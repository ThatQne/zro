//! Downloads: WebView2's default download UI can't draw over our layout, and
//! Chrome-store CRX fetches die with "download interrupted" (Google blocks
//! non-Chrome UAs, server-side). We take over: route files to the user's
//! Downloads folder, track state, and surface everything in the panel.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, serde::Serialize)]
pub struct DownloadInfo {
    pub id: u64,
    pub url: String,
    pub path: String,
    pub filename: String,
    pub state: String, // active | done | failed
    pub started_at: u64,
    /// Human-readable failure reason (state == "failed" only).
    pub reason: Option<String>,
}

#[derive(Default)]
pub struct Downloads {
    pub items: Mutex<Vec<DownloadInfo>>,
    pub counter: std::sync::atomic::AtomicU64,
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pick a non-colliding path in the user's Downloads folder ("name (2).ext").
fn unique_download_path(dir: &std::path::Path, filename: &str) -> std::path::PathBuf {
    let mut target = dir.join(filename);
    if !target.exists() {
        return target;
    }
    let p = std::path::Path::new(filename);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "download".into());
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for n in 2..1000 {
        target = dir.join(format!("{stem} ({n}){ext}"));
        if !target.exists() {
            return target;
        }
    }
    dir.join(format!("{stem}-{}{ext}", epoch_ms()))
}

/// Chrome-store CRX endpoints refuse non-Chrome user agents server-side —
/// the native WebView2 download always dies as "interrupted".
fn is_crx_url(url: &str) -> bool {
    url.contains("/service/update2/crx")
        || url.split('?').next().unwrap_or("").ends_with(".crx")
}

pub(crate) const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// Web Store extension id (32 chars a–p) when the CRX URL carries one.
pub(crate) fn crx_ext_id(url: &str) -> Option<String> {
    let dec = url.replace("%3D", "=").replace("%3d", "=").replace("%26", "&");
    let mut rest = dec.as_str();
    while let Some(i) = rest.find("id=") {
        let id: String = rest[i + 3..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        if id.len() == 32 && id.chars().all(|c| ('a'..='p').contains(&c)) {
            return Some(id);
        }
        rest = &rest[i + 3..];
    }
    None
}

/// "<extension-id>.crx" when the store URL carries one, else a generic name.
fn crx_filename(url: &str) -> String {
    crx_ext_id(url)
        .map(|id| format!("{id}.crx"))
        .unwrap_or_else(|| "extension.crx".into())
}

/// Re-fetch a CRX with a Chrome UA (Google serves it then) and finish the
/// tracked download item. When the URL carries a Web Store id we rebuild the
/// canonical update URL — store-page URLs can carry a prodversion the
/// endpoint answers with an empty 204 for — and auto-install the extension.
async fn fetch_crx(app: AppHandle, id: u64, url: String, path: std::path::PathBuf) {
    let ext_id = crx_ext_id(&url);
    let fetch_url = match &ext_id {
        Some(eid) => format!(
            "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=126.0.6478.127&acceptformat=crx3&x=id%3D{eid}%26uc"
        ),
        None => url.clone(),
    };
    let mut reason: Option<String> = None;
    let ok = async {
        let client = reqwest::Client::builder()
            .user_agent(CHROME_UA)
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .ok()?;
        let resp = client.get(&fetch_url).send().await.ok()?;
        if !resp.status().is_success() {
            eprintln!("[dl] crx fetch {} -> {}", fetch_url, resp.status());
            reason = Some(format!("download failed (HTTP {})", resp.status()));
            return None;
        }
        let bytes = resp.bytes().await.ok()?;
        if bytes.is_empty() {
            eprintln!("[dl] crx fetch {} -> empty body", fetch_url);
            reason = Some("empty response".into());
            return None;
        }
        // Google answers an unknown/unpublished extension id with a 200 OK
        // HTML error page, not an HTTP error — only real CRX bytes count.
        if ext_id.is_some() && !bytes.starts_with(b"Cr24") {
            eprintln!("[dl] crx fetch {} -> not a CRX (unknown extension id?)", fetch_url);
            reason = Some("not available on the Chrome Web Store".into());
            return None;
        }
        std::fs::write(&path, &bytes).ok()?;
        Some(())
    }
    .await
    .is_some();

    // Page-initiated store download → install it too, that's what the user
    // meant. Best-effort; the .crx stays in Downloads either way.
    if ok && ext_id.is_some() {
        match crate::browser::extensions::install_crx_file(&app, &path).await {
            Ok(info) => eprintln!("[ext] auto-installed {} ({})", info.name, info.id),
            Err(e) => {
                eprintln!("[ext] auto-install failed: {e}");
                reason = Some(e);
            }
        }
    }

    let failed = !ok || reason.is_some();
    let dls = app.state::<Downloads>();
    let info = {
        let mut items = dls.items.lock().unwrap();
        items.iter_mut().find(|i| i.id == id).map(|item| {
            item.state = if failed { "failed" } else { "done" }.into();
            item.reason = reason.clone();
            item.clone()
        })
    };
    if let Some(info) = info {
        let _ = app.emit("download-event", serde_json::json!({ "kind": "finished", "item": info }));
    }
}

pub(crate) fn handle_download(app: &AppHandle, event: tauri::webview::DownloadEvent<'_>) -> bool {
    use tauri::webview::DownloadEvent;
    match event {
        DownloadEvent::Requested { url, destination } => {
            let url_s = url.to_string();
            let crx = is_crx_url(&url_s);
            eprintln!("[dl] requested crx={crx} {url_s}");
            let filename = if crx {
                crx_filename(&url_s)
            } else {
                destination
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "download".to_string())
            };
            if let Ok(dir) = app.path().download_dir() {
                *destination = unique_download_path(&dir, &filename);
            }
            let dls = app.state::<Downloads>();
            let id = dls.counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let info = DownloadInfo {
                id,
                url: url_s.clone(),
                path: destination.to_string_lossy().to_string(),
                filename: destination
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or(filename),
                state: "active".into(),
                started_at: epoch_ms(),
                reason: None,
            };
            dls.items.lock().unwrap().insert(0, info.clone());
            let _ = app.emit("download-event", serde_json::json!({ "kind": "started", "item": info }));

            if crx {
                // Cancel the doomed native download; fetch it ourselves.
                // (async_runtime::spawn — this callback runs on wry's UI
                // thread, outside any tokio context)
                let app2 = app.clone();
                let path = destination.clone();
                tauri::async_runtime::spawn(fetch_crx(app2, id, url_s, path));
                return false;
            }
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            eprintln!("[dl] finished success={success} {url}");
            let dls = app.state::<Downloads>();
            let info = {
                let mut items = dls.items.lock().unwrap();
                let url_s = url.to_string();
                // Match by URL first; a redirected download (link → CDN) reports
                // a different final URL, so fall back to the most-recently
                // started still-active item instead of leaving it stuck "active".
                let pos = items
                    .iter()
                    .position(|i| i.state == "active" && i.url == url_s)
                    .or_else(|| {
                        items
                            .iter()
                            .enumerate()
                            .filter(|(_, i)| i.state == "active")
                            .max_by_key(|(_, i)| i.started_at)
                            .map(|(idx, _)| idx)
                    });
                pos.map(|idx| {
                    let item = &mut items[idx];
                    item.state = if success { "done" } else { "failed" }.into();
                    if let Some(p) = &path {
                        item.path = p.to_string_lossy().to_string();
                    }
                    item.clone()
                })
            };
            if let Some(info) = info {
                let _ = app.emit("download-event", serde_json::json!({ "kind": "finished", "item": info }));
            }
            true
        }
        _ => true,
    }
}

