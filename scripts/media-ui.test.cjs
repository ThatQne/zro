const {chromium}=require('playwright'),{readFileSync}=require('node:fs'),{resolve}=require('node:path'),assert=require('node:assert/strict');
const source=readFileSync(resolve(__dirname,'../src-tauri/src/browser/perf.rs'),'utf8').split('PERF_INIT_SCRIPT: &str = r#"')[1].split('"#;')[0];
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage();await page.route('https://media.test/**',r=>r.fulfill({body:'',status:200}));await page.goto('https://media.test/');
  await page.evaluate(()=>{window.messages=[];window.chrome=window.chrome||{};chrome.webview={postMessage:s=>messages.push(JSON.parse(s))};document.body.innerHTML='<a href="https://media.test/link"><img id="image" src="https://media.test/picture.webp" width="80" height="80"></a><video id="video" src="https://media.test/clip.mp4" width="120" height="80"></video><div id="background" style="width:80px;height:80px;background-image:url(https://media.test/a.gif)"></div><canvas width="80" height="80"></canvas>';});
  await page.evaluate(source);
  for(const selector of ['#image','#video','#background','canvas'])await page.locator(selector).click({button:'right'});
  const messages=await page.evaluate(()=>messages.filter(m=>m.type==='zro-image-context'));
  assert.equal(messages.length,4);assert.equal(messages[0].link,'https://media.test/link');assert.match(messages[0].src,/webp$/);assert.equal(messages[1].media_kind,'video');assert.match(messages[2].src,/gif$/);assert.match(messages[3].src,/^data:image\/png/);
  console.log('Media context passed: linked WebP, video, CSS GIF background, and canvas export.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
