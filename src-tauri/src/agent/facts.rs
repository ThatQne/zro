//! Long-term memory: file-backed facts with human-like retention.
//!
//! Facts persist across sessions in ai_memory.json. Ranking = frequency ×
//! recency (spaced-repetition-ish): recalled facts get their use count bumped
//! ("reconsolidation"), stale unused facts decay to the bottom and are pruned.

use tauri::{AppHandle, Manager};

const MEMORY_CAP: usize = 400;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct MemFact {
    fact: String,
    ts: u64,   // last touched (epoch secs)
    uses: u32, // times recalled/reinforced
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn fact_score(f: &MemFact) -> f64 {
    let age_days = (now_secs().saturating_sub(f.ts)) as f64 / 86_400.0;
    (f.uses as f64 + 1.0) / (age_days + 1.0)
}

fn memory_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("ai_memory.json"))
}

fn load_facts(app: &AppHandle) -> Vec<MemFact> {
    memory_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_facts(app: &AppHandle, facts: &mut Vec<MemFact>) {
    if facts.len() > MEMORY_CAP {
        // Forget the weakest memories, keep the strong ones
        facts.sort_by(|a, b| fact_score(b).partial_cmp(&fact_score(a)).unwrap_or(std::cmp::Ordering::Equal));
        facts.truncate(MEMORY_CAP);
    }
    if let (Some(p), Ok(json)) = (memory_path(app), serde_json::to_string_pretty(facts)) {
        let _ = std::fs::write(p, json);
    }
}

pub(crate) fn remember_fact(app: &AppHandle, fact: &str) -> String {
    let fact = fact.trim();
    if fact.is_empty() {
        return r#"{"ok":false,"error":"empty fact"}"#.into();
    }
    let mut facts = load_facts(app);
    // Re-remembering reinforces instead of duplicating
    if let Some(existing) = facts.iter_mut().find(|f| f.fact.eq_ignore_ascii_case(fact)) {
        existing.uses += 1;
        existing.ts = now_secs();
    } else {
        facts.push(MemFact { fact: fact.to_string(), ts: now_secs(), uses: 0 });
    }
    save_facts(app, &mut facts);
    r#"{"ok":true,"saved":true}"#.into()
}

pub(crate) fn recall_facts(app: &AppHandle, query: &str) -> String {
    let mut facts = load_facts(app);
    let words: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .filter(|w| w.len() > 2)
        .map(String::from)
        .collect();
    let mut scored: Vec<(f64, usize)> = facts
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let lower = f.fact.to_lowercase();
            let hits = words.iter().filter(|w| lower.contains(w.as_str())).count() as f64;
            (hits * 10.0 + fact_score(f), i)
        })
        .filter(|(s, _)| *s > 0.0)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let top: Vec<usize> = scored.iter().take(8).map(|(_, i)| *i).collect();
    if top.is_empty() {
        return r#"{"ok":true,"memories":[]}"#.into();
    }
    // Recall reinforces — touched memories survive pruning longer
    let now = now_secs();
    for &i in &top {
        facts[i].uses += 1;
        facts[i].ts = now;
    }
    let out: Vec<&str> = top.iter().map(|&i| facts[i].fact.as_str()).collect();
    let json = serde_json::json!({ "ok": true, "memories": out }).to_string();
    save_facts(app, &mut facts);
    json
}

/// Strongest memories for prompt injection (no query — background context).
pub(crate) fn top_memories(app: &AppHandle, n: usize) -> Vec<String> {
    let mut facts = load_facts(app);
    facts.sort_by(|a, b| fact_score(b).partial_cmp(&fact_score(a)).unwrap_or(std::cmp::Ordering::Equal));
    facts.into_iter().take(n).map(|f| f.fact).collect()
}
