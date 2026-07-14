//! Tool definitions (OpenAI function-call schema, shared by both chat loops)
//! and the dispatcher that runs them against the live page / memory stores.

use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::browser::cookies::cookies_for;
use crate::browser::navigate_wv;

use super::eval::{
    click_js, eval_in, fill_js, find_js, find_text_js, js_str, read_page_js,
    run_js_js, scroll_js, select_option_js, GET_LINKS_JS,
};
use super::facts::{recall_facts, remember_fact};
use super::semantic::search_memory;

/// Every page tool accepts this — omit it for the active tab.
const TAB_ID_PROP: &str = "Optional tab id from list_tabs; omit for the active tab";

pub(crate) fn tool_defs() -> serde_json::Value {
    serde_json::json!([
        { "type": "function", "function": {
            "name": "web_search",
            "description": "Search the web instantly WITHOUT opening any tab. Returns titles, urls and snippets in one step. ALWAYS use this first for factual or current-info questions — never navigate the visible tab to a search engine and click through results. Often the snippets alone answer the question; otherwise pass the best urls to read_url.",
            "parameters": { "type": "object", "properties": {
                "query": { "type": "string", "description": "Search query" }
            }, "required": ["query"] } } },
        { "type": "function", "function": {
            "name": "read_url",
            "description": "Fetch up to 5 URLs IN PARALLEL and return the readable text of each — no tabs opened, no page rendering, ~1s total. Pass all urls you want to read in ONE call (e.g. the top 3 web_search hits), not one call per url. Use navigate only when the task needs to interact with the page or the user wants it open.",
            "parameters": { "type": "object", "properties": {
                "urls": { "type": "array", "items": { "type": "string" }, "description": "1-5 full URLs including https://" }
            }, "required": ["urls"] } } },
        { "type": "function", "function": {
            "name": "list_tabs",
            "description": "List every open browser tab (id, title, url, active). Use the ids with the tab_id parameter of other tools to read or operate background tabs, or with switch_tab.",
            "parameters": { "type": "object", "properties": {} } } },
        { "type": "function", "function": {
            "name": "switch_tab",
            "description": "Bring a tab to the foreground.",
            "parameters": { "type": "object", "properties": {
                "tab_id": { "type": "string", "description": "Tab id from list_tabs" }
            }, "required": ["tab_id"] } } },
        { "type": "function", "function": {
            "name": "read_page",
            "description": "Read a page: visible text, title, URL, scroll state, plus its interactive skeleton — dropdowns (with their options and ready CSS selectors), buttons, tabs and pagination controls. Call this after every navigate/click to see what you can operate.",
            "parameters": { "type": "object", "properties": {
                "tab_id": { "type": "string", "description": TAB_ID_PROP }
            } } } },
        { "type": "function", "function": {
            "name": "get_links",
            "description": "List up to 40 links (text + href) on a page.",
            "parameters": { "type": "object", "properties": {
                "tab_id": { "type": "string", "description": TAB_ID_PROP }
            } } } },
        { "type": "function", "function": {
            "name": "find",
            "description": "Find visible interactive elements (links, buttons, tabs, dropdowns, menu items) whose text matches a phrase. Returns ready-to-use CSS selectors — use this instead of guessing selectors.",
            "parameters": { "type": "object", "properties": {
                "text": { "type": "string", "description": "Text to look for, e.g. 'Community Payouts' or 'Next page'" },
                "tab_id": { "type": "string", "description": TAB_ID_PROP }
            }, "required": ["text"] } } },
        { "type": "function", "function": {
            "name": "find_text",
            "description": "Search the FULL text of a page for a phrase and get matching snippets with context plus the total hit count. read_page truncates long pages at ~6k chars — use this to reach content past that (long inboxes, threads, tables) or to confirm/quote an exact value.",
            "parameters": { "type": "object", "properties": {
                "text": { "type": "string", "description": "Phrase to search for, e.g. a sender name, 'born', or '$'" },
                "tab_id": { "type": "string", "description": TAB_ID_PROP }
            }, "required": ["text"] } } },
        { "type": "function", "function": {
            "name": "search_page",
            "description": "RANKED, typo-tolerant search of the current page — returns the best-matching headings, links, buttons, form fields and text sections as structured results ({type, tag, text, href}), not a raw dump. This is the fastest way to LOCATE something specific on a page (a section, a button, a value); prefer it over read_page/find_text when you know what you're looking for. Multiple words are AND-matched and ranked by relevance (headings and links weighted higher).",
            "parameters": { "type": "object", "properties": {
                "query": { "type": "string", "description": "What to look for, e.g. 'download button', 'pricing', a name" },
                "limit": { "type": "number", "description": "Max results (default 20)" },
                "tab_id": { "type": "string", "description": TAB_ID_PROP }
            }, "required": ["query"] } } },
        { "type": "function", "function": {
            "name": "click",
            "description": "Click an element on a page.",
            "parameters": { "type": "object", "properties": {
                "selector": { "type": "string", "description": "CSS selector of the element to click" },
                "tab_id": { "type": "string", "description": TAB_ID_PROP }
            }, "required": ["selector"] } } },
        { "type": "function", "function": {
            "name": "select_option",
            "description": "Choose an option in a native <select> dropdown by option text or value (fires proper change events for React pages). For custom (non-<select>) dropdowns: click the dropdown, read_page/find, then click the option.",
            "parameters": { "type": "object", "properties": {
                "selector": { "type": "string", "description": "CSS selector of the <select>" },
                "value": { "type": "string", "description": "Option text or value to pick" },
                "tab_id": { "type": "string", "description": TAB_ID_PROP }
            }, "required": ["selector", "value"] } } },
        { "type": "function", "function": {
            "name": "fill",
            "description": "Type a value into an input or textarea on a page.",
            "parameters": { "type": "object", "properties": {
                "selector": { "type": "string", "description": "CSS selector of the input" },
                "value": { "type": "string", "description": "Text to enter" },
                "tab_id": { "type": "string", "description": TAB_ID_PROP }
            }, "required": ["selector", "value"] } } },
        { "type": "function", "function": {
            "name": "run_js",
            "description": "Run JavaScript in a page and get its return value. Write a function BODY that ends with a return statement. PREFER THIS over long chains of click/read_page for anything repetitive or bulk: selecting many rows, harvesting links/emails/prices across a list, checking N checkboxes, extracting a table. Example — collect unsubscribe links: return [...document.querySelectorAll('a')].filter(a => /unsubscribe/i.test(a.textContent + a.href)).map(a => a.href).slice(0, 20); Runs synchronously: DOM reads/clicks apply immediately, but fetches or page loads it triggers are NOT awaited — follow with read_page to see the aftermath. Result is JSON-stringified and truncated at 8k chars.",
            "parameters": { "type": "object", "properties": {
                "code": { "type": "string", "description": "JavaScript function body, e.g. 'return document.title'" },
                "tab_id": { "type": "string", "description": TAB_ID_PROP }
            }, "required": ["code"] } } },
        { "type": "function", "function": {
            "name": "navigate",
            "description": "Navigate the active tab to a URL.",
            "parameters": { "type": "object", "properties": {
                "url": { "type": "string", "description": "Full URL including https://" }
            }, "required": ["url"] } } },
        { "type": "function", "function": {
            "name": "scroll",
            "description": "Scroll a page.",
            "parameters": { "type": "object", "properties": {
                "direction": { "type": "string", "enum": ["up", "down", "top", "bottom"] },
                "tab_id": { "type": "string", "description": TAB_ID_PROP }
            }, "required": ["direction"] } } },
        { "type": "function", "function": {
            "name": "search_history",
            "description": "Semantic search over pages the user has previously visited in this browser.",
            "parameters": { "type": "object", "properties": {
                "query": { "type": "string", "description": "What to look for" }
            }, "required": ["query"] } } },
        { "type": "function", "function": {
            "name": "remember",
            "description": "Save a durable fact to persistent memory (user preferences, accounts, recurring tasks, important context). Survives across sessions.",
            "parameters": { "type": "object", "properties": {
                "fact": { "type": "string", "description": "One self-contained fact, e.g. 'User's main email is on Gmail account X'" }
            }, "required": ["fact"] } } },
        { "type": "function", "function": {
            "name": "recall",
            "description": "Search persistent memory for facts saved in past sessions.",
            "parameters": { "type": "object", "properties": {
                "query": { "type": "string", "description": "What to look for" }
            }, "required": ["query"] } } },
        { "type": "function", "function": {
            "name": "get_cookies",
            "description": "Read the browser cookies visible to a URL (defaults to the current page). Returns name, value, domain, path, expiry and flags. The user owns this browser — retrieving their own cookies (login/session tokens included) is expected.",
            "parameters": { "type": "object", "properties": {
                "url": { "type": "string", "description": "Optional URL; omit for the current page" }
            } } } }
    ])
}

