//! Resolve the logical new-tab address to the bundled document on every path.
//! Complete loading only after the arcade has mounted in the owning WebView.
use std::{
    collections::HashSet,
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const URL: &str = "zro://newtab";
pub(crate) const ASSET: &str = "newtab.html";

pub(crate) fn navigation_url(app: &AppHandle, url: url::Url) -> Result<url::Url, String> {
    if url.as_str() != URL {
        return Ok(url);
    }
    // Match the shell's actual protocol/dev-server origin instead of navigating
    // WebView2 to zro:// (which has no registered protocol handler).
    app.get_webview("main")
        .ok_or("no browser shell")?
        .url()
        .map_err(|e| e.to_string())?
        .join(ASSET)
        .map_err(|e| e.to_string())
}
pub(crate) const INIT: &str = concat!(
    "window.__zroNewTabDocument=/^(tauri\\.localhost|localhost|127\\.0\\.0\\.1)$/.test(location.hostname)&&location.pathname==='/newtab.html';\n",
    include_str!("arcade_core.js"), "\n", include_str!("new_tab.js"), "\n",
    "({url:location.href,ready:window.__zroNewTabDocument===true && window.__zroArcadeReady===true})"
);

pub(crate) fn is_document_url(raw: &str) -> bool {
    url::Url::parse(raw).ok().is_some_and(|u| {
        u.path() == "/newtab.html"
            && matches!(
                u.host_str(),
                Some("tauri.localhost" | "localhost" | "127.0.0.1")
            )
    })
}
static PENDING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn save_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("arcade.json"))
}

