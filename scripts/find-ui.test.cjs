// Optional real-renderer test: run with bundled Playwright on NODE_PATH.
const {chromium}=require('playwright');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const assert=require('node:assert/strict');
const rust=readFileSync(resolve(__dirname,'../src-tauri/src/browser/search.rs'),'utf8');
const script=rust.split('SEARCH_INIT_SCRIPT: &str = r#"')[1].split('"#;')[0];
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://find.test/',route=>route.fulfill({headers:{'Content-Security-Policy':"require-trusted-types-for 'script'"},contentType:'text/html',body:'<!doctype html><html><head></head><body><h1>Allocator benchmark</h1><p>Allocator memory benchmark</p></body></html>'}));
    await page.goto('https://find.test/');
    await page.evaluate(()=>{window.messages=[];window.chrome=window.chrome||{};window.chrome.webview={postMessage:m=>messages.push(JSON.parse(m))};});
    await page.evaluate(script+';window.__zroFind.open();');
    const input=page.locator('#__zroFindHost input');await input.fill('Allocator');
    await page.waitForTimeout(150);assert.equal(await page.locator('#__zroFindHost .count').textContent(),'1/2');
    await input.press('Enter');assert.equal(await page.locator('#__zroFindHost .count').textContent(),'2/2');
    await input.fill('iframe-only-phrase');await page.waitForTimeout(150);
    assert.ok(await page.evaluate(()=>messages.some(m=>m.type==='zro-find'&&m.action==='start'&&m.query==='iframe-only-phrase')));
    await page.evaluate(()=>document.querySelector('#__zroFindHost').remove());
    await page.evaluate(script+';window.__zroFind.open();');assert.equal(await input.isVisible(),true);
    assert.deepEqual(errors,[]);
    console.log('Find UI passed: Trusted Types, literal match cycling, native frame fallback dispatch, and SPA host recovery.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
