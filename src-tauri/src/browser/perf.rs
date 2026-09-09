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
