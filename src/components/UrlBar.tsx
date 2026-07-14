import { useState, useRef, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Lock, Search, Clock, Globe, CornerDownLeft } from "lucide-react";
import { inProfile, useBrowserStore } from "../store/tabs";
import { trackOverlay } from "../store/overlays";

const ROW_H = 30;
const MAX_ROWS = 9;

interface Suggestion {
  kind: "tab" | "history" | "search";
  label: string;
  detail?: string;
  /** navigate target (search text or URL) — or tab id for kind=tab */
  value: string;
}

export default function UrlBar() {
  const { tabs: allTabs, activeTabId, navigate, history, switchTab, isIncognito, settings } = useBrowserStore();
  const activeTab = allTabs.find((t) => t.id === activeTabId);
  // "Switch to tab" suggestions stay inside the current tab space —
  // profiles are separate browsers, incognito is a separate mode
  const tabs = allTabs.filter(
    (t) => !!t.incognito === isIncognito && inProfile(t, settings.activeProfileId)
  );

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  // Focus preselects the current URL — that text is NOT a query. Only after
  // the user types does the value drive matching; until then the dropdown
  // shows the zero state (open tabs + most-visited sites).
  const [dirty, setDirty] = useState(false);
  const [webSug, setWebSug] = useState<string[]>([]);
  const [selIdx, setSelIdx] = useState(-1);
  // Inline autofill: input shows typed text + auto-completed remainder
  // (selected, so the next keystroke replaces it — Chrome behavior)
  const [completion, setCompletion] = useState<string | null>(null);
  // What the input displayed before the current keystroke — deletion is
  // "new text is a shrinking prefix of the old", anything else is typing.
  // (A plain length check fails on the first char after focus-select-all.)
  const shownRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!editing) setValue(activeTab?.url ?? "");
  }, [activeTab?.url, editing]);

  // Ctrl+L / Ctrl+E / new tab — focus and select the URL bar
  useEffect(() => {
    function onFocusReq() {
      inputRef.current?.focus();
      setTimeout(() => inputRef.current?.select(), 0);
    }
    window.addEventListener("zro-focus-url", onFocusReq);
    return () => window.removeEventListener("zro-focus-url", onFocusReq);
  }, []);

  // Google suggestions — debounced, Rust-side fetch (CORS-free)
  useEffect(() => {
    clearTimeout(debounceRef.current);
    const q = dirty ? value.trim() : "";
    if (!editing || !q || q.length > 100) {
      setWebSug([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      invoke<string[]>("search_suggest", { q })
        .then(setWebSug)
        .catch(() => setWebSug([]));
    }, 150);
    return () => clearTimeout(debounceRef.current);
  }, [value, editing, dirty]);

  // Frecency: every visit contributes, recent ones weigh more (7-day
  // half-life). "Used twice today" beats "used 50 times last year".
  const frecency = useMemo(() => {
    const now = Date.now();
    const HALF_LIFE = 7 * 86_400_000;
    const map = new Map<string, { url: string; title: string; score: number }>();
    for (const h of history) {
      const w = Math.pow(0.5, (now - h.visitedAt) / HALF_LIFE);
      const cur = map.get(h.url);
      if (cur) {
        cur.score += w;
        if (!cur.title && h.title) cur.title = h.title;
      } else {
        map.set(h.url, { url: h.url, title: h.title, score: w });
      }
    }
    return map;
  }, [history]);

  // Hosts ranked by total frecency — the source for inline autofill:
  // typing "gi" completes to "github.com" in place.
  const hostRank = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of frecency.values()) {
      const host = hostOf(e.url);
      if (!host) continue;
      m.set(host, (m.get(host) ?? 0) + e.score);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  }, [frecency]);

  function completionFor(q: string): string | null {
    const lq = q.toLowerCase();
    // Hosts only — a query with spaces/paths is a search or a full URL
    if (!lq || lq.includes(" ") || lq.includes("/")) return null;
    for (const host of hostRank) {
      const lh = host.toLowerCase();
      if (lh.startsWith(lq) && lh !== lq) return q + host.slice(q.length);
      const bare = lh.replace(/^www\./, "");
      if (bare.startsWith(lq) && bare !== lq) {
        return q + host.replace(/^www\./i, "").slice(q.length);
      }
    }
    return null;
  }

  // Most-visited sites, one row per host (zero-state dropdown).
  // www/non-www collapse into one row — they're the same site, and showing
  // both read as a duplicated suggestion.
  const topSites = useMemo(() => {
    const byHost = new Map<string, { host: string; url: string; title: string; hostScore: number; best: number }>();
    for (const e of frecency.values()) {
      const host = hostOf(e.url).replace(/^www\./, "");
      if (!host) continue;
      const cur = byHost.get(host);
      if (cur) {
        cur.hostScore += e.score;
        if (e.score > cur.best) { cur.best = e.score; cur.url = e.url; cur.title = e.title; }
      } else {
        byHost.set(host, { host, url: e.url, title: e.title, hostScore: e.score, best: e.score });
      }
    }
    return [...byHost.values()].sort((a, b) => b.hostScore - a.hostScore).slice(0, 6);
  }, [frecency]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!editing) return [];
    const q = (dirty ? value : "").trim().toLowerCase();
    const out: Suggestion[] = [];

    const norm = (h: string) => h.replace(/^www\./, "");

    // Zero state (just focused, or cleared): open tabs + most-used sites.
    // A site already listed as an open tab must not show AGAIN as "most
    // visited" — that read as duplicate suggestions.
    if (!q) {
      const shownHosts = new Set<string>();
      for (const t of tabs) {
        if (t.id === activeTabId) continue;
        out.push({ kind: "tab", label: t.title || t.url, detail: "switch to tab", value: t.id });
        const h = norm(hostOf(t.url));
        if (h) shownHosts.add(h);
        if (out.length >= 3) break;
      }
      const activeHost = norm(hostOf(activeTab?.url ?? ""));
      for (const s of topSites) {
        if (out.length >= MAX_ROWS - 1) break;
        if (s.host === activeHost || shownHosts.has(s.host)) continue;
        shownHosts.add(s.host);
        try {
          out.push({ kind: "history", label: s.host, detail: "most visited", value: new URL(s.url).origin });
        } catch { /* unparseable url */ }
      }
      return out;
    }

    // Open tabs → switch instead of duplicate
    const tabUrls = new Set<string>();
    for (const t of tabs) {
      if (t.id === activeTabId) continue;
      if (t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)) {
        out.push({ kind: "tab", label: t.title || t.url, detail: "switch to tab", value: t.id });
        tabUrls.add(t.url);
        if (out.length >= 3) break;
      }
    }

    // History — frecency-ranked, host-prefix matches first. URLs already
    // offered as "switch to tab" rows are skipped.
    const scored: { s: Suggestion; score: number }[] = [];
    for (const e of frecency.values()) {
      if (e.url === activeTab?.url || tabUrls.has(e.url)) continue;
      const host = hostOf(e.url).toLowerCase();
      let boost = 0;
      if (host.startsWith(q) || host.replace(/^www\./, "").startsWith(q)) boost = 3;
      else if (e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)) boost = 1;
      if (!boost) continue;
      scored.push({
        s: { kind: "history", label: e.title || e.url, detail: hostOf(e.url), value: e.url },
        score: e.score * boost,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const { s } of scored.slice(0, 4)) out.push(s);

    // Web suggestions
    for (const s of webSug) {
      if (out.length >= MAX_ROWS) break;
      if (s.toLowerCase() === q) continue;
      out.push({ kind: "search", label: s, value: s });
    }

    return out.slice(0, MAX_ROWS);
  }, [editing, dirty, value, tabs, frecency, topSites, webSug, activeTabId, activeTab?.url]);

  // The dropdown renders OVER the page (chrome-on-top region): report its
  // rect so Rust punches a hole for it. The page never moves.
  const open = editing && suggestions.length > 0;
  useEffect(() => {
    if (!open) return;
    return trackOverlay("url-dropdown", dropRef.current, 8);
  }, [open, suggestions.length]);

  useEffect(() => { setSelIdx(-1); }, [value]);

  // The input renders the full completion — select the auto-added remainder
  // so it reads as a suggestion and the next keystroke overwrites it
  useEffect(() => {
    if (!completion || !inputRef.current) return;
    inputRef.current.setSelectionRange(value.length, completion.length);
  }, [completion, value]);

  function close() {
    setEditing(false);
    setDirty(false);
    setWebSug([]);
    setSelIdx(-1);
    setCompletion(null);
  }

  function pick(s: Suggestion) {
    if (s.kind === "tab") {
      switchTab(s.value);
    } else {
      navigate(s.value);
    }
    close();
    inputRef.current?.blur();
  }

  function handleFocus() {
    setEditing(true);
    setDirty(false);
    setValue(activeTab?.url ?? "");
    setCompletion(null);
    shownRef.current = activeTab?.url ?? "";
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Tab cycles the suggestion list (Shift+Tab backwards)
    if (e.key === "Tab" && suggestions.length > 0) {
      e.preventDefault();
      setCompletion(null);
      setSelIdx((i) =>
        e.shiftKey ? (i <= 0 ? suggestions.length - 1 : i - 1) : (i + 1) % suggestions.length
      );
      return;
    }
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setSelIdx((i) => (i + 1) % suggestions.length);
      return;
    }
    if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setSelIdx((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
      return;
    }
    if (e.key === "Enter") {
      if (selIdx >= 0 && suggestions[selIdx]) {
        pick(suggestions[selIdx]);
      } else {
        // The visible (auto-completed) text is what Enter navigates to
        navigate(completion ?? value);
        close();
        inputRef.current?.blur();
      }
    }
    if (e.key === "Escape") {
      close();
      setValue(activeTab?.url ?? "");
      inputRef.current?.blur();
    }
  }

  function displayValue(): string {
    if (editing) return value;
    if (!activeTab?.url) return "";
    try {
      const u = new URL(activeTab.url);
      return u.hostname || activeTab.url;
    } catch {
      return activeTab.url;
    }
  }

  const isLoading = activeTab?.isLoading ?? false;
  const isSecure = activeTab?.url?.startsWith("https://") ?? false;

  return (
    <div className="flex-1 no-drag" style={{ position: "relative", minWidth: 0 }}>
      <div
        className="flex items-center gap-2"
        style={{
          height: 28,
          background: "rgba(255,255,255,0.04)",
          borderRadius: 6,
          padding: "0 10px",
          border: editing
            ? "1px solid rgba(79,128,245,0.5)"
            : "1px solid rgba(255,255,255,0.06)",
          transition: "border 0.1s",
        }}
      >
        <span style={{ display: "flex", flexShrink: 0, color: isLoading ? "#4f80f5" : isSecure ? "#3a3a3a" : "#554444" }}>
          {editing ? <Search size={11} /> : <Lock size={11} />}
        </span>

        <input
          ref={inputRef}
          value={editing ? (completion ?? value) : displayValue()}
          onChange={(e) => {
            const v = e.target.value;
            setDirty(true);
            setValue(v);
            // Autofill only while typing — deleting must not refill
            const prev = shownRef.current;
            const deleting = v.length < prev.length && prev.toLowerCase().startsWith(v.toLowerCase());
            const c = deleting ? null : completionFor(v);
            setCompletion(c);
            shownRef.current = c ?? v;
          }}
          onFocus={handleFocus}
          onBlur={close}
          onKeyDown={handleKeyDown}
          placeholder="Search or enter URL"
          spellCheck={false}
          style={{
            flex: 1, fontSize: 12,
            color: editing ? "#e4e4e4" : "#aaa",
            background: "transparent", minWidth: 0,
          }}
        />

        {editing && value && (
          <button
            onMouseDown={(e) => { e.preventDefault(); setValue(""); setCompletion(null); shownRef.current = ""; }}
            style={{ fontSize: 10, color: "#555", background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Suggestions — rendered over the page via the chrome region hole */}
      {open && (
        <div ref={dropRef} style={{
          position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4,
          background: "#141414", border: "1px solid rgba(255,255,255,0.09)",
          borderRadius: 8, zIndex: 60, overflow: "hidden",
          boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
        }}>
          {suggestions.map((s, i) => (
            <div
              key={`${s.kind}-${s.value}-${i}`}
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              onMouseEnter={() => setSelIdx(i)}
              style={{
                height: ROW_H, display: "flex", alignItems: "center", gap: 8,
                padding: "0 10px", cursor: "pointer",
                background: i === selIdx ? "rgba(79,128,245,0.14)" : "transparent",
              }}
            >
              <span style={{ display: "flex", flexShrink: 0, color: s.kind === "tab" ? "#4fb56a" : s.kind === "history" ? "#8a7ac8" : "#4a5a7a" }}>
                {s.kind === "tab" ? <Globe size={11} /> : s.kind === "history" ? <Clock size={11} /> : <Search size={11} />}
              </span>
              <span style={{
                fontSize: 11.5, color: i === selIdx ? "#d0d0d0" : "#999",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
              }}>
                {s.label}
              </span>
              {s.detail && (
                <span style={{ fontSize: 9.5, color: "#3a3a3a", flexShrink: 0, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.detail}
                </span>
              )}
              {i === selIdx && <CornerDownLeft size={10} color="#4f80f5" style={{ flexShrink: 0 }} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}
