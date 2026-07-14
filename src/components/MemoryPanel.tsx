import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  X, StickyNote, CheckSquare, Square, Link2, Image as ImageIcon, Clipboard,
  Globe, Search, Trash2, Pin, ExternalLink, Share2, List, Network, Plus, Circle,
} from "lucide-react";
import { useMemoryStore, MemNode, MemKind, MemEdge } from "../store/memory";
import { useBrowserStore } from "../store/tabs";

const KIND_COLOR: Record<MemKind, string> = {
  note: "#9aa7c7",
  todo: "#4f80f5",
  link: "#5fb3a3",
  image: "#c78f5f",
  clip: "#a98fd0",
  visit: "#5a5a5a",
};
const EDGE_COLOR: Record<MemEdge["kind"], string> = {
  manual: "rgba(228,228,228,0.60)",
  semantic: "rgba(79,128,245,0.50)",
  domain: "rgba(130,130,130,0.30)",
  temporal: "rgba(130,130,130,0.16)",
};
const GRAPH_CAP = 240;

function kindIcon(k: MemKind, size = 13) {
  const c = KIND_COLOR[k];
  switch (k) {
    case "note": return <StickyNote size={size} color={c} />;
    case "todo": return <CheckSquare size={size} color={c} />;
    case "link": return <Link2 size={size} color={c} />;
    case "image": return <ImageIcon size={size} color={c} />;
    case "clip": return <Clipboard size={size} color={c} />;
    case "visit": return <Globe size={size} color={c} />;
  }
}

function hostOf(url?: string | null) {
  if (!url) return "";
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

async function downscaleImage(file: File, max = 520): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  return cv.toDataURL("image/jpeg", 0.72);
}

