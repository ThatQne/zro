//! Chrome-extension support via ICoreWebView2Profile7: install from a Web
//! Store CRX (downloaded with a Chrome UA, unpacked by us), load unpacked
//! folders, list / enable / disable / remove. WebView2 persists installed
//! extensions in the profile; our registry.json only carries what WebView2
//! won't tell us (popup page, icon path, source folder).

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

use super::downloads::CHROME_UA;

/// What the frontend sees per extension.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub version: String,
    /// manifest action/browser_action default_popup (relative path)
    pub popup: Option<String>,
    pub has_icon: bool,
}

/// Registry entry — the manifest-derived bits keyed by WebView2's extension id.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ExtMeta {
    id: String,
    name: String,
    version: String,
    popup: Option<String>,
    icon: Option<String>, // path relative to folder
    folder: String,
}

fn extensions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("extensions");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(extensions_dir(app)?.join("registry.json"))
}

fn load_registry(app: &AppHandle) -> Vec<ExtMeta> {
    registry_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_registry(app: &AppHandle, reg: &[ExtMeta]) {
    if let Ok(p) = registry_path(app) {
        let _ = std::fs::write(p, serde_json::to_string_pretty(reg).unwrap_or_default());
    }
}

fn upsert_registry(app: &AppHandle, meta: ExtMeta) {
    let mut reg = load_registry(app);
    reg.retain(|m| m.id != meta.id);
    reg.push(meta);
    save_registry(app, &reg);
}

// ── CRX3 container ────────────────────────────────────────────────────────────

/// A .crx is a signed header followed by a plain ZIP. CRX3: "Cr24" magic,
/// u32 version, u32 header length, header bytes, then the archive.
fn crx_zip_offset(bytes: &[u8]) -> Result<usize, String> {
    if bytes.len() < 16 || &bytes[0..4] != b"Cr24" {
        return Err("not a CRX file (bad magic)".into());
    }
    let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    match version {
        3 => {
            let header_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
            let off = 12 + header_len;
            if off >= bytes.len() {
                return Err("CRX header longer than file".into());
            }
            Ok(off)
        }
        2 => {
            let key_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
            let sig_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
            let off = 16 + key_len + sig_len;
            if off >= bytes.len() {
                return Err("CRX header longer than file".into());
            }
            Ok(off)
        }
        v => Err(format!("unsupported CRX version {v}")),
    }
}

fn unpack_crx(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let off = crx_zip_offset(bytes)?;
    let cursor = std::io::Cursor::new(&bytes[off..]);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    archive.extract(dest).map_err(|e| e.to_string())
}

// ── Manifest ──────────────────────────────────────────────────────────────────

/// name / version / popup / best icon out of manifest.json (MV2 + MV3).
fn read_manifest(folder: &Path) -> (String, String, Option<String>, Option<String>) {
    let v: serde_json::Value = std::fs::read_to_string(folder.join("manifest.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);

    let mut name = v["name"].as_str().unwrap_or("Extension").to_string();
    // Localized names ("__MSG_appName__") → default_locale messages.json
    if name.starts_with("__MSG_") {
        let key = name.trim_start_matches("__MSG_").trim_end_matches("__").to_string();
        let locale = v["default_locale"].as_str().unwrap_or("en").to_string();
        let resolved = std::fs::read_to_string(folder.join("_locales").join(&locale).join("messages.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|m| {
                // message keys are case-insensitive in Chrome
                m.as_object().and_then(|o| {
                    o.iter()
                        .find(|(k, _)| k.eq_ignore_ascii_case(&key))
                        .and_then(|(_, e)| e["message"].as_str().map(String::from))
                })
            });
        if let Some(n) = resolved {
            name = n;
        }
    }

    let version = v["version"].as_str().unwrap_or("").to_string();
    let popup = v["action"]["default_popup"]
        .as_str()
        .or_else(|| v["browser_action"]["default_popup"].as_str())
        .map(String::from);
    // Largest icon ≤ 128px
    let icon = v["icons"]
        .as_object()
        .and_then(|o| {
            let mut best: Option<(u32, String)> = None;
            for (size, path) in o {
                if let (Ok(s), Some(p)) = (size.parse::<u32>(), path.as_str()) {
                    if s <= 128 && best.as_ref().map(|(bs, _)| s > *bs).unwrap_or(true) {
                        best = Some((s, p.to_string()));
                    }
                }
            }
            best.map(|(_, p)| p)
        });
    (name, version, popup, icon)
}

// ── Profile7 plumbing ─────────────────────────────────────────────────────────

/// Any live webview shares the single profile; the UI window's own webview
/// ("main") always exists.
fn any_webview(app: &AppHandle) -> Result<tauri::Webview, String> {
    app.get_webview("main")
        .or_else(|| super::active_webview(app))
        .ok_or_else(|| "no webview available".into())
}

/// Install (or update) the unpacked extension at `folder`; returns WebView2's
/// extension id + name.
#[cfg(windows)]
async fn add_extension_native(app: &AppHandle, folder: &Path) -> Result<(String, String), String> {
    use webview2_com::ProfileAddBrowserExtensionCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Profile7, ICoreWebView2_13};
    use windows_core::{Interface, HSTRING, PWSTR};

    let wv = any_webview(app)?;
    let folder_hs = HSTRING::from(folder);
    let (tx, rx) = std::sync::mpsc::channel::<Result<(String, String), String>>();

    wv.with_webview(move |pwv| unsafe {
        let send_err = |tx: &std::sync::mpsc::Sender<Result<(String, String), String>>, e: String| {
            let _ = tx.send(Err(e));
        };
        let controller = pwv.controller();
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(e) => return send_err(&tx, e.to_string()),
        };
        let profile = match core
            .cast::<ICoreWebView2_13>()
            .and_then(|c| c.Profile())
            .and_then(|p| p.cast::<ICoreWebView2Profile7>())
        {
            Ok(p) => p,
            Err(e) => return send_err(&tx, format!("extensions unsupported: {e}")),
        };
        let tx2 = tx.clone();
        let handler = ProfileAddBrowserExtensionCompletedHandler::create(Box::new(
            move |err: windows_core::Result<()>, ext| {
                let result = err.map_err(|e| e.to_string()).and_then(|_| {
                    let ext = ext.ok_or("no extension object returned")?;
                    let mut id = PWSTR::null();
                    let mut name = PWSTR::null();
                    ext.Id(&mut id).map_err(|e| e.to_string())?;
                    ext.Name(&mut name).map_err(|e| e.to_string())?;
                    Ok((webview2_com::take_pwstr(id), webview2_com::take_pwstr(name)))
                });
                let _ = tx2.send(result);
                Ok(())
            },
        ));
        if let Err(e) = profile.AddBrowserExtension(&folder_hs, &handler) {
            send_err(&tx, e.to_string());
        }
    })
    .map_err(|e| e.to_string())?;

    tokio::task::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(15))
            .map_err(|_| "AddBrowserExtension timed out".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

/// (id, name, enabled) for every extension WebView2 has installed.
#[cfg(windows)]
async fn list_extensions_native(app: &AppHandle) -> Result<Vec<(String, String, bool)>, String> {
    use webview2_com::ProfileGetBrowserExtensionsCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Profile7, ICoreWebView2_13};
    use windows_core::{Interface, PWSTR};

    let wv = any_webview(app)?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<(String, String, bool)>, String>>();

    wv.with_webview(move |pwv| unsafe {
        let controller = pwv.controller();
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(e) => { let _ = tx.send(Err(e.to_string())); return; }
        };
        let profile = match core
            .cast::<ICoreWebView2_13>()
            .and_then(|c| c.Profile())
            .and_then(|p| p.cast::<ICoreWebView2Profile7>())
        {
            Ok(p) => p,
            Err(e) => { let _ = tx.send(Err(format!("extensions unsupported: {e}"))); return; }
        };
        let tx2 = tx.clone();
        let handler = ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(
            move |err: windows_core::Result<()>, list| {
                let result = err.map_err(|e| e.to_string()).and_then(|_| {
                    let list = list.ok_or("no extension list returned")?;
                    let mut count = 0u32;
                    list.Count(&mut count).map_err(|e| e.to_string())?;
                    let mut out = Vec::with_capacity(count as usize);
                    for i in 0..count {
                        let ext = list.GetValueAtIndex(i).map_err(|e| e.to_string())?;
                        let mut id = PWSTR::null();
                        let mut name = PWSTR::null();
                        let mut enabled = windows_core::BOOL::default();
                        ext.Id(&mut id).map_err(|e| e.to_string())?;
                        ext.Name(&mut name).map_err(|e| e.to_string())?;
                        ext.IsEnabled(&mut enabled).map_err(|e| e.to_string())?;
                        out.push((
                            webview2_com::take_pwstr(id),
                            webview2_com::take_pwstr(name),
                            enabled.as_bool(),
                        ));
                    }
                    Ok(out)
                });
                let _ = tx2.send(result);
                Ok(())
            },
        ));
        if let Err(e) = profile.GetBrowserExtensions(&handler) {
            let _ = tx.send(Err(e.to_string()));
        }
    })
    .map_err(|e| e.to_string())?;

    tokio::task::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "GetBrowserExtensions timed out".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove or enable/disable by id — both walk the native list to find the
