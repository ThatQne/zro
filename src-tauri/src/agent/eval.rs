//! Page script evaluation with result + the page tool scripts.
//!
//! Tool results are read back from the page via WebView2 ExecuteScript,
//! which — unlike tauri's fire-and-forget eval — returns the script's
//! completion value as JSON.

use std::time::Duration;
use tauri::AppHandle;

use crate::browser::active_webview;

/// Run JS in the active tab's webview and get the completion value back.
pub async fn eval_with_result(app: &AppHandle, script: String) -> Result<String, String> {
    eval_in(app, None, script).await
}

/// Run JS in a specific tab's webview (None = active tab).
pub async fn eval_in(app: &AppHandle, target: Option<&str>, script: String) -> Result<String, String> {
    let wv = match target {
        // Through the label indirection — a warm-spare-adopted tab's webview
        // label is not its tab id
        Some(id) => crate::browser::tab_webview(app, id).ok_or("no such tab")?,
        None => active_webview(app).ok_or("no active tab")?,
    };
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();

    #[cfg(windows)]
    wv.with_webview(move |pwv| {
        use webview2_com::ExecuteScriptCompletedHandler;
        use windows_core::HSTRING;
        unsafe {
            let controller = pwv.controller();
            match controller.CoreWebView2() {
                Ok(core) => {
                    let js = HSTRING::from(script.as_str());
                    let tx2 = tx.clone();
                    let handler = ExecuteScriptCompletedHandler::create(Box::new(
                        move |err: windows_core::Result<()>, result: String| {
                            let _ = tx2.send(match err {
                                Ok(()) => Ok(result),
                                Err(e) => Err(e.to_string()),
                            });
                            Ok(())
                        },
                    ));
                    if let Err(e) = core.ExecuteScript(&js, &handler) {
                        let _ = tx.send(Err(e.to_string()));
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;

    #[cfg(not(windows))]
    {
        let _ = tx.send(Err("page tools only supported on Windows".into()));
    }

    tokio::task::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "page script timed out".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Page tool scripts ─────────────────────────────────────────────────────────

pub(crate) fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// run_js: execute agent-written JS (a function body) and return its value.
/// The wrapper keeps page errors as structured results instead of COM errors
/// and caps the payload so a `return document.body.innerHTML` can't blow the
/// context window.
pub(crate) fn run_js_js(code: &str) -> String {
    format!(
        r#"
(function(){{
  try {{
    var __r = (function(){{ {code} }})();
    var __s;
    try {{ __s = JSON.stringify(__r); }} catch (e) {{ __s = undefined; }}
    if (__s === undefined) __s = String(__r);
    var __total = __s.length;
    if (__s.length > 8000) __s = __s.slice(0, 8000);
    return JSON.stringify({{ ok: true, result: __s, result_length: __total, truncated: __total > 8000 }});
  }} catch (e) {{
    return JSON.stringify({{ ok: false, error: String((e && e.stack) || e) }});
  }}
}})()"#
    )
}

/// Stable-ish CSS path builder shared by the page tools (inlined into each
/// script — ExecuteScript runs them as isolated expressions).
const CSS_PATH_FN: &str = r#"
  function cssPath(el){
    if (el.id) return '#' + CSS.escape(el.id);
    var path = [], n = el;
    while (n && n.nodeType === 1 && path.length < 5) {
      if (n.id) { path.unshift('#' + CSS.escape(n.id)); break; }
      var seg = n.tagName.toLowerCase();
      var p = n.parentElement;
      if (p) {
        var sib = Array.prototype.filter.call(p.children, function(c){ return c.tagName === n.tagName; });
        if (sib.length > 1) seg += ':nth-of-type(' + (Array.prototype.indexOf.call(sib, n) + 1) + ')';
      }
      path.unshift(seg);
      n = p;
    }
    return path.join('>');
  }"#;

/// read_page returns text PLUS the interactive skeleton: dropdowns with
/// their options, buttons/tabs with selectors, pagination controls and
/// scroll state — without these the agent is blind to anything it must
/// operate (e.g. a transactions-type filter dropdown + paged table).
pub(crate) fn read_page_js() -> String {
    format!(r#"
(function(){{
  {CSS_PATH_FN}
  // Prefer the page's main-content region (Scrapling-style extraction) so the
  // 6k budget isn't burned on nav bars / footers — fall back to body when the
  // region is empty or suspiciously small (SPAs that render elsewhere).
  var full = document.body ? document.body.innerText : '';
  var root = document.querySelector('main, [role=main], article');
  var t = root ? root.innerText : '';
  if (!t || t.length < 500) t = full;
  var total = t.length;
  t = t.replace(/\n{{3,}}/g, '\n\n').slice(0, 6000);
  var controls = [];
  var els = document.querySelectorAll('select, button, [role=button], [role=tab], [role=combobox], [role=listbox], [aria-haspopup], input[type=submit]');
  for (var i = 0; i < els.length && controls.length < 30; i++) {{
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    var label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!label && el.tagName !== 'SELECT') continue;
    var c = {{ tag: el.tagName.toLowerCase(), text: label, selector: cssPath(el) }};
    if (el.tagName === 'SELECT') {{
      c.options = Array.prototype.slice.call(el.options, 0, 20).map(function(o){{ return o.text.trim().slice(0, 40); }});
      c.selected = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text.trim() : '';
    }}
    controls.push(c);
  }}
  var pag = [];
  var pa = document.querySelectorAll('a[rel=next], [aria-label*="next" i], [aria-label*="page" i], .pagination a, .pagination button, [class*="pager"] button');
  for (var j = 0; j < pa.length && pag.length < 6; j++) {{
    var lp = (pa[j].innerText || pa[j].getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    if (lp) pag.push({{ text: lp, selector: cssPath(pa[j]) }});
  }}
  return {{
    title: document.title, url: location.href,
    scroll: {{ y: Math.round(scrollY), remaining: Math.max(0, Math.round(document.body.scrollHeight - innerHeight - scrollY)) }},
    text: t, text_truncated: total > 6000, full_text_length: full.length,
    controls: controls, pagination: pag
  }};
}})()"#)
}

/// find_text: substring search over the FULL page text (read_page truncates
/// at 6k — long inboxes/threads/tables live past that). Returns match
/// snippets with surrounding context plus the total hit count.
pub(crate) fn find_text_js(query: &str) -> String {
    format!(r#"
(function(){{
  var q = {q};
  var t = document.body ? document.body.innerText : '';
  var lower = t.toLowerCase(), needle = q.toLowerCase();
  if (!needle) return {{ ok: false, error: 'empty query' }};
  var out = [], total = 0, i = 0;
  while (true) {{
    i = lower.indexOf(needle, i);
    if (i === -1) break;
    total++;
    if (out.length < 8) {{
      var s = Math.max(0, i - 160), e = Math.min(t.length, i + needle.length + 160);
      out.push(t.slice(s, e).replace(/\s+/g, ' ').trim());
      i = e;
    }} else {{
      i = i + needle.length;
    }}
  }}
  if (!total) return {{ ok: false, error: 'no matches', page_text_length: t.length }};
  return {{ matches: out, total: total, page_text_length: t.length }};
}})()"#, q = js_str(query))
}

/// find: locate visible interactive elements by their text — returns ready
/// CSS selectors so the model never guesses them.
pub(crate) fn find_js(query: &str) -> String {
    format!(r#"
(function(){{
  {CSS_PATH_FN}
  var q = {q}.toLowerCase();
  var out = [];
  var els = document.querySelectorAll('a, button, [role=button], [role=tab], [role=menuitem], [role=option], select, input, label, [aria-haspopup], [onclick]');
  for (var i = 0; i < els.length && out.length < 15; i++) {{
    var el = els[i];
    var own = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.value || ''));
    if (own.length > 250) continue; // skip giant containers
    if (own.toLowerCase().indexOf(q) === -1) continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    var item = {{
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.getAttribute('aria-label') || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      selector: cssPath(el)
    }};
    if (el.href) item.href = el.href;
    out.push(item);
  }}
  return out.length ? out : {{ ok: false, error: 'no visible element contains that text' }};
}})()"#, q = js_str(query))
}

/// select_option: native <select> value change with framework-safe events.
pub(crate) fn select_option_js(selector: &str, value: &str) -> String {
    format!(r#"
(function(){{
  var el = document.querySelector({sel});
  if (!el) return {{ ok: false, error: 'no element matches selector' }};
  if (el.tagName !== 'SELECT') return {{ ok: false, error: 'element is not a <select> — use click for custom dropdowns' }};
  var want = {val}, v = want.toLowerCase(), hit = null;
  for (var i = 0; i < el.options.length; i++) {{
    var o = el.options[i];
    if (o.value === want || o.text.trim().toLowerCase() === v) {{ hit = o; break; }}
  }}
  if (!hit) for (var j = 0; j < el.options.length; j++) {{
    if (el.options[j].text.toLowerCase().indexOf(v) !== -1) {{ hit = el.options[j]; break; }}
  }}
  if (!hit) return {{ ok: false, error: 'no option matches', options: Array.prototype.map.call(el.options, function(o){{ return o.text.trim(); }}).slice(0, 20) }};
  var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
  if (setter && setter.set) setter.set.call(el, hit.value); else el.value = hit.value;
  el.dispatchEvent(new Event('input',  {{ bubbles: true }}));
  el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  return {{ ok: true, selected: hit.text.trim() }};
}})()"#, sel = js_str(selector), val = js_str(value))
}

pub(crate) const GET_LINKS_JS: &str = r#"
(function(){
  var out = [];
  var as = document.querySelectorAll('a[href]');
  for (var i = 0; i < as.length && out.length < 40; i++) {
    var t = (as[i].innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (t) out.push({ text: t, href: as[i].href });
  }
  return out;
})()"#;

/// Click: prefer the first VISIBLE match (querySelector alone often lands on
/// a hidden duplicate — "clicked" but nothing happened), and fire the full
/// pointer/mouse sequence — React/custom widgets listen to pointerdown or
/// mousedown, not the bare click() call.
pub(crate) fn click_js(selector: &str) -> String {
    format!(r#"
(function(){{
  var els = document.querySelectorAll({sel});
  if (!els.length) return {{ ok: false, error: 'no element matches selector' }};
  var el = null;
  for (var i = 0; i < els.length; i++) {{
    var r = els[i].getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {{ el = els[i]; break; }}
  }}
  var hidden = !el;
  if (!el) el = els[0];
  el.scrollIntoView({{ block: 'center' }});
  var r = el.getBoundingClientRect();
  var o = {{ bubbles: true, cancelable: true, view: window,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }};
  try {{ el.dispatchEvent(new PointerEvent('pointerdown', o)); }} catch (e) {{}}
  el.dispatchEvent(new MouseEvent('mousedown', o));
  try {{ el.dispatchEvent(new PointerEvent('pointerup', o)); }} catch (e) {{}}
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.click();
  var out = {{ ok: true, clicked: el.tagName,
              text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80) }};
  if (hidden) out.warning = 'all matches were invisible - clicked a hidden element, likely no effect';
  return out;
}})()"#, sel = js_str(selector))
}

/// Where the page is after a click settled — lets the model SEE whether the
/// click actually did something instead of trusting ok:true.
pub(crate) const PAGE_AFTER_JS: &str =
    "(function(){ return { url: location.href, title: document.title }; })()";

pub(crate) fn fill_js(selector: &str, value: &str) -> String {
    format!(r#"
(function(){{
  var el = document.querySelector({sel});
  if (!el) return {{ ok: false, error: 'no element matches selector' }};
  el.focus();
  var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
  var setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
  if (setter && setter.set) setter.set.call(el, {val}); else el.value = {val};
  el.dispatchEvent(new Event('input',  {{ bubbles: true }}));
  el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  return {{ ok: true }};
}})()"#, sel = js_str(selector), val = js_str(value))
}

pub(crate) fn scroll_js(direction: &str) -> String {
    let expr = match direction {
        "top" => "window.scrollTo(0, 0)",
        "bottom" => "window.scrollTo(0, document.body.scrollHeight)",
        "up" => "window.scrollBy(0, -window.innerHeight * 0.8)",
        _ => "window.scrollBy(0, window.innerHeight * 0.8)",
    };
    format!("(function(){{ {expr}; return {{ ok: true, y: Math.round(window.scrollY) }}; }})()")
}

/// Page metadata for tab titles + real favicons. Works for background tabs
/// via the optional id (active tab when omitted).
#[tauri::command]
pub async fn get_page_meta(app: AppHandle, id: Option<String>) -> Result<serde_json::Value, String> {
    const META_JS: &str = r#"
(function(){
  var best = null, bestScore = -1;
  var links = document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
  for (var i = 0; i < links.length; i++) {
    var l = links[i];
    if (!l.href) continue;
    var score = 0;
    var sizes = (l.getAttribute('sizes') || '').split('x')[0];
    if (sizes && !isNaN(parseInt(sizes))) score = Math.min(parseInt(sizes), 64);
    else if ((l.rel || '').indexOf('apple') !== -1) score = 32;
    else score = 16;
    if (score > bestScore) { bestScore = score; best = l.href; }
  }
  if (!best && location.protocol.indexOf('http') === 0) best = location.origin + '/favicon.ico';
  return { title: document.title, url: location.href, favicon: best };
})()"#;
    let raw = eval_in(&app, id.as_deref(), META_JS.to_string()).await?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}
