const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = resolve(__dirname, '..');

function captureSleep({ controls = [], rich = false, elements = [], frames = [], url = 'https://example.com/article' } = {}) {
  return vm.runInNewContext(readFileSync(resolve(root, 'src-tauri/src/browser/sleep_capture.js'), 'utf8'), {
    location: { href: url }, scrollX: 0, scrollY: 720, CSS: { escape: s => s },
    document: {
      querySelector: () => rich ? {} : null,
      querySelectorAll: selector => selector === '*' ? elements : selector === 'iframe,frame' ? frames : controls,
    },
  });
}

test('deep sleep captures scroll and edited ordinary fields; protects sensitive and rich pages on any host', () => {
  const field = { id: 'message', tagName: 'TEXTAREA', type: 'textarea', name: 'message', value: 'unsent draft', defaultValue: '', autocomplete: '' };
  const saved = captureSleep({ controls: [field], elements: [{ id: 'pane', scrollLeft: 10, scrollTop: 55 }] });
  assert.equal(saved.y, 720);
  assert.equal(saved.forms[0].value, 'unsent draft');
  assert.equal(saved.scrollers[0].y, 55);
  for (const type of ['password', 'file', 'hidden']) {
    assert.equal(captureSleep({ controls: [{ ...field, type }] }).protected, true);
  }
  assert.equal(captureSleep({ controls: [{ ...field, autocomplete: 'cc-number' }] }).protected, true);
  assert.equal(captureSleep({ rich: true, url: 'https://any-editor.example/document' }).protected, true);
  assert.equal(captureSleep({ controls: [{ ...field, value: 'x'.repeat(40000) }] }).protected, true);
});

test('same-origin frame drafts/scroll are bounded; inaccessible frames and shadow state stay protected', () => {
  const field = { id: 'draft', tagName: 'TEXTAREA', type: 'textarea', name: 'draft', value: 'unsent', defaultValue: '' };
  const child = { location: { href: 'https://example.com/embed' }, scrollX: 0, scrollY: 90,
    document: { readyState: 'complete', querySelector: () => null,
      querySelectorAll: s => s === 'input,textarea,select' ? [field] : [] } };
  const frame = { id: 'embed', contentWindow: child };
  const saved = captureSleep({ frames: [frame] });
  assert.equal(saved.frames[0].state.forms[0].value, 'unsent');
  assert.equal(saved.frames[0].state.y, 90);
  assert.equal(captureSleep({ frames: Array(9).fill(frame) }).protected, true);
  const opaque = { id: 'remote', get contentWindow() { throw new Error('cross-origin'); } };
  assert.equal(captureSleep({ frames: [opaque] }).protected, true);
  assert.equal(captureSleep({ elements: [{ shadowRoot: {} }] }).protected, true);
  assert.equal(captureSleep({ elements: Array.from({ length: 101 }, (_, i) => ({ id: String(i), scrollTop: 1 })) }).protected, true);
});

test('new-tab script modifies only the marked local page and waits for DOM readiness', () => {
  const source = readFileSync(resolve(root, 'src-tauri/src/browser/new_tab.js'), 'utf8');
  let render;
  const doc = { readyState: 'loading', documentElement: { style: {} }, body: { innerHTML: '' },
    addEventListener: (_, cb) => { render = cb; } };
  vm.runInNewContext(source, { window: {}, location: { href: 'https://example.com/' }, document: doc });
  assert.equal(render, undefined);
  const window = { __zroNewTabDocument: true };
  const location = { href: 'http://tauri.localhost/newtab.html' };
  vm.runInNewContext(source, { window, location, document: doc });
  assert.equal(doc.body.innerHTML, '');
  assert.equal(typeof render, 'function');
  // Navigating away before DOMContentLoaded must not overwrite the destination.
  location.href = 'https://example.com/';
  window.__zroNewTabDocument = false;
  render();
  assert.equal(doc.body.innerHTML, '');
});

