//! Per-tab webview lifecycle: creation (with popup/download/zoom wiring),
//! switching (park + hide), closing, navigation and back/forward history.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

use super::downloads::handle_download;
use super::layout::{compute_rect, parked_rect, sync_bounds};
use super::perf::PERF_INIT_SCRIPT;
use super::{active_webview, BrowserState, TabInfo};

/// Launch an external-protocol URI (roblox-player:, steam:, mailto:, …) via
/// the OS shell, from zro's own process. The shell resolves and starts the
/// handler outside any WebView2/zro process job, so the launched app is NOT
/// killed when zro exits — unlike WebView2's built-in launch.
#[cfg(windows)]
fn shell_open_detached(uri: &str) {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = HSTRING::from(uri);
    unsafe {
        let _ = ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
    }
}

/// Per-tab URL trail backing our own back/forward when the renderer's session
/// history is gone (e.g. lazily restored tabs).
pub(crate) struct TabHistory {
    urls: Vec<String>,
    current: usize,
    skip_next: bool,
}

impl TabHistory {
    fn new(url: String) -> Self {
        Self { urls: vec![url], current: 0, skip_next: false }
    }
    fn push(&mut self, url: String) {
        if self.skip_next { self.skip_next = false; return; }
        if self.urls.last().map(|u| u == &url).unwrap_or(false) { return; }
        self.urls.truncate(self.current + 1);
        self.urls.push(url);
        self.current = self.urls.len() - 1;
    }
    fn back(&mut self) -> Option<String> {
        if self.current == 0 { return None; }
        self.current -= 1;
        self.skip_next = true;
        Some(self.urls[self.current].clone())
    }
    fn forward(&mut self) -> Option<String> {
        if self.current + 1 >= self.urls.len() { return None; }
        self.current += 1;
        self.skip_next = true;
        Some(self.urls[self.current].clone())
    }
}

/// Navigate the active tab's webview (used by the AI agent).
pub(crate) fn navigate_wv(app: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = url.parse::<url::Url>().map_err(|e| e.to_string())?;
    match active_webview(app) {
        Some(wv) => wv.navigate(parsed).map_err(|e: tauri::Error| e.to_string()),
        None => Err("no active tab".into()),
    }
}

// ── Renderer freeze (RAM tier between "live" and "hibernated") ────────────────

/// Freeze a hidden webview's renderer via WebView2 TrySuspend — the same
/// mechanism as Chromium's tab freezing. DOM, scroll, form state and session
/// history all survive; scripts/timers stop and the renderer's memory becomes
/// reclaimable by the OS. Pages playing audio are skipped. Failure is normal
/// (webview still visible, navigation in flight, DevTools open) — the sweep
/// simply retries later.
#[cfg(windows)]
pub(crate) fn suspend_webview(app: &AppHandle, label: &str, wv: &tauri::Webview) {
    suspend_webview_hiding(app, label, wv, false);
}

/// The freeze primitive. `hide_first` = also make the webview invisible, but
/// only AFTER the audio check passes — the whole-app freeze paths (minimize,
/// machine-idle watchdog) used to `wv.hide()` unconditionally BEFORE the
/// audio check ever ran, which blanked the ACTIVE tab mid-video: watching a
/// video is exactly "no mouse, no keyboard", so 3 idle minutes in, the
/// watchdog hid the visible webview and the window turned see-through.
#[cfg(windows)]
pub(crate) fn suspend_webview_hiding(app: &AppHandle, label: &str, wv: &tauri::Webview, hide_first: bool) {
    suspend_webview_covering(app, label, wv, hide_first, false);
}

/// `cover_hole` = this is the VISIBLE (active) webview being hidden while the
/// window may still be on screen — mark `page_hidden` and re-solidify the UI
/// region so the transparent window never shows the desktop through the hole.
/// Only set once the audio check passes (a playing page is never hidden).
#[cfg(windows)]
pub(crate) fn suspend_webview_covering(
    app: &AppHandle,
    label: &str,
    wv: &tauri::Webview,
    hide_first: bool,
    cover_hole: bool,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, ICoreWebView2_3, ICoreWebView2_8,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    };
    use webview2_com::TrySuspendCompletedHandler;
    use windows_core::Interface;

    let app = app.clone();
    let label = label.to_string();
    let _ = wv.with_webview(move |pwv| unsafe {
        let controller = pwv.controller();
        let Ok(core) = controller.CoreWebView2() else { return };
        if let Ok(wv8) = core.cast::<ICoreWebView2_8>() {
            let mut playing = windows_core::BOOL::default();
            let _ = wv8.IsDocumentPlayingAudio(&mut playing);
            if playing.as_bool() {
                return; // playing media stays visible AND unfrozen
            }
        }
        if hide_first {
            let _ = controller.SetIsVisible(false); // TrySuspend needs invisible
            if cover_hole {
                {
                    let state = app.state::<Mutex<BrowserState>>();
                    state.lock().unwrap().page_hidden = true;
                }
                crate::browser::overlay::update_ui_region(&app);
            }
        }
        // Also ask Chromium to shed caches for this background webview
        if let Ok(wv19) = core.cast::<ICoreWebView2_19>() {
            let _ = wv19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
        }
        let Ok(wv3) = core.cast::<ICoreWebView2_3>() else { return };
        let mut already = windows_core::BOOL::default();
        if wv3.IsSuspended(&mut already).is_ok() && already.as_bool() {
            return;
        }
        let handler = TrySuspendCompletedHandler::create(Box::new(
            move |err: windows_core::Result<()>, ok: bool| {
                if err.is_ok() && ok {
                    let state = app.state::<Mutex<BrowserState>>();
                    state.lock().unwrap().suspended.insert(label.clone());
                }
                Ok(())
            },
        ));
        let _ = wv3.TrySuspend(&handler);
    });
}

/// Undo a freeze before a webview must work again. Showing a suspended
/// webview auto-resumes it, but navigation / history calls against a frozen
/// renderer can fail — so every activation path calls this first.
#[cfg(windows)]
pub(crate) fn resume_webview(app: &AppHandle, label: &str, wv: &tauri::Webview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    {
        let state = app.state::<Mutex<BrowserState>>();
        let mut s = state.lock().unwrap();
        s.suspended.remove(label);
        // Every activation path resumes first — any pending "active page
        // hidden" cover must lift so the content hole reopens.
        s.page_hidden = false;
    }
    let _ = wv.with_webview(|pwv| unsafe {
        let Ok(core) = pwv.controller().CoreWebView2() else { return };
        if let Ok(wv3) = core.cast::<ICoreWebView2_3>() {
            let mut sus = windows_core::BOOL::default();
            if wv3.IsSuspended(&mut sus).is_ok() && sus.as_bool() {
                let _ = wv3.Resume();
            }
        }
        if let Ok(wv19) = core.cast::<ICoreWebView2_19>() {
            let _ = wv19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL);
        }
    });
}

/// Lighter than a freeze: tell Chromium this webview should shed caches NOW.
/// Used the moment a tab is parked — the freeze sweep only reaches it after
/// a minute of idling, this claws back memory immediately.
/// Audio-exempt: dropping a PLAYING tab's caches (music in a background tab
/// is the normal case) flushes its media buffers → audible stutter on every
/// tab switch.
#[cfg(windows)]
pub(crate) fn shed_memory(wv: &tauri::Webview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, ICoreWebView2_8, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    };
    use windows_core::Interface;
    let _ = wv.with_webview(|pwv| unsafe {
        if let Ok(core) = pwv.controller().CoreWebView2() {
            if let Ok(wv8) = core.cast::<ICoreWebView2_8>() {
                let mut playing = windows_core::BOOL::default();
                let _ = wv8.IsDocumentPlayingAudio(&mut playing);
                if playing.as_bool() {
                    return;
                }
            }
            if let Ok(wv19) = core.cast::<ICoreWebView2_19>() {
                let _ = wv19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
            }
        }
    });
}

#[cfg(not(windows))]
pub(crate) fn suspend_webview(_app: &AppHandle, _label: &str, _wv: &tauri::Webview) {}
#[cfg(not(windows))]
pub(crate) fn suspend_webview_hiding(_app: &AppHandle, _label: &str, _wv: &tauri::Webview, _hide: bool) {}
#[cfg(not(windows))]
pub(crate) fn resume_webview(_app: &AppHandle, _label: &str, _wv: &tauri::Webview) {}
#[cfg(not(windows))]
pub(crate) fn shed_memory(_wv: &tauri::Webview) {}

// ── Whole-app freeze on minimize ─────────────────────────────────────────────
// Minimized = the user is elsewhere. Freeze EVERY page renderer (active tab
// included, audio-playing pages excluded by suspend_webview) so a minimized
// zro costs close to nothing. Restore thaws the active tab.

