import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { v4 as uuidv4 } from "uuid";

export interface Tab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  folderId?: string;
  isLoading: boolean;
  /** Opened while incognito mode was on — marked purple, never recorded */
  incognito?: boolean;
  /** Page is currently playing audio */
  audible?: boolean;
  /** Page played audio/video at some point this session. Freeze (TrySuspend)
   *  keeps playback position + paused state; hibernation destroys them — so
   *  media tabs only ever freeze, never hibernate. */
  hadMedia?: boolean;
  /** Tab is muted (user clicked the speaker) */
  muted?: boolean;
  /** Profile this tab's webview lives in (undefined = "default") */
  profileId?: string;
  /** Renderer destroyed to free RAM; wakes lazily on hover/click */
  hibernated?: boolean;
  /** Renderer frozen (WebView2 TrySuspend) — state kept, RAM released.
   *  Cheaper tier than hibernation; thaws automatically on switch. */
  suspended?: boolean;
  /** Last time this tab was active — drives the freeze/hibernation sweeps */
  lastActiveAt?: number;
  /** User pinned it awake — exempt from every auto-sleep sweep (freeze,
   *  hibernate, live-cap). The whole-machine idle freeze still applies. */
  keepAwake?: boolean;
}

export interface Profile {
  id: string;
  name: string;
  color: string;
}

export interface Folder {
  id: string;
  name: string;
  isOpen: boolean;
  color: string;
  icon: string;
  /** Profile this folder belongs to (undefined = "default") — folders are
   *  part of a profile's browser, they never cross profiles */
  profileId?: string;
}

export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: number; // epoch ms
}

interface ClosedTab {
  url: string;
  folderId?: string;
}

export type AiProvider = "ollama" | "openai" | "mzcode";

export interface Settings {
  searchEngine: "google" | "duckduckgo" | "bing";
  aiProvider: AiProvider;
  aiModel: string;
  aiBaseUrl: string; // OpenAI-compatible endpoint (LM Studio, vLLM, cloud)
  aiApiKey: string;
  passwordAutosave: boolean;
  /** Require Windows Hello / passcode before entering incognito */
  incognitoLock: boolean;
  /** djb2 hash of the fallback passcode ("" = none set) */
  incognitoPasscode: string;
  /** Digit count of the passcode (4-6) — drives the PIN-box UI */
  incognitoPasscodeLen: number;
  /** Named identities — each maps to its own WebView2 user data folder
   *  (cookies, logins, storage fully isolated). "default" = the original. */
  profiles: Profile[];
  activeProfileId: string;
  /** Destroy renderers of background tabs idle this long (minutes, 0 = off) */
  hibernateAfterMin: number;
  /** Hard cap on live background renderers — the total-memory bound. Only
   *  the N most-recently-used background tabs keep a process; everything
   *  past the cap sleeps immediately regardless of idle time (0 = no cap). */
  liveTabLimit: number;
  /** Whole machine idle this long → freeze EVERY renderer, active tab
   *  included (audio exempt). The all-night-fans fix (minutes, 0 = off). */
  idleFreezeMin: number;
  /** Shields master switch (the whole protection suite). On by default. */
  shieldsEnabled: boolean;
  /** Pillar 1: network ad/tracker blocking (Brave's adblock engine). */
  shieldsAds: boolean;
  /** Pillar 2: anti-fingerprinting (canvas/WebGL/audio/navigator farbling). */
  shieldsFingerprint: boolean;
  /** Pillar 3: upgrade http:// to https://. */
  shieldsHttps: boolean;
  /** Pillar 4: strip tracking params (utm_*, fbclid, gclid…) off URLs. */
  shieldsStrip: boolean;
  /** Toolbar tools kept visible in the top bar; the rest fold into a "⋯"
   *  overflow menu. Settings is always shown regardless. */
  pinnedTools: string[];
}

/** Every toolbar tool that can be pinned/overflowed (settings excluded — it's
 *  always pinned). Order here is the render order in the bar. */
export const TOOL_KEYS = ["shield", "incognito", "memory", "history", "downloads", "stats", "ai"] as const;

const DEFAULT_SETTINGS: Settings = {
  searchEngine: "google",
  aiProvider: "ollama",
  aiModel: "",
  aiBaseUrl: "http://localhost:1234/v1",
  aiApiKey: "",
  passwordAutosave: true,
  incognitoLock: false,
  incognitoPasscode: "",
  incognitoPasscodeLen: 0,
  profiles: [{ id: "default", name: "Default", color: "#4f80f5" }],
  activeProfileId: "default",
  hibernateAfterMin: 10,
  liveTabLimit: 3,
  idleFreezeMin: 3,
  shieldsEnabled: true,
  shieldsAds: true,
  shieldsFingerprint: true,
  shieldsHttps: true,
  shieldsStrip: true,
  // Default: all pinned (no change from before) — users curate down from here.
  pinnedTools: ["shield", "incognito", "memory", "history", "downloads", "stats", "ai"],
};

