//! Graph memory — the "brain".
//!
//! Every saved thing (note, todo, link, image, clipboard snippet, or visited
//! page) is a NODE. Relationships are EDGES formed four ways:
//!   - semantic  : cosine similarity of nomic-embed embeddings (the ML part)
//!   - domain    : same site host
//!   - temporal  : created within a short window of each other
//!   - manual    : the user drew the link
//!
//! Persisted as a single JSON graph in app_data_dir. Embeddings are kept in
//! memory + on disk but never shipped to the frontend (they're bulky and the
//! UI doesn't need them). Embedding is best-effort: if Ollama is down the node
//! is still stored and linked by domain/temporal/manual only.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent::OLLAMA;

const NODE_CAP: usize = 4000;
// Auto-linking is semantic-only and deliberately sparse: only genuinely related
// entries connect, so the graph stays readable instead of a hairball. Domain /
// temporal auto-links were removed (they linked everything to everything).
const SEMANTIC_THRESHOLD: f32 = 0.70;
const SEMANTIC_MAX_LINKS: usize = 4;
const EMBED_MODEL: &str = "nomic-embed-text";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Note,
    Todo,
    Link,
    Image,
    Clip,
    Visit,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    Manual,
    Semantic,
    Domain,
    Temporal,
}

impl EdgeKind {
    /// Strength ranking so an upserted edge keeps the most meaningful reason.
    fn rank(self) -> u8 {
        match self {
            EdgeKind::Manual => 3,
            EdgeKind::Semantic => 2,
            EdgeKind::Domain => 1,
            EdgeKind::Temporal => 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MemNode {
    pub id: String,
    pub kind: NodeKind,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub image: Option<String>, // downscaled data URL
    pub created: u64,
    pub updated: u64,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub visits: u32,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub embed: Option<Vec<f32>>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MemEdge {
    pub a: String,
    pub b: String,
    pub kind: EdgeKind,
    pub weight: f32,
}

#[derive(Default)]
pub struct MemGraph {
    pub nodes: Vec<MemNode>,
    pub edges: Vec<MemEdge>,
    pub dim: usize,
    pub loaded: bool,
}

// ── helpers ────────────────────────────────────────────────────────────────

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

fn graph_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("memory_graph.json"))
}

/// Load the graph from disk once, into the managed state.
pub fn ensure_loaded(app: &AppHandle, g: &mut MemGraph) {
    if g.loaded {
        return;
    }
    g.loaded = true;
    if let Some(p) = graph_path(app) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(loaded) = serde_json::from_str::<MemGraph>(&s) {
                g.nodes = loaded.nodes;
                g.edges = loaded.edges;
                g.dim = loaded.dim;
            }
        }
    }
}

// MemGraph needs to Deserialize from the on-disk shape (nodes/edges/dim).
impl<'de> Deserialize<'de> for MemGraph {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Wire {
            #[serde(default)]
            nodes: Vec<MemNode>,
            #[serde(default)]
            edges: Vec<MemEdge>,
            #[serde(default)]
            dim: usize,
        }
        let w = Wire::deserialize(d)?;
        Ok(MemGraph { nodes: w.nodes, edges: w.edges, dim: w.dim, loaded: true })
    }
}

fn save(app: &AppHandle, g: &MemGraph) {
    #[derive(Serialize)]
    struct Wire<'a> {
        nodes: &'a [MemNode],
        edges: &'a [MemEdge],
        dim: usize,
    }
    if let (Some(p), Ok(json)) = (
        graph_path(app),
        serde_json::to_string(&Wire { nodes: &g.nodes, edges: &g.edges, dim: g.dim }),
    ) {
        let _ = std::fs::write(p, json);
    }
}

async fn embed(text: &str) -> Result<Vec<f32>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("empty".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
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
        .ok_or("no embedding")?
        .iter()
        .map(|x| x.as_f64().unwrap_or(0.0) as f32)
        .collect::<Vec<f32>>();
    if emb.is_empty() {
        return Err("empty embedding".into());
    }
    Ok(emb)
}

