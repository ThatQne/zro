//! Web search + page reading, as a retrieval pipeline rather than a scrape.
//!
//! The old path was one DuckDuckGo HTML scrape, snippets straight to the model,
//! and `read_url` returning the first 5k chars of tag-stripped HTML. Five things
//! were wrong with that, and only the first is about which engine we use:
//!
//!  1. one degraded index — DDG's HTML endpoint rate-limits bursts,
//!  2. no dates anywhere, so a 2019 page reads as current,
//!  3. nav/cookie/footer boilerplate ate the character budget before the
//!     article started,
//!  4. no reranking — results arrived in whatever order the engine felt like,
//!  5. one query per question, so a question with two parts got one part's
//!     results.
//!
//! So: fan-out (several sub-queries at once) → several engines with failover →
//! reciprocal-rank fusion → readable-text extraction with a publish date →
//! BM25 passage selection against the question → cached.
//!
//! Everything here is dependency-free beyond what the browser already links,
//! and no API key is required — keys and a self-hosted SearXNG only ever
//! *improve* the result order.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

// ── Config ───────────────────────────────────────────────────────────────────

/// Optional retrieval back ends. Empty = that provider is skipped, which is the
/// default state: the scrapers below need no configuration at all.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SearchConfig {
    /// Base URL of a SearXNG instance, e.g. `http://localhost:8888`. Aggregates
    /// Google/Bing/Brave results, unlimited and keyless — the recommended one.
    pub searxng_url: String,
    /// Google Programmable Search (Custom Search JSON API) key + engine id.
    /// 100 queries/day free; the real Google index.
    pub google_cse_key: String,
    pub google_cse_cx: String,
}

/// Push search settings from the UI. Called before each ask so the config is
/// always current — an init-time-only handshake goes stale the moment the user
/// edits the field.
#[tauri::command]
pub fn set_search_config(
    app: AppHandle,
    searxng_url: Option<String>,
    google_cse_key: Option<String>,
    google_cse_cx: Option<String>,
) -> Result<(), String> {
    let clean = |s: Option<String>| s.unwrap_or_default().trim().trim_end_matches('/').to_string();
    let cfg = SearchConfig {
        searxng_url: clean(searxng_url),
        google_cse_key: clean(google_cse_key),
        google_cse_cx: clean(google_cse_cx),
    };
    if let Some(state) = app.try_state::<Mutex<SearchConfig>>() {
        if let Ok(mut guard) = state.lock() {
            *guard = cfg;
        }
    }
    Ok(())
}

/// Managed state, with an env fallback so a dev run needs no UI round-trip.
pub(crate) fn config(app: &AppHandle) -> SearchConfig {
    let mut cfg = app
        .try_state::<Mutex<SearchConfig>>()
        .and_then(|s| s.lock().ok().map(|g| g.clone()))
        .unwrap_or_default();

    let env = |k: &str| std::env::var(k).unwrap_or_default().trim().trim_end_matches('/').to_string();
    if cfg.searxng_url.is_empty() {
        cfg.searxng_url = env("ZRO_SEARXNG_URL");
    }
    if cfg.google_cse_key.is_empty() {
        cfg.google_cse_key = env("ZRO_GOOGLE_CSE_KEY");
        cfg.google_cse_cx = env("ZRO_GOOGLE_CSE_CX");
    }
    cfg
}

// ── Cache ────────────────────────────────────────────────────────────────────
//
// A process-local TTL map, not Redis: this is one desktop process, and shipping
// a server dependency with a browser to cache 200 strings would be absurd. It
// pays for itself within a single agent run — the model routinely re-searches a
// phrasing it already tried and re-reads a page it read two rounds ago, and
// both now cost nothing instead of a second round trip.

const SEARCH_TTL: Duration = Duration::from_secs(600);
const PAGE_TTL: Duration = Duration::from_secs(1_800);
const CACHE_CAP: usize = 256;

struct Cached {
    at: Instant,
    val: String,
}

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static C: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(key: &str, ttl: Duration) -> Option<String> {
    let map = cache().lock().ok()?;
    let hit = map.get(key)?;
    if hit.at.elapsed() < ttl {
        Some(hit.val.clone())
    } else {
        None
    }
}