/** Small non-cryptographic hash so the passcode isn't stored in plaintext.
 *  This is a personal browser's convenience lock, not a security boundary. */
export function hashPasscode(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export const FOLDER_COLORS = [
  "#4f80f5", "#e8a030", "#4fb56a", "#c95df0", "#e05555",
  "#40bfbf", "#e0629a", "#8a9a2a", "#7a6ff0", "#d0813a",
];
export const FOLDER_COLOR_NAMES = [
  "Blue", "Orange", "Green", "Purple", "Red",
  "Teal", "Pink", "Olive", "Violet", "Amber",
];
/** Lucide icon names — rendered as SVG via FolderIcon (no emoji). */
export const FOLDER_ICONS = [
  "folder", "rocket", "target", "zap", "flame", "gem",
  "waves", "palette", "brain", "star", "wrench", "gamepad",
];
/** Legacy folders stored emoji — map them onto the SVG set once. */
const LEGACY_ICON_MAP: Record<string, string> = {
  "\u{1F4C1}": "folder", "\u{1F680}": "rocket", "\u{1F3AF}": "target",
  "⚡": "zap", "\u{1F525}": "flame", "\u{1F48E}": "gem",
  "\u{1F30A}": "waves", "\u{1F3A8}": "palette", "\u{1F9E0}": "brain",
  "⭐": "star", "\u{1F6E0}️": "wrench", "\u{1F3AE}": "gamepad",
};
export function normalizeFolderIcon(icon: string): string {
  if (FOLDER_ICONS.includes(icon)) return icon;
  return LEGACY_ICON_MAP[icon] ?? "folder";
}

function randomFolderStyle(): { color: string; icon: string } {
  return {
    color: FOLDER_COLORS[Math.floor(Math.random() * FOLDER_COLORS.length)],
    icon: FOLDER_ICONS[Math.floor(Math.random() * FOLDER_ICONS.length)],
  };
}

/** Google's favicon service can't reach these — it 200s with its own generic
 *  globe instead of erroring, so the img never falls through to OUR fallback
 *  icon. Skip it up front and let the Favicon component render our own. */
function isUnreachableHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  if (/^(127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (hostname === "[::1]" || hostname === "::1") return true;
  return false;
}

function faviconFor(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!u.protocol.startsWith("http")) return undefined;
    if (isUnreachableHost(u.hostname)) return undefined;
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return undefined;
  }
}

const SEARCH_URLS: Record<Settings["searchEngine"], string> = {
  google: "https://www.google.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
  bing: "https://www.bing.com/search?q=",
};

/** Build a search URL for the given engine (falls back to Google). */
export function searchUrl(query: string, engine: Settings["searchEngine"]): string {
  return (SEARCH_URLS[engine] ?? SEARCH_URLS.google) + encodeURIComponent(query);
}

/** Log to devtools AND the dev terminal (native layout bugs need both sides). */
function logErr(ctx: string, err: unknown) {
  console.error(ctx, err);
  invoke("log_js", { msg: `${ctx}: ${err}` }).catch(() => {});
}

/** Profiles are separate browsers — tabs AND folders are visible only inside
 *  their own profile's space. */
export function inProfile(x: { profileId?: string }, profileId: string): boolean {
  return (x.profileId ?? "default") === profileId;
}

/** Folder the active tab lives in — a new tab opened while you're inside a
 *  folder (Ctrl+T, the + button, or a link/popup) inherits it. undefined when
 *  the active tab is loose or there is none. */
export function activeFolderId(tabs: Tab[], activeTabId: string | null): string | undefined {
  return tabs.find((t) => t.id === activeTabId)?.folderId;
}

interface BrowserStore {
  tabs: Tab[];
  folders: Folder[];
  activeTabId: string | null;
  selectedTabIds: string[];
  sidebarWidth: number;
  isIncognito: boolean;
  history: HistoryEntry[];
  closedTabs: ClosedTab[];
  renamingFolderId: string | null;
  /** Folder whose style editor popover is open (sidebar) */
  editingFolderId: string | null;
  /** >0 = sidebar flyout must stay open (rename/edit inputs live) */
  sidebarPins: number;
  settings: Settings;

