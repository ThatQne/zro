import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft, ChevronRight, RotateCw, Settings as SettingsIcon,
  Bot, BarChart2, EyeOff, Clock, Download, Minus, Square, X, Shield, Network, MoreHorizontal,
} from "lucide-react";
import { Puzzle } from "lucide-react";
import { useBrowserStore, activeFolderId, TOOL_KEYS, searchUrl } from "./store/tabs";
import { useDownloadsStore } from "./store/downloads";
import { useExtStore } from "./store/extensions";
import { trackOverlay } from "./store/overlays";
import Sidebar from "./components/Sidebar";
import UrlBar from "./components/UrlBar";
import StatsPanel from "./components/StatsPanel";
import AiPanel from "./components/AiPanel";
import HistoryPanel from "./components/HistoryPanel";
import SettingsPanel from "./components/SettingsPanel";
import ShieldPanel from "./components/ShieldPanel";
import DownloadsPanel from "./components/DownloadsPanel";
import IncognitoLock from "./components/IncognitoLock";
import UpdateBanner from "./components/UpdateBanner";
import MemoryPanel from "./components/MemoryPanel";
import logo from "../logo.png";

const CORNER_INSET = 12; // keep webview away from rounded window corners
const BAR_H = 40;        // single top row height

export type PanelKind = "stats" | "ai" | "history" | "settings" | "downloads" | "shield" | "memory";

// Web-content right-click context (from browser/menus.rs PageMenuCtx)
type PageCtx = { link: string; src: string; selection: string; page_url: string; is_image?: boolean; is_editable?: boolean };

// Module-level: survives StrictMode unmount/remount cycles
let bootDone = false;