test('frame restoration uses its own DOM prototypes and stops on frame interaction', () => {
  const source = readFileSync(resolve(root, 'src-tauri/src/browser/sleep_restore.js'), 'utf8');
  let tick;
  const listeners = new Map(), scrolls = [];
  class Field { set value(v) { this.saved = v; } dispatchEvent() {} }
  const field = Object.assign(new Field(), { tagName: 'INPUT', type: 'text', name: 'draft' });
  const child = { location: { href: 'https://example.com/frame' },
    document: { querySelector: () => field }, HTMLInputElement: Field, HTMLTextAreaElement: Field, Event: class {},
    scrollTo: (x, y) => scrolls.push(y), addEventListener: (n, fn) => listeners.set(n, fn), removeEventListener() {} };
  const context = { location: { href: 'https://example.com/' }, document: { querySelector: () => ({ contentWindow: child }) },
    HTMLInputElement: Field, HTMLTextAreaElement: Field, Event: class {}, scrollTo() {},
    addEventListener() {}, removeEventListener() {}, setInterval: fn => { tick = fn; }, clearInterval() {}, setTimeout() {} };
  const restore = vm.runInNewContext(source, context);
  const snapshot = { url: context.location.href, x: 0, y: 10, forms: [], scrollers: [], frames: [{ path: '#frame', state: {
    url: child.location.href, x: 0, y: 300, scrollers: [], forms: [{ path: '#draft', tag: 'INPUT', type: 'text', name: 'draft', value: 'saved' }],
  } }] };
  restore(snapshot);
  assert.equal(field.saved, 'saved');
  assert.deepEqual(scrolls, [300]);
  listeners.get('keydown')();
  field.value = 'new typing'; tick();
  assert.equal(field.saved, 'new typing');
  assert.deepEqual(scrolls, [300]);
  child.location.href = 'https://example.com/other';
  restore(snapshot);
  assert.equal(field.saved, 'new typing');
});

test('sleep restoration retries delayed content, stops on user input, and rejects a different URL', () => {
  const script = readFileSync(resolve(root, 'src-tauri/src/browser/sleep_restore.js'), 'utf8');
  const listeners = new Map();
  const scrolls = [];
  let tick, field;
  class Input { set value(v) { this.saved = v; } dispatchEvent() {} }
  const context = { location: { href: 'https://example.com/article' },
    document: { querySelector: () => field }, HTMLInputElement: Input, HTMLTextAreaElement: Input,
    Event: class {}, setInterval: fn => { tick = fn; return 1; }, clearInterval() {}, setTimeout() {},
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {},
    scrollTo: (x, y) => scrolls.push([x, y]),
  };
  const restore = vm.runInNewContext(script, context);
  const snapshot = { url: context.location.href, x: 0, y: 720, scrollers: [], forms: [
    { path: '#draft', tag: 'INPUT', type: 'text', name: 'draft', value: 'saved draft' },
  ] };
  restore(snapshot);
  field = Object.assign(new Input(), { tagName: 'INPUT', type: 'text', name: 'draft' });
  tick();
  assert.equal(field.saved, 'saved draft');
  listeners.get('pointerdown')();
  field.value = 'new typing';
  const count = scrolls.length;
  tick();
  assert.equal(field.saved, 'new typing');
  assert.equal(scrolls.length, count);
  context.location.href = 'https://other.example/';
  restore(snapshot);
  assert.equal(scrolls.length, count);
});

test('middle-click dispatches a background link and cancels native foreground navigation', () => {
  const source = readFileSync(resolve(root, 'src-tauri/src/browser/perf.rs'), 'utf8');
  const script = source.split('r#"')[1].split('"#;')[0];
  const events = new Map();
  const messages = [];
  const chrome = { webview: { postMessage: m => messages.push(JSON.parse(m)) } };
  vm.runInNewContext(script, {
    window: { chrome }, chrome, URL, Set,
    location: { href: 'https://example.com/' },
    document: { readyState: 'loading', addEventListener() {} },
    addEventListener: (name, fn) => events.set(name, fn),
  });
  const click = (button, isTrusted, href, download = false) => {
    let prevented = false;
    events.get('auxclick')({ button, isTrusted,
      composedPath: () => [{ matches: () => true, href, hasAttribute: () => download }],
      preventDefault: () => { prevented = true; }, stopImmediatePropagation() {},
    });
    return prevented;
  };
  assert.equal(click(1, true, 'https://example.com/video'), true);
  assert.deepEqual(messages, [{ type: 'zro-background-link', url: 'https://example.com/video' }]);
  for (const args of [[0, true, 'https://example.com'], [1, false, 'https://example.com'],
    [1, true, 'javascript:alert(1)'], [1, true, 'https://example.com/file', true]]) {
    assert.equal(click(...args), false);
  }
  assert.equal(messages.length, 1);
});

test('overlay updates coalesce during IPC and closing sends the final empty region', async () => {
  const frames = [];
  const calls = [];
  let finish;
  const exports = {};
  const source = ts.transpileModule(readFileSync(resolve(root, 'src/store/overlays.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, { exports,
    requestAnimationFrame: cb => { frames.push(cb); return frames.length; },
    require: () => ({ invoke: (_, payload) => {
      calls.push(JSON.parse(JSON.stringify(payload.rects)));
      return new Promise(resolve => { finish = resolve; });
    } }),
  });
  const rect = { x: 0, y: 40, w: 220, h: 600, r: 0 };
  exports.reportOverlay('sidebar', rect);
  frames.shift()();
  exports.reportOverlay('sidebar', { ...rect, w: 221 });
  frames.shift()();
  exports.reportOverlay('sidebar', null);
  frames.shift()();
  assert.equal(calls.length, 1);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  frames.shift()();
  assert.deepEqual(calls, [[rect], []]);
  finish();
});
