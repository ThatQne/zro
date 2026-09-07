const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = resolve(__dirname, '..');

function captureSleep({ controls = [], rich = false, elements = [], url = 'https://example.com/article' } = {}) {
  return vm.runInNewContext(readFileSync(resolve(root, 'src-tauri/src/browser/sleep_capture.js'), 'utf8'), {
    location: { href: url }, scrollX: 0, scrollY: 720, CSS: { escape: s => s },
    document: {
      querySelector: () => rich ? {} : null,
      querySelectorAll: selector => selector === '*' ? elements : controls,
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
