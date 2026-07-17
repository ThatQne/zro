//! Native OS context menus. DOM menus can't draw above the native child
//! webviews, so tab/folder context menus are real OS popup menus. Selection
//! comes back through on_menu_event (wired in lib.rs) which emits
//! "ctx-action" to the frontend.

use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use super::BrowserState;

#[derive(Debug, Clone, serde::Deserialize)]
pub struct FolderLite {
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub async fn show_tab_menu(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
    ids: Vec<String>,
    folders: Vec<FolderLite>,
    in_folder: bool,
    keep_awake: bool,
) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let n = ids.len();
    state.lock().unwrap().menu_ctx = ids;

    let close_label = if n > 1 { format!("Close {n} Tabs") } else { "Close Tab".into() };
    let dup_label = if n > 1 { format!("Duplicate {n} Tabs") } else { "Duplicate Tab".into() };
    let copy_label = if n > 1 { format!("Copy {n} URLs") } else { "Copy URL".into() };

    // Power: freeze (keep RAM, instant resume) vs hibernate (drop the whole
    // renderer, slow reload) vs keep-awake (exempt from every auto-sleep sweep).
    let awake_label = if keep_awake { "Allow Sleeping" } else { "Keep Awake" };
    let power_sub = SubmenuBuilder::new(&app, "Power")
        .item(&MenuItemBuilder::with_id("tab:freeze", "Freeze Now").build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("tab:hibernate", "Hibernate Now").build(&app).map_err(|e| e.to_string())?)
        .separator()
        .item(&MenuItemBuilder::with_id("tab:keep-awake", awake_label).build(&app).map_err(|e| e.to_string())?)
        .build().map_err(|e| e.to_string())?;

    let mut folder_sub = SubmenuBuilder::new(&app, "Move to Folder");
    for f in &folders {
        folder_sub = folder_sub.item(
            &MenuItemBuilder::with_id(format!("tab:folder:{}", f.id), &f.name)
                .build(&app).map_err(|e| e.to_string())?,
        );
    }
    if !folders.is_empty() {
        folder_sub = folder_sub.separator();
    }
    folder_sub = folder_sub.item(
        &MenuItemBuilder::with_id("tab:folder:new", "New Folder…")
            .build(&app).map_err(|e| e.to_string())?,
    );
    let folder_sub = folder_sub.build().map_err(|e| e.to_string())?;

    let mut menu = MenuBuilder::new(&app)
        .item(&MenuItemBuilder::with_id("tab:close", close_label).build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("tab:close-others", "Close Other Tabs").build(&app).map_err(|e| e.to_string())?)
        .separator()
        .item(&MenuItemBuilder::with_id("tab:duplicate", dup_label).build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("tab:copy-url", copy_label).build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("tab:reload", "Reload").build(&app).map_err(|e| e.to_string())?)
        .separator()
        .item(&power_sub)
        .item(&folder_sub);

    if in_folder {
        menu = menu.item(
            &MenuItemBuilder::with_id("tab:unfolder", "Remove from Folder")
                .build(&app).map_err(|e| e.to_string())?,
        );
    }

    let menu = menu.build().map_err(|e| e.to_string())?;
    let window = app.get_window("main").ok_or("no main window")?;
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// Right-click on a toolbar extension icon.
#[tauri::command]
pub async fn show_extension_menu(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
    id: String,
    enabled: bool,
    pinned: bool,
) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};

    state.lock().unwrap().menu_ctx = vec![id];

    let menu = MenuBuilder::new(&app)
        .item(&MenuItemBuilder::with_id("ext:manage", "Manage Extension…").build(&app).map_err(|e| e.to_string())?)
        .separator()
        .item(&MenuItemBuilder::with_id("ext:toggle", if enabled { "Disable" } else { "Enable" }).build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("ext:pin", if pinned { "Unpin from Toolbar" } else { "Pin to Toolbar" }).build(&app).map_err(|e| e.to_string())?)
        .separator()
        .item(&MenuItemBuilder::with_id("ext:remove", "Remove from zro").build(&app).map_err(|e| e.to_string())?)
        .build()
        .map_err(|e| e.to_string())?;

    let window = app.get_window("main").ok_or("no main window")?;
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// Web-content right-click menu. Built from `page_menu_ctx` (captured by the
/// ContextMenuRequested handler in tabs.rs) and popped at the cursor. Items are
/// context-dependent; selections come back via on_menu_event as `page:*` and
/// are performed on the frontend (see the ctx-action listener).
pub fn show_page_menu_now(app: &AppHandle) {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let ctx = {
        let state = app.state::<Mutex<BrowserState>>();
        let s = state.lock().unwrap();
        s.page_menu_ctx.clone()
    };

    let build = || -> Result<(), tauri::Error> {
        let mut menu = MenuBuilder::new(app);

        if !ctx.link.is_empty() {
            menu = menu
                .item(&MenuItemBuilder::with_id("page:open-link", "Open Link in New Tab").build(app)?)
                .item(&MenuItemBuilder::with_id("page:copy-link", "Copy Link Address").build(app)?)
                .separator();
        }

        if ctx.is_image && !ctx.src.is_empty() {
            let save_sub = SubmenuBuilder::new(app, "Save Image As")
                .item(&MenuItemBuilder::with_id("page:save-image:png", "PNG").build(app)?)
                .item(&MenuItemBuilder::with_id("page:save-image:jpeg", "JPEG").build(app)?)
                .item(&MenuItemBuilder::with_id("page:save-image:webp", "WebP").build(app)?)
                .build()?;
            menu = menu
                .item(&MenuItemBuilder::with_id("page:open-image", "Open Image in New Tab").build(app)?)
                .item(&save_sub)
                .item(&MenuItemBuilder::with_id("page:copy-image-data", "Copy Image").build(app)?)
                .item(&MenuItemBuilder::with_id("page:copy-image", "Copy Image Address").build(app)?)
                .separator();
        }

        if !ctx.selection.trim().is_empty() {
            let sel = ctx.selection.trim();
            let short: String = sel.chars().take(24).collect();
            let label = if sel.chars().count() > 24 {
                format!("Search for \"{short}…\"")
            } else {
                format!("Search for \"{short}\"")
            };
            menu = menu
                .item(&MenuItemBuilder::with_id("page:copy", "Copy").build(app)?)
                .item(&MenuItemBuilder::with_id("page:search", label).build(app)?)
                .separator();
        }

        menu = menu
            .item(&MenuItemBuilder::with_id("page:back", "Back").build(app)?)
            .item(&MenuItemBuilder::with_id("page:forward", "Forward").build(app)?)
            .item(&MenuItemBuilder::with_id("page:reload", "Reload").build(app)?)
            .separator()
            .item(&MenuItemBuilder::with_id("page:copy-url", "Copy Page URL").build(app)?);

        let menu = menu.build()?;
        if let Some(window) = app.get_window("main") {
            window.popup_menu(&menu)?;
        }
        Ok(())
    };

    if let Err(e) = build() {
        eprintln!("[page-menu] {e}");
    }
}

