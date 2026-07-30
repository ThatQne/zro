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

/// A launch argument that's openable (what Windows passes when zro is the
/// default browser / "Open with"): an http(s)/file URL, or a local file path
/// (double-clicked .html) which becomes a file:// URL. Skips the exe path and
/// any flags.
pub fn url_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find_map(|a| {
        let l = a.to_ascii_lowercase();
        if l.starts_with("http://") || l.starts_with("https://") || l.starts_with("file://") {
            return Some(a);
        }
        if a.starts_with('-') {
            return None; // flag, not a document
        }
        // "Open with zro" hands us a bare filesystem path, not a URL.
        let p = std::path::Path::new(&a);
        if p.is_file() {
            let abs = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
            // canonicalize returns \\?\C:\… on Windows — strip the verbatim
            // prefix or the file:// URL grows a bogus host.
            let s = abs.to_string_lossy();
            let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
            return url::Url::from_file_path(s).ok().map(|u| u.to_string());
        }
        None
    })
}

/// Forward a URL (from launch args / a second instance) to the UI to open as a
/// tab. Best-effort — dropped if the frontend isn't listening yet.
pub fn open_url(app: &AppHandle, url: &str) {
    // Same shape the popup/new-window path uses so the one frontend listener
    // handles both — `external` is what tells them apart: there is no source
    // tab here, so the new tab must not inherit the active tab's folder.
    let _ = app.emit(
        "open-url",
        serde_json::json!({ "url": url, "external": true }),
    );
}

// Registration writes native Win32 registry calls, not `reg.exe`. A burst of
// a dozen reg.exe spawns from an unsigned exe is a persistence pattern that
// trips Defender's ML — the in-process API leaves nothing to match on.
#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Create `HKCU\<subkey>` and set one value (name=None → the key's default
/// value). All string data is REG_SZ. Returns false on any failure.
#[cfg(windows)]
fn reg_set(subkey: &str, name: Option<&str>, value: &str) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };
    unsafe {
        let sub = wide(subkey);
        let mut hkey = HKEY::default();
        let rc = RegCreateKeyExW(
            HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), None, PCWSTR::null(),
            REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut hkey, None,
        );
        if rc != ERROR_SUCCESS {
            return false;
        }
        let v = wide(value);
        let bytes = std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 2);
        let n = name.map(wide);
        let name_ptr = n.as_ref().map(|w| PCWSTR(w.as_ptr())).unwrap_or(PCWSTR::null());
        let rc = RegSetValueExW(hkey, name_ptr, Some(0), REG_SZ, Some(bytes));
        let _ = RegCloseKey(hkey);
        rc == ERROR_SUCCESS
    }
}

/// Read `HKCU\<subkey>`'s default (unnamed) REG_SZ value.
#[cfg(windows)]
fn reg_get(subkey: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    unsafe {
        let sub = wide(subkey);
        let mut cb: u32 = 0;
        let rc = RegGetValueW(
            HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR::null(),
            RRF_RT_REG_SZ, None, None, Some(&mut cb),
        );
        if rc != ERROR_SUCCESS || cb == 0 {
            return None;
        }
        let mut buf = vec![0u16; (cb as usize / 2) + 1];
        let rc = RegGetValueW(
            HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR::null(),
            RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut cb),
        );
        if rc != ERROR_SUCCESS {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

/// Is this exe running out of a cargo build tree (i.e. `tauri dev` / a local
/// `cargo build`), rather than an installed copy?
#[cfg(windows)]
fn is_dev_exe(exe: &str) -> bool {
    let l = exe.to_ascii_lowercase();
    l.contains("\\target\\debug\\") || l.contains("\\target\\release\\")
}

/// Write the HKCU registration that makes zro appear as a default-browser
/// candidate. Idempotent — safe to call every launch.
///
/// Refuses to point Windows at a build-tree exe. A dev exe registered here is
/// doubly bad: the debug binary is a CONSOLE-subsystem build (a black console
/// flashes on every launch — `windows_subsystem = "windows"` is release-only),
/// and every externally-opened link then starts a *second* zro binary against
/// the one `com.zro.browser` WebView2 profile, whose Local Storage leveldb only
/// tolerates a single owner. That collision is what wiped a whole session once.
#[cfg(windows)]
pub fn register() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    if is_dev_exe(&exe) {
        return Err(
            "this is a development build — install zro and set the default from the installed copy"
                .into(),
        );
    }

    // ProgId: how Windows opens an http(s) document with zro.
    let classes = format!("Software\\Classes\\{PROGID}");
    reg_set(&classes, None, "zro HTML Document");
    reg_set(&format!("{classes}\\DefaultIcon"), None, &format!("{exe},0"));
    reg_set(
        &format!("{classes}\\shell\\open\\command"),
        None,
        &format!("\"{exe}\" \"%1\""),
    );

    // Capabilities: name + which URL schemes zro claims.
    let caps = "Software\\zro\\Capabilities";
    reg_set(caps, Some("ApplicationName"), "zro");
    reg_set(caps, Some("ApplicationDescription"), "A fast, minimalist browser.");
    let assoc = format!("{caps}\\URLAssociations");
    reg_set(&assoc, Some("http"), PROGID);
    reg_set(&assoc, Some("https"), PROGID);
    // StartMenuInternet-style shortcut associations too (Set Default Programs).
    let file_assoc = format!("{caps}\\FileAssociations");
    reg_set(&file_assoc, Some(".htm"), PROGID);
    reg_set(&file_assoc, Some(".html"), PROGID);

    // Advertise the capabilities set to Windows.
    reg_set(
        "Software\\RegisteredApplications",
        Some("zro"),
        "Software\\zro\\Capabilities",
    );
    Ok(())
}

/// Whether zro's default-browser registration is present.
#[cfg(windows)]
pub fn is_registered() -> bool {
    use windows::core::w;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    unsafe {
        let mut cb: u32 = 0;
        let rc = RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\RegisteredApplications"),
            w!("zro"),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut cb),
        );
        rc == ERROR_SUCCESS
    }
}

/// Repair a registration that points at a different zro than this one.
///
/// The open command is a plain string in HKCU, so it keeps pointing at whatever
/// exe registered last — including a build-tree binary that has since been
/// deleted or, worse, one that still runs and fights the installed copy for the
/// WebView2 profile. Only an installed build heals it: a dev run must never
/// hijack the association.
#[cfg(windows)]
pub(crate) fn heal_registration() {
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = exe.to_string_lossy().to_string();
    if is_dev_exe(&exe) {
        return;
    }
    // Nothing registered at all → leave it alone; registering is the user's
    // explicit choice via Settings, not something a launch does behind them.
    let key = format!("Software\\Classes\\{PROGID}\\shell\\open\\command");
    let Some(cur) = reg_get(&key) else { return };
    let want = format!("\"{exe}\" \"%1\"");
    if cur == want {
        return;
    }
    let _ = register();
}

/// Register (if needed) and open Windows' Default-apps page so the user can
/// pick zro. Returns once Settings has been asked to open.
#[cfg(windows)]
#[tauri::command]
pub async fn set_default_browser(_app: AppHandle) -> Result<(), String> {
    register()?;
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    // Deep-link straight to zro's default-apps entry via ShellExecute (no cmd
    // /C start shell). Windows falls back to the general page if the app id
    // isn't matched yet.
    unsafe {
        let _ = ShellExecuteW(
            None,
            w!("open"),
            w!("ms-settings:defaultapps?registeredAppUser=zro"),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
    }
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