static MINIMIZED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn on_minimized(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    if MINIMIZED.swap(true, Ordering::SeqCst) {
        return; // already handled
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Grace period: a quick minimize/restore shouldn't churn renderers
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        if !MINIMIZED.load(Ordering::SeqCst) {
            return;
        }
        for (label, wv) in app.webviews() {
            if label == "main" || label.starts_with("ext") {
                continue;
            }
            // Hide happens INSIDE, after the audio check — media keeps playing
            suspend_webview_hiding(&app, &label, &wv, true);
        }
    });
}

pub(crate) fn on_restored(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    if !MINIMIZED.swap(false, Ordering::SeqCst) {
        return; // plain resize, not a restore
    }
    thaw_active_tab(app);
}

/// Focus = the user is definitively here. Clears ANY stuck freeze state
/// (minimize flag that never saw its restore event, idle-watchdog freeze
/// waiting on its next poll tick) and brings the active tab back instantly.
/// This is the self-heal for "came back and the window was see-through".
pub(crate) fn on_user_active(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    // Only REAL input counts. Hiding the focused page webview (idle freeze)
    // re-activates the main window — a synthetic Focused(true) with no user
    // behind it. Thawing on that re-showed the page, the watchdog re-froze it
    // 3 seconds later, and the window flashed in a loop until the user came
    // back. A genuine return always has fresh input (the click/keystroke that
    // focused the window), so gate on input recency instead of the event.
    #[cfg(windows)]
    if system_idle_ms() > 5_000 {
        return;
    }
    let was_min = MINIMIZED.swap(false, Ordering::SeqCst);
    #[cfg(windows)]
    let was_idle = IDLE_FROZEN.swap(false, Ordering::SeqCst)
        | IDLE_ACTIVE_FROZEN.swap(false, Ordering::SeqCst);
    #[cfg(not(windows))]
    let was_idle = false;
    if was_min || was_idle {
        thaw_active_tab(app);
    }
}

/// Resume + show the active tab's renderer and put it back at its layout rect.
/// Shared by minimize-restore and the idle watchdog — both freeze the active
/// tab and need to bring exactly it back when the user returns.
pub(crate) fn thaw_active_tab(app: &AppHandle) {
    let state = app.state::<Mutex<BrowserState>>();
    let (id, layout) = {
        let mut s = state.lock().unwrap();
        s.page_hidden = false; // re-open the content hole
        (s.active_tab_id.clone(), s.layout)
    };
    let Some(id) = id else { return };
    let Some(wv) = crate::browser::tab_webview(app, &id) else { return };
    resume_webview(app, &crate::browser::tab_label(app, &id), &wv);
    if let Some(main) = app.get_window("main") {
        if let Ok(rect) = compute_rect(&main, layout) {
            let _ = wv.set_bounds(rect);
        }
    }
    let _ = wv.show();
    super::overlay::update_ui_region(app);
}

// ── Idle watchdog: machine left unattended → freeze EVERY renderer ────────────
// The all-night fan problem. Minimize freezes the app, but a page left open and
// focused (or just behind another window) keeps its renderer running rAF /
// video / timers forever. This watches the OS-wide last-input time and, once
// the whole machine has been idle past the threshold, freezes every page —
// the active tab included (audio-playing pages are still skipped inside
// suspend_webview). The first keypress/mouse move thaws the active tab.

#[cfg(windows)]
static IDLE_FROZEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The ACTIVE tab froze too (long-idle stage). Separate flag so the visible
/// page only ever blanks after a genuinely long absence, never mid-reading.
#[cfg(windows)]
static IDLE_ACTIVE_FROZEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Idle threshold in ms; frontend Performance setting can retune it. 0 = off.
#[cfg(windows)]
static IDLE_FREEZE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(180_000);
/// The visible tab is what the user is (maybe) READING — sitting still for a
/// few minutes is normal use, and freezing it blanks the page until the next
/// watchdog tick ("pages keep freezing and unresponsive"). It only freezes
/// after a long absence; background pages still freeze at the user's setting,
/// which is where the overnight-fans CPU actually lived.
#[cfg(windows)]
const ACTIVE_FREEZE_FLOOR_MS: u64 = 900_000; // 15 min

/// True while the machine-idle freeze is engaged — the cookie snapshotter and
/// any other periodic work skips its beat, since nothing is changing.
pub(crate) fn is_idle_frozen() -> bool {
    #[cfg(windows)]
    {
        IDLE_FROZEN.load(std::sync::atomic::Ordering::SeqCst)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
pub fn set_idle_freeze_min(minutes: u64) {
    #[cfg(windows)]
    {
        let ms = minutes.saturating_mul(60_000);
        IDLE_FREEZE_MS.store(ms, std::sync::atomic::Ordering::SeqCst);
    }
    #[cfg(not(windows))]
    let _ = minutes;
}

#[cfg(windows)]
fn system_idle_ms() -> u64 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    unsafe {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut lii).as_bool() {
            GetTickCount().wrapping_sub(lii.dwTime) as u64
        } else {
            0
        }
    }
}

/// Freeze background page renderers (stage 1 — the active tab stays live).
/// Audio pages are skipped inside suspend_webview. Runs on the main thread —
/// WebView2 calls require it.
#[cfg(windows)]
fn freeze_background_pages(app: &AppHandle) {
    let active_label = {
        let state = app.state::<Mutex<BrowserState>>();
        let id = state.lock().unwrap().active_tab_id.clone();
        id.map(|id| crate::browser::tab_label(app, &id))
    };
    for (label, wv) in app.webviews() {
        if label == "main" || label.starts_with("ext") {
            continue;
        }
        if active_label.as_deref() == Some(label.as_str()) {
            continue;
        }
        // Audio check runs BEFORE any hide — a page playing a video/music
        // stays visible and live (this is what used to blank videos mid-watch)
        suspend_webview_hiding(app, &label, &wv, true);
    }
}

/// Stage 2 (long absence): freeze the ACTIVE tab too. Same audio exemption —
/// an unattended video keeps playing.
#[cfg(windows)]
fn freeze_active_page(app: &AppHandle) {
    let state = app.state::<Mutex<BrowserState>>();
    let Some(id) = state.lock().unwrap().active_tab_id.clone() else { return };
    let Some(wv) = crate::browser::tab_webview(app, &id) else { return };
    let label = crate::browser::tab_label(app, &id);
    // cover_hole: the window may still be on screen — solidify the region so
    // the hidden page never reads as a transparent window
    suspend_webview_covering(app, &label, &wv, true, true);
}

/// Is zro the window the user is actually in front of? Raw Win32 (thread-safe,
/// unlike tao's window methods) — GetForegroundWindow catches "behind another
/// app" and IsIconic catches "minimized", the two cases where zro's tabs should
/// cost nothing. When a page webview (child HWND) holds focus the foreground is
/// still the main top-level window, so this stays correct.
#[cfg(windows)]
fn zro_in_front(app: &AppHandle) -> Option<(bool, bool)> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsIconic};
    let hwnd = app.get_window("main").and_then(|w| w.hwnd().ok())?;
    unsafe {
        let minimized = IsIconic(hwnd).as_bool();
        let in_front = GetForegroundWindow() == hwnd;
        Some((in_front, minimized))
    }
}

