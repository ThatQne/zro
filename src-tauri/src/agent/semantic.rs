//! Semantic memory: turbovec index over Ollama embeddings of visited pages.

use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use super::eval::eval_with_result;
use super::OLLAMA;

/// Text-only page read for indexing — runs on every page load, so it skips
/// the interactive-skeleton scan the agent's read_page tool now does.
const INDEX_PAGE_JS: &str = r#"
(function(){
  var t = document.body ? document.body.innerText : '';
  t = t.replace(/\n{3,}/g, '\n\n').slice(0, 6000);
  return { title: document.title, url: location.href, text: t };
})()"#;

const EMBED_MODEL: &str = "nomic-embed-text";

pub struct MemoryDoc {
    pub url: String,
    pub title: String,
    pub snippet: String,
}

pub struct SemanticMemory {
    index: Option<turbovec::TurboQuantIndex>,
    dim: usize,
    docs: Vec<MemoryDoc>, // position == index row
    seen_urls: std::collections::HashSet<String>,
}

impl Default for SemanticMemory {
    fn default() -> Self {
        Self { index: None, dim: 0, docs: Vec::new(), seen_urls: Default::default() }
    }
}

async fn embed(text: &str) -> Result<Vec<f32>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{OLLAMA}/api/embed"))
        .json(&serde_json::json!({ "model": EMBED_MODEL, "input": text }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let emb = v["embeddings"][0]
        .as_array()
        .ok_or_else(|| format!("no embedding in response: {}", v))?
        .iter()
        .map(|x| x.as_f64().unwrap_or(0.0) as f32)
        .collect::<Vec<f32>>();
    if emb.is_empty() { return Err("empty embedding".into()); }
    Ok(emb)
}

/// Index the current page into semantic memory. Fire-and-forget from frontend
/// on every page load (frontend skips it in incognito).
#[tauri::command]
pub async fn index_page(
    app: AppHandle,
    memory: tauri::State<'_, Mutex<SemanticMemory>>,
    url: Option<String>,
) -> Result<(), String> {
    // Dedupe by URL BEFORE touching the page — INDEX_PAGE_JS forces a full
    // layout pass (innerText), which visibly janks heavy pages on repeat visits
    if let Some(u) = &url {
        let m = memory.lock().unwrap();
        if m.seen_urls.contains(u) { return Ok(()); }
    }
    let raw = eval_with_result(&app, INDEX_PAGE_JS.to_string()).await?;
    let page: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let url = page["url"].as_str().unwrap_or("").to_string();
    let title = page["title"].as_str().unwrap_or("").to_string();
    let text = page["text"].as_str().unwrap_or("").to_string();
    if url.is_empty() || text.len() < 80 { return Ok(()); } // nothing worth indexing

    // Dedupe check BEFORE the expensive embed call (lock not held across await)
    {
        let m = memory.lock().unwrap();
        if m.seen_urls.contains(&url) { return Ok(()); }
    }

    let doc_text = format!("{title}\n{}", &text[..text.len().min(2000)]);
    let vec = embed(&doc_text).await?; // fails silently upstream if Ollama down

    let mut m = memory.lock().unwrap();
    if m.seen_urls.contains(&url) { return Ok(()); } // raced another load
    if m.index.is_none() {
        m.dim = vec.len();
        m.index = Some(
            turbovec::TurboQuantIndex::new(vec.len(), 4).map_err(|e| format!("{e:?}"))?,
        );
    }
    if vec.len() != m.dim { return Err(format!("embed dim {} != index dim {}", vec.len(), m.dim)); }
    if let Some(idx) = m.index.as_mut() {
        idx.add(&vec);
    }
    m.docs.push(MemoryDoc { url: url.clone(), title, snippet: text.chars().take(300).collect() });
    m.seen_urls.insert(url);
    Ok(())
}

pub(crate) async fn search_memory(app: &AppHandle, query: &str) -> Result<String, String> {
    let qvec = embed(query).await?;
    let memory = app.state::<Mutex<SemanticMemory>>();
    let m = memory.lock().unwrap();
    let idx = match m.index.as_ref() {
        Some(i) if !m.docs.is_empty() => i,
        _ => return Ok("no pages indexed yet".into()),
    };
    if qvec.len() != m.dim { return Err("embedding dim mismatch".into()); }
    let k = 5.min(m.docs.len());
    let results = idx.search(&qvec, k);
    let hits: Vec<serde_json::Value> = results
        .indices_for_query(0)
        .iter()
        .zip(results.scores_for_query(0))
        .filter_map(|(&i, &score)| {
            m.docs.get(i as usize).map(|d| serde_json::json!({
                "url": d.url, "title": d.title, "snippet": d.snippet, "score": score,
            }))
        })
        .collect();
    Ok(serde_json::Value::Array(hits).to_string())
}
