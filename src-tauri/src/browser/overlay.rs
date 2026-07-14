//! UI-on-top compositing.
//!
//! Native child webviews always draw above the UI webview's DOM — the root
//! cause of every "renders under the page" bug. This module flips the stack:
//! the UI webview is raised ABOVE all page webviews, and a GDI region cuts a
//! rounded "hole" where the page shows through. DOM overlays (sidebar flyout,
//! panels, URL-bar dropdown) simply punch their rects back into the region
//! and genuinely render OVER the page — no viewport shifting, ever.
//!
//! Regions also handle hit-testing: clicks inside the hole fall through to
//! the page webview beneath; clicks on chrome/overlays hit the UI.

use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use super::layout::sync_bounds;
use super::BrowserState;

/// CSS-pixel rect pushed from JS for each visible DOM overlay.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
pub struct OverlayRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// corner radius (logical px)
    pub r: f64,
}

/// Recompute and apply the UI webview's window region:
/// full window − rounded content hole + overlay rects.
pub fn update_ui_region(app: &AppHandle) {
    let state = app.state::<Mutex<BrowserState>>();
    let (layout, overlays, fullscreen, page_hidden) = {
        let s = state.lock().unwrap();
        (s.layout, s.overlays.clone(), s.fullscreen, s.page_hidden)
    };
    let Some(main) = app.get_window("main") else { return };
    let (Ok(inner), Ok(scale)) = (main.inner_size(), main.scale_factor()) else { return };
    let (win_w, win_h) = (inner.width as i32, inner.height as i32);
    if win_w <= 0 || win_h <= 0 {
        return;
    }

    // Content hole in physical px (matches layout::compute_rect)
    let hx = (layout.x * scale).round() as i32;
    let hy = (layout.y * scale).round() as i32;
    let hr = win_w - ((layout.right_offset + layout.inset) * scale).round() as i32;
    let hb = win_h - (layout.inset * scale).round() as i32;
    let hole_radius = (10.0 * scale).round() as i32;

    let ov_px: Vec<(i32, i32, i32, i32, i32)> = overlays
        .iter()
        .map(|o| {
            (
                (o.x * scale).round() as i32,
                (o.y * scale).round() as i32,
                ((o.x + o.w) * scale).round() as i32,
                ((o.y + o.h) * scale).round() as i32,
                (o.r * scale).round() as i32,
            )
        })
        .collect();

    // Active page hidden (long-idle freeze): keep the region SOLID — no hole.
    // The window is transparent, so a hole over a hidden webview shows the
    // desktop through ("window turns see-through after idling").
    let hole = if page_hidden { (0, 0, 0, 0) } else { (hx, hy, hr, hb) };

    // SetWindowRgn(…, redraw=true) forces a full chrome repaint, and callers
    // re-assert repeatedly (page-load re-stacks, live resize, tab switch).
    // Rebuild the region only when its inputs changed; the HWND_TOP re-assert
    // in apply_region is the part that must always run.
    let set_region = {
        let sig = (win_w, win_h, hole, hole_radius, fullscreen, ov_px.clone());
        let mut last = LAST_REGION.lock().unwrap();
        if last.as_ref() == Some(&sig) {
            false
        } else {
            *last = Some(sig);
            true
        }
    };

    let Some(ui) = app.get_webview("main") else { return };
    apply_region(&ui, win_w, win_h, hole, hole_radius, fullscreen, ov_px, set_region);
}

/// Signature of the last-applied window region (see update_ui_region).
#[allow(clippy::type_complexity)]
static LAST_REGION: Mutex<
    Option<(i32, i32, (i32, i32, i32, i32), i32, bool, Vec<(i32, i32, i32, i32, i32)>)>,
> = Mutex::new(None);

#[cfg(windows)]
fn apply_region(
    ui: &tauri::Webview,
    win_w: i32,
    win_h: i32,
    hole: (i32, i32, i32, i32),
    hole_radius: i32,
    fullscreen: bool,
    overlays: Vec<(i32, i32, i32, i32, i32)>,
    set_region: bool,
) {
    let _ = ui.with_webview(move |pwv| unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::{
            CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF,
            RGN_OR,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };

        let controller = pwv.controller();
        let mut hwnd = HWND::default();
        if controller.ParentWindow(&mut hwnd).is_err() || hwnd.is_invalid() {
            return;
        }

        // Chrome must stay above the page webviews — newly created children
        // stack on top, so re-assert on every region update (idempotent).
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );

        // Unchanged region → the z-order re-assert above was all we needed
        if !set_region {
            return;
        }

        let region = CreateRectRgn(0, 0, win_w, win_h);
        let (hx, hy, hr, hb) = hole;
        if fullscreen {
            // Fullscreen video: page owns the whole window, chrome invisible
            let all = CreateRectRgn(0, 0, win_w, win_h);
            let _ = CombineRgn(Some(region), Some(region), Some(all), RGN_DIFF);
            let _ = DeleteObject(all.into());
        } else if hr > hx && hb > hy {
            let h = CreateRoundRectRgn(hx, hy, hr + 1, hb + 1, hole_radius * 2, hole_radius * 2);
            let _ = CombineRgn(Some(region), Some(region), Some(h), RGN_DIFF);
            let _ = DeleteObject(h.into());
        }
        for (l, t, r, b, rad) in overlays {
            if r <= l || b <= t {
                continue;
            }
            let o = CreateRoundRectRgn(l, t, r + 1, b + 1, rad * 2, rad * 2);
            let _ = CombineRgn(Some(region), Some(region), Some(o), RGN_OR);
            let _ = DeleteObject(o.into());
        }
        // System takes ownership of `region` — do not delete it
        let _ = SetWindowRgn(hwnd, Some(region), true);
    });
}

#[cfg(not(windows))]
fn apply_region(
    _ui: &tauri::Webview,
    _win_w: i32,
    _win_h: i32,
    _hole: (i32, i32, i32, i32),
    _hole_radius: i32,
    _fullscreen: bool,
    _overlays: Vec<(i32, i32, i32, i32, i32)>,
    _set_region: bool,
) {
}

/// JS pushes the rects of every currently-visible DOM overlay.
#[tauri::command]
pub async fn set_overlays(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
    rects: Vec<OverlayRect>,
) -> Result<(), String> {
    {
        let mut s = state.lock().unwrap();
        if s.overlays == rects {
            return Ok(());
        }
        s.overlays = rects;
    }
    update_ui_region(&app);
    Ok(())
}

/// Page requested (or left) element fullscreen — video players etc.
/// The page webview expands to the whole window and the chrome region empties.
pub(crate) fn set_fullscreen(app: &AppHandle, fullscreen: bool) {
    {
        let state = app.state::<Mutex<BrowserState>>();
        let mut s = state.lock().unwrap();
        if s.fullscreen == fullscreen {
            return;
        }
        s.fullscreen = fullscreen;
        s.layout.fullscreen = fullscreen;
    }
    sync_bounds(app);
    update_ui_region(app);
}
