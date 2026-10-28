//! Host-side clipboard. The UI runs in a WebView2, and `navigator.clipboard`
//! there rejects with NotAllowedError whenever the document doesn't hold focus
//! — which is exactly the case right after our *native* right-click menu closes
//! (the menu took focus). So every copy the menu triggers runs through here
//! instead, where the OS clipboard is always reachable.

/// Put plain text on the clipboard. Runs on a blocking thread — arboard's
/// Win32 clipboard calls are synchronous.
#[tauri::command]
pub async fn set_clipboard_text(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        cb.set_text(text).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy the actual image (a bitmap) — not just its URL — to the clipboard.
/// Fetches host-side (no CORS / tainted-canvas limits), decodes, and hands
/// arboard raw RGBA. Handles both remote URLs and inline `data:` images.
#[tauri::command]
pub async fn copy_image(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let bytes = super::media::bytes(&app, &url).await?;

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        super::media::check_image(&bytes)?;
        let img = image::load_from_memory(&bytes)
            .map_err(|e| e.to_string())?
            .to_rgba8();
        let (w, h) = img.dimensions();
        let data = arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::from(img.into_raw()),
        };
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        cb.set_image(data).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
