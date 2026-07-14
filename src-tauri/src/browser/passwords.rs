//! Read-only viewer for WebView2's own saved passwords — the `chrome://passwords`
//! equivalent for zro.
//!
//! WebView2 (Chromium) stores logins in a SQLite database, "Login Data", inside
//! the user-data folder. Each `password_value` is AES-256-GCM encrypted with a
//! key that lives — itself DPAPI-wrapped — in the profile's "Local State" JSON.
//! Both the DPAPI unwrap and the whole store are scoped to the current Windows
//! user, so nothing here can read another account's passwords.
//!
//! This module is deliberately READ-ONLY. Deleting a row means writing to the
//! same SQLite file WebView2 holds open — a good way to corrupt the user's
//! password store — so we never open it for writing. The DB is opened
//! `immutable=1` (SQLite skips all locking, safe to read while WebView2 has it
//! open) against a snapshot URI.

#[cfg(windows)]
use std::path::{Path, PathBuf};

use serde::Serialize;

/// One saved login. `password` is only populated by `reveal_password` — the
/// list command leaves it empty so plaintext is never shipped unasked.
#[derive(Serialize, Clone)]
pub struct SavedPassword {
    /// Stable key for reveal: `origin\u{1}username` (origin_url can repeat).
    pub id: String,
    pub origin: String,
    pub username: String,
    pub password: String,
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut out = CRYPT_INTEGER_BLOB::default();
        if CryptUnprotectData(&input, None, None, None, None, 0, &mut out).is_err()
            || out.pbData.is_null()
        {
            return None;
        }
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
        Some(bytes)
    }
}

/// EBWebView user-data root. Tauri points WebView2 at the app's local-data dir.
#[cfg(windows)]
fn ebwebview_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let base = app.path().app_local_data_dir().ok()?;
    let dir = base.join("EBWebView");
    dir.is_dir().then_some(dir)
}

/// The AES-256 key that encrypts every `v10` password blob, recovered from
/// Local State (base64 → strip the "DPAPI" prefix → CryptUnprotectData).
#[cfg(windows)]
fn master_key(ebwebview: &Path) -> Option<Vec<u8>> {
    use base64::Engine;
    let raw = std::fs::read(ebwebview.join("Local State")).ok()?;
    let ls: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let b64 = ls.get("os_crypt")?.get("encrypted_key")?.as_str()?;
    let mut key = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if key.starts_with(b"DPAPI") {
        key.drain(0..5);
    }
    dpapi_unprotect(&key)
}

/// Decrypt one `password_value` blob. Chromium's modern format is
/// `"v10"|"v11" ‖ nonce(12) ‖ ciphertext ‖ tag(16)` under AES-256-GCM; very old
/// entries are a bare DPAPI blob.
#[cfg(windows)]
fn decrypt_value(blob: &[u8], key: &[u8]) -> Option<String> {
    if blob.len() > 3 && (&blob[0..3] == b"v10" || &blob[0..3] == b"v11") {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Nonce};
        if blob.len() < 3 + 12 + 16 {
            return None;
        }
        let cipher = Aes256Gcm::new_from_slice(key).ok()?;
        let nonce = Nonce::from_slice(&blob[3..15]);
        let pt = cipher.decrypt(nonce, &blob[15..]).ok()?;
        return String::from_utf8(pt).ok();
    }
    // Pre-v10: the whole blob is DPAPI-protected plaintext.
    dpapi_unprotect(blob).and_then(|b| String::from_utf8(b).ok())
}

/// Read (origin, username, password_blob) from the Login Data DB without
/// disturbing WebView2's own handle: copy nothing, open the file `immutable`
/// and read-only so SQLite performs no locking.
#[cfg(windows)]
fn read_logins(ebwebview: &Path) -> Result<Vec<(String, String, Vec<u8>)>, String> {
    use rusqlite::OpenFlags;
    let db = ebwebview.join("Default").join("Login Data");
    if !db.exists() {
        return Ok(Vec::new());
    }
    // file: URI needs forward slashes; immutable=1 => no locks, safe live read.
    let uri = format!("file:{}?immutable=1", db.to_string_lossy().replace('\\', "/"));
    let conn = rusqlite::Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT origin_url, username_value, password_value FROM logins ORDER BY origin_url")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        if let Ok(t) = row {
            out.push(t);
        }
    }
    Ok(out)
}

/// Tidy an origin_url for display: scheme + host, no path/query.
fn pretty_origin(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| url.to_string())
}

fn make_id(origin: &str, username: &str) -> String {
    format!("{origin}\u{1}{username}")
}

/// List saved logins — origin + username only, NO plaintext. The frontend
/// searches/filters this and calls `reveal_password` per entry on demand.
#[cfg(windows)]
#[tauri::command]
pub async fn list_passwords(app: tauri::AppHandle) -> Result<Vec<SavedPassword>, String> {
    let Some(dir) = ebwebview_dir(&app) else {
        return Ok(Vec::new());
    };
    let logins = read_logins(&dir)?;
    Ok(logins
        .into_iter()
        .filter(|(_, u, _)| !u.is_empty())
        .map(|(origin, username, _)| SavedPassword {
            id: make_id(&origin, &username),
            origin: pretty_origin(&origin),
            username,
            password: String::new(),
        })
        .collect())
}

/// Decrypt and return one saved password, matched by its `id`. Runs only when
/// the user explicitly reveals or copies that entry.
#[cfg(windows)]
#[tauri::command]
pub async fn reveal_password(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let Some(dir) = ebwebview_dir(&app) else {
        return Err("no user-data folder".into());
    };
    let key = master_key(&dir).ok_or("could not recover the encryption key")?;
    for (origin, username, blob) in read_logins(&dir)? {
        if make_id(&origin, &username) == id {
            return decrypt_value(&blob, &key).ok_or_else(|| "decrypt failed".to_string());
        }
    }
    Err("no such saved password".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn list_passwords(_app: tauri::AppHandle) -> Result<Vec<SavedPassword>, String> {
    Ok(Vec::new())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn reveal_password(_app: tauri::AppHandle, _id: String) -> Result<String, String> {
    Err("only supported on Windows".into())
}
