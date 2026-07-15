import { useMemo, useRef, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DndContext, DragEndEvent, DragOverlay, DragStartEvent,
  PointerSensor, useSensor, useSensors, DragOverEvent, DragMoveEvent, Modifier,
  closestCenter,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, FolderPlus } from "lucide-react";
import { Tab, inProfile, activeFolderId, useBrowserStore } from "../store/tabs";
import { trackOverlay } from "../store/overlays";
import TabItem, { TabItemGhost } from "./TabItem";
import FolderItem from "./FolderItem";

const COLLAPSED_W = 44;
const EXPANDED_W = 220;

/** Right-click a tab: apply to the whole selection when the target is part of it. */
export async function openTabMenu(e: React.MouseEvent, tabId: string) {
  e.preventDefault();
  const s = useBrowserStore.getState();
  const ids =
    s.selectedTabIds.length > 1 && s.selectedTabIds.includes(tabId)
      ? s.selectedTabIds
      : [tabId];
  const tab = s.tabs.find((t) => t.id === tabId);
  await invoke("show_tab_menu", {
    ids,
    folders: s.folders.map((f) => ({ id: f.id, name: f.name })),
    inFolder: !!tab?.folderId,
    keepAwake: !!tab?.keepAwake,
  }).catch(console.error);
}

export async function openFolderMenu(e: React.MouseEvent, folderId: string) {
  e.preventDefault();
  await invoke("show_folder_menu", { id: folderId }).catch(console.error);
}