  createTab: (url?: string, folderId?: string, opts?: { focusUrl?: boolean }) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  closeTabs: (ids: string[]) => Promise<void>;
  closeOtherTabs: (keepIds: string[]) => Promise<void>;
  reopenClosedTab: () => Promise<void>;
  switchTab: (id: string) => Promise<void>;
  cycleTab: (dir: 1 | -1) => Promise<void>;
  switchToIndex: (n: number) => Promise<void>;
  navigate: (url: string) => Promise<void>;
  toggleMute: (id: string) => void;
  updateTab: (id: string, updates: Partial<Tab>) => void;
  reorderTabs: (orderedIds: string[]) => void;
  /** One drag-drop primitive: move `ids` into `folderId` (undefined = loose),
   *  positioned relative to `anchorId` (before/after), or appended to that
   *  container's end when anchorId is null. */
  placeTabs: (
    ids: string[],
    folderId: string | undefined,
    anchorId: string | null,
    after: boolean
  ) => void;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  reload: () => Promise<void>;

  toggleSelectTab: (id: string) => void;
  clearSelection: () => void;

  createFolder: (name: string) => string;
  deleteFolder: (id: string) => void;
  toggleFolder: (id: string) => void;
  renameFolder: (id: string, name: string) => void;
  randomizeFolderStyle: (id: string) => void;
  setFolderStyle: (id: string, style: { color?: string; icon?: string }) => void;
  moveTabToFolder: (tabId: string, folderId: string | undefined) => void;
  moveTabsToFolder: (tabIds: string[], folderId: string | undefined) => void;

  setSidebarWidth: (w: number) => void;
  toggleIncognito: () => void;
  /** Profiles are separate browsers: switching swaps the whole tab space */
  switchProfile: (id: string) => void;
  /** Close the profile's tabs, drop its folders, remove it from settings.
   *  Caller confirms first and wipes the on-disk data separately. */
  deleteProfile: (id: string) => Promise<void>;
  addHistory: (entry: HistoryEntry) => void;
  removeHistory: (visitedAt: number, url: string) => void;
  /** null = all time, otherwise delete entries with visitedAt >= since */
  clearHistory: (since?: number | null) => void;
  setRenamingFolder: (id: string | null) => void;
  setEditingFolder: (id: string | null) => void;
  pinSidebar: () => void;
  unpinSidebar: () => void;
  setSettings: (patch: Partial<Settings>) => void;

  /** Call once on mount to wire up Tauri events */
  initEvents: () => Promise<() => void>;
}