#[cfg(windows)]
pub(crate) fn idle_watch(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut away_since: Option<std::time::Instant> = None;
        loop {
            let any_frozen = IDLE_FROZEN.load(Ordering::SeqCst) || IDLE_ACTIVE_FROZEN.load(Ordering::SeqCst);
            // Poll fast while frozen (first input thaws in ~3s); a lean 6s
            // otherwise — checking foreground + last-input is nearly free.
            let nap = if any_frozen { 3 } else { 6 };
            tokio::time::sleep(std::time::Duration::from_secs(nap)).await;

            let bg_frozen = IDLE_FROZEN.load(Ordering::SeqCst);
            let act_frozen = IDLE_ACTIVE_FROZEN.load(Ordering::SeqCst);
            let (in_front, minimized) = zro_in_front(&app).unwrap_or((true, false));

            // ── zro is NOT the active window (minimized or behind another app)
            // The real "fans rise while minimized" cause: background tabs kept
            // running because the machine wasn't idle (user busy elsewhere).
            // Freeze background pages immediately; freeze the visible tab too
            // once it's clearly abandoned (minimized now, or unfocused a while).
            if !in_front {
                if away_since.is_none() { away_since = Some(std::time::Instant::now()); }
                if !bg_frozen {
                    IDLE_FROZEN.store(true, Ordering::SeqCst);
                    let a = app.clone();
                    let _ = app.run_on_main_thread(move || freeze_background_pages(&a));
                }
                // Freeze the VISIBLE tab only when it truly can't be seen or
                // the user left the machine: minimized, or no input anywhere
                // for the long floor. Merely unfocused is NOT enough — reading
                // zro side-by-side while typing in another app is normal use,
                // and hiding the page then made the window turn see-through.
                let away = away_since.map(|t| t.elapsed().as_secs()).unwrap_or(0);
                let user_gone = system_idle_ms() >= ACTIVE_FREEZE_FLOOR_MS;
                if (minimized || (away >= 60 && user_gone)) && !act_frozen {
                    IDLE_ACTIVE_FROZEN.store(true, Ordering::SeqCst);
                    let a = app.clone();
                    let _ = app.run_on_main_thread(move || freeze_active_page(&a));
                }
                continue;
            }

            // ── zro is in front → the user is here.
            away_since = None;
            let threshold = IDLE_FREEZE_MS.load(Ordering::SeqCst);
            let idle = if threshold == 0 { 0 } else { system_idle_ms() };

            // Thaw if we were frozen (from blur or idle) and the user is active.
            if threshold == 0 || idle < threshold {
                if bg_frozen || act_frozen {
                    IDLE_FROZEN.store(false, Ordering::SeqCst);
                    IDLE_ACTIVE_FROZEN.store(false, Ordering::SeqCst);
                    let a = app.clone();
                    let _ = app.run_on_main_thread(move || thaw_active_tab(&a));
                }
                continue;
            }

            // Whole machine idle past the threshold (user away, zro still front)
            if !bg_frozen {
                IDLE_FROZEN.store(true, Ordering::SeqCst);
                let a = app.clone();
                let _ = app.run_on_main_thread(move || freeze_background_pages(&a));
            }
            if idle >= threshold.max(ACTIVE_FREEZE_FLOOR_MS) && !act_frozen {
                IDLE_ACTIVE_FROZEN.store(true, Ordering::SeqCst);
                let a = app.clone();
                let _ = app.run_on_main_thread(move || freeze_active_page(&a));
            }
        }
    });
}

#[cfg(not(windows))]
pub(crate) fn idle_watch(_app: &AppHandle) {}

/// Frontend sweep target: freeze one background tab's renderer (state kept,
/// RAM released). The active tab never freezes.
#[tauri::command]
pub async fn suspend_tab(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
    id: String,
) -> Result<(), String> {
    let label = {
        let s = state.lock().unwrap();
        if s.active_tab_id.as_deref() == Some(&id) {
            return Err("won't freeze the active tab".into());
        }
        s.labels.get(&id).cloned().unwrap_or_else(|| id.clone())
    };
    let wv = app.get_webview(&label).ok_or("no webview")?;
    suspend_webview(&app, &label, &wv);
    Ok(())
}

// ── WebView2 configuration (autofill, shortcut interception) ─────────────────