/// live extension object first.
#[cfg(windows)]
async fn mutate_extension_native(
    app: &AppHandle,
    ext_id: &str,
    action: ExtAction,
) -> Result<(), String> {
    use webview2_com::{
        BrowserExtensionEnableCompletedHandler, BrowserExtensionRemoveCompletedHandler,
        ProfileGetBrowserExtensionsCompletedHandler,
    };
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Profile7, ICoreWebView2_13};
    use windows_core::{Interface, PWSTR};

    let wv = any_webview(app)?;
    let target = ext_id.to_string();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    wv.with_webview(move |pwv| unsafe {
        let controller = pwv.controller();
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(e) => { let _ = tx.send(Err(e.to_string())); return; }
        };
        let profile = match core
            .cast::<ICoreWebView2_13>()
            .and_then(|c| c.Profile())
            .and_then(|p| p.cast::<ICoreWebView2Profile7>())
        {
            Ok(p) => p,
            Err(e) => { let _ = tx.send(Err(format!("extensions unsupported: {e}"))); return; }
        };
        let tx2 = tx.clone();
        let handler = ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(
            move |err: windows_core::Result<()>, list| {
                if let Err(e) = err {
                    let _ = tx2.send(Err(e.to_string()));
                    return Ok(());
                }
                let Some(list) = list else {
                    let _ = tx2.send(Err("no extension list".into()));
                    return Ok(());
                };
                let mut count = 0u32;
                let _ = list.Count(&mut count);
                for i in 0..count {
                    let Ok(ext) = list.GetValueAtIndex(i) else { continue };
                    let mut id = PWSTR::null();
                    if ext.Id(&mut id).is_err() {
                        continue;
                    }
                    if webview2_com::take_pwstr(id) != target {
                        continue;
                    }
                    let tx3 = tx2.clone();
                    let done = match action {
                        ExtAction::Remove => {
                            let h = BrowserExtensionRemoveCompletedHandler::create(Box::new(
                                move |err: windows_core::Result<()>| {
                                    let _ = tx3.send(err.map_err(|e| e.to_string()));
                                    Ok(())
                                },
                            ));
                            ext.Remove(&h)
                        }
                        ExtAction::SetEnabled(on) => {
                            let h = BrowserExtensionEnableCompletedHandler::create(Box::new(
                                move |err: windows_core::Result<()>| {
                                    let _ = tx3.send(err.map_err(|e| e.to_string()));
                                    Ok(())
                                },
                            ));
                            ext.Enable(on, &h)
                        }
                    };
                    if let Err(e) = done {
                        let _ = tx2.send(Err(e.to_string()));
                    }
                    return Ok(());
                }
                let _ = tx2.send(Err(format!("extension {target} not installed")));
                Ok(())
            },
        ));
        if let Err(e) = profile.GetBrowserExtensions(&handler) {
            let _ = tx.send(Err(e.to_string()));
        }
    })
    .map_err(|e| e.to_string())?;

    tokio::task::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "extension operation timed out".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Copy)]