export function normalizeUrl(raw: string, engine: Settings["searchEngine"] = "google"): string {
  const t = raw.trim();
  if (!t) return "about:blank";
  if (/^https?:\/\//i.test(t)) return t;
  // Any other hierarchical URI scheme (chrome-extension://, file://, ...)
  // passes through untouched — otherwise it falls into the search-query
  // branch below and gets encoded as a Google search instead of navigated
  // to. Requires "://" so "host.tld:port" isn't mistaken for a scheme.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[a-z]{2,})+/i.test(t) && !t.includes(" ")) return `https://${t}`;
  return `${SEARCH_URLS[engine]}${encodeURIComponent(t)}`;
}

/** Fetch real title/favicon for a tab (works for background tabs too).
 *  History guard is the TAB's incognito flag, never the current mode — a
 *  background incognito tab firing events after the user toggled back to
 *  normal mode must not leak into history. */
function refreshMeta(id: string) {
  const { updateTab, addHistory, tabs } = useBrowserStore.getState();
  const isPrivate = !!tabs.find((t) => t.id === id)?.incognito;
  invoke<{ title: string; url: string; favicon: string | null }>("get_page_meta", { id })
    .then((meta) => {
      const updates: Partial<Tab> = {};
      if (meta.title) updates.title = meta.title;
      if (meta.favicon) updates.favicon = meta.favicon;
      updateTab(id, updates);
      if (!isPrivate) {
        const tab = tabs.find((t) => t.id === id);
        const url = meta.url || tab?.url || "";
        if (url) addHistory({ url, title: meta.title || url, visitedAt: Date.now() });
      }
    })
    .catch(() => {
      if (!isPrivate) {
        const tab = useBrowserStore.getState().tabs.find((t) => t.id === id);
        if (tab) addHistory({ url: tab.url, title: tab.title || tab.url, visitedAt: Date.now() });
      }
    });
}

export const useBrowserStore = create<BrowserStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      folders: [],
      activeTabId: null,
      selectedTabIds: [],
      sidebarWidth: 44,
      isIncognito: false,
      history: [],
      closedTabs: [],
      renamingFolderId: null,
      editingFolderId: null,
      sidebarPins: 0,
      settings: DEFAULT_SETTINGS,

      createTab: async (url, folderId, opts) => {
        // Blank new tab (Ctrl+T / + button) → focus the URL bar so the user
        // can type immediately. Link/popup opens keep focus on the page.
        const focusUrl = opts?.focusUrl ?? url === undefined;
        const target = url ?? "https://www.google.com";
        const id = `tab-${uuidv4()}`;
        const normalized = normalizeUrl(target, get().settings.searchEngine);
        const profileId = get().settings.activeProfileId;
        set((s) => ({
          tabs: [
            // Outgoing active tab's idle clock starts now
            ...s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, lastActiveAt: Date.now() } : t)),
            {
              id, url: normalized, title: "New Tab", favicon: faviconFor(normalized),
              folderId, isLoading: true, incognito: s.isIncognito || undefined,
              profileId: profileId !== "default" ? profileId : undefined,
              lastActiveAt: Date.now(),
            },
          ],
          activeTabId: id,
          selectedTabIds: [],
        }));
        try {
          await invoke("create_browser_tab", {
            id, url: normalized,
            profile: profileId !== "default" ? profileId : null,
          });
        } catch (err) {
          logErr("create_browser_tab", err);
        }
        if (focusUrl) {
          invoke("focus_main").catch(() => {});
          setTimeout(() => window.dispatchEvent(new CustomEvent("zro-focus-url")), 80);
        }
      },

      closeTab: async (id) => {
        await get().closeTabs([id]);
      },

      closeTabs: async (ids) => {
        const s = get();
        const closing = new Set(ids);
        const closedEntries: ClosedTab[] = s.tabs
          .filter((t) => closing.has(t.id))
          .map((t) => ({ url: t.url, folderId: t.folderId }));
        const remaining = s.tabs.filter((t) => !closing.has(t.id));

        // Pick the next active tab on the frontend - the Rust side may not
        // know about restored-but-unloaded tabs. NEVER leave the current tab
        // space: closing the last tab of a profile must not jump to another
        // profile's tab — it opens a fresh tab in this one instead.
        let nextId = s.activeTabId;
        let needFresh = false;
        if (nextId && closing.has(nextId)) {
          const mode = s.isIncognito;
          const pid = s.settings.activeProfileId;
          const ok = (t: Tab) => !closing.has(t.id) && !!t.incognito === mode && inProfile(t, pid);
          // Most-recently-used first — closing a tab returns to the tab you
          // were on before it, not whatever happens to sit next to it.
          const mru = s.tabs
            .filter((t) => ok(t) && t.lastActiveAt !== undefined)
            .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0];
          if (mru) {
            nextId = mru.id;
          } else {
            // No usage history (fresh restore) — fall back to the neighbor
            const oldIdx = s.tabs.findIndex((t) => t.id === nextId);
            const after = s.tabs.slice(oldIdx + 1).find(ok);
            const before = [...s.tabs.slice(0, oldIdx)].reverse().find(ok);
            nextId = after?.id ?? before?.id ?? null;
          }
          needFresh = nextId === null;
        }

        set({
          tabs: remaining,
          activeTabId: nextId,
          selectedTabIds: s.selectedTabIds.filter((sid) => !closing.has(sid)),
          closedTabs: [...closedEntries, ...s.closedTabs].slice(0, 20),
        });

        // Switch FIRST, destroy after: closing the active webview before its
        // replacement is shown uncovers the window beneath for a split second.
        if (needFresh) {
          await get().createTab();
        } else if (nextId && s.activeTabId && closing.has(s.activeTabId)) {
          await get().switchTab(nextId);
        }
        for (const id of ids) {
          invoke("close_browser_tab", { id }).catch((err) => logErr("close_browser_tab", err));
        }
      },

      closeOtherTabs: async (keepIds) => {
        const keep = new Set(keepIds);
        const { tabs, closeTabs } = get();
        await closeTabs(tabs.filter((t) => !keep.has(t.id)).map((t) => t.id));
      },

      reopenClosedTab: async () => {
        const { closedTabs, createTab } = get();
        const last = closedTabs[0];
        if (!last) return;
        set((s) => ({ closedTabs: s.closedTabs.slice(1) }));
        await createTab(last.url, last.folderId);
      },

      switchTab: async (id) => {
        const tab = get().tabs.find((t) => t.id === id);
        if (!tab) return;
        set((s) => ({
          activeTabId: id,
          selectedTabIds: [],
          tabs: s.tabs.map((t) =>
            // Stamp both sides: the incoming tab (wakes + thaws) and the
            // outgoing one (its idle clock starts NOW, going to background)
            t.id === id
              ? { ...t, lastActiveAt: Date.now(), hibernated: false, suspended: false }
              : t.id === s.activeTabId
              ? { ...t, lastActiveAt: Date.now() }
              : t
          ),
        }));
        try {
          const exists = await invoke<boolean>("switch_browser_tab", { id });
          if (!exists) {
            // Restored / hibernated — webview is created lazily on activation
            set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, isLoading: true } : t)) }));
            await invoke("create_browser_tab", {
              id, url: tab.url,
              profile: tab.profileId && tab.profileId !== "default" ? tab.profileId : null,
            });
          }
        } catch (err) {
          logErr("switch_browser_tab", err);
        }
      },

      cycleTab: async (dir) => {
        const { tabs, activeTabId, switchTab, isIncognito, settings } = get();
        // Cycle within the current tab space only (profile + mode)
        const pool = tabs.filter((t) => !!t.incognito === isIncognito && inProfile(t, settings.activeProfileId));
        if (pool.length < 2) return;
        const idx = pool.findIndex((t) => t.id === activeTabId);
        const next = pool[(idx + dir + pool.length) % pool.length];
        if (next) await switchTab(next.id);
      },

      switchToIndex: async (n) => {
        const { tabs, switchTab, isIncognito, settings } = get();
        const pool = tabs.filter((t) => !!t.incognito === isIncognito && inProfile(t, settings.activeProfileId));
        if (pool.length === 0) return;
        // Chrome convention: 9 = last tab
        const tab = n >= 9 ? pool[pool.length - 1] : pool[n - 1];
        if (tab) await switchTab(tab.id);
      },

      navigate: async (url) => {
        const { activeTabId, settings } = get();
        if (!activeTabId) {
          await get().createTab(url);
          return;
        }
        const normalized = normalizeUrl(url, settings.searchEngine);
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === activeTabId
              ? { ...t, url: normalized, favicon: faviconFor(normalized), isLoading: true }
              : t
          ),
        }));
        try {
          await invoke("navigate_tab", { id: activeTabId, url: normalized });
        } catch (err) {
          logErr("navigate_tab", err);
        }
      },

      toggleMute: (id) => {
        const tab = get().tabs.find((t) => t.id === id);
        if (!tab) return;
        const next = !tab.muted;
        // Optimistic; the page-audio event will confirm from WebView2
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, muted: next } : t)) }));
        invoke("set_tab_muted", { id, muted: next }).catch((e) => logErr("set_tab_muted", e));
      },

      updateTab: (id, updates) =>
        set((s) => {
          // Page events re-fire with unchanged values constantly (audio state,
          // repeated titles, isLoading spam during SPA loads). A no-op update
          // must not rebuild the tabs array — that notifies every subscriber
          // and re-renders the whole sidebar per event. Returning the state
          // object itself makes zustand skip notification (Object.is check).
          const cur = s.tabs.find((t) => t.id === id);
          if (!cur) return s;
          let changed = false;
          for (const k in updates) {
            if (cur[k as keyof Tab] !== updates[k as keyof Tab]) {
              changed = true;
              break;
            }
          }
          if (!changed) return s;
          return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)) };
        }),

      reorderTabs: (orderedIds) =>
        set((s) => {
          const map = new Map(s.tabs.map((t) => [t.id, t]));
          const loose = orderedIds.map((id) => map.get(id)).filter(Boolean) as Tab[];
          const inFolders = s.tabs.filter((t) => t.folderId && !orderedIds.includes(t.id));
          return { tabs: [...loose, ...inFolders] };
        }),

      placeTabs: (ids, folderId, anchorId, after) =>
        set((s) => {
          const idSet = new Set(ids);
          // Preserve the bundle's own relative order while retargeting it
          const moving = s.tabs.filter((t) => idSet.has(t.id)).map((t) => ({ ...t, folderId }));
          if (moving.length === 0) return {};
          const rest = s.tabs.filter((t) => !idSet.has(t.id));
          let at: number;
          if (anchorId) {
            const a = rest.findIndex((t) => t.id === anchorId);
            at = a === -1 ? rest.length : after ? a + 1 : a;
          } else if (folderId) {
            // No anchor → append after the folder's last tab (or list end)
            let last = -1;
            rest.forEach((t, i) => { if (t.folderId === folderId) last = i; });
            at = last === -1 ? rest.length : last + 1;
          } else {
            at = rest.length;
          }
          return { tabs: [...rest.slice(0, at), ...moving, ...rest.slice(at)] };
        }),

      goBack: async () => {
        try { await invoke("go_back"); } catch (err) { logErr("go_back", err); }
      },

      goForward: async () => {
        try { await invoke("go_forward"); } catch (err) { logErr("go_forward", err); }
      },

      reload: async () => {
        const { activeTabId } = get();
        if (!activeTabId) return;
        set((s) => ({
          tabs: s.tabs.map((t) => t.id === activeTabId ? { ...t, isLoading: true } : t),
        }));
        try { await invoke("reload_tab"); } catch (err) { logErr("reload_tab", err); }
      },

      toggleSelectTab: (id) =>
        set((s) => ({
          selectedTabIds: s.selectedTabIds.includes(id)
            ? s.selectedTabIds.filter((sid) => sid !== id)
            : [...s.selectedTabIds, id],
        })),

      clearSelection: () => set({ selectedTabIds: [] }),

      createFolder: (name) => {
        const id = `folder-${uuidv4()}`;
        const profileId = get().settings.activeProfileId;
        set((s) => ({
          folders: [...s.folders, {
            id, name, isOpen: true, ...randomFolderStyle(),
            profileId: profileId !== "default" ? profileId : undefined,
          }],
        }));
        return id;
      },

      deleteFolder: (id) =>
        set((s) => ({
          folders: s.folders.filter((f) => f.id !== id),
          tabs: s.tabs.map((t) => (t.folderId === id ? { ...t, folderId: undefined } : t)),
        })),

      toggleFolder: (id) =>
        set((s) => ({
          folders: s.folders.map((f) => (f.id === id ? { ...f, isOpen: !f.isOpen } : f)),
        })),

      renameFolder: (id, name) =>
        set((s) => ({
          folders: s.folders.map((f) => (f.id === id ? { ...f, name } : f)),
        })),

      randomizeFolderStyle: (id) =>
        set((s) => ({
          folders: s.folders.map((f) => (f.id === id ? { ...f, ...randomFolderStyle() } : f)),
        })),

      setFolderStyle: (id, style) =>
        set((s) => ({
          folders: s.folders.map((f) => (f.id === id ? { ...f, ...style } : f)),
        })),

      moveTabToFolder: (tabId, folderId) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, folderId } : t)),
        })),

      moveTabsToFolder: (tabIds, folderId) =>
        set((s) => {
          const ids = new Set(tabIds);
          return { tabs: s.tabs.map((t) => (ids.has(t.id) ? { ...t, folderId } : t)) };
        }),

      setSidebarWidth: (w) => set({ sidebarWidth: w }),
      // Incognito is a separate tab space: the sidebar only shows the current
      // mode's tabs, so toggling also lands you on a tab of that mode.
      toggleIncognito: () => {
        const next = !get().isIncognito;
        set({ isIncognito: next, selectedTabIds: [] });
        const pool = get().tabs.filter((t) => !!t.incognito === next);
        if (pool.length > 0) {
          const active = get().activeTabId;
          if (!pool.some((t) => t.id === active)) {
            get().switchTab(pool[pool.length - 1].id).catch(() => {});
          }
        } else {
          get().createTab().catch(() => {});
        }
      },
      // Profile switch = swap the whole tab space, like a separate browser:
      // land on that profile's most recent tab, or open one if it's empty.
      switchProfile: (id) => {
        const s = get();
        if (s.settings.activeProfileId === id) return;
        set((st) => ({
          settings: { ...st.settings, activeProfileId: id },
          selectedTabIds: [],
        }));
        const pool = get().tabs.filter(
          (t) => inProfile(t, id) && !!t.incognito === get().isIncognito
        );
        if (pool.length > 0) {
          if (!pool.some((t) => t.id === get().activeTabId)) {
            get().switchTab(pool[pool.length - 1].id).catch(() => {});
          }
        } else {
          get().createTab().catch(() => {});
        }
      },
      // Deleting a profile deletes that whole browser: its tabs close, its
      // folders go, and if it was active we land back in Default first (so
      // the close logic never runs inside a dead tab space).
      deleteProfile: async (id) => {
        if (id === "default") return;
        if (get().settings.activeProfileId === id) get().switchProfile("default");
        const ids = get().tabs
          .filter((t) => (t.profileId ?? "default") === id)
          .map((t) => t.id);
        if (ids.length > 0) await get().closeTabs(ids);
        set((st) => ({
          folders: st.folders.filter((f) => (f.profileId ?? "default") !== id),
          settings: {
            ...st.settings,
            profiles: st.settings.profiles.filter((p) => p.id !== id),
          },
        }));
      },
      addHistory: (entry) =>
        set((s) => {
          // Dedupe: refreshes / redirect hops / SPA re-fires of the same URL
          // within 5 minutes update the existing entry instead of stacking
          const cutoff = entry.visitedAt - 5 * 60_000;
          const recent = s.history
            .slice(0, 50)
            .filter((h) => !(h.url === entry.url && h.visitedAt > cutoff));
          return { history: [entry, ...recent, ...s.history.slice(50)].slice(0, 5000) };
        }),
      removeHistory: (visitedAt, url) =>
        set((s) => ({
          history: s.history.filter((h) => !(h.visitedAt === visitedAt && h.url === url)),
        })),
      clearHistory: (since) =>
        set((s) => ({
          history: since == null ? [] : s.history.filter((h) => h.visitedAt < since),
        })),
      setRenamingFolder: (id) => set({ renamingFolderId: id }),
      setEditingFolder: (id) => set({ editingFolderId: id }),
      pinSidebar: () => set((s) => ({ sidebarPins: s.sidebarPins + 1 })),
      unpinSidebar: () => set((s) => ({ sidebarPins: Math.max(0, s.sidebarPins - 1) })),
      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      initEvents: async () => {
        // Per-tab webviews: events carry the exact tab id
        const unsubLoaded = await listen<{ id: string; url: string }>("page-loaded", (e) => {
          const { updateTab } = get();
          const { id, url } = e.payload;
          updateTab(id, { isLoading: false, url, favicon: faviconFor(url) });
          invoke("push_to_history", { id, url }).catch(() => {});

          // Real title + real favicon straight from the page (any tab)
          refreshMeta(id);

          // AI semantic memory (no-op if Ollama down) - active tab only.
          // Deferred: reading innerText forces a full layout pass, so never
          // do it in the same beat as first paint.
          const loadedTab = get().tabs.find((t) => t.id === id);
          if (get().activeTabId === id && !loadedTab?.incognito) {
            setTimeout(() => {
              if (get().activeTabId === id) {
                invoke("index_page", { url }).catch(() => {});
              }
            }, 2500);
          }
        });

        const unsubLoading = await listen<{ id: string }>("page-loading", (e) => {
          get().updateTab(e.payload.id, { isLoading: true });
        });

        // Audio state (speaker button / muted indicator)
        const unsubAudio = await listen<{ id: string; audible: boolean; muted: boolean }>(
          "page-audio",
          (e) => {
            const { id, audible, muted } = e.payload;
            // hadMedia sticks for the session — it downgrades this tab's
            // deepest sleep tier to freeze so playback position survives
            get().updateTab(id, audible ? { audible, muted, hadMedia: true } : { audible, muted });
          }
        );

        // SPA navigations (YouTube video→video, Gmail, etc.) never fire
        // page-loaded — SourceChanged is the only reliable signal. Without
        // this the tab keeps the stale URL and restores the wrong page.
        const unsubNav = await listen<{ id: string; url: string }>("page-navigated", (e) => {
          const { id, url } = e.payload;
          const tab = get().tabs.find((t) => t.id === id);
          if (!tab || tab.url === url) return;
          get().updateTab(id, { url, favicon: faviconFor(url) });
          if (!tab.incognito) {
            get().addHistory({ url, title: tab.title || url, visitedAt: Date.now() });
          }
        });

        const unsubTitle = await listen<{ id: string; title: string }>("page-title", (e) => {
          const { id, title } = e.payload;
          if (!title) return;
          get().updateTab(id, { title });
          // Keep the freshest title on the newest history entry for this URL
          const tab = get().tabs.find((t) => t.id === id);
          if (tab?.url && !tab.incognito) {
            get().addHistory({ url: tab.url, title, visitedAt: Date.now() });
          }
        });

        return () => {
          unsubLoaded();
          unsubLoading();
          unsubAudio();
          unsubNav();
          unsubTitle();
        };
      },
    }),
    {
      name: "zro-store",
      partialize: (s) => ({
        // Tabs persist across restarts; webviews are recreated lazily on
        // first activation. Incognito tabs die with the session.
        tabs: s.tabs.filter((t) => !t.incognito).map((t) => ({
          ...t, isLoading: false, audible: false, muted: false, hadMedia: false,
          hibernated: false, suspended: false, lastActiveAt: undefined,
        })),
        activeTabId: s.activeTabId,
        history: s.history,
        folders: s.folders,
        closedTabs: s.closedTabs,
        settings: s.settings,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<BrowserStore>;
        return {
          ...current,
          ...p,
          // Restored tabs have no webview yet — they ARE hibernated until
          // first activation (drives the sleeping look + hover pre-wake)
          tabs: (p.tabs ?? []).map((t) => ({ ...t, hibernated: true })),
          // Older sessions stored emoji icons — normalize onto the SVG set
          folders: (p.folders ?? []).map((f) => ({ ...f, icon: normalizeFolderIcon(f.icon) })),
          settings: {
            ...DEFAULT_SETTINGS,
            ...(p.settings ?? {}),
            // Default profile row must always exist
            profiles: (p.settings?.profiles?.some((pr) => pr.id === "default")
              ? p.settings.profiles
              : [{ id: "default", name: "Default", color: "#4f80f5" }, ...(p.settings?.profiles ?? [])]),
          },
        };
      },
    }
  )
);