/// Canonical undirected edge upsert — keeps the strongest reason per pair.
fn upsert_edge(g: &mut MemGraph, a: &str, b: &str, kind: EdgeKind, weight: f32) {
    if a == b {
        return;
    }
    let (a, b) = if a < b { (a, b) } else { (b, a) };
    if let Some(e) = g.edges.iter_mut().find(|e| e.a == a && e.b == b) {
        if kind.rank() > e.kind.rank() || (kind == e.kind && weight > e.weight) {
            e.kind = kind;
            e.weight = weight;
        }
        return;
    }
    g.edges.push(MemEdge { a: a.to_string(), b: b.to_string(), kind, weight });
}

/// Form semantic edges from the node at `idx` to its nearest neighbours.
///
/// Only meaning-based links: the top-K most-similar nodes over a fairly high
/// threshold. No domain/temporal fan-out — those made every entry link to every
/// other, which drowned the graph. Needs an embedding (Ollama); a node with no
/// embed simply stays unlinked until it gets one.
fn autolink(g: &mut MemGraph, idx: usize) {
    let me = match &g.nodes[idx].embed {
        Some(v) => v.clone(),
        None => return,
    };
    let id = g.nodes[idx].id.clone();
    let mut sims: Vec<(String, f32)> = Vec::new();
    for (j, other) in g.nodes.iter().enumerate() {
        if j == idx {
            continue;
        }
        if let Some(oe) = &other.embed {
            let s = cosine(&me, oe);
            if s >= SEMANTIC_THRESHOLD {
                sims.push((other.id.clone(), s));
            }
        }
    }
    sims.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    for (oid, s) in sims.into_iter().take(SEMANTIC_MAX_LINKS) {
        upsert_edge(g, &id, &oid, EdgeKind::Semantic, s);
    }
}

/// Background worker: embed a node's text, store the vector, re-link it, persist,
/// and notify the frontend. Runs off the command hot path so `mem_add` /
/// `mem_update` return instantly even when Ollama is slow or down.
async fn embed_and_link(app: AppHandle, id: String) {
    let src = {
        let state = app.state::<Mutex<MemGraph>>();
        let g = state.lock().unwrap();
        match g.nodes.iter().find(|n| n.id == id) {
            Some(n) => {
                let host = n.url.as_deref().and_then(host_of).unwrap_or_default();
                format!("{}\n{}\n{}", n.title, n.body, host)
            }
            None => return,
        }
    };
    let vec = match embed(&src).await {
        Ok(v) => v,
        Err(_) => return, // Ollama down — node stays unlinked, no harm
    };

    let state = app.state::<Mutex<MemGraph>>();
    let mut g = state.lock().unwrap();
    let idx = match g.nodes.iter().position(|n| n.id == id) {
        Some(i) => i,
        None => return,
    };
    if g.dim == 0 {
        g.dim = vec.len();
    }
    if vec.len() != g.dim {
        return; // model dimension mismatch — skip
    }
    g.nodes[idx].embed = Some(vec);
    // Fresh links from the new meaning (clear any stale semantic edges first).
    g.edges
        .retain(|e| !((e.a == id || e.b == id) && e.kind == EdgeKind::Semantic));
    autolink(&mut g, idx);
    save(&app, &g);
    drop(g);
    let _ = app.emit("zro:mem-changed", ());
}

/// Drop weakest nodes when over cap (unpinned visits first, then oldest).
fn enforce_cap(g: &mut MemGraph) {
    if g.nodes.len() <= NODE_CAP {
        return;
    }
    let over = g.nodes.len() - NODE_CAP;
    // rank removable: unpinned, prefer visits, then oldest updated
    let mut idxs: Vec<usize> = (0..g.nodes.len()).filter(|&i| !g.nodes[i].pinned).collect();
    idxs.sort_by(|&a, &b| {
        let na = &g.nodes[a];
        let nb = &g.nodes[b];
        let va = (na.kind == NodeKind::Visit) as u8;
        let vb = (nb.kind == NodeKind::Visit) as u8;
        vb.cmp(&va).then(na.updated.cmp(&nb.updated))
    });
    let remove: std::collections::HashSet<String> =
        idxs.into_iter().take(over).map(|i| g.nodes[i].id.clone()).collect();
    g.nodes.retain(|n| !remove.contains(&n.id));
    g.edges.retain(|e| !remove.contains(&e.a) && !remove.contains(&e.b));
}

