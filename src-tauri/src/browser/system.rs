//! System-level utilities: JS error funnel, focus, search suggestions,
//! privacy toggles and memory stats.

use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MemoryInfo {
    pub total_ram_mb: u64,
    pub used_ram_mb: u64,
    pub process_mb: u64,
    /// Sum of the PRIVATE footprint of all msedgewebview2.exe children — the
    /// tab engines live there, not under zro's own pid. Private bytes, not
    /// working set: working set double-counts shared memory per process.
    pub webview_mb: u64,
    /// Whole-machine CPU load, 0-100. Needs two samples; first call reads 0.
    pub cpu_pct: f32,
    pub zro_cpu_pct: f32,
}

/// Frontend error funnel — JS console isn't visible in the dev terminal.
#[tauri::command]
pub async fn log_js(msg: String) -> Result<(), String> {
    eprintln!("[js] {msg}");
    Ok(())
}

/// Wipe a deleted profile's WebView2 user data folder. Fails while its
/// environment still holds file locks (a tab used it this session) — the
/// frontend surfaces that as "restart zro to finish removing".
#[tauri::command]
pub async fn delete_profile_data(app: AppHandle, profile: String) -> Result<(), String> {
    let clean: String = profile
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if clean.is_empty() || clean == "default" {
        return Err("can't delete the default profile".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("profiles")
        .join(clean);
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

/// On dual-GPU laptops Windows may default WebView2's renderer to the weak
/// integrated GPU for battery life — invisible everywhere except heavy
/// WebGL/3D/video pages, which is exactly the "Roblox is slow" symptom.
/// This is the same per-exe opt-in game launchers use (Settings > Graphics),
/// set here instead so the user never has to find that page. Chromium-flag
/// routes (additionalBrowserArguments) are off the table — they silently
/// break navigation in this app (see AGENTS notes) — so this goes through
/// Windows' own DXGI adapter-preference registry key, invisible to WebView2.
#[cfg(windows)]
pub fn prefer_high_performance_gpu() {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_SZ,
    };

    let Ok(exe) = std::env::current_exe() else { return };
    let exe_path = exe.to_string_lossy().to_string();

    unsafe {
        let subkey = HSTRING::from("Software\\Microsoft\\DirectX\\UserGpuPreference");
        let mut hkey = HKEY::default();
        let opened = RegCreateKeyW(HKEY_CURRENT_USER, &subkey, &mut hkey);
        if opened.0 != 0 {
            return;
        }
        let name = HSTRING::from(exe_path);
        // "2" = high performance (discrete GPU); NUL-terminated UTF-16 for REG_SZ.
        let data: Vec<u16> = "GpuPreference=2;".encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 2);
        let _ = RegSetValueExW(hkey, &name, None, REG_SZ, Some(bytes));
        let _ = RegCloseKey(hkey);
    }
}

#[cfg(not(windows))]
pub fn prefer_high_performance_gpu() {}

/// Keep the host process responsive while a game saturates the machine.
/// EVERYTHING WebView2 does funnels through this process's UI-thread message
/// pump — input, paint, every deferred WebResourceRequested callback (which
/// gates script/xhr/fetch, i.e. streaming-audio chunks). A game at 100% CPU
/// starves a NORMAL-priority pump: chrome lags, deferred fetches stall,
/// audio underruns. ABOVE_NORMAL fixes the latency without hurting the game —
/// the pump's work is microseconds-sized bursts, priority only decides who
/// runs FIRST, not who runs more.
#[cfg(windows)]
pub fn boost_process_priority() {
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentThread, SetPriorityClass, SetThreadPriority,
        ABOVE_NORMAL_PRIORITY_CLASS, THREAD_PRIORITY_ABOVE_NORMAL,
    };
    unsafe {
        let _ = SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS);
        // The UI/message-pump thread specifically — it services every COM
        // callback for every webview.
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
    }
}

#[cfg(not(windows))]
pub fn boost_process_priority() {}

