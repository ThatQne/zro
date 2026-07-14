//! Cookie access via the WebView2 CookieManager. One profile is shared by
//! every tab, so any tab's manager sees the full jar. Powers the Settings
//! cookie editor and the AI agent's get_cookies tool.

use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use super::{active_webview, BrowserState};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieInfo {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    /// epoch seconds; 0 for session cookies
    pub expires: f64,
    pub secure: bool,
    pub http_only: bool,
    pub session: bool,
}

fn target_uri(app: &AppHandle, url: Option<String>) -> Result<String, String> {
    match url {
        Some(u) if !u.trim().is_empty() => Ok(u),
        _ => {
            let state = app.state::<Mutex<BrowserState>>();
            let s = state.lock().unwrap();
            s.active_tab_id
                .as_ref()
                .and_then(|id| s.tabs.get(id))
                .map(|t| t.url.clone())
                .filter(|u| !u.is_empty())
                .ok_or_else(|| "no active page".into())
        }
    }
}

/// All cookies visible to `url` (defaults to the active tab's page).
pub(crate) async fn cookies_for(app: &AppHandle, url: Option<String>) -> Result<Vec<CookieInfo>, String> {
    let uri = target_uri(app, url)?;
    let wv = active_webview(app).ok_or("no active tab")?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<CookieInfo>, String>>();

    #[cfg(windows)]
    wv.with_webview(move |pwv| unsafe {
        use webview2_com::take_pwstr;
        use webview2_com::GetCookiesCompletedHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2CookieList, ICoreWebView2_2};
        use windows_core::{Interface, BOOL, HSTRING, PWSTR};

        let controller = pwv.controller();
        let mgr = controller
            .CoreWebView2()
            .and_then(|core| core.cast::<ICoreWebView2_2>())
            .and_then(|c2| c2.CookieManager());
        let mgr = match mgr {
            Ok(m) => m,
            Err(e) => {
                let _ = tx.send(Err(e.to_string()));
                return;
            }
        };

        let tx2 = tx.clone();
        let handler = GetCookiesCompletedHandler::create(Box::new(
            move |err: windows_core::Result<()>, list: Option<ICoreWebView2CookieList>| {
                let mut out = Vec::new();
                if let (Ok(()), Some(list)) = (err, list) {
                    let mut count = 0u32;
                    let _ = list.Count(&mut count);
                    for i in 0..count {
                        let Ok(c) = list.GetValueAtIndex(i) else { continue };
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
                        let mut expires = 0f64;
                        let _ = c.Expires(&mut expires);
                        let mut secure = BOOL::default();
                        let _ = c.IsSecure(&mut secure);
                        let mut http_only = BOOL::default();
                        let _ = c.IsHttpOnly(&mut http_only);
                        let mut session = BOOL::default();
                        let _ = c.IsSession(&mut session);
                        out.push(CookieInfo {
                            name,
                            value,
                            domain,
                            path,
                            expires,
                            secure: secure.as_bool(),
                            http_only: http_only.as_bool(),
                            session: session.as_bool(),
                        });
                    }
                }
                let _ = tx2.send(Ok(out));
                Ok(())
            },
        ));
        if let Err(e) = mgr.GetCookies(&HSTRING::from(uri.as_str()), &handler) {
            let _ = tx.send(Err(e.to_string()));
        }
    })
    .map_err(|e| e.to_string())?;

    #[cfg(not(windows))]
    let _ = tx.send(Err("cookies only supported on Windows".into()));

    tokio::task::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "cookie query timed out".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_cookies(app: AppHandle, url: Option<String>) -> Result<Vec<CookieInfo>, String> {
    cookies_for(&app, url).await
}

#[tauri::command]
pub async fn set_cookie(
    app: AppHandle,
    name: String,
    value: String,
    domain: String,
    path: Option<String>,
    secure: Option<bool>,
    http_only: Option<bool>,
    expires_days: Option<f64>,
) -> Result<(), String> {
    let wv = active_webview(&app).ok_or("no active tab")?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let path = path.unwrap_or_else(|| "/".into());

    #[cfg(windows)]
    wv.with_webview(move |pwv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
        use windows_core::{Interface, HSTRING};

        let r = (|| -> windows_core::Result<()> {
            let controller = pwv.controller();
            let mgr = controller
                .CoreWebView2()?
                .cast::<ICoreWebView2_2>()?
                .CookieManager()?;
            let cookie = mgr.CreateCookie(
                &HSTRING::from(name.as_str()),
                &HSTRING::from(value.as_str()),
                &HSTRING::from(domain.as_str()),
                &HSTRING::from(path.as_str()),
            )?;
            if let Some(sec) = secure {
                let _ = cookie.SetIsSecure(sec);
            }
            if let Some(ho) = http_only {
                let _ = cookie.SetIsHttpOnly(ho);
            }
            if let Some(days) = expires_days {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs_f64())
                    .unwrap_or(0.0);
                let _ = cookie.SetExpires(now + days * 86_400.0);
            }
            mgr.AddOrUpdateCookie(&cookie)?;
            Ok(())
        })();
        let _ = tx.send(r.map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;

    #[cfg(not(windows))]
    let _ = tx.send(Err("cookies only supported on Windows".into()));

    tokio::task::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "cookie write timed out".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_cookie(
    app: AppHandle,
    name: String,
    domain: String,
    path: Option<String>,
) -> Result<(), String> {
    delete_cookie_inner(&app, name, domain, path.unwrap_or_else(|| "/".into())).await
}

/// Shared by the delete_cookie command and clear_site_data's per-site sweep.
pub(crate) async fn delete_cookie_inner(
    app: &AppHandle,
    name: String,
    domain: String,
    path: String,
) -> Result<(), String> {
    let wv = active_webview(app).ok_or("no active tab")?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    #[cfg(windows)]
    wv.with_webview(move |pwv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
        use windows_core::{Interface, HSTRING};

        let r = (|| -> windows_core::Result<()> {
            let controller = pwv.controller();
            let mgr = controller
                .CoreWebView2()?
                .cast::<ICoreWebView2_2>()?
                .CookieManager()?;
            mgr.DeleteCookiesWithDomainAndPath(
                &HSTRING::from(name.as_str()),
                &HSTRING::from(domain.as_str()),
                &HSTRING::from(path.as_str()),
            )?;
            Ok(())
        })();
        let _ = tx.send(r.map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;

    #[cfg(not(windows))]
    let _ = tx.send(Err("cookies only supported on Windows".into()));

    tokio::task::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "cookie delete timed out".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Wipe the entire shared cookie jar (clear_site_data, scope = all sites).
pub(crate) async fn delete_all_cookies(app: &AppHandle) -> Result<(), String> {
    let wv = active_webview(app).ok_or("no active tab")?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    #[cfg(windows)]
    wv.with_webview(move |pwv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
        use windows_core::Interface;

        let r = (|| -> windows_core::Result<()> {
            pwv.controller()
                .CoreWebView2()?
                .cast::<ICoreWebView2_2>()?
                .CookieManager()?
                .DeleteAllCookies()?;
            Ok(())
        })();
        let _ = tx.send(r.map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;

    #[cfg(not(windows))]
    let _ = tx.send(Err("cookies only supported on Windows".into()));

    tokio::task::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "cookie clear timed out".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}
