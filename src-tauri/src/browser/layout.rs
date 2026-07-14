//! Webview geometry: content-area rect math and instant live-resize tracking.
//! Rounded corners + overlays live in [`super::overlay`] (UI-on-top region).

use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Rect};

use super::overlay::update_ui_region;
use super::BrowserState;

pub(crate) const CORNER_INSET: f64 = 12.0;

/// Content-area layout, pushed from JS (which measures the real DOM rect).
/// Rust recomputes width/height from window size on native resize events so
/// live resize is instant with zero IPC round-trips.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    pub x: f64,            // content-area left (sidebar width)
    pub y: f64,            // content-area top (header height)
    pub right_offset: f64, // reserved right-side width (currently always 0 — panels overlay)
    pub inset: f64,        // corner inset
    pub fullscreen: bool,  // element fullscreen (video) — page owns the window
}

impl Default for Layout {
    fn default() -> Self {
        Self { x: 44.0, y: 40.0, right_offset: 0.0, inset: CORNER_INSET, fullscreen: false }
    }
}

// NOTE: always use the plain `Window` handle (`app.get_window("main")`), never
// `get_webview_window("main")` — the latter only matches windows with exactly
// ONE webview, so it returns None forever once the first tab webview is added.
// That single lookup silently broke resize, tab switching and Ctrl+T.
pub(crate) fn compute_rect(main: &tauri::Window, l: Layout) -> Result<Rect, String> {
    let inner = main.inner_size().map_err(|e: tauri::Error| e.to_string())?;
    let scale = main.scale_factor().map_err(|e: tauri::Error| e.to_string())?;
    if l.fullscreen {
        return Ok(Rect {
            position: LogicalPosition::new(0.0, 0.0).into(),
            size: LogicalSize::new(
                (inner.width as f64 / scale).max(1.0),
                (inner.height as f64 / scale).max(1.0),
            )
            .into(),
        });
    }
    let w = (inner.width as f64 / scale - l.x - l.right_offset - l.inset).max(1.0);
    let h = (inner.height as f64 / scale - l.y - l.inset).max(1.0);
    Ok(Rect {
        position: LogicalPosition::new(l.x, l.y).into(),
        size: LogicalSize::new(w, h).into(),
    })
}

/// Park offscreen but KEEP the content-area size. Resizing a parked webview
/// (the old 4×4 trick) forced a full page relayout on every tab switch —
/// which looked like the page reloading.
pub(crate) fn parked_rect(main: &tauri::Window, l: Layout) -> Rect {
    let size = compute_rect(main, l)
        .map(|r| r.size)
        .unwrap_or_else(|_| LogicalSize::new(800.0, 600.0).into());
    Rect {
        position: LogicalPosition::new(-32000.0, 0.0).into(),
        size,
    }
}

/// Reposition the ACTIVE tab's webview to the content area.
/// Called from JS layout pushes and the native resize handler.
pub fn sync_bounds(app: &AppHandle) {
    let state = app.state::<Mutex<BrowserState>>();
    let (id, layout, resizing) = {
        let s = state.lock().unwrap();
        (s.active_tab_id.clone(), s.layout, s.resizing)
    };
    // Live resize owns the bounds (oversize + region clip); the settle task
    // calls us again once the drag ends.
    if resizing {
        return;
    }
    let Some(id) = id else { return };
    let (Some(main), Some(wv)) = (app.get_window("main"), super::tab_webview(app, &id)) else {
        eprintln!("[layout] sync_bounds: window/webview missing for {id}");
        return;
    };
    match compute_rect(&main, layout) {
        Ok(rect) => {
            if let Err(e) = wv.set_bounds(rect) {
                eprintln!("[layout] set_bounds failed: {e}");
            }
            // Activation path — parked webviews are hidden to stop background
            // compositing; make sure the active one is visible
            let _ = wv.show();
        }
        Err(e) => eprintln!("[layout] compute_rect failed: {e}"),
    }
    // Chrome hole must track the content rect
    update_ui_region(app);
}

/// Live window resize. Never resize the webview per event — Chromium bounds
/// changes are async (SWP_ASYNCWINDOWPOS + compositor) and lag the cursor.
/// Instead: on the 2nd rapid event (= real interactive drag) grow the webview
/// ONCE to monitor size, then track every event with the synchronous GDI
/// region hole (see overlay.rs). One real set_bounds happens 300ms after the
/// last event.
pub fn on_live_resize(app: &AppHandle) {
    let state = app.state::<Mutex<BrowserState>>();
    let (id, layout, gen, was_resizing) = {
        let mut s = state.lock().unwrap();
        s.resize_gen = s.resize_gen.wrapping_add(1);
        let was = s.resizing;
        s.resizing = true;
        (s.active_tab_id.clone(), s.layout, s.resize_gen, was)
    };

    if let (Some(id), Some(main)) = (id, app.get_window("main")) {
        if let (Some(wv), Ok(rect)) = (super::tab_webview(app, &id), compute_rect(&main, layout)) {
            let scale = main.scale_factor().unwrap_or(1.0);

            let need_oversize = {
                let mut s = state.lock().unwrap();
                if was_resizing && !s.oversized {
                    s.oversized = true;
                    true
                } else {
                    false
                }
            };
            if need_oversize {
                let (mw, mh) = main
                    .current_monitor()
                    .ok()
                    .flatten()
                    .map(|m| {
                        let sz = m.size();
                        (sz.width as f64 / scale, sz.height as f64 / scale)
                    })
                    .unwrap_or((3840.0, 2160.0));
                let _ = wv.set_bounds(Rect {
                    position: rect.position,
                    size: LogicalSize::new(mw, mh).into(),
                });
            }
        }
    }

    // The chrome region (window-sized, with the content hole) tracks every
    // event synchronously — this is what makes resize feel instant.
    update_ui_region(app);

    // Settle: if no further resize event bumps the generation within 300ms,
    // apply the real bounds exactly once.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let state = app2.state::<Mutex<BrowserState>>();
        {
            let mut s = state.lock().unwrap();
            if s.resize_gen != gen {
                return; // superseded by a newer event
            }
            s.resizing = false;
            s.oversized = false;
        }
        sync_bounds(&app2);
    });
}

/// JS pushes content-area layout (measured from the real DOM rect).
/// Rust stores it and repositions the active webview; native resizes then
/// recompute from these stored offsets with no further IPC.
#[tauri::command]
pub async fn set_layout(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
    x: f64,
    y: f64,
    right_offset: f64,
    inset: f64,
) -> Result<(), String> {
    {
        let mut s = state.lock().unwrap();
        let next = Layout { x, y, right_offset, inset, fullscreen: s.layout.fullscreen };
        if next == s.layout {
            return Ok(()); // no change — skip the set_bounds churn
        }
        s.layout = next;
    }
    sync_bounds(&app);
    Ok(())
}
