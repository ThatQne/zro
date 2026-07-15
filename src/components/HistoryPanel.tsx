import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  X, Search, Trash2, Clock, Globe, CalendarDays, List,
  ChevronLeft, ChevronRight,
} from "lucide-react";
import { useBrowserStore, HistoryEntry } from "../store/tabs";
import { ClearDataSection } from "./SettingsPanel";

interface Props {
  onClose: () => void;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

const dayKey = (ts: number) => new Date(ts).toDateString();

export default function HistoryPanel({ onClose }: Props) {
  const { history, createTab, removeHistory, clearHistory, isIncognito } = useBrowserStore();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"list" | "calendar">("list");
  const [confirmClear, setConfirmClear] = useState(false);
  // Calendar → click a day → list filtered to that day
  const [dayFilter, setDayFilter] = useState<string | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    let filtered = q
      ? history.filter((h) => h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q))
      : history;
    if (dayFilter) filtered = filtered.filter((h) => dayKey(h.visitedAt) === dayFilter);
    const map = new Map<string, HistoryEntry[]>();
    for (const h of filtered.slice(0, 500)) {
      const label = dayLabel(h.visitedAt);
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(h);
    }
    return [...map.entries()];
  }, [history, query, dayFilter]);

  return (
    <motion.div
      // Opacity-only — see AiPanel: an x-slide desyncs the region-hole
      // overlay measurement from the panel's actual on-screen position.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      style={{
        width: 300, flexShrink: 0, background: "#0f0f0f",
        borderLeft: "1px solid rgba(255,255,255,0.1)",
        boxShadow: "inset 16px 0 28px -20px rgba(0,0,0,0.8)",
        display: "flex", flexDirection: "column", height: "100%",
      }}
    >
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 12px 9px", borderBottom: "1px solid rgba(255,255,255,0.05)", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Clock size={13} color="#4f80f5" />
          <span style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            History
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* View toggle */}
          <div style={{ display: "flex", background: "rgba(255,255,255,0.04)", borderRadius: 5, padding: 2 }}>
            <ViewBtn active={view === "list"} onClick={() => setView("list")} title="List"><List size={11} /></ViewBtn>
            <ViewBtn active={view === "calendar"} onClick={() => setView("calendar")} title="Calendar"><CalendarDays size={11} /></ViewBtn>
          </div>
          {history.length > 0 && !confirmClear && (
            <button
              onClick={() => setConfirmClear(true)}
              title="Clear history"
              style={{ background: "none", border: "none", cursor: "pointer", color: "#444", display: "flex" }}
            >
              <Trash2 size={12} />
            </button>
          )}
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#444", display: "flex" }}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {confirmClear && (
        <div style={{
          margin: "8px 10px 0", padding: "8px 10px",
          background: "rgba(220,60,60,0.06)", border: "1px solid rgba(220,60,60,0.16)",
          borderRadius: 6, flexShrink: 0,
        }}>
          <div style={{ fontSize: 10, color: "#d66", marginBottom: 6 }}>Clear history from…</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {([
              ["Past hour", () => Date.now() - 3_600_000],
              ["Past 24 hours", () => Date.now() - 86_400_000],
              ["Past 7 days", () => Date.now() - 7 * 86_400_000],
              ["All time", () => null],
            ] as const).map(([label, since]) => (
              <button
                key={label}
                onClick={() => { clearHistory(since()); setConfirmClear(false); }}
                style={{
                  background: "rgba(220,60,60,0.14)", border: "none", borderRadius: 4,
                  color: "#e88", fontSize: 10, padding: "4px 8px", cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
            <button
              onClick={() => setConfirmClear(false)}
              style={{
                background: "rgba(255,255,255,0.05)", border: "none", borderRadius: 4,
                color: "#777", fontSize: 10, padding: "4px 8px", cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isIncognito && (
        <div style={{ padding: "6px 12px", fontSize: 10, color: "rgba(150,80,220,0.7)", flexShrink: 0 }}>
          ● Incognito — new visits are not recorded
        </div>
      )}

      {view === "calendar" ? (
        <CalendarView
          history={history}
          onPickDay={(key) => { setDayFilter(key); setView("list"); }}
        />
      ) : (
        <>
          {/* Search */}
          <div style={{ padding: "8px 10px 4px", flexShrink: 0 }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 6, padding: "5px 8px",
            }}>
              <Search size={11} color="#444" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search history"
                style={{ flex: 1, fontSize: 11, color: "#aaa", background: "transparent", minWidth: 0 }}
              />
            </div>
          </div>

          {dayFilter && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              margin: "4px 10px 0", padding: "5px 8px", borderRadius: 5,
              background: "rgba(79,128,245,0.08)", border: "1px solid rgba(79,128,245,0.16)", flexShrink: 0,
            }}>
              <span style={{ fontSize: 10, color: "#7a9cf5" }}>
                {new Date(dayFilter).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
              </span>
              <button
                onClick={() => setDayFilter(null)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#6a7aaa", display: "flex" }}
              >
                <X size={11} />
              </button>
            </div>
          )}

          {/* Entries */}
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px 10px" }}>
            {groups.length === 0 && (
              <div style={{ padding: "28px 8px", textAlign: "center", color: "#2a2a2a", fontSize: 11 }}>
                {query || dayFilter ? "No matches" : "No history yet"}
              </div>
            )}
            {groups.map(([label, entries]) => (
              <div key={label}>
                <div style={{
                  fontSize: 9, color: "#3a3a3a", letterSpacing: "0.12em", textTransform: "uppercase",
                  padding: "10px 6px 4px",
                }}>
                  {label}
                </div>
                {entries.map((h) => (
                  <motion.div
                    key={`${h.visitedAt}-${h.url}`}
                    whileHover={{ backgroundColor: "rgba(255,255,255,0.04)" }}
                    onClick={() => createTab(h.url)}
                    className="history-row"
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6, cursor: "default" }}
                  >
                    <Globe size={11} color="#3a3a3a" style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: "#999", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {h.title || h.url}
                      </div>
                      <div style={{ fontSize: 9, color: "#3a3a3a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {hostOf(h.url)}
                      </div>
                    </div>
                    <span style={{ fontSize: 9, color: "#333", flexShrink: 0 }}>{timeLabel(h.visitedAt)}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeHistory(h.visitedAt, h.url); }}
                      title="Remove"
                      className="history-remove"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#444", display: "flex", flexShrink: 0, padding: 2, opacity: 0 }}
                    >
                      <X size={10} />
                    </button>
                  </motion.div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Cookies / cache / site-data clearing lives here now (moved out of
          Settings › Privacy), alongside history clearing. */}
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "10px 12px", flexShrink: 0 }}>
        <ClearDataSection />
      </div>

      <style>{`.history-row:hover .history-remove { opacity: 1 !important; }`}</style>
    </motion.div>
  );
}

/** Month grid with per-day visit-count heat. Click a day to drill in. */
function CalendarView({ history, onPickDay }: {
  history: HistoryEntry[]; onPickDay: (key: string) => void;
}) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  // Visit counts keyed by toDateString
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of history) {
      const k = dayKey(h.visitedAt);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [history]);

  const max = useMemo(() => Math.max(1, ...[...counts.values()]), [counts]);

  const cells = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const startPad = first.getDay(); // 0=Sun
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < startPad; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(new Date(month.getFullYear(), month.getMonth(), d));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [month]);

  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const todayKey = new Date().toDateString();
  const total = useMemo(() => {
    let n = 0;
    for (const [k, c] of counts) {
      const d = new Date(k);
      if (d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth()) n += c;
    }
    return n;
  }, [counts, month]);

  function heat(count: number): { bg: string; color: string } {
    if (count === 0) return { bg: "rgba(255,255,255,0.03)", color: "#3a3a3a" };
    const t = Math.min(1, count / max);
    const alpha = 0.15 + t * 0.55;
    return { bg: `rgba(79,128,245,${alpha})`, color: t > 0.5 ? "#dfe7ff" : "#9ab0e8" };
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px 16px" }}>
      {/* Month nav */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <button
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          style={{ background: "rgba(255,255,255,0.04)", border: "none", borderRadius: 5, cursor: "pointer", color: "#777", display: "flex", padding: 4 }}
        >
          <ChevronLeft size={13} />
        </button>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "#c0c0c0" }}>{monthLabel}</div>
          <div style={{ fontSize: 9, color: "#3a3a3a" }}>{total} visit{total !== 1 ? "s" : ""}</div>
        </div>
        <button
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          style={{ background: "rgba(255,255,255,0.04)", border: "none", borderRadius: 5, cursor: "pointer", color: "#777", display: "flex", padding: 4 }}
        >
          <ChevronRight size={13} />
        </button>
      </div>

      {/* Weekday header */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} style={{ textAlign: "center", fontSize: 9, color: "#3a3a3a" }}>{d}</div>
        ))}
      </div>

      {/* Day grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {cells.map((cell, i) => {
          if (!cell) return <div key={i} />;
          const key = cell.toDateString();
          const count = counts.get(key) ?? 0;
          const { bg, color } = heat(count);
          const isToday = key === todayKey;
          return (
            <button
              key={i}
              onClick={() => count > 0 && onPickDay(key)}
              title={count > 0 ? `${count} visit${count !== 1 ? "s" : ""}` : "No visits"}
              style={{
                aspectRatio: "1", borderRadius: 6, border: isToday ? "1px solid rgba(79,128,245,0.7)" : "1px solid transparent",
                background: bg, color, cursor: count > 0 ? "pointer" : "default",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                fontSize: 11, gap: 1, transition: "transform 0.1s",
              }}
              onMouseEnter={(e) => { if (count > 0) e.currentTarget.style.transform = "scale(1.08)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
            >
              {cell.getDate()}
              {count > 0 && <span style={{ fontSize: 7.5, opacity: 0.8 }}>{count}</span>}
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 9, color: "#3a3a3a" }}>
        less
        {[0.03, 0.25, 0.45, 0.7].map((a, i) => (
          <span key={i} style={{ width: 11, height: 11, borderRadius: 3, background: `rgba(79,128,245,${a})` }} />
        ))}
        more
      </div>
    </div>
  );
}

function ViewBtn({ active, onClick, title, children }: {
  active: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 22, height: 18, borderRadius: 4, cursor: "pointer", border: "none",
        background: active ? "rgba(79,128,245,0.25)" : "transparent",
        color: active ? "#7a9cf5" : "#555",
      }}
    >
      {children}
    </button>
  );
}