export default function App() {
  const {
    tabs, createTab, goBack, goForward, reload,
    isIncognito, initEvents, settings,
  } = useBrowserStore();

  const [panel, setPanel] = useState<PanelKind | null>(null);
  const dlUnseen = useDownloadsStore((s) => s.unseen);
  const dlActive = useDownloadsStore((s) => s.items.some((i) => i.state === "active"));
  const [isMaximized, setIsMaximized] = useState(false);
  const [lockOpen, setLockOpen] = useState(false);

  // Entering incognito requires the unlock EVERY time (Windows Hello or
  // passcode); exiting never does.
  function requestIncognito() {
    const s = useBrowserStore.getState();
    if (s.isIncognito) { s.toggleIncognito(); return; }
    if (s.settings.incognitoLock) { setLockOpen(true); return; }
    s.toggleIncognito();
  }

  const contentRef = useRef<HTMLDivElement>(null);

  // Content div rect → Rust webview bounds. Right side is always full width now
  // (panels overlay the page instead of shrinking it).
  function pushBounds() {
    if (!contentRef.current) return;
    const rect = contentRef.current.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    invoke("set_layout", {
      x: rect.left,
      y: rect.top,
      rightOffset: 0,
      inset: CORNER_INSET,
    }).catch((e) => {
      invoke("log_js", { msg: `set_layout failed: ${e}` }).catch(() => {});
    });
  }

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => pushBounds());
    ro.observe(el);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    initEvents().then((fn) => {
      if (disposed) fn();
      else cleanup = fn;
    });
    const unsubResize = listen("window-resized", () => pushBounds());
    return () => {
      disposed = true;
      cleanup?.();
      unsubResize.then((u) => u());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Keyboard shortcuts ----------------------------------------------------
  function handleCombo(combo: string) {
    const s = useBrowserStore.getState();
    switch (combo) {
      case "new-tab": s.createTab(undefined, activeFolderId(s.tabs, s.activeTabId)); break;
      case "close-tab": if (s.activeTabId) s.closeTab(s.activeTabId); break;
      case "reopen-tab": s.reopenClosedTab(); break;
      case "reload":
      case "hard-reload": s.reload(); break;
      case "history": setPanel((p) => (p === "history" ? null : "history")); break;
      case "memory": setPanel((p) => (p === "memory" ? null : "memory")); break;
      case "downloads": setPanel((p) => (p === "downloads" ? null : "downloads")); break;
      case "settings": setPanel((p) => (p === "settings" ? null : "settings")); break;
      case "focus-url":
        // The page webview may hold OS keyboard focus — move it to the UI
        // webview HWND first, or the URL input gets focus visually but
        // keystrokes still go to the page.
        invoke("focus_main").finally(() =>
          window.dispatchEvent(new CustomEvent("zro-focus-url"))
        );
        break;
      case "next-tab": s.cycleTab(1); break;
      case "prev-tab": s.cycleTab(-1); break;
      case "find": invoke("open_find").catch(() => {}); break;
      default:
        if (combo.startsWith("tab-")) s.switchToIndex(parseInt(combo.slice(4), 10));
    }
  }

  useEffect(() => {
    const unsubShortcut = listen<{ combo: string }>("shortcut", (e) => handleCombo(e.payload.combo));

    function comboFromEvent(e: KeyboardEvent): string | null {
      if (e.key === "F5") return "reload";
      if (!e.ctrlKey && !e.metaKey) return null;
      const k = e.key.toLowerCase();
      if (k === "t") return e.shiftKey ? "reopen-tab" : "new-tab";
      if (k === "n" && !e.shiftKey) return "new-tab";
      if (k === "w") return "close-tab";
      if (k === "h") return "history";
      if (k === "m" && !e.shiftKey) return "memory";
      if (k === "j") return "downloads";
      if (k === ",") return "settings";
      if (k === "l" || k === "e") return "focus-url";
      if (k === "f" && !e.shiftKey && !e.altKey) return "find";
      if (k === "r") return "reload";
      if (k === "tab") return e.shiftKey ? "prev-tab" : "next-tab";
      if (k === "pagedown") return "next-tab";
      if (k === "pageup") return "prev-tab";
      if (/^[1-9]$/.test(k)) return `tab-${k}`;
      return null;
    }

    function onKey(e: KeyboardEvent) {
      const combo = comboFromEvent(e);
      if (!combo) return;
      e.preventDefault();
      e.stopPropagation();
      handleCombo(combo);
    }
    window.addEventListener("keydown", onKey);

    return () => {
      unsubShortcut.then((u) => u());
      window.removeEventListener("keydown", onKey);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Popups (window.open / target=_blank) → new tabs
  useEffect(() => {
    const unsub = listen<{ url: string }>("open-url", (e) => {
      if (e.payload.url && e.payload.url !== "about:blank") {
        // Link/popup opened from a tab inside a folder lands in that folder
        const s = useBrowserStore.getState();
        s.createTab(e.payload.url, activeFolderId(s.tabs, s.activeTabId));
      }
    });
    return () => { unsub.then((u) => u()); };
  }, []);

  // --- Native context-menu actions -------------------------------------------
  useEffect(() => {
    const unsub = listen<{ action: string; ctx: string[]; page?: PageCtx }>("ctx-action", async (e) => {
      const { action, ctx, page } = e.payload;
      const s = useBrowserStore.getState();

      // Web-content right-click actions (see browser/menus.rs show_page_menu_now)
      if (action.startsWith("page:")) {
        const p = page ?? { link: "", src: "", selection: "", page_url: "" };
        if (action === "page:open-link" && p.link) s.createTab(p.link);
        else if (action === "page:copy-link" && p.link) navigator.clipboard.writeText(p.link).catch(() => {});
        else if (action === "page:open-image" && p.src) s.createTab(p.src);
        else if (action === "page:copy-image" && p.src) navigator.clipboard.writeText(p.src).catch(() => {});
        else if (action === "page:copy" && p.selection) navigator.clipboard.writeText(p.selection).catch(() => {});
        else if (action === "page:copy-url" && p.page_url) navigator.clipboard.writeText(p.page_url).catch(() => {});
        else if (action === "page:search" && p.selection) s.createTab(searchUrl(p.selection, s.settings.searchEngine));
        else if (action === "page:back") s.goBack();
        else if (action === "page:forward") s.goForward();
        else if (action === "page:reload") s.reload();
        else if (action.startsWith("page:save-image:") && p.src) {
          const format = action.slice("page:save-image:".length);
          invoke("save_image_as", { url: p.src, format }).catch(() => {});
        }
        return;
      }

      if (action === "tab:close") s.closeTabs(ctx);
      else if (action === "tab:close-others") s.closeOtherTabs(ctx);
      else if (action === "tab:duplicate") {
        for (const id of ctx) {
          const t = s.tabs.find((x) => x.id === id);
          if (t) await s.createTab(t.url, t.folderId);
        }
      } else if (action === "tab:copy-url") {
        const urls = ctx
          .map((id) => s.tabs.find((x) => x.id === id)?.url)
          .filter(Boolean)
          .join("\n");
        if (urls) navigator.clipboard.writeText(urls).catch(() => {});
      } else if (action === "tab:reload") {
        for (const id of ctx) {
          const t = s.tabs.find((x) => x.id === id);
          if (t) invoke("navigate_tab", { id, url: t.url }).catch(() => {});
        }
      } else if (action === "tab:freeze") {
        for (const id of ctx) {
          if (id === s.activeTabId) continue; // can't freeze the active tab
          invoke("suspend_tab", { id })
            .then(() => s.updateTab(id, { suspended: true }))
            .catch(() => {});
        }
      } else if (action === "tab:hibernate") {
        for (const id of ctx) {
          if (id === s.activeTabId) continue;
          invoke("hibernate_tab", { id })
            .then(() => s.updateTab(id, { hibernated: true, suspended: false }))
            .catch(() => {});
        }
      } else if (action === "tab:keep-awake") {
        // Toggle off the right-clicked tab's current state (menu label reflects it)
        const anyAwake = ctx.some((id) => s.tabs.find((x) => x.id === id)?.keepAwake);
        for (const id of ctx) s.updateTab(id, { keepAwake: !anyAwake });
      } else if (action === "tab:folder:new") {
        const fid = s.createFolder("New Folder");
        s.moveTabsToFolder(ctx, fid);
        s.setRenamingFolder(fid);
      } else if (action.startsWith("tab:folder:")) {
        s.moveTabsToFolder(ctx, action.slice("tab:folder:".length));
      } else if (action === "tab:unfolder") {
        s.moveTabsToFolder(ctx, undefined);
      } else if (action === "folder:rename") {
        s.setRenamingFolder(ctx[0]);
      } else if (action === "folder:edit") {
        s.setEditingFolder(ctx[0]);
      } else if (action === "folder:delete") {
        s.deleteFolder(ctx[0]);
      } else if (action === "folder:randomize") {
        s.randomizeFolderStyle(ctx[0]);
      } else if (action.startsWith("folder:color:")) {
        s.setFolderStyle(ctx[0], { color: action.slice("folder:color:".length) });
      } else if (action.startsWith("folder:icon:")) {
        s.setFolderStyle(ctx[0], { icon: action.slice("folder:icon:".length) });
      } else if (action === "folder:open-all") {
        const folder = s.folders.find((f) => f.id === ctx[0]);
        if (folder && !folder.isOpen) s.toggleFolder(folder.id);
        const first = s.tabs.find((t) => t.folderId === ctx[0]);
        if (first) s.switchTab(first.id);
      } else if (action === "ext:manage") {
        setPanel("settings");
      } else if (action === "ext:toggle") {
        const ex = useExtStore.getState();
        const item = ex.items.find((i) => i.id === ctx[0]);
        if (item) ex.setEnabled(item.id, !item.enabled);
      } else if (action === "ext:pin") {
        useExtStore.getState().togglePin(ctx[0]);
      } else if (action === "ext:remove") {
        useExtStore.getState().remove(ctx[0]);
      } else if (action.startsWith("tool:")) {
        const [, sub, key] = action.split(":");
        if (sub === "pin" || sub === "unpin") {
          const cur = s.settings.pinnedTools ?? [];
          const next = sub === "pin"
            ? Array.from(new Set([...cur, key]))
            : cur.filter((k) => k !== key);
          s.setSettings({ pinnedTools: next });
        } else if (sub === "open") {
          if (key === "incognito") {
            if (!s.isIncognito) {
              if (s.settings.incognitoLock) setLockOpen(true);
              else s.toggleIncognito();
            }
          } else {
            setPanel(key as PanelKind);
          }
        }
      }

      if (ctx.length > 1 && action.startsWith("tab:")) s.clearSelection();
    });
    return () => { unsub.then((u) => u()); };
  }, []);

  // Maximize detection
  useEffect(() => {
    function check() {
      setIsMaximized(
        window.outerWidth >= screen.availWidth && window.outerHeight >= screen.availHeight
      );
    }
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Boot: restore last session (lazy). Fresh install → Google.
  useEffect(() => {
    if (bootDone) return;
    bootDone = true;
    requestAnimationFrame(() => {
      pushBounds();
      const s = useBrowserStore.getState();
      if (s.tabs.length > 0) {
        const target = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0];
        s.switchTab(target.id).catch(console.error);
      } else {
        createTab("https://www.google.com").catch(console.error);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const radius = isMaximized ? 0 : 12;

  function togglePanel(p: PanelKind) {
    setPanel((cur) => (cur === p ? null : p));
  }

  // Toolbar pin system: pinned tools sit in the bar, the rest fold into a "⋯"
  // overflow (native menu — a DOM dropdown would be occluded by the page
  // webview). Settings is always shown and never unpinnable.
  const TOOL_LABELS: Record<string, string> = {
    shield: "Shields", incognito: "Incognito", memory: "Memory",
    history: "History", downloads: "Downloads", stats: "Stats", ai: "AI",
  };
  const pinnedTools = settings.pinnedTools ?? [];
  const isPinned = (k: string) => pinnedTools.includes(k);
  const unpinnedTools = TOOL_KEYS.filter((k) => !isPinned(k));
  const openOverflow = () =>
    invoke("show_tools_menu", {
      tools: unpinnedTools.map((k) => ({ key: k, label: TOOL_LABELS[k] })),
    }).catch(() => {});
  const toolCtx = (key: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    invoke("show_tool_menu", { key, label: TOOL_LABELS[key] }).catch(() => {});
  };

  return (
    <div
      className="app-shell"
      style={{
        borderRadius: radius,
        boxShadow: "0 0 0 1px rgba(0,0,0,0.6), 0 32px 80px rgba(0,0,0,0.7)",
        position: "relative",
      }}
    >
      <style>{`@keyframes zro-dl-pulse { 0%,100%{opacity:0.4} 50%{opacity:1} }`}</style>

      {/* Single top row: logo · window drag · nav · URL · actions · window btns */}
      <div
        className="flex items-center gap-1 drag-region"
        style={{
          height: BAR_H, padding: "0 6px 0 10px",
          background: isIncognito ? "rgba(80,20,100,0.18)" : "#0c0c0c",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          // Incognito marker: one purple stroke along the bottom of the bar
          // (never tints the rounded window edge)
          boxShadow: isIncognito
            ? "inset 0 -2px 0 rgba(150,80,220,0.75)"
            : "none",
          transition: "background 0.3s, box-shadow 0.3s",
        }}
      >
        <img src={logo} alt="" className="no-drag" style={{ width: 16, height: 16, borderRadius: 4, marginRight: 4 }} draggable={false} />

        <div className="flex gap-0.5 no-drag">
          <NavBtn icon={<ChevronLeft size={15} />} onClick={goBack} title="Back" />
          <NavBtn icon={<ChevronRight size={15} />} onClick={goForward} title="Forward" />
          <NavBtn icon={<RotateCw size={13} />} onClick={reload} title="Reload (Ctrl+R)" />
        </div>

        <UrlBar />

        <div className="flex gap-0.5 no-drag">
          <PinnedExtensions />
          {isPinned("shield") && (
            <ShieldBtn onClick={() => togglePanel("shield")} active={panel === "shield"} onContextMenu={toolCtx("shield")} />
          )}
          {isPinned("incognito") && (
            <NavBtn
              icon={<EyeOff size={13} />}
              onClick={requestIncognito}
              title={isIncognito ? "Exit Incognito" : "Incognito"}
              active={isIncognito}
              activeColor="rgba(150,80,220,0.6)"
              onContextMenu={toolCtx("incognito")}
            />
          )}
          {isPinned("memory") && (
            <NavBtn
              icon={<Network size={13} />}
              onClick={() => togglePanel("memory")}
              title="Memory (Ctrl+M)"
              active={panel === "memory"}
              onContextMenu={toolCtx("memory")}
            />
          )}
          {isPinned("history") && (
            <NavBtn
              icon={<Clock size={13} />}
              onClick={() => togglePanel("history")}
              title="History (Ctrl+H)"
              active={panel === "history"}
              onContextMenu={toolCtx("history")}
            />
          )}
          {isPinned("downloads") && (
            <div style={{ position: "relative" }}>
              <NavBtn
                icon={<Download size={13} />}
                onClick={() => togglePanel("downloads")}
                title="Downloads (Ctrl+J)"
                active={panel === "downloads"}
                onContextMenu={toolCtx("downloads")}
              />
              {(dlUnseen > 0 || dlActive) && panel !== "downloads" && (
                <span style={{
                  position: "absolute", top: 3, right: 3,
                  width: 7, height: 7, borderRadius: "50%",
                  background: dlActive ? "#4f80f5" : "#4fb56a",
                  pointerEvents: "none",
                  animation: dlActive ? "zro-dl-pulse 1.2s ease-in-out infinite" : undefined,
                }} />
              )}
            </div>
          )}
          {isPinned("stats") && (
            <NavBtn icon={<BarChart2 size={14} />} onClick={() => togglePanel("stats")} title="Stats" active={panel === "stats"} onContextMenu={toolCtx("stats")} />
          )}
          {isPinned("ai") && (
            <NavBtn icon={<Bot size={14} />} onClick={() => togglePanel("ai")} title="AI" active={panel === "ai"} onContextMenu={toolCtx("ai")} />
          )}
          {unpinnedTools.length > 0 && (
            <NavBtn
              icon={<MoreHorizontal size={15} />}
              onClick={openOverflow}
              title={`More tools (${unpinnedTools.length})`}
            />
          )}
          <NavBtn icon={<SettingsIcon size={13} />} onClick={() => togglePanel("settings")} title="Settings (Ctrl+,)" active={panel === "settings"} />
        </div>

        {/* Drag handle — the bar is packed with interactive controls and CSS
            app-region does nothing in wry, so this dots grip is THE spot to
            grab the window. Double-click = maximize toggle (OS convention). */}
        <DragHandle />

        {/* Window controls — inline, same row */}
        <div className="flex gap-0.5 no-drag" style={{ marginLeft: 2, paddingLeft: 6, borderLeft: "1px solid rgba(255,255,255,0.06)" }}>
          <WinBtn icon={<Minus size={12} />} onClick={() => invoke("minimize_window")} title="Minimize" />
          <WinBtn icon={<Square size={9} />} onClick={() => invoke("maximize_window")} title="Maximize" />
          <WinBtn icon={<X size={12} />} onClick={() => invoke("close_window")} title="Close" danger />
        </div>
      </div>

      {/* Main content row */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
        <Sidebar />

        {/* Content area — native page webview renders here (behind the UI) */}
        <div ref={contentRef} style={{ flex: 1, background: "#0c0c0c", position: "relative" }}>
          {tabs.length === 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              style={{
                position: "absolute", inset: 0, display: "flex",
                alignItems: "center", justifyContent: "center",
                flexDirection: "column", gap: 12,
              }}
            >
              <img src={logo} alt="zro" style={{ width: 48, opacity: 0.12 }} />
              <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#222" }}>zro</div>
            </motion.div>
          )}
        </div>

        {/* Side panels — absolute OVERLAYS over the page (chrome renders on top
            now, so the page never shrinks). Each tracks its rect to punch the
            region hole. */}
        <AnimatePresence>
          {panel && (
            <PanelOverlay key={panel} kind={panel}>
              {panel === "stats" && <StatsPanel onClose={() => setPanel(null)} />}
              {panel === "ai" && <AiPanel onClose={() => setPanel(null)} />}
              {panel === "history" && <HistoryPanel onClose={() => setPanel(null)} />}
              {panel === "memory" && <MemoryPanel onClose={() => setPanel(null)} />}
              {panel === "settings" && <SettingsPanel onClose={() => setPanel(null)} />}
              {panel === "shield" && <ShieldPanel onClose={() => setPanel(null)} />}
              {panel === "downloads" && <DownloadsPanel onClose={() => setPanel(null)} />}
            </PanelOverlay>
          )}
        </AnimatePresence>

        {/* Incognito unlock gate (Windows Hello / passcode) */}
        <AnimatePresence>
          {lockOpen && (
            <IncognitoLock
              onUnlock={() => {
                setLockOpen(false);
                useBrowserStore.getState().toggleIncognito();
              }}
              onCancel={() => setLockOpen(false)}
            />
          )}
        </AnimatePresence>

        {/* Auto-update toast (self-managing; tracks its own overlay rect) */}
        <UpdateBanner />
      </div>
    </div>
  );
}

/** Positions a side panel as an absolute overlay and reports its rect so the
 *  native region punches a hole for it (renders OVER the page webview).
 *  Overlay id must be unique per panel kind: while panel A exit-animates and
 *  panel B mounts, both are alive — a shared id would let A's cleanup delete
 *  B's region hole, leaving B invisible under the page webview.
 *
 *  No padding here: the region is a hard clip (SetWindowRgn), not alpha
 *  compositing, so anything outside the tracked rect that isn't the live
 *  page is just opaque .app-shell background (#0c0c0c) showing through —
 *  padding to "fit" a drop shadow just paints a solid near-black bar, since
 *  a soft shadow over a near-black ancestor bg reads as solid black. Panels
 *  use an inset shadow instead (see each panel's boxShadow), which paints
 *  inside their own already-tracked box and never needs extra rect. */
function PanelOverlay({ kind, children }: { kind: PanelKind; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => trackOverlay(`panel-${kind}`, ref.current, 0), [kind]);
  return (
    <div
      ref={ref}
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, zIndex: 50 }}
    >
      {children}
    </div>
  );
}

/** Pinned extensions get their own toolbar icon. Clicking pops the
 *  extension's popup page out as a real small floating window anchored under
 *  the icon (chrome-style) — never a tab. */
function PinnedExtensions() {
  const { items, pinned, icons } = useExtStore();
  const shown = pinned
    .map((id) => items.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => !!e);

  if (shown.length === 0) return null;

  return (
    <>
      {shown.map((ext) => (
        <motion.button
          key={ext.id}
          onClick={(e) => {
            if (!ext.popup) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            invoke("open_extension_popup", {
              extId: ext.id,
              popup: ext.popup,
              anchorX: r.left,
              anchorY: r.bottom + 6,
            }).catch(console.error);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            invoke("show_extension_menu", {
              id: ext.id,
              enabled: ext.enabled,
              pinned: true,
            }).catch(() => {});
          }}
          title={ext.popup ? ext.name : `${ext.name} (no popup)`}
          whileHover={{ backgroundColor: "rgba(255,255,255,0.07)" }}
          whileTap={{ scale: 0.88 }}
          transition={{ duration: 0.12 }}
          style={{
            width: 28, height: 28, border: "none", cursor: ext.popup ? "pointer" : "default",
            borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center",
            background: "transparent", opacity: ext.enabled ? 1 : 0.4, padding: 0,
          }}
        >
          {icons[ext.id]
            ? <img src={icons[ext.id]} alt="" style={{ width: 16, height: 16, borderRadius: 4 }} draggable={false} />
            : <Puzzle size={14} color="#7a9cf5" />}
        </motion.button>
      ))}
      <div style={{ width: 1, alignSelf: "stretch", margin: "6px 2px", background: "rgba(255,255,255,0.06)" }} />
    </>
  );
}

interface NavBtnProps {
  icon: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  activeColor?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
}

/** Shields status in the toolbar: lit blue with a filled crest when active
 *  (dot appears once it has blocked something), dim when off. Click → the
 *  Shields panel, where the suite's pillars live. */
function ShieldBtn({ onClick, active, onContextMenu }: { onClick: () => void; active?: boolean; onContextMenu?: (e: React.MouseEvent) => void }) {
  const enabled = useBrowserStore((s) => s.settings.shieldsEnabled);
  const [blocked, setBlocked] = useState(0);
  useEffect(() => {
    let alive = true;
    const pull = () => {
      // Hidden window = nothing to show and nothing browsing — skip the IPC
      // beat instead of waking the UI renderer forever while minimized
      if (document.hidden) return;
      invoke<{ blocked: number }>("get_shield_stats")
        .then((s) => alive && setBlocked(s.blocked))
        .catch(() => {});
    };
    pull();
    const id = setInterval(pull, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return (
    <motion.button
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={enabled ? `Shields active — ${blocked.toLocaleString()} blocked` : "Shields off"}
      whileHover={{ backgroundColor: "rgba(255,255,255,0.07)" }}
      whileTap={{ scale: 0.88 }}
      style={{
        position: "relative", width: 28, height: 28, border: "none", cursor: "pointer",
        borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center",
        background: active ? "rgba(79,128,245,0.25)" : "transparent",
        color: enabled ? "#5b8def" : "#6a6a6a",
      }}
    >
      <Shield size={13} fill={enabled ? "rgba(79,128,245,0.22)" : "none"} />
      {enabled && blocked > 0 && (
        <span style={{
          position: "absolute", top: 4, right: 4, width: 6, height: 6, borderRadius: "50%",
          background: "#4f80f5", pointerEvents: "none",
        }} />
      )}
    </motion.button>
  );
}

function NavBtn({ icon, onClick, title, active, activeColor = "rgba(79,128,245,0.6)", onContextMenu }: NavBtnProps) {
  return (
    <motion.button
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      whileHover={{ backgroundColor: "rgba(255,255,255,0.07)", color: "#e4e4e4" }}
      whileTap={{ scale: 0.88 }}
      animate={{
        color: active ? "#e4e4e4" : "#8f8f8f",
        backgroundColor: active ? activeColor : "transparent",
      }}
      transition={{ duration: 0.12 }}
      style={{
        width: 28, height: 28, border: "none", cursor: "pointer",
        borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {icon}
    </motion.button>
  );
}

/** Dots-grid grip: mousedown hands the drag to the OS (start_dragging), so it
 *  moves the window with native snap/aero behavior. */
function DragHandle() {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="no-drag"
      title="Drag window"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={(e) => {
        if (e.button !== 0 || e.detail > 1) return; // left button, not double-click
        e.preventDefault();
        invoke("start_drag").catch(() => {});
      }}
      onDoubleClick={() => invoke("maximize_window")}
      style={{
        alignSelf: "stretch", width: 34, marginLeft: 2, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "grab", borderRadius: 5,
        background: hover ? "rgba(255,255,255,0.04)" : "transparent",
        transition: "background 0.12s",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 3px)", gap: 3 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} style={{
            width: 3, height: 3, borderRadius: "50%",
            background: hover ? "#7a7a7a" : "#4c4c4c",
            transition: "background 0.12s",
          }} />
        ))}
      </div>
    </div>
  );
}

function WinBtn({ icon, onClick, title, danger }: { icon: React.ReactNode; onClick: () => void; title: string; danger?: boolean }) {
  return (
    <motion.button
      onClick={onClick}
      title={title}
      whileHover={{ backgroundColor: danger ? "rgba(220,50,50,0.8)" : "rgba(255,255,255,0.09)", color: "#e4e4e4" }}
      whileTap={{ scale: 0.9 }}
      transition={{ duration: 0.1 }}
      style={{
        // All three window buttons read at the same brightness — minimize and
        // maximize used to look dimmer than close (thin glyphs at #8f8f8f)
        width: 28, height: 26, color: "#c9c9c9", background: "transparent",
        border: "none", cursor: "pointer", borderRadius: 5,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {icon}
    </motion.button>
  );
}