// ── Tab power tiers ──────────────────────────────────────────────────────────
// FREEZE (TrySuspend) is the workhorse: DOM, scroll, forms, video position and
// play/pause state all survive, resume is instant, and the renderer's RAM
// becomes reclaimable. DESTROY (hibernate) frees everything but the wake is a
// full cold page load — so it's reserved for genuinely idle tabs only.
//
// The original cap sweep hibernated any beyond-cap tab REGARDLESS of recency —
// a tab used 20s ago got its renderer destroyed, every switch back was a cold
// reload, every reload burned the warm spare and spawned a replacement. That
// churn was the "everything is slow" report. Rules now:
//   · beyond-cap + recently used  → freeze (instant to come back)
//   · beyond-cap + idle ≥ 5 min   → destroy (gently, 1 per tick)
//   · idle ≥ hibernateAfterMin    → destroy (the user's own timer)
// All sweeps skip while the window is hidden — the native minimize-freeze and
// idle watchdog own that case, and letting intervals queue up while hidden
// meant a burst of native calls (and a frozen sidebar) on refocus.

const CAP_DESTROY_IDLE_MS = 5 * 60_000;

// Tier 0 (10s): enforce the live-renderer cap, freeze-first.
setInterval(() => {
  if (document.hidden) return;
  const s = useBrowserStore.getState();
  const cap = s.settings.liveTabLimit;
  if (cap <= 0) return;
  const live = s.tabs
    .filter(
      (t) =>
        t.id !== s.activeTabId && !t.hibernated && !t.audible && !t.isLoading &&
        !t.keepAwake && t.lastActiveAt !== undefined
    )
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  let destroys = 0;
  let freezes = 0;
  for (const t of live.slice(cap)) {
    const idle = Date.now() - (t.lastActiveAt ?? 0);
    // Media tabs (played audio/video this session) freeze but never get
    // destroyed — TrySuspend keeps the video position and paused state,
    // a renderer teardown loses both.
    if (!t.hadMedia && idle >= CAP_DESTROY_IDLE_MS && destroys < 1) {
      destroys++;
      invoke("hibernate_tab", { id: t.id })
        .then(() => s.updateTab(t.id, { hibernated: true, suspended: false }))
        .catch(() => {});
    } else if (!t.suspended && freezes < 2) {
      freezes++;
      invoke("suspend_tab", { id: t.id })
        .then(() => s.updateTab(t.id, { suspended: true }))
        .catch(() => {});
    }
  }
}, 10_000);

