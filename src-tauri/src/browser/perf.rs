//! Page performance init script, injected into every tab.

/// Instant.page-style predictive prefetch.
/// The old version preconnected to up to 40 origins per page which FOUGHT the
/// page's own resource fetches (connection contention) and made loads SLOWER.
/// This one prefetches a link only on hover-intent (65ms) or mousedown —
/// exactly when a click is imminent — so the next navigation is served from
/// cache. Same-origin only, deduped, capped.
pub(crate) const PERF_INIT_SCRIPT: &str = r#"
(function() {
  'use strict';
  if (window.__zroPerf) return;
  window.__zroPerf = true;

  var done = new Set();
  var hoverTimer = null;

  function prefetch(a) {
    try {
      var u = new URL(a.href, location.href);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
      if (u.origin !== location.origin) return;      // cheap + credential-safe
      var key = u.pathname + u.search;
      if (done.has(key) || done.size > 80) return;
      if (key === location.pathname + location.search) return;
      done.add(key);
      var l = document.createElement('link');
      l.rel = 'prefetch';
      l.href = u.href;
      l.setAttribute('data-zro', '1');
      (document.head || document.documentElement).appendChild(l);
    } catch (e) {}
  }

  function linkFrom(e) {
    var t = e.target;
    return t && t.closest ? t.closest('a[href]') : null;
  }

  // Hover intent: 65ms of hover means a click is likely (instant.page numbers)
  addEventListener('mouseover', function(e) {
    var a = linkFrom(e);
    if (!a) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(function() { prefetch(a); }, 65);
  }, { capture: true, passive: true });
  addEventListener('mouseout', function() { clearTimeout(hoverTimer); },
    { capture: true, passive: true });
  // Mousedown fires ~100-200ms before navigation commits — free head start
  addEventListener('mousedown', function(e) {
    var a = linkFrom(e);
    if (a) prefetch(a);
  }, { capture: true, passive: true });

  // Lazy-load far-below-fold images (don't touch priority of visible ones —
  // the engine's own prioritization is better)
  function lazify() {
    try {
      document.querySelectorAll('img:not([loading])').forEach(function(img) {
        if (img.getBoundingClientRect().top > innerHeight * 1.5) img.loading = 'lazy';
      });
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', lazify, { once: true });
  } else {
    lazify();
  }
})();
"#;
