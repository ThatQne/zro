//! Cheap resource sensing and opt-in bounded timings; no URLs or page text.
use std::collections::{HashMap, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    LazyLock, Mutex,
};
use std::time::Instant;

static BACKGROUND_ALLOWED: AtomicBool = AtomicBool::new(true);

/// Keep at most one native heartbeat outstanding. Log only prolonged stalls;
/// no page URLs, text, or regular disk writes are collected.
pub(crate) fn watch_ui(app: tauri::AppHandle) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            let (tx, mut rx) = tokio::sync::oneshot::channel();
            if app
                .run_on_main_thread(move || {
                    let _ = tx.send(());
                })
                .is_err()
            {
                break;
            }
            if tokio::time::timeout(std::time::Duration::from_secs(5), &mut rx)
                .await
                .is_ok()
            {
                continue;
            }
            let state = app.state::<Mutex<super::BrowserState>>();
            let summary = match state.try_lock() {
                Ok(s) => format!(
                    "tabs={} suspended={} hidden={} resizing={}",
                    s.tabs.len(),
                    s.suspended.len(),
                    s.page_hidden,
                    s.resizing
                ),
                Err(_) => "browser_state_locked=true".into(),
            };
            let memory = memory_sample()
                .map(|s| format!("available_mb={} total_mb={}", s.available_mb, s.total_mb))
                .unwrap_or_else(|_| "memory_unavailable".into());
            if let Ok(dir) = app.path().app_local_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let path = dir.join("hang.log");
                let append = std::fs::metadata(&path)
                    .map(|m| m.len() < 131072)
                    .unwrap_or(true);
                if let Ok(mut file) = std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .append(append)
                    .truncate(!append)
                    .open(path)
                {
                    use std::io::Write;
                    let timestamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let _ = writeln!(
                        file,
                        "{timestamp} version={} ui_stall_over_5s {summary} {memory}",
                        env!("CARGO_PKG_VERSION")
                    );
                }
            }
            // A blocked UI gets no additional queued probes or repeated writes.
            if rx.await.is_err() {
                break;
            }
        }
    });
}
static TRACING: AtomicBool = AtomicBool::new(false);
static TIMINGS: LazyLock<Mutex<HashMap<&'static str, VecDeque<f64>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(serde::Serialize)]
pub struct ResourceSample {
    pub total_mb: u64,
    pub available_mb: u64,
}

/// Constant-size OS query, not a scan of all processes.
pub(crate) fn memory_sample() -> Result<ResourceSample, String> {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status = MEMORYSTATUSEX::default();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        GlobalMemoryStatusEx(&mut status).map_err(|e| e.to_string())?;
        return Ok(ResourceSample {
            total_mb: status.ullTotalPhys / 1048576,
            available_mb: status.ullAvailPhys / 1048576,
        });
    }
    #[cfg(not(windows))]
    {
        Err("memory pressure sampling unavailable".into())
    }
}

#[tauri::command]
pub fn get_resource_sample() -> Result<ResourceSample, String> {
    memory_sample()
}

#[tauri::command]
pub fn set_background_budget(app: tauri::AppHandle, allowed: bool, release: bool) {
    let previous = BACKGROUND_ALLOWED.swap(allowed, Ordering::Relaxed);
    if release {
        super::tabs::release_spare(&app);
    } else if !previous {
        super::tabs::ensure_spare(&app);
    }
}

pub(crate) fn background_allowed() -> bool {
    BACKGROUND_ALLOWED.load(Ordering::Relaxed)
        && memory_sample()
            .map(|s| {
                s.available_mb >= 1536
                    && s.available_mb.saturating_mul(100) >= s.total_mb.saturating_mul(20)
            })
            .unwrap_or(false)
}

pub(crate) struct Span {
    name: &'static str,
    start: Option<Instant>,
}
pub(crate) fn span(name: &'static str) -> Span {
    Span {
        name,
        start: TRACING.load(Ordering::Relaxed).then(Instant::now),
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        if let Some(start) = self.start {
            if !TRACING.load(Ordering::Relaxed) {
                return;
            }
            let mut timings = TIMINGS.lock().unwrap();
            let samples = timings.entry(self.name).or_default();
            if samples.len() == 256 {
                samples.pop_front();
            }
            samples.push_back(start.elapsed().as_secs_f64() * 1000.0);
        }
    }
}

#[tauri::command]
pub fn set_performance_tracing(enabled: bool) {
    TRACING.store(enabled, Ordering::Relaxed);
    if enabled {
        TIMINGS.lock().unwrap().clear();
    }
}

#[derive(serde::Serialize)]
pub struct TimingRow {
    name: String,
    samples: usize,
    p50_ms: f64,
    p95_ms: f64,
    max_ms: f64,
}
#[tauri::command]
pub fn get_performance_trace() -> Vec<TimingRow> {
    let timings = TIMINGS.lock().unwrap();
    let mut rows: Vec<_> = timings
        .iter()
        .filter_map(|(name, q)| {
            if q.is_empty() {
                return None;
            }
            let mut v: Vec<_> = q.iter().copied().collect();
            v.sort_by(f64::total_cmp);
            Some(TimingRow {
                name: name.to_string(),
                samples: v.len(),
                p50_ms: v[(v.len() - 1) / 2],
                p95_ms: v[((v.len() as f64 * 0.95).ceil() as usize).saturating_sub(1)],
                max_ms: v[v.len() - 1],
            })
        })
        .collect();
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    rows
}