fn cache_put(key: String, val: String) {
    let Ok(mut map) = cache().lock() else { return };
    if map.len() >= CACHE_CAP {
        // Evict the oldest quarter. Tracking a true LRU order for a map this
        // small costs more than the occasional re-fetch of a live entry, and
        // everything in here is re-fetchable by definition.
        let mut ages: Vec<(String, Instant)> = map.iter().map(|(k, v)| (k.clone(), v.at)).collect();
        ages.sort_by_key(|(_, at)| *at);
        for (k, _) in ages.into_iter().take(CACHE_CAP / 4) {
            map.remove(&k);
        }
    }
    map.insert(key, Cached { at: Instant::now(), val });
}

// ── HTTP + HTML helpers ──────────────────────────────────────────────────────

const HTTP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

fn http_client(secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(secs))
        .user_agent(HTTP_UA)
        .build()
        .map_err(|e| e.to_string())
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
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

/// Non-content elements, as an alternation per tag.
///
/// The regex crate has no backreferences, so `<(script|style)\b.*?</\1>` is a
/// compile error at runtime, not a clever shortcut — each tag needs its own
/// open/close pair spelled out.
fn junk_blocks() -> &'static regex::Regex {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| {
        let tags = [
            "script", "style", "noscript", "svg", "head", "nav", "header", "footer", "aside",
            "form", "figure", "iframe", "template", "button", "select",
        ];
        let alts: Vec<String> = tags
            .iter()
            .map(|t| format!(r"<{t}\b[^>]*>[\s\S]*?</{t}\s*>"))
            .collect();
        regex::Regex::new(&format!("(?i){}", alts.join("|"))).unwrap()
    })
}

fn tag_re() -> &'static regex::Regex {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"(?s)<[^>]*>").unwrap())
}

/// Tags out, entities decoded, whitespace collapsed.
pub(crate) fn strip_tags(html: &str) -> String {
    static WS: OnceLock<regex::Regex> = OnceLock::new();
    let ws = WS.get_or_init(|| regex::Regex::new(r"[ \t\r\f]*\n[ \t\r\f\n]*").unwrap());
    let no_blocks = junk_blocks().replace_all(html, "\n");
    let no_tags = tag_re().replace_all(&no_blocks, " ");
    let decoded = decode_entities(&no_tags);
    ws.replace_all(&decoded, "\n")
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn clip_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

// ── Readable extraction ──────────────────────────────────────────────────────

/// Prose-bearing elements, in document order.
///
/// Boilerplate lives in `nav`/`header`/`footer`/`aside` (already dropped above)
/// and in short one-line `div`s; real article text lives in `<p>`, list items
/// and headings. Pulling only those is most of what a readability library buys,
/// without a DOM.
fn prose_re() -> &'static regex::Regex {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| {
        let tags = ["p", "li", "h1", "h2", "h3", "h4", "blockquote", "dd", "td", "pre"];
        let alts: Vec<String> = tags
            .iter()
            .map(|t| format!(r"<{t}\b[^>]*>([\s\S]*?)</{t}\s*>"))
            .collect();
        regex::Regex::new(&format!("(?i){}", alts.join("|"))).unwrap()
    })
}

/// Readable body text. Falls back to the whole stripped document when a page
/// carries no prose elements (SPAs that render into bare `div`s), so a weird
/// page degrades to the old behaviour rather than to nothing.
pub(crate) fn extract_text(html: &str) -> String {
    let cleaned = junk_blocks().replace_all(html, "\n");

    let mut out: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for caps in prose_re().captures_iter(&cleaned) {
        // Exactly one alternative matched, so exactly one group is populated.
        let Some(inner) = caps.iter().skip(1).flatten().next() else { continue };
        let text = strip_tags(inner.as_str()).split_whitespace().collect::<Vec<_>>().join(" ");
        if text.chars().count() < 25 {
            continue;
        }
        // Repeated identical blocks are template furniture (card decks,
        // cookie rows), not article text.
        if seen.iter().any(|s| s == &text) {
            continue;
        }
        seen.push(text.clone());
        out.push(text);
    }

    let joined = out.join("\n");
    if joined.chars().count() >= 400 {
        joined
    } else {
        strip_tags(html)
    }
}