/// Give keyboard focus back to the browser UI webview (URL bar etc.).
#[tauri::command]
pub async fn focus_main(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview("main") {
        wv.set_focus().map_err(|e: tauri::Error| e.to_string())?;
    }
    Ok(())
}

/// Google search suggestions (fetched Rust-side — the UI origin can't call
/// the endpoint directly because of CORS).
#[tauri::command]
pub async fn search_suggest(q: String) -> Result<Vec<String>, String> {
    let q = q.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = client
        .get("https://suggestqueries.google.com/complete/search")
        .query(&[("client", "firefox"), ("q", q.as_str())])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(v[1]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(String::from))
                .take(6)
                .collect()
        })
        .unwrap_or_default())
}

// ── Privacy / data ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn clear_browsing_data(app: AppHandle) -> Result<(), String> {
    for (_, wv) in app.webviews() {
        let _ = wv.clear_all_browsing_data();
    }
    Ok(())
}

/// Runs inside the active page — the only per-site path WebView2 offers for
/// DOM storage (its ClearBrowsingData API is profile-wide).
const CLEAR_SITE_STORAGE_JS: &str = r#"(function(){
  try{localStorage.clear()}catch(e){}
  try{sessionStorage.clear()}catch(e){}
  try{indexedDB.databases&&indexedDB.databases().then(ds=>ds.forEach(d=>d.name&&indexedDB.deleteDatabase(d.name)))}catch(e){}
  try{caches.keys().then(ks=>ks.forEach(k=>caches.delete(k)))}catch(e){}
})();"#;