/// Every open tab as JSON for the model.
fn list_tabs_json(app: &AppHandle) -> String {
    let state = app.state::<std::sync::Mutex<crate::browser::BrowserState>>();
    let s = state.lock().unwrap();
    let active = s.active_tab_id.clone();
    let tabs: Vec<serde_json::Value> = s
        .tabs
        .values()
        .map(|t| serde_json::json!({
            "id": t.id, "title": t.title, "url": t.url,
            "active": active.as_deref() == Some(t.id.as_str()),
        }))
        .collect();
    serde_json::Value::Array(tabs).to_string()
}

// ── Direct HTTP search + fetch (no webview, no LLM round per page) ───────────

const HTTP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

fn http_client(secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(secs))
        .user_agent(HTTP_UA)
        .build()
        .map_err(|e| e.to_string())
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

/// Script/style blocks out, tags out, entities decoded, whitespace collapsed.
fn strip_tags(html: &str) -> String {
    use std::sync::OnceLock;
    static BLOCKS: OnceLock<regex::Regex> = OnceLock::new();
    static TAGS: OnceLock<regex::Regex> = OnceLock::new();
    static WS: OnceLock<regex::Regex> = OnceLock::new();
    let blocks = BLOCKS.get_or_init(|| {
        regex::Regex::new(r"(?is)<(script|style|noscript|svg|head)\b.*?</\1>").unwrap()
    });
    let tags = TAGS.get_or_init(|| regex::Regex::new(r"(?s)<[^>]*>").unwrap());
    let ws = WS.get_or_init(|| regex::Regex::new(r"[ \t\r\f]*\n[ \t\r\f\n]*").unwrap());
    let no_blocks = blocks.replace_all(html, "\n");
    let no_tags = tags.replace_all(&no_blocks, " ");
    let decoded = decode_entities(&no_tags);
    ws.replace_all(&decoded, "\n")
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn clip_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { s.chars().take(max).collect::<String>() + "…" }
}

