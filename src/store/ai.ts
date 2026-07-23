import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { v4 as uuidv4 } from "uuid";
import { useBrowserStore } from "./tabs";
import { tauriStorage } from "./tauriStorage";

export interface AiMsg {
  role: "user" | "ai" | "tool";
  text: string;
  streaming?: boolean;
  error?: boolean;
}

/** A named conversation. Not tied to any page — the agent can see and operate
 *  every open tab (list_tabs + tab_id on the page tools), so one thread can
 *  span sites. Threads are just a chat-history manager. */
export interface Thread {
  id: string;
  title: string;
  msgs: AiMsg[];
  createdAt: number;
  updatedAt: number;
}

export function toolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_tabs": return "Listing open tabs";
    case "switch_tab": return "Switching tab";
    case "read_page": return "Reading page";
    case "get_links": return "Scanning links";
    case "find": return `Finding "${args.text ?? ""}"`;
    case "click": return `Clicking ${args.selector ?? ""}`;
    case "fill": return `Typing into ${args.selector ?? ""}`;
    case "select_option": return `Selecting ${args.value ?? ""}`;
    case "navigate": return `Opening ${args.url ?? ""}`;
    case "scroll": return `Scrolling ${args.direction ?? ""}`;
    case "search_history": return `Searching history: ${args.query ?? ""}`;
    case "get_cookies": return "Reading cookies";
    case "remember": return "Saving to memory";
    case "recall": return `Recalling: ${args.query ?? ""}`;
    case "mzcode": return "Running mz agent";
    default: return name;
  }
}

/** First user line → a short thread title. */
function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 42 ? t.slice(0, 42) + "…" : t || "New chat";
}

function freshThread(): Thread {
  const now = Date.now();
  return { id: `thread-${uuidv4()}`, title: "New chat", msgs: [], createdAt: now, updatedAt: now };
}

interface AiStore {
  threads: Thread[];
  activeThreadId: string;
  busy: boolean;
  /** Thread the in-flight ask streams into (survives thread switches) */
  busyThreadId: string;
  lastEventAt: number;

  send: (prompt: string) => Promise<void>;
  stop: () => void;
  newThread: () => void;
  selectThread: (id: string) => void;
  deleteThread: (id: string) => void;
  clearActive: () => void;
}

/** Ensure there is an active thread; returns its id. */
function ensureActive(get: () => AiStore, set: (p: Partial<AiStore>) => void): string {
  const s = get();
  if (s.threads.some((t) => t.id === s.activeThreadId)) return s.activeThreadId;
  const t = freshThread();
  set({ threads: [t, ...s.threads], activeThreadId: t.id });
  return t.id;
}

function patchThread(
  st: AiStore,
  id: string,
  fn: (msgs: AiMsg[]) => AiMsg[],
  touch = true
): Partial<AiStore> {
  return {
    threads: st.threads.map((t) =>
      t.id === id ? { ...t, msgs: fn(t.msgs), updatedAt: touch ? Date.now() : t.updatedAt } : t
    ),
  };
}

