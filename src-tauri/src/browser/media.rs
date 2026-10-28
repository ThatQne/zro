//! Bounded media reads. The page fetch path retains blob/auth context; a host
//! fallback supports cross-origin resources without weakening CORS globally.
use tauri::AppHandle;
const LIMIT: usize = 32 * 1024 * 1024;
pub(crate) fn check_image(bytes: &[u8]) -> Result<(), String> {
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let (w, h) = reader.into_dimensions().map_err(|e| e.to_string())?;
    if w as u64 * h as u64 > 16000000 {
        return Err("Image is too large to convert safely; save the original instead.".into());
    }
    Ok(())
}
pub(crate) async fn save_original(app: &AppHandle, url: String) -> Result<String, String> {
    use tauri::Manager;
    let filename = url::Url::parse(&url)
        .ok()
        .and_then(|u| u.path_segments().and_then(|s| s.last()).map(str::to_owned))
        .filter(|s| !s.is_empty() && s.len() < 120)
        .unwrap_or_else(|| {
            let ext = if url.starts_with("data:image/gif") {
                "gif"
            } else if url.starts_with("data:image/png") {
                "png"
            } else {
                "bin"
            };
            format!("media.{ext}")
        });
    let filename: String = filename
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut dialog = rfd::AsyncFileDialog::new().set_file_name(filename);
    if let Ok(dir) = app.path().download_dir() {
        dialog = dialog.set_directory(dir);
    }
    let Some(handle) = dialog.save_file().await else {
        return Ok(String::new());
    };
    let path = handle.path().to_path_buf();
    // Normal URLs stream directly to disk so video size doesn't become RAM
    // usage. Blob/data exports use the bounded renderer path above.
    if url.starts_with("http://") || url.starts_with("https://") {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;
        let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            // Authenticated/same-origin media may require the renderer's
            // cookies. Do not invent or globally weaken cookie/CORS policy.
            tokio::fs::write(&path, bytes(app, &url).await?)
                .await
                .map_err(|e| e.to_string())?;
            super::downloads::record_completed(app, url, &path);
            return Ok(path.to_string_lossy().into_owned());
        }
        let temporary = path.with_file_name(format!(".zro-{}.part", uuid::Uuid::new_v4()));
        let result = async {
            let mut file = tokio::fs::File::create(&temporary)
                .await
                .map_err(|e| e.to_string())?;
            let mut stream = response.bytes_stream();
            while let Some(part) = stream.next().await {
                file.write_all(&part.map_err(|e| e.to_string())?)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            file.flush().await.map_err(|e| e.to_string())?;
            drop(file);
            tokio::fs::rename(&temporary, &path)
                .await
                .map_err(|e| e.to_string())
        }
        .await;
        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(e);
        }
    } else {
        tokio::fs::write(&path, bytes(app, &url).await?)
            .await
            .map_err(|e| e.to_string())?;
    }
    super::downloads::record_completed(app, url, &path);
    Ok(path.to_string_lossy().into_owned())
}
pub(crate) async fn bytes(app: &AppHandle, url: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    if let Some(data) = url.strip_prefix("data:") {
        let (meta, body) = data.split_once(',').ok_or("Invalid data URL")?;
        if body.len() > LIMIT * 4 / 3 + 4 {
            return Err("Media exceeds the 32 MiB conversion limit; use the site's download action for large files.".into());
        }
        if meta.ends_with(";base64") {
            return base64::engine::general_purpose::STANDARD
                .decode(body)
                .map_err(|e| e.to_string());
        }
        return Ok(percent_decode(body));
    }
    #[cfg(windows)]
    if let Some(wv) = super::active_webview(app) {
        let expression = format!(
            r#"(async()=>{{const r=await fetch({},{{credentials:'include',signal:AbortSignal.timeout(15000)}});if(!r.ok)throw Error('HTTP '+r.status);const reader=r.body.getReader();let chunks=[],size=0;while(true){{const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>{LIMIT}){{await reader.cancel();throw Error('Media too large')}}chunks.push(v.value)}}const b=new Blob(chunks);return await new Promise((ok,no)=>{{const f=new FileReader();f.onload=()=>ok(f.result);f.onerror=no;f.readAsDataURL(b)}})}})()"#,
            serde_json::to_string(url).unwrap()
        );
        let result = super::devtools::call(
            &wv,
            "Runtime.evaluate",
            serde_json::json!({"expression":expression,"awaitPromise":true,"returnByValue":true}),
        )
        .await;
        if let Ok(value) = result {
            if let Some(data) = value
                .pointer("/result/value")
                .and_then(|v| v.as_str())
                .and_then(|v| v.split_once(','))
                .map(|v| v.1)
            {
                if data.len() <= LIMIT * 4 / 3 + 4 {
                    return base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .map_err(|e| e.to_string());
                }
            }
        }
    }
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("This media cannot be exported as a file. Stream/DRM playlists are not standalone videos.".into());
    }
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(25))
            .build()
            .unwrap()
    });
    let response = CLIENT
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if out.len() + chunk.len() > LIMIT {
            return Err(
                "Media exceeds 32 MiB; use the site's direct download for large files.".into(),
            );
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}
fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(hex) = std::str::from_utf8(&b[i + 1..i + 3]) {
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}