/// DDG wraps result hrefs as //duckduckgo.com/l/?uddg=<real-url> — unwrap them.
fn unwrap_ddg_href(href: &str) -> Option<String> {
    let abs = if href.starts_with("//") { format!("https:{href}") } else { href.to_string() };
    let u = url::Url::parse(&abs).ok()?;
    if u.host_str().map_or(false, |h| h.ends_with("duckduckgo.com")) {
        if u.path().contains("y.js") { return None; } // ad redirect
        u.query_pairs().find(|(k, _)| k == "uddg").map(|(_, v)| v.into_owned())
    } else {
        Some(abs)
    }
}

fn parse_ddg(html: &str) -> Vec<serde_json::Value> {
    use std::sync::OnceLock;
    static RESULT_A: OnceLock<regex::Regex> = OnceLock::new();
    static SNIPPET: OnceLock<regex::Regex> = OnceLock::new();
    let re_a = RESULT_A.get_or_init(|| {
        regex::Regex::new(r#"(?s)<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap()
    });
    let re_s = SNIPPET.get_or_init(|| {
        regex::Regex::new(r#"(?s)<a[^>]*class="result__snippet"[^>]*>(.*?)</a>"#).unwrap()
    });

    re_a.captures_iter(html)
        .filter_map(|c| {
            let url = unwrap_ddg_href(&c[1])?;
            // Snippet lives just after its link in the same result block
            let after = c.get(0).map(|m| m.end()).unwrap_or(0);
            let window = &html[after..(after + 2500).min(html.len())];
            let snippet = re_s
                .captures(window)
                .map(|s| clip_chars(&strip_tags(&s[1]), 300))
                .unwrap_or_default();
            Some(serde_json::json!({
                "title": strip_tags(&c[2]), "url": url, "snippet": snippet,
            }))
        })
        .take(8)
        .collect()
}

fn parse_mojeek(html: &str) -> Vec<serde_json::Value> {
    use std::sync::OnceLock;
    static TITLE_A: OnceLock<regex::Regex> = OnceLock::new();
    static SNIP_P: OnceLock<regex::Regex> = OnceLock::new();
    let re_a = TITLE_A.get_or_init(|| {
        regex::Regex::new(r#"(?s)<a[^>]*class="title"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap()
    });
    let re_s = SNIP_P.get_or_init(|| regex::Regex::new(r#"(?s)<p class="s">(.*?)</p>"#).unwrap());

    re_a.captures_iter(html)
        .filter_map(|c| {
            let url = decode_entities(&c[1]);
            if !url.starts_with("http") { return None; }
            let after = c.get(0).map(|m| m.end()).unwrap_or(0);
            let window = &html[after..(after + 2500).min(html.len())];
            let snippet = re_s
                .captures(window)
                .map(|s| clip_chars(&strip_tags(&s[1]), 300))
                .unwrap_or_default();
            Some(serde_json::json!({
                "title": strip_tags(&c[2]), "url": url, "snippet": snippet,
            }))
        })
        .take(8)
        .collect()
}

async fn web_search(query: &str) -> Result<String, String> {
    let client = http_client(10)?;
    let q: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();

    // DDG first; it rate-limits bursts with an anomaly page — Mojeek covers that
    let engines = [
        (format!("https://html.duckduckgo.com/html/?q={q}"), parse_ddg as fn(&str) -> Vec<serde_json::Value>),
        (format!("https://www.mojeek.com/search?q={q}"), parse_mojeek),
    ];
    for (url, parse) in engines {
        let Ok(resp) = client.get(&url).send().await else { continue };
        let Ok(html) = resp.text().await else { continue };
        let results = parse(&html);
        if !results.is_empty() {
            return Ok(serde_json::json!({ "results": results }).to_string());
        }
    }
    Ok("{\"results\":[],\"note\":\"both engines returned nothing parseable — retry once with different wording, or fall back to navigate\"}".into())
}

async fn read_urls(urls: &[String]) -> Result<String, String> {
    use std::sync::OnceLock;
    static TITLE: OnceLock<regex::Regex> = OnceLock::new();
    let re_title = TITLE.get_or_init(|| regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap());

    let client = http_client(12)?;
    let futs = urls.iter().take(5).map(|u| {
        let client = client.clone();
        let u = u.clone();
        async move {
            match client.get(&u).send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let body = resp.text().await.unwrap_or_default();
                    // Bound regex work on pathological pages
                    let body = clip_chars(&body, 600_000);
                    let title = re_title
                        .captures(&body)
                        .map(|c| strip_tags(&c[1]))
                        .unwrap_or_default();
                    serde_json::json!({
                        "url": u, "status": status, "title": title,
                        "text": clip_chars(&strip_tags(&body), 5_000),
                    })
                }
                Err(e) => serde_json::json!({ "url": u, "error": e.to_string() }),
            }
        }
    });
    let pages = futures_util::future::join_all(futs).await;
    Ok(serde_json::Value::Array(pages).to_string())
}

/// Tools with no page/tab side effects — safe to run concurrently when the
/// model emits several calls in one turn.
pub(crate) fn is_parallel_safe(name: &str) -> bool {
    matches!(name, "web_search" | "read_url" | "list_tabs" | "recall" | "search_history")
}

pub(crate) async fn run_tool(app: &AppHandle, name: &str, args: &serde_json::Value) -> String {
    // Page tools take an optional tab_id — None targets the active tab
    let tab = args["tab_id"].as_str().filter(|s| !s.is_empty());
    let result: Result<String, String> = match name {
        "web_search" => web_search(args["query"].as_str().unwrap_or("")).await,
        "read_url" => {
            let urls: Vec<String> = args["urls"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if urls.is_empty() {
                Err("urls array is empty".into())
            } else {
                read_urls(&urls).await
            }
        }
        "list_tabs" => Ok(list_tabs_json(app)),
        "switch_tab" => {
            let id = args["tab_id"].as_str().unwrap_or("").to_string();
            crate::browser::tabs::switch_browser_tab(app.clone(), app.state(), id.clone())
                .await
                .map(|exists| {
                    if exists {
                        format!("{{\"ok\":true,\"switched_to\":{}}}", js_str(&id))
                    } else {
                        "{\"ok\":false,\"error\":\"tab has no live webview (restored tab — ask the user to open it)\"}".into()
                    }
                })
        }
        "read_page" => eval_in(app, tab, read_page_js()).await,
        "get_links" => eval_in(app, tab, GET_LINKS_JS.to_string()).await,
        "find" => {
            let q = args["text"].as_str().unwrap_or("");
            eval_in(app, tab, find_js(q)).await
        }
        "find_text" => {
            let q = args["text"].as_str().unwrap_or("");
            eval_in(app, tab, find_text_js(q)).await
        }
        "search_page" => {
            let q = args["query"].as_str().unwrap_or("");
            let limit = args["limit"].as_u64().unwrap_or(20).min(50);
            // Reef-inspired in-page index, injected into every tab
            let js = format!(
                "JSON.stringify((window.__zroFind && window.__zroFind.query({}, {})) || [])",
                js_str(q), limit
            );
            eval_in(app, tab, js).await
        }
        "click" => {
            let sel = args["selector"].as_str().unwrap_or("");
            let r = eval_in(app, tab, click_js(sel)).await;
            // Click may trigger navigation — give the page a moment, then
            // report where it landed so the model can verify the effect
            tokio::time::sleep(Duration::from_millis(1200)).await;
            match r {
                Ok(res) => {
                    let after = eval_in(app, tab, super::eval::PAGE_AFTER_JS.to_string())
                        .await
                        .unwrap_or_else(|_| "null".into());
                    Ok(format!("{{\"result\":{res},\"page_after_click\":{after}}}"))
                }
                Err(e) => Err(e),
            }
        }
        "select_option" => {
            let sel = args["selector"].as_str().unwrap_or("");
            let val = args["value"].as_str().unwrap_or("");
            let r = eval_in(app, tab, select_option_js(sel, val)).await;
            // Selection usually refetches the table/list — let it settle
            tokio::time::sleep(Duration::from_millis(1000)).await;
            r
        }
        "fill" => {
            let sel = args["selector"].as_str().unwrap_or("");
            let val = args["value"].as_str().unwrap_or("");
            eval_in(app, tab, fill_js(sel, val)).await
        }
        "run_js" => {
            let code = args["code"].as_str().unwrap_or("");
            let r = eval_in(app, tab, run_js_js(code)).await;
            // Script may have clicked/mutated — let the page settle briefly
            tokio::time::sleep(Duration::from_millis(400)).await;
            r
        }
        "navigate" => {
            let url = args["url"].as_str().unwrap_or("");
            match navigate_wv(app, url) {
                Ok(()) => {
                    // Wait for the new page to render before the next tool runs
                    tokio::time::sleep(Duration::from_millis(2500)).await;
                    Ok(format!("{{\"ok\":true,\"navigated_to\":{}}}", js_str(url)))
                }
                Err(e) => Err(e),
            }
        }
        "scroll" => {
            let dir = args["direction"].as_str().unwrap_or("down");
            eval_in(app, tab, scroll_js(dir)).await
        }
        "search_history" => {
            let q = args["query"].as_str().unwrap_or("");
            search_memory(app, q).await
        }
        "remember" => Ok(remember_fact(app, args["fact"].as_str().unwrap_or(""))),
        "recall" => Ok(recall_facts(app, args["query"].as_str().unwrap_or(""))),
        "get_cookies" => {
            let url = args["url"].as_str().filter(|s| !s.is_empty()).map(String::from);
            cookies_for(app, url)
                .await
                .and_then(|c| serde_json::to_string(&c).map_err(|e| e.to_string()))
        }
        _ => Err(format!("unknown tool: {name}")),
    };
    match result {
        Ok(s) => s,
        Err(e) => format!("{{\"ok\":false,\"error\":{}}}", js_str(&e)),
    }
}