/// Selective clearing: scope = "site" (active page) | "all", kinds ⊆
/// {"cookies","cache","storage"}. Per-site cache isn't supported by WebView2
/// — the frontend greys that combination out.
#[tauri::command]
pub async fn clear_site_data(
    app: AppHandle,
    scope: String,
    kinds: Vec<String>,
    url: Option<String>,
) -> Result<(), String> {
    let all = scope == "all";
    for kind in &kinds {
        match (kind.as_str(), all) {
            ("cookies", true) => super::cookies::delete_all_cookies(&app).await?,
            ("cookies", false) => {
                let list = super::cookies::cookies_for(&app, url.clone()).await?;
                for c in list {
                    super::cookies::delete_cookie_inner(&app, c.name, c.domain, c.path).await?;
                }
            }
            ("cache", true) => {
                clear_profile_data(&app, ProfileDataKind::Cache).await?;
            }
            ("storage", true) => {
                clear_profile_data(&app, ProfileDataKind::DomStorage).await?;
            }
            ("storage", false) => {
                if let Some(wv) = super::active_webview(&app) {
                    wv.eval(CLEAR_SITE_STORAGE_JS).map_err(|e: tauri::Error| e.to_string())?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ProfileDataKind {
    Cache,
    DomStorage,
}

/// Profile-wide ClearBrowsingData for one data family (Windows/WebView2).
#[cfg(windows)]
async fn clear_profile_data(app: &AppHandle, kind: ProfileDataKind) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_DOM_STORAGE,
        COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
    };
    let wv = super::active_webview(app).ok_or("no active tab")?;
    let kinds = match kind {
        ProfileDataKind::Cache => COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE.0,
        ProfileDataKind::DomStorage => COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_DOM_STORAGE.0,
    };
    clear_data_kinds(wv, kinds).await
}

/// The COM plumbing shared by every profile-wide ClearBrowsingData call.
#[cfg(windows)]
async fn clear_data_kinds(wv: tauri::Webview, kinds_raw: i32) -> Result<(), String> {
    use webview2_com::ClearBrowsingDataCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile2, ICoreWebView2_13, COREWEBVIEW2_BROWSING_DATA_KINDS,
    };
    use windows_core::Interface;

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    wv.with_webview(move |pwv| unsafe {
        let data_kinds = COREWEBVIEW2_BROWSING_DATA_KINDS(kinds_raw);
        let tx2 = tx.clone();
        let r = (|| -> windows_core::Result<()> {
            let profile = pwv
                .controller()
                .CoreWebView2()?
                .cast::<ICoreWebView2_13>()?
                .Profile()?;
            let p2 = profile.cast::<ICoreWebView2Profile2>()?;
            let handler = ClearBrowsingDataCompletedHandler::create(Box::new(
                move |err: windows_core::Result<()>| {
                    let _ = tx2.send(err.map_err(|e| e.to_string()));
                    Ok(())
                },
            ));
            p2.ClearBrowsingData(data_kinds, &handler)?;
            Ok(())
        })();
        if let Err(e) = r {
            let _ = tx.send(Err(e.to_string()));
        }
    })
    .map_err(|e| e.to_string())?;

    tokio::task::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "clear timed out".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(windows))]
async fn clear_profile_data(_app: &AppHandle, _kind: ProfileDataKind) -> Result<(), String> {
    Err("only supported on Windows".into())
}

// ── Cache trim ────────────────────────────────────────────────────────────────
// WebView2 has no cache-size cap — the disk cache grows without bound (2 days
// of browsing ≈ 900 MB). This trims JUST the rebuildable parts: HTTP disk
// cache + service-worker CacheStorage. Cookies, logins, history and site
// storage (localStorage/IndexedDB) are untouched — pages simply re-download
// their assets on next visit.

/// The default profile's WebView2 user data folder, if it exists yet.
fn default_udf(app: &AppHandle) -> Option<std::path::PathBuf> {
    let data = app.path().app_data_dir().ok();
    let local = app.path().app_local_data_dir().ok();
    for base in [data, local].into_iter().flatten() {
        let udf = base.join("EBWebView");
        if udf.is_dir() {
            return Some(udf);
        }
    }
    None
}

async fn udf_size(app: &AppHandle) -> u64 {
    let Some(udf) = default_udf(app) else { return 0 };
    tokio::task::spawn_blocking(move || dir_size(&udf))
        .await
        .unwrap_or(0)
}

#[cfg(windows)]
async fn clear_default_cache(app: &AppHandle) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE,
        COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
    };
    // Through the always-alive UI webview — same profile as every
    // default-profile tab, works even with zero tabs open
    let wv = app.get_webview("main").ok_or("no main webview")?;
    clear_data_kinds(
        wv,
        COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE.0
            | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE.0,
    )
    .await
}

#[cfg(not(windows))]
async fn clear_default_cache(_app: &AppHandle) -> Result<(), String> {
    Err("only supported on Windows".into())
}

/// Manual trim (Usage panel button). Returns MB actually freed on disk.
#[tauri::command]
pub async fn trim_cache(app: AppHandle) -> Result<u64, String> {
    let before = udf_size(&app).await;
    clear_default_cache(&app).await?;
    // Chromium deletes the cache files asynchronously — give it a beat
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let after = udf_size(&app).await;
    Ok(before.saturating_sub(after) / 1024 / 1024)
}

/// Cache sweep: once the browsing data crosses the cap, trim it. Keeps the
/// "900 MB after 2 days" growth permanently bounded without user attention.
/// Startup-only used to leave week-long sessions unbounded — now it re-checks
/// every 6 hours (skipped while the machine-idle freeze is engaged).
pub fn auto_trim_cache(app: &AppHandle) {
    const CAP_MB: u64 = 512;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Off the startup path — restores + spare build come first
        tokio::time::sleep(std::time::Duration::from_secs(90)).await;
        loop {
            if !crate::browser::tabs::is_idle_frozen() {
                let size_mb = udf_size(&app).await / 1024 / 1024;
                if size_mb > CAP_MB {
                    match trim_cache(app.clone()).await {
                        Ok(freed) => eprintln!(
                            "[cache] auto-trim: {size_mb} MB > {CAP_MB} MB cap, freed {freed} MB"
                        ),
                        Err(e) => eprintln!("[cache] auto-trim failed: {e}"),
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
        }
    });
}

// ── Durable app-state snapshot ────────────────────────────────────────────────
// The React stores (tabs, history, folders, settings, extensions, AI chat) used
// to live ONLY in WebView2 localStorage. That leveldb gets discarded WHOLE when
// it corrupts — an unclean shutdown, or two processes touching the default
// profile during a default-browser "open localhost" launch — taking every tab
// and all history with it, with no backup and no restore. Mirror each store to
// a plain JSON file in the app data dir: a localStorage rebuild can never lose
// the session again, and the file is the source of truth on load.

fn session_path(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    // The name comes from our own stores, but slug it anyway so it can never
    // escape the data dir (path traversal via a crafted key).
    let slug: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("store-{slug}.json")))
}