/// Windows-only per-webview setup: enable password autosave + autofill,
/// track SPA navigations (SourceChanged — YouTube & co. never fire page_load
/// when moving between videos), live titles, element fullscreen, and
/// intercept browser shortcuts while the PAGE has focus.
///
/// `id` is the webview LABEL — every emit resolves it to the owning tab id at
/// event time (warm spares change owners after creation; unadopted spares
/// resolve to None and stay silent).
#[cfg(windows)]
fn configure_webview(app: &AppHandle, wv: &tauri::Webview, id: &str) {
    use webview2_com::take_pwstr;
    use webview2_com::{
        AcceleratorKeyPressedEventHandler, ContainsFullScreenElementChangedEventHandler,
        DocumentTitleChangedEventHandler, IsDocumentPlayingAudioChangedEventHandler,
        IsMutedChangedEventHandler, SourceChangedEventHandler,
    };
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile6, ICoreWebView2_13, ICoreWebView2_18, ICoreWebView2_8,
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    };
    use windows_core::{Interface, BOOL, PWSTR};

    let app = app.clone();
    let id = id.to_string();
    let _ = wv.with_webview(move |pwv| unsafe {
        let controller = pwv.controller();
        if let Ok(core) = controller.CoreWebView2() {
            // Custom right-click menu: suppress WebView2's built-in context menu,
            // capture what was clicked (link / image / selection), and pop our
            // own native menu — the same OS-popup style as the sidebar menus.
            {
                use webview2_com::ContextMenuRequestedEventHandler;
                use webview2_com::Microsoft::Web::WebView2::Win32::{
                    ICoreWebView2_11, COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE,
                    COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_PAGE,
                };
                if let Ok(wv11) = core.cast::<ICoreWebView2_11>() {
                    let app_cm = app.clone();
                    let mut tok_cm = std::mem::zeroed();
                    let handler = ContextMenuRequestedEventHandler::create(Box::new(
                        move |_sender, args| {
                            let Some(args) = args else { return Ok(()) };
                            let mut ctx = crate::browser::PageMenuCtx::default();
                            let Ok(target) = args.ContextMenuTarget() else { return Ok(()) };
                            let mut b = BOOL::default();
                            if target.IsEditable(&mut b).is_ok() { ctx.is_editable = b.as_bool(); }
                            // Editable fields keep WebView2's own menu — it has
                            // cut/copy/paste/undo we don't reimplement here.
                            if ctx.is_editable {
                                return Ok(());
                            }
                            // Everything else → our custom menu; block the built-in.
                            let _ = args.SetHandled(true);
                            let mut kind = COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_PAGE;
                            let _ = target.Kind(&mut kind);
                            ctx.is_image = kind == COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE;
                            if target.HasLinkUri(&mut b).is_ok() && b.as_bool() {
                                let mut p = PWSTR::null();
                                if target.LinkUri(&mut p).is_ok() { ctx.link = take_pwstr(p); }
                            }
                            if target.HasSourceUri(&mut b).is_ok() && b.as_bool() {
                                let mut p = PWSTR::null();
                                if target.SourceUri(&mut p).is_ok() { ctx.src = take_pwstr(p); }
                            }
                            let mut ps = PWSTR::null();
                            if target.SelectionText(&mut ps).is_ok() { ctx.selection = take_pwstr(ps); }
                            let mut pu = PWSTR::null();
                            if target.PageUri(&mut pu).is_ok() { ctx.page_url = take_pwstr(pu); }
                            {
                                let state = app_cm.state::<Mutex<BrowserState>>();
                                state.lock().unwrap().page_menu_ctx = ctx;
                            }
                            // Pop the menu on the next main-loop turn — never
                            // inside this callback (popup_menu runs a modal loop).
                            let a = app_cm.clone();
                            let _ = app_cm.run_on_main_thread(move || {
                                crate::browser::menus::show_page_menu_now(&a);
                            });
                            Ok(())
                        },
                    ));
                    let _ = wv11.add_ContextMenuRequested(&handler, &mut tok_cm);
                }
            }

            // Download progress: Tauri's DownloadEvent only reports start/finish,
            // so real %/speed needs WebView2 directly. On DownloadStarting we grab
            // the DownloadOperation and subscribe to BytesReceivedChanged; that
            // callback's `sender` IS the operation, so we read bytes + uri off it
            // and emit a "progress" event the panel matches to its row by url.
            {
                use webview2_com::{BytesReceivedChangedEventHandler, DownloadStartingEventHandler};
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_4;
                if let Ok(wv4) = core.cast::<ICoreWebView2_4>() {
                    let app_dl = app.clone();
                    let mut tok_dl = std::mem::zeroed();
                    let handler = DownloadStartingEventHandler::create(Box::new(
                        move |_sender, args| {
                            let Some(args) = args else { return Ok(()) };
                            let Ok(op) = args.DownloadOperation() else { return Ok(()) };
                            let app_p = app_dl.clone();
                            let mut tok_b = std::mem::zeroed();
                            let prog = BytesReceivedChangedEventHandler::create(Box::new(
                                move |sender, _| {
                                    let Some(op) = sender else { return Ok(()) };
                                    let mut received: i64 = 0;
                                    let _ = op.BytesReceived(&mut received);
                                    let mut total: i64 = 0;
                                    let _ = op.TotalBytesToReceive(&mut total);
                                    let mut pu = PWSTR::null();
                                    let uri = if op.Uri(&mut pu).is_ok() { take_pwstr(pu) } else { String::new() };
                                    let _ = app_p.emit(
                                        "download-event",
                                        serde_json::json!({
                                            "kind": "progress",
                                            "uri": uri,
                                            "received": received,
                                            "total": total,
                                        }),
                                    );
                                    Ok(())
                                },
                            ));
                            let _ = op.add_BytesReceivedChanged(&prog, &mut tok_b);
                            // The op holds the only ref while it downloads; keep the
                            // handler alive for that lifetime (a few bytes per file).
                            std::mem::forget(prog);
                            Ok(())
                        },
                    ));
                    let _ = wv4.add_DownloadStarting(&handler, &mut tok_dl);
                }
            }

            // Top-frame URL cache — the Shields request handler needs the page
            // origin (first-party check) on EVERY request. Calling Source() (a
            // COM round trip) per request was pure overhead on request-heavy
            // sites; instead SourceChanged writes the current URL here once per
            // navigation and the request handler just reads it.
            let top_url = std::sync::Arc::new(std::sync::Mutex::new(String::new()));

            // One request handler does two jobs. A single "*" filter routes
            // every request through it (many small filters would each fire the
            // same handler anyway), and the handler URL-gates each job:
            //   1. Chrome Web Store CRX endpoints — rewrite the UA (Google
            //      rejects non-Chrome UAs, breaking extension installs). Never
            //      global: global UA games break Google sign-in.
            //   2. Everything else — run it through Shields (adblock-rust) and
            //      drop known ads/trackers before they hit the network. The top
            //      document is never blocked (ctx_to_type returns None for it).
            {
                use webview2_com::WebResourceRequestedEventHandler;
                use webview2_com::Microsoft::Web::WebView2::Win32::{
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST,
                    ICoreWebView2_2,
                };
                use windows_core::{HSTRING, Interface, PWSTR};

                // EVERY filtered request DEFERS in the network stack until this
                // handler runs on the host's UI thread — the SAME thread that
                // pumps the chrome UI and every other tab. A burst of them at
                // page-load time starves input, so the whole app freezes while
                // a page loads. Two defenses: (a) register only the contexts
                // that actually carry trackers — script / xhr / fetch /
                // websocket / ping — and let the high-volume IMAGE and MEDIA
                // streams (hundreds per page on image/video sites, ~zero
                // tracker value vs the script that summons them) go straight
                // through; (b) the handler itself is now allocation-light and
                // early-outs when blocking is idle. Documents (main frame) are
                // never intercepted — they're not in this list.
                for ctx in [
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING,
                ] {
                    let _ = core.AddWebResourceRequestedFilter(&HSTRING::from("*"), ctx);
                }
                // CRX downloads aren't in the contexts above — keep the UA
                // rewrite alive with narrow URL filters (any context).
                for url in [
                    "https://clients2.google.com/service/update2/crx*",
                    "https://update.googleapis.com/service/update2/crx*",
                ] {
                    let _ = core.AddWebResourceRequestedFilter(
                        &HSTRING::from(url),
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    );
                }
                let mut tok_wr = std::mem::zeroed();
                let top_url_wr = top_url.clone();
                let wr_handler = WebResourceRequestedEventHandler::create(Box::new(
                    move |sender, args| {
                        let Some(args) = args else { return Ok(()) };
                        let Ok(req) = args.Request() else { return Ok(()) };
                        let mut uri = PWSTR::null();
                        let url = if req.Uri(&mut uri).is_ok() { take_pwstr(uri) } else { return Ok(()) };

                        // (1) Chrome Web Store CRX — UA rewrite, then done
                        if url.starts_with("https://clients2.google.com/service/update2/crx")
                            || url.starts_with("https://update.googleapis.com/service/update2/crx")
                        {
                            if let Ok(headers) = req.Headers() {
                                let _ = headers.SetHeader(
                                    &HSTRING::from("User-Agent"),
                                    &HSTRING::from(crate::browser::downloads::CHROME_UA),
                                );
                                let _ = headers.SetHeader(
                                    &HSTRING::from("sec-ch-ua"),
                                    &HSTRING::from(r#""Chromium";v="126", "Google Chrome";v="126", "Not/A)Brand";v="8""#),
                                );
                            }
                            return Ok(());
                        }

                        // (2) Shields — nothing to do when blocking is off/loading
                        if !crate::browser::shields::ads_active() {
                            return Ok(());
                        }
                        // Never block the main frame
                        let mut ctx = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
                        let _ = args.ResourceContext(&mut ctx);
                        let Some(rtype) = crate::browser::shields::ctx_to_type(ctx.0) else { return Ok(()) };
                        // First-party origin from the cache (no COM Source() per
                        // request); fall back to Source() only until the first
                        // SourceChanged fills the cache.
                        let source = {
                            let cached = top_url_wr.lock().unwrap().clone();
                            if !cached.is_empty() {
                                cached
                            } else if let Some(core) = &sender {
                                let mut s = PWSTR::null();
                                if core.Source(&mut s).is_ok() { take_pwstr(s) } else { String::new() }
                            } else {
                                String::new()
                            }
                        };
                        if crate::browser::shields::should_block(&url, &source, rtype) {
                            if let Some(core) = &sender {
                                if let Ok(env) = core.cast::<ICoreWebView2_2>().and_then(|c| c.Environment()) {
                                    if let Ok(resp) = env.CreateWebResourceResponse(
                                        None,
                                        403,
                                        &HSTRING::from("Blocked by zro Shields"),
                                        &HSTRING::from(""),
                                    ) {
                                        let _ = args.SetResponse(&resp);
                                    }
                                }
                            }
                        }
                        Ok(())
                    },
                ));
                let _ = core.add_WebResourceRequested(&wr_handler, &mut tok_wr);
            }

            // Shields pillars 3+4: HTTPS upgrade + tracking-param stripping.
            // At navigation start, rewrite the target (http→https, drop utm_*/
            // fbclid/… ) and, if it changed, cancel + re-navigate to the clean
            // URL. The rewritten URL is already https and param-free, so its own
            // NavigationStarting won't rewrite again — no loop.
            {
                use webview2_com::NavigationStartingEventHandler;
                use windows_core::{HSTRING, PWSTR};

                let mut tok_ns = std::mem::zeroed();
                let ns_handler = NavigationStartingEventHandler::create(Box::new(
                    move |sender, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut uri = PWSTR::null();
                        if args.Uri(&mut uri).is_err() {
                            return Ok(());
                        }
                        let url = take_pwstr(uri);
                        if let Some(clean) = crate::browser::shields::rewrite_navigation(&url) {
                            let _ = args.SetCancel(true);
                            if let Some(core) = &sender {
                                let _ = core.Navigate(&HSTRING::from(clean));
                            }
                        }
                        Ok(())
                    },
                ));
                let _ = core.add_NavigationStarting(&ns_handler, &mut tok_ns);
            }

            // Password autosave + general autofill (stored by WebView2 in the
            // user data folder, encrypted at rest by the OS via DPAPI)
            if let Ok(wv13) = core.cast::<ICoreWebView2_13>() {
                if let Ok(profile) = wv13.Profile() {
                    if let Ok(p6) = profile.cast::<ICoreWebView2Profile6>() {
                        let _ = p6.SetIsPasswordAutosaveEnabled(true);
                        let _ = p6.SetIsGeneralAutofillEnabled(true);
                    }
                }
            }

            // SPA navigations: pushState/replaceState/fragment moves change the
            // source WITHOUT a page load — this is the only reliable URL signal
            let app_src = app.clone();
            let id_src = id.clone();
            let top_url_src = top_url.clone();
            let mut tok = std::mem::zeroed();
            let src_handler = SourceChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(core) = sender {
                    let mut uri = PWSTR::null();
                    if core.Source(&mut uri).is_ok() {
                        let url = take_pwstr(uri);
                        if !url.is_empty() {
                            // Refresh the Shields first-party cache (always, even
                            // for an unadopted spare) before the tab-scoped emit.
                            *top_url_src.lock().unwrap() = url.clone();
                            if let Some(tab_id) = crate::browser::tab_of_label(&app_src, &id_src) {
                                let _ = app_src.emit("page-navigated", serde_json::json!({ "id": tab_id, "url": url }));
                            }
                        }
                    }
                }
                Ok(())
            }));
            let _ = core.add_SourceChanged(&src_handler, &mut tok);

            // Live document titles (SPAs update titles without loads too)
            let app_title = app.clone();
            let id_title = id.clone();
            let mut tok2 = std::mem::zeroed();
            let title_handler = DocumentTitleChangedEventHandler::create(Box::new(move |sender, _| {
                let Some(tab_id) = crate::browser::tab_of_label(&app_title, &id_title) else { return Ok(()) };
                if let Some(core) = sender {
                    let mut t = PWSTR::null();
                    if core.DocumentTitle(&mut t).is_ok() {
                        let title = take_pwstr(t);
                        if !title.is_empty() {
                            let _ = app_title.emit("page-title", serde_json::json!({ "id": tab_id, "title": title }));
                        }
                    }
                }
                Ok(())
            }));
            let _ = core.add_DocumentTitleChanged(&title_handler, &mut tok2);

            // Audio state (tab mute button): IsDocumentPlayingAudioChanged +
            // IsMutedChanged both funnel into one "page-audio" event
            if let Ok(wv8) = core.cast::<ICoreWebView2_8>() {
                fn emit_audio(app: &AppHandle, label: &str, sender: &Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2>) {
                    use windows_core::Interface;
                    let Some(id) = crate::browser::tab_of_label(app, label) else { return };
                    let Some(core) = sender else { return };
                    let Ok(wv8) = core.cast::<ICoreWebView2_8>() else { return };
                    let (mut playing, mut muted) = (BOOL::default(), BOOL::default());
                    unsafe {
                        let _ = wv8.IsDocumentPlayingAudio(&mut playing);
                        let _ = wv8.IsMuted(&mut muted);
                    }
                    let _ = app.emit("page-audio", serde_json::json!({
                        "id": id, "audible": playing.as_bool(), "muted": muted.as_bool(),
                    }));
                }
                // Pause Shields interception while this page audibly plays:
                // streaming media chunks arrive over xhr/fetch, and every
                // filtered request DEFERS through the host UI thread — when
                // that thread is starved (a game pegging the CPU), the
                // deferred chunks arrive late and the audio underruns. The
                // two narrow CRX filters stay; blocking resumes on stop.
                let filters_paused =
                    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

                let app_a = app.clone();
                let id_a = id.clone();
                let paused_a = filters_paused.clone();
                let mut tok_a = std::mem::zeroed();
                let audio_handler = IsDocumentPlayingAudioChangedEventHandler::create(Box::new(
                    move |sender, _| {
                        if let Some(core) = &sender {
                            let mut playing = BOOL::default();
                            let known = core
                                .cast::<ICoreWebView2_8>()
                                .and_then(|w| w.IsDocumentPlayingAudio(&mut playing))
                                .is_ok();
                            if known {
                                use webview2_com::Microsoft::Web::WebView2::Win32::{
                                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH,
                                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING,
                                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT,
                                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET,
                                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST,
                                };
                                use windows_core::HSTRING;
                                let pause = playing.as_bool();
                                let was = paused_a.swap(pause, std::sync::atomic::Ordering::SeqCst);
                                if pause != was {
                                    for ctx in [
                                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT,
                                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST,
                                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH,
                                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET,
                                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING,
                                    ] {
                                        if pause {
                                            let _ = core.RemoveWebResourceRequestedFilter(
                                                &HSTRING::from("*"),
                                                ctx,
                                            );
                                        } else {
                                            let _ = core.AddWebResourceRequestedFilter(
                                                &HSTRING::from("*"),
                                                ctx,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        emit_audio(&app_a, &id_a, &sender);
                        Ok(())
                    },
                ));
                let _ = wv8.add_IsDocumentPlayingAudioChanged(&audio_handler, &mut tok_a);

                let app_m = app.clone();
                let id_m = id.clone();
                let mut tok_m = std::mem::zeroed();
                let muted_handler = IsMutedChangedEventHandler::create(Box::new(
                    move |sender, _| { emit_audio(&app_m, &id_m, &sender); Ok(()) },
                ));
                let _ = wv8.add_IsMutedChanged(&muted_handler, &mut tok_m);
            }

            // Element fullscreen (video players): page takes the whole window
            let app_fs = app.clone();
            let mut tok3 = std::mem::zeroed();
            let fs_handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(core) = sender {
                    let mut fs = BOOL::default();
                    if core.ContainsFullScreenElement(&mut fs).is_ok() {
                        crate::browser::overlay::set_fullscreen(&app_fs, fs.as_bool());
                    }
                }
                Ok(())
            }));
            let _ = core.add_ContainsFullScreenElementChanged(&fs_handler, &mut tok3);

            // External app protocols (roblox-player:, steam:, ms-*, tel:, …).
            // WebView2's DEFAULT launch spawns the target from the WebView2
            // browser process, which lives in WebView2's process job — so when
            // zro exits, the OS tears the job down and kills the game with it.
            // Cancel the default and relaunch the URI from OUR process via the
            // shell instead: the shell parents it outside any zro/WebView2 job,
            // so it survives zro closing.
            if let Ok(wv18) = core.cast::<ICoreWebView2_18>() {
                use webview2_com::LaunchingExternalUriSchemeEventHandler;
                let mut tok_ext = std::mem::zeroed();
                let ext_handler = LaunchingExternalUriSchemeEventHandler::create(Box::new(
                    move |_sender, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut uri = PWSTR::null();
                        if args.Uri(&mut uri).is_err() { return Ok(()) }
                        let url = take_pwstr(uri);
                        // Take over the launch ourselves (detached from the job).
                        let _ = args.SetCancel(true);
                        if !url.is_empty() {
                            shell_open_detached(&url);
                        }
                        Ok(())
                    },
                ));
                let _ = wv18.add_LaunchingExternalUriScheme(&ext_handler, &mut tok_ext);
            }
        }

        // Browser shortcuts while page focused
        let mut token = std::mem::zeroed();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_ctl, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
            let _ = args.KeyEventKind(&mut kind);
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN {
                return Ok(());
            }
            let mut vk: u32 = 0;
            let _ = args.VirtualKey(&mut vk);

            let ctrl = windows::Win32::UI::Input::KeyboardAndMouse::GetKeyState(0x11) as u16 & 0x8000 != 0;
            let shift = windows::Win32::UI::Input::KeyboardAndMouse::GetKeyState(0x10) as u16 & 0x8000 != 0;

            // F5 works without Ctrl
            if !ctrl && vk == 0x74 {
                let _ = args.SetHandled(true);
                let _ = app.emit("shortcut", serde_json::json!({ "combo": "reload" }));
                return Ok(());
            }
            if !ctrl { return Ok(()); }

            let combo = match (vk, shift) {
                (0x54, false) => Some("new-tab"),        // Ctrl+T
                (0x54, true)  => Some("reopen-tab"),     // Ctrl+Shift+T
                (0x4E, false) => Some("new-tab"),        // Ctrl+N
                (0x57, false) => Some("close-tab"),      // Ctrl+W
                (0x48, false) => Some("history"),        // Ctrl+H
                (0x4A, false) => Some("downloads"),      // Ctrl+J
                (0x4C, false) => Some("focus-url"),      // Ctrl+L
                (0x45, false) => Some("focus-url"),      // Ctrl+E
                (0x46, false) => Some("find"),           // Ctrl+F (suppress native find bar)
                (0x52, false) => Some("reload"),         // Ctrl+R
                (0x52, true)  => Some("hard-reload"),    // Ctrl+Shift+R
                (0x09, false) => Some("next-tab"),       // Ctrl+Tab
                (0x09, true)  => Some("prev-tab"),       // Ctrl+Shift+Tab
                (0x22, false) => Some("next-tab"),       // Ctrl+PgDn
                (0x21, false) => Some("prev-tab"),       // Ctrl+PgUp
                (0xBC, false) => Some("settings"),       // Ctrl+,
                (0x31..=0x39, false) => Some(match vk {  // Ctrl+1..9
                    0x31 => "tab-1", 0x32 => "tab-2", 0x33 => "tab-3",
                    0x34 => "tab-4", 0x35 => "tab-5", 0x36 => "tab-6",
                    0x37 => "tab-7", 0x38 => "tab-8", _ => "tab-9",
                }),
                _ => None,
            };
            if let Some(c) = combo {
                let _ = args.SetHandled(true);
                let _ = app.emit("shortcut", serde_json::json!({ "combo": c }));
            }
            Ok(())
        }));
        let _ = controller.add_AcceleratorKeyPressed(&handler, &mut token);
    });
}

