import { invoke } from "@tauri-apps/api/core";
import type { StateStorage } from "zustand/middleware";

/**
 * Durable storage backend for zustand `persist`, replacing WebView2
 * localStorage as the source of truth.
 *
 * localStorage lives in a leveldb that Chromium discards WHOLE when it
 * corrupts (unclean shutdown, or a second process touching the profile during
 * a default-browser "open localhost" launch) — which is how a full session of
 * tabs + history vanished with no restore. This writes every change to a plain
 * JSON file on disk (via the `save_session` / `load_session` Rust commands) and
 * reads from the file first, so a localStorage rebuild can no longer lose data.
 *
 * localStorage is now a MIGRATION SOURCE and a failure fallback only — see
 * setItem for why it stopped being written on the hot path.
 */

/** Coalescing window for writes. Long enough to swallow a page-load burst,
 *  short enough that the exposure on a hard kill stays trivial. */
const WRITE_DEBOUNCE_MS = 400;

export function tauriStorage(name: string): StateStorage {
  // zustand's persist writes on EVERY set() — no equality check — and each
  // write re-serializes the entire persisted slice. For the main store that
  // slice includes history (hundreds of KB), so a single page load's worth of
  // title/loading/audio updates used to mean a dozen full-size writes, each
  // one a JSON.stringify + an IPC string copy + a file rewrite. Coalesce them:
  // only the newest value matters, since every write is the complete state.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | null = null;
  // Last value actually persisted. persist re-serializes on sets that leave the
  // persisted slice untouched (the background sweeps re-assert flags that are
  // already set), and an identical blob is pure cost — a string compare is
  // orders of magnitude cheaper than the IPC hop plus the file rewrite.
  let lastWritten: string | null = null;

  async function write(data: string) {
    try {
      await invoke("save_session", { name, data });
    } catch {
      // File write failed (permissions, disk full). Fall back to localStorage
      // so state still survives a normal restart — it is the fragile store,
      // but a fragile copy beats none.
      try {
        localStorage.setItem(name, data);
      } catch {
        /* nothing left to try */
      }
    }
  }

  function flush() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending == null) return;
    const data = pending;
    pending = null;
    if (data === lastWritten) return;
    lastWritten = data;
    void write(data);
  }

  // The tail matters more than the average here: whatever is still pending has
  // to land before the window goes away, or closing zro loses the last few
  // hundred ms of tab state. Flush on every "about to stop being visible"
  // signal — they overlap deliberately, and flush() is a no-op when idle.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flush();
    });
  }

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
      // Both keys: `key` is what persist used before the switch, `name` is
      // what the fallback path above writes.
      try {
        const legacy = localStorage.getItem(key) ?? localStorage.getItem(name);
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

    setItem: async (_key, value) => {
      pending = value;
      if (timer === undefined) {
        timer = setTimeout(flush, WRITE_DEBOUNCE_MS);
      }
    },

    removeItem: async (key) => {
      pending = null;
      lastWritten = null;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      try {
        await invoke("save_session", { name, data: "" });
      } catch {
        /* ignore */
      }
      try {
        localStorage.removeItem(key);
        localStorage.removeItem(name);
      } catch {
        /* ignore */
      }
    },
  };
}