/// Persist one store's serialized state. Atomic replace (temp + rename) so a
/// crash mid-write can never leave a truncated, unparseable snapshot behind.
#[tauri::command]
pub async fn save_session(app: AppHandle, name: String, data: String) -> Result<(), String> {
    let path = session_path(&app, &name)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Read one store's snapshot back. `None` when it was never written (fresh
/// install) — the frontend then falls back to any legacy localStorage copy.
#[tauri::command]
pub async fn load_session(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = session_path(&app, &name)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Toggle WebView2 password autosave + autofill on every open tab.
/// Credentials live in the WebView2 user-data folder, encrypted at rest via
/// Windows DPAPI (same storage Edge uses).
#[cfg(windows)]
#[tauri::command]
pub async fn set_password_autosave(app: AppHandle, enabled: bool) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Profile6, ICoreWebView2_13};
    use windows_core::Interface;

    for (label, wv) in app.webviews() {
        if label == "main" { continue; }
        let _ = wv.with_webview(move |pwv| unsafe {
            let controller = pwv.controller();
            if let Ok(core) = controller.CoreWebView2() {
                if let Ok(wv13) = core.cast::<ICoreWebView2_13>() {
                    if let Ok(profile) = wv13.Profile() {
                        if let Ok(p6) = profile.cast::<ICoreWebView2Profile6>() {
                            let _ = p6.SetIsPasswordAutosaveEnabled(enabled);
                            let _ = p6.SetIsGeneralAutofillEnabled(enabled);
                        }
                    }
                }
            }
        });
    }
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn set_password_autosave(_app: AppHandle, _enabled: bool) -> Result<(), String> {
    Ok(())
}

/// Windows Hello verification (fingerprint / face / PIN) for the incognito
/// lock. Uses the Win32 interop factory — the plain WinRT call needs a
/// CoreWindow and fails in desktop apps. Returns false on user cancel,
/// Err when Hello isn't configured (frontend falls back to the passcode).
#[cfg(windows)]
#[tauri::command]
pub async fn verify_identity(app: AppHandle, reason: String) -> Result<bool, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier,
    };
    use windows::Win32::System::WinRT::{
        IUserConsentVerifierInterop, RoInitialize, RO_INIT_MULTITHREADED,
    };
    use windows_core::HSTRING;
    use windows_future::IAsyncOperation;

    // HWND is a raw pointer (not Send) — cross the thread boundary as isize
    let hwnd_raw = app
        .get_window("main")
        .ok_or("no main window")?
        .hwnd()
        .map_err(|e| e.to_string())?
        .0 as isize;

    tokio::task::spawn_blocking(move || unsafe {
        let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);
        let _ = RoInitialize(RO_INIT_MULTITHREADED); // idempotent per thread
        let interop = windows_core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
            .map_err(|e| e.to_string())?;
        let op: IAsyncOperation<UserConsentVerificationResult> = interop
            .RequestVerificationForWindowAsync(hwnd, &HSTRING::from(reason))
            .map_err(|e| e.to_string())?;
        let result = op.get().map_err(|e| e.to_string())?;
        match result {
            UserConsentVerificationResult::Verified => Ok(true),
            UserConsentVerificationResult::Canceled
            | UserConsentVerificationResult::RetriesExhausted => Ok(false),
            // Not configured / no hardware / disabled by policy → let the
            // frontend fall back to the passcode
            other => Err(format!("windows hello unavailable ({})", other.0)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn verify_identity(_app: AppHandle, _reason: String) -> Result<bool, String> {
    Err("only supported on Windows".into())
}

// ── Disk usage ────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct DiskItem {
    pub name: String,
    pub bytes: u64,
}

fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|e| {
            let Ok(meta) = e.metadata() else { return 0 };
            if meta.is_dir() { dir_size(&e.path()) } else { meta.len() }
        })
        .sum()
}

