import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  X, Send, Bot, AlertCircle, ChevronDown, Wrench, Terminal,
  Square, MessageSquarePlus, MessagesSquare, Trash2, Check,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useBrowserStore, AiProvider } from "../store/tabs";
import { useAiStore } from "../store/ai";
import Markdown from "./Markdown";

interface Props {
  onClose: () => void;
}

const PROVIDER_LABELS: Record<AiProvider, string> = {
  ollama: "Ollama",
  mzcode: "mz-code",
  openai: "Custom API",
};

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function AiPanel({ onClose }: Props) {
  const { tabs, activeTabId, settings, setSettings } = useBrowserStore();
  const {
    threads, activeThreadId, busy, lastEventAt,
    send, stop, newThread, selectThread, deleteThread,
  } = useAiStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const provider = settings.aiProvider;

  const thread = threads.find((t) => t.id === activeThreadId);
  const msgs = thread?.msgs ?? [];

  const [input, setInput] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [providerOk, setProviderOk] = useState<boolean | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [showProviders, setShowProviders] = useState(false);
  const [showThreads, setShowThreads] = useState(false);
  const [, forceTick] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const busyStartRef = useRef(0);

  const model = settings.aiModel;

  // Provider status + model scan
  useEffect(() => {
    setProviderOk(null);
    setModels([]);
    if (provider === "ollama") {
      invoke<boolean>("check_ollama", {}).then(setProviderOk).catch(() => setProviderOk(false));
      invoke<string[]>("list_ollama_models", {})
        .then((names) => {
          setModels(names);
          if (names.length && !names.includes(settings.aiModel)) setSettings({ aiModel: names[0] });
        })
        .catch(() => {});
    } else if (provider === "mzcode") {
      invoke<boolean>("check_mzcode").then(setProviderOk).catch(() => setProviderOk(false));
    } else {
      invoke<string[]>("list_openai_models", { baseUrl: settings.aiBaseUrl, apiKey: settings.aiApiKey || null })
        .then((names) => {
          setProviderOk(true);
          setModels(names);
          if (names.length && !names.includes(settings.aiModel)) setSettings({ aiModel: names[0] });
        })
        .catch(() => setProviderOk(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, settings.aiBaseUrl, settings.aiApiKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  useEffect(() => {
    if (!busy) return;
    if (!busyStartRef.current) busyStartRef.current = Date.now();
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  if (!busy && busyStartRef.current) busyStartRef.current = 0;

  function doSend() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    busyStartRef.current = Date.now();
    send(text);
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  }

  const statusError =
    providerOk === false
      ? provider === "ollama"
        ? <>Ollama not running — start with <code>ollama serve</code></>
        : provider === "mzcode"
        ? <>mz not found — build mz-code and add it to PATH</>
        : <>Endpoint unreachable — check the URL in Settings</>
      : null;

  const elapsed = busy && busyStartRef.current ? Math.floor((Date.now() - busyStartRef.current) / 1000) : 0;
  const sinceEvent = busy ? Date.now() - lastEventAt : 0;
  const lastToolText = [...msgs].reverse().find((m) => m.role === "tool")?.text;
  const workingLabel =
    sinceEvent > 25_000
      ? "still working — model is slow to respond"
      : lastToolText && msgs[msgs.length - 1]?.role === "tool"
      ? lastToolText
      : "thinking";

  return (
    <motion.div
      // Opacity-only — an x-slide moves the panel via transform, which the
      // overlay's getBoundingClientRect measurement (mount-time, no
      // ResizeObserver signal for transforms) can't track, leaving a sliver
      // of the region hole unpunched for the whole transition.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      style={{
        width: 280, flexShrink: 0, background: "#0f0f0f",
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
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <Bot size={13} color="#4f80f5" style={{ flexShrink: 0 }} />
          <span style={{
            fontSize: 11, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {thread?.title ?? "AI"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
          <HeaderBtn onClick={newThread} title="New chat">
            <MessageSquarePlus size={14} />
          </HeaderBtn>
          {/* Thread manager */}
          <div style={{ position: "relative" }}>
            <HeaderBtn
              onClick={() => { setShowThreads((v) => !v); setShowModels(false); setShowProviders(false); }}
              title="Chats"
              active={showThreads}
            >
              <MessagesSquare size={14} />
            </HeaderBtn>
            {showThreads && (
              <div style={{
                position: "absolute", right: 0, top: "100%", marginTop: 6,
                background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8, zIndex: 99, width: 230, maxHeight: 300, overflowY: "auto",
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
              }}>
                <button
                  onClick={() => { newThread(); setShowThreads(false); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, width: "100%",
                    padding: "8px 10px", fontSize: 11, color: "#7a9cf5",
                    background: "none", border: "none", borderBottom: "1px solid rgba(255,255,255,0.06)",
                    cursor: "pointer",
                  }}
                >
                  <MessageSquarePlus size={12} /> New chat
                </button>
                {threads.length === 0 && (
                  <div style={{ padding: "10px", fontSize: 10, color: "#444" }}>No chats yet</div>
                )}
                {threads.map((t) => (
                  <div
                    key={t.id}
                    onClick={() => { selectThread(t.id); setShowThreads(false); }}
                    className="ai-thread-row"
                    style={{
                      display: "flex", alignItems: "center", gap: 6, padding: "7px 8px 7px 10px",
                      cursor: "pointer",
                      background: t.id === activeThreadId ? "rgba(79,128,245,0.1)" : "transparent",
                    }}
                  >
                    {t.id === activeThreadId
                      ? <Check size={11} color="#4f80f5" style={{ flexShrink: 0 }} />
                      : <span style={{ width: 11, flexShrink: 0 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 11, color: t.id === activeThreadId ? "#c0c8e8" : "#999",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {t.title}
                      </div>
                      <div style={{ fontSize: 9, color: "#3a3a3a" }}>
                        {t.msgs.filter((m) => m.role === "user").length} msg · {timeAgo(t.updatedAt)}
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteThread(t.id); }}
                      title="Delete chat"
                      className="ai-thread-del"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#5a4444", display: "flex", padding: 2, flexShrink: 0, opacity: 0 }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <HeaderBtn onClick={onClose} title="Close (chats are kept)">
            <X size={14} />
          </HeaderBtn>
        </div>
      </div>

      {/* Provider + model row */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4, padding: "7px 10px 0", flexShrink: 0,
      }}>
        <Dropdown
          open={showProviders}
          setOpen={(v) => { setShowProviders(v); if (v) { setShowModels(false); setShowThreads(false); } }}
          label={PROVIDER_LABELS[provider]}
          items={(Object.keys(PROVIDER_LABELS) as AiProvider[]).map((p) => ({ key: p, label: PROVIDER_LABELS[p], active: p === provider }))}
          onPick={(p) => setSettings({ aiProvider: p as AiProvider })}
        />
        {provider !== "mzcode" && (
          <Dropdown
            open={showModels}
            setOpen={(v) => { setShowModels(v); if (v) { setShowProviders(false); setShowThreads(false); } }}
            label={model ? model.split(":")[0].slice(0, 14) : "model…"}
            items={models.map((m) => ({ key: m, label: m, active: m === model }))}
            empty={provider === "ollama" ? "no models — ollama pull …" : "no models found"}
            onPick={(m) => setSettings({ aiModel: m })}
          />
        )}
      </div>

      {statusError && (
        <div style={{
          margin: "8px 10px 0", padding: "7px 10px",
          background: "rgba(220,60,60,0.08)", border: "1px solid rgba(220,60,60,0.15)",
          borderRadius: 6, display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
        }}>
          <AlertCircle size={11} color="#e44" style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: "#e44" }}>{statusError}</span>
        </div>
      )}

      {provider === "mzcode" && providerOk && (
        <div style={{
          margin: "8px 10px 0", padding: "5px 8px",
          background: "rgba(79,245,160,0.04)", border: "1px solid rgba(79,245,160,0.1)",
          borderRadius: 5, display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
        }}>
          <Terminal size={10} color="#4fb56a" />
          <span style={{ fontSize: 9.5, color: "#4a7a5a" }}>mz agent — shell, web search, files, MCP tools</span>
        </div>
      )}

      {/* Context: works across all open tabs */}
      {activeTab && (
        <div style={{
          margin: "8px 10px 0", padding: "5px 8px",
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 5, flexShrink: 0,
        }}>
          <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.08em", marginBottom: 2 }}>
            CONTEXT · <span style={{ color: "#3a4a6a" }}>{tabs.length} tab{tabs.length !== 1 ? "s" : ""} · all reachable</span>
          </div>
          <div style={{ fontSize: 10, color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {activeTab.title || activeTab.url}
          </div>
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 10px 4px" }}>
        {msgs.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 32, gap: 8 }}>
            <Bot size={22} color="#222" />
            <div style={{ fontSize: 11, color: "#2a2a2a", textAlign: "center", lineHeight: 1.5 }}>
              Ask about any open tab<br />or anything else
            </div>
          </div>
        )}
        {msgs.map((msg, i) => (
          msg.role === "tool" ? (
            <div key={i} style={{
              marginBottom: 8, display: "flex", alignItems: "center", gap: 6,
              padding: "4px 8px", borderRadius: 6,
              background: "rgba(79,128,245,0.06)", border: "1px dashed rgba(79,128,245,0.2)",
            }}>
              <Wrench size={10} color="#4f80f5" />
              <span style={{ fontSize: 10, color: "#4f80f5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {msg.text}
              </span>
              {busy && i === msgs.length - 1 && <PulseDot />}
            </div>
          ) : (
          <div key={i} style={{
            marginBottom: 8, display: "flex",
            justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
          }}>
            <div style={{
              maxWidth: "88%", padding: "7px 10px",
              borderRadius: msg.role === "user" ? "10px 10px 3px 10px" : "10px 10px 10px 3px",
              background: msg.error ? "rgba(220,60,60,0.08)" : msg.role === "user" ? "rgba(79,128,245,0.18)" : "rgba(255,255,255,0.04)",
              border: msg.error ? "1px solid rgba(220,60,60,0.2)" : msg.role === "user" ? "1px solid rgba(79,128,245,0.2)" : "1px solid rgba(255,255,255,0.05)",
              fontSize: 12, color: msg.error ? "#d66" : msg.role === "user" ? "#c0c8e8" : "#8a8a8a",
              lineHeight: 1.55, wordBreak: "break-word",
              whiteSpace: msg.role === "user" ? "pre-wrap" : "normal",
            }}>
              {msg.role === "ai" && !msg.error ? <Markdown text={msg.text} /> : msg.text}
              {msg.streaming && msg.text !== "" && (
                <span style={{ display: "inline-block", width: 6, height: 12, marginLeft: 2, background: "#4f80f5", borderRadius: 1, verticalAlign: "middle", animation: "blink 0.8s step-end infinite" }} />
              )}
              {msg.streaming && msg.text === "" && (
                <span style={{ display: "inline-flex", gap: 3, padding: "2px 0" }}>
                  <Dot d={0} /><Dot d={0.15} /><Dot d={0.3} />
                </span>
              )}
            </div>
          </div>
          )
        ))}
        <div ref={bottomRef} />
      </div>

      {busy && (
        <div style={{
          display: "flex", alignItems: "center", gap: 7, margin: "0 10px 6px", padding: "6px 9px",
          background: "rgba(79,128,245,0.05)", border: "1px solid rgba(79,128,245,0.12)",
          borderRadius: 7, flexShrink: 0,
        }}>
          <PulseDot />
          <span style={{
            fontSize: 10, color: sinceEvent > 25_000 ? "#c99a4a" : "#5a7ac8",
            flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {workingLabel} · {elapsed}s
          </span>
          <button
            onClick={stop} title="Stop"
            style={{
              display: "flex", alignItems: "center", gap: 4,
              background: "rgba(220,60,60,0.12)", border: "1px solid rgba(220,60,60,0.2)",
              borderRadius: 4, color: "#d66", fontSize: 9.5, padding: "2px 7px", cursor: "pointer",
            }}
          >
            <Square size={8} fill="#d66" /> Stop
          </button>
        </div>
      )}

      {/* Input */}
      <div style={{ padding: "8px 10px 10px", borderTop: "1px solid rgba(255,255,255,0.05)", flexShrink: 0 }}>
        <div style={{
          display: "flex", alignItems: "flex-end", gap: 6,
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 8, padding: "6px 8px",
        }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={provider === "mzcode" ? "Ask mz anything…" : "Ask anything…"}
            rows={1}
            disabled={busy || providerOk === false}
            style={{
              flex: 1, background: "none", border: "none", outline: "none", resize: "none",
              fontSize: 12, color: "#aaa", lineHeight: 1.5, fontFamily: "inherit", maxHeight: 80, overflow: "auto",
            }}
          />
          <button
            onClick={doSend}
            disabled={busy || !input.trim() || providerOk === false}
            style={{
              background: busy ? "rgba(79,128,245,0.15)" : "rgba(79,128,245,0.25)",
              border: "none", borderRadius: 5, cursor: busy ? "default" : "pointer",
              color: busy ? "#2a3a60" : "#4f80f5",
              display: "flex", alignItems: "center", padding: "4px 6px", transition: "all 0.15s", flexShrink: 0,
            }}
          >
            <Send size={12} />
          </button>
        </div>
        <div style={{ fontSize: 9, color: "#222", marginTop: 4, textAlign: "center" }}>
          Enter to send · Shift+Enter newline
        </div>
      </div>

      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes zro-pulse { 0%,100%{opacity:0.35;transform:scale(0.85)} 50%{opacity:1;transform:scale(1.1)} }
        @keyframes zro-bounce { 0%,80%,100%{opacity:0.25} 40%{opacity:1} }
        .ai-thread-row:hover { background: rgba(255,255,255,0.04) !important; }
        .ai-thread-row:hover .ai-thread-del { opacity: 1 !important; }
      `}</style>
    </motion.div>
  );
}

/** Header icon button with a real 26px hit area — the bare 13px icons were
 *  too small / too close to press reliably. */
function HeaderBtn({ children, onClick, title, active }: {
  children: React.ReactNode; onClick: () => void; title: string; active?: boolean;
}) {
  return (
    <motion.button
      onClick={onClick}
      title={title}
      whileHover={{ backgroundColor: "rgba(255,255,255,0.08)", color: "#ccc" }}
      whileTap={{ scale: 0.9 }}
      transition={{ duration: 0.1 }}
      animate={{ color: active ? "#7a9cf5" : "#555", backgroundColor: active ? "rgba(79,128,245,0.12)" : "rgba(0,0,0,0)" }}
      style={{
        width: 26, height: 26, borderRadius: 6, border: "none", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0,
      }}
    >
      {children}
    </motion.button>
  );
}

function PulseDot() {
  return (
    <span style={{
      width: 7, height: 7, borderRadius: "50%", background: "#4f80f5",
      display: "inline-block", flexShrink: 0, animation: "zro-pulse 1.1s ease-in-out infinite",
    }} />
  );
}

function Dot({ d }: { d: number }) {
  return (
    <span style={{
      width: 5, height: 5, borderRadius: "50%", background: "#4f80f5",
      display: "inline-block", animation: `zro-bounce 1.2s ease-in-out ${d}s infinite`,
    }} />
  );
}

function Dropdown({ open, setOpen, label, items, empty, onPick }: {
  open: boolean; setOpen: (v: boolean) => void; label: string;
  items: Array<{ key: string; label: string; active: boolean }>;
  empty?: string; onPick: (key: string) => void;
}) {
  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: 4, cursor: "pointer", color: "#666", fontSize: 10,
          padding: "3px 7px", display: "flex", alignItems: "center", gap: 3,
          maxWidth: 120, whiteSpace: "nowrap",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
        <ChevronDown size={9} style={{ flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{
          position: "absolute", left: 0, top: "100%", marginTop: 4,
          background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 6, zIndex: 99, minWidth: 150, maxHeight: 220, overflowY: "auto",
          boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        }}>
          {items.length === 0 && (
            <div style={{ padding: "8px 10px", fontSize: 10, color: "#444" }}>{empty ?? "empty"}</div>
          )}
          {items.map((it) => (
            <button
              key={it.key}
              onClick={() => { onPick(it.key); setOpen(false); }}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "6px 10px", fontSize: 11,
                color: it.active ? "#4f80f5" : "#666", background: "none", border: "none", cursor: "pointer",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