export default function MemoryPanel({ onClose }: { onClose: () => void }) {
  const { nodes, edges, load, add, update, remove, link, search } = useMemoryStore();
  const [view, setView] = useState<"list" | "graph">("list");
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<Map<string, number> | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [asTodo, setAsTodo] = useState(false);

  useEffect(() => { load(); }, [load]);

  // Debounced semantic search.
  useEffect(() => {
    if (!q.trim()) { setMatches(null); return; }
    const t = setTimeout(async () => {
      const r = await search(q);
      setMatches(new Map(r.map((x) => [x.id, x.score])));
    }, 250);
    return () => clearTimeout(t);
  }, [q, search]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const neighborsOf = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!m.has(e.a)) m.set(e.a, new Set());
      if (!m.has(e.b)) m.set(e.b, new Set());
      m.get(e.a)!.add(e.b);
      m.get(e.b)!.add(e.a);
    }
    return m;
  }, [edges]);

  async function addDraft() {
    const text = draft.trim();
    if (!text) return;
    const isUrl = /^https?:\/\//i.test(text) || /^www\.\S+\.\S+/i.test(text) || /^\S+\.\w{2,}(\/\S*)?$/i.test(text);
    if (asTodo) await add({ kind: "todo", title: text });
    else if (isUrl) {
      const url = /^https?:\/\//i.test(text) ? text : "https://" + text;
      await add({ kind: "link", title: text.replace(/^https?:\/\//, ""), url });
    } else await add({ kind: "note", title: text });
    setDraft("");
  }

  async function onPaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) {
          e.preventDefault();
          const data = await downscaleImage(file);
          await add({ kind: "image", title: "Pasted image", image: data });
          return;
        }
      }
    }
  }

  function onNodeClick(id: string) {
    if (linkFrom && linkFrom !== id) {
      link(linkFrom, id);
      setLinkFrom(null);
      return;
    }
    setSel((s) => (s === id ? null : id));
  }

  // List ordering: search → score order; else pinned + todos + recent.
  const listNodes = useMemo(() => {
    if (matches) {
      return nodes
        .filter((n) => matches.has(n.id))
        .sort((a, b) => (matches.get(b.id)! - matches.get(a.id)!));
    }
    const rank = (n: MemNode) =>
      (n.pinned ? 4 : 0) +
      (n.kind === "todo" && !n.done ? 2 : 0);
    return [...nodes].sort((a, b) => rank(b) - rank(a) || b.updated - a.updated);
  }, [nodes, matches]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of nodes) c[n.kind] = (c[n.kind] || 0) + 1;
    return c;
  }, [nodes]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      style={{
        width: 460, flexShrink: 0, background: "#0d0d0d",
        borderLeft: "1px solid rgba(255,255,255,0.1)",
        boxShadow: "inset 16px 0 28px -20px rgba(0,0,0,0.8)",
        display: "flex", flexDirection: "column", height: "100%",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px 9px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Network size={13} color="#4f80f5" />
          <span style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase" }}>Memory</span>
          <span style={{ fontSize: 10, color: "#3a3a3a", marginLeft: 4 }}>{nodes.length} nodes · {edges.length} links</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <SegBtn active={view === "list"} onClick={() => setView("list")}><List size={13} /></SegBtn>
          <SegBtn active={view === "graph"} onClick={() => setView("graph")}><Network size={13} /></SegBtn>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#444", display: "flex", marginLeft: 4 }}><X size={13} /></button>
        </div>
      </div>

      {/* Capture bar */}
      <div style={{ padding: "9px 12px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", gap: 6, alignItems: "center" }}>
        <button
          onClick={() => setAsTodo((v) => !v)}
          title={asTodo ? "Adding as todo" : "Adding as note/link"}
          style={{ display: "flex", background: asTodo ? "rgba(79,128,245,0.15)" : "#161616", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6, padding: 6, cursor: "pointer", color: asTodo ? "#4f80f5" : "#666" }}
        >
          {asTodo ? <CheckSquare size={14} /> : <StickyNote size={14} />}
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addDraft(); }}
          onPaste={onPaste}
          placeholder={asTodo ? "New todo…" : "Note, link, or paste an image…"}
          style={{ flex: 1, background: "#161616", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6, padding: "7px 10px", color: "#e4e4e4", fontSize: 12, outline: "none" }}
        />
        <button onClick={addDraft} style={{ display: "flex", background: "#4f80f5", border: "none", borderRadius: 6, padding: 7, cursor: "pointer", color: "#fff" }}><Plus size={14} /></button>
      </div>

      {/* Search */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", gap: 7 }}>
        <Search size={12} color="#555" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your brain (meaning, not just words)…"
          style={{ flex: 1, background: "transparent", border: "none", color: "#ccc", fontSize: 12, outline: "none" }}
        />
        {q && <button onClick={() => setQ("")} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", display: "flex" }}><X size={12} /></button>}
      </div>

      {linkFrom && (
        <div style={{ padding: "6px 12px", background: "rgba(79,128,245,0.1)", fontSize: 11, color: "#4f80f5", display: "flex", justifyContent: "space-between" }}>
          <span>Click another node to link it</span>
          <button onClick={() => setLinkFrom(null)} style={{ background: "none", border: "none", color: "#4f80f5", cursor: "pointer" }}>cancel</button>
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: view === "list" ? "auto" : "hidden" }}>
        {view === "list" ? (
          <ListView
            nodes={listNodes}
            byId={byId}
            neighborsOf={neighborsOf}
            sel={sel}
            matches={matches}
            onSelect={onNodeClick}
            onUpdate={update}
            onRemove={(id) => { remove(id); if (sel === id) setSel(null); }}
            onStartLink={(id) => setLinkFrom(id)}
            empty={nodes.length === 0}
            counts={counts}
          />
        ) : (
          <GraphView
            nodes={nodes}
            edges={edges}
            matches={matches}
            sel={sel}
            linkFrom={linkFrom}
            onSelect={onNodeClick}
          />
        )}
      </div>
    </motion.div>
  );
}

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ display: "flex", padding: 5, borderRadius: 5, cursor: "pointer", border: "1px solid " + (active ? "rgba(79,128,245,0.4)" : "transparent"), background: active ? "rgba(79,128,245,0.15)" : "transparent", color: active ? "#4f80f5" : "#666" }}>
      {children}
    </button>
  );
}

// ── List view ───────────────────────────────────────────────────────────────

