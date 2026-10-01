const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = resolve(__dirname, '..');
function loadTS(path, extras = {}) {
  const exports = {};
  const source = readFileSync(resolve(root, path), 'utf8').replaceAll('import.meta.hot', 'undefined');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText, { exports, ...extras });
  return exports;
}
const algorithms = loadTS('src/store/resourceAlgorithms.ts');
const { planResources, createResourceScheduler } = loadTS('src/store/resourceScheduler.ts', { require: () => algorithms });
const tab = (id, patch = {}) => ({ id, isLoading: false, lastActiveAt: 0, ...patch });
const state = tabs => ({ tabs, activeTabId: 'active', settings: {
  liveTabLimit: 3, hibernateAfterMin: 10, backgroundLoadLimit: 2,
} });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('memory pressure uses separate enter/exit thresholds and rejects invalid samples', () => {
  const p = algorithms.memoryPressure;
  assert.equal(p('normal', 16000, 1000), 'critical');
  assert.equal(p('critical', 16000, 1700), 'critical');
  assert.equal(p('critical', 16000, 2600), 'elevated');
  assert.equal(p('elevated', 16000, 3100), 'elevated');
  assert.equal(p('elevated', 16000, 5000), 'normal');
  assert.equal(p('critical', 0, 0), 'critical');
  assert.equal(p('normal', 16000, NaN), 'normal');
});

test('EWMA reload cost and aged reuse prefer useful tabs without permanent pinning', () => {
  assert.equal(algorithms.smoothLoadCost(1000, 5000), 2000);
  assert.equal(algorithms.smoothLoadCost(1000, Infinity), 1000);
  assert.equal(algorithms.smoothLoadCost(undefined, 0), undefined);
  const hot = { lastActiveAt: 0, reuseScore: 10, reuseUpdatedAt: 0, loadCostMs: 8000 };
  assert.ok(algorithms.retentionScore(hot, 60000) > algorithms.retentionScore({ lastActiveAt: 10000 }, 60000));
  assert.equal(algorithms.decayedReuse(hot, 1800000), 5);
  assert.equal(algorithms.recordReuse({ reuseScore: 32 }, 0).reuseScore, 32);
  const s = state([tab('hot', hot), tab('one-off', { lastActiveAt: 10000 })]);
  assert.equal(planResources(s, 70000).action.id, 'one-off');
});

test('critical pressure stops background admission but never overrides user protection or Off', () => {
  const s = state([tab('queued', { hibernated: true, pendingLoad: true }), tab('cold', { suspended: true }),
    tab('draft', { keepAwake: true }), tab('video', { hadMedia: true, suspended: true })]);
  s.memoryPressure = 'critical';
  assert.equal(planResources(s, 61000).action.id, 'cold');
  s.settings.hibernateAfterMin = 0;
  assert.equal(planResources(s, 61000).action, undefined);
});

test('policy protects active, loading, audible, pinned and unloaded tabs', () => {
  const s = state([tab('active'), tab('audio', { audible: true }), tab('load', { isLoading: true }),
    tab('pin', { keepAwake: true }), tab('asleep', { hibernated: true })]);
  assert.equal(planResources(s, 999999).nextAt, Infinity);
  for (const patch of [{ hadMedia: true }, { sleepProtected: true }]) {
    const s = state([tab('editor', patch)]);
    assert.equal(planResources(s, 999999).action.kind, 'freeze');
    s.tabs[0].suspended = true;
    assert.equal(planResources(s, 999999).nextAt, Infinity);
  }
});

test('coldest tab first, 20s grace over cap, Off prevents all automatic discards', () => {
  const s = state([tab('recent', { lastActiveAt: 15000 }), tab('oldest'), tab('middle', { lastActiveAt: 10000 })]);
  s.settings.liveTabLimit = 1;
  assert.equal(planResources(s, 19000).action, undefined);
  assert.equal(planResources(s, 20000).action.id, 'oldest');
  assert.equal(planResources(s, 300000).action.kind, 'hibernate');
  s.settings.hibernateAfterMin = 0;
  assert.equal(planResources(s, 900000).action.kind, 'freeze');
  s.tabs.forEach(t => t.suspended = true);
  assert.equal(planResources(s, 900000).nextAt, Infinity);
});

test('1000 background links respect slots, foreground priority and on-click mode', () => {
  const s = state(Array.from({ length: 1000 }, (_, i) => tab(String(i), { pendingLoad: true, hibernated: true })));
  for (let i = 0; i < 2; i++) {
    const p = planResources(s, 0);
    assert.equal(p.action.id, String(i));
    Object.assign(s.tabs[i], { pendingLoad: false, hibernated: false, isLoading: true });
  }
  assert.equal(planResources(s, 0).action, undefined);
  s.tabs[0].isLoading = false;
  assert.equal(planResources(s, 0).action.id, '2');
  s.tabs.push(tab('active', { isLoading: true }));
  assert.equal(planResources(s, 0).action, undefined);
  s.tabs.pop();
  s.settings.backgroundLoadLimit = 0;
  assert.equal(planResources(s, 0).action, undefined);
});

