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
