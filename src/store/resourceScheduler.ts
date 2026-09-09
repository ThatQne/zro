import { MemoryPressure, retentionScore } from "./resourceAlgorithms";
/** Deterministic policy, separate from WebView/React so races and costs can be tested. */
export interface ResourceTab {
  id: string;
  lastActiveAt?: number;
  isLoading: boolean;
  pendingLoad?: boolean;
  hibernated?: boolean;
  suspended?: boolean;
  audible?: boolean;
  hadMedia?: boolean;
  keepAwake?: boolean;
  sleepProtected?: boolean;
  reuseScore?: number;
  reuseUpdatedAt?: number;
  loadCostMs?: number;
}

export interface ResourceState {
  tabs: ResourceTab[];
  activeTabId: string | null;
  memoryPressure?: MemoryPressure;
  settings: { liveTabLimit: number; hibernateAfterMin: number; backgroundLoadLimit: number };
}

export type ResourceAction = { id: string; kind: "load" | "freeze" | "hibernate" };
export interface ResourcePlan { action?: ResourceAction; nextAt: number }

const MINUTE = 60_000;

export function planResources(
  state: ResourceState, now: number, retryAt: ReadonlyMap<string, number> = new Map(),
): ResourcePlan {
  const { tabs, activeTabId, settings } = state;
  const pressure = state.memoryPressure ?? "normal";
  const cap = pressure === "critical" ? 1 : pressure === "elevated"
    ? Math.max(1, Math.floor((settings.liveTabLimit || 3) / 2)) : settings.liveTabLimit;
  const loadLimit = pressure === "critical" ? 0 : pressure === "elevated"
    ? Math.min(1, settings.backgroundLoadLimit) : settings.backgroundLoadLimit;
  let nextAt = Infinity;
  let loadAction: ResourceAction | undefined;
  const retry = (id: string) => retryAt.get(id) ?? 0;
  // A clicked tab always bypasses this queue. Background pages cannot all
  // start at once, and new work waits until the foreground load completes.
  const foregroundBusy = tabs.some(t => t.id === activeTabId && t.isLoading);
  const loading = tabs.filter(t => t.id !== activeTabId && t.isLoading && !t.pendingLoad && !t.hibernated).length;
  if (!foregroundBusy && loading < loadLimit) {
    for (const tab of tabs) {
      if (!tab.pendingLoad || tab.id === activeTabId) continue;
      if (retry(tab.id) <= now) { loadAction = { id: tab.id, kind: "load" }; break; }
      nextAt = Math.min(nextAt, retry(tab.id));
    }
  }

  const candidates = tabs.filter(t => t.id !== activeTabId && !t.hibernated && !t.pendingLoad &&
    !t.isLoading && !t.audible && !t.keepAwake && t.lastActiveAt !== undefined)
    .map(tab => ({ tab, score: retentionScore(tab, now) }))
    .sort((a, b) => b.score - a.score).map(item => item.tab);
  // Work from coldest to hottest. A recent tab gets a 20-second grace even
  // over the cap; repeated quick switching must not become freeze/thaw churn.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const tab = candidates[i];
    const overflow = cap > 0 && i >= cap;
    const freezeGrace = pressure === "critical" ? 5_000 : pressure === "elevated" ? 15_000 : overflow ? 20_000 : MINUTE;
    const freezeAt = tab.lastActiveAt! + freezeGrace;
    // Capturing state resumes a renderer and executes script: defer that work
    // while the foreground is loading. Cheap suspension is still permitted.
    const canDiscard = !foregroundBusy && settings.hibernateAfterMin > 0 && !tab.hadMedia && !tab.sleepProtected;
    const pressureDeadline = pressure === "critical" ? 1 : pressure === "elevated" ? 2 : Infinity;
    const discardAt = canDiscard ? tab.lastActiveAt! +
      Math.min(settings.hibernateAfterMin, overflow ? 5 : Infinity, pressureDeadline) * MINUTE : Infinity;
    const dueAt = Math.max(retry(tab.id), Math.min(tab.suspended ? Infinity : freezeAt, discardAt));
    if (dueAt <= now) {
      return { action: { id: tab.id, kind: discardAt <= now ? "hibernate" : "freeze" }, nextAt: now };
    }
    nextAt = Math.min(nextAt, dueAt);
  }
  // Reclaim overdue tabs before admitting more work. Otherwise a stream of
  // quickly-loaded pages could starve sleep indefinitely and accumulate RAM.
  return loadAction ? { action: loadAction, nextAt: now } : { nextAt };
}

interface SchedulerHost {
  state(): ResourceState;
  visible(): boolean;
  now(): number;
  run(action: ResourceAction): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  sampleResources?(): Promise<void>;
}

/** One deadline timer and at most one operation in flight; no polling while
 * idle/hidden, no overlapping sweeps, bounded retry on native refusal. */
export function createResourceScheduler(host: SchedulerHost) {
  let timer: unknown;
  let busy = false;
  let disposed = false;
  let notBefore = 0;
  const retries = new Map<string, number>();
  let nextSampleAt = 0;
  function cancelTimer() {
    if (timer !== undefined) host.clearTimer(timer);
    timer = undefined;
  }
  function notify() {
    cancelTimer();
    if (disposed || busy || !host.visible()) return;
    const state = host.state();
    const ids = new Set(state.tabs.map(t => t.id));
    for (const id of retries.keys()) if (!ids.has(id)) retries.delete(id);
    const plan = planResources(state, host.now(), retries);
    const sampleAt = host.sampleResources && state.tabs.some(t => !t.hibernated || t.pendingLoad) ? nextSampleAt : Infinity;
    const nextAt = Math.min(plan.nextAt, sampleAt);
    if (!Number.isFinite(nextAt)) return;
    timer = host.setTimer(() => { timer = undefined; void tick(); },
      Math.max(0, notBefore - host.now(), nextAt - host.now()));
  }
  async function tick() {
    if (disposed || busy || !host.visible()) return;
    if (host.sampleResources && host.now() >= nextSampleAt) {
      busy = true;
      try { await host.sampleResources(); } catch { /* keep last known pressure */ }
      finally {
        nextSampleAt = host.now() + ((host.state().memoryPressure ?? "normal") === "normal" ? 30_000 : 10_000);
        busy = false;
      }
      if (disposed || !host.visible()) return;
    }
    const action = planResources(host.state(), host.now(), retries).action;
    if (!action) { notify(); return; }
    busy = true;
    try {
      await host.run(action);
      retries.delete(action.id);
    } catch {
      retries.set(action.id, host.now() + MINUTE);
    } finally {
      busy = false;
      // Spread native work across time rather than dumping a large batch
      // onto the Windows UI thread when many tabs become eligible together.
      notBefore = host.now() + 750;
      notify();
    }
  }
  return { notify, dispose() { disposed = true; cancelTimer(); retries.clear(); } };
}