test('background admission cannot starve overdue sleep; capture yields to foreground loading', () => {
  const s = state([tab('cold'), tab('queued', { pendingLoad: true, hibernated: true })]);
  assert.equal(planResources(s, 61000).action.kind, 'freeze');
  s.tabs[0].suspended = true;
  assert.equal(planResources(s, 61000).action.kind, 'load');
  s.tabs.push(tab('active', { isLoading: true }));
  assert.equal(planResources(s, 900000).action, undefined);
  s.tabs[2].isLoading = false;
  assert.equal(planResources(s, 900000).action.kind, 'hibernate');
});

function harness(run, initial = state([tab('old')])) {
  let now = 70000, visible = true, seq = 0;
  const timers = new Map();
  const scheduler = createResourceScheduler({ state: () => initial, now: () => now,
    visible: () => visible, run,
    setTimer: (fn, ms) => { timers.set(++seq, { fn, at: now + ms }); return seq; },
    clearTimer: id => timers.delete(id),
  });
  return { scheduler, timers, state: initial,
    visible(value) { visible = value; scheduler.notify(); },
    fire() { const [id, t] = [...timers][0]; timers.delete(id); now = t.at; t.fn(); },
  };
}

test('scheduler has one in-flight operation, backs off refusals and pauses hidden', async () => {
  let reject, calls = 0;
  const h = harness(() => { calls++; return new Promise((_, no) => { reject = no; }); });
  h.scheduler.notify(); h.scheduler.notify();
  assert.equal(h.timers.size, 1);
  h.fire(); h.scheduler.notify();
  assert.equal(calls, 1);
  assert.equal(h.timers.size, 0);
  reject(new Error('audio grace'));
  await flush();
  assert.equal([...h.timers.values()][0].at, 130000);
  h.visible(false);
  assert.equal(h.timers.size, 0);
  h.visible(true);
  assert.equal(h.timers.size, 1);
  h.scheduler.dispose(); h.scheduler.notify();
  assert.equal(h.timers.size, 0);
});

test('settled policy has no timer; tab changes reschedule rather than poll', async () => {
  const s = state([tab('old', { hadMedia: true })]);
  const h = harness(async () => { s.tabs[0].suspended = true; }, s);
  h.scheduler.notify(); h.fire(); await flush();
  assert.equal(h.timers.size, 0);
  s.tabs.push(tab('new'));
  h.scheduler.notify();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].at, 70750);
});

function storeHarness() {
  const events = new Map(), timers = new Map(), calls = [], nativeTabs = new Set();
  let serial = 0, nativeActive;
  let now = 1_000_000;
  class ClockDate extends Date { static now() { return now; } }
  const store = loadTS('src/store/tabs.ts', {
    Date: ClockDate, console, URL,
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    window: { dispatchEvent() {} }, CustomEvent: class {},
    require: name => {
      if (name === 'zustand') return require('zustand');
      if (name === 'zustand/middleware') return { persist: fn => fn, createJSONStorage: () => ({}) };
      if (name === './tauriStorage') return {};
      if (name === './resourceScheduler') return { planResources, createResourceScheduler };
      if (name === './resourceAlgorithms') return algorithms;
      if (name === 'uuid') return { v4: () => String(++serial) };
      if (name === '@tauri-apps/api/event') return { listen: async (name, fn) => { events.set(name, fn); return () => events.delete(name); } };
      if (name === '@tauri-apps/api/core') return { invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'switch_browser_tab') {
          if (!nativeTabs.has(args.id)) return false;
          nativeActive = args.id; return true;
        }
        if (cmd === 'create_browser_tab') { nativeTabs.add(args.id); if (!args.background) nativeActive = args.id; }
        if (cmd === 'close_browser_tab') nativeTabs.delete(args.id);
        if (cmd === 'get_page_meta') throw new Error('not available');
      } };
      throw new Error(name);
    },
  }).useBrowserStore;
  return { store, calls, nativeTabs, events, timers, active: () => nativeActive,
    async tick() {
      const found = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(found, 'scheduler timer exists');
      now = found[1].at;
      timers.delete(found[0]); found[1].fn(); await flush();
    },
  };
}

