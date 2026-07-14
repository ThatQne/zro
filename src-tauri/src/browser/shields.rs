//! Native ad/tracker blocking — Brave's own engine, in-process.
//!
//! zro embeds `adblock` (adblock-rust, the exact engine Brave ships) and runs
//! it at WebView2's `WebResourceRequested` chokepoint. Every subresource a page
//! fetches is classified in ~microseconds against EasyList + EasyPrivacy and
//! dropped before it hits the network. Because this lives in the network layer,
//! not an extension, it isn't nerfed by Manifest V3 and it covers every tab and
//! profile — and it's portable to any future platform (it's pure Rust, no
//! extension API needed).
//!
//! Threading note: `adblock::Engine` is `!Send + !Sync`. WebView2's request
//! events all fire on the main (UI) thread, so the engine lives in a
//! main-thread `thread_local` and is only ever touched from there. Filter-list
//! parsing (the heavy part) happens on a worker; only the final index build
//! hops to the main thread.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[cfg(windows)]
use std::cell::RefCell;

// Shields is a SUITE, not just a blocklist — that's the point (uBlock already
// does list-based blocking). The pillars below are what an extension can't do
// from inside the page sandbox: randomize the fingerprint before page JS runs,
// force HTTPS, and strip tracking cruft off URLs at the navigation layer.

/// Master switch (Settings → Privacy). Everything is a no-op while off.
static SHIELDS_ON: AtomicBool = AtomicBool::new(true);
/// Pillar 1 — network ad/tracker blocking (adblock-rust).
static BLOCK_ADS: AtomicBool = AtomicBool::new(true);
/// Pillar 2 — anti-fingerprinting (canvas/WebGL/audio/navigator farbling).
static ANTI_FP: AtomicBool = AtomicBool::new(true);
/// Pillar 3 — upgrade http:// navigations to https://.
static HTTPS_UP: AtomicBool = AtomicBool::new(true);
/// Pillar 4 — strip tracking params (utm_*, fbclid, gclid…) off URLs.
static STRIP_PARAMS: AtomicBool = AtomicBool::new(true);

/// Lifetime count of blocked requests, surfaced in the UI.
static BLOCKED_COUNT: AtomicU64 = AtomicU64::new(0);
/// Lifetime count of tracking params + http upgrades scrubbed off navigations.
static SCRUBBED_COUNT: AtomicU64 = AtomicU64::new(0);
/// Flips true once the filter lists have loaded and the engine is built.
static READY: AtomicBool = AtomicBool::new(false);

pub(crate) fn shields_on() -> bool {
    SHIELDS_ON.load(Ordering::Relaxed)
}
/// Ad/tracker blocking is doing real work — cheap gate the per-request handler
/// checks first so, when Shields is off or still loading, a request pays only
/// one atomic read instead of a resource-context lookup + adblock match.
pub(crate) fn ads_active() -> bool {
    SHIELDS_ON.load(Ordering::Relaxed)
        && BLOCK_ADS.load(Ordering::Relaxed)
        && READY.load(Ordering::Relaxed)
}
/// Anti-fingerprinting is on only when the master switch is too.
pub(crate) fn anti_fp_on() -> bool {
    SHIELDS_ON.load(Ordering::Relaxed) && ANTI_FP.load(Ordering::Relaxed)
}
pub(crate) fn https_up_on() -> bool {
    SHIELDS_ON.load(Ordering::Relaxed) && HTTPS_UP.load(Ordering::Relaxed)
}
pub(crate) fn strip_on() -> bool {
    SHIELDS_ON.load(Ordering::Relaxed) && STRIP_PARAMS.load(Ordering::Relaxed)
}

#[cfg(windows)]
thread_local! {
    static SHIELD_ENGINE: RefCell<Option<adblock::Engine>> = const { RefCell::new(None) };
}

