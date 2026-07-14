//! AI agent, split by concern:
//! - [`eval`]      — WebView2 ExecuteScript with result + page tool scripts
//! - [`semantic`]  — turbovec semantic memory over Ollama embeddings
//! - [`facts`]     — long-term fact memory (ai_memory.json, freq×recency)
//! - [`tools`]     — tool definitions + dispatch
//! - [`providers`] — ollama / openai-compatible / mz-code loops
//!
//! Everything is glob re-exported so command paths stay `agent::<command>`.

pub mod eval;
pub mod facts;
pub mod providers;
pub mod semantic;
pub mod tools;

pub use eval::*;
pub use providers::*;
pub use semantic::*;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const OLLAMA: &str = "http://localhost:11434";
pub(crate) const MAX_TOOL_ROUNDS: usize = 24;

// ── Cancellation ─────────────────────────────────────────────────────────────

/// One in-flight ask at a time; Stop button sets the flag, loops poll it.
#[derive(Default)]
pub struct AiCancel(pub AtomicBool);

#[tauri::command]
pub async fn cancel_ai(app: AppHandle) -> Result<(), String> {
    app.state::<AiCancel>().0.store(true, Ordering::SeqCst);
    Ok(())
}

pub(crate) fn cancelled(app: &AppHandle) -> bool {
    app.state::<AiCancel>().0.load(Ordering::SeqCst)
}

pub(crate) fn emit_stopped(app: &AppHandle) {
    let _ = app.emit("ai-token", serde_json::json!({ "token": "\n[stopped]" }));
    let _ = app.emit("ai-done", serde_json::json!({}));
}

// ── Entry point ───────────────────────────────────────────────────────────────

/// Agentic ask: streams tokens ("ai-token"), announces tool use ("ai-tool"),
/// finishes with "ai-done".
///
/// Providers:
///  - "ollama"  — local Ollama with the in-page tool loop (click/fill/read…)
///  - "openai"  — any OpenAI-compatible endpoint, same tool loop over SSE
///  - "mzcode"  — the local mz agent binary (its own tools: bash, web, files);
///                one-shot spawn, stdout streamed back
#[tauri::command]
pub async fn ask_ai(
    app: AppHandle,
    prompt: String,
    page_url: String,
    page_title: String,
    model: String,
    provider: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    history: Option<Vec<serde_json::Value>>,
) -> Result<(), String> {
    let provider = provider.unwrap_or_else(|| "ollama".into());
    app.state::<AiCancel>().0.store(false, Ordering::SeqCst);

    let memories = facts::top_memories(&app, 10);
    let memory_block = if memories.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nPERSISTENT MEMORY (facts from past sessions — use them, don't re-ask):\n{}",
            memories.iter().map(|m| format!("- {m}")).collect::<Vec<_>>().join("\n")
        )
    };

    let system = format!(
        "You are the zro browser agent — autonomous and persistent.\n\
         AUTONOMY: chain as many tools as needed WITHOUT asking permission. \
         After navigate or click, call read_page to verify where you actually landed. \
         If an action fails or the page isn't what you expected, try another route \
         (find/get_links to locate the right element, a different selector, a direct URL). \
         Only stop to ask the user when truly blocked — e.g. a login or 2FA screen \
         that needs their input.\n\
         WEB SEARCH: for any factual or current-info question call web_search FIRST — \
         one call, instant titles+urls+snippets, no tab opened. Snippets often answer \
         outright; if not, pass the best 2-3 urls to read_url in a SINGLE call (they \
         fetch in parallel). NEVER navigate the visible tab to a search engine and \
         click through results — that is 10x slower and churns the user's screen. \
         Use navigate/click only when the task needs to interact with a page (forms, \
         logins, actions) or the user asked to open it.\n\
         OPERATING PAGES: read_page returns the interactive skeleton — dropdowns with \
         options + selectors, buttons, tabs, pagination. Use find to get a selector for \
         anything by its visible text; never guess selectors. Native <select> dropdowns → \
         select_option. Custom dropdowns → click to open, read_page/find, click the option.\n\
         BATCH WITH CODE: for anything repetitive or bulk — harvesting links/values from \
         a list, selecting many rows, ticking N checkboxes, extracting a table — write \
         JavaScript with run_js instead of looping click/read_page one element at a time. \
         One run_js that querySelectorAll's and returns an array beats ten clicks, and it \
         works even on pages with obfuscated selectors (Gmail etc.). If you catch yourself \
         repeating the same click/scroll/read cycle a third time, stop and script it.\n\
         MULTI-PAGE TASKS: for totals/tallies/lists that span pages, iterate: read_page, \
         record the values, click the next-page control from `pagination`, repeat until \
         no next page — THEN compute the answer from everything collected. Never answer \
         from page 1 of a paginated table. If data sits behind a filter (a dropdown or \
         tab like a payout/transaction type), set that filter FIRST and confirm the page \
         changed via read_page.\n\
         ALL TABS: you can see and operate every open tab, not just the current one. \
         list_tabs shows them; pass tab_id to read_page/get_links/find/click/fill/\
         select_option/scroll to work in another tab (it can stay in the background), \
         or switch_tab to bring it forward. Use this to compare pages, gather data \
         across sites, or continue work in a tab the user mentioned.\n\
         GROUNDING: when the question concerns anything on screen or reachable \
         through your tools — the user's search results, emails, feeds, articles, \
         prices, scores — READ IT and answer from what the page actually says, \
         never from training memory. If the page and your prior knowledge disagree, \
         the page wins; quote it. Only answer from built-in knowledge when no open \
         tab or tool can answer, and say \"from memory\" when you do. read_page \
         truncates long pages — use find_text to search the FULL text (inboxes, \
         long threads, big tables).\n\
         MEMORY: you have persistent cross-session memory. Call remember when the user \
         shares a durable fact (preference, account, recurring task). Call recall when \
         past context could help answer.\n\
         STYLE: be concise. Format page/source mentions as markdown links [title](url). \
         Use **bold** for key points, `code` for technical terms, and lists for steps.\n\
         Current page: \"{page_title}\" ({page_url}).{memory_block}"
    );

    // Prior turns (persisted chat) → multi-turn context for the model
    let history = history.unwrap_or_default();

    let result = match provider.as_str() {
        "mzcode" => providers::run_mzcode(&app, &prompt, &page_url, &page_title).await,
        "openai" => {
            providers::run_openai_loop(
                &app,
                &system,
                &prompt,
                &history,
                &model,
                &base_url.unwrap_or_else(|| "http://localhost:1234/v1".into()),
                api_key.as_deref(),
            )
            .await
        }
        _ => {
            providers::run_ollama_loop(
                &app,
                &system,
                &prompt,
                &history,
                &model,
                &base_url.unwrap_or_else(|| OLLAMA.into()),
            )
            .await
        }
    };
    if result.is_err() {
        let _ = app.emit("ai-done", serde_json::json!({}));
    }
    result
}