// Tier 1 (30s): background tabs idle over a minute get frozen.
setInterval(() => {
  if (document.hidden) return;
  const s = useBrowserStore.getState();
  const cutoff = Date.now() - 60_000;
  for (const t of s.tabs) {
    if (t.id === s.activeTabId || t.hibernated || t.suspended || t.audible || t.isLoading || t.keepAwake) continue;
    if (t.lastActiveAt === undefined || t.lastActiveAt > cutoff) continue;
    invoke("suspend_tab", { id: t.id })
      .then(() => s.updateTab(t.id, { suspended: true }))
      .catch(() => {});
  }
}, 30_000);

// Tier 2 (60s): idle past the user's timer → renderer destroyed. Rate-limited
// so a pile of newly-eligible tabs never lands as one main-thread burst.
setInterval(() => {
  if (document.hidden) return;
  const s = useBrowserStore.getState();
  const afterMin = s.settings.hibernateAfterMin;
  if (afterMin <= 0) return;
  const cutoff = Date.now() - afterMin * 60_000;
  let destroys = 0;
  for (const t of s.tabs) {
    if (destroys >= 2) break;
    if (t.id === s.activeTabId || t.hibernated || t.audible || t.isLoading || t.keepAwake) continue;
    // Media tabs cap out at freeze — hibernation would lose video position
    if (t.hadMedia) continue;
    // Tabs never activated this session have no timestamp — leave them;
    // they either already lack a webview or were just created.
    if (t.lastActiveAt === undefined || t.lastActiveAt > cutoff) continue;
    destroys++;
    invoke("hibernate_tab", { id: t.id })
      .then(() => s.updateTab(t.id, { hibernated: true, suspended: false }))
      .catch(() => {});
  }
}, 60_000);