fn read_save(app: &AppHandle) -> Option<serde_json::Value> {
    std::fs::read_to_string(save_path(app)?)
        .ok()
        .and_then(|raw| (raw.len() <= 128 * 1024).then_some(raw))
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn send_save(app: &AppHandle, tab_id: &str) {
    let Some(saved) = read_save(app) else {
        return;
    };
    if let Some(wv) = super::tab_webview(app, tab_id) {
        let _ = wv.eval(format!("window.__zroArcadeLoad?.({saved});"));
    }
}

fn updated(value: &serde_json::Value) -> i64 {
    value["updatedAt"].as_i64().unwrap_or(0)
}

/// Merge per-game revisions so two open new tabs cannot replace newer progress
/// with an older copy. Only known, bounded arcade fields reach disk.
fn merge_save(
    current: Option<serde_json::Value>,
    incoming: &serde_json::Value,
) -> Option<serde_json::Value> {
    if incoming["version"] != 2 {
        return None;
    }
    let mut out = current
        .filter(|v| v["version"] == 2)
        .unwrap_or_else(|| serde_json::json!({"version":2,"settings":{},"games":{}}));
    if let Some(blocks) = incoming.pointer("/settings/blocks") {
        if updated(blocks) >= updated(&out["settings"]["blocks"]) {
            out["settings"]["blocks"] = blocks.clone();
        }
    }
    for name in ["blocks", "factory", "merge", "pool"] {
        if let Some(game) = incoming["games"].get(name) {
            if updated(game) >= updated(&out["games"][name]) {
                out["games"][name] = game.clone();
            }
        }
    }
    if serde_json::to_vec(&out).ok()?.len() > 128 * 1024 {
        return None;
    }
    Some(out)
}

pub(crate) fn handle_message(app: &AppHandle, label: &str, value: &serde_json::Value) -> bool {
    let kind = value["type"].as_str().unwrap_or_default();
    if kind != "zro-arcade-save" && kind != "zro-arcade-load" {
        return false;
    }
    let Some(tab_id) = super::tab_of_label(app, label) else {
        return true;
    };
    let is_local = {
        let state = app.state::<Mutex<super::BrowserState>>();
        let local = state
            .lock()
            .unwrap()
            .tabs
            .get(&tab_id)
            .is_some_and(|t| t.url == URL);
        local
    };
    if !is_local {
        return true;
    }
    let Some(path) = save_path(app) else {
        return true;
    };
    if kind == "zro-arcade-load" {
        send_save(app, &tab_id);
    } else if let Some(incoming) = value.get("data") {
        let current = std::fs::read_to_string(&path)
            .ok()
            .filter(|s| s.len() <= 128 * 1024)
            .and_then(|s| serde_json::from_str(&s).ok());
        if let Some(merged) = merge_save(current, incoming) {
            if let Ok(bytes) = serde_json::to_vec(&merged) {
                // Small (<128 KiB), infrequent debounced save. Direct replacement
                // works on Windows even when the destination already exists.
                let _ = std::fs::write(path, bytes);
            }
        }
    }
    true
}

struct Flight(String);
impl Drop for Flight {
    fn drop(&mut self) {
        PENDING.lock().unwrap().remove(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::merge_save;
    use serde_json::json;

    #[test]
    fn arcade_saves_merge_by_game_revision() {
        let old = json!({"version":2,"settings":{"blocks":{"updatedAt":5,"grid":true}},"games":{"factory":{"updatedAt":9,"energy":90},"pool":{"updatedAt":4,"score":2}}});
        let incoming = json!({"version":2,"settings":{"blocks":{"updatedAt":3,"grid":false}},"games":{"factory":{"updatedAt":7,"energy":1},"pool":{"updatedAt":8,"score":5}}});
        let saved = merge_save(Some(old), &incoming).unwrap();
        assert_eq!(saved["settings"]["blocks"]["grid"], true);
        assert_eq!(saved["games"]["factory"]["energy"], 90);
        assert_eq!(saved["games"]["pool"]["score"], 5);
    }

    #[test]
    fn rejects_unknown_version_and_oversized_data() {
        assert!(merge_save(None, &json!({"version":1})).is_none());
        let huge = "x".repeat(140_000);
        assert!(merge_save(
            None,
            &json!({"version":2,"games":{"factory":{"updatedAt":1,"blob":huge}}})
        )
        .is_none());
    }
}

pub(crate) fn ensure_ready(app: &AppHandle, id: &str) {
    // Events can arrive inside add_child, before cold creation has registered
    // the tab. Do not let an early no-op occupy the single-flight slot and
    // swallow the explicit post-registration request.
    let label = {
        let state = app.state::<Mutex<super::BrowserState>>();
        let s = state.lock().unwrap();
        if !s.tabs.get(id).is_some_and(|t| t.url == URL) {
            return;
        }
        let Some(label) = s.labels.get(id) else {
            return;
        };
        label.clone()
    };
    if !PENDING.lock().unwrap().insert(id.to_owned()) {
        return;
    }
    let app = app.clone();
    let id = id.to_owned();
    tauri::async_runtime::spawn(async move {
        let _flight = Flight(id.clone());
        let mut retried_blank = false;
        for _ in 0..12 {
            // Do not paint or complete an abandoned navigation, closed tab, or
            // replacement webview. The JS checks the actual URL independently.
            let expected = {
                let state = app.state::<Mutex<super::BrowserState>>();
                let s = state.lock().unwrap();
                s.tabs.get(&id).is_some_and(|t| t.url == URL) && s.labels.get(&id) == Some(&label)
            };
            if !expected {
                return;
            }
            let result = crate::agent::eval::eval_in(&app, Some(&id), INIT.into()).await;
            let status = result
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
            // Initial blank events may win the construction race, or a parked
            // spare may not have finished its first navigation before adoption.
            if !retried_blank && status.as_ref().is_some_and(|s| s["url"] == "about:blank") {
                retried_blank = true;
                if let (Some(wv), Ok(target)) = (
                    app.get_webview(&label),
                    navigation_url(&app, URL.parse().unwrap()),
                ) {
                    let _ = wv.navigate(target);
                }
            }
            if status.as_ref().is_some_and(|s| {
                s["ready"] == true
                    && s["url"]
                        .as_str()
                        .is_some_and(super::new_tab::is_document_url)
            }) {
                let snapshot = {
                    let state = app.state::<Mutex<super::BrowserState>>();
                    let mut s = state.lock().unwrap();
                    if s.labels.get(&id) != Some(&label)
                        || !s.tabs.get(&id).is_some_and(|t| t.url == URL)
                    {
                        return;
                    }
                    if let Some(t) = s.tabs.get_mut(&id) {
                        t.is_loading = false;
                        t.title = "New Tab".into();
                    }
                    s.nav_started.remove(&id);
                    s.sleep_snapshots.remove(&id)
                };
                if let Some(saved) = snapshot.filter(|s| {
                    s["url"]
                        .as_str()
                        .is_some_and(|url| url == URL || is_document_url(url))
                }) {
                    if let Some(wv) = app.get_webview(&label) {
                        let _ =
                            wv.eval(format!("{}({});", include_str!("sleep_restore.js"), saved));
                    }
                }
                // The initialization script can run before a cold webview has
                // been registered to a tab. Load the durable save only after
                // ownership and local-page readiness are both confirmed.
                send_save(&app, &id);
                let _ = app.emit("page-loaded", serde_json::json!({"id":id,"url":URL}));
                return;
            }
            // A script transport failure takes up to 10s to return. Do not
            // accumulate retries against a dead renderer.
            if status.is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = app.emit("new-tab-error", serde_json::json!({"id":id}));
        eprintln!("[new-tab] local page did not acknowledge readiness for {id}");
    });
}
