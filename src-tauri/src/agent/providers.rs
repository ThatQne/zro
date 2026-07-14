//! AI providers: ollama / OpenAI-compatible chat loops (streaming, with the
//! in-page tool set) and the local mz-code agent binary.

use std::time::Duration;
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

use super::tools::{is_parallel_safe, run_tool, tool_defs};
use super::{build_messages, cancelled, compact_messages, emit_stopped, CTX_CHAR_BUDGET, MAX_TOOL_ROUNDS, OLLAMA};

// ── Provider checks + model listing ──────────────────────────────────────────

#[tauri::command]
pub async fn check_ollama(base_url: Option<String>) -> Result<bool, String> {
    let base = base_url.unwrap_or_else(|| OLLAMA.to_string());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(client
        .get(format!("{base}/api/tags"))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false))
}

/// Installed Ollama models — populates the model dropdown automatically.
#[tauri::command]
pub async fn list_ollama_models(base_url: Option<String>) -> Result<Vec<String>, String> {
    let base = base_url.unwrap_or_else(|| OLLAMA.to_string());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = client
        .get(format!("{base}/api/tags"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mut names: Vec<String> = v["models"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["name"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    Ok(names)
}

/// Models on an OpenAI-compatible endpoint (LM Studio, vLLM, llama.cpp, cloud).
#[tauri::command]
pub async fn list_openai_models(base_url: String, api_key: Option<String>) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(format!("{}/models", base_url.trim_end_matches('/')));
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let v: serde_json::Value = req
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mut names: Vec<String> = v["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    Ok(names)
}

#[tauri::command]
pub async fn check_mzcode() -> Result<bool, String> {
    Ok(which_mz().is_some())
}

fn which_mz() -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) { "mz.exe" } else { "mz" };
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|p| p.join(exe))
            .find(|p| p.is_file())
    })
}

// ── mz-code (local agent binary) ─────────────────────────────────────────────

/// Strip ANSI escape sequences and spinner carriage-return overdraws.
fn clean_terminal_line(line: &str) -> String {
    // Keep only what a terminal would show: text after the last \r
    let visible = line.rsplit('\r').next().unwrap_or(line);
    let mut out = String::with_capacity(visible.len());
    let mut chars = visible.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    // CSI: consume until final byte @..~
                    while let Some(&n) = chars.peek() {
                        chars.next();
                        if ('\u{40}'..='\u{7e}').contains(&n) { break; }
                    }
                }
                Some(']') => {
                    chars.next();
                    // OSC: consume until BEL or ST
                    while let Some(&n) = chars.peek() {
                        chars.next();
                        if n == '\u{07}' { break; }
                    }
                }
                _ => { chars.next(); }
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub(crate) async fn run_mzcode(
    app: &AppHandle,
    prompt: &str,
    page_url: &str,
    page_title: &str,
) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mz = which_mz().ok_or("mz not found on PATH — build mz-code and add it to PATH")?;

    let full_prompt = if page_url.is_empty() {
        prompt.to_string()
    } else {
        format!("[Browser context — the user is currently viewing: \"{page_title}\" ({page_url})]\n{prompt}")
    };

    let mut cmd = tokio::process::Command::new(mz);
    cmd.arg("--session")
        .arg("zro-browser")
        .arg(&full_prompt)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| format!("failed to launch mz: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout from mz")?;
    let mut lines = BufReader::new(stdout).lines();

    let _ = app.emit("ai-tool", serde_json::json!({ "name": "mzcode", "args": {} }));

    let mut was_cancelled = false;
    let stream = async {
        while let Ok(Some(line)) = lines.next_line().await {
            if cancelled(app) { was_cancelled = true; break; }
            let text = clean_terminal_line(&line);
            let _ = app.emit("ai-token", serde_json::json!({ "token": format!("{text}\n") }));
        }
    };

    match tokio::time::timeout(Duration::from_secs(300), stream).await {
        Ok(()) if was_cancelled => {
            let _ = child.kill().await;
            let _ = app.emit("ai-token", serde_json::json!({ "token": "\n[stopped]" }));
        }
        Ok(()) => { let _ = child.wait().await; }
        Err(_) => {
            let _ = child.kill().await;
            let _ = app.emit("ai-token", serde_json::json!({ "token": "\n[mz timed out after 5 min]" }));
        }
    }

    let _ = app.emit("ai-done", serde_json::json!({}));
    Ok(())
}