export default function Sidebar() {
  const {
    tabs: allTabs, folders: allFolders, activeTabId, selectedTabIds,
    createTab, createFolder, placeTabs, clearSelection,
    toggleFolder, isIncognito, settings,
  } = useBrowserStore();

  // Separate tab spaces: the sidebar shows ONLY the active profile's tabs
  // AND folders (profiles are separate browsers), and incognito mode shows
  // ONLY incognito tabs (no folders — folders are a normal-mode structure).
  const tabs = allTabs.filter(
    (t) => !!t.incognito === isIncognito && inProfile(t, settings.activeProfileId)
  );
  const folders = isIncognito
    ? []
    : allFolders.filter((f) => inProfile(f, settings.activeProfileId));

  const [expanded, setExpanded] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // The dragged tab's REAL row width — DragStack used to hardcode 196px
  // while the actual flyout row is ~212px, leaving an uncovered strip on the
  // right that read as a black box around the dragged tab (the flyout's own
  // near-black background showing through where the ghost drew nothing).
  const [dragWidth, setDragWidth] = useState(196);
  // Which half of the hovered row the drag sits in — final before/after
  // placement at drop time. A ref, not state: it changes every pointer move
  // and nothing needs to re-render for it.
  const overSideRef = useRef<"above" | "below">("below");
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const openTimer = useRef<ReturnType<typeof setTimeout>>();
  // Hovering a CLOSED folder mid-drag for 1s springs it open
  const dwellTimer = useRef<ReturnType<typeof setTimeout>>();
  // Pre-drag tab order — cross-container moves happen LIVE during the drag
  // (that's what makes rows shift with the normal animation), so a cancelled
  // drag must put everything back where it was.
  const tabsSnapshot = useRef<Tab[] | null>(null);
  const menuGuard = useRef(0);
  const flyoutRef = useRef<HTMLDivElement>(null);

  const looseTabs = tabs.filter((t) => !t.folderId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

  // The flyout renders OVER the page (chrome-on-top region): report its rect
  // so Rust punches a hole for it. No viewport shift — the page never moves.
  useEffect(() => {
    if (!expanded) return;
    return trackOverlay("sidebar", flyoutRef.current, 0);
  }, [expanded]);

  // New-folder input pins the flyout open (same as rename/style editors)
  useEffect(() => {
    if (!showNewFolder) return;
    const s = useBrowserStore.getState();
    s.pinSidebar();
    return () => useBrowserStore.getState().unpinSidebar();
  }, [showNewFolder]);

  // Rename / style-edit from the collapsed rail's context menu — the editors
  // only render in the flyout, so expand it first
  const renamingFolderId = useBrowserStore((s) => s.renamingFolderId);
  const editingFolderId = useBrowserStore((s) => s.editingFolderId);
  useEffect(() => {
    if (renamingFolderId || editingFolderId) setExpanded(true);
  }, [renamingFolderId, editingFolderId]);

  function handleExpand() {
    clearTimeout(leaveTimer.current);
    clearTimeout(openTimer.current);
    // Short hover-intent delay — a casual mouse pass shouldn't expand,
    // but a deliberate hover must feel instant
    openTimer.current = setTimeout(() => setExpanded(true), 120);
  }

  function cancelExpand() {
    clearTimeout(openTimer.current);
  }

  function handleCollapse() {
    clearTimeout(openTimer.current);
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      // Dragging, a native menu open, or a live editor (rename / folder
      // style / new-folder input) — stay expanded and re-check later
      const pinned = useBrowserStore.getState().sidebarPins > 0;
      if (activeId || pinned || Date.now() - menuGuard.current < 2500) {
        handleCollapse();
        return;
      }
      setExpanded(false);
    }, 150);
  }

  async function onTabContextMenu(e: React.MouseEvent, tabId: string) {
    menuGuard.current = Date.now();
    await openTabMenu(e, tabId);
    menuGuard.current = 0; // popup closed (or returned immediately — timeout covers that)
  }

  async function onFolderContextMenu(e: React.MouseEvent, folderId: string) {
    menuGuard.current = Date.now();
    await openFolderMenu(e, folderId);
    menuGuard.current = 0;
  }

  // The drag ghost needs NO overlay hole of its own: it only ever moves
  // within the flyout, which is ALREADY one continuous tracked overlay
  // ("sidebar", above) for as long as it's open — and it must be open to
  // start a drag at all. A separate per-move hole used to be pushed here on
  // every pointer move via reportOverlay → invoke("set_overlays") → a native
  // SetWindowRgn call in Rust — a full IPC round trip per animation frame.
  // The ghost itself is pure CSS/dnd-kit and moves instantly; the native
  // hole lagged behind that async round trip, which read as "the drag
  // renders in its own delayed window". Worse, a fast drag could queue more
  // set_overlays calls than Rust could drain before drop, so the hole kept
  // updating for seconds afterward — the "blank for 5 seconds" after
  // dropping a tab. Fix is to not touch the overlay system during drag at
  // all; only the real row width (for the ghost's own sizing) is captured.
  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(active.id as string);
    clearTimeout(leaveTimer.current);
    const r = active.rect.current.initial;
    if (r) setDragWidth(r.width);
    // Cross-container moves are applied to the store LIVE during the drag
    // (that's what makes rows part and close with the normal tab animation
    // instead of an insertion line) — a cancelled drag restores this.
    tabsSnapshot.current = useBrowserStore.getState().tabs;
  }

  // Folders stay exactly as they are during a drag — the only state change
  // is dwell-open: hold over a CLOSED folder for 1s and it opens (and then
  // behaves like any open folder). Nothing auto-closes afterwards.
  //
  // Crossing into a different container moves the dragged tab there IN THE
  // STORE immediately: the source list closes its gap, the target list makes
  // room, both with the standard sortable animation — same feel as
  // reordering within a list. Same-container hovers are dnd-kit's own
  // preview (no store writes), and the final exact position lands on drop.
  function handleDragOver({ active, over }: DragOverEvent) {
    const id = (over?.id as string) ?? null;
    setOverId(id);
    clearTimeout(dwellTimer.current);

    if (!id) return;
    const actStr = active.id as string;
    const s = useBrowserStore.getState();
    const container = s.tabs.find((t) => t.id === actStr)?.folderId;

    if (id.startsWith("folder-")) {
      const f = s.folders.find((x) => x.id === id);
      if (f && !f.isOpen) {
        dwellTimer.current = setTimeout(() => toggleFolder(id), 1000);
      }
      if (container !== id) {
        // Entering via the header → tail of the folder (drop here keeps it)
        placeTabs([actStr], id, null, true);
      }
      return;
    }
    if (id === "root-zone") {
      if (container !== undefined) {
        placeTabs([actStr], undefined, null, true);
      }
      return;
    }
    const overTab = s.tabs.find((t) => t.id === id);
    if (overTab && overTab.id !== actStr && overTab.folderId !== container) {
      const a = active.rect.current.translated;
      const after =
        !!a && !!over?.rect &&
        a.top + a.height / 2 > over.rect.top + over.rect.height / 2;
      placeTabs([actStr], overTab.folderId, id, after);
    }
  }

  function handleDragMove({ active, over }: DragMoveEvent) {
    if (!over) return;
    const a = active.rect.current.translated;
    if (!a) return;
    overSideRef.current =
      a.top + a.height / 2 > over.rect.top + over.rect.height / 2 ? "below" : "above";
  }

  // Keep the ghost inside the flyout at all times — a "normal popout" is a
  // bounded, contained drag, and (now that the drag no longer punches its
  // own overlay hole per move) this also guarantees the ghost never drifts
  // outside the flyout's already-open "sidebar" hole.
  const clampToFlyout: Modifier = ({ transform, draggingNodeRect }) => {
    const bounds = flyoutRef.current?.getBoundingClientRect();
    if (!bounds || !draggingNodeRect) return transform;
    return {
      ...transform,
      x: Math.min(Math.max(transform.x, bounds.left - draggingNodeRect.left), bounds.right - draggingNodeRect.right),
      y: Math.min(Math.max(transform.y, bounds.top - draggingNodeRect.top), bounds.bottom - draggingNodeRect.bottom),
    };
  };

  function handleDragEnd({ active, over }: DragEndEvent) {
    clearTimeout(dwellTimer.current);
    setActiveId(null);
    setOverId(null);
    tabsSnapshot.current = null;

    if (!over) return;

    const ovStr = over.id as string;
    const actStr = active.id as string;
    const sel =
      selectedTabIds.length > 1 && selectedTabIds.includes(actStr)
        ? selectedTabIds
        : [actStr];

    const overTab = useBrowserStore.getState().tabs.find((t) => t.id === ovStr);
    if (ovStr.startsWith("folder-")) {
      // Dropped on the folder header itself → last place in that folder
      placeTabs(sel, ovStr, null, true);
    } else if (overTab && !sel.includes(ovStr)) {
      // Dropped on a row (loose OR inside a folder) → land in that row's
      // container, before/after it depending on which half the drag sat in.
      // Compute the side from the FINAL dragged rect here — a fast flick can
      // end before handleDragMove fires for the last frame, leaving the cached
      // overSideRef stale (the drop then lands on the wrong side / no-ops).
      const a = active.rect.current.translated;
      const below = a && over.rect
        ? a.top + a.height / 2 > over.rect.top + over.rect.height / 2
        : overSideRef.current === "below";
      placeTabs(sel, overTab.folderId, ovStr, below);
    } else if (ovStr === "root-zone") {
      // Empty space → end of the loose list (pulls out of any folder)
      placeTabs(sel, undefined, null, true);
    }
    clearSelection();
  }

  function commitNewFolder() {
    const n = newFolderName.trim();
    if (n) createFolder(n);
    setNewFolderName("");
    setShowNewFolder(false);
  }

  const draggedTabs: Tab[] = activeId
    ? selectedTabIds.length > 1 && selectedTabIds.includes(activeId)
      ? (selectedTabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean) as Tab[])
      : [tabs.find((t) => t.id === activeId)].filter(Boolean) as Tab[]
    : [];

  // While a multi-select drag is live, the whole bundle travels in the
  // DragOverlay — the other selected tabs must VANISH from the list, not sit
  // there looking left behind.
  const inFlight: Set<string> =
    activeId && draggedTabs.length > 1
      ? new Set(draggedTabs.map((t) => t.id).filter((id) => id !== activeId))
      : new Set();

  // SortableContext's `items` must be REFERENCE-STABLE across renders that
  // don't actually change the list — `.filter().map()` inline returns a new
  // array every render (Sidebar re-renders on every onDragOver as the
  // pointer crosses rows), and dnd-kit reads that as "the list changed
  // externally", which snaps the just-settled item to its new spot with NO
  // transition instead of animating it. Which items that hits depends on
  // drag direction, which is exactly the down-smooth/up-instant asymmetry.
  // useMemo keyed on the actual id sequence keeps the reference stable.
  const sortableIds = useMemo(
    () => looseTabs.filter((t) => !inFlight.has(t.id)).map((t) => t.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [looseTabs.map((t) => t.id).join(","), [...inFlight].join(",")]
  );

  return (
    <>
      {/* Collapsed rail — permanent 44px flex child. The page area never
          changes when the flyout opens, so nothing shifts or reflows. */}
      <div
        className="flex flex-col no-select"
        style={{
          width: COLLAPSED_W,
          height: "100%",
          background: "#0f0f0f",
          borderRight: "1px solid rgba(255,255,255,0.05)",
          flexShrink: 0,
          overflow: "hidden",
        }}
        onMouseEnter={handleExpand}
        onMouseLeave={cancelExpand}
      >
        <ProfileStrip />
        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "8px 4px 4px" }}>
          {folders.map((folder) => (
            <FolderItem
              key={folder.id}
              folder={folder}
              expanded={false}
              onContextMenu={onTabContextMenu}
              onFolderContextMenu={onFolderContextMenu}
            />
          ))}
          {looseTabs.map((tab) => (
            <div key={tab.id} style={{ height: 32, marginBottom: 2 }}>
              <TabItem
                tab={tab}
                isActive={tab.id === activeTabId}
                isSelected={selectedTabIds.includes(tab.id)}
                collapsed
                overlay
                onContextMenu={onTabContextMenu}
              />
            </div>
          ))}
        </div>
        <div style={{ padding: "6px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, borderTop: "1px solid rgba(255,255,255,0.04)" }}>
          <SidebarBtn onClick={() => createTab(undefined, activeFolderId(tabs, activeTabId))} title="New Tab (Ctrl+T)" icon={<Plus size={14} />} />
        </div>
      </div>

      {/* Expanded flyout — absolute overlay, never part of the flex layout */}
      <AnimatePresence>
        {expanded && (
          <DndContext
            sensors={sensors}
            // closestCenter (not the default rectIntersection) always resolves a
            // target during a reorder — a fast flick no longer ends with a null
            // `over` and silently drops nothing.
            collisionDetection={closestCenter}
            modifiers={[clampToFlyout]}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={() => {
              clearTimeout(dwellTimer.current);
              setActiveId(null);
              setOverId(null);
              // Undo any live cross-container moves from this drag
              if (tabsSnapshot.current) {
                useBrowserStore.setState({ tabs: tabsSnapshot.current });
                tabsSnapshot.current = null;
              }
            }}
          >
            <motion.div
              ref={flyoutRef}
              className="flex flex-col no-select"
              // No width animation — the region hole must match the flyout's
              // final rect in the same frame, so it appears instantly
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.06 }}
              style={{
                position: "absolute",
                left: 0, top: 0, bottom: 0,
                width: EXPANDED_W,
                zIndex: 40,
                background: "#0f0f0f",
                borderRight: "1px solid rgba(255,255,255,0.08)",
                boxShadow: "8px 0 32px rgba(0,0,0,0.45)",
                overflow: "hidden",
              }}
              onMouseEnter={() => clearTimeout(leaveTimer.current)}
              onMouseLeave={handleCollapse}
            >
              <ProfileStrip expanded />
              <RootDropZone isOver={overId === "root-zone"}>
                {/* Folders */}
                {folders.map((folder) => (
                  <FolderDropZone key={folder.id} folderId={folder.id} isOver={overId === folder.id}>
                    <FolderItem
                      folder={folder}
                      expanded
                      onContextMenu={onTabContextMenu}
                      onFolderContextMenu={onFolderContextMenu}
                    />
                  </FolderDropZone>
                ))}

                {/* Loose tabs */}
                <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                  {looseTabs.filter((t) => !inFlight.has(t.id)).map((tab) => (
                    <div key={tab.id} style={{ height: 32, marginBottom: 2, position: "relative" }}>
                      <TabItem
                        tab={tab}
                        isActive={tab.id === activeTabId}
                        isSelected={selectedTabIds.includes(tab.id)}
                        onContextMenu={onTabContextMenu}
                      />
                    </div>
                  ))}
                </SortableContext>

                {tabs.length === 0 && (
                  <div style={{ padding: "20px 8px", textAlign: "center", color: "#2a2a2a", fontSize: 11 }}>
                    No tabs open
                  </div>
                )}
              </RootDropZone>

              {/* New folder input */}
              <AnimatePresence>
                {showNewFolder && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.13 }}
                    style={{ overflow: "hidden", padding: "0 8px" }}
                  >
                    <input
                      autoFocus
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onBlur={() => { if (!newFolderName.trim()) setShowNewFolder(false); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitNewFolder();
                        if (e.key === "Escape") { setShowNewFolder(false); setNewFolderName(""); }
                        e.stopPropagation();
                      }}
                      placeholder="Folder name"
                      style={{
                        width: "100%", fontSize: 12, color: "#e4e4e4",
                        background: "rgba(255,255,255,0.06)", borderRadius: 5,
                        padding: "5px 8px", marginBottom: 6,
                        border: "1px solid rgba(79,128,245,0.4)",
                      }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Bottom actions — prominent New Tab button when expanded */}
              <div
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 8px",
                  borderTop: "1px solid rgba(255,255,255,0.04)",
                  flexShrink: 0,
                }}
              >
                <motion.button
                  onClick={() => createTab(undefined, activeFolderId(tabs, activeTabId))}
                  title="New Tab (Ctrl+T)"
                  whileHover={{ backgroundColor: "rgba(79,128,245,0.16)", color: "#9ab4f5" }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ duration: 0.1 }}
                  style={{
                    flex: 1, height: 34, borderRadius: 8, cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                    background: "rgba(79,128,245,0.1)", border: "1px solid rgba(79,128,245,0.22)",
                    color: "#7a9cf5", fontSize: 12, fontWeight: 500,
                  }}
                >
                  <Plus size={16} /> New Tab
                </motion.button>
                <motion.button
                  onClick={() => setShowNewFolder((v) => !v)}
                  title="New Folder"
                  whileHover={{ backgroundColor: "rgba(255,255,255,0.08)", color: "#ccc" }}
                  whileTap={{ scale: 0.96 }}
                  transition={{ duration: 0.1 }}
                  style={{
                    width: 34, height: 34, borderRadius: 8, cursor: "pointer", flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
                    color: "#777",
                  }}
                >
                  <FolderPlus size={15} />
                </motion.button>
              </div>
            </motion.div>

            <DragOverlay dropAnimation={{ duration: 120, easing: "cubic-bezier(0.2,0,0,1)" }}>
              {draggedTabs.length > 0 && <DragStack tabs={draggedTabs} width={dragWidth} />}
            </DragOverlay>
          </DndContext>
        )}
      </AnimatePresence>
    </>
  );
}

