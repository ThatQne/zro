// Optional Edge integration test. Resolve Playwright with NODE_PATH when it is not local.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { readFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
const script = name => readFileSync(resolve(root, 'src-tauri/src/browser', name), 'utf8');
const output = resolve(root, 'src-tauri/target/arcade-qa');
const localUrl = 'http://tauri.localhost/newtab.html';
const flag = "window.__zroNewTabDocument=location.hostname==='tauri.localhost'&&location.pathname==='/newtab.html';\n";
const init = flag + script('arcade_core.js') + '\n' + script('new_tab.js') +
  '\n({url:location.href,ready:window.__zroNewTabDocument===true && window.__zroArcadeReady===true})';
const harness = `
  const raf = requestAnimationFrame, cancel = cancelAnimationFrame, timer = setTimeout, clear = clearTimeout;
  const frames = new Set(), timers = new Set(), messages = [];
  window.__work = { frames, timers, messages };
  window.requestAnimationFrame = callback => { const id = raf(t => { frames.delete(id); callback(t); }); frames.add(id); return id; };
  window.cancelAnimationFrame = id => { frames.delete(id); cancel(id); };
  window.setTimeout = (callback, delay) => { const id = timer(() => { timers.delete(id); callback(); }, delay); timers.add(id); return id; };
  window.clearTimeout = id => { timers.delete(id); clear(id); };
  window.chrome = window.chrome || {}; window.chrome.webview = { postMessage: text => messages.push(JSON.parse(text)) };
`;

(async () => {
  const browser = await chromium.launch({ channel: process.env.ZRO_TEST_BROWSER || 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.route(localUrl, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>New Tab</title></head><body></body></html>' }));
    await page.addInitScript({ content: harness + init });
    await page.goto(localUrl);
    assert.equal(await page.locator('#zro-play').count(), 1, 'Local app page mounts on its first document load');
    const ready = await page.evaluate(init);
    assert.equal(ready.ready, true); await page.evaluate(init);
    assert.equal(await page.locator('#zro-play').count(), 1, 'Native ready retry is idempotent');
    assert.equal(await page.locator('[data-game]').count(), 4);
    assert.deepEqual(await page.evaluate(() => __work.messages.map(x => x.type)), ['zro-arcade-load']);
    assert.equal(await page.locator('[data-game="ricochet"]').count(), 0);
    assert.equal(await page.locator('[data-game="pool"]').count(), 0);
    assert.equal(await page.locator('[data-game="breakout"]').count(), 1);
    assert.equal(await page.locator('.card-icon svg').count(), 4, 'Cards use SVG icons');
    assert.match(await page.evaluate(() => getComputedStyle(document.documentElement).fontFamily), /Outfit/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const work = () => page.evaluate(() => ({ frames: __work.frames.size, timers: __work.timers.size }));
    mkdirSync(output, { recursive: true }); await page.screenshot({ path: resolve(output, 'menu.png') });

    await page.locator('[data-game="blocks"]').click();
    assert.equal(await page.locator('#game-settings').isVisible(), true);
    assert.equal(await page.locator('#controls button svg').count(), 6, 'Game controls use SVG icons');
    assert.equal(await page.locator('#next-piece').count(), 1);
    await page.locator('#surface canvas').click({ position: { x: 100, y: 100 } });
    await page.keyboard.press('c');
    assert.notEqual((await page.evaluate(()=>window.__zroArcadeSave())).games.blocks.held, null);
    assert.equal(await page.locator('#surface canvas').evaluate(c => getComputedStyle(c).outlineStyle), 'none');
    await page.locator('#game-settings').click();
    assert.equal(await page.locator('#settings-dialog').evaluate(d => d.open), true);
    await page.locator('[data-setting="grid"]').click();
    await page.locator('#start-level').selectOption('5');
    await page.locator('#close-settings').click();
    await page.keyboard.press('Space');
    assert.ok(Number(await page.locator('#score').textContent()) > 0);
    await page.waitForTimeout(300);
    const blockSave = await page.evaluate(() => __work.messages.filter(x => x.type === 'zro-arcade-save').at(-1).data);
    assert.equal(blockSave.version, 2); assert.equal(blockSave.settings.blocks.grid, false); assert.equal(blockSave.settings.blocks.startLevel, 5);
    await page.screenshot({ path: resolve(output, 'blocks.png') });
    await page.locator('#pause').click(); assert.deepEqual(await work(), { frames: 0, timers: 0 });
    await page.locator('#back').click();

    await page.locator('[data-game="factory"]').click();
    await page.waitForTimeout(300);
    assert.deepEqual(await work(), { frames: 0, timers: 0 });
    for (let i = 0; i < 16; i++) await page.locator('#generate').click();
    assert.match(await page.locator('#footnote').textContent(), /Achievement unlocked/);
    await page.locator('[data-buy="0"]').click();
    assert.match(await page.locator('#detail').textContent(), /cycles \/ second/);
    assert.equal((await work()).timers >= 1, true);
    await page.locator('[data-view="achievements"]').click();
    assert.equal(await page.locator('.achievement.done').count() >= 1, true);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: resolve(output, 'factory.png') });
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.deepEqual(await work(), { frames: 0, timers: 0 });
    const persistent = await page.evaluate(() => __work.messages.filter(x => x.type === 'zro-arcade-save').at(-1).data);
    assert.equal(persistent.games.factory.items[0], 1); assert.equal(persistent.selected, null);
    await page.locator('#back').click();

    await page.locator('[data-game="merge"]').click();
    const pixels = await page.locator('canvas').evaluate(c => {
      const x = c.getContext('2d').getImageData(12, 200, 1, 1).data;
      return [...x];
    });
    assert.notDeepEqual(pixels.slice(0, 3), [15,15,15], 'Jar has a visible side border');
    await page.evaluate(() => { Math.random = () => 0; });
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(600); }
    assert.ok(Number(await page.locator('#score').textContent()) > 0);
    await page.screenshot({ path: resolve(output, 'merge.png') });
    await page.waitForTimeout(4500); assert.deepEqual(await work(), { frames: 0, timers: 0 });
    await page.locator('#back').click();

    await page.locator('[data-game="breakout"]').click();
    assert.equal(await page.locator('canvas').getAttribute('width'), '360');
    await page.keyboard.press('Space');
    assert.equal((await work()).frames, 1); assert.match(await page.locator('#detail').textContent(), /3 lives/);
    await page.screenshot({ path: resolve(output, 'breakout.png') });
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); assert.deepEqual(await work(), { frames: 0, timers: 0 });

    // Disk-style state load reconstructs methods and keeps miner inventory/settings.
    await page.reload();
    await page.evaluate(saved => window.__zroArcadeLoad(saved), persistent);
    await page.locator('[data-game="factory"]').click();
    assert.equal(await page.locator('[data-buy="0"] .badge').textContent(), '1');
    await page.locator('#back').click(); await page.locator('[data-game="blocks"]').click(); await page.locator('#game-settings').click();
    assert.equal(await page.locator('[data-setting="grid"]').getAttribute('class'), 'switch');
    assert.equal(await page.locator('#start-level').inputValue(), '5');
    await page.locator('#close-settings').click(); await page.locator('#back').click();

    await page.setViewportSize({ width: 400, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve(output, 'menu-narrow.png'), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(requests, [localUrl, localUrl], 'Arcade makes no requests beyond its local document');
    console.log('Arcade UI passed: zro theme, SVG controls, settings, hold/next, miner progression, merge boundaries, Breakout, persistence, idle cancellation, and responsive layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
