//! Page performance init script, injected into every tab.

/// Minimal interaction bridge. Chromium/site-authored hints own HTTP caching,
/// speculative fetches and image priority. Browser-wide hover fetching can
/// issue unwanted credentialed requests and compete with useful page work;
/// walking every image at DOMContentLoaded also forces layout on the hot path.
pub(crate) const PERF_INIT_SCRIPT: &str = r#"
(function() {
  'use strict';
  if (window.__zroPerf) return;
  window.__zroPerf = true;
  // Some sites cancel their image context menu. Keep image actions available
  // without replacing their normal menu for non-image targets.
  addEventListener('contextmenu', function(e) {
    if (!e.isTrusted) return;
    var path=e.composedPath(), img=path.find(function(n){return n&&n.tagName==='IMG';});
    if(!img) return;
    var a=path.find(function(n){return n&&n.matches&&n.matches('a[href]');});
    var data={type:'zro-image-context',src:img.currentSrc||img.src,link:a?a.href:'',page_url:location.href};
    queueMicrotask(function(){
      if(e.defaultPrevented&&window.chrome&&chrome.webview) chrome.webview.postMessage(JSON.stringify(data));
    });
  },true);

  // Capture the actual auxclick: NewWindowRequested arrives after button-up,
  // when GetAsyncKeyState can no longer identify a middle click.
  addEventListener('auxclick', function(e) {
    if (!e.isTrusted || e.button !== 1) return;
    var a = e.composedPath().find(function(n) { return n && n.matches && n.matches('a[href]'); });
    if (!a || a.hasAttribute('download')) return;
    try {
      var u = new URL(a.href, location.href);
      if (!/^https?:$/.test(u.protocol) || !window.chrome || !chrome.webview) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      chrome.webview.postMessage(JSON.stringify({ type: 'zro-background-link', url: u.href }));
    } catch (_) {}
  }, true);

})();
"#;
