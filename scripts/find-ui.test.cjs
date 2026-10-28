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
    await page.waitForTimeout(350);assert.equal(await page.locator('#__zroFindHost .count').textContent(),'1/2');
    await input.press('Enter');assert.equal(await page.locator('#__zroFindHost .count').textContent(),'2/2');
    await input.press('ArrowUp');assert.equal(await page.locator('#__zroFindHost .count').textContent(),'1/2');
    await input.press('ArrowDown');assert.equal(await page.locator('#__zroFindHost .count').textContent(),'2/2');
    await page.locator('#__zroFindHost [data-a="prev"]').click();assert.equal(await page.locator('#__zroFindHost .count').textContent(),'1/2');
    await input.fill('iframe-only-phrase');await page.waitForTimeout(350);
    assert.ok(await page.evaluate(()=>messages.some(m=>m.type==='zro-find'&&m.action==='start'&&m.query==='iframe-only-phrase')));
    await page.evaluate(()=>document.querySelector('#__zroFindHost').remove());
    await page.evaluate(script+';window.__zroFind.open();');assert.equal(await input.isVisible(),true);
    await page.evaluate(()=>{
      const host=document.querySelector('#__zroFindHost');document.body.replaceChildren();document.documentElement.append(host);
      const fragment=document.createDocumentFragment();for(let i=0;i<30000;i++){const p=document.createElement('p');p.textContent='e repeated text with many letters '.repeat(8);fragment.append(p);}document.body.append(fragment);
      window.rectReads=0;const original=Range.prototype.getBoundingClientRect;Range.prototype.getBoundingClientRect=function(){rectReads++;return original.call(this);};
    });
    const began=Date.now();await input.fill('e');await page.waitForTimeout(500);
    assert.match(await page.locator('#__zroFindHost .count').textContent(),/250\+$/);
    assert.ok(await page.evaluate(()=>rectReads<10),'No layout read per match');
    await input.fill('this phrase is absent');await input.fill('e');await input.press('Escape');
    await page.waitForTimeout(300);assert.equal(await input.isVisible(),false,'Closing cancels pending searches');
    await page.evaluate(()=>{window.__zroFindEngine=true;window.__zroFind.open();window.walks=0;document.createTreeWalker=()=>{walks++;throw Error('Engine search must not scan DOM')};});
    await input.fill('native-only');await page.waitForTimeout(350);
    assert.equal(await page.evaluate(()=>walks),0);
    await input.press('ArrowDown');await input.press('ArrowUp');
    assert.deepEqual(await page.evaluate(()=>messages.filter(m=>['next','prev'].includes(m.action)).slice(-2).map(m=>m.action)),['next','prev']);
    assert.ok(Date.now()-began<10000,'Large document search remains responsive');
    assert.deepEqual(errors,[]);
    console.log('Find UI passed: Trusted Types, match cycling, native engine dispatch, SPA recovery, 30,000-paragraph stress, bounded layout reads, and cancel-on-close.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