/// system + prior turns + current prompt (shared by both chat loops)
pub(crate) fn build_messages(system: &str, history: &[serde_json::Value], prompt: &str) -> Vec<serde_json::Value> {
    let mut messages = vec![serde_json::json!({ "role": "system", "content": system })];
    for h in history {
        let role = h["role"].as_str().unwrap_or("");
        let content = h["content"].as_str().unwrap_or("");
        if (role == "user" || role == "assistant") && !content.is_empty() {
            messages.push(serde_json::json!({ "role": role, "content": content }));
        }
    }
    messages.push(serde_json::json!({ "role": "user", "content": prompt }));
    messages
}

/// Rough char budget for one request (~15k tokens) — small enough for local
/// 16k-context models with room for the reply.
pub(crate) const CTX_CHAR_BUDGET: usize = 60_000;

/// Keep the running conversation under `budget` chars so long agentic runs
/// never overflow the model's context window. Cheapest wins first:
///  1. old tool results collapse to a stub (the model can re-run the tool),
///  2. whole oldest turns drop — always keeping the system prompt and the
///     newest few messages intact.
/// Called before every round, so the request size is bounded no matter how
/// many tool rounds or how big the pages read.
pub(crate) fn compact_messages(messages: &mut Vec<serde_json::Value>, budget: usize) {
    const STUB: &str = "[older tool result pruned to save context — re-run the tool if you still need it]";
    // Per-message overhead approximates role/ids/tool_calls JSON framing.
    fn size(m: &serde_json::Value) -> usize {
        m["content"].as_str().map(|s| s.len()).unwrap_or(0) + 128
    }

    let mut used: usize = messages.iter().map(size).sum();
    if used <= budget {
        return;
    }

    // Pass 1: stub old tool results, oldest first. The newest 4 messages stay
    // whole — that's the tool output the model is about to reason over.
    let protect_from = messages.len().saturating_sub(4);
    for i in 1..protect_from {
        if used <= budget {
            return;
        }
        if messages[i]["role"] == "tool" {
            let s = size(&messages[i]);
            if s > STUB.len() + 128 {
                messages[i]["content"] = serde_json::json!(STUB);
                used = used - s + STUB.len() + 128;
            }
        }
    }

    // Pass 2: drop whole turns from the front (index 1 = oldest after system).
    // An assistant message's tool replies go with it — orphaned "tool" rows
    // make strict OpenAI-compatible servers reject the request.
    while used > budget && messages.len() > 5 {
        used -= size(&messages[1]);
        messages.remove(1);
        while messages.len() > 5 && messages[1]["role"] == "tool" {
            used -= size(&messages[1]);
            messages.remove(1);
        }
    }
}