/// Direct CRX fetch for a Web Store extension id — deterministic path that
/// skips the store page's non-Chrome download flow entirely.
#[tauri::command]
pub async fn download_crx(app: AppHandle, ext_id: String) -> Result<(), String> {
    if ext_id.len() != 32 || !ext_id.chars().all(|c| c.is_ascii_lowercase()) {
        return Err("invalid extension id".into());
    }
    let url = format!(
        "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=126.0.6478.127&acceptformat=crx3&x=id%3D{ext_id}%26uc"
    );
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let path = unique_download_path(&dir, &format!("{ext_id}.crx"));

    let dls = app.state::<Downloads>();
    let id = dls.counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let info = DownloadInfo {
        id,
        url: url.clone(),
        path: path.to_string_lossy().to_string(),
        filename: path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{ext_id}.crx")),
        state: "active".into(),
        started_at: epoch_ms(),
        reason: None,
    };
    dls.items.lock().unwrap().insert(0, info.clone());
    let _ = app.emit("download-event", serde_json::json!({ "kind": "started", "item": info }));

    fetch_crx(app.clone(), id, url, path).await;
    Ok(())
}

/// Register an already-written file as a completed download so it shows up in
/// the panel. Used by flows that save directly (e.g. "Save Image As") rather
/// than going through WebView2's download pipeline.
pub fn record_completed(app: &AppHandle, url: String, path: &std::path::Path) {
    let dls = app.state::<Downloads>();
    let id = dls.counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let info = DownloadInfo {
        id,
        url,
        path: path.to_string_lossy().to_string(),
        filename: path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| "download".into()),
        state: "done".into(),
        started_at: epoch_ms(),
        reason: None,
    };
    dls.items.lock().unwrap().insert(0, info.clone());
    let _ = app.emit("download-event", serde_json::json!({ "kind": "started", "item": info }));
}

#[tauri::command]
pub async fn list_downloads(dls: tauri::State<'_, Downloads>) -> Result<Vec<DownloadInfo>, String> {
    Ok(dls.items.lock().unwrap().clone())
}

#[tauri::command]
pub async fn clear_downloads(dls: tauri::State<'_, Downloads>) -> Result<(), String> {
    dls.items.lock().unwrap().retain(|i| i.state == "active");
    Ok(())
}

/// Delete a finished download's FILE from disk and drop its row. Missing
/// file (already deleted in Explorer) still clears the row.
#[tauri::command]
pub async fn delete_download(dls: tauri::State<'_, Downloads>, id: u64) -> Result<(), String> {
    let path = {
        let mut items = dls.items.lock().unwrap();
        let Some(pos) = items.iter().position(|i| i.id == id && i.state != "active") else {
            return Err("download not found or still active".into());
        };
        items.remove(pos).path
    };
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(windows)]
fn spawn_hidden(exe: &str, args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new(exe)
        .args(args)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
#[tauri::command]
pub async fn open_download(path: String) -> Result<(), String> {
    spawn_hidden("cmd", &["/C", "start", "", &path])
}

#[cfg(windows)]
#[tauri::command]
pub async fn reveal_download(path: String) -> Result<(), String> {
    spawn_hidden("explorer", &[&format!("/select,{path}")])
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn open_download(_path: String) -> Result<(), String> { Ok(()) }

#[cfg(not(windows))]
#[tauri::command]
pub async fn reveal_download(_path: String) -> Result<(), String> { Ok(()) }