#[cfg(not(windows))]
fn configure_webview(_app: &AppHandle, _wv: &tauri::Webview, _id: &str) {}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Named profiles = separate WebView2 user data folders (cookies, logins,
/// storage, extensions all isolated). "default"/None = the main profile dir,
/// untouched so existing state survives. Names are sanitized to a-z0-9- so a
/// profile id can never traverse out of the profiles dir.
fn profile_dir(app: &AppHandle, profile: &str) -> Option<std::path::PathBuf> {
    let clean: String = profile
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if clean.is_empty() || clean == "default" {
        return None;
    }
    let dir = app.path().app_data_dir().ok()?.join("profiles").join(clean);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Sign-in flows that must open as a REAL popup window even without explicit
/// size — the opener page waits for a postMessage from it.
fn is_auth_url(url: &str) -> bool {
    let Ok(u) = url.parse::<url::Url>() else { return false };
    let host = u.host_str().unwrap_or("");
    let path = u.path();
    // Google's GSI opens several accounts.google.com pages — all popups
    if host == "accounts.google.com" {
        return true;
    }
    let auth_host = matches!(
        host,
        "appleid.apple.com" | "login.microsoftonline.com" | "login.live.com"
            | "id.twitch.tv" | "discord.com" | "www.facebook.com" | "github.com"
    );
    (auth_host
        && (path.contains("oauth")
            || path.contains("signin")
            || path.contains("authorize")
            || path.contains("dialog")))
        || path.contains("/oauth")
}

/// Build a page webview with the full wiring (popups, downloads, load events,
/// shortcut interception). `label` is the webview label — for a cold-created
/// tab it equals the tab id; for a warm spare it's `spare-N` and every event
/// resolves its owner through the label map at fire time.
fn spawn_webview(
    app: &AppHandle,
    label: String,
    parsed: url::Url,
    data_dir: Option<std::path::PathBuf>,
    pos: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> Result<tauri::Webview, String> {
    let main = app.get_window("main").ok_or("no main window")?;
    let label_pl = label.clone();
    let app_popup = app.clone();
    let app_dl = app.clone();
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        // Dark render surface: no white flash between navigations, and the
        // repaint lag during live window resize blends into the dark UI
        .background_color(tauri::webview::Color(12, 12, 12, 255))
        // Never grab keyboard focus at construction — the spare rebuild and
        // background pre-wakes run while the user may be TYPING in the URL
        // bar (its blur closes the smartbar). Foreground activations call
        // set_focus explicitly.
        .focused(false)
        // Ctrl+scroll / Ctrl+± / Ctrl+0 page zoom (wry disables it by default)
        .zoom_hotkeys_enabled(true)
        // Chrome-extension support (ICoreWebView2Profile7). MUST match the
        // main window's browserExtensionsEnabled in tauri.conf.json — WebView2
        // rejects webviews whose environment options differ within one user
        // data folder.
        .browser_extensions_enabled(true)
        // window.open / target=_blank. wry DENIES all of these when no
        // handler is set. Two flavors:
        //  - sized window.open() or a sign-in host → REAL popup window
        //    (WebView2 default impl). OAuth needs window.opener +
        //    postMessage back to the page — opening it as a tab breaks
        //    Google sign-in (gsi/transform dead page, duplicate tabs).
        //  - plain target=_blank links → new tab.
        .on_new_window(move |url, features| {
            let u = url.to_string();
            // window.open() to an external app protocol (roblox-player://,
            // steam://, ms-…): launch it detached and open NO window. The old
            // "sized → Allow" path made WebView2 spawn a launcher popup that
            // immediately self-closed — and that close was taking the main
            // window down with it.
            let lower = u.to_ascii_lowercase();
            let is_web = lower.starts_with("http://") || lower.starts_with("https://")
                || lower.starts_with("about:") || lower.starts_with("blob:")
                || lower.starts_with("data:") || lower.starts_with("javascript:");
            if !is_web && !u.is_empty() {
                shell_open_detached(&u);
                return tauri::webview::NewWindowResponse::Deny;
            }
            if features.size().is_some() || is_auth_url(&u) {
                return tauri::webview::NewWindowResponse::Allow;
            }
            let _ = app_popup.emit("open-url", serde_json::json!({ "url": u }));
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(move |_wv, event| handle_download(&app_dl, event))
        .initialization_script(PERF_INIT_SCRIPT)
        .on_page_load(move |wv, payload| {
            use tauri::webview::PageLoadEvent;
            let eurl = payload.url().to_string();
            let app = wv.app_handle();
            // Unadopted spares stay silent — their warmup load must not
            // reach the frontend, history or nav timing
            let Some(tab_id) = crate::browser::tab_of_label(app, &label_pl) else { return };
            match payload.event() {
                PageLoadEvent::Finished => {
                    let ms = {
                        let state = app.state::<Mutex<BrowserState>>();
                        let mut s = state.lock().unwrap();
                        s.nav_started.remove(&tab_id).map(|t| t.elapsed().as_millis())
                    };
                    eprintln!("[nav] loaded in {}ms {}", ms.unwrap_or(0), eurl);
                    let _ = wv.emit("page-loaded", serde_json::json!({ "id": tab_id, "url": eurl }));
                }
                PageLoadEvent::Started => {
                    let is_active = {
                        let state = app.state::<Mutex<BrowserState>>();
                        let mut s = state.lock().unwrap();
                        s.nav_started.insert(tab_id.clone(), std::time::Instant::now());
                        s.active_tab_id.as_deref() == Some(tab_id.as_str())
                    };
                    // A fresh page paint can flash ABOVE the chrome before the
                    // UI thread services the region — the sidebar/URL bar
                    // appear "covered until it loads". Re-assert chrome-on-top
                    // repeatedly through the load (Chromium re-creates its
                    // composition windows mid-load, which re-stacks them above
                    // the UI), not just once at the start.
                    if is_active {
                        crate::browser::overlay::update_ui_region(app);
                        let app2 = app.clone();
                        tauri::async_runtime::spawn(async move {
                            for ms in [250u64, 700, 1500, 3000] {
                                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                                let a = app2.clone();
                                let _ = app2.run_on_main_thread(move || {
                                    // Bounds too — WebView2 sometimes ignores
                                    // positions set while the renderer spins up,
                                    // leaving the page over the sidebar area.
                                    sync_bounds(&a);
                                    crate::browser::overlay::update_ui_region(&a);
                                });
                            }
                        });
                    }
                    let _ = wv.emit("page-loading", serde_json::json!({ "id": tab_id }));
                }
            }
        });

    if let Some(dir) = data_dir {
        builder = builder.data_directory(dir);
    }

    // Anti-fingerprinting: inject the farble script at document-create (before
    // page JS). Baked at build time from the current setting — toggling it
    // applies to newly loaded tabs.
    if crate::browser::shields::anti_fp_on() {
        builder = builder.initialization_script(crate::browser::shields::FARBLE_JS);
    }

    // In-page search (Reef-inspired): replaces the native Ctrl+F and gives the
    // AI a ranked page-read tool. Runs in the page process, so it can't stall
    // the shared UI thread.
    builder = builder.initialization_script(crate::browser::search::SEARCH_INIT_SCRIPT);

    let wv = main
        .add_child(builder, pos, size)
        .map_err(|e: tauri::Error| {
            eprintln!("[tab] add_child failed for {label}: {e}");
            e.to_string()
        })?;

    configure_webview(app, &wv, &label);
    Ok(wv)
}

/// Shared tail of a foreground tab activation: park the previous tab's
/// webview, place this one at the content rect, register state, then enforce
/// bounds shortly after (WebView2 sometimes ignores the initial position).
fn finish_foreground(
    app: &AppHandle,
    state: &tauri::State<'_, Mutex<BrowserState>>,
    id: &str,
    url: &str,
    wv: &tauri::Webview,
    prev_active: Option<String>,
    layout: super::layout::Layout,
    main: &tauri::Window,
) {
    // Show the incoming webview BEFORE parking the old one — a hide-first
    // order leaves one uncovered frame where the UI shell (or desktop)
    // shows through as a flicker.
    if let Ok(rect) = compute_rect(main, layout) {
        let _ = wv.set_bounds(rect);
    }
    let _ = wv.show();
    let _ = wv.set_focus();
    if let Some(prev) = prev_active {
        if prev != id {
            if let Some(prev_wv) = crate::browser::tab_webview(app, &prev) {
                let _ = prev_wv.set_bounds(parked_rect(main, layout));
                let _ = prev_wv.hide();
                shed_memory(&prev_wv);
            }
        }
    }
    {
        let mut s = state.lock().unwrap();
        s.histories.insert(id.to_string(), TabHistory::new(url.to_string()));
        s.tabs.insert(id.to_string(), TabInfo {
            id: id.to_string(), url: url.to_string(), title: "New Tab".into(),
            favicon: None, is_loading: true,
        });
        s.active_tab_id = Some(id.to_string());
    }
    // New children stack above the UI webview — re-assert chrome-on-top
    super::overlay::update_ui_region(app);
    let app2 = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        sync_bounds(&app2);
    });
}

/// Keep one pre-built webview idling offscreen, pre-navigated to the new-tab
/// page — Ctrl+T adopts it instead of paying webview construction + first
/// navigation (the "instant new tab"). Rebuilt after every adoption.
pub(crate) fn ensure_spare(app: &AppHandle) {
    const SPARE_WARM_URL: &str = "https://www.google.com/";
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        super::session_cookies::wait_restored().await;
        // Don't compete with a startup restore / the adoption's own first
        // paint — the spare is a background nicety
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        // Wait for an input LULL before building: add_child blocks the main
        // thread for the whole webview construction (seconds under memory
        // pressure), and this rebuild fires right after every new tab /
        // hibernated-tab wake — landing it mid-typing/mid-scroll was the
        // "new tab lags for a couple seconds, even the sidebar freezes"
        // report. Built only once the user pauses, the same block is
        // invisible. No spare yet = clicks fall back to cold create, which
        // is just the pre-spare behavior.
        // …and for a NAVIGATION lull: the rebuild fires right after every
        // Ctrl+T adoption, which is exactly when the new tab starts LOADING.
        // The user goes hands-off to watch the page load → the input check
        // passes → add_child lands its main-thread block mid-load, stalling
        // the deferred request callbacks ("takes a while, then loads fast").
        // Wait until no page has been loading for a bit (stale entries — a
        // load that never fires Finished — stop counting after 30s).
        loop {
            #[cfg(windows)]
            let input_lull = system_idle_ms() >= 2_000;
            #[cfg(not(windows))]
            let input_lull = true;
            let nav_quiet = {
                let state = app.state::<Mutex<BrowserState>>();
                let s = state.lock().unwrap();
                s.nav_started.values().all(|t| t.elapsed().as_secs() >= 30)
            };
            if input_lull && nav_quiet {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        let state = app.state::<Mutex<BrowserState>>();
        let label = {
            let mut s = state.lock().unwrap();
            if s.spare.is_some() { return; }
            s.spare_seq += 1;
            format!("spare-{}", s.spare_seq)
        };
        let Ok(parsed) = SPARE_WARM_URL.parse::<url::Url>() else { return };
        let size = {
            let layout = state.lock().unwrap().layout;
            app.get_window("main")
                .and_then(|m| compute_rect(&m, layout).ok())
                .and_then(|r| match r.size {
                    tauri::Size::Logical(s) => Some(s),
                    _ => None,
                })
                .unwrap_or_else(|| LogicalSize::new(1000.0, 700.0))
        };
        match spawn_webview(&app, label.clone(), parsed, None, LogicalPosition::new(-32000.0, 0.0), size) {
            Ok(wv) => {
                let _ = wv.hide();
                {
                    let mut s = state.lock().unwrap();
                    s.spare = Some(label.clone());
                    s.spare_url = Some(SPARE_WARM_URL.into());
                }
                // Warm != expensive: once the page has settled, freeze the
                // spare's renderer. Adoption thaws it — still instant, but the
                // idle cost drops from a full renderer to a few tens of MB.
                tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                let still_spare = {
                    let state = app.state::<Mutex<BrowserState>>();
                    let s = state.lock().unwrap();
                    s.spare.as_deref() == Some(label.as_str())
                };
                if still_spare {
                    if let Some(wv) = app.get_webview(&label) {
                        suspend_webview(&app, &label, &wv);
                    }
                }
            }
            Err(e) => eprintln!("[spare] build failed: {e}"),
        }
    });
}

#[tauri::command]
pub async fn create_browser_tab(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
    id: String,
    url: String,
    profile: Option<String>,
    background: Option<bool>,
) -> Result<(), String> {
    let parsed = url.parse::<url::Url>().map_err(|e| e.to_string())?;
    let background = background.unwrap_or(false);

    // Session cookies must be back in the jar before the first navigation —
    // otherwise a restored YouTube/Gmail tab loads without them once, and the
    // site overwrites the restored state (theatre mode reads `wide` on load).
    super::session_cookies::wait_restored().await;

    // Idempotency: webview for this tab already exists → just activate it
    // (or do nothing for a background pre-wake)
    if crate::browser::tab_webview(&app, &id).is_some() {
        if !background {
            switch_browser_tab(app, state, id).await?;
        }
        return Ok(());
    }

    let (layout, prev_active) = {
        let s = state.lock().unwrap();
        (s.layout, s.active_tab_id.clone())
    };

    let main = app.get_window("main").ok_or("no main window")?;
    let rect = compute_rect(&main, layout)?;
    let (pos, size) = match (rect.position, rect.size) {
        (tauri::Position::Logical(p), tauri::Size::Logical(s)) => (p, s),
        _ => (LogicalPosition::new(layout.x, layout.y), LogicalSize::new(800.0, 600.0)),
    };

    let data_dir = profile.as_deref().and_then(|p| profile_dir(&app, p));

    // ── Warm-spare adoption: instant new tab ─────────────────────────────
    // Default profile + foreground only (spares live in the default data
    // directory; background pre-wakes aren't latency-sensitive).
    if data_dir.is_none() && !background {
        let adopt = {
            let mut s = state.lock().unwrap();
            s.spare.take().map(|l| (l, s.spare_url.take()))
        };
        if let Some((label, spare_url)) = adopt {
            if let Some(wv) = app.get_webview(&label) {
                // The idle spare is kept frozen — thaw before it goes live
                resume_webview(&app, &label, &wv);
                {
                    let mut s = state.lock().unwrap();
                    s.labels.insert(id.clone(), label.clone());
                    s.label_owner.insert(label, id.clone());
                }
                let already_there = spare_url.as_deref() == Some(parsed.as_str());
                if !already_there {
                    // Kill the new-tab-page flash: the spare idles on the warm
                    // URL — wipe it to the dark surface in place, THEN
                    // navigate. The user sees dark → target, never Google.
                    let _ = wv.eval(
                        "document.documentElement.innerHTML='';\
                         document.documentElement.style.background='#0c0c0c';",
                    );
                    let _ = wv.navigate(parsed.clone());
                }
                finish_foreground(&app, &state, &id, &url, &wv, prev_active, layout, &main);
                if already_there {
                    // Spare already sits on this page — no load event will
                    // fire, so close the frontend's loading state ourselves
                    let _ = app.emit("page-loaded", serde_json::json!({ "id": id, "url": parsed.as_str() }));
                }
                ensure_spare(&app);
                return Ok(());
            }
            // Spare's webview died — fall through to a cold create
        }
    }

    // ── Cold create ──────────────────────────────────────────────────────
    // Background pre-wake (hover on a sleeping tab): build parked + hidden so
    // it never flashes over the active page; switch later just shows it.
    let spawn_pos = if background { LogicalPosition::new(-32000.0, 0.0) } else { pos };
    let wv = spawn_webview(&app, id.clone(), parsed, data_dir, spawn_pos, size)?;

    {
        let mut s = state.lock().unwrap();
        s.labels.insert(id.clone(), id.clone());
        s.label_owner.insert(id.clone(), id.clone());
    }

    if background {
        let _ = wv.hide();
        let mut s = state.lock().unwrap();
        s.histories.entry(id.clone()).or_insert_with(|| TabHistory::new(url.clone()));
        s.tabs.entry(id.clone()).or_insert_with(|| TabInfo {
            id: id.clone(), url, title: "New Tab".into(), favicon: None, is_loading: true,
        });
        return Ok(());
    }

    finish_foreground(&app, &state, &id, &url, &wv, prev_active, layout, &main);
    Ok(())
}

/// Put a long-idle background tab to sleep: destroy its webview (frees the
/// whole renderer process, typically 100-400 MB) while keeping the tab entry
/// and its URL trail. Waking = the existing lazy-restore path.
#[tauri::command]
pub async fn hibernate_tab(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
    id: String,
) -> Result<(), String> {
    let label = {
        let mut s = state.lock().unwrap();
        if s.active_tab_id.as_deref() == Some(&id) {
            return Err("won't hibernate the active tab".into());
        }
        let label = s.labels.remove(&id).unwrap_or_else(|| id.clone());
        s.label_owner.remove(&label);
        s.suspended.remove(&label);
        label
    };
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.close();
    }
    Ok(())
}

/// Switch = move webviews, NO navigation → no page reload, state preserved.
/// Returns false when this tab has no webview yet (restored from a previous
/// session) — the frontend then lazily creates it.
#[tauri::command]
pub async fn switch_browser_tab(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
    id: String,
) -> Result<bool, String> {
    if crate::browser::tab_webview(&app, &id).is_none() {
        return Ok(false);
    }

    let (prev, layout) = {
        let mut s = state.lock().unwrap();
        let prev = s.active_tab_id.replace(id.clone());
        (prev, s.layout)
    };

    let main = app.get_window("main");
    // Incoming FIRST, outgoing after — the reverse order uncovers the UI
    // shell for a frame (visible flicker on every switch).
    if let (Some(main), Some(wv)) = (main.as_ref(), crate::browser::tab_webview(&app, &id)) {
        // Frozen renderer (background freeze) → thaw before it's shown
        resume_webview(&app, &crate::browser::tab_label(&app, &id), &wv);
        if let Ok(rect) = compute_rect(main, layout) {
            let _ = wv.set_bounds(rect);
        }
        let _ = wv.show();
        let _ = wv.set_focus();
    }
    if let Some(prev) = prev {
        if prev != id {
            if let (Some(main), Some(wv)) = (main.as_ref(), crate::browser::tab_webview(&app, &prev)) {
                let _ = wv.set_bounds(parked_rect(main, layout));
                // Hidden = Chromium stops compositing it → GPU/CPU freed for
                // the foreground tab (audio keeps playing, like normal browsers)
                let _ = wv.hide();
                // Ask Chromium to shed its caches right away — the freeze
                // sweep only reaches it after a minute of idling
                shed_memory(&wv);
            }
        }
    }
    // Re-assert chrome-on-top + hole (rounded corners come from the UI region)
    super::overlay::update_ui_region(&app);
    Ok(true)
}

#[tauri::command]
pub async fn close_browser_tab(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
    id: String,
) -> Result<Option<String>, String> {
    // Destroy this tab's webview entirely — frees its renderer process
    let label = {
        let mut s = state.lock().unwrap();
        let label = s.labels.remove(&id).unwrap_or_else(|| id.clone());
        s.label_owner.remove(&label);
        s.suspended.remove(&label);
        label
    };
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.close();
    }

    let next_id = {
        let mut s = state.lock().unwrap();
        s.tabs.remove(&id);
        s.histories.remove(&id);
        if s.active_tab_id.as_deref() == Some(&id) {
            s.active_tab_id = s.tabs.keys().next().cloned();
        }
        s.active_tab_id.clone()
    };

    // Bring the next tab's webview into view
    if next_id.is_some() {
        sync_bounds(&app);
        if let Some(wv) = active_webview(&app) {
            let _ = wv.set_focus();
        }
    }

    Ok(next_id)
}

#[tauri::command]
pub async fn navigate_tab(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
    id: String,
    url: String,
) -> Result<(), String> {
    let parsed = url.parse::<url::Url>().map_err(|e| e.to_string())?;
    {
        let mut s = state.lock().unwrap();
        if let Some(tab) = s.tabs.get_mut(&id) {
            tab.url = url.clone();
            tab.is_loading = true;
        }
    }
    if let Some(wv) = crate::browser::tab_webview(&app, &id) {
        resume_webview(&app, &crate::browser::tab_label(&app, &id), &wv);
        wv.navigate(parsed).map_err(|e: tauri::Error| e.to_string())?;
        // Navigating the ACTIVE tab must also un-hide it — a whole-app freeze
        // (minimize / idle watchdog) may have hidden the webview, and a
        // navigation that lands on an invisible renderer reads as "search
        // blanks the page".
        let is_active = {
            let s = state.lock().unwrap();
            s.active_tab_id.as_deref() == Some(id.as_str())
        };
        if is_active {
            let _ = wv.show();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn push_to_history(
    state: tauri::State<'_, Mutex<BrowserState>>,
    id: String,
    url: String,
) -> Result<(), String> {
    if let Ok(mut s) = state.lock() {
        if let Some(hist) = s.histories.get_mut(&id) {
            hist.push(url);
        }
    }
    Ok(())
}

/// Native renderer-history navigation. Unlike re-navigating to a stored URL
/// (full page load), CoreWebView2 GoBack/GoForward restores from the session
/// history — instant, keeps scroll position and form state.
/// Returns false when the renderer can't go that way (e.g. webview recreated
/// this session) so the caller can fall back to the URL list.
#[cfg(windows)]
fn native_history_nav(wv: &tauri::Webview, forward: bool) -> bool {
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    let ok = wv.with_webview(move |pwv| unsafe {
        let controller = pwv.controller();
        let moved = controller.CoreWebView2().ok().and_then(|core| {
            let mut can = windows_core::BOOL::default();
            if forward {
                core.CanGoForward(&mut can).ok()?;
                if can.as_bool() { core.GoForward().ok()?; Some(true) } else { Some(false) }
            } else {
                core.CanGoBack(&mut can).ok()?;
                if can.as_bool() { core.GoBack().ok()?; Some(true) } else { Some(false) }
            }
        }).unwrap_or(false);
        let _ = tx.send(moved);
    }).is_ok();
    ok && rx.recv_timeout(std::time::Duration::from_millis(500)).unwrap_or(false)
}

#[cfg(not(windows))]
fn native_history_nav(_wv: &tauri::Webview, _forward: bool) -> bool { false }

async fn history_nav(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
    forward: bool,
) -> Result<(), String> {
    let id = match state.lock().unwrap().active_tab_id.clone() {
        Some(i) => i,
        None => return Ok(()),
    };
    let Some(wv) = crate::browser::tab_webview(&app, &id) else { return Ok(()) };
    resume_webview(&app, &crate::browser::tab_label(&app, &id), &wv);

    // Fast path: renderer session history (instant, preserves state)
    let wv2 = wv.clone();
    let native = tokio::task::spawn_blocking(move || native_history_nav(&wv2, forward))
        .await
        .unwrap_or(false);
    if native {
        // Keep our URL list in step without triggering a nav
        if let Ok(mut s) = state.lock() {
            if let Some(h) = s.histories.get_mut(&id) {
                if forward { h.forward(); } else { h.back(); }
            }
        }
        return Ok(());
    }

    // Fallback: our own URL list (restored tabs whose renderer history is gone)
    let url = {
        let mut s = state.lock().unwrap();
        s.histories.get_mut(&id).and_then(|h| if forward { h.forward() } else { h.back() })
    };
    if let Some(url) = url {
        let parsed = url.parse::<url::Url>().map_err(|e| e.to_string())?;
        wv.navigate(parsed).map_err(|e: tauri::Error| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn go_back(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
) -> Result<(), String> {
    history_nav(app, state, false).await
}

#[tauri::command]
pub async fn go_forward(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
) -> Result<(), String> {
    history_nav(app, state, true).await
}

#[tauri::command]
pub async fn reload_tab(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = active_webview(&app) {
        wv.reload().map_err(|e: tauri::Error| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_tab_state(
    state: tauri::State<'_, Mutex<BrowserState>>,
) -> Result<Vec<TabInfo>, String> {
    Ok(state.lock().unwrap().tabs.values().cloned().collect())
}

/// Mute/unmute a tab. SetIsMuted fires IsMutedChanged → the configure_webview
/// handler emits "page-audio", so the frontend state follows automatically.
#[cfg(windows)]
#[tauri::command]
pub async fn set_tab_muted(app: AppHandle, id: String, muted: bool) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use windows_core::Interface;

    let wv = crate::browser::tab_webview(&app, &id).ok_or("no such tab")?;
    wv.with_webview(move |pwv| unsafe {
        if let Ok(core) = pwv.controller().CoreWebView2() {
            if let Ok(wv8) = core.cast::<ICoreWebView2_8>() {
                let _ = wv8.SetIsMuted(muted);
            }
        }
    })
    .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn set_tab_muted(_app: AppHandle, _id: String, _muted: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::TabHistory;

    #[test]
    fn history_back_forward() {
        let mut h = TabHistory::new("a".into());
        h.push("b".into());
        h.push("c".into());
        assert_eq!(h.back(), Some("b".into()));
        // The back-navigation lands as a SourceChanged push — must be skipped
        h.push("b".into());
        assert_eq!(h.back(), Some("a".into()));
        h.push("a".into());
        assert_eq!(h.back(), None); // at the start
        assert_eq!(h.forward(), Some("b".into()));
        h.push("b".into());
        assert_eq!(h.forward(), Some("c".into()));
        h.push("c".into());
        assert_eq!(h.forward(), None); // at the end
    }

    #[test]
    fn history_dedupes_reloads() {
        let mut h = TabHistory::new("a".into());
        h.push("a".into()); // reload — no new entry
        assert_eq!(h.back(), None);
    }

    #[test]
    fn history_truncates_forward_on_new_nav() {
        let mut h = TabHistory::new("a".into());
        h.push("b".into());
        assert_eq!(h.back(), Some("a".into()));
        h.push("a".into()); // skip_next consumes this
        h.push("c".into()); // branches: forward list ("b") is discarded
        assert_eq!(h.forward(), None);
        assert_eq!(h.back(), Some("a".into()));
    }
}
