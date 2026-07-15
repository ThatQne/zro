import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Extension {
  id: string;
  name: string;
  enabled: boolean;
  version: string;
  popup: string | null;
  has_icon: boolean;
  /** Dev extension loaded from a user folder (vs a Web Store CRX we manage) */
  unpacked: boolean;
}

interface ExtStore {
  items: Extension[];
  /** Extension ids pinned to the top bar (own icon) */
  pinned: string[];
  /** Data-URL icon cache, keyed by ext id */
  icons: Record<string, string>;
  loading: boolean;
  error: string | null;

  /** Store ids that have been auto-install-attempted this session (success
   *  or failure) — keeps autoInstall from retrying every render. */
  attempted: Record<string, true>;
  /** Per-id failure reason, kept around so the UI can show why without a button. */
  autoErrors: Record<string, string>;
  /** Ids currently mid-reload — spins the reload button. */
  reloading: Record<string, true>;

  refresh: () => Promise<void>;
  reload: (extId: string) => Promise<void>;
  installCrx: (extId: string) => Promise<void>;
  /** Fire-and-forget: installs `extId` once per session, no button needed. */
  autoInstall: (extId: string) => void;
  installUnpacked: () => Promise<void>;
  remove: (extId: string) => Promise<void>;
  setEnabled: (extId: string, enabled: boolean) => Promise<void>;
  togglePin: (extId: string) => void;
  isInstalled: (extId: string) => boolean;
}

export const useExtStore = create<ExtStore>()(
  persist(
    (set, get) => ({
      items: [],
      pinned: [],
      icons: {},
      loading: false,
      error: null,
      attempted: {},
      autoErrors: {},
      reloading: {},

      refresh: async () => {
        set({ loading: true });
        try {
          const items = await invoke<Extension[]>("list_extensions");
          set({ items, loading: false, error: null });
          // Fetch any icons we don't have yet
          for (const ext of items) {
            if (ext.has_icon && !get().icons[ext.id]) {
              invoke<string | null>("get_extension_icon", { extId: ext.id })
                .then((icon) => {
                  if (icon) set((s) => ({ icons: { ...s.icons, [ext.id]: icon } }));
                })
                .catch(() => {});
            }
          }
          // Drop pins for extensions no longer installed
          const ids = new Set(items.map((i) => i.id));
          set((s) => ({ pinned: s.pinned.filter((p) => ids.has(p)) }));
        } catch (e) {
          set({ loading: false, error: String(e) });
        }
      },

      reload: async (extId) => {
        set((s) => ({ reloading: { ...s.reloading, [extId]: true }, error: null }));
        try {
          await invoke<Extension>("reload_extension", { extId });
          await get().refresh();
        } catch (e) {
          set({ error: String(e) });
        } finally {
          set((s) => {
            const { [extId]: _drop, ...rest } = s.reloading;
            return { reloading: rest };
          });
        }
      },

      installCrx: async (extId) => {
        set({ loading: true, error: null });
        try {
          await invoke<Extension>("install_crx_extension", { extId });
          await get().refresh();
        } catch (e) {
          set({ loading: false, error: String(e) });
          throw e;
        }
      },

      autoInstall: (extId) => {
        const s = get();
        if (s.attempted[extId] || s.isInstalled(extId)) return;
        set((s) => ({ attempted: { ...s.attempted, [extId]: true } }));
        s.installCrx(extId).catch((e) => {
          set((s) => ({ autoErrors: { ...s.autoErrors, [extId]: String(e) } }));
        });
      },

      installUnpacked: async () => {
        set({ loading: true, error: null });
        try {
          await invoke<Extension | null>("install_unpacked_extension");
          await get().refresh();
        } catch (e) {
          set({ loading: false, error: String(e) });
          throw e;
        }
      },

      remove: async (extId) => {
        try {
          await invoke("remove_extension", { extId });
          set((s) => ({
            pinned: s.pinned.filter((p) => p !== extId),
          }));
          await get().refresh();
        } catch (e) {
          set({ error: String(e) });
        }
      },

      setEnabled: async (extId, enabled) => {
        try {
          await invoke("set_extension_enabled", { extId, enabled });
          set((s) => ({
            items: s.items.map((i) => (i.id === extId ? { ...i, enabled } : i)),
          }));
        } catch (e) {
          set({ error: String(e) });
        }
      },

      togglePin: (extId) =>
        set((s) => ({
          pinned: s.pinned.includes(extId)
            ? s.pinned.filter((p) => p !== extId)
            : [...s.pinned, extId],
        })),

      isInstalled: (extId) => get().items.some((i) => i.id === extId),
    }),
    {
      name: "zro-extensions",
      // Only pins persist; items/icons are refetched from WebView2 each launch
      partialize: (s) => ({ pinned: s.pinned }),
    }
  )
);

// Native side re-installs on launch (WebView2 persists them); refresh once the
// window is up, and whenever the backend signals a change.
async function wireExtensions() {
  // Slight delay so a webview exists to talk to the profile
  setTimeout(() => useExtStore.getState().refresh(), 1500);
  await listen("extensions-changed", () => useExtStore.getState().refresh());
}
wireExtensions();