/// Node minus its embedding, for shipping to the frontend.
fn node_view(n: &MemNode) -> serde_json::Value {
    serde_json::json!({
        "id": n.id,
        "kind": n.kind,
        "title": n.title,
        "body": n.body,
        "url": n.url,
        "image": n.image,
        "created": n.created,
        "updated": n.updated,
        "done": n.done,
        "pinned": n.pinned,
        "visits": n.visits,
        "tags": n.tags,
        "linked": n.embed.is_some(),
    })
}

// ── commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn mem_list(
    app: AppHandle,
    state: tauri::State<'_, Mutex<MemGraph>>,
) -> Result<serde_json::Value, String> {
    let mut g = state.lock().unwrap();
    ensure_loaded(&app, &mut g);
    let nodes: Vec<serde_json::Value> = g.nodes.iter().map(node_view).collect();
    Ok(serde_json::json!({ "nodes": nodes, "edges": g.edges }))
}

#[tauri::command]
pub async fn mem_add(
    app: AppHandle,
    state: tauri::State<'_, Mutex<MemGraph>>,
    kind: NodeKind,
    title: String,
    body: Option<String>,
    url: Option<String>,
    image: Option<String>,
) -> Result<serde_json::Value, String> {
    let body = body.unwrap_or_default();
    let now = now_secs();
    let url = url.filter(|u| !u.is_empty());
    let id = new_id();

    // Hot path: insert + persist immediately, no embedding. The vector and its
    // semantic links land shortly after via the background worker below.
    let out = {
        let mut g = state.lock().unwrap();
        ensure_loaded(&app, &mut g);
        g.nodes.push(MemNode {
            id: id.clone(),
            kind,
            title,
            body,
            url,
            image,
            created: now,
            updated: now,
            done: false,
            pinned: false,
            visits: 0,
            tags: Vec::new(),
            embed: None,
        });
        enforce_cap(&mut g);
        let out = g
            .nodes
            .iter()
            .find(|n| n.id == id)
            .map(node_view)
            .ok_or("node evicted")?;
        save(&app, &g);
        out
    };

    let app2 = app.clone();
    tauri::async_runtime::spawn(embed_and_link(app2, id));
    Ok(out)
}

#[tauri::command]
pub fn mem_update(
    app: AppHandle,
    state: tauri::State<'_, Mutex<MemGraph>>,
    id: String,
    title: Option<String>,
    body: Option<String>,
    done: Option<bool>,
    pinned: Option<bool>,
    tags: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let text_changed = title.is_some() || body.is_some();

    let mut g = state.lock().unwrap();
    ensure_loaded(&app, &mut g);
    let idx = g.nodes.iter().position(|n| n.id == id).ok_or("not found")?;
    {
        let n = &mut g.nodes[idx];
        if let Some(t) = title {
            n.title = t;
        }
        if let Some(b) = body {
            n.body = b;
        }
        if let Some(d) = done {
            n.done = d;
        }
        if let Some(p) = pinned {
            n.pinned = p;
        }
        if let Some(t) = tags {
            n.tags = t;
        }
        n.updated = now_secs();
    }
    let out = node_view(&g.nodes[idx]);
    save(&app, &g);
    drop(g);

    // Re-embed + re-link off the hot path when the meaning changed.
    if text_changed {
        let app2 = app.clone();
        tauri::async_runtime::spawn(embed_and_link(app2, id));
    }
    Ok(out)
}

#[tauri::command]
pub fn mem_delete(
    app: AppHandle,
    state: tauri::State<'_, Mutex<MemGraph>>,
    id: String,
) -> Result<(), String> {
    let mut g = state.lock().unwrap();
    ensure_loaded(&app, &mut g);
    g.nodes.retain(|n| n.id != id);
    g.edges.retain(|e| e.a != id && e.b != id);
    save(&app, &g);
    Ok(())
}

#[tauri::command]
pub fn mem_link(
    app: AppHandle,
    state: tauri::State<'_, Mutex<MemGraph>>,
    a: String,
    b: String,
) -> Result<(), String> {
    let mut g = state.lock().unwrap();
    ensure_loaded(&app, &mut g);
    upsert_edge(&mut g, &a, &b, EdgeKind::Manual, 1.0);
    save(&app, &g);
    Ok(())
}