// ── Keep the Rust idle watchdog's threshold in sync with the setting ──────────
function pushIdleFreeze() {
  invoke("set_idle_freeze_min", {
    minutes: useBrowserStore.getState().settings.idleFreezeMin ?? 3,
  }).catch(() => {});
}
pushIdleFreeze(); // initial (covers non-default persisted values after rehydrate)

function pushShields() {
  const s = useBrowserStore.getState().settings;
  invoke("set_shield_config", {
    master: s.shieldsEnabled ?? true,
    ads: s.shieldsAds ?? true,
    fingerprint: s.shieldsFingerprint ?? true,
    https: s.shieldsHttps ?? true,
    strip: s.shieldsStrip ?? true,
  }).catch(() => {});
}
pushShields();

useBrowserStore.subscribe((s, prev) => {
  if (s.settings.idleFreezeMin !== prev.settings.idleFreezeMin) pushIdleFreeze();
  const p = prev.settings, n = s.settings;
  if (
    n.shieldsEnabled !== p.shieldsEnabled ||
    n.shieldsAds !== p.shieldsAds ||
    n.shieldsFingerprint !== p.shieldsFingerprint ||
    n.shieldsHttps !== p.shieldsHttps ||
    n.shieldsStrip !== p.shieldsStrip
  ) {
    pushShields();
  }
});