function ListView({
  nodes, byId, neighborsOf, sel, matches, onSelect, onUpdate, onRemove, onStartLink, empty, counts,
}: {
  nodes: MemNode[];
  byId: Map<string, MemNode>;
  neighborsOf: Map<string, Set<string>>;
  sel: string | null;
  matches: Map<string, number> | null;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Pick<MemNode, "title" | "body" | "done" | "pinned" | "tags">>) => void;
  onRemove: (id: string) => void;
  onStartLink: (id: string) => void;
  empty: boolean;
  counts: Record<string, number>;
}) {
  if (empty) {
    return (
      <div style={{ padding: "40px 24px", textAlign: "center", color: "#444", fontSize: 12, lineHeight: 1.7 }}>
        <Network size={28} color="#2a2a2a" style={{ marginBottom: 12 }} />
        <div style={{ color: "#666", marginBottom: 6 }}>Your brain is empty.</div>
        Add a note, drop a link, jot a todo, or paste an image above.<br />
        Pages you visit show up here too, auto-linked to related things.
      </div>
    );
  }
  if (matches && nodes.length === 0) {
    return <div style={{ padding: 30, textAlign: "center", color: "#555", fontSize: 12 }}>No matches.</div>;
  }
  return (
    <div style={{ padding: "6px 0" }}>
      {!matches && (
        <div style={{ display: "flex", gap: 8, padding: "4px 14px 8px", flexWrap: "wrap" }}>
          {(Object.keys(counts) as MemKind[]).map((k) => (
            <span key={k} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#666" }}>
              {kindIcon(k, 10)} {counts[k]}
            </span>
          ))}
        </div>
      )}
      {nodes.map((n) => (
        <MemRow
          key={n.id}
          n={n}
          expanded={sel === n.id}
          neighbors={[...(neighborsOf.get(n.id) || [])].map((id) => byId.get(id)).filter(Boolean) as MemNode[]}
          score={matches?.get(n.id)}
          onSelect={() => onSelect(n.id)}
          onUpdate={onUpdate}
          onRemove={() => onRemove(n.id)}
          onStartLink={() => onStartLink(n.id)}
          onOpenNeighbor={onSelect}
        />
      ))}
    </div>
  );
}