#[tauri::command]
pub fn mem_unlink(
    app: AppHandle,
    state: tauri::State<'_, Mutex<MemGraph>>,
    a: String,
    b: String,
) -> Result<(), String> {
    let mut g = state.lock().unwrap();
    ensure_loaded(&app, &mut g);
    let (a, b) = if a < b { (a, b) } else { (b, a) };
    g.edges.retain(|e| !(e.a == a && e.b == b));
    save(&app, &g);
    Ok(())
}

#[tauri::command]
pub async fn mem_search(
    app: AppHandle,
    state: tauri::State<'_, Mutex<MemGraph>>,
    query: String,
) -> Result<serde_json::Value, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(serde_json::json!([]));
    }
    // Try semantic first.
    let qvec = embed(&q).await.ok();
    let mut g = state.lock().unwrap();
    ensure_loaded(&app, &mut g);

    let mut scored: Vec<(String, f32)> = Vec::new();
    if let Some(qv) = qvec.as_ref().filter(|v| v.len() == g.dim && g.dim > 0) {
        for n in &g.nodes {
            if let Some(e) = &n.embed {
                let s = cosine(qv, e);
                if s > 0.2 {
                    scored.push((n.id.clone(), s));
                }
            }
        }
    }
    // Text fallback / supplement (guarantees keyword hits even without Ollama).
    let ql = q.to_lowercase();
    let words: Vec<&str> = ql.split_whitespace().filter(|w| w.len() > 1).collect();
    for n in &g.nodes {
        let hay = format!("{} {} {}", n.title, n.body, n.url.as_deref().unwrap_or("")).to_lowercase();
        let hits = words.iter().filter(|w| hay.contains(**w)).count();
        if hits > 0 {
            let boost = hits as f32 * 0.5;
            if let Some(entry) = scored.iter_mut().find(|(id, _)| *id == n.id) {
                entry.1 += boost;
            } else {
                scored.push((n.id.clone(), boost));
            }
        }
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(40);
    let out: Vec<serde_json::Value> = scored
        .into_iter()
        .map(|(id, score)| serde_json::json!({ "id": id, "score": score }))
        .collect();
    Ok(serde_json::Value::Array(out))
}

/// Fire-and-forget from the history hook: a visited page becomes (or refreshes)
/// a Visit node. Deduped by URL so repeat visits just bump the counter.
#[tauri::command]
pub async fn mem_ingest_visit(
    app: AppHandle,
    state: tauri::State<'_, Mutex<MemGraph>>,
    url: String,
    title: String,
) -> Result<(), String> {
    if url.is_empty() {
        return Ok(());
    }
    // Existing visit? bump and bail (no embed cost).
    {
        let mut g = state.lock().unwrap();
        ensure_loaded(&app, &mut g);
        let bumped = match g
            .nodes
            .iter_mut()
            .find(|n| n.kind == NodeKind::Visit && n.url.as_deref() == Some(url.as_str()))
        {
            Some(n) => {
                n.visits += 1;
                n.updated = now_secs();
                if !title.is_empty() {
                    n.title = title.clone();
                }
                true
            }
            None => false,
        };
        if bumped {
            save(&app, &g);
            return Ok(());
        }
    }

    let host = host_of(&url).unwrap_or_default();
    let vec = embed(&format!("{title}\n{host}")).await.ok();
    let now = now_secs();

    let mut g = state.lock().unwrap();
    // Raced another ingest of the same URL?
    if g
        .nodes
        .iter()
        .any(|n| n.kind == NodeKind::Visit && n.url.as_deref() == Some(url.as_str()))
    {
        return Ok(());
    }
    let vec = match vec {
        Some(v) if g.dim == 0 => {
            g.dim = v.len();
            Some(v)
        }
        Some(v) if v.len() == g.dim => Some(v),
        _ => None,
    };
    g.nodes.push(MemNode {
        id: new_id(),
        kind: NodeKind::Visit,
        title: if title.is_empty() { url.clone() } else { title },
        body: String::new(),
        url: Some(url),
        image: None,
        created: now,
        updated: now,
        done: false,
        pinned: false,
        visits: 1,
        tags: Vec::new(),
        embed: vec,
    });
    let idx = g.nodes.len() - 1;
    autolink(&mut g, idx);
    enforce_cap(&mut g);
    save(&app, &g);
    Ok(())
}
