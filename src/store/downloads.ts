import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface DownloadItem {
  id: number;
  url: string;
  path: string;
  filename: string;
  state: "active" | "done" | "failed";
  started_at: number;
  reason?: string | null;
  // live progress (active only) — fed by "progress" events from WebView2
  received?: number;      // bytes so far
  total?: number;         // total bytes (0/undefined = unknown length)
  speed?: number;         // bytes/sec, smoothed
  _lastTs?: number;       // internal: last speed-sample time (perf.now ms)
  _lastBytes?: number;    // internal: bytes at last speed sample
}

interface DownloadsStore {
  items: DownloadItem[];
  /** Bumped on every new download while the panel is closed — badge pulse */
  unseen: number;
  markSeen: () => void;
  clearFinished: () => Promise<void>;
  /** Delete the downloaded FILE from disk and drop the row */
  deleteFile: (id: number) => Promise<void>;
}

export const useDownloadsStore = create<DownloadsStore>()((set) => ({
  items: [],
  unseen: 0,
  markSeen: () => set({ unseen: 0 }),
  clearFinished: async () => {
    await invoke("clear_downloads").catch(() => {});
    set((s) => ({ items: s.items.filter((i) => i.state === "active") }));
  },
  deleteFile: async (id) => {
    await invoke("delete_download", { id });
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },
}));

// Module-level wiring — mirrors ai.ts: survives panel close and StrictMode
async function wireDownloads() {
  // Anything already tracked this session (e.g. UI reloaded via HMR)
  invoke<DownloadItem[]>("list_downloads")
    .then((items) => useDownloadsStore.setState({ items }))
    .catch(() => {});

  await listen<{ kind: string; item?: DownloadItem; uri?: string; received?: number; total?: number }>(
    "download-event",
    (e) => {
      const p = e.payload;

      // Byte-progress tick — no full item, just update the matching active row.
      if (p.kind === "progress") {
        useDownloadsStore.setState((s) => {
          const uri = p.uri || "";
          // match by url; redirected downloads change url, so fall back to the
          // newest still-active row (mirrors the backend's Finished matching).
          let idx = s.items.findIndex((i) => i.state === "active" && i.url === uri);
          if (idx < 0) idx = s.items.findIndex((i) => i.state === "active");
          if (idx < 0) return s;
          const now = performance.now();
          const items = s.items.slice();
          const it = { ...items[idx] };
          const rec = p.received ?? 0;
          if (it._lastTs == null) {
            it._lastTs = now; it._lastBytes = rec;
          } else {
            const dt = (now - it._lastTs) / 1000;
            if (dt >= 0.3) {
              it.speed = Math.max(0, (rec - (it._lastBytes ?? 0)) / dt);
              it._lastTs = now; it._lastBytes = rec;
            }
          }
          it.received = rec;
          if (p.total && p.total > 0) it.total = p.total;
          items[idx] = it;
          return { items };
        });
        return;
      }

      // started / finished — carries a full DownloadInfo.
      const { kind, item } = p;
      if (!item) return;
      useDownloadsStore.setState((s) => {
        const prev = s.items.find((i) => i.id === item.id);
        const rest = s.items.filter((i) => i.id !== item.id);
        // preserve live progress fields across a "finished" replace so the row
        // doesn't flicker; finished rows just stop updating.
        const merged = kind === "finished" && prev
          ? { ...item, received: prev.received, total: prev.total }
          : item;
        return {
          items: [merged, ...rest].sort((a, b) => b.started_at - a.started_at),
          unseen: kind === "started" ? s.unseen + 1 : s.unseen,
        };
      });
    }
  );
}
wireDownloads();