/// On-disk footprint of the browser's stored data: WebView2 browsing data
/// (cache, cookies, site storage, service workers) per profile, extensions,
/// and the app's own files (AI memory, session cookies).
#[tauri::command]
pub async fn get_disk_usage(app: tauri::AppHandle) -> Result<Vec<DiskItem>, String> {
    use tauri::Manager;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let local = app.path().app_local_data_dir().ok();

    tokio::task::spawn_blocking(move || {
        let mut out: Vec<DiskItem> = Vec::new();

        // Default profile's WebView2 user data folder — tauri puts EBWebView
        // under app data or local app data depending on version
        for base in [Some(&data), local.as_ref()].into_iter().flatten() {
            let udf = base.join("EBWebView");
            if udf.is_dir() {
                out.push(DiskItem { name: "Browsing data (cache · cookies · storage)".into(), bytes: dir_size(&udf) });
                break;
            }
        }

        // Named profiles — each is its own user data folder
        let profiles = data.join("profiles");
        if let Ok(entries) = std::fs::read_dir(&profiles) {
            for e in entries.flatten() {
                if e.path().is_dir() {
                    out.push(DiskItem {
                        name: format!("Profile: {}", e.file_name().to_string_lossy()),
                        bytes: dir_size(&e.path()),
                    });
                }
            }
        }

        let ext = data.join("extensions");
        if ext.is_dir() {
            out.push(DiskItem { name: "Extensions".into(), bytes: dir_size(&ext) });
        }
        for (file, label) in [
            ("ai_memory.json", "AI memory"),
            ("session_cookies.bin", "Session cookies"),
        ] {
            if let Ok(meta) = std::fs::metadata(data.join(file)) {
                out.push(DiskItem { name: label.into(), bytes: meta.len() });
            }
        }

        out.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// One live System, kept across calls — CPU usage is a delta between two
// refreshes, so a fresh System::new_all() per call always reported 0%.
static SYS: std::sync::OnceLock<std::sync::Mutex<sysinfo::System>> = std::sync::OnceLock::new();

/// Private commit of one process — what Chrome's task manager calls "memory
/// footprint". Working set double-counts shared DLLs/memory across the dozens
/// of Chromium processes, so summing it reports absurd totals (2.6 GB for a
/// handful of tabs). Private bytes is the honest per-process number.
#[cfg(windows)]
fn private_mb(pid: u32) -> u64 {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return 0 };
        let mut c = PROCESS_MEMORY_COUNTERS_EX::default();
        c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = K32GetProcessMemoryInfo(h, &mut c as *mut _ as *mut PROCESS_MEMORY_COUNTERS, c.cb);
        let _ = CloseHandle(h);
        if ok.as_bool() { c.PrivateUsage as u64 / 1024 / 1024 } else { 0 }
    }
}

#[cfg(not(windows))]
fn private_mb(_pid: u32) -> u64 { 0 }

/// All msedgewebview2.exe processes in zro's own process tree. Walking parent
/// links catches renderers (parented to the browser broker, which is parented
/// to us) without counting other apps' webviews. Returns (pid, chromium
/// process type from the command line — "renderer", "gpu-process", …).
fn webview_pids(sys: &sysinfo::System) -> Vec<(u32, String)> {
    let Ok(me) = sysinfo::get_current_pid() else { return vec![] };
    let mut ours: std::collections::HashSet<sysinfo::Pid> = std::collections::HashSet::new();
    ours.insert(me);
    // Two passes: broker (parent = zro) first, then its children.
    for _ in 0..2 {
        for (child, proc) in sys.processes() {
            if let Some(parent) = proc.parent() {
                if ours.contains(&parent) {
                    ours.insert(*child);
                }
            }
        }
    }
    sys.processes()
        .iter()
        .filter(|(child, proc)| {
            **child != me
                && ours.contains(child)
                && proc.name().to_string_lossy().to_ascii_lowercase().contains("webview2")
        })
        .map(|(child, proc)| {
            let kind = proc
                .cmd()
                .iter()
                .find_map(|a| a.to_string_lossy().strip_prefix("--type=").map(String::from))
                .unwrap_or_else(|| "browser".into());
            (child.as_u32(), kind)
        })
        .collect()
}

#[tauri::command]
pub async fn get_memory_info() -> Result<MemoryInfo, String> {
    use sysinfo::{ProcessesToUpdate, System};
    let sys = SYS.get_or_init(|| std::sync::Mutex::new(System::new_all()));
    let mut sys = sys.lock().map_err(|e| e.to_string())?;
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let total = sys.total_memory() / 1024 / 1024;
    let used = sys.used_memory() / 1024 / 1024;
    let cpu_pct = sys.global_cpu_usage();

    let pid = sysinfo::get_current_pid().map_err(|e| e.to_string())?;
    let zro_cpu = sys.process(pid).map(|p| p.cpu_usage()).unwrap_or(0.0);
    let proc_mb = private_mb(pid.as_u32());
    let webview_mb: u64 = webview_pids(&sys).iter().map(|(p, _)| private_mb(*p)).sum();

    Ok(MemoryInfo {
        total_ram_mb: total,
        used_ram_mb: used,
        process_mb: proc_mb,
        webview_mb,
        cpu_pct,
        zro_cpu_pct: zro_cpu,
    })
}

// ── Per-process / per-tab memory breakdown ────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ProcRow {
    pub pid: u32,
    /// "browser" | "renderer" | "gpu" | "utility" | …
    pub kind: String,
    /// Private footprint, MB
    pub mb: u64,
    /// Page URLs of frames hosted by this process (renderers only) — the
    /// frontend matches these against open tabs
    pub sources: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct ProcessBreakdown {
    pub procs: Vec<ProcRow>,
    /// Tab ids whose renderer is currently frozen (TrySuspend)
    pub suspended: Vec<String>,
}

/// WebView2's own process list with frame attribution: which renderer hosts
/// which page. Asked through the environment of the main UI webview — every
/// default-profile tab shares it. Named-profile renderers aren't in this
/// environment; they still show up via the process-tree pass, just without
/// page attribution.
#[cfg(windows)]
async fn webview_process_infos(app: &AppHandle) -> Vec<(u32, i32, Vec<String>)> {
    use webview2_com::GetProcessExtendedInfosCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment13, ICoreWebView2ProcessExtendedInfoCollection, ICoreWebView2_2,
    };
    use webview2_com::take_pwstr;
    use windows_core::Interface;

    let Some(wv) = app.get_webview("main") else { return vec![] };
    let (tx, rx) = std::sync::mpsc::channel::<Vec<(u32, i32, Vec<String>)>>();
    let send_ok = wv.with_webview(move |pwv| unsafe {
        let r = (|| -> windows_core::Result<()> {
            let env = pwv
                .controller()
                .CoreWebView2()?
                .cast::<ICoreWebView2_2>()?
                .Environment()?;
            let env13 = env.cast::<ICoreWebView2Environment13>()?;
            let tx2 = tx.clone();
            let handler = GetProcessExtendedInfosCompletedHandler::create(Box::new(
                move |err: windows_core::Result<()>,
                      coll: Option<ICoreWebView2ProcessExtendedInfoCollection>| {
                    let mut out: Vec<(u32, i32, Vec<String>)> = Vec::new();
                    if let (Ok(()), Some(coll)) = (err, coll) {
                        let mut n = 0u32;
                        let _ = coll.Count(&mut n);
                        for i in 0..n {
                            let Ok(info) = coll.GetValueAtIndex(i) else { continue };
                            let Ok(pi) = info.ProcessInfo() else { continue };
                            let mut pid = 0i32;
                            let _ = pi.ProcessId(&mut pid);
                            let mut kind = Default::default();
                            let _ = pi.Kind(&mut kind);
                            let mut sources = Vec::new();
                            if let Ok(frames) = info.AssociatedFrameInfos() {
                                if let Ok(iter) = frames.GetIterator() {
                                    let mut has = windows_core::BOOL::default();
                                    let _ = iter.HasCurrent(&mut has);
                                    while has.as_bool() {
                                        if let Ok(fi) = iter.GetCurrent() {
                                            let mut src = windows_core::PWSTR::null();
                                            if fi.Source(&mut src).is_ok() {
                                                let s = take_pwstr(src);
                                                if !s.is_empty() {
                                                    sources.push(s);
                                                }
                                            }
                                        }
                                        if iter.MoveNext(&mut has).is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            out.push((pid as u32, kind.0, sources));
                        }
                    }
                    let _ = tx2.send(out);
                    Ok(())
                },
            ));
            env13.GetProcessExtendedInfos(&handler)?;
            Ok(())
        })();
        if r.is_err() {
            let _ = tx.send(vec![]);
        }
    });
    if send_ok.is_err() {
        return vec![];
    }
    tokio::task::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[cfg(not(windows))]
async fn webview_process_infos(_app: &AppHandle) -> Vec<(u32, i32, Vec<String>)> {
    vec![]
}

/// What's actually eating RAM: every webview process with its private
/// footprint, renderers attributed to the pages (→ tabs) they host.
#[tauri::command]
pub async fn get_process_breakdown(app: AppHandle) -> Result<ProcessBreakdown, String> {
    let com = webview_process_infos(&app).await;

    // Process-tree pass (covers named-profile environments too)
    let tree: Vec<(u32, String)> = {
        use sysinfo::{ProcessesToUpdate, System};
        let sys = SYS.get_or_init(|| std::sync::Mutex::new(System::new_all()));
        let mut sys = sys.lock().map_err(|e| e.to_string())?;
        sys.refresh_processes(ProcessesToUpdate::All, true);
        webview_pids(&sys)
    };

    fn kind_name(k: i32) -> &'static str {
        match k {
            0 => "browser",
            1 => "renderer",
            2 => "utility",
            3 => "sandbox",
            4 => "gpu",
            _ => "plugin",
        }
    }

    let mut procs: Vec<ProcRow> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (pid, kind, sources) in com {
        seen.insert(pid);
        procs.push(ProcRow { pid, kind: kind_name(kind).into(), mb: private_mb(pid), sources });
    }
    for (pid, kind) in tree {
        if seen.insert(pid) {
            // cmdline types: "renderer", "gpu-process", "utility", "crashpad-handler"
            let kind = match kind.as_str() {
                "gpu-process" => "gpu".into(),
                "crashpad-handler" => "crashpad".into(),
                k => k.to_string(),
            };
            procs.push(ProcRow { pid, kind, mb: private_mb(pid), sources: vec![] });
        }
    }
    procs.sort_by(|a, b| b.mb.cmp(&a.mb));

    // Frozen tabs: suspended labels → owning tab ids (the spare has no owner)
    let suspended = {
        let state = app.state::<std::sync::Mutex<super::BrowserState>>();
        let s = state.lock().map_err(|e| e.to_string())?;
        s.suspended
            .iter()
            .filter_map(|label| s.label_owner.get(label).cloned())
            .collect()
    };

    Ok(ProcessBreakdown { procs, suspended })
}
