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

  await listen<{ kind: string; item: DownloadItem }>("download-event", (e) => {
    const { kind, item } = e.payload;
    useDownloadsStore.setState((s) => {
      const rest = s.items.filter((i) => i.id !== item.id);
      return {
        items: [item, ...rest].sort((a, b) => b.started_at - a.started_at),
        unseen: kind === "started" ? s.unseen + 1 : s.unseen,
      };
    });
  });
}
wireDownloads();
