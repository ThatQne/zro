//! "Continue where you left off" for session cookies.
//!
//! Chromium purges session cookies (no expiry) on a clean shutdown — that's
//! why YouTube's theatre mode (the `wide` cookie), some "stay in this view"
//! toggles and a few login sessions reset every restart, while everything
//! with a real expiry survives. Real browsers with session restore put those
//! cookies back; WebView2 exposes no switch for it, so we do it ourselves:
//!
//! - snapshot: enumerate the shared jar, keep only session cookies, encrypt
//!   with DPAPI (same at-rest story as the profile's own cookie DB) and write
//!   to app-data. Runs periodically and once more on window close.
//! - restore: on startup, before any tab webview navigates, write them back
//!   through the main UI webview's CookieManager (same profile → same jar).
//!
//! Incognito shares the profile jar (it's a history-privacy mode here, not a
//! separate profile), so its session cookies ride along — same rule the
//! persistent-cookie store already applies.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(serde::Serialize, serde::Deserialize)]
struct SessionCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    secure: bool,
    http_only: bool,
    same_site: i32,
}

static RESTORED: AtomicBool = AtomicBool::new(false);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// First close request wins; lets lib.rs run one snapshot then destroy.
pub(crate) fn begin_shutdown() -> bool {
    !SHUTTING_DOWN.swap(true, Ordering::SeqCst)
}

/// Tab creation gates on this so pages never load before their session
/// cookies are back (a YouTube tab racing the restore would still open in
/// default mode). Restore normally finishes long before React even mounts —
/// the deadline only guards against a wedged COM call.
pub(crate) async fn wait_restored() {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !RESTORED.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn store_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("session_cookies.bin"))
}

/// Any webview reaches the shared jar — use the always-alive UI webview,
/// never a tab: cookie-manager COM calls auto-RESUME a suspended renderer,
/// so snapshotting through the active tab silently woke frozen tabs every
/// 120s (minimized overnight = renderer resurrected and never re-frozen,
/// because the freeze flags were still set).
fn jar_webview(app: &AppHandle) -> Option<tauri::Webview> {
    app.get_webview("main").or_else(|| super::active_webview(app))
}

// ── DPAPI (encrypt-at-rest, current Windows user) ─────────────────────────────

#[cfg(windows)]
fn dpapi(data: &[u8], encrypt: bool) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut out = CRYPT_INTEGER_BLOB::default();
        let r = if encrypt {
            CryptProtectData(&input, None, None, None, None, 0, &mut out)
        } else {
            CryptUnprotectData(&input, None, None, None, None, 0, &mut out)
        };
        if r.is_err() || out.pbData.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
        Some(bytes)
    }
}