test('real tab store queues middle-clicks, cancels closed pending links, and click bypasses queue', async () => {
  const h = storeHarness();
  await h.store.getState().createTab('https://example.com');
  const original = h.store.getState().activeTabId;
  h.store.getState().updateTab(original, { isLoading: false });
  for (let i = 0; i < 20; i++) await h.store.getState().createTab(`https://example.com/${i}`, undefined, { background: true });
  assert.equal(h.nativeTabs.size, 1);
  assert.equal(h.store.getState().activeTabId, original);
  const pending = h.store.getState().tabs.filter(t => t.pendingLoad);
  await h.store.getState().closeTab(pending[0].id);
  await h.tick();
  assert.equal(h.nativeTabs.has(pending[0].id), false);
  assert.equal(h.nativeTabs.has(pending[1].id), true);
  assert.equal(h.active(), original);
  const clicked = pending[19].id;
  await h.store.getState().switchTab(clicked);
  assert.equal(h.active(), clicked);
  assert.equal(h.nativeTabs.has(clicked), true);
  assert.equal(h.calls.filter(c => c.cmd === 'create_browser_tab' && c.args.id === clicked).length, 1);
});

test('rapid foreground creations coalesce and do not create abandoned renderers', async () => {
  const h = storeHarness();
  await Promise.all(Array.from({ length: 10 }, (_, i) => h.store.getState().createTab(`https://example.com/${i}`)));
  assert.equal(h.nativeTabs.size, 1);
  assert.equal(h.active(), h.store.getState().activeTabId);
  const abandoned = h.store.getState().tabs.filter(t => t.id !== h.active());
  assert.ok(abandoned.every(t => t.hibernated && !t.isLoading));
});

test('duplicate copies history before its initial native page is created', async () => {
  const h = storeHarness();
  await h.store.getState().createTab('https://example.com');
  const source = h.active();
  await h.store.getState().createTab('https://example.com', undefined, { duplicateFrom: source });
  const copy = h.active();
  assert.notEqual(copy, source);
  const cloneIndex = h.calls.findIndex(c => c.cmd === 'clone_tab_history');
  assert.equal(h.calls[cloneIndex].args.sourceId, source);
  assert.equal(h.calls[cloneIndex].args.id, copy);
  assert.ok(cloneIndex < h.calls.findIndex(c => c.cmd === 'create_browser_tab' && c.args.id === copy));
});

test('local new-tab readiness completes loading and failures stop the spinner without affecting navigated tabs', async () => {
  const h = storeHarness();
  const cleanup = await h.store.getState().initEvents();
  await h.store.getState().createTab();
  const tab = h.store.getState().tabs[0];
  assert.equal(tab.isLoading, true);
  h.events.get('new-tab-error')({ payload: { id: tab.id } });
  assert.equal(h.store.getState().tabs[0].isLoading, false);
  assert.match(h.store.getState().tabs[0].title, /reload to retry/);
  h.events.get('page-loaded')({ payload: { id: tab.id, url: tab.url } });
  assert.equal(h.store.getState().tabs[0].title, 'New Tab');
  h.store.getState().updateTab(tab.id, { url: 'https://example.com/', isLoading: true });
  h.events.get('new-tab-error')({ payload: { id: tab.id } });
  assert.equal(h.store.getState().tabs[0].isLoading, true);
  cleanup(); assert.equal(h.events.has('new-tab-error'), false);
});

test('default new tab is local, not searched or recorded in history', async () => {
  const h = storeHarness();
  await h.store.getState().initEvents();
  await h.store.getState().createTab();
  const tab = h.store.getState().tabs[0];
  assert.equal(tab.url, 'zro://newtab');
  h.events.get('page-loaded')({ payload: { id: tab.id, url: tab.url, loadMs: 4 } });
  assert.equal(h.store.getState().tabs[0].isLoading, false);
  assert.equal(h.store.getState().history.length, 0);
  assert.equal(h.calls.some(c => c.cmd === 'get_page_meta'), false);
});

test('real store admits at most two background loads and replenishes on completion', async () => {
  const h = storeHarness();
  await h.store.getState().initEvents();
  await h.store.getState().createTab('https://example.com');
  const original = h.store.getState().activeTabId;
  for (let i = 0; i < 5; i++) await h.store.getState().createTab(`https://example.com/${i}`, undefined, { background: true });
  assert.equal(h.nativeTabs.size, 1, 'foreground loading pauses admission');
  h.store.getState().updateTab(original, { isLoading: false });
  await h.tick(); await h.tick();
  assert.equal(h.nativeTabs.size, 3);
  assert.equal(h.store.getState().tabs.filter(t => t.pendingLoad).length, 3);
  assert.equal(h.timers.size, 1, 'only the low-rate memory sensor remains scheduled');
  const background = h.store.getState().tabs.find(t => t.id !== original && t.isLoading);
  h.events.get('page-loaded')({ payload: { id: background.id, url: background.url } });
  await h.tick();
  assert.equal(h.nativeTabs.size, 4);
  assert.equal(h.active(), original);
});