enum ExtAction {
    Remove,
    SetEnabled(bool),
}

#[cfg(not(windows))]
async fn add_extension_native(_app: &AppHandle, _folder: &Path) -> Result<(String, String), String> {
    Err("extensions are Windows-only".into())
}
#[cfg(not(windows))]
async fn list_extensions_native(_app: &AppHandle) -> Result<Vec<(String, String, bool)>, String> {
    Ok(Vec::new())
}
#[cfg(not(windows))]
async fn mutate_extension_native(_app: &AppHandle, _id: &str, _a: ExtAction) -> Result<(), String> {
    Err("extensions are Windows-only".into())
}

// ── Shared install path ───────────────────────────────────────────────────────

/// Register an unpacked folder with WebView2 + our registry. Returns the info
/// row the frontend renders.
async fn install_folder(app: &AppHandle, folder: &Path) -> Result<ExtensionInfo, String> {
    if !folder.join("manifest.json").is_file() {
        return Err("folder has no manifest.json — not an extension".into());
    }
    let (id, native_name) = add_extension_native(app, folder).await?;
    let (name, version, popup, icon) = read_manifest(folder);
    let display_name = if native_name.trim().is_empty() { name } else { native_name };
    upsert_registry(app, ExtMeta {
        id: id.clone(),
        name: display_name.clone(),
        version: version.clone(),
        popup: popup.clone(),
        icon: icon.clone(),
        folder: folder.to_string_lossy().to_string(),
    });
    let _ = app.emit("extensions-changed", ());
    Ok(ExtensionInfo {
        id,
        name: display_name,
        enabled: true,
        version,
        popup,
        has_icon: icon.is_some(),
    })
}

