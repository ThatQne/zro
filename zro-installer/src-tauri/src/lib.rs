//! zro installer backend.
//!
//! Flow: download the portable zro payload from the GitHub release, extract it
//! into the chosen directory, create shortcuts, register an uninstall entry, and
//! (optionally) launch. Progress is streamed to the UI via `install-progress`.
//!
//! NOTE (integration): this expects the zro release to publish a **portable
//! zip** asset (zro.exe + WebView2Loader.dll + resources) at [`PAYLOAD_URL`].
//! zro currently ships only an NSIS installer — add a zip artifact to
//! `release.yml` (see zro-installer/README.md) before this can fetch a real
//! build. Until then `install` works against any zip at that URL.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// Portable zip published on the zro release. `latest` redirects to the newest.
const PAYLOAD_URL: &str =
    "https://github.com/ThatQne/zro/releases/latest/download/zro-portable.zip";
/// The executable name inside the zip / install dir.
const EXE_NAME: &str = "zro.exe";
/// This installer, copied into the install dir to serve as the uninstaller.
const UNINSTALL_NAME: &str = "uninstall.exe";

#[derive(Deserialize, Default)]
struct Options {
    desktop: bool,
    startmenu: bool,
    launch: bool,
}

fn emit(app: &AppHandle, pct: u32, step: &str) {
    let _ = app.emit(
        "install-progress",
        serde_json::json!({ "pct": pct, "step": step }),
    );
}

#[tauri::command]
fn default_install_dir() -> String {
    // %LOCALAPPDATA%\zro — per-user, no admin needed.
    dirs::data_local_dir()
        .map(|p| p.join("zro"))
        .unwrap_or_else(|| PathBuf::from("C:/zro"))
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
async fn pick_install_dir() -> Result<Option<String>, String> {
    let dir = rfd::AsyncFileDialog::new()
        .set_title("Choose where to install zro")
        .pick_folder()
        .await;
    Ok(dir.map(|d| d.path().to_string_lossy().to_string()))
}

#[tauri::command]
async fn install(app: AppHandle, dir: String, options: Options) -> Result<(), String> {
    let target = PathBuf::from(&dir);

    emit(&app, 5, "Preparing target directory");
    std::fs::create_dir_all(&target).map_err(|e| format!("cannot create {dir}: {e}"))?;

    // 1. download the payload
    emit(&app, 12, "Downloading zro");
    let bytes = download(&app, PAYLOAD_URL).await?;

    // 2. extract
    emit(&app, 60, "Extracting application files");
    extract_zip(&bytes, &target).map_err(|e| format!("extract failed: {e}"))?;

    let exe = target.join(EXE_NAME);
    if !exe.exists() {
        return Err(format!("{EXE_NAME} not found after extract"));
    }

    // 3. shortcuts
    if options.startmenu {
        emit(&app, 78, "Adding to Start menu");
        let start = dirs::data_dir()
            .map(|p| p.join("Microsoft/Windows/Start Menu/Programs/zro.lnk"));
        if let Some(lnk) = start {
            let _ = create_shortcut(&lnk, &exe);
        }
    }
    if options.desktop {
        emit(&app, 86, "Creating desktop shortcut");
        if let Some(desk) = dirs::desktop_dir() {
            let _ = create_shortcut(&desk.join("zro.lnk"), &exe);
        }
    }

    // 4. uninstaller: this binary doubles as it — copy ourselves into the
    // install dir; `uninstall.exe --uninstall` boots the themed uninstall UI.
    emit(&app, 92, "Installing uninstaller");
    let un_exe = target.join(UNINSTALL_NAME);
    if let Ok(me) = std::env::current_exe() {
        let _ = std::fs::copy(&me, &un_exe);
    }

    // 5. uninstall entry
    emit(&app, 96, "Registering uninstaller");
    register_uninstall(&target, &exe, &un_exe);

    emit(&app, 100, "Done");
    Ok(())
}

/// `zro Setup.exe --uninstall` (as `uninstall.exe` in the install dir) →
/// the same window runs the uninstall flow instead.
#[tauri::command]
fn install_mode() -> String {
    if std::env::args().any(|a| a == "--uninstall") {
        "uninstall".into()
    } else {
        "install".into()
    }
}

/// Where zro is installed — the uninstaller binary lives inside that dir.
#[tauri::command]
fn uninstall_info() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string()))
        .unwrap_or_default()
}

