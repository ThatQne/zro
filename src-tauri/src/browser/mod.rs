//! Browser core, split by concern:
//! - [`layout`]    — webview geometry: content rect, rounded-corner regions,
//!                   live-resize tracking, nudges (sidebar / URL-bar dropdown)
//! - [`tabs`]      — per-tab webview lifecycle: create/switch/close/navigate,
//!                   back-forward history, WebView2 shortcut interception
//! - [`perf`]      — page init script (hover prefetch, lazy images)
//! - [`menus`]     — native OS context menus (tab / folder)
//! - [`downloads`] — download routing, tracking, open/reveal
//! - [`system`]    — logging funnel, privacy toggles, suggestions, misc
//!
//! Everything is glob re-exported so command paths stay `browser::<command>`.

pub mod cookies;
pub mod downloads;
pub mod extensions;
pub mod layout;
pub mod menus;
pub mod overlay;
pub mod passwords;
pub mod perf;
pub mod search;
pub mod session_cookies;
pub mod shields;
pub mod system;
pub mod tabs;

pub use cookies::*;
pub use downloads::*;
pub use extensions::*;
pub use layout::*;
pub use menus::*;
pub use overlay::*;
pub use passwords::*;
pub use search::*;
pub use shields::*;
pub use system::*;
pub use tabs::*;

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TabInfo {
    pub id: String,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub is_loading: bool,
}

pub struct BrowserState {
    pub tabs: HashMap<String, TabInfo>,
    pub(crate) histories: HashMap<String, tabs::TabHistory>,
    pub active_tab_id: Option<String>,
    pub layout: layout::Layout,
    /// Target of the currently open native context menu (tab ids or folder id)
    pub menu_ctx: Vec<String>,
    /// Navigation start times — measures real page load latency
    pub(crate) nav_started: HashMap<String, std::time::Instant>,
    /// Live window-resize state (see [`layout::on_live_resize`])
    pub(crate) resizing: bool,
    pub(crate) resize_gen: u64,
    pub(crate) oversized: bool,
    /// DOM overlays currently punched into the UI region (see [`overlay`])
    pub(crate) overlays: Vec<overlay::OverlayRect>,
    /// Element fullscreen (video) active
    pub(crate) fullscreen: bool,
    /// tab id → webview label. Identity for cold-created tabs; differs after a
    /// warm-spare adoption. Every tab-webview lookup goes through this.
    pub(crate) labels: HashMap<String, String>,
    /// webview label → owning tab id. Event handlers resolve at emit time —
    /// an unadopted spare has no owner, so its events are suppressed.
    pub(crate) label_owner: HashMap<String, String>,
    /// Pre-built idle webview awaiting adoption (instant new tab).
    /// Default-profile only — other profiles use a different data directory.
    pub(crate) spare: Option<String>,
    /// URL the spare was pre-navigated to (matching adoption skips the nav)
    pub(crate) spare_url: Option<String>,
    pub(crate) spare_seq: u64,
    /// Webview labels whose renderer is frozen (TrySuspend succeeded).
    /// Cleared on resume/close/hibernate — the Usage panel reads this.
    pub(crate) suspended: std::collections::HashSet<String>,
    /// The ACTIVE page webview is hidden (long-idle freeze). The window is
    /// transparent, so the content hole would show the DESKTOP through —
    /// update_ui_region skips punching the hole while this is set and the
    /// dark chrome covers the whole window instead.
    pub(crate) page_hidden: bool,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            tabs: HashMap::new(),
            histories: HashMap::new(),
            active_tab_id: None,
            layout: layout::Layout::default(),
            menu_ctx: Vec::new(),
            nav_started: HashMap::new(),
            resizing: false,
            resize_gen: 0,
            oversized: false,
            overlays: Vec::new(),
            fullscreen: false,
            labels: HashMap::new(),
            label_owner: HashMap::new(),
            spare: None,
            spare_url: None,
            spare_seq: 0,
            suspended: std::collections::HashSet::new(),
            page_hidden: false,
        }
    }
}

/// The webview of a tab, through the label indirection — after a warm-spare
/// adoption a tab's webview label is NOT its tab id. Never call
/// `app.get_webview(tab_id)` directly for tab webviews.
pub fn tab_webview(app: &AppHandle, tab_id: &str) -> Option<tauri::Webview> {
    let state = app.state::<Mutex<BrowserState>>();
    let label = state.lock().unwrap().labels.get(tab_id).cloned();
    app.get_webview(label.as_deref().unwrap_or(tab_id))
}

/// Webview label of a tab (identity unless the tab adopted a warm spare).
pub(crate) fn tab_label(app: &AppHandle, tab_id: &str) -> String {
    let state = app.state::<Mutex<BrowserState>>();
    let s = state.lock().unwrap();
    s.labels.get(tab_id).cloned().unwrap_or_else(|| tab_id.to_string())
}

/// Tab id owning a webview label (None = unadopted spare → suppress events).
pub(crate) fn tab_of_label(app: &AppHandle, label: &str) -> Option<String> {
    let state = app.state::<Mutex<BrowserState>>();
    let s = state.lock().unwrap();
    s.label_owner.get(label).cloned()
}

/// The webview of the currently active tab, if any.
pub fn active_webview(app: &AppHandle) -> Option<tauri::Webview> {
    let state = app.state::<Mutex<BrowserState>>();
    let id = state.lock().unwrap().active_tab_id.clone()?;
    tab_webview(app, &id)
}