/// Already-installed check — the store-page auto-install (DownloadsPanel /
/// SettingsPanel effects, fired just from visiting the detail page) usually
/// wins the race before the user's own "Add to Chrome" click reaches us
/// through the download-interception path. Re-adding an id WebView2 already
/// has is at best wasted work and at worst errors, which then shows as a
/// failed download for an extension that's actually already installed.
async fn existing_extension(app: &AppHandle, ext_id: &str) -> Option<ExtensionInfo> {
    let native = list_extensions_native(app).await.ok()?;
    let (id, name, enabled) = native.into_iter().find(|(id, _, _)| id == ext_id)?;
    let reg = load_registry(app);
    let meta = reg.iter().find(|m| m.id == id);
    Some(ExtensionInfo {
        name: meta.map(|m| m.name.clone()).filter(|n| !n.trim().is_empty()).unwrap_or(name),
        version: meta.map(|m| m.version.clone()).unwrap_or_default(),
        popup: meta.and_then(|m| m.popup.clone()),
        has_icon: meta.map(|m| m.icon.is_some()).unwrap_or(false),
        id,
        enabled,
    })
}

fn is_webstore_id(s: &str) -> bool {
    s.len() == 32 && s.chars().all(|c| ('a'..='p').contains(&c))
}

/// Install a downloaded .crx: unpack next to our other extensions, then add.
/// Used by both the panel Install button and the auto-install hook on
/// page-initiated CRX downloads.
pub(crate) async fn install_crx_file(app: &AppHandle, crx_path: &Path) -> Result<ExtensionInfo, String> {
    let stem = crx_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "extension".into());
    if is_webstore_id(&stem) {
        if let Some(info) = existing_extension(app, &stem).await {
            return Ok(info);
        }
    }
    let bytes = std::fs::read(crx_path).map_err(|e| e.to_string())?;
    let dest = extensions_dir(app)?.join(&stem);
    unpack_crx(&bytes, &dest)?;
    install_folder(app, &dest).await
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Download the CRX for a Web Store extension id (Chrome UA — Google's
/// endpoint serves any client with a valid prodversion) and install it.
#[tauri::command]
pub async fn install_crx_extension(app: AppHandle, ext_id: String) -> Result<ExtensionInfo, String> {
    if ext_id.len() != 32 || !ext_id.chars().all(|c| c.is_ascii_lowercase()) {
        return Err("invalid extension id".into());
    }
    if let Some(info) = existing_extension(&app, &ext_id).await {
        return Ok(info);
    }
    let url = format!(
        "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=126.0.6478.127&acceptformat=crx3&x=id%3D{ext_id}%26uc"
    );
    let client = reqwest::Client::builder()
        .user_agent(CHROME_UA)
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("CRX fetch failed: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    // An unknown/unpublished id gets a 200 OK HTML error page, not an HTTP
    // error — give a real reason instead of the raw CRX-parse failure.
    if !bytes.starts_with(b"Cr24") {
        return Err("not available on the Chrome Web Store".into());
    }
    let dest = extensions_dir(&app)?.join(&ext_id);
    unpack_crx(&bytes, &dest)?;
    install_folder(&app, &dest).await
}

/// Native folder picker → install the chosen unpacked extension in place.
#[tauri::command]
pub async fn install_unpacked_extension(app: AppHandle) -> Result<Option<ExtensionInfo>, String> {
    // rfd blocks; keep it off the async runtime
    let picked = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Pick an unpacked extension folder (contains manifest.json)")
            .pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(folder) = picked else { return Ok(None) };
    install_folder(&app, &folder).await.map(Some)
}

#[tauri::command]
pub async fn list_extensions(app: AppHandle) -> Result<Vec<ExtensionInfo>, String> {
    let native = list_extensions_native(&app).await?;
    let reg = load_registry(&app);
    Ok(native
        .into_iter()
        .map(|(id, name, enabled)| {
            let meta = reg.iter().find(|m| m.id == id);
            ExtensionInfo {
                name: meta
                    .map(|m| m.name.clone())
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or(name),
                version: meta.map(|m| m.version.clone()).unwrap_or_default(),
                popup: meta.and_then(|m| m.popup.clone()),
                has_icon: meta.map(|m| m.icon.is_some()).unwrap_or(false),
                id,
                enabled,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn remove_extension(app: AppHandle, ext_id: String) -> Result<(), String> {
    mutate_extension_native(&app, &ext_id, ExtAction::Remove).await?;
    // Drop our unpacked copy only when it lives inside our extensions dir
    // (never delete a user's own load-unpacked source folder)
    let mut reg = load_registry(&app);
    if let Some(meta) = reg.iter().find(|m| m.id == ext_id) {
        if let Ok(dir) = extensions_dir(&app) {
            let folder = PathBuf::from(&meta.folder);
            if folder.starts_with(&dir) && folder.exists() {
                let _ = std::fs::remove_dir_all(&folder);
            }
        }
    }
    reg.retain(|m| m.id != ext_id);
    save_registry(&app, &reg);
    let _ = app.emit("extensions-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn set_extension_enabled(app: AppHandle, ext_id: String, enabled: bool) -> Result<(), String> {
    mutate_extension_native(&app, &ext_id, ExtAction::SetEnabled(enabled)).await?;
    let _ = app.emit("extensions-changed", ());
    Ok(())
}

/// Extension icon as a data URL (the UI webview can't reach
/// chrome-extension:// resources — different webview, different origin).
#[tauri::command]
pub async fn get_extension_icon(app: AppHandle, ext_id: String) -> Result<Option<String>, String> {
    let reg = load_registry(&app);
    let Some(meta) = reg.iter().find(|m| m.id == ext_id) else { return Ok(None) };
    let Some(icon_rel) = &meta.icon else { return Ok(None) };
    let path = Path::new(&meta.folder).join(icon_rel.trim_start_matches('/'));
    let Ok(bytes) = std::fs::read(&path) else { return Ok(None) };
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("svg") => "image/svg+xml",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    };
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(format!("data:{mime};base64,{b64}")))
}

// ── Popup window ──────────────────────────────────────────────────────────────

const POPUP_LABEL: &str = "ext-popup";

/// A real Chrome-style extension popup: a small always-on-top window anchored
/// under the toolbar icon, not a tab. Closes itself the moment it loses
/// focus, same as every other browser's popup.
#[tauri::command]
pub async fn open_extension_popup(
    app: AppHandle,
    ext_id: String,
    popup: String,
    anchor_x: f64,
    anchor_y: f64,
) -> Result<(), String> {
    let url = format!("chrome-extension://{ext_id}/{popup}")
        .parse::<url::Url>()
        .map_err(|e| e.to_string())?;

    // anchor_x/y arrive as logical (CSS) px within the chrome webview's own
    // viewport — the main window is undecorated, so its outer position is
    // effectively the client-area origin they're measured from.
    let main = app.get_window("main").ok_or("no main window")?;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    let main_pos = main.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let x = main_pos.x + anchor_x;
    let y = main_pos.y + anchor_y;
    let (w, h) = (360.0_f64, 480.0_f64);

    // Re-clicking a pin (or a different one) reuses the same window.
    if let Some(existing) = app.get_webview_window(POPUP_LABEL) {
        let _ = existing.navigate(url);
        let _ = existing.set_position(tauri::LogicalPosition::new(x, y));
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    // A button inside the popup that opens a page (window.open, target=_blank,
    // or a plain http(s) navigation) or triggers a download would do NOTHING:
    // wry denies new windows without a handler, and the popup has no download
    // sink. Route both back through the main window like a real browser action.
    let app_open = app.clone();
    let app_nav = app.clone();
    let app_dl = app.clone();
    let win = tauri::WebviewWindowBuilder::new(&app, POPUP_LABEL, WebviewUrl::External(url))
        .title("")
        .inner_size(w, h)
        .position(x, y)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .visible(true)
        .shadow(true)
        .browser_extensions_enabled(true)
        // window.open / target=_blank from the popup → open as a tab in the
        // main window, then let the popup dismiss on its own blur.
        .on_new_window(move |url, _features| {
            let u = url.to_string();
            if u.starts_with("http://") || u.starts_with("https://") {
                let _ = app_open.emit("open-url", serde_json::json!({ "url": u }));
                return tauri::webview::NewWindowResponse::Deny;
            }
            tauri::webview::NewWindowResponse::Allow
        })
        // Same-window http(s) navigation (button sets window.location) → hand
        // it to the main window instead of replacing the popup's own UI.
        // chrome-extension:// stays in-popup (options subpages, routing).
        .on_navigation(move |url| {
            let u = url.to_string();
            if u.starts_with("http://") || u.starts_with("https://") {
                let _ = app_nav.emit("open-url", serde_json::json!({ "url": u }));
                if let Some(p) = app_nav.get_webview_window(POPUP_LABEL) {
                    let _ = p.close();
                }
                return false;
            }
            true
        })
        .on_download(move |_wv, event| super::downloads::handle_download(&app_dl, event))
        // Dark until the popup page paints — the WebView2 default is white,
        // which flashes hard against the dark chrome.
        .background_color(tauri::utils::config::Color(0x0f, 0x0f, 0x0f, 0xff))
        .build()
        .map_err(|e| e.to_string())?;

    // WebView2 startup bounces focus while the popup initializes; an
    // unguarded blur-close fires on that first bounce and the window dies
    // before it paints. Honor blur only once it has actually held focus and
    // survived its first moments.
    let created = std::time::Instant::now();
    let gained = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let closer = win.clone();
    win.on_window_event(move |event| {
        use std::sync::atomic::Ordering;
        match event {
            tauri::WindowEvent::Focused(true) => gained.store(true, Ordering::SeqCst),
            tauri::WindowEvent::Focused(false) => {
                // gained + 400ms = normal path; the 1.5s age fallback covers
                // tao never delivering Focused(true) because the WebView2
                // child owns keyboard focus. (Clicks back into zro are
                // handled by the main window's Focused(true) in lib.rs.)
                let old_enough = created.elapsed() > std::time::Duration::from_millis(400);
                let stale = created.elapsed() > std::time::Duration::from_millis(1500);
                if (gained.load(Ordering::SeqCst) && old_enough) || stale {
                    let _ = closer.close();
                }
            }
            _ => {}
        }
    });

    Ok(())
}