function RootDropZone({ isOver, children }: { isOver: boolean; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: "root-zone" });
  return (
    <div
      ref={setNodeRef}
      style={{
        flex: 1, overflowY: "auto", overflowX: "hidden", padding: "8px 4px 4px",
        background: isOver ? "rgba(79,128,245,0.04)" : "transparent",
        transition: "background 0.1s",
      }}
    >
      {children}
    </div>
  );
}

function FolderDropZone({ folderId, isOver, children }: {
  folderId: string; isOver: boolean; children: React.ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: folderId });
  return (
    <motion.div
      ref={setNodeRef}
      animate={{ backgroundColor: isOver ? "rgba(79,128,245,0.16)" : "rgba(0,0,0,0)" }}
      transition={{ duration: 0.1 }}
      style={{
        borderRadius: 6,
        // Bright accent ring so "this folder will receive the drop" is
        // unmissable — the old 0.1-alpha wash was invisible on #0f0f0f
        boxShadow: isOver ? "inset 0 0 0 1.5px rgba(105,146,245,0.85)" : "none",
        transition: "box-shadow 0.1s",
      }}
    >
      {children}
    </motion.div>
  );
}

function DragStack({ tabs, width }: { tabs: Tab[]; width: number }) {
  const shown = tabs.slice(0, 3);
  return (
    <div style={{ position: "relative", width, height: 32 + (shown.length - 1) * 4 }}>
      {shown.slice(1).reverse().map((tab, ri) => {
        const depth = shown.length - 1 - ri;
        return (
          <div key={tab.id} style={{
            position: "absolute", top: depth * 4, left: depth * 3, right: depth * 3,
            height: 32, borderRadius: 6,
            background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.06)",
            opacity: 1 - depth * 0.25, zIndex: shown.length - depth,
          }} />
        );
      })}
      {/* No outer box-shadow: the punched drag-hole shows the chrome
          webview's own near-black bg wherever nothing else paints, so an
          outer shadow (black-on-near-black) just reads as a solid box. A
          border reads instead, same treatment as the stacked cards above. */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, zIndex: shown.length + 1,
        borderRadius: 6, border: "1px solid rgba(255,255,255,0.12)",
      }}>
        {/* padRight reserves space for the count badge — title must not clip through it */}
        <TabItemGhost tab={shown[0]} depth={0} padRight={tabs.length > 1} />
        {tabs.length > 1 && (
          <div style={{
            position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
            fontSize: 9, color: "#888", background: "rgba(255,255,255,0.1)",
            padding: "1px 5px", borderRadius: 3,
          }}>
            {tabs.length}
          </div>
        )}
      </div>
    </div>
  );
}