/// Fetch an image, decode whatever the site served (webp, avif via the codecs
/// enabled in Cargo.toml, …) and re-encode it to the format the user picked,
/// then write it via a native Save-As dialog. This is the fix for sites that
/// only serve webp — the user gets a real PNG/JPEG on disk.
#[tauri::command]
pub async fn save_image_as(app: AppHandle, url: String, format: String) -> Result<String, String> {
    use image::ImageFormat;

    let (fmt, ext) = match format.as_str() {
        "png" => (ImageFormat::Png, "png"),
        "jpeg" | "jpg" => (ImageFormat::Jpeg, "jpg"),
        "webp" => (ImageFormat::WebP, "webp"),
        other => return Err(format!("unsupported format: {other}")),
    };

    // Host-side fetch — no CORS / tainted-canvas limits (client JS can't do this).
    let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
    let bytes = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    let img = image::load_from_memory(&bytes).map_err(|e| format!("decode failed: {e}"))?;
    // JPEG has no alpha channel — flatten transparency to RGB first.
    let img = if matches!(fmt, ImageFormat::Jpeg) {
        image::DynamicImage::ImageRgb8(img.to_rgb8())
    } else {
        img
    };

    let mut out: Vec<u8> = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), fmt)
        .map_err(|e| format!("encode failed: {e}"))?;

    // Default name from the URL's last path segment (minus its old extension).
    let stem = url
        .rsplit('/')
        .next()
        .and_then(|s| s.split(['?', '#']).next())
        .map(|s| s.rsplit_once('.').map(|(a, _)| a).unwrap_or(s))
        .filter(|s| !s.is_empty())
        .unwrap_or("image");
    let default_name = format!("{stem}.{ext}");

    let mut dlg = rfd::AsyncFileDialog::new().set_file_name(&default_name);
    if let Ok(dir) = app.path().download_dir() {
        dlg = dlg.set_directory(dir);
    }
    let Some(handle) = dlg.save_file().await else {
        return Ok(String::new()); // user cancelled
    };
    let path = handle.path().to_path_buf();
    std::fs::write(&path, &out).map_err(|e| e.to_string())?;
    // Surface it in the Downloads panel like any other download.
    super::downloads::record_completed(&app, url, &path);
    Ok(path.to_string_lossy().to_string())
}

/// Color/icon picking moved to a DOM grid popover in the sidebar
/// ("folder:edit" → FolderStyleEditor) — native submenus can't render
/// swatch grids or SVG icons.
#[tauri::command]
pub async fn show_folder_menu(
    app: AppHandle,
    state: tauri::State<'_, Mutex<BrowserState>>,
    id: String,
) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};

    state.lock().unwrap().menu_ctx = vec![id];

    let menu = MenuBuilder::new(&app)
        .item(&MenuItemBuilder::with_id("folder:rename", "Rename").build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("folder:edit", "Edit Color & Icon…").build(&app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("folder:open-all", "Open All Tabs").build(&app).map_err(|e| e.to_string())?)
        .separator()
        .item(&MenuItemBuilder::with_id("folder:randomize", "Shuffle Style").build(&app).map_err(|e| e.to_string())?)
        .separator()
        .item(&MenuItemBuilder::with_id("folder:delete", "Delete Folder").build(&app).map_err(|e| e.to_string())?)
        .build()
        .map_err(|e| e.to_string())?;

    let window = app.get_window("main").ok_or("no main window")?;
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}
