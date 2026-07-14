import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { X, Activity, Cpu, MemoryStick, HardDrive, Moon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useBrowserStore } from "../store/tabs";

interface MemoryInfo {
  total_ram_mb: number;
  used_ram_mb: number;
  process_mb: number;
  webview_mb: number;
  cpu_pct: number;
  zro_cpu_pct: number;
}

interface ProcRow {
  pid: number;
  kind: string;
  mb: number;
  sources: string[];
}

interface Breakdown {
  procs: ProcRow[];
  suspended: string[];
}

interface DiskItem {
  name: string;
  bytes: number;
}

function fmtBytes(b: number): string {
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${Math.round(b / (1 << 20))} MB`;
  if (b >= 1 << 10) return `${Math.round(b / (1 << 10))} KB`;
  return `${b} B`;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

interface Props {
  onClose: () => void;
}

function meterColor(pct: number): string {
  return pct > 85 ? "#e44" : pct > 65 ? "#e8a030" : "#4f80f5";
}

export default function StatsPanel({ onClose }: Props) {
  const { tabs, activeTabId, isIncognito, updateTab } = useBrowserStore();
  const [mem, setMem] = useState<MemoryInfo | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [disk, setDisk] = useState<DiskItem[] | null>(null);
  const [trim, setTrim] = useState<"idle" | "busy" | number>("idle");

  // Clears the rebuildable parts only (HTTP cache + service-worker caches) —
  // cookies, logins, history and site storage stay. Auto-runs at 512 MB too.
  function trimCache() {
    if (trim === "busy") return;
    setTrim("busy");
    invoke<number>("trim_cache")
      .then((freed) => {
        setTrim(freed);
        invoke<DiskItem[]>("get_disk_usage").then(setDisk).catch(() => {});
        setTimeout(() => setTrim("idle"), 4000);
      })
      .catch(() => setTrim("idle"));
  }

  useEffect(() => {
    function refresh() {
      invoke<MemoryInfo>("get_memory_info").then(setMem).catch(() => {});
      invoke<Breakdown>("get_process_breakdown").then(setBreakdown).catch(() => {});
    }
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, []);

  // Disk walk is a full recursive directory scan — once per panel open
  useEffect(() => {
    invoke<DiskItem[]>("get_disk_usage").then(setDisk).catch(() => {});
  }, []);

  // The UI store itself (tabs, history, settings) lives in localStorage
  const storeBytes = (localStorage.getItem("zro-store") ?? "").length;

  const ramPct = mem ? (mem.used_ram_mb / mem.total_ram_mb) * 100 : 0;
  const zroMb = mem ? mem.process_mb + mem.webview_mb : 0;
  const zroPct = mem ? (zroMb / mem.total_ram_mb) * 100 : 0;

  const frozenSet = useMemo(() => new Set(breakdown?.suspended ?? []), [breakdown]);
  const frozenCount = tabs.filter((t) => frozenSet.has(t.id)).length;
  const asleepCount = tabs.filter((t) => t.hibernated).length;

  // Attribute renderer processes to tabs by the pages they host. Same-site
  // tabs share one renderer (Chromium site isolation) — those show as one
  // row listing every tab in it. Everything non-renderer folds into a single
  // "engine" row: browser broker, GPU, network/storage utilities.
  const ramRows = useMemo(() => {
    if (!breakdown) return null;
    const rows: { key: string; label: string; mb: number; tabIds: string[]; frozen: boolean }[] = [];
    let engineMb = 0;
    let engineCount = 0;
    for (const p of breakdown.procs) {
      if (p.kind !== "renderer") {
        engineMb += p.mb;
        engineCount++;
        continue;
      }
      const matched = tabs.filter((t) =>
        p.sources.some((src) => src === t.url || (hostOf(src) && hostOf(src) === hostOf(t.url)))
      );
      if (matched.length > 0) {
        rows.push({
          key: `p${p.pid}`,
          label: matched.map((t) => t.title || hostOf(t.url) || "tab").join(" · "),
          mb: p.mb,
          tabIds: matched.map((t) => t.id),
          frozen: matched.every((t) => frozenSet.has(t.id)),
        });
      } else {
        const host = hostOf(p.sources[0] ?? "");
        rows.push({
          key: `p${p.pid}`,
          label: host ? `${host} (background)` : "Page renderer",
          mb: p.mb,
          tabIds: [],
          frozen: false,
        });
      }
    }
    rows.sort((a, b) => b.mb - a.mb);
    if (engineCount > 0) {
      rows.push({
        key: "engine",
        label: `Engine (browser · GPU · ${engineCount} procs)`,
        mb: engineMb,
        tabIds: [],
        frozen: false,
      });
    }
    return rows;
  }, [breakdown, tabs, frozenSet]);

  /** Put a whole renderer row to sleep — hibernates every tab it hosts. */
  function sleepRow(tabIds: string[]) {
    for (const id of tabIds) {
      if (id === activeTabId) continue;
      invoke("hibernate_tab", { id })
        .then(() => updateTab(id, { hibernated: true, suspended: false }))
        .catch(() => {});
    }
    setTimeout(() => {
      invoke<Breakdown>("get_process_breakdown").then(setBreakdown).catch(() => {});
    }, 800);
  }

  return (
    <motion.div
      // Opacity-only — an x-slide moves the panel via transform, which the
      // overlay's rect tracking can't follow, so the region hole (a black
      // box) sits still while the content slides.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      style={{
        width: 300,
        flexShrink: 0,
        background: "#0f0f0f",
        borderLeft: "1px solid rgba(255,255,255,0.1)",
        boxShadow: "inset 16px 0 28px -20px rgba(0,0,0,0.8)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* Header — same form as Settings / History */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 12px 9px",
        borderBottom: "1px solid rgba(255,255,255,0.05)", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Activity size={13} color="#4f80f5" />
          <span style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Usage
          </span>
        </div>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#444", display: "flex" }}
        >
          <X size={13} />
        </button>
      </div>

      <div style={{ flex: 1, padding: "10px 14px 16px", display: "flex", flexDirection: "column", gap: 8, overflowY: "auto" }}>
        {/* Counts — big numbers, read at a glance */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
          <Tile label="Tabs" value={tabs.length} />
          <Tile label="Frozen" value={frozenCount} accent={frozenCount > 0 ? "#5a9ad8" : undefined} />
          <Tile label="Asleep" value={asleepCount} accent={asleepCount > 0 ? "#8a6ad8" : undefined} />
        </div>

        {/* Machine load */}
        {mem && (
          <Card icon={<Cpu size={12} />} title="System">
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Meter
                label="CPU"
                pct={mem.cpu_pct}
                right={`${Math.round(mem.cpu_pct)}%`}
                sub={`zro ${mem.zro_cpu_pct.toFixed(1)}%`}
              />
              <Meter
                label="RAM"
                pct={ramPct}
                right={`${Math.round(ramPct)}%`}
                sub={`${mem.used_ram_mb.toLocaleString()} / ${mem.total_ram_mb.toLocaleString()} MB`}
              />
              <Meter
                label="zro"
                pct={zroPct}
                right={`${zroMb.toLocaleString()} MB`}
                sub={`app ${mem.process_mb} MB · tab engines ${mem.webview_mb.toLocaleString()} MB (private footprint)`}
                color="#8a6ad8"
              />
            </div>
          </Card>
        )}

        {/* What's actually eating RAM — renderers attributed to their tabs */}
        {ramRows && ramRows.length > 0 && (() => {
          const max = Math.max(...ramRows.map((r) => r.mb), 1);
          return (
            <Card icon={<MemoryStick size={12} />} title="Memory by tab">
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {ramRows.map((r) => {
                  const sleepable = r.tabIds.some((id) => id !== activeTabId);
                  return (
                    <div key={r.key}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                        <span style={{
                          flex: 1, fontSize: 9.5, color: "#888",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {r.label}
                        </span>
                        {r.frozen && (
                          <span style={{ fontSize: 8, color: "#5a9ad8", flexShrink: 0, border: "1px solid rgba(90,154,216,0.35)", borderRadius: 3, padding: "0 4px" }}>
                            frozen
                          </span>
                        )}
                        {sleepable && (
                          <button
                            onClick={() => sleepRow(r.tabIds)}
                            title="Sleep now — frees this renderer entirely"
                            style={{ background: "none", border: "none", cursor: "pointer", color: "#4a4a6a", display: "flex", padding: 1, flexShrink: 0 }}
                          >
                            <Moon size={10} />
                          </button>
                        )}
                        <span style={{ fontSize: 9.5, color: "#999", fontVariantNumeric: "tabular-nums", flexShrink: 0, minWidth: 44, textAlign: "right" }}>
                          {r.mb.toLocaleString()} MB
                        </span>
                      </div>
                      <div style={{ height: 3, borderRadius: 2, background: "rgba(255,255,255,0.05)", overflow: "hidden" }}>
                        <div style={{
                          height: "100%", borderRadius: 2, width: `${Math.max(2, (r.mb / max) * 100)}%`,
                          background: r.frozen ? "#3a5a7a" : "#8a6ad8", transition: "width 0.4s ease",
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <Hint>Same-site tabs share one renderer — they appear as one row. Frozen rows keep their state but release RAM back to Windows.</Hint>
            </Card>
          );
        })()}

        {/* Disk — what the browser's data costs on disk */}
        {disk && disk.length > 0 && (() => {
          const rows = [...disk, { name: "History + settings (UI store)", bytes: storeBytes }];
          const max = Math.max(...rows.map((d) => d.bytes), 1);
          const total = rows.reduce((a, d) => a + d.bytes, 0);
          return (
            <Card icon={<HardDrive size={12} />} title={`Disk · ${fmtBytes(total)}`}>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {rows.map((d) => (
                  <div key={d.name}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 9.5, color: "#666", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
                      <span style={{ fontSize: 9.5, color: "#888", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{fmtBytes(d.bytes)}</span>
                    </div>
                    <div style={{ height: 3, borderRadius: 2, background: "rgba(255,255,255,0.05)", overflow: "hidden" }}>
                      <div style={{
                        height: "100%", borderRadius: 2, width: `${Math.max(2, (d.bytes / max) * 100)}%`,
                        background: "#4a8a6a", transition: "width 0.4s ease",
                      }} />
                    </div>
                  </div>
                ))}
              </div>
              <button
                onClick={trimCache}
                disabled={trim === "busy"}
                style={{
                  marginTop: 10, width: "100%", padding: "6px 0",
                  background: "rgba(74,138,106,0.1)", border: "1px solid rgba(74,138,106,0.3)",
                  borderRadius: 6, color: "#5aa07a", fontSize: 10.5,
                  cursor: trim === "busy" ? "default" : "pointer",
                }}
              >
                {trim === "busy" ? "Trimming…" : typeof trim === "number" ? `Freed ${trim} MB` : "Trim cache"}
              </button>
              <Hint>Trim clears the page cache only — logins, cookies, history and site data stay. Runs by itself past 512 MB.</Hint>
            </Card>
          );
        })()}

        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: "auto", paddingTop: 8 }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
            background: isIncognito ? "rgba(150,80,220,0.9)" : "#2a4a2a",
          }} />
          <span style={{ fontSize: 10, color: isIncognito ? "rgba(150,80,220,0.7)" : "#3a3a3a" }}>
            {isIncognito ? "Incognito — history paused" : "History recording"}
          </span>
        </div>
      </div>
    </motion.div>
  );
}

/** Same card form as the Settings panel — panels must read as one family. */
function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: 12, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10, fontSize: 11, color: "#999", fontWeight: 500 }}>
        <span style={{ color: "#4f80f5", display: "flex" }}>{icon}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 9.5, color: "#3a3a3a", marginTop: 8, lineHeight: 1.5 }}>{children}</div>;
}

/** Big number over a small label — the count IS the display. */
function Tile({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div style={{
      padding: "8px 10px", borderRadius: 8,
      background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)",
    }}>
      <div style={{
        fontSize: 20, fontWeight: 300, lineHeight: 1.1, color: accent ?? "#999",
        fontVariantNumeric: "tabular-nums",
      }}>
        {value.toLocaleString()}
      </div>
      <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}

/** Label + bar + value on one line; detail line under it. */
function Meter({ label, pct, right, sub, color }: {
  label: string; pct: number; right: string; sub?: string; color?: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 9.5, color: "#555", width: 26, flexShrink: 0, letterSpacing: "0.06em" }}>{label}</span>
        <div style={{ flex: 1, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: 2,
            width: `${clamped}%`,
            background: color ?? meterColor(clamped),
            transition: "width 0.4s ease",
          }} />
        </div>
        <span style={{ fontSize: 10, color: "#888", fontVariantNumeric: "tabular-nums", flexShrink: 0, minWidth: 34, textAlign: "right" }}>
          {right}
        </span>
      </div>
      {sub && (
        <div style={{ fontSize: 9, color: "#3a3a3a", paddingLeft: 34 }}>{sub}</div>
      )}
    </div>
  );
}