// ── OpenAI-compatible chat loop (SSE, with tools) ────────────────────────────

pub(crate) async fn run_openai_loop(
    app: &AppHandle,
    system: &str,
    prompt: &str,
    history: &[serde_json::Value],
    model: &str,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<(), String> {
    let mut messages = build_messages(system, history, prompt);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    for _round in 0..MAX_TOOL_ROUNDS {
        if cancelled(app) { emit_stopped(app); return Ok(()); }
        compact_messages(&mut messages, CTX_CHAR_BUDGET);
        let body = serde_json::json!({
            "model": model,
            "stream": true,
            "messages": messages,
            "tools": tool_defs(),
        });

        let mut req = client.post(&url).json(&body);
        if let Some(key) = api_key.filter(|k| !k.is_empty()) {
            req = req.bearer_auth(key);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(resp.text().await.unwrap_or_default());
        }

        let mut content = String::new();
        // tool call deltas keyed by index: (id, name, arguments-accumulator)
        let mut calls: Vec<(String, String, String)> = Vec::new();
        let mut buf = String::new();
        let mut stream = resp.bytes_stream();

        'outer: while let Some(chunk) = stream.next().await {
            if cancelled(app) { emit_stopped(app); return Ok(()); }
            let chunk = chunk.map_err(|e| e.to_string())?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(nl) = buf.find('\n') {
                let line = buf[..nl].trim().to_string();
                buf.drain(..=nl);
                let Some(data) = line.strip_prefix("data:") else { continue };
                let data = data.trim();
                if data == "[DONE]" { break 'outer; }
                let v: serde_json::Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let delta = &v["choices"][0]["delta"];
                if let Some(tok) = delta["content"].as_str() {
                    if !tok.is_empty() {
                        content.push_str(tok);
                        let _ = app.emit("ai-token", serde_json::json!({ "token": tok }));
                    }
                }
                if let Some(tcs) = delta["tool_calls"].as_array() {
                    for tc in tcs {
                        let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                        while calls.len() <= idx {
                            calls.push((String::new(), String::new(), String::new()));
                        }
                        if let Some(id) = tc["id"].as_str() { calls[idx].0 = id.to_string(); }
                        if let Some(n) = tc["function"]["name"].as_str() { calls[idx].1.push_str(n); }
                        if let Some(a) = tc["function"]["arguments"].as_str() { calls[idx].2.push_str(a); }
                    }
                }
            }
        }

        if calls.is_empty() {
            let _ = app.emit("ai-done", serde_json::json!({}));
            return Ok(());
        }

        let tool_calls_json: Vec<serde_json::Value> = calls
            .iter()
            .map(|(id, name, args)| {
                serde_json::json!({
                    "id": id, "type": "function",
                    "function": { "name": name, "arguments": args },
                })
            })
            .collect();
        messages.push(serde_json::json!({
            "role": "assistant", "content": content, "tool_calls": tool_calls_json,
        }));

        let parsed: Vec<(String, String, serde_json::Value)> = calls
            .iter()
            .map(|(id, name, args_raw)| {
                let args = serde_json::from_str(args_raw).unwrap_or(serde_json::json!({}));
                (id.clone(), name.clone(), args)
            })
            .collect();

        // Side-effect-free tools (searches, url fetches, memory lookups) run
        // concurrently when the model batches them; page tools stay sequential.
        if parsed.len() > 1 && parsed.iter().all(|(_, n, _)| is_parallel_safe(n)) {
            if cancelled(app) { emit_stopped(app); return Ok(()); }
            for (_, name, args) in &parsed {
                let _ = app.emit("ai-tool", serde_json::json!({ "name": name, "args": args }));
            }
            let results = futures_util::future::join_all(
                parsed.iter().map(|(_, name, args)| run_tool(app, name, args)),
            )
            .await;
            for ((id, _, _), result) in parsed.iter().zip(results) {
                messages.push(serde_json::json!({
                    "role": "tool", "tool_call_id": id, "content": result,
                }));
            }
        } else {
            for (id, name, args) in &parsed {
                if cancelled(app) { emit_stopped(app); return Ok(()); }
                let _ = app.emit("ai-tool", serde_json::json!({ "name": name, "args": args }));
                let result = run_tool(app, name, args).await;
                messages.push(serde_json::json!({
                    "role": "tool", "tool_call_id": id, "content": result,
                }));
            }
        }
    }

    let _ = app.emit("ai-token", serde_json::json!({ "token": "\n[stopped: tool-call limit reached]" }));
    let _ = app.emit("ai-done", serde_json::json!({}));
    Ok(())
}

// ── Ollama chat loop ──────────────────────────────────────────────────────────

pub(crate) async fn run_ollama_loop(
    app: &AppHandle,
    system: &str,
    prompt: &str,
    history: &[serde_json::Value],
    model: &str,
    base_url: &str,
) -> Result<(), String> {
    let mut messages = build_messages(system, history, prompt);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    for _round in 0..MAX_TOOL_ROUNDS {
        if cancelled(app) { emit_stopped(app); return Ok(()); }
        compact_messages(&mut messages, CTX_CHAR_BUDGET);
        let body = serde_json::json!({
            "model": model,
            "stream": true,
            "messages": messages,
            "tools": tool_defs(),
        });

        let resp = client
            .post(format!("{base_url}/api/chat"))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(resp.text().await.unwrap_or_default());
        }

        let mut content = String::new();
        let mut tool_calls: Vec<serde_json::Value> = Vec::new();
        let mut buf = String::new();
        let mut stream = resp.bytes_stream();

        'outer: while let Some(chunk) = stream.next().await {
            if cancelled(app) { emit_stopped(app); return Ok(()); }
            let chunk = chunk.map_err(|e| e.to_string())?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            // NDJSON — process complete lines, keep remainder in buf
            while let Some(nl) = buf.find('\n') {
                let line = buf[..nl].trim().to_string();
                buf.drain(..=nl);
                if line.is_empty() { continue; }
                let v: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(tok) = v["message"]["content"].as_str() {
                    if !tok.is_empty() {
                        content.push_str(tok);
                        let _ = app.emit("ai-token", serde_json::json!({ "token": tok }));
                    }
                }
                if let Some(tcs) = v["message"]["tool_calls"].as_array() {
                    tool_calls.extend(tcs.iter().cloned());
                }
                if v["done"].as_bool().unwrap_or(false) {
                    break 'outer;
                }
            }
        }

        if tool_calls.is_empty() {
            let _ = app.emit("ai-done", serde_json::json!({}));
            return Ok(());
        }

        // Model wants tools: record its turn, run each tool, feed results back
        messages.push(serde_json::json!({
            "role": "assistant", "content": content, "tool_calls": tool_calls,
        }));
        let all_safe = tool_calls.len() > 1
            && tool_calls
                .iter()
                .all(|tc| is_parallel_safe(tc["function"]["name"].as_str().unwrap_or("")));
        if all_safe {
            if cancelled(app) { emit_stopped(app); return Ok(()); }
            for tc in &tool_calls {
                let _ = app.emit("ai-tool", serde_json::json!({
                    "name": tc["function"]["name"].as_str().unwrap_or(""),
                    "args": tc["function"]["arguments"],
                }));
            }
            let results = futures_util::future::join_all(tool_calls.iter().map(|tc| {
                run_tool(
                    app,
                    tc["function"]["name"].as_str().unwrap_or(""),
                    &tc["function"]["arguments"],
                )
            }))
            .await;
            for result in results {
                messages.push(serde_json::json!({ "role": "tool", "content": result }));
            }
        } else {
            for tc in &tool_calls {
                if cancelled(app) { emit_stopped(app); return Ok(()); }
                let name = tc["function"]["name"].as_str().unwrap_or("");
                let args = &tc["function"]["arguments"];
                let _ = app.emit("ai-tool", serde_json::json!({ "name": name, "args": args }));
                let result = run_tool(app, name, args).await;
                messages.push(serde_json::json!({ "role": "tool", "content": result }));
            }
        }
    }

    let _ = app.emit("ai-token", serde_json::json!({ "token": "\n[stopped: tool-call limit reached]" }));
    let _ = app.emit("ai-done", serde_json::json!({}));
    Ok(())
}
