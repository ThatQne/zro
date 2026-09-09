/** Transparent heuristics, not a V8 heap patch. No dependency or model inference. */
export type MemoryPressure = "normal" | "elevated" | "critical";
export function memoryPressure(previous: MemoryPressure, totalMb: number, availableMb: number): MemoryPressure {
  if (!Number.isFinite(totalMb) || totalMb <= 0 || !Number.isFinite(availableMb) || availableMb < 0 || availableMb > totalMb) return previous;
  const used = 1 - availableMb / totalMb;
  if (used >= .93 || availableMb < 768) return "critical";
  // Hysteresis: enter critical at 93%, don't exit until below 88% and >1 GiB.
  if (previous === "critical" && (used >= .88 || availableMb < 1024)) return "critical";
  if (used >= .85 || availableMb < 1536) return "elevated";
  if (previous !== "normal" && (used >= .80 || availableMb < 2048)) return "elevated";
  return "normal";
}

export function smoothLoadCost(previous: number | undefined, sample: number | undefined): number | undefined {
  if (sample === undefined || !Number.isFinite(sample) || sample <= 0 || sample > 120_000) return previous;
  return previous === undefined ? sample : .75 * previous + .25 * sample;
}

interface Reuse { reuseScore?: number; reuseUpdatedAt?: number; lastActiveAt?: number; loadCostMs?: number }
export function decayedReuse(tab: Reuse, now: number): number {
  return (tab.reuseScore ?? 0) * Math.pow(.5, Math.max(0, now - (tab.reuseUpdatedAt ?? now)) / 1_800_000);
}
export function recordReuse(tab: Reuse, now: number) {
  return { reuseScore: Math.min(32, decayedReuse(tab, now) + 1), reuseUpdatedAt: now };
}
/** Higher = more useful to retain. Frequency ages away; expensive loads gain
 * bounded protection. Never estimates per-tab bytes from shared processes. */
export function retentionScore(tab: Reuse, now: number): number {
  const benefit = 1 + 4 * Math.log2(1 + decayedReuse(tab, now)) + Math.min(8, (tab.loadCostMs ?? 0) / 1000);
  return benefit / (1 + Math.max(0, now - (tab.lastActiveAt ?? now)) / 60_000);
}