/** Which browser am I in? Profiles are separate browsers, so they sit at the
 *  TOP of the sidebar like a workspace switcher — every profile visible, one
 *  click switches directly. Hidden while only the default profile exists.
 *  Collapsed rail: a stack of initial squares. Flyout: named segments. */
function ProfileStrip({ expanded = false }: { expanded?: boolean }) {
  const settings = useBrowserStore((s) => s.settings);
  const switchProfile = useBrowserStore((s) => s.switchProfile);
  const { profiles, activeProfileId } = settings;
  if (profiles.length < 2) return null;

  if (!expanded) {
    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
        padding: "8px 0 6px", borderBottom: "1px solid rgba(255,255,255,0.04)", flexShrink: 0,
      }}>
        {profiles.map((p) => {
          const active = p.id === activeProfileId;
          return (
            <motion.button
              key={p.id}
              onClick={() => switchProfile(p.id)}
              title={active ? `${p.name} (current)` : `Switch to ${p.name}`}
              whileHover={active ? {} : { backgroundColor: "rgba(255,255,255,0.08)", color: "#bbb" }}
              whileTap={{ scale: 0.92 }}
              transition={{ duration: 0.1 }}
              style={{
                width: 22, height: 22, borderRadius: 6, cursor: "pointer", padding: 0,
                background: active ? `${p.color}26` : "rgba(255,255,255,0.03)",
                border: `1px solid ${active ? `${p.color}66` : "rgba(255,255,255,0.05)"}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 9, fontWeight: 600, textTransform: "uppercase",
                color: active ? p.color : "#4a4a4a",
              }}
            >
              {p.name.slice(0, 1)}
            </motion.button>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", gap: 4, padding: "8px 8px 7px",
      borderBottom: "1px solid rgba(255,255,255,0.04)", flexShrink: 0,
    }}>
      {profiles.map((p) => {
        const active = p.id === activeProfileId;
        return (
          <button
            key={p.id}
            onClick={() => switchProfile(p.id)}
            title={active ? `${p.name} (current)` : `Switch to ${p.name}`}
            style={{
              flex: 1, minWidth: 0, height: 25, borderRadius: 6, cursor: "pointer",
              background: active ? `${p.color}1f` : "rgba(255,255,255,0.03)",
              border: `1px solid ${active ? `${p.color}59` : "rgba(255,255,255,0.06)"}`,
              color: active ? p.color : "#555", fontSize: 10, fontWeight: 500,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              padding: "0 6px",
            }}
          >
            {p.name}
          </button>
        );
      })}
    </div>
  );
}

function SidebarBtn({ onClick, title, icon }: { onClick: () => void; title: string; icon: React.ReactNode }) {
  return (
    <motion.button
      onClick={onClick} title={title}
      whileHover={{ backgroundColor: "rgba(255,255,255,0.07)", color: "#e4e4e4" }}
      whileTap={{ scale: 0.92 }}
      transition={{ duration: 0.1 }}
      style={{
        width: 26, height: 26, color: "#3a3a3a", background: "transparent",
        border: "none", cursor: "pointer", borderRadius: 5,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {icon}
    </motion.button>
  );
}
