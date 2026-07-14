import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Trash2, Copy, Check, Plus, ChevronRight } from "lucide-react";
import { useBrowserStore } from "../store/tabs";

// Live view of the WebView2 cookie jar for the active page. Plain list — one
// row per cookie, expand a row to see and copy the full value.
// Backend commands live in browser/cookies.rs.

interface CookieInfo {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
}

export default function CookieEditor() {
  const { tabs, activeTabId } = useBrowserStore();
  const activeUrl = tabs.find((t) => t.id === activeTabId)?.url ?? "";

  const [cookies, setCookies] = useState<CookieInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    invoke<CookieInfo[]>("get_cookies", {})
      .then((c) => setCookies(c.sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load, activeUrl]);

  async function remove(c: CookieInfo) {
    await invoke("delete_cookie", { name: c.name, domain: c.domain, path: c.path }).catch(() => {});
    load();
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        <button onClick={load} style={miniBtn}>
          <RefreshCw size={10} style={{ animation: loading ? "spin 0.8s linear infinite" : "none" }} /> Refresh
        </button>
        <button onClick={() => setAdding((v) => !v)} style={{ ...miniBtn, color: adding ? "#7a9cf5" : "#666" }}>
          <Plus size={10} /> Add
        </button>
      </div>

      {adding && <AddCookie url={activeUrl} onDone={() => { setAdding(false); load(); }} />}

      {err && (
        <div style={{ fontSize: 9.5, color: "#c96a6a", padding: "4px 0", lineHeight: 1.4 }}>{err}</div>
      )}

      {!err && cookies.length === 0 && !loading && (
        <div style={{ fontSize: 9.5, color: "#3a3a3a", padding: "4px 0" }}>
          No cookies for this page.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {cookies.map((c) => {
          const key = `${c.domain}${c.path}${c.name}`;
          return (
            <CookieRow
              key={key}
              cookie={c}
              open={open === key}
              onToggle={() => setOpen(open === key ? null : key)}
              onDelete={() => remove(c)}
            />
          );
        })}
      </div>
    </div>
  );
}

function CookieRow({ cookie: c, open, onToggle, onDelete }: {
  cookie: CookieInfo; open: boolean; onToggle: () => void; onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${c.name}=${c.value}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  }

  return (
    <div style={{ borderRadius: 4, background: "rgba(255,255,255,0.02)", overflow: "hidden" }}>
      {/* Header row — click to expand */}
      <div
        onClick={onToggle}
        style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 6px", cursor: "pointer" }}
      >
        <ChevronRight
          size={10}
          color="#444"
          style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {c.name}
            {c.httpOnly && <Tag>HTTP</Tag>}
            {c.secure && <Tag>SEC</Tag>}
            {c.session && <Tag>SESSION</Tag>}
          </div>
          <div style={{ fontSize: 8.5, color: "#3a3a3a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {c.domain}{c.path}
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete"
          style={iconBtn}
        >
          <Trash2 size={11} />
        </button>
      </div>

      {/* Expanded — full copyable value */}
      {open && (
        <div style={{ padding: "0 6px 6px 20px" }}>
          <div style={{ position: "relative" }}>
            <pre style={{
              fontSize: 9.5, color: "#9a9a9a", background: "#080808",
              border: "1px solid rgba(255,255,255,0.06)", borderRadius: 5,
              padding: "6px 8px", margin: 0, maxHeight: 120, overflow: "auto",
              whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "ui-monospace, monospace",
              userSelect: "text",
            }}>
              {c.value || "(empty)"}
            </pre>
            <button
              onClick={copy}
              title="Copy name=value"
              style={{
                position: "absolute", top: 4, right: 4, display: "flex", alignItems: "center", gap: 3,
                fontSize: 9, padding: "2px 6px", borderRadius: 4, cursor: "pointer",
                background: "rgba(20,20,20,0.9)", border: "1px solid rgba(255,255,255,0.08)",
                color: copied ? "#4fb56a" : "#888",
              }}
            >
              {copied ? <Check size={9} /> : <Copy size={9} />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {!c.session && c.expires > 0 && (
            <div style={{ fontSize: 8.5, color: "#3a3a3a", marginTop: 4 }}>
              Expires {new Date(c.expires * 1000).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddCookie({ url, onDone }: { url: string; onDone: () => void }) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [domain, setDomain] = useState(host);

  async function save() {
    if (!name || !domain) return;
    await invoke("set_cookie", { name, value, domain, path: "/" }).catch(() => {});
    onDone();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8, padding: 6, background: "rgba(255,255,255,0.02)", borderRadius: 5 }}>
      <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} style={addInput} />
      <input placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} style={addInput} />
      <input placeholder="domain" value={domain} onChange={(e) => setDomain(e.target.value)} style={addInput} />
      <button onClick={save} style={{ ...miniBtn, justifyContent: "center", color: "#7a9cf5" }}>Save cookie</button>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 7.5, color: "#555", border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 3, padding: "0 3px", marginLeft: 4, verticalAlign: "middle",
    }}>
      {children}
    </span>
  );
}

const miniBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, padding: "4px 7px",
  borderRadius: 4, cursor: "pointer", color: "#666",
  border: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.03)",
};

const iconBtn: React.CSSProperties = {
  background: "none", border: "none", cursor: "pointer", color: "#5a4444",
  display: "flex", flexShrink: 0, padding: 2,
};

const addInput: React.CSSProperties = {
  fontSize: 10, color: "#aaa", background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.07)", borderRadius: 4, padding: "4px 6px",
};