const LIST_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// Anti-fingerprinting content script — injected at document-create, BEFORE any
/// page script runs (that timing is the whole point, and it's why this can't be
/// an extension). It "farbles" the classic passive fingerprint vectors the way
/// Brave does: a per-session seed drives tiny, deterministic-per-session noise
/// so a site gets a stable-but-unique reading it can't correlate across
/// sessions or against other users. Everything is wrapped so a failure can
/// never break a page, and the noise is imperceptible (no visible canvas/audio
/// change), only enough to poison hashing.
pub(crate) const FARBLE_JS: &str = r#"
(function () {
  try {
    var seed;
    try { seed = crypto.getRandomValues(new Uint32Array(1))[0]; }
    catch (e) { seed = (Math.random() * 4294967295) >>> 0; }
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

    // --- Canvas 2D: perturb a sparse set of pixels on readback ---
    function poison(data) {
      for (var i = 0; i < data.length; i += 4) {
        if ((rnd() * 97) < 1) {
          var d = rnd() < 0.5 ? -1 : 1;
          data[i]     = Math.max(0, Math.min(255, data[i] + d));
          data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + d));
          data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + d));
        }
      }
      return data;
    }
    if (window.CanvasRenderingContext2D) {
      var gid = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function () {
        var img = gid.apply(this, arguments);
        try { poison(img.data); } catch (e) {}
        return img;
      };
      if (window.HTMLCanvasElement) {
        var tdu = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function () {
          try {
            var ctx = this.getContext('2d');
            if (ctx && this.width && this.height) {
              var d = gid.call(ctx, 0, 0, this.width, this.height);
              poison(d.data); ctx.putImageData(d, 0, 0);
            }
          } catch (e) {}
          return tdu.apply(this, arguments);
        };
        var tb = HTMLCanvasElement.prototype.toBlob;
        if (tb) {
          HTMLCanvasElement.prototype.toBlob = function () {
            try {
              var ctx = this.getContext('2d');
              if (ctx && this.width && this.height) {
                var d = gid.call(ctx, 0, 0, this.width, this.height);
                poison(d.data); ctx.putImageData(d, 0, 0);
              }
            } catch (e) {}
            return tb.apply(this, arguments);
          };
        }
      }
    }

    // --- WebGL: spoof unmasked vendor/renderer strings ---
    function patchGL(proto) {
      if (!proto) return;
      var gp = proto.getParameter;
      proto.getParameter = function (p) {
        if (p === 37445) return 'Google Inc.';        // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return 'ANGLE (Generic GPU)'; // UNMASKED_RENDERER_WEBGL
        return gp.apply(this, arguments);
      };
    }
    if (window.WebGLRenderingContext) patchGL(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patchGL(WebGL2RenderingContext.prototype);

    // --- AudioContext: sub-audible noise on frequency reads ---
    if (window.AnalyserNode) {
      var gff = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function (arr) {
        gff.apply(this, arguments);
        try { for (var i = 0; i < arr.length; i++) arr[i] += (rnd() * 0.0002 - 0.0001); } catch (e) {}
      };
    }

    // --- Navigator: normalize the high-entropy hardware counters ---
    function defv(obj, prop, val) {
      try { Object.defineProperty(obj, prop, { get: function () { return val; }, configurable: true }); } catch (e) {}
    }
    defv(navigator, 'hardwareConcurrency', 8);
    defv(navigator, 'deviceMemory', 8);
    // Battery API is a pure fingerprint vector and almost never needed
    try { if ('getBattery' in navigator) navigator.getBattery = undefined; } catch (e) {}
  } catch (e) {}
})();
"#;

/// The default block lists — the same core set Brave ships with.
const LISTS: &[(&str, &str)] = &[
    ("easylist.txt", "https://easylist.to/easylist/easylist.txt"),
    ("easyprivacy.txt", "https://easylist.to/easylist/easyprivacy.txt"),
];