function MemRow({
  n, expanded, neighbors, score, onSelect, onUpdate, onRemove, onStartLink, onOpenNeighbor,
}: {
  n: MemNode;
  expanded: boolean;
  neighbors: MemNode[];
  score?: number;
  onSelect: () => void;
  onUpdate: (id: string, patch: Partial<Pick<MemNode, "title" | "body" | "done" | "pinned" | "tags">>) => void;
  onRemove: () => void;
  onStartLink: () => void;
  onOpenNeighbor: (id: string) => void;
}) {
  const host = hostOf(n.url);
  const open = () => { if (n.url) useBrowserStore.getState().createTab(n.url).catch(() => {}); };

  return (
    <div
      style={{ borderBottom: "1px solid rgba(255,255,255,0.03)", background: expanded ? "rgba(255,255,255,0.02)" : "transparent" }}
    >
      <div onClick={onSelect} style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "9px 14px", cursor: "pointer" }}>
        {n.kind === "todo" ? (
          <button
            onClick={(e) => { e.stopPropagation(); onUpdate(n.id, { done: !n.done }); }}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0, marginTop: 1, display: "flex" }}
          >
            {n.done ? <CheckSquare size={14} color="#4f80f5" /> : <Square size={14} color="#666" />}
          </button>
        ) : (
          <span style={{ marginTop: 1, display: "flex" }}>
            {n.image ? <img src={n.image} style={{ width: 26, height: 26, borderRadius: 4, objectFit: "cover", marginTop: -1 }} /> : kindIcon(n.kind)}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: n.done ? "#555" : "#dcdcdc", textDecoration: n.done ? "line-through" : "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: expanded ? "normal" : "nowrap" }}>
            {n.title || host || "(untitled)"}
          </div>
          {(host || n.body) && (
            <div style={{ fontSize: 10.5, color: "#5a5a5a", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: expanded ? "normal" : "nowrap" }}>
              {host && <span style={{ color: KIND_COLOR[n.kind === "visit" ? "visit" : "link"] }}>{host}</span>}
              {host && n.body ? " · " : ""}{n.body}
            </div>
          )}
        </div>
        {n.pinned && <Pin size={11} color="#4f80f5" style={{ marginTop: 2 }} />}
        {score != null && <span style={{ fontSize: 9, color: "#4f80f5", fontFamily: "monospace", marginTop: 2 }}>{(score).toFixed(2)}</span>}
      </div>

      {expanded && (
        <div style={{ padding: "0 14px 12px 34px" }}>
          {n.image && <img src={n.image} style={{ maxWidth: "100%", borderRadius: 6, marginBottom: 8 }} />}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: neighbors.length ? 10 : 0 }}>
            {n.url && <ActBtn onClick={open}><ExternalLink size={11} /> Open</ActBtn>}
            <ActBtn onClick={() => onUpdate(n.id, { pinned: !n.pinned })}><Pin size={11} /> {n.pinned ? "Unpin" : "Pin"}</ActBtn>
            <ActBtn onClick={onStartLink}><Share2 size={11} /> Link</ActBtn>
            <ActBtn onClick={onRemove} danger><Trash2 size={11} /> Delete</ActBtn>
          </div>
          {neighbors.length > 0 && (
            <div>
              <div style={{ fontSize: 9.5, color: "#555", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 5 }}>
                Linked ({neighbors.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {neighbors.slice(0, 12).map((m) => (
                  <button
                    key={m.id}
                    onClick={() => onOpenNeighbor(m.id)}
                    style={{ display: "flex", alignItems: "center", gap: 6, background: "#141414", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 5, padding: "5px 8px", cursor: "pointer", color: "#bbb", fontSize: 11, textAlign: "left" }}
                  >
                    {kindIcon(m.kind, 11)}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title || hostOf(m.url)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActBtn({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 4, background: "#161616", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 5, padding: "4px 8px", cursor: "pointer", color: danger ? "#c56" : "#aaa", fontSize: 11 }}
    >
      {children}
    </button>
  );
}

// ── Graph view (force-directed canvas) ───────────────────────────────────────

interface P { x: number; y: number; vx: number; vy: number }

function GraphView({
  nodes, edges, matches, sel, linkFrom, onSelect,
}: {
  nodes: MemNode[];
  edges: MemEdge[];
  matches: Map<string, number> | null;
  sel: string | null;
  linkFrom: string | null;
  onSelect: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pos = useRef<Map<string, P>>(new Map());
  const drag = useRef<{ id: string; ox: number; oy: number } | null>(null);
  const raf = useRef(0);
  const size = useRef({ w: 460, h: 400 });

  // Working set: cap the node count so the O(n²) sim stays smooth. Prefer
  // pinned / todos / notes / links, then busiest visits; when searching,
  // show the matches plus their direct neighbors.
  const { gNodes, gEdges } = useMemo(() => {
    let keep: MemNode[];
    if (matches) {
      const nb = new Set<string>(matches.keys());
      for (const e of edges) {
        if (matches.has(e.a)) nb.add(e.b);
        if (matches.has(e.b)) nb.add(e.a);
      }
      keep = nodes.filter((n) => nb.has(n.id));
    } else {
      const weight = (n: MemNode) =>
        (n.pinned ? 100 : 0) + (n.kind !== "visit" ? 50 : 0) + n.visits + n.updated / 1e12;
      keep = [...nodes].sort((a, b) => weight(b) - weight(a)).slice(0, GRAPH_CAP);
    }
    const ids = new Set(keep.map((n) => n.id));
    return { gNodes: keep, gEdges: edges.filter((e) => ids.has(e.a) && ids.has(e.b)) };
  }, [nodes, edges, matches]);

  // Seed positions for new nodes.
  useEffect(() => {
    const { w, h } = size.current;
    for (const n of gNodes) {
      if (!pos.current.has(n.id)) {
        pos.current.set(n.id, { x: w / 2 + (Math.random() - 0.5) * w * 0.6, y: h / 2 + (Math.random() - 0.5) * h * 0.6, vx: 0, vy: 0 });
      }
    }
    // prune stale
    const ids = new Set(gNodes.map((n) => n.id));
    for (const k of [...pos.current.keys()]) if (!ids.has(k)) pos.current.delete(k);
  }, [gNodes]);

  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      size.current = { w: r.width, h: r.height };
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      canvas.style.width = r.width + "px";
      canvas.style.height = r.height + "px";
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const ctx = canvas.getContext("2d")!;
    const radius = (n: MemNode) => (n.pinned ? 7 : 0) + 3.5 + Math.min(4, n.visits * 0.4) + (n.kind !== "visit" ? 1.5 : 0);

    const step = () => {
      const { w, h } = size.current;
      const P = pos.current;
      // repulsion
      for (let i = 0; i < gNodes.length; i++) {
        const a = P.get(gNodes[i].id)!;
        for (let j = i + 1; j < gNodes.length; j++) {
          const b = P.get(gNodes[j].id)!;
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random(); dy = Math.random(); d2 = 1; }
          const f = 900 / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      // springs
      for (const e of gEdges) {
        const a = P.get(e.a), b = P.get(e.b);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const rest = 62 - e.weight * 18;
        const f = (d - rest) * 0.015;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      // gravity to center + integrate
      let moving = 0;
      for (const n of gNodes) {
        const p = P.get(n.id)!;
        if (drag.current?.id === n.id) { p.vx = 0; p.vy = 0; continue; }
        p.vx += (w / 2 - p.x) * 0.0016;
        p.vy += (h / 2 - p.y) * 0.0016;
        p.vx *= 0.86; p.vy *= 0.86;
        p.x += p.vx; p.y += p.vy;
        moving += Math.abs(p.vx) + Math.abs(p.vy);
      }

      // draw
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const focus = sel;
      const focusNb = new Set<string>();
      if (focus) for (const e of gEdges) { if (e.a === focus) focusNb.add(e.b); if (e.b === focus) focusNb.add(e.a); }

      for (const e of gEdges) {
        const a = P.get(e.a), b = P.get(e.b);
        if (!a || !b) continue;
        const active = !focus || e.a === focus || e.b === focus;
        ctx.strokeStyle = EDGE_COLOR[e.kind];
        ctx.globalAlpha = active ? 1 : 0.15;
        ctx.lineWidth = e.kind === "manual" ? 1.4 : 0.8;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const n of gNodes) {
        const p = P.get(n.id)!;
        const isMatch = matches?.has(n.id);
        const dim = (focus && n.id !== focus && !focusNb.has(n.id)) || (matches && !isMatch);
        ctx.globalAlpha = dim ? 0.28 : 1;
        const r = radius(n);
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = KIND_COLOR[n.kind];
        ctx.fill();
        if (n.id === focus || n.id === linkFrom) {
          ctx.lineWidth = 2; ctx.strokeStyle = "#4f80f5"; ctx.stroke();
        } else if (isMatch) {
          ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(79,128,245,0.8)"; ctx.stroke();
        }
        if ((n.id === focus || n.pinned) && (n.title || n.url)) {
          ctx.globalAlpha = dim ? 0.4 : 0.95;
          ctx.fillStyle = "#cfcfcf";
          ctx.font = "10px -apple-system, system-ui, sans-serif";
          const label = (n.title || hostOf(n.url)).slice(0, 22);
          ctx.fillText(label, p.x + r + 3, p.y + 3);
        }
      }
      ctx.globalAlpha = 1;
      // Keep simulating (cheap); nodes settle via damping.
      raf.current = requestAnimationFrame(step);
      void moving;
    };
    raf.current = requestAnimationFrame(step);

    // interaction
    const nodeAt = (mx: number, my: number) => {
      for (let i = gNodes.length - 1; i >= 0; i--) {
        const p = pos.current.get(gNodes[i].id)!;
        const r = radius(gNodes[i]) + 4;
        if ((mx - p.x) ** 2 + (my - p.y) ** 2 <= r * r) return gNodes[i];
      }
      return null;
    };
    const localXY = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      const { x, y } = localXY(e);
      const hit = nodeAt(x, y);
      if (hit) {
        const p = pos.current.get(hit.id)!;
        drag.current = { id: hit.id, ox: p.x - x, oy: p.y - y };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }
    };
    const onMove = (e: PointerEvent) => {
      const { x, y } = localXY(e);
      if (!drag.current) { canvas.style.cursor = nodeAt(x, y) ? "pointer" : "default"; return; }
      const p = pos.current.get(drag.current.id)!;
      p.x = x + drag.current.ox; p.y = y + drag.current.oy; p.vx = 0; p.vy = 0;
    };
    const onUp = (e: PointerEvent) => {
      if (drag.current) {
        const start = pos.current.get(drag.current.id)!;
        const { x, y } = localXY(e);
        const moved = (start.x - (x + drag.current.ox)) ** 2 + (start.y - (y + drag.current.oy)) ** 2;
        const id = drag.current.id;
        drag.current = null;
        if (moved < 9) onSelect(id); // treat as click
      }
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);

    return () => {
      cancelAnimationFrame(raf.current);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
    };
  }, [gNodes, gEdges, sel, matches, linkFrom, onSelect]);

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%", position: "relative" }}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
      {gNodes.length === 0 && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#444", fontSize: 12 }}>
          Nothing to graph yet.
        </div>
      )}
      {/* legend */}
      <div style={{ position: "absolute", bottom: 8, left: 8, display: "flex", gap: 10, flexWrap: "wrap", fontSize: 9, color: "#666" }}>
        {(["note", "todo", "link", "image", "clip", "visit"] as MemKind[]).map((k) => (
          <span key={k} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <Circle size={7} fill={KIND_COLOR[k]} color={KIND_COLOR[k]} /> {k}
          </span>
        ))}
      </div>
    </div>
  );
}
