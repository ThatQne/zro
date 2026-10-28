//! Await COM completion without blocking WebView2's STA/message pump.
pub(crate) async fn call(
    wv: &tauri::Webview,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let method = method.to_owned();
    let params = params.to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let pending = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    wv.with_webview(move |p| unsafe {
        let completion = pending.clone();
        let result = (|| -> windows_core::Result<()> {
            let core = p.controller().CoreWebView2()?;
            let done = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, json| {
                    if let Some(tx) = completion.lock().unwrap().take() {
                        let _ = tx.send(status.map(|_| json).map_err(|e| e.to_string()));
                    }
                    Ok(())
                },
            ));
            core.CallDevToolsProtocolMethod(
                &windows_core::HSTRING::from(method),
                &windows_core::HSTRING::from(params),
                &done,
            )
        })();
        if let Err(e) = result {
            if let Some(tx) = pending.lock().unwrap().take() {
                let _ = tx.send(Err(e.to_string()));
            }
        }
    })
    .map_err(|e| e.to_string())?;
    let raw = tokio::time::timeout(std::time::Duration::from_secs(25), rx)
        .await
        .map_err(|_| "Browser operation timed out")?
        .map_err(|e| e.to_string())??;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}