#[cfg(windows)]
fn shields_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok()?.join("shields");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// Fetch/refresh the block lists and build the engine on the main thread.
/// Cache-first: a fresh (<3 day) cached copy is used immediately; otherwise the
/// list is fetched and cached. Offline with no cache = shields stay idle (no
/// blocking) rather than failing.
#[cfg(windows)]
pub fn init_shields(app: &tauri::AppHandle) {
    use adblock::lists::{FilterSet, ParseOptions};
    use std::time::Duration;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(dir) = shields_dir(&app) else { return };
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(LIST_UA)
            .build()
            .ok();

        let mut texts: Vec<String> = Vec::new();
        for (name, url) in LISTS {
            let path = dir.join(name);
            let fresh = std::fs::metadata(&path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .map(|age| age < Duration::from_secs(3 * 24 * 3600))
                .unwrap_or(false);

            let text = if fresh {
                std::fs::read_to_string(&path).ok()
            } else if let Some(c) = &client {
                match c.get(*url).send().await {
                    Ok(resp) => match resp.text().await {
                        Ok(body) if body.len() > 1024 => {
                            let _ = std::fs::write(&path, &body);
                            Some(body)
                        }
                        // Bad/short body — fall back to any stale cache
                        _ => std::fs::read_to_string(&path).ok(),
                    },
                    Err(_) => std::fs::read_to_string(&path).ok(),
                }
            } else {
                std::fs::read_to_string(&path).ok()
            };

            if let Some(t) = text {
                texts.push(t);
            }
        }

        if texts.is_empty() {
            return;
        }

        // Engine::new_with_filter_set (rule compilation) takes SECONDS and
        // used to run on the MAIN thread — freezing the chrome, every tab and
        // all input shortly after launch ("everything freezes when a tab
        // loads"). Now the expensive build happens here on the worker:
        // parse → build → serialize to the DAT format, and the main thread
        // only pays a fast deserialize. The DAT is also cached on disk so
        // subsequent launches skip parsing entirely.
        let dat_path = dir.join("engine.dat");
        let lists_newest = LISTS
            .iter()
            .filter_map(|(name, _)| std::fs::metadata(dir.join(name)).ok()?.modified().ok())
            .max();
        let dat_fresh = match (std::fs::metadata(&dat_path).ok().and_then(|m| m.modified().ok()), lists_newest) {
            (Some(dat), Some(lists)) => dat >= lists,
            _ => false,
        };

        let dat: Vec<u8> = if dat_fresh {
            std::fs::read(&dat_path).unwrap_or_default()
        } else {
            Vec::new()
        };
        let dat = if dat.is_empty() {
            // CPU-heavy: keep it off the async pool's shared workers too
            let built = tokio::task::spawn_blocking(move || {
                let mut set = FilterSet::new(false);
                for t in texts {
                    let _ = set.add_filter_list(t, ParseOptions::default());
                }
                adblock::Engine::new_with_filter_set(set).serialize()
            })
            .await
            .unwrap_or_default();
            if !built.is_empty() {
                let _ = std::fs::write(&dat_path, &built);
            }
            built
        } else {
            dat
        };
        if dat.is_empty() {
            return;
        }

        let _ = app.run_on_main_thread(move || {
            let mut engine = adblock::Engine::default();
            if engine.deserialize(&dat).is_ok() {
                SHIELD_ENGINE.with(|cell| *cell.borrow_mut() = Some(engine));
                READY.store(true, Ordering::Relaxed);
                eprintln!("[shields] block engine ready");
            } else {
                eprintln!("[shields] engine DAT deserialize failed");
            }
        });
    });
}

#[cfg(not(windows))]
pub fn init_shields(_app: &tauri::AppHandle) {}

/// Map a WebView2 resource context to an adblock request type. `None` means
/// "never block this kind" — the top document (context DOCUMENT / ALL) must
/// always load, or navigation itself would be cancelled.
pub(crate) fn ctx_to_type(ctx: i32) -> Option<&'static str> {
    // COREWEBVIEW2_WEB_RESOURCE_CONTEXT_* numeric values
    match ctx {
        2 => Some("stylesheet"),
        3 => Some("image"),
        4 => Some("media"),
        5 => Some("font"),
        6 => Some("script"),
        7 | 8 => Some("xmlhttprequest"), // XHR + Fetch
        11 => Some("websocket"),
        14 => Some("ping"),
        15 => Some("csp_report"),
        9 | 10 | 12 | 13 | 16 => Some("other"),
        _ => None, // 0 = ALL, 1 = DOCUMENT → never block the main frame
    }
}

/// Host portion of a URL, allocation-free (`https://a.b/c?d` → `a.b`).
/// Lowercase compare-friendly: callers only use it for equality.
#[cfg_attr(not(windows), allow(dead_code))]
fn host_of(u: &str) -> &str {
    let after = u.split_once("://").map(|(_, r)| r).unwrap_or(u);
    let host = after.split(['/', '?', '#']).next().unwrap_or(after);
    // strip userinfo + port
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
    host.split_once(':').map(|(h, _)| h).unwrap_or(host)
}

