// Regression for the real Sheets failure: a reserved non-configurable global
// prevents the entire core bundle's top-level `let ipc` from compiling.
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const source = readFileSync(resolve(__dirname, '../src-tauri/vendor/wry/src/webview2/mod.rs'), 'utf8');
const bridge = source.match(/r#"(Object\.defineProperty\(window, 'ipc',[^\n]+)"#/)[1];
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    async function run(script) {
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(`window.messages=[];window.chrome.webview={postMessage:s=>messages.push(s)};${script}`);
      await page.route('https://bridge.test/', route => route.fulfill({ contentType:'text/html', body:
        `<script>let ipc='page-owned';window.pageInitialized=ipc;window.ipc.postMessage('bridge-still-works');</script>` }));
      await page.goto('https://bridge.test/');
      const result = await page.evaluate(() => ({ initialized:window.pageInitialized, messages:window.messages }));
      await page.close();
      return { ...result, errors };
    }
    const original = await run(bridge.replace('configurable: true, ', ''));
    assert.ok(original.errors.some(e => /ipc.*already been declared/.test(e)));
    assert.equal(original.initialized, undefined);
    const fixed = await run(bridge);
    assert.equal(fixed.initialized, 'page-owned');
    assert.deepEqual(fixed.messages, ['bridge-still-works']);
    assert.deepEqual(fixed.errors, []);
    console.log('Native bridge regression passed: original descriptor reproduces the Sheets failure; fixed descriptor permits lexical ipc and preserves message delivery.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