fn first_capture(html: &str, pattern: &str) -> Option<String> {
    let re = regex::Regex::new(pattern).ok()?;
    let caps = re.captures(html)?;
    let raw = caps.get(1)?.as_str().trim();
    if raw.is_empty() {
        None
    } else {
        Some(decode_entities(raw))
    }
}

/// Publish date, if the page declares one.
///
/// This is the single highest-value field the old pipeline threw away: without
/// it the model cannot tell a live report from an archived one, and it will
/// quote either with equal confidence.
pub(crate) fn extract_date(html: &str) -> Option<String> {
    const NAMES: &str =
        "article:published_time|datePublished|pubdate|publishdate|publish-date|date|dc.date|dc.date.issued|citation_publication_date|parsely-pub-date|og:published_time";
    let patterns = [
        format!(r#"(?i)<meta[^>]+(?:property|name)\s*=\s*["'](?:{NAMES})["'][^>]*content\s*=\s*["']([^"']+)["']"#),
        format!(r#"(?i)<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["'](?:{NAMES})["']"#),
        r#"(?i)"datePublished"\s*:\s*"([^"]+)""#.to_string(),
        r#"(?i)<time[^>]+datetime\s*=\s*["']([^"']+)["']"#.to_string(),
    ];
    patterns.iter().find_map(|p| first_capture(html, p))
}

pub(crate) fn extract_title(html: &str) -> String {
    first_capture(html, r#"(?i)<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']"#)
        .or_else(|| first_capture(html, r"(?is)<title[^>]*>(.*?)</title>").map(|t| strip_tags(&t)))
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ── BM25 passage selection ───────────────────────────────────────────────────

fn tokenize(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 1)
        .map(String::from)
        .collect()
}

/// Group lines into passages of roughly `target` chars, never splitting a line.
fn chunk(text: &str, target: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        if !cur.is_empty() && cur.chars().count() + line.chars().count() > target {
            out.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(line);
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

/// The passages of `text` that actually answer `query`, in document order.
///
/// Without this, a long page is truncated at an arbitrary character count and
/// the paragraph containing the answer is usually past the cut. Ranking is
/// BM25 over the page's own passages — no model, no network, microseconds.
pub(crate) fn rank_passages(text: &str, query: &str, max_chars: usize) -> String {
    if query.trim().is_empty() || text.chars().count() <= max_chars {
        return clip_chars(text, max_chars);
    }

    let chunks = chunk(text, 700);
    if chunks.len() < 2 {
        return clip_chars(text, max_chars);
    }

    let docs: Vec<Vec<String>> = chunks.iter().map(|c| tokenize(c)).collect();
    let n = docs.len() as f64;
    let avgdl = (docs.iter().map(|d| d.len()).sum::<usize>() as f64 / n).max(1.0);

    let terms: Vec<String> = {
        let mut t = tokenize(query);
        t.sort();
        t.dedup();
        t
    };

    const K1: f64 = 1.2;
    const B: f64 = 0.75;

    let mut scored: Vec<(f64, usize)> = docs
        .iter()
        .enumerate()
        .map(|(i, doc)| {
            let dl = doc.len() as f64;
            let score: f64 = terms
                .iter()
                .map(|term| {
                    let tf = doc.iter().filter(|w| *w == term).count() as f64;
                    if tf == 0.0 {
                        return 0.0;
                    }
                    let df = docs.iter().filter(|d| d.iter().any(|w| w == term)).count() as f64;
                    let idf = (((n - df + 0.5) / (df + 0.5)) + 1.0).ln();
                    idf * (tf * (K1 + 1.0)) / (tf + K1 * (1.0 - B + B * dl / avgdl))
                })
                .sum();
            (score, i)
        })
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    // Take the best passages until the budget is spent. The opening passage
    // always rides along — it carries the byline, dateline and lede that make
    // the rest interpretable.
    let mut picked: Vec<usize> = vec![0];
    let mut used = chunks[0].chars().count();
    for (score, i) in scored {
        if score <= 0.0 || picked.contains(&i) {
            continue;
        }
        let len = chunks[i].chars().count();
        if used + len > max_chars {
            continue;
        }
        used += len;
        picked.push(i);
    }

    // Reading order, not score order — a page read out of order reads as
    // nonsense, and gaps are marked so the model knows text was skipped.
    picked.sort_unstable();
    let mut out = String::new();
    let mut prev: Option<usize> = None;
    for i in picked {
        if let Some(p) = prev {
            out.push_str(if i == p + 1 { "\n" } else { "\n[…]\n" });
        }
        out.push_str(&chunks[i]);
        prev = Some(i);
    }
    out
}

// ── Engines ──────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Hit {
    title: String,
    url: String,
    snippet: String,
    engine: &'static str,
    date: Option<String>,
}

/// DDG wraps result hrefs as //duckduckgo.com/l/?uddg=<real-url> — unwrap them.
fn unwrap_ddg_href(href: &str) -> Option<String> {
    let abs = if href.starts_with("//") { format!("https:{href}") } else { href.to_string() };
    let u = url::Url::parse(&abs).ok()?;
    if u.host_str().map_or(false, |h| h.ends_with("duckduckgo.com")) {
        if u.path().contains("y.js") {
            return None; // ad redirect
        }
        u.query_pairs().find(|(k, _)| k == "uddg").map(|(_, v)| v.into_owned())
    } else {
        Some(abs)
    }
}

fn parse_ddg(html: &str) -> Vec<Hit> {
    static RESULT_A: OnceLock<regex::Regex> = OnceLock::new();
    static SNIPPET: OnceLock<regex::Regex> = OnceLock::new();
    let re_a = RESULT_A.get_or_init(|| {
        regex::Regex::new(r#"(?s)<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap()
    });
    let re_s = SNIPPET
        .get_or_init(|| regex::Regex::new(r#"(?s)<a[^>]*class="result__snippet"[^>]*>(.*?)</a>"#).unwrap());

    re_a.captures_iter(html)
        .filter_map(|c| {
            let url = unwrap_ddg_href(&c[1])?;
            let after = c.get(0).map(|m| m.end()).unwrap_or(0);
            let window = &html[after..(after + 2500).min(html.len())];
            let snippet = re_s
                .captures(window)
                .map(|s| clip_chars(&strip_tags(&s[1]), 300))
                .unwrap_or_default();
            Some(Hit {
                title: strip_tags(&c[2]),
                url,
                snippet,
                engine: "duckduckgo",
                date: None,
            })
        })
        .take(8)
        .collect()
}

fn parse_mojeek(html: &str) -> Vec<Hit> {
    static TITLE_A: OnceLock<regex::Regex> = OnceLock::new();
    static SNIP_P: OnceLock<regex::Regex> = OnceLock::new();
    let re_a = TITLE_A.get_or_init(|| {
        regex::Regex::new(r#"(?s)<a[^>]*class="title"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap()
    });
    let re_s = SNIP_P.get_or_init(|| regex::Regex::new(r#"(?s)<p class="s">(.*?)</p>"#).unwrap());

    re_a.captures_iter(html)
        .filter_map(|c| {
            let url = decode_entities(&c[1]);
            if !url.starts_with("http") {
                return None;
            }
            let after = c.get(0).map(|m| m.end()).unwrap_or(0);
            let window = &html[after..(after + 2500).min(html.len())];
            let snippet = re_s
                .captures(window)
                .map(|s| clip_chars(&strip_tags(&s[1]), 300))
                .unwrap_or_default();
            Some(Hit {
                title: strip_tags(&c[2]),
                url,
                snippet,
                engine: "mojeek",
                date: None,
            })
        })
        .take(8)
        .collect()
}

async fn scrape(client: &reqwest::Client, url: &str, parse: fn(&str) -> Vec<Hit>) -> Vec<Hit> {
    let Ok(resp) = client.get(url).send().await else { return vec![] };
    let Ok(html) = resp.text().await else { return vec![] };
    parse(&html)
}

/// Self-hosted SearXNG: aggregates Google/Bing/Brave/DDG behind one keyless,
/// unlimited endpoint. Needs `formats: [html, json]` in its settings.yml —
/// without that it answers `format=json` with 403 and we fall through.
async fn searxng(client: &reqwest::Client, q: &str, cfg: &SearchConfig) -> Vec<Hit> {
    if cfg.searxng_url.is_empty() {
        return vec![];
    }
    let url = format!("{}/search?q={}&format=json&categories=general%2Cnews", cfg.searxng_url, enc(q));
    let Ok(resp) = client.get(&url).send().await else { return vec![] };
    if !resp.status().is_success() {
        return vec![];
    }
    let Ok(v) = resp.json::<serde_json::Value>().await else { return vec![] };
    v["results"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    let url = r["url"].as_str()?.to_string();
                    Some(Hit {
                        title: r["title"].as_str().unwrap_or("").to_string(),
                        url,
                        snippet: clip_chars(r["content"].as_str().unwrap_or(""), 300),
                        engine: "searxng",
                        date: r["publishedDate"].as_str().map(String::from),
                    })
                })
                .take(8)
                .collect()
        })
        .unwrap_or_default()
}

/// Google Programmable Search — the actual Google index, 100 queries/day free.
async fn google_cse(client: &reqwest::Client, q: &str, cfg: &SearchConfig) -> Vec<Hit> {
    if cfg.google_cse_key.is_empty() || cfg.google_cse_cx.is_empty() {
        return vec![];
    }
    let url = format!(
        "https://www.googleapis.com/customsearch/v1?key={}&cx={}&num=8&q={}",
        enc(&cfg.google_cse_key),
        enc(&cfg.google_cse_cx),
        enc(q)
    );
    let Ok(resp) = client.get(&url).send().await else { return vec![] };
    if !resp.status().is_success() {
        return vec![];
    }
    let Ok(v) = resp.json::<serde_json::Value>().await else { return vec![] };
    v["items"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    let url = r["link"].as_str()?.to_string();
                    let date = r["pagemap"]["metatags"][0]["article:published_time"]
                        .as_str()
                        .or_else(|| r["pagemap"]["metatags"][0]["og:updated_time"].as_str())
                        .map(String::from);
                    Some(Hit {
                        title: r["title"].as_str().unwrap_or("").to_string(),
                        url,
                        snippet: clip_chars(r["snippet"].as_str().unwrap_or(""), 300),
                        engine: "google",
                        date,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One sub-query against the best engine that answers.
///
/// Configured APIs first — they are stable, dated and not rate-limited at our
/// volume. The scrapers are the floor that keeps this working with zero setup.
async fn search_one(client: &reqwest::Client, q: &str, cfg: &SearchConfig) -> Vec<Hit> {
    let hits = searxng(client, q, cfg).await;
    if !hits.is_empty() {
        return hits;
    }
    let hits = google_cse(client, q, cfg).await;
    if !hits.is_empty() {
        return hits;
    }
    let hits = scrape(client, &format!("https://html.duckduckgo.com/html/?q={}", enc(q)), parse_ddg).await;
    if !hits.is_empty() {
        return hits;
    }
    scrape(client, &format!("https://www.mojeek.com/search?q={}", enc(q)), parse_mojeek).await
}

// ── Fusion ───────────────────────────────────────────────────────────────────

/// Same page, different URL spellings — tracking params and `www.` would
/// otherwise let one result occupy three slots.
fn norm_url(raw: &str) -> String {
    let Ok(mut u) = url::Url::parse(raw) else { return raw.trim_end_matches('/').to_lowercase() };
    u.set_fragment(None);
    let keep: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| {
            let k = k.to_lowercase();
            !(k.starts_with("utm_") || matches!(k.as_str(), "fbclid" | "gclid" | "ref" | "ref_src" | "spm"))
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if keep.is_empty() {
        u.set_query(None);
    } else {
        u.query_pairs_mut().clear().extend_pairs(keep);
    }
    let host = u.host_str().unwrap_or("").trim_start_matches("www.").to_lowercase();
    let path = u.path().trim_end_matches('/').to_string();
    let query = u.query().map(|q| format!("?{q}")).unwrap_or_default();
    format!("{host}{path}{query}")
}

/// Reciprocal-rank fusion.
///
/// The right way to merge ranked lists that have no comparable scores: a result
/// near the top of several sub-queries' lists outranks one that was first for a
/// single sub-query. That is exactly the "answers the whole question" signal
/// fan-out exists to produce, and it needs no tuning.
const RRF_K: f64 = 60.0;

fn fuse(lists: &[(String, Vec<Hit>)], limit: usize) -> Vec<serde_json::Value> {
    struct Merged {
        hit: Hit,
        score: f64,
        queries: Vec<String>,
        engines: Vec<String>,
    }
    let mut by_url: HashMap<String, Merged> = HashMap::new();

    for (query, hits) in lists {
        for (rank, hit) in hits.iter().enumerate() {
            let key = norm_url(&hit.url);
            let contrib = 1.0 / (RRF_K + rank as f64 + 1.0);
            let entry = by_url.entry(key).or_insert_with(|| Merged {
                hit: hit.clone(),
                score: 0.0,
                queries: vec![],
                engines: vec![],
            });
            entry.score += contrib;
            if !entry.queries.contains(query) {
                entry.queries.push(query.clone());
            }
            let engine = hit.engine.to_string();
            if !entry.engines.contains(&engine) {
                entry.engines.push(engine);
            }
            // Keep the richest copy of each field across duplicates.
            if hit.snippet.len() > entry.hit.snippet.len() {
                entry.hit.snippet = hit.snippet.clone();
            }
            if entry.hit.date.is_none() {
                entry.hit.date = hit.date.clone();
            }
            if entry.hit.title.len() < hit.title.len() {
                entry.hit.title = hit.title.clone();
            }
        }
    }

    let mut merged: Vec<Merged> = by_url.into_values().collect();
    merged.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    merged
        .into_iter()
        .take(limit)
        .map(|m| {
            let mut obj = serde_json::json!({
                "title": m.hit.title,
                "url": m.hit.url,
                "snippet": m.hit.snippet,
                "engine": m.engines.join("+"),
            });
            if let Some(d) = m.hit.date {
                obj["date"] = serde_json::json!(d);
            }
            // Only interesting when fan-out actually happened.
            if lists.len() > 1 {
                obj["matched_queries"] = serde_json::json!(m.queries.len());
            }
            obj
        })
        .collect()
}

// ── Tool entry points ────────────────────────────────────────────────────────

/// Max sub-queries per call. Past four, added queries return the same pages and
/// the latency is the slowest engine's, not the average.
const MAX_QUERIES: usize = 4;
const MAX_RESULTS: usize = 10;

pub(crate) async fn web_search(app: &AppHandle, queries: &[String]) -> Result<String, String> {
    let cfg = config(app);

    let mut qs: Vec<String> = Vec::new();
    for q in queries {
        let q = q.trim().to_string();
        if !q.is_empty() && !qs.iter().any(|e: &String| e.eq_ignore_ascii_case(&q)) {
            qs.push(q);
        }
        if qs.len() == MAX_QUERIES {
            break;
        }
    }
    if qs.is_empty() {
        return Err("no query given".into());
    }

    let cache_key = {
        let mut sorted = qs.clone();
        sorted.sort();
        format!("s|{}|{}", cfg.searxng_url, sorted.join("\u{1}"))
    };
    if let Some(hit) = cache_get(&cache_key, SEARCH_TTL) {
        return Ok(hit);
    }

    let client = http_client(10)?;
    let futs = qs.iter().cloned().map(|q| {
        let client = client.clone();
        let cfg = cfg.clone();
        async move {
            let hits = search_one(&client, &q, &cfg).await;
            (q, hits)
        }
    });
    let lists: Vec<(String, Vec<Hit>)> = futures_util::future::join_all(futs).await;

    let results = fuse(&lists, MAX_RESULTS);
    if results.is_empty() {
        return Ok(serde_json::json!({
            "results": [],
            "note": "every engine returned nothing parseable — retry once with different wording, or use navigate"
        })
        .to_string());
    }

    let mut out = serde_json::json!({ "queries": qs, "results": results });
    // A configured SearXNG that never appears in the results is nearly always
    // the JSON format being disabled, and silently falling back to a scraper
    // looks like "search is just bad" rather than a one-line config fix.
    if !cfg.searxng_url.is_empty()
        && !lists.iter().any(|(_, h)| h.iter().any(|x| x.engine == "searxng"))
    {
        out["note"] = serde_json::json!(
            "SearXNG is configured but returned nothing — check it is running and that settings.yml has `formats: [html, json]`"
        );
    }

    let json = out.to_string();
    cache_put(cache_key, json.clone());
    Ok(json)
}

/// One fetched page, cached before ranking so a re-read with a different
/// question costs no network.
#[derive(serde::Serialize, serde::Deserialize)]
struct Doc {
    status: u16,
    title: String,
    date: Option<String>,
    text: String,
}

async fn fetch_doc(client: &reqwest::Client, url: &str) -> Result<Doc, String> {
    let cache_key = format!("p|{url}");
    if let Some(hit) = cache_get(&cache_key, PAGE_TTL) {
        if let Ok(doc) = serde_json::from_str::<Doc>(&hit) {
            return Ok(doc);
        }
    }

    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    if !content_type.is_empty() && !content_type.contains("html") && !content_type.contains("text") {
        return Ok(Doc {
            status,
            title: String::new(),
            date: None,
            text: format!("[not readable as text: content-type {content_type}]"),
        });
    }

    let body = resp.text().await.unwrap_or_default();
    // Bound regex work on pathological pages.
    let body = clip_chars(&body, 900_000);

    let doc = Doc {
        status,
        title: extract_title(&body),
        date: extract_date(&body),
        text: extract_text(&body),
    };
    if let Ok(json) = serde_json::to_string(&doc) {
        cache_put(cache_key, json);
    }
    Ok(doc)
}

/// Character budget per page. Generous because the text is now article prose
/// selected against the question, rather than a nav-menu prefix.
const PAGE_CHARS: usize = 4_500;

pub(crate) async fn read_urls(urls: &[String], query: &str) -> Result<String, String> {
    let client = http_client(12)?;
    let futs = urls.iter().take(5).map(|u| {
        let client = client.clone();
        let u = u.clone();
        let query = query.to_string();
        async move {
            match fetch_doc(&client, &u).await {
                Ok(doc) => {
                    let total = doc.text.chars().count();
                    let text = rank_passages(&doc.text, &query, PAGE_CHARS);
                    let mut obj = serde_json::json!({
                        "url": u,
                        "status": doc.status,
                        "title": doc.title,
                        "text": text,
                    });
                    if let Some(d) = doc.date {
                        obj["published"] = serde_json::json!(d);
                    }
                    if total > PAGE_CHARS {
                        obj["note"] = serde_json::json!(format!(
                            "showing the passages most relevant to the query out of {total} chars; [\u{2026}] marks skipped text"
                        ));
                    }
                    obj
                }
                Err(e) => serde_json::json!({ "url": u, "error": e }),
            }
        }
    });
    let pages = futures_util::future::join_all(futs).await;
    Ok(serde_json::Value::Array(pages).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The old strip_tags used `</\1>`, which the regex crate rejects at
    // build time — the .unwrap() panicked on the first call, taking read_url
    // with it. This is the guard against writing that again.
    #[test]
    fn regexes_compile() {
        assert!(junk_blocks().is_match("<script>x</script>"));
        assert!(prose_re().is_match("<p>hello</p>"));
    }

    #[test]
    fn strips_scripts_and_nav() {
        let html = "<nav>Home About</nav><script>var x=1</script><p>Real body text here.</p>";
        let text = strip_tags(html);
        assert!(!text.contains("var x"));
        assert!(!text.contains("Home About"));
        assert!(text.contains("Real body text"));
    }

    #[test]
    fn extracts_prose_over_chrome() {
        let body = "<p>".to_string()
            + &"The council voted to approve the budget on Tuesday evening. ".repeat(10)
            + "</p>";
        let html = format!(
            "<header>Subscribe now</header><div>Menu</div>{body}<footer>Cookie policy</footer>"
        );
        let text = extract_text(&html);
        assert!(text.contains("council voted"));
        assert!(!text.contains("Cookie policy"));
        assert!(!text.contains("Subscribe now"));
    }

    #[test]
    fn falls_back_when_no_prose_elements() {
        let html = "<div>Single line app shell with no paragraph tags at all</div>";
        assert!(extract_text(html).contains("app shell"));
    }

    #[test]
    fn reads_dates_in_either_attribute_order() {
        let a = r#"<meta property="article:published_time" content="2026-03-04T10:00:00Z">"#;
        let b = r#"<meta content="2026-03-05" name="pubdate">"#;
        let c = r#"{"@type":"NewsArticle","datePublished":"2026-03-06T08:00:00Z"}"#;
        assert_eq!(extract_date(a).as_deref(), Some("2026-03-04T10:00:00Z"));
        assert_eq!(extract_date(b).as_deref(), Some("2026-03-05"));
        assert_eq!(extract_date(c).as_deref(), Some("2026-03-06T08:00:00Z"));
        assert_eq!(extract_date("<p>no date here</p>"), None);
    }

    #[test]
    fn ranking_finds_the_buried_paragraph() {
        let filler = (0..40)
            .map(|i| format!("Paragraph {i} about unrelated administrative scheduling matters."))
            .collect::<Vec<_>>()
            .join("\n");
        let needle = "The refund window closes ninety days after purchase.";
        let text = format!("{filler}\n{needle}\n{filler}");

        let ranked = rank_passages(&text, "refund window closes", 900);
        assert!(ranked.contains(needle), "buried answer must survive truncation");
        assert!(ranked.chars().count() < text.chars().count());
    }

    #[test]
    fn ranking_keeps_document_order() {
        let text = (0..30)
            .map(|i| format!("Line {i} refund policy detail number {i}."))
            .collect::<Vec<_>>()
            .join("\n");
        let ranked = rank_passages(&text, "refund policy", 400);
        let first = ranked.find("Line 0").unwrap_or(0);
        let later = ranked.rfind("Line").unwrap_or(0);
        assert!(first <= later);
    }

    #[test]
    fn short_text_is_returned_whole() {
        let text = "One short paragraph.";
        assert_eq!(rank_passages(text, "anything", 500), text);
    }

    #[test]
    fn url_normalisation_collapses_duplicates() {
        let a = norm_url("https://www.example.com/story?utm_source=x&id=7#top");
        let b = norm_url("https://example.com/story?id=7");
        assert_eq!(a, b);
    }

    #[test]
    fn fusion_ranks_consensus_first() {
        let hit = |u: &str| Hit {
            title: u.into(),
            url: u.into(),
            snippet: String::new(),
            engine: "duckduckgo",
            date: None,
        };
        // `both` is second on each list; `only` is first on one. Agreement wins.
        let lists = vec![
            ("q1".to_string(), vec![hit("https://a.com/only"), hit("https://b.com/both")]),
            ("q2".to_string(), vec![hit("https://c.com/other"), hit("https://b.com/both")]),
        ];
        let fused = fuse(&lists, 5);
        assert_eq!(fused[0]["url"], "https://b.com/both");
        assert_eq!(fused[0]["matched_queries"], 2);
    }

    #[test]
    fn ddg_hrefs_unwrap() {
        let wrapped = "//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpage&rut=abc";
        assert_eq!(unwrap_ddg_href(wrapped).as_deref(), Some("https://real.example/page"));
        assert_eq!(unwrap_ddg_href("//duckduckgo.com/y.js?ad=1"), None);
    }
}
