//! Register zro as a selectable Windows default browser and handle the URLs
//! Windows hands us when it is one.
//!
//! Windows 10/11 will not let an app silently seize the http/https default —
//! the user must confirm in Settings ▸ Default apps. What we *can* do is
//! register zro as a valid candidate (so it shows up there at all) and then
//! open that Settings page. Registration is all under HKCU (no admin needed);
//! we shell out to `reg.exe` rather than hand-roll the Win32 registry calls.
//!
//! Once zro is the default, Windows launches `zro.exe "<url>"`. The
//! single-instance plugin forwards that argv to the running window, and
//! [`url_from_args`] pulls the URL out so the frontend can open a tab.

use tauri::{AppHandle, Emitter};

const PROGID: &str = "zroHTML";

/// A launch argument that's an http(s) URL (what Windows passes when zro is the
/// default browser), if any. Skips the exe path and any flags.
pub fn url_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find(|a| {
        let l = a.to_ascii_lowercase();
        l.starts_with("http://") || l.starts_with("https://")
    })
}

/// Forward a URL (from launch args / a second instance) to the UI to open as a
/// tab. Best-effort — dropped if the frontend isn't listening yet.
pub fn open_url(app: &AppHandle, url: &str) {
    // Same shape the popup/new-window path uses so the one frontend listener
    // handles both.
    let _ = app.emit("open-url", serde_json::json!({ "url": url }));
}

#[cfg(windows)]
fn reg_add(key: &str, name: Option<&str>, value: &str) -> bool {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("reg");
    cmd.arg("add").arg(key);
    match name {
        Some(n) => { cmd.arg("/v").arg(n); }
        None => { cmd.arg("/ve"); }
    }
    cmd.arg("/d").arg(value).arg("/f");
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// Write the HKCU registration that makes zro appear as a default-browser
/// candidate. Idempotent — safe to call every launch.
#[cfg(windows)]
pub fn register() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();

    // ProgId: how Windows opens an http(s) document with zro.
    let classes = format!("HKCU\\Software\\Classes\\{PROGID}");
    reg_add(&classes, None, "zro HTML Document");
    reg_add(&format!("{classes}\\DefaultIcon"), None, &format!("{exe},0"));
    reg_add(
        &format!("{classes}\\shell\\open\\command"),
        None,
        &format!("\"{exe}\" \"%1\""),
    );

    // Capabilities: name + which URL schemes zro claims.
    let caps = "HKCU\\Software\\zro\\Capabilities";
    reg_add(caps, Some("ApplicationName"), "zro");
    reg_add(caps, Some("ApplicationDescription"), "A fast, minimalist browser.");
    let assoc = format!("{caps}\\URLAssociations");
    reg_add(&assoc, Some("http"), PROGID);
    reg_add(&assoc, Some("https"), PROGID);
    // StartMenuInternet-style shortcut associations too (Set Default Programs).
    let file_assoc = format!("{caps}\\FileAssociations");
    reg_add(&file_assoc, Some(".htm"), PROGID);
    reg_add(&file_assoc, Some(".html"), PROGID);

    // Advertise the capabilities set to Windows.
    reg_add(
        "HKCU\\Software\\RegisteredApplications",
        Some("zro"),
        "Software\\zro\\Capabilities",
    );
    Ok(())
}

/// Whether zro's default-browser registration is present.
#[cfg(windows)]
pub fn is_registered() -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("reg")
        .args(["query", "HKCU\\Software\\RegisteredApplications", "/v", "zro"])
        .creation_flags(0x0800_0000)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Register (if needed) and open Windows' Default-apps page so the user can
/// pick zro. Returns once Settings has been asked to open.
#[cfg(windows)]
#[tauri::command]
pub async fn set_default_browser(_app: AppHandle) -> Result<(), String> {
    register()?;
    use std::os::windows::process::CommandExt;
    // Deep-link straight to zro's default-apps entry when possible; Windows
    // falls back to the general page if the app id isn't matched yet.
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:defaultapps?registeredAppUser=zro"])
        .creation_flags(0x0800_0000)
        .spawn();
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub async fn is_default_browser_registered(_app: AppHandle) -> Result<bool, String> {
    Ok(is_registered())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn set_default_browser(_app: AppHandle) -> Result<(), String> {
    Err("only supported on Windows".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn is_default_browser_registered(_app: AppHandle) -> Result<bool, String> {
    Ok(false)
}
