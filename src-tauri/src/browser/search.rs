//! Reef-inspired in-page search — replaces WebView2's native Ctrl+F.
//!
//! This is a content script injected into every tab. It runs entirely in the
//! PAGE's renderer process (never the shared UI thread — see the Shields
//! freeze saga), so indexing and highlighting cost the chrome nothing.
//!
//! Two capabilities off one index of the LIVE DOM (so it works on every site,
//! SPAs included — unlike Reef's static sitemap crawl):
//!   • Ctrl+F  — literal substring highlight of all matches (CSS Custom
//!     Highlight API, zero DOM mutation), match count, next/prev, scroll-to.
//!   • Smart results — a typo-tolerant, field-weighted ranked list of the
//!     page's headings / links / buttons / sections you can jump to; the same
//!     `window.__zroFind.query()` the AI calls to read a page.
//!
//! Public API exposed on the page: window.__zroFind = { open, close, query,
//! next, prev, isOpen }.

pub(crate) const SEARCH_INIT_SCRIPT: &str = r#"
(function () {
  'use strict';
  if (window.__zroFind) return;

  var HL = 'zro-find', HLC = 'zro-find-cur';
  var canHL = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

  try {
    var st = document.createElement('style');
    st.textContent =
      // Literal Ctrl+F highlight of ALL matches (native Custom Highlight API,
      // zero DOM mutation). The current match gets the brighter box on top.
      '::highlight(zro-find){background:rgba(255,225,40,0.42);color:inherit}';
    (document.head || document.documentElement).appendChild(st);
  } catch (e) {}

  // ---- bounded Levenshtein (for typo tolerance in ranked results) ----
  function lev(a, b, max) {
    var al = a.length, bl = b.length;
    if (Math.abs(al - bl) > max) return max + 1;
    var prev = [], i, j;
    for (j = 0; j <= bl; j++) prev[j] = j;
    for (i = 1; i <= al; i++) {
      var cur = [i], best = i;
      for (j = 1; j <= bl; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[bl];
  }

  // ---- text nodes (for literal Ctrl+F highlight) ----
  function textNodes() {
    var nodes = [];
    if (!document.body) return nodes;
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement; if (!p) return NodeFilter.FILTER_REJECT;
        var t = p.tagName;
        if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('#__zroFindHost')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n; while ((n = w.nextNode())) nodes.push(n);
    return nodes;
  }

  var matches = [], curIdx = -1;
  var nativeMode = false, nativeTotal = 0, nativeIndex = 0;
  function nativeMessage(action, query) {
    try { window.chrome.webview.postMessage(JSON.stringify({type:'zro-find',action:action,query:query||''})); } catch (_) {}
  }
  function clearHL() {
    try { CSS.highlights.delete(HL); CSS.highlights.delete(HLC); } catch (e) {}
    if (typeof clearJump === 'function') clearJump();
    matches = []; curIdx = -1;
  }
  function runFind(q) {
    clearHL();
    nativeMode = false; nativeTotal = 0;
    nativeMessage('stop');
    if (!q) return;
    var lc = q.toLowerCase(), ranges = [], nodes = textNodes(), i, idx, from;
    for (i = 0; i < nodes.length && ranges.length < 2000; i++) {
      var t = nodes[i].nodeValue.toLowerCase(); from = 0;
      while ((idx = t.indexOf(lc, from)) !== -1) {
        try {
          var r = document.createRange();
          r.setStart(nodes[i], idx); r.setEnd(nodes[i], idx + q.length);
          // Skip matches that aren't actually rendered — display:none menus,
          // collapsed panels, off-DOM templates. They inflated the count
          // ("1/95" when only a few show) and made ↑/↓ land on nothing.
          var rr = r.getBoundingClientRect();
          if (rr.width >= 1 || rr.height >= 1) ranges.push(r);
        } catch (e) {}
        from = idx + q.length;
        if (ranges.length >= 2000) break;
      }
    }
    matches = ranges;
    // Fall back to Chromium's engine for text in cross-origin frames/PDFs.
    if (!ranges.length && q) { nativeMode = true; nativeMessage('start',q); }
    if (canHL && ranges.length) {
      var h = new Highlight();
      for (i = 0; i < ranges.length; i++) h.add(ranges[i]);
      CSS.highlights.set(HL, h);
    }
    // Mark the first match but DON'T scroll — jumping the page while the user
    // is still typing is the "it shouldn't autoscroll" complaint. Scrolling
    // only happens on ↑/↓ (step) or clicking a result (jump).
    if (ranges.length) { curIdx = 0; focusMatch(false); }
  }
  function focusMatch(scroll) {
    if (curIdx < 0 || !matches[curIdx]) return;
    if (canHL) { var h = new Highlight(); h.add(matches[curIdx]); CSS.highlights.set(HLC, h); }
    var el = matches[curIdx].startContainer.parentElement;
    if (scroll && el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Box the matched substring itself (its own rect), the one dynamic outline.
    hiliteTarget(matches[curIdx], el || document.body);
  }
  function step(d) {
    if (nativeMode) { nativeMessage(d > 0 ? 'next' : 'prev'); return; }
    if (!matches.length) return;
    curIdx = (curIdx + d + matches.length) % matches.length;
    focusMatch(true); renderCount();
  }

  // ---- structured index (ranked results + the AI's read tool) ----
  var SEL = 'h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,a[href],button,[role=button],summary,label,figcaption,blockquote';
  function weightOf(tag, role) {
    if (/^H[1-3]$/.test(tag)) return 3.2;
    if (/^H[4-6]$/.test(tag)) return 2.4;
    if (tag === 'A' || tag === 'BUTTON' || role === 'button' || tag === 'SUMMARY') return 2.0;
    if (tag === 'LABEL') return 1.6;
    return 1.0;
  }
  function typeOf(tag, role) {
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || role === 'button' || tag === 'SUMMARY') return 'button';
    if (tag === 'LABEL') return 'field';
    return 'text';
  }
  function buildRecords() {
    var out = [], seen = 0;
    var els = document.querySelectorAll(SEL);
    for (var i = 0; i < els.length && seen < 4000; i++) {
      var el = els[i];
      if (el.closest && el.closest('#__zroFindHost')) continue;
      // Skip elements that aren't rendered (display:none subtrees, detached
      // templates) — they polluted the results with unreachable entries.
      if (!el.offsetParent && el.tagName !== 'BODY') continue;
      // innerText (not textContent) already excludes hidden descendants.
      var txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 400) { if (txt.length > 400) txt = txt.slice(0, 400); else continue; }
      var tag = el.tagName, role = el.getAttribute && el.getAttribute('role');
      out.push({
        el: el, text: txt, low: txt.toLowerCase(),
        toks: txt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
        w: weightOf(tag, role), type: typeOf(tag, role), tag: tag.toLowerCase(),
        href: tag === 'A' ? el.href : undefined
      });
      seen++;
    }
    return out;
  }
  function scoreRec(rec, terms) {
    var s = 0;
    for (var i = 0; i < terms.length; i++) {
      var term = terms[i], hit = 0;
      if (rec.low.indexOf(term) !== -1) hit = 1;
      else if (term.length >= 4) {
        var max = term.length <= 6 ? 1 : 2, best = 99;
        for (var j = 0; j < rec.toks.length; j++) {
          var d = lev(term, rec.toks[j], max);
          if (d < best) best = d;
          if (best === 0) break;
        }
        if (best <= max) hit = 0.5 * (1 - best / (max + 1));
      }
      if (!hit) return 0; // every term must appear (AND semantics)
      s += hit;
    }
    return s * rec.w;
  }
  // Ranked records WITH their live .el — the UI keeps these so clicking a
  // result jumps to the exact element (no fragile re-scoring).
  function rankRecords(q, limit) {
    limit = limit || 20;
    var terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    var recs = buildRecords(), scored = [];
    for (var i = 0; i < recs.length; i++) {
      var sc = scoreRec(recs[i], terms);
      if (sc > 0) scored.push({ r: recs[i], s: sc });
    }
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored.slice(0, limit).map(function (x) { return x.r; });
  }
  // AI-facing: same ranking, stripped to plain JSON (no DOM refs).
  function query(q, limit) {
    return rankRecords(q, limit || 20).map(function (r) {
      return { type: r.type, tag: r.tag, text: r.text, href: r.href || null };
    });
  }

  // ---- overlay (Shadow DOM, top-right find bar + ranked results) ----
  var host, root, input, countEl, listEl, open_ = false, resultRecs = [], sel = -1, deb;
  function css() {
    return '' +
      ':host{all:initial}' +
      '.bar{position:fixed;top:12px;right:16px;z-index:2147483647;width:340px;' +
      'font:13px -apple-system,Segoe UI,Roboto,sans-serif;color:#e4e4e4;' +
      'background:#161616;border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
      'box-shadow:0 12px 40px rgba(0,0,0,0.6);overflow:hidden}' +
      '.row{display:flex;align-items:center;gap:6px;padding:8px 10px}' +
      'input{flex:1;background:transparent;border:none;outline:none;color:#e4e4e4;font-size:13px}' +
      'input::placeholder{color:#666}' +
      '.count{font-size:11px;color:#888;min-width:38px;text-align:right}' +
      '.btn{width:22px;height:22px;border:none;background:transparent;color:#8f8f8f;cursor:pointer;' +
      'border-radius:5px;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center}' +
      '.btn:hover{background:rgba(255,255,255,0.09);color:#e4e4e4}' +
      '.list{max-height:300px;overflow-y:auto;border-top:1px solid rgba(255,255,255,0.07)}' +
      '.list:empty{display:none}' +
      '.it{display:flex;gap:8px;align-items:center;padding:7px 10px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04)}' +
      '.it:hover,.it.sel{background:rgba(79,128,245,0.16)}' +
      '.it .k{font-size:8.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;' +
      'padding:2px 6px;border-radius:4px;flex-shrink:0;line-height:1.35;' +
      'background:rgba(79,128,245,0.16);color:#7aa2f7}' + /* heading (default) */
      '.it .k.link{background:rgba(79,181,106,0.18);color:#69cf85}' +
      '.it .k.button{background:rgba(232,160,48,0.18);color:#f0b45a}' +
      '.it .k.field{background:rgba(176,122,216,0.18);color:#c79ae6}' +
      '.it .k.text{background:rgba(255,255,255,0.08);color:#9a9a9a}' +
      '.it .t{font-size:12px;color:#c8c8c8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
  }
  function build() {
    host = document.createElement('div');
    host.id = '__zroFindHost';
    root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style'); style.textContent = css(); root.appendChild(style);
    var bar = document.createElement('div'); bar.className = 'bar';
    // Trusted Types sites reject innerHTML assignments. Build inert DOM.
    var row = document.createElement('div'); row.className = 'row';
    input = document.createElement('input'); input.type = 'text'; input.placeholder = 'Find on page'; input.spellcheck = false; row.appendChild(input);
    countEl = document.createElement('span'); countEl.className = 'count'; row.appendChild(countEl);
    [['prev','↑','Previous (Shift+Enter)'],['next','↓','Next (Enter)'],['close','✕','Close (Esc)']].forEach(function (v) {
      var b = document.createElement('button'); b.className = 'btn'; b.setAttribute('data-a',v[0]); b.textContent = v[1]; b.title = v[2]; row.appendChild(b);
    });
    listEl = document.createElement('div'); listEl.className = 'list'; bar.appendChild(row); bar.appendChild(listEl);
    root.appendChild(bar);
    input = root.querySelector('input');
    countEl = root.querySelector('.count');
    listEl = root.querySelector('.list');
    bar.addEventListener('mousedown', function (e) {
      var b = e.target.closest ? e.target.closest('.btn') : null;
      if (b) { e.preventDefault(); var a = b.getAttribute('data-a'); if (a === 'next') step(1); else if (a === 'prev') step(-1); else close(); }
      var it = e.target.closest ? e.target.closest('.it') : null;
      if (it) { e.preventDefault(); jump(parseInt(it.getAttribute('data-i'), 10)); }
    });
    input.addEventListener('input', function () {
      clearTimeout(deb);
      var v = input.value;
      deb = setTimeout(function () { runFind(v); renderResults(v); renderCount(); }, 90);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); if (sel >= 0) jump(sel); else step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
    });
    document.documentElement.appendChild(host);

    // SPA route changes swap the DOM without a page load; re-index so the bar
    // reflects the new page ("doesn't rescan even on a new page"). A short
    // delay lets the new content render first.
    function rescan() {
      if (!open_) return;
      var v = input.value;
      setTimeout(function () { if (open_) { runFind(v); renderResults(v); renderCount(); } }, 300);
    }
    addEventListener('popstate', rescan);
    addEventListener('hashchange', rescan);
  }
  function renderCount() {
    if (!countEl) return;
    countEl.textContent = nativeMode && nativeTotal ? (nativeIndex+1)+'/'+nativeTotal : matches.length ? (curIdx + 1) + '/' + matches.length : (input.value ? '0/0' : '');
  }
  function renderResults(q) {
    resultRecs = rankRecords(q, 12); sel = -1; // records keep their live .el
    listEl.replaceChildren();
    resultRecs.forEach(function (r, i) {
      var it = document.createElement('div'); it.className = 'it'; it.setAttribute('data-i',i);
      var k = document.createElement('span'); k.className = 'k '+r.type; k.textContent = r.type;
      var t = document.createElement('span'); t.className = 't'; t.textContent = r.text.length > 90 ? r.text.slice(0,90)+'…' : r.text;
      it.appendChild(k); it.appendChild(t); listEl.appendChild(it);
    });
  }
  function moveSel(d) {
    if (!resultRecs.length) return;
    sel = (sel + d + resultRecs.length) % resultRecs.length;
    var its = listEl.querySelectorAll('.it');
    for (var i = 0; i < its.length; i++) its[i].classList.toggle('sel', i === sel);
    if (its[sel]) its[sel].scrollIntoView({ block: 'nearest' });
  }
  // ---- jump highlighter: ONE box, in DOCUMENT coordinates ----
  // A single overlay box (not per-line fragments) with a translucent yellow
  // fill (the visible "background highlight") plus a solid border. It's
  // positioned in PAGE coordinates (pageX/Y + rect) inside an absolutely-
  // positioned host, so the browser scrolls it WITH the content natively —
  // zero JS-per-scroll, no lag. It only repositions on resize / layout settle.
  // Fill strength adapts to the font color so text stays readable.
  var hlHost, hlBox, jumpTok = 0, hlEl = null, hlRange = null;
  function ensureHlHost() {
    if (hlHost && hlHost.isConnected) return;
    hlHost = document.createElement('div');
    hlHost.id = '__zroHiliteHost';
    var r = hlHost.attachShadow({ mode: 'open' });
    var s = document.createElement('style');
    s.textContent =
      ':host{all:initial}' +
      // absolute (NOT fixed) at the page origin → scrolls with the document.
      '.wrap{position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483646}' +
      '.box{position:absolute;box-sizing:border-box;border:2px solid rgba(255,201,0,0.95);' +
      'border-radius:5px;box-shadow:0 0 0 1px rgba(0,0,0,0.15);' +
      'transition:background-color .35s ease-out,opacity .2s;opacity:0}' +
      '.box.on{opacity:1}';
    r.appendChild(s);
    var wrap = document.createElement('div'); wrap.className = 'wrap';
    hlBox = document.createElement('div'); hlBox.className = 'box';
    wrap.appendChild(hlBox); r.appendChild(wrap);
    document.documentElement.appendChild(hlHost);
    // Layout can shift the target (resize, font swap, images) — realign then.
    addEventListener('resize', placeBox);
  }
  function fontLuma(el) {
    try {
      var m = getComputedStyle(el).color.match(/\d+(\.\d+)?/g);
      if (!m) return 0.5;
      return (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255;
    } catch (e) { return 0.5; }
  }
  function curRect() {
    try { if (hlRange) return hlRange.getBoundingClientRect(); } catch (e) {}
    try { if (hlEl) return hlEl.getBoundingClientRect(); } catch (e) {}
    return null;
  }
  function placeBox() {
    if (!hlBox) return;
    var r = curRect();
    if (!r || (r.width < 1 && r.height < 1)) { hlBox.classList.remove('on'); return; }
    var pad = 3;
    hlBox.style.left = (r.left + (window.pageXOffset || 0) - pad) + 'px';
    hlBox.style.top = (r.top + (window.pageYOffset || 0) - pad) + 'px';
    hlBox.style.width = (r.width + pad * 2) + 'px';
    hlBox.style.height = (r.height + pad * 2) + 'px';
    hlBox.classList.add('on');
  }
  function clearJump() {
    jumpTok++;
    hlEl = null; hlRange = null;
    if (hlBox) hlBox.classList.remove('on');
  }
  // Highlight one target: `range` (Ctrl+F match) or the element itself (jump).
  // Flash bright, then settle to a lighter persistent wash chosen by font color.
  function hiliteTarget(range, el) {
    ensureHlHost();
    hlRange = range || null;
    hlEl = el || null;
    var tok = ++jumpTok;
    placeBox();
    var soft = fontLuma(el) > 0.55 ? 'rgba(255,236,110,0.32)' : 'rgba(255,212,0,0.48)';
    hlBox.style.backgroundColor = 'rgba(255,229,80,0.85)';   // flash
    setTimeout(function () { if (tok === jumpTok) hlBox.style.backgroundColor = soft; }, 520);
    // Re-place after the smooth scroll / any late layout settles.
    requestAnimationFrame(function () { if (tok === jumpTok) placeBox(); });
    setTimeout(function () { if (tok === jumpTok) placeBox(); }, 320);
  }

  function jump(i) {
    var rec = resultRecs[i];
    if (!rec || !rec.el) return;
    var el = rec.el;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    hiliteTarget(null, el);
    // NOTE: deliberately NOT focusing the element — the browser's focus ring
    // (a white/blue outline on links & buttons) was the "white border".
  }
  function open() {
    if (!host) build();
    if (!host.isConnected) document.documentElement.appendChild(host);
    open_ = true; host.style.display = '';
    var q = (window.getSelection && String(window.getSelection())) || '';
    if (q && q.length < 80) { input.value = q.replace(/\s+/g, ' ').trim(); }
    input.focus(); input.select();
    if (input.value) { runFind(input.value); renderResults(input.value); }
    renderCount();
  }
  function close() {
    nativeMessage('stop'); nativeMode = false;
    open_ = false; clearHL();   // clearHL now also clears the jump wash + border
    if (listEl) listEl.replaceChildren();
    if (host) host.style.display = 'none';
  }

  window.__zroFind = {
    nativeCount: function(total,index) { if(nativeMode){nativeTotal=total;nativeIndex=index;renderCount();} },
    open: open, close: close, query: query,
    next: function () { step(1); }, prev: function () { step(-1); },
    isOpen: function () { return open_; }
  };
})();
"#;

/// Open the in-page find bar on the active tab (invoked by the Ctrl+F route,
/// page- or chrome-focused). Focuses the webview first so its input takes keys.
#[tauri::command]
pub async fn open_find(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(wv) = super::active_webview(&app) {
        let _ = wv.set_focus();
        wv.eval(format!("{};window.__zroFind.open();", SEARCH_INIT_SCRIPT))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) unsafe fn native_message(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    value: &serde_json::Value,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment15, ICoreWebView2_2, ICoreWebView2_28,
    };
    use windows_core::{Interface, HSTRING};
    let Ok(wv) = core.cast::<ICoreWebView2_28>() else {
        return;
    };
    let Ok(find) = wv.Find() else {
        return;
    };
    match value["action"].as_str().unwrap_or("") {
        "stop" => {
            let _ = find.Stop();
        }
        "next" => {
            let _ = find.FindNext();
            update_native_count(core, &find);
        }
        "prev" => {
            let _ = find.FindPrevious();
            update_native_count(core, &find);
        }
        "start" => {
            let query = value["query"].as_str().unwrap_or("");
            if query.is_empty() || query.len() > 512 {
                return;
            }
            let options = core
                .cast::<ICoreWebView2_2>()
                .and_then(|c| c.Environment())
                .and_then(|e| e.cast::<ICoreWebView2Environment15>())
                .and_then(|e| e.CreateFindOptions());
            let Ok(options) = options else {
                return;
            };
            let _ = options.SetFindTerm(&HSTRING::from(query));
            let _ = options.SetShouldHighlightAllMatches(true);
            let f = find.clone();
            let c = core.clone();
            let done = webview2_com::FindStartCompletedHandler::create(Box::new(move |result| {
                if result.is_ok() {
                    let mut count = 0;
                    let mut index = 0;
                    let _ = f.MatchCount(&mut count);
                    let _ = f.ActiveMatchIndex(&mut index);
                    let script = HSTRING::from(format!(
                        "window.__zroFind&&window.__zroFind.nativeCount({count},{index})"
                    ));
                    let cb = webview2_com::ExecuteScriptCompletedHandler::create(Box::new(
                        |_, _| Ok(()),
                    ));
                    let _ = c.ExecuteScript(&script, &cb);
                }
                Ok(())
            }));
            let _ = find.Start(&options, &done);
        }
        _ => {}
    }
}

#[cfg(windows)]
unsafe fn update_native_count(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    find: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Find,
) {
    let mut count = 0;
    let mut index = 0;
    let _ = find.MatchCount(&mut count);
    let _ = find.ActiveMatchIndex(&mut index);
    let script = windows_core::HSTRING::from(format!(
        "window.__zroFind&&window.__zroFind.nativeCount({count},{index})"
    ));
    let cb = webview2_com::ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
    let _ = core.ExecuteScript(&script, &cb);
}