/// True if this request should be dropped. Must be called on the main thread
/// (the engine is thread-local there). Increments the blocked counter on a hit.
#[cfg(windows)]
pub(crate) fn should_block(url: &str, source_url: &str, request_type: &str) -> bool {
    if !SHIELDS_ON.load(Ordering::Relaxed)
        || !BLOCK_ADS.load(Ordering::Relaxed)
        || !READY.load(Ordering::Relaxed)
    {
        return false;
    }
    // First-party fast path: same-host requests are the bulk of a page's
    // traffic (self scripts, xhr, fetch) and are almost never on a blocklist.
    // Skipping the engine for them removes most per-request work from the
    // shared UI thread — the thread that also pumps the chrome — so a heavy
    // page load stops freezing the sidebar / URL bar.
    if !source_url.is_empty() && host_of(url) == host_of(source_url) {
        return false;
    }
    let matched = SHIELD_ENGINE.with(|cell| {
        let borrowed = cell.borrow();
        let Some(engine) = borrowed.as_ref() else { return false };
        match adblock::request::Request::new(url, source_url, request_type, "GET") {
            Ok(req) => engine.check_network_request(&req).should_block(),
            Err(_) => false,
        }
    });
    if matched {
        BLOCKED_COUNT.fetch_add(1, Ordering::Relaxed);
    }
    matched
}

#[cfg(not(windows))]
pub(crate) fn should_block(_url: &str, _source_url: &str, _request_type: &str) -> bool {
    false
}

// ── Pillar 3+4: HTTPS upgrade + tracking-param stripping (navigation layer) ───

/// Known tracking params to strip. Anything starting `utm_` is also dropped.
const TRACKING_PARAMS: &[&str] = &[
    "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "yclid",
    "mc_eid", "mc_cid", "igshid", "igsh", "twclid", "ttclid", "rb_clickid",
    "s_cid", "vero_id", "oly_anon_id", "oly_enc_id", "_openstat", "wickedid",
    "icid", "spm", "scm", "cmpid", "campaign_id", "ref_src", "ref_url",
];

fn is_tracking_key(k: &str) -> bool {
    let kl = k.to_ascii_lowercase();
    kl.starts_with("utm_") || TRACKING_PARAMS.contains(&kl.as_str())
}

/// Return an https:// version of an http:// URL, or None if not eligible
/// (localhost, raw IPs, .local/.onion are left alone).
pub(crate) fn upgrade_https(raw: &str) -> Option<String> {
    let mut u = url::Url::parse(raw).ok()?;
    if u.scheme() != "http" {
        return None;
    }
    let host = u.host_str()?;
    if host == "localhost"
        || host.ends_with(".local")
        || host.ends_with(".onion")
        || host.parse::<std::net::IpAddr>().is_ok()
    {
        return None;
    }
    u.set_scheme("https").ok()?;
    Some(u.to_string())
}

/// Return a cleaned URL with tracking params removed, or None if there was
/// nothing to strip.
pub(crate) fn strip_tracking_params(raw: &str) -> Option<String> {
    let mut u = url::Url::parse(raw).ok()?;
    let pairs: Vec<(String, String)> =
        u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    if pairs.is_empty() {
        return None;
    }
    let kept: Vec<&(String, String)> = pairs.iter().filter(|(k, _)| !is_tracking_key(k)).collect();
    if kept.len() == pairs.len() {
        return None; // nothing tracked
    }
    if kept.is_empty() {
        u.set_query(None);
    } else {
        let mut qp = u.query_pairs_mut();
        qp.clear();
        for (k, v) in &kept {
            qp.append_pair(k, v);
        }
    }
    Some(u.to_string())
}

/// Apply HTTPS upgrade then param stripping to a navigation target. Returns a
/// rewritten URL (and bumps the scrubbed counter) or None to let it through.
pub(crate) fn rewrite_navigation(url: &str) -> Option<String> {
    if !SHIELDS_ON.load(Ordering::Relaxed) {
        return None;
    }
    let mut out: Option<String> = None;
    if HTTPS_UP.load(Ordering::Relaxed) {
        if let Some(up) = upgrade_https(url) {
            out = Some(up);
        }
    }
    if STRIP_PARAMS.load(Ordering::Relaxed) {
        let base = out.as_deref().unwrap_or(url);
        if let Some(st) = strip_tracking_params(base) {
            out = Some(st);
        }
    }
    if out.as_deref() == Some(url) {
        return None;
    }
    if out.is_some() {
        SCRUBBED_COUNT.fetch_add(1, Ordering::Relaxed);
    }
    out
}

