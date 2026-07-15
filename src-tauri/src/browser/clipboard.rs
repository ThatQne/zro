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
pub async fn copy_image(url: String) -> Result<(), String> {
    let bytes: Vec<u8> = if let Some(rest) = url.strip_prefix("data:") {
        // data:[<mime>][;base64],<payload>
        use base64::Engine;
        let comma = rest.find(',').ok_or("malformed data URI")?;
        let meta = &rest[..comma];
        let payload = &rest[comma + 1..];
        if meta.contains("base64") {
            base64::engine::general_purpose::STANDARD
                .decode(payload)
                .map_err(|e| e.to_string())?
        } else {
            // percent-encoded text image (rare) — treat bytes as-is
            payload.as_bytes().to_vec()
        }
    } else {
        let client = reqwest::Client::builder()
            .user_agent(super::downloads::CHROME_UA)
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("fetch failed (HTTP {})", resp.status()));
        }
        resp.bytes().await.map_err(|e| e.to_string())?.to_vec()
    };

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
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
