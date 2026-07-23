import { invoke } from "@tauri-apps/api/core";
import type { StateStorage } from "zustand/middleware";

/**
 * Durable storage backend for zustand `persist`, replacing WebView2
 * localStorage as the source of truth.
 *
 * localStorage lives in a leveldb that Chromium discards WHOLE when it
 * corrupts (unclean shutdown, or a second process touching the profile during
 * a default-browser "open localhost" launch) — which is how a full session of
 * tabs + history vanished with no restore. This mirrors every write to a plain
 * JSON file on disk (via the `save_session` / `load_session` Rust commands) and
 * reads from the file first, so a localStorage rebuild can no longer lose data.
 *
 * localStorage is still written as a fast cache and, for users upgrading from
 * the old build, is the migration source on first load before any file exists.
 */
export function tauriStorage(name: string): StateStorage {
  return {
    getItem: async (key) => {
      // File is authoritative. Empty string = a prior removeItem → treat as
      // absent so callers see "no state", not an unparseable "".
      try {
        const fromFile = await invoke<string | null>("load_session", { name });
        if (fromFile != null && fromFile !== "") return fromFile;
      } catch {
        /* fall through to localStorage */
      }
      // No file yet → migrate whatever the old build left in localStorage.
      try {
        const legacy = localStorage.getItem(key);
        if (legacy != null) {
          // Seed the file so the next load is file-backed even if localStorage
          // gets wiped before the store's first write-through.
          invoke("save_session", { name, data: legacy }).catch(() => {});
          return legacy;
        }
      } catch {
        /* localStorage unavailable */
      }
      return null;
    },
    setItem: async (key, value) => {
      try {
        await invoke("save_session", { name, data: value });
      } catch {
        /* keep the localStorage mirror even if the file write failed */
      }
      try {
        localStorage.setItem(key, value);
      } catch {
        /* quota / disabled — the file copy is the durable one */
      }
    },
    removeItem: async (key) => {
      try {
        await invoke("save_session", { name, data: "" });
      } catch {
        /* ignore */
      }
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}