#[tauri::command]
pub fn set_shield_config(master: bool, ads: bool, fingerprint: bool, https: bool, strip: bool) {
    SHIELDS_ON.store(master, Ordering::Relaxed);
    BLOCK_ADS.store(ads, Ordering::Relaxed);
    ANTI_FP.store(fingerprint, Ordering::Relaxed);
    HTTPS_UP.store(https, Ordering::Relaxed);
    STRIP_PARAMS.store(strip, Ordering::Relaxed);
}

#[tauri::command]
pub fn get_shield_stats() -> serde_json::Value {
    serde_json::json!({
        "enabled": SHIELDS_ON.load(Ordering::Relaxed),
        "ads": BLOCK_ADS.load(Ordering::Relaxed),
        "fingerprint": ANTI_FP.load(Ordering::Relaxed),
        "https": HTTPS_UP.load(Ordering::Relaxed),
        "strip": STRIP_PARAMS.load(Ordering::Relaxed),
        "ready": READY.load(Ordering::Relaxed),
        "blocked": BLOCKED_COUNT.load(Ordering::Relaxed),
        "scrubbed": SCRUBBED_COUNT.load(Ordering::Relaxed),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_of_strips_scheme_path_query_port_userinfo() {
        assert_eq!(host_of("https://a.b/c?d"), "a.b");
        assert_eq!(host_of("http://sub.example.com:8080/x"), "sub.example.com");
        assert_eq!(host_of("https://user:pw@example.com/x"), "example.com");
        assert_eq!(host_of("wss://ws.example.com/socket#frag"), "ws.example.com");
        assert_eq!(host_of("example.com/path"), "example.com");
        assert_eq!(host_of(""), "");
    }

    #[test]
    fn first_party_hosts_match() {
        // The fast path in should_block relies on plain equality of these
        assert_eq!(
            host_of("https://www.youtube.com/api/stats"),
            host_of("https://www.youtube.com/watch?v=x")
        );
        assert_ne!(
            host_of("https://doubleclick.net/pixel"),
            host_of("https://www.youtube.com/watch?v=x")
        );
    }

    #[test]
    fn https_upgrade_rules() {
        assert_eq!(
            upgrade_https("http://example.com/a?b=c"),
            Some("https://example.com/a?b=c".into())
        );
        // Already https / non-http schemes: untouched
        assert_eq!(upgrade_https("https://example.com/"), None);
        assert_eq!(upgrade_https("ftp://example.com/"), None);
        // Local + raw-IP targets are left alone
        assert_eq!(upgrade_https("http://localhost:3000/"), None);
        assert_eq!(upgrade_https("http://192.168.1.10/admin"), None);
        assert_eq!(upgrade_https("http://nas.local/"), None);
        assert_eq!(upgrade_https("http://site.onion/"), None);
    }

    #[test]
    fn strip_tracking_params_rules() {
        // utm_* + known ids stripped, real params kept
        assert_eq!(
            strip_tracking_params("https://e.com/p?utm_source=x&q=rust&fbclid=123"),
            Some("https://e.com/p?q=rust".into())
        );
        // Everything tracked → query removed entirely
        assert_eq!(
            strip_tracking_params("https://e.com/p?gclid=1&utm_campaign=2"),
            Some("https://e.com/p".into())
        );
        // Nothing tracked → None (no rewrite, no re-navigation)
        assert_eq!(strip_tracking_params("https://e.com/p?q=rust&page=2"), None);
        assert_eq!(strip_tracking_params("https://e.com/p"), None);
    }

    #[test]
    fn ctx_never_blocks_main_frame() {
        // 0 = ALL, 1 = DOCUMENT — blocking these would cancel navigation itself
        assert_eq!(ctx_to_type(0), None);
        assert_eq!(ctx_to_type(1), None);
        assert_eq!(ctx_to_type(6), Some("script"));
        assert_eq!(ctx_to_type(7), Some("xmlhttprequest"));
        assert_eq!(ctx_to_type(8), Some("xmlhttprequest"));
        assert_eq!(ctx_to_type(11), Some("websocket"));
        assert_eq!(ctx_to_type(14), Some("ping"));
        assert_eq!(ctx_to_type(999), None);
    }
}