#[cfg(not(windows))]
fn dpapi(_data: &[u8], _encrypt: bool) -> Option<Vec<u8>> {
    None
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

/// Enumerate the jar and persist every session cookie. An empty jar writes an
/// empty snapshot — "clear browsing data" must not resurrect on next launch.
pub(crate) async fn snapshot(app: &AppHandle) {
    let Some(path) = store_path(app) else { return };
    let Some(wv) = jar_webview(app) else { return };

    let (tx, rx) = std::sync::mpsc::channel::<Vec<SessionCookie>>();

    #[cfg(windows)]
    {
        let send_err = tx.clone();
        let ok = wv.with_webview(move |pwv| unsafe {
            use webview2_com::take_pwstr;
            use webview2_com::GetCookiesCompletedHandler;
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2CookieList, ICoreWebView2_2,
            };
            use windows_core::{Interface, BOOL, HSTRING, PWSTR};

            let mgr = pwv
                .controller()
                .CoreWebView2()
                .and_then(|core| core.cast::<ICoreWebView2_2>())
                .and_then(|c2| c2.CookieManager());
            let Ok(mgr) = mgr else {
                let _ = send_err.send(Vec::new());
                return;
            };

            let tx2 = send_err.clone();
            let handler = GetCookiesCompletedHandler::create(Box::new(
                move |err: windows_core::Result<()>, list: Option<ICoreWebView2CookieList>| {
                    let mut out = Vec::new();
                    if let (Ok(()), Some(list)) = (err, list) {
                        let mut count = 0u32;
                        let _ = list.Count(&mut count);
                        for i in 0..count {
                            let Ok(c) = list.GetValueAtIndex(i) else { continue };
                            let mut session = BOOL::default();
                            let _ = c.IsSession(&mut session);
                            if !session.as_bool() {
                                continue; // persistent — Chromium already stores it
                            }
                            let mut p = PWSTR::null();
                            let _ = c.Name(&mut p);
                            let name = take_pwstr(p);
                            let mut p = PWSTR::null();
                            let _ = c.Value(&mut p);
                            let value = take_pwstr(p);
                            let mut p = PWSTR::null();
                            let _ = c.Domain(&mut p);
                            let domain = take_pwstr(p);
                            let mut p = PWSTR::null();
                            let _ = c.Path(&mut p);
                            let path = take_pwstr(p);
                            let mut secure = BOOL::default();
                            let _ = c.IsSecure(&mut secure);
                            let mut http_only = BOOL::default();
                            let _ = c.IsHttpOnly(&mut http_only);
                            let mut same_site =
                                webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_COOKIE_SAME_SITE_KIND::default();
                            let _ = c.SameSite(&mut same_site);
                            out.push(SessionCookie {
                                name,
                                value,
                                domain,
                                path,
                                secure: secure.as_bool(),
                                http_only: http_only.as_bool(),
                                same_site: same_site.0,
                            });
                        }
                    }
                    let _ = tx2.send(out);
                    Ok(())
                },
            ));
            // Empty URI = every cookie in the profile
            if mgr.GetCookies(&HSTRING::new(), &handler).is_err() {
                let _ = send_err.send(Vec::new());
            }
        });
        if ok.is_err() {
            return;
        }
    }

    #[cfg(not(windows))]
    let _ = tx.send(Vec::new());

    let cookies = tokio::task::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default()
    })
    .await
    .unwrap_or_default();

    let Ok(json) = serde_json::to_vec(&cookies) else { return };
    let Some(blob) = dpapi(&json, true) else { return };
    if let Err(e) = std::fs::write(&path, blob) {
        eprintln!("[cookies] snapshot write failed: {e}");
    }
}

// ── Restore ───────────────────────────────────────────────────────────────────

/// Put the previous session's cookies back. Runs once at startup; always
/// flips RESTORED so tab creation never stalls on a missing/corrupt snapshot.
pub(crate) async fn restore(app: &AppHandle) {
    let result = restore_inner(app).await;
    if let Err(e) = result {
        eprintln!("[cookies] restore skipped: {e}");
    }
    RESTORED.store(true, Ordering::SeqCst);
}

async fn restore_inner(app: &AppHandle) -> Result<(), String> {
    let path = store_path(app).ok_or("no app data dir")?;
    let blob = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Ok(()), // first run — nothing to restore
    };
    let json = dpapi(&blob, false).ok_or("decrypt failed (different Windows user?)")?;
    let cookies: Vec<SessionCookie> =
        serde_json::from_str(&String::from_utf8_lossy(&json)).map_err(|e| e.to_string())?;
    if cookies.is_empty() {
        return Ok(());
    }
    let n = cookies.len();

    let wv = jar_webview(app).ok_or("no webview")?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    #[cfg(windows)]
    wv.with_webview(move |pwv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_2, COREWEBVIEW2_COOKIE_SAME_SITE_KIND,
        };
        use windows_core::{Interface, HSTRING};

        let r = (|| -> windows_core::Result<()> {
            let mgr = pwv
                .controller()
                .CoreWebView2()?
                .cast::<ICoreWebView2_2>()?
                .CookieManager()?;
            for c in &cookies {
                let Ok(cookie) = mgr.CreateCookie(
                    &HSTRING::from(c.name.as_str()),
                    &HSTRING::from(c.value.as_str()),
                    &HSTRING::from(c.domain.as_str()),
                    &HSTRING::from(c.path.as_str()),
                ) else {
                    continue;
                };
                let _ = cookie.SetIsSecure(c.secure);
                let _ = cookie.SetIsHttpOnly(c.http_only);
                let _ = cookie.SetSameSite(COREWEBVIEW2_COOKIE_SAME_SITE_KIND(c.same_site));
                // No SetExpires — stays a session cookie, so the jar looks to
                // sites exactly like the browser was never closed.
                let _ = mgr.AddOrUpdateCookie(&cookie);
            }
            Ok(())
        })();
        let _ = tx.send(r.map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;

    #[cfg(not(windows))]
    let _ = tx.send(Ok(()));

    tokio::task::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "restore timed out".to_string())?
    })
    .await
    .map_err(|e| e.to_string())??;

    eprintln!("[cookies] restored {n} session cookies");
    Ok(())
}
