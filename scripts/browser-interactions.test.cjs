const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = resolve(__dirname, '..');

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