#[tauri::command]
async fn uninstall(app: AppHandle, purge: bool) -> Result<(), String> {
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = me
        .parent()
        .ok_or("cannot resolve install directory")?
        .to_path_buf();
    if !dir.join(EXE_NAME).exists() {
        return Err(format!("{EXE_NAME} not found next to the uninstaller — refusing to delete {}", dir.display()));
    }

    emit(&app, 10, "Removing shortcuts");
    if let Some(desk) = dirs::desktop_dir() {
        let _ = std::fs::remove_file(desk.join("zro.lnk"));
    }
    if let Some(start) = dirs::data_dir() {
        let _ = std::fs::remove_file(start.join("Microsoft/Windows/Start Menu/Programs/zro.lnk"));
    }

    emit(&app, 30, "Removing registry entries");
    unregister_uninstall();

    if purge {
        emit(&app, 45, "Deleting browsing data");
        // Roaming (settings/session) + Local (WebView2 profile) for zro's id.
        for base in [dirs::data_dir(), dirs::data_local_dir()] {
            if let Some(d) = base.map(|p| p.join("com.zro.browser")) {
                let _ = std::fs::remove_dir_all(&d);
            }
        }
    }

    emit(&app, 65, "Removing application files");
    // Delete everything except the running uninstaller (Windows won't let a
    // process delete its own exe); the leftover exe + dir go via a detached
    // shell once we exit.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p == me {
                continue;
            }
            let _ = if p.is_dir() {
                std::fs::remove_dir_all(&p)
            } else {
                std::fs::remove_file(&p)
            };
        }
    }

    emit(&app, 90, "Scheduling final cleanup");
    schedule_self_delete(&dir);

    emit(&app, 100, "Done");
    Ok(())
}

#[tauri::command]
fn launch_zro(dir: String) -> Result<(), String> {
    let exe = Path::new(&dir).join(EXE_NAME);
    std::process::Command::new(exe)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ── helpers ──────────────────────────────────────────────────────────────────

async fn download(app: &AppHandle, url: &str) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    let resp = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed (HTTP {})", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut got: u64 = 0;
    let mut out = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        out.extend_from_slice(&chunk);
        if total > 0 {
            // map download onto the 12–58% band of the overall bar
            let pct = 12 + (got as f64 / total as f64 * 46.0) as u32;
            emit(app, pct, "Downloading zro");
        }
    }
    Ok(out)
}

fn extract_zip(bytes: &[u8], dest: &Path) -> std::io::Result<()> {
    let reader = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(reader)?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        let Some(rel) = f.enclosed_name() else { continue };
        let outpath = dest.join(rel);
        if f.is_dir() {
            std::fs::create_dir_all(&outpath)?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out = std::fs::File::create(&outpath)?;
            std::io::copy(&mut f, &mut out)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn hidden(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
}
#[cfg(not(windows))]
fn hidden(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}

/// Create a .lnk via WScript.Shell (no extra crate).
#[cfg(windows)]
fn create_shortcut(lnk: &Path, target: &Path) -> Result<(), String> {
    let ps = format!(
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');\
         $s.TargetPath='{}';$s.WorkingDirectory='{}';$s.Save()",
        lnk.display(),
        target.display(),
        target.parent().unwrap_or(target).display(),
    );
    hidden(std::process::Command::new("powershell").args(["-NoProfile", "-Command", &ps]))
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| if s.success() { Ok(()) } else { Err("shortcut failed".into()) })
}
#[cfg(not(windows))]
fn create_shortcut(_lnk: &Path, _target: &Path) -> Result<(), String> {
    Ok(())
}

const UNINSTALL_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\zro";

/// Add the Programs-and-Features / Settings uninstall entry (HKCU).
#[cfg(windows)]
fn register_uninstall(install_dir: &Path, exe: &Path, un_exe: &Path) {
    let add = |name: &str, val: &str| {
        hidden(std::process::Command::new("reg").args([
            "add", UNINSTALL_KEY, "/v", name, "/d", val, "/f",
        ]))
        .status()
        .ok();
    };
    add("DisplayName", "zro");
    add("DisplayVersion", env!("CARGO_PKG_VERSION"));
    add("Publisher", "ThatQne");
    add("InstallLocation", &install_dir.to_string_lossy());
    add("DisplayIcon", &exe.to_string_lossy());
    add("UninstallString", &format!("\"{}\" --uninstall", un_exe.display()));
    hidden(std::process::Command::new("reg").args([
        "add", UNINSTALL_KEY, "/v", "NoModify", "/t", "REG_DWORD", "/d", "1", "/f",
    ]))
    .status()
    .ok();
}
#[cfg(not(windows))]
fn register_uninstall(_install_dir: &Path, _exe: &Path, _un_exe: &Path) {}

#[cfg(windows)]
fn unregister_uninstall() {
    hidden(std::process::Command::new("reg").args(["delete", UNINSTALL_KEY, "/f"]))
        .status()
        .ok();
}
#[cfg(not(windows))]
fn unregister_uninstall() {}

/// A running exe can't delete itself — hand the last rites to a detached
/// `cmd` that waits for us to exit, then removes the install dir.
#[cfg(windows)]
fn schedule_self_delete(dir: &Path) {
    let script = format!(
        "ping -n 3 127.0.0.1 >nul & rmdir /s /q \"{}\"",
        dir.display()
    );
    hidden(std::process::Command::new("cmd").args(["/c", &script]))
        .spawn()
        .ok();
}
#[cfg(not(windows))]
fn schedule_self_delete(_dir: &Path) {}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            default_install_dir,
            pick_install_dir,
            install,
            launch_zro,
            install_mode,
            uninstall_info,
            uninstall,
        ])
        .setup(|app| {
            // Center the compact installer window.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.center();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running zro installer");
}
