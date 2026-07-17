mod agent;
mod browser;

use agent::{AiCancel, SemanticMemory};
use browser::BrowserState;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[tauri::command]
fn minimize_window(window: tauri::Window) {
    window.minimize().unwrap();
}

#[tauri::command]
fn maximize_window(window: tauri::Window) {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().unwrap();
    } else {
        window.maximize().unwrap();
    }
}

#[tauri::command]
fn close_window(window: tauri::Window) {
    window.close().unwrap();
}

#[tauri::command]
fn start_drag(window: tauri::Window) {
    window.start_dragging().unwrap();
}

pub fn run() {
    tauri::Builder::default()
        // Single instance MUST be the first plugin. When zro is the default
        // browser and already running, Windows starts a second `zro.exe "<url>"`;
        // this forwards that argv to the live window (→ new tab) and exits the
        // duplicate, instead of opening a whole second browser.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(url) = browser::default_browser::url_from_args(argv) {
                browser::default_browser::open_url(app, &url);
            }
        }))
        // Auto-update stack: updater checks GitHub Releases + verifies the
        // minisign signature; process plugin supplies relaunch() after install.
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(BrowserState::default()))
        .manage(Mutex::new(SemanticMemory::default()))
        .manage(Mutex::new(browser::memory::MemGraph::default()))
        .manage(AiCancel::default())
        .manage(browser::Downloads::default())
        .invoke_handler(tauri::generate_handler![
            minimize_window,
            maximize_window,
            close_window,
            start_drag,
            browser::create_browser_tab,
            browser::switch_browser_tab,
            browser::close_browser_tab,
            browser::hibernate_tab,
            browser::suspend_tab,
            browser::set_idle_freeze_min,
            browser::set_shield_config,
            browser::get_shield_stats,
            browser::open_find,
            browser::get_process_breakdown,
            browser::delete_profile_data,
            browser::navigate_tab,
            browser::go_back,
            browser::go_forward,
            browser::reload_tab,
            browser::set_layout,
            browser::set_overlays,
            browser::get_cookies,
            browser::set_cookie,
            browser::delete_cookie,
            browser::focus_main,
            browser::search_suggest,
            browser::list_downloads,
            browser::clear_downloads,
            browser::delete_download,
            browser::trim_cache,
            browser::download_crx,
            browser::open_download,
            browser::reveal_download,
            browser::get_tab_state,
            browser::set_tab_muted,
            browser::push_to_history,
            browser::get_memory_info,
            browser::get_disk_usage,
            browser::show_tab_menu,
            browser::show_folder_menu,
            browser::show_extension_menu,
            browser::save_image_as,
            browser::log_js,
            browser::clear_browsing_data,
            browser::clear_site_data,
            browser::set_password_autosave,
            browser::list_passwords,
            browser::reveal_password,
            browser::verify_identity,
            browser::install_crx_extension,
            browser::install_unpacked_extension,
            browser::list_extensions,
            browser::reload_extension,
            browser::remove_extension,
            browser::set_extension_enabled,
            browser::get_extension_icon,
            browser::open_extension_popup,
            browser::mem_list,
            browser::mem_add,
            browser::mem_update,
            browser::mem_delete,
            browser::mem_link,
            browser::mem_unlink,
            browser::mem_search,
            browser::mem_ingest_visit,
            browser::default_browser::set_default_browser,
            browser::default_browser::is_default_browser_registered,
            browser::set_clipboard_text,
            browser::copy_image,
            agent::check_ollama,
            agent::check_mzcode,
            agent::list_ollama_models,
            agent::list_openai_models,
            agent::ask_ai,
            agent::cancel_ai,
            agent::index_page,
            agent::get_page_meta,
        ])
        // Native context-menu selections → frontend
        .on_menu_event(|app, event| {
            let (ctx, page) = {
                let state = app.state::<Mutex<BrowserState>>();
                let s = state.lock().unwrap();
                (s.menu_ctx.clone(), s.page_menu_ctx.clone())
            };
            let _ = app.emit("ctx-action", serde_json::json!({
                "action": event.id().0,
                "ctx": ctx,
                "page": page,
            }));
        })
        .setup(|app| {
            // Dual-GPU laptops otherwise default WebView2 to the weak
            // integrated GPU — invisible until a WebGL/3D/video-heavy page
            // hits it. One-time registry opt-in, cheap to redo every launch.
            browser::prefer_high_performance_gpu();

            // Host pump must win scheduling ties against games — see
            // boost_process_priority docs (runs on the main/UI thread).
            browser::boost_process_priority();

            // Native resize handler — repositions the single browser webview
            // immediately on every OS resize event, no JS bridge latency
            let app_handle = app.handle().clone();
            // Plain Window handle — get_webview_window("main") stops matching
            // once tab webviews are added (multiwebview), see browser.rs note.
            let main_window = app.get_window("main")
                .expect("main window missing");

            // Taskbar/titlebar icon. The bundled .ico wires up the built exe,
            // but `tauri dev` and the undecorated transparent window otherwise
            // fall back to a blank (black) taskbar square — set it explicitly
            // from the embedded PNG at runtime so both dev and release show it.
            if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")) {
                let _ = main_window.set_icon(icon);
            }

            // Native resize → reposition active webview instantly from stored
            // layout offsets. Zero IPC round-trips = smooth live resize.
            // Also notify JS so React-side layout (maximize detection) updates.
            main_window.on_window_event(move |event| {
                match event {
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                        // Minimized = user is elsewhere → freeze every page
                        // renderer (audio excluded); restore thaws the active
                        // tab. A minimized zro should cost close to nothing.
                        let minimized = app_handle
                            .get_window("main")
                            .map(|w| w.is_minimized().unwrap_or(false))
                            .unwrap_or(false);
                        if minimized {
                            browser::tabs::on_minimized(&app_handle);
                            return;
                        }
                        browser::tabs::on_restored(&app_handle);
                        // Live-resize path: instant GDI region tracking,
                        // one real webview resize after the drag settles
                        browser::on_live_resize(&app_handle);
                        let _ = app_handle.emit("window-resized", ());
                    }
                    // Final session-cookie snapshot before the process dies —
                    // Chromium drops session cookies on clean exit, so this is
                    // what keeps YouTube theatre mode & co. across restarts.
                    // prevent_close → async snapshot → destroy (no re-entry).
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        if browser::session_cookies::begin_shutdown() {
                            api.prevent_close();
                            let app = app_handle.clone();
                            tauri::async_runtime::spawn(async move {
                                browser::session_cookies::snapshot(&app).await;
                                if let Some(w) = app.get_window("main") {
                                    let _ = w.destroy();
                                }
                            });
                        }
                    }
                    // Extension popup close-on-click-out, main-window side:
                    // the popup's own Focused(false) is unreliable when its
                    // WebView2 child holds keyboard focus (tao swallows the
                    // blur), but clicking anywhere in zro — chrome OR page
                    // webview — always activates the main top-level window.
                    tauri::WindowEvent::Focused(true) => {
                        // Self-heal any stuck freeze/hide state the moment the
                        // user is back — covers missed restore events and the
                        // idle watchdog's poll latency ("see-through window")
                        browser::tabs::on_user_active(&app_handle);
                        if let Some(popup) = app_handle.get_webview_window("ext-popup") {
                            let _ = popup.close();
                        }
                    }
                    _ => {}
                }
            });

            // Session cookies: restore last session's jar before any tab
            // webview navigates, then keep a rolling snapshot (crash safety —
            // the close-time snapshot only covers clean exits).
            let app_cookies = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                browser::session_cookies::restore(&app_cookies).await;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                    // Machine idle-frozen → nothing is changing, skip the beat
                    if browser::tabs::is_idle_frozen() {
                        continue;
                    }
                    browser::session_cookies::snapshot(&app_cookies).await;
                }
            });

            // Idle watchdog: whole-machine idle past the threshold → freeze
            // every renderer (the all-night fan fix). First input thaws.
            browser::tabs::idle_watch(app.handle());

            // Shields: load block lists + build the adblock engine (Brave's
            // engine, native) — request interception is wired per-webview.
            browser::shields::init_shields(app.handle());

            // Warm spare: pre-built webview so the first Ctrl+T is instant
            // (waits for the session-cookie restore internally)
            browser::tabs::ensure_spare(app.handle());

            // Browsing-data growth is unbounded in WebView2 — trim the
            // rebuildable cache once it crosses the cap (90s after boot)
            browser::auto_trim_cache(app.handle());

            // Set taskbar / title-bar icon (embedded at compile time)
            let _ = main_window.set_icon(tauri::include_image!("icons/icon.png"));

            // Launched as the default browser with a URL (`zro.exe "<url>"`)?
            // Hand it to the UI once the frontend listener is up (short delay —
            // the second-instance path goes through the single-instance plugin
            // instead, which always fires after the window exists).
            if let Some(url) = browser::default_browser::url_from_args(std::env::args()) {
                let app_url = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
                    browser::default_browser::open_url(&app_url, &url);
                });
            }

            // Devtools no longer auto-open — Ctrl+Shift+I toggles them on demand
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running zro");
}