export const useAiStore = create<AiStore>()(
  persist(
    (set, get) => ({
      threads: [],
      activeThreadId: "",
      busy: false,
      busyThreadId: "",
      lastEventAt: 0,

      send: async (prompt) => {
        if (get().busy || !prompt.trim()) return;
        const id = ensureActive(get, set as (p: Partial<AiStore>) => void);
        const s = useBrowserStore.getState();
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        const st = s.settings;

        const thread = get().threads.find((t) => t.id === id)!;
        const isFirst = thread.msgs.filter((m) => m.role === "user").length === 0;

        // Prior turns (before this prompt) → multi-turn context for the model
        const history = thread.msgs
          .filter((m) => m.role !== "tool" && !m.error && m.text.trim())
          .slice(-12)
          .map((m) => ({ role: m.role === "ai" ? "assistant" : "user", content: m.text }));

        set((st0) => ({
          busy: true,
          busyThreadId: id,
          lastEventAt: Date.now(),
          threads: st0.threads.map((t) =>
            t.id === id
              ? {
                  ...t,
                  title: isFirst ? titleFrom(prompt) : t.title,
                  updatedAt: Date.now(),
                  msgs: [
                    ...t.msgs,
                    { role: "user", text: prompt.trim() },
                    { role: "ai", text: "", streaming: true },
                  ],
                }
              : t
          ),
        }));

        try {
          await invoke("ask_ai", {
            prompt: prompt.trim(),
            pageUrl: tab?.url ?? "",
            pageTitle: tab?.title ?? "",
            model: st.aiModel,
            provider: st.aiProvider,
            baseUrl: st.aiProvider === "openai" ? st.aiBaseUrl : null,
            apiKey: st.aiProvider === "openai" && st.aiApiKey ? st.aiApiKey : null,
            history,
          });
        } catch (err) {
          set((st0) => ({
            busy: false,
            ...patchThread(st0, id, (msgs) => {
              const out = [...msgs];
              const last = out[out.length - 1];
              if (last && last.role === "ai" && last.streaming) {
                out[out.length - 1] = { role: "ai", text: String(err), error: true };
              } else {
                out.push({ role: "ai", text: String(err), error: true });
              }
              return out;
            }),
          }));
        }
      },

      stop: () => {
        invoke("cancel_ai").catch(() => {});
      },

      newThread: () =>
        set((s) => {
          // Reuse an existing empty thread rather than piling up blanks
          const empty = s.threads.find((t) => t.msgs.length === 0);
          if (empty) return { activeThreadId: empty.id };
          const t = freshThread();
          return { threads: [t, ...s.threads], activeThreadId: t.id };
        }),

      selectThread: (id) => set({ activeThreadId: id }),

      deleteThread: (id) =>
        set((s) => {
          const threads = s.threads.filter((t) => t.id !== id);
          const activeThreadId =
            s.activeThreadId === id ? threads[0]?.id ?? "" : s.activeThreadId;
          return { threads, activeThreadId };
        }),

      clearActive: () =>
        set((s) => ({ threads: s.threads.filter((t) => t.id !== s.activeThreadId), activeThreadId: "" })),
    }),
    {
      name: "zro-ai-chat",
      storage: createJSONStorage(() => tauriStorage("zro-ai-chat")),
      partialize: (s) => ({
        threads: s.threads
          .map((t) => ({
            ...t,
            msgs: t.msgs.filter((m) => m.text.trim().length > 0).slice(-100).map((m) => ({ ...m, streaming: false })),
          }))
          .filter((t) => t.msgs.length > 0)
          .slice(0, 50),
        activeThreadId: s.activeThreadId,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AiStore> & {
          msgs?: AiMsg[];
          histories?: Record<string, AiMsg[]>;
        };
        let threads = p.threads ?? [];
        // Migrate older shapes: single msgs[] or per-domain histories{}
        if (threads.length === 0) {
          const now = Date.now();
          if (p.histories && Object.keys(p.histories).length) {
            threads = Object.entries(p.histories)
              .filter(([, m]) => m.length > 0)
              .map(([domain, msgs]) => ({
                id: `thread-${uuidv4()}`,
                title: domain === "general" ? "General" : domain,
                msgs,
                createdAt: now,
                updatedAt: now,
              }));
          } else if (p.msgs?.length) {
            threads = [{ id: `thread-${uuidv4()}`, title: "Imported chat", msgs: p.msgs, createdAt: now, updatedAt: now }];
          }
        }
        return { ...current, threads, activeThreadId: p.activeThreadId ?? threads[0]?.id ?? "" };
      },
    }
  )
);

// ── Global stream listeners ──────────────────────────────────────────────────
// Wired ONCE at module load. Streams route to busyThreadId, so switching
// threads mid-answer doesn't misfile tokens.
async function wireStreamListeners() {
  await listen<{ token: string }>("ai-token", (e) => {
    useAiStore.setState((st) => ({
      lastEventAt: Date.now(),
      ...patchThread(st, st.busyThreadId, (msgs) => {
        const out = [...msgs];
        const last = out[out.length - 1];
        if (last && last.role === "ai" && last.streaming) {
          out[out.length - 1] = { ...last, text: last.text + e.payload.token };
        } else {
          out.push({ role: "ai", text: e.payload.token, streaming: true });
        }
        return out;
      }),
    }));
  });

  await listen<{ name: string; args: Record<string, unknown> }>("ai-tool", (e) => {
    useAiStore.setState((st) => ({
      lastEventAt: Date.now(),
      ...patchThread(st, st.busyThreadId, (msgs) => {
        let out = [...msgs];
        const last = out[out.length - 1];
        if (last && last.role === "ai" && last.text === "") {
          out = out.slice(0, -1);
        } else if (last && last.role === "ai" && last.streaming) {
          out[out.length - 1] = { ...last, streaming: false };
        }
        out.push({ role: "tool", text: toolLabel(e.payload.name, e.payload.args ?? {}) });
        return out;
      }),
    }));
  });

  await listen("ai-done", () => {
    useAiStore.setState((st) => ({
      busy: false,
      lastEventAt: Date.now(),
      ...patchThread(st, st.busyThreadId, (msgs) => {
        const out = [...msgs];
        const last = out[out.length - 1];
        if (last && last.role === "ai") {
          out[out.length - 1] = { ...last, streaming: false };
        }
        return out;
      }, false),
    }));
  });
}
wireStreamListeners();
