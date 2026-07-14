import { useState, useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronRight, Plus } from "lucide-react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useBrowserStore, inProfile, FOLDER_COLORS, FOLDER_ICONS } from "../store/tabs";
import type { Folder as FolderType } from "../store/tabs";
import TabItem from "./TabItem";
import FolderIcon from "./FolderIcon";

interface Props {
  folder: FolderType;
  expanded?: boolean;
  onContextMenu: (e: React.MouseEvent, tabId: string) => void;
  onFolderContextMenu: (e: React.MouseEvent, folderId: string) => void;
}

export default function FolderItem({ folder, expanded = true, onContextMenu, onFolderContextMenu }: Props) {
  const {
    tabs, activeTabId, selectedTabIds,
    toggleFolder, renameFolder, createTab,
    renamingFolderId, setRenamingFolder,
    editingFolderId, setEditingFolder,
    pinSidebar, unpinSidebar,
  } = useBrowserStore();
  const [editing, setEditing] = useState(false);
  const [headerHover, setHeaderHover] = useState(false);
  const [nameValue, setNameValue] = useState(folder.name);

  // Folders only surface the active profile's tabs — other profiles' tabs
  // stay in their own browser space
  const activeProfileId = useBrowserStore((s) => s.settings.activeProfileId);
  const folderTabs = tabs.filter((t) => t.folderId === folder.id && inProfile(t, activeProfileId));
  const hasActive = folderTabs.some((t) => t.id === activeTabId);
  const styleOpen = editingFolderId === folder.id;

  // Same reference-stability requirement as the Sidebar's loose list: a fresh
  // ids array per render makes dnd-kit skip transitions (down/up asymmetry).
  const folderTabIds = useMemo(
    () => folderTabs.map((t) => t.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folderTabs.map((t) => t.id).join(",")]
  );

  // Auto-enter rename mode when triggered from the context menu. Only the
  // FLYOUT instance may consume the signal — the rail instance renders no
  // input, and eating the flag there would kill rename-from-rail.
  useEffect(() => {
    if (expanded && renamingFolderId === folder.id) {
      setNameValue(folder.name);
      setEditing(true);
      setRenamingFolder(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renamingFolderId, expanded]);

  // Any live editor (rename input / style popover) pins the flyout open —
  // mouse-leave must not collapse the sidebar mid-edit.
  useEffect(() => {
    if (!editing && !styleOpen) return;
    pinSidebar();
    return () => unpinSidebar();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, styleOpen]);

  function commitRename() {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== folder.name) renameFolder(folder.id, trimmed);
    else setNameValue(folder.name);
    setEditing(false);
  }

  // Rail tile — SVG icon chip tinted with the folder color. Open folders show
  // their tabs' favicons beneath, mirroring the flyout order — tab targets
  // must not shift when the flyout opens/closes.
  if (!expanded) {
    return (
      <div style={{ marginBottom: 2 }}>
        <motion.div
          whileHover={{ backgroundColor: "rgba(255,255,255,0.06)" }}
          transition={{ duration: 0.1 }}
          title={`${folder.name} (${folderTabs.length})`}
          onClick={() => toggleFolder(folder.id)}
          onContextMenu={(e) => onFolderContextMenu(e, folder.id)}
          style={{
            width: 32, height: 32, borderRadius: 6, margin: "0 auto 2px",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "default", position: "relative",
            background: `${folder.color}14`,
            border: `1px solid ${folder.color}2e`,
          }}
        >
          {hasActive && (
            <div style={{ position: "absolute", left: 1, top: 8, bottom: 8, width: 2, borderRadius: 2, background: folder.color }} />
          )}
          <FolderIcon name={folder.icon} size={13} color={folder.color} />
        </motion.div>
        {folder.isOpen && folderTabs.map((tab) => (
          <div key={tab.id} style={{ height: 32, marginBottom: 2, position: "relative" }}>
            {/* Thin folder-color thread ties the tabs to their folder */}
            <div style={{
              position: "absolute", left: 3, top: 4, bottom: 4, width: 2,
              borderRadius: 2, background: `${folder.color}55`, pointerEvents: "none",
            }} />
            <TabItem
              tab={tab}
              isActive={tab.id === activeTabId}
              isSelected={selectedTabIds.includes(tab.id)}
              collapsed
              overlay
              onContextMenu={onContextMenu}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 2 }}>
      {/* Folder header */}
      <motion.div
        onClick={() => !editing && toggleFolder(folder.id)}
        onContextMenu={(e) => onFolderContextMenu(e, folder.id)}
        onMouseEnter={() => setHeaderHover(true)}
        onMouseLeave={() => setHeaderHover(false)}
        whileHover={{ backgroundColor: "rgba(255,255,255,0.04)" }}
        transition={{ duration: 0.1 }}
        style={{
          // 32px like every tab row — the header used to drop to 28px in the
          // flyout, so folders read as "shrinking" when the sidebar expanded
          height: 32, borderRadius: 6, display: "flex", alignItems: "center",
          gap: 6, padding: "0 6px", cursor: "default",
        }}
      >
        <motion.div
          animate={{ rotate: folder.isOpen ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          style={{ display: "flex", color: "#666", flexShrink: 0 }}
        >
          <ChevronRight size={12} />
        </motion.div>

        <span
          style={{
            width: 18, height: 18, borderRadius: 4, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: `${folder.color}22`,
          }}
        >
          <FolderIcon name={folder.icon} size={11} color={folder.color} />
        </span>

        {editing ? (
          <input
            autoFocus
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") { setNameValue(folder.name); setEditing(false); }
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1, fontSize: 11, color: "#e4e4e4", minWidth: 0,
              background: "rgba(255,255,255,0.06)", borderRadius: 3, padding: "1px 4px",
              border: `1px solid ${folder.color}66`,
            }}
          />
        ) : (
          <span
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
            style={{
              flex: 1, fontSize: 11,
              color: hasActive ? folder.color : "#9a9a9a",
              textTransform: "uppercase", letterSpacing: "0.06em",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              transition: "color 0.15s",
            }}
          >
            {folder.name}
          </span>
        )}

        {/* Hover swaps the tab count for a + — new tab straight into this
            folder (opens the folder too, so the new tab is visible) */}
        {headerHover && !editing ? (
          <button
            title="New tab in folder"
            onClick={(e) => {
              e.stopPropagation();
              if (!folder.isOpen) toggleFolder(folder.id);
              createTab(undefined, folder.id);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: 18, height: 18, borderRadius: 4, flexShrink: 0, padding: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: `${folder.color}22`, border: "none", cursor: "pointer",
              color: folder.color,
            }}
          >
            <Plus size={12} />
          </button>
        ) : (
          <span style={{ fontSize: 10, color: "#4a4a4a", flexShrink: 0 }}>{folderTabs.length}</span>
        )}
      </motion.div>

      {/* Style editor — color + icon grids (context menu → Edit Style) */}
      <AnimatePresence>
        {styleOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.13 }}
            style={{ overflow: "hidden" }}
          >
            <FolderStyleEditor folder={folder} onClose={() => setEditingFolder(null)} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tabs inside folder — sortable so they can be dragged out or between
          folders. Ctrl+click multi-select works the same as loose tabs. */}
      <AnimatePresence initial={false}>
        {folder.isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
            style={{ overflow: "hidden", paddingLeft: 10 }}
          >
            <SortableContext items={folderTabIds} strategy={verticalListSortingStrategy}>
              {folderTabs.map((tab) => (
                <TabItem
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeTabId}
                  isSelected={selectedTabIds.includes(tab.id)}
                  onContextMenu={onContextMenu}
                  folderColor={folder.color}
                />
              ))}
            </SortableContext>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FolderStyleEditor({ folder, onClose }: { folder: FolderType; onClose: () => void }) {
  const { setFolderStyle } = useBrowserStore();

  return (
    <div
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); e.stopPropagation(); }}
      style={{
        margin: "2px 4px 6px", padding: 8, borderRadius: 6,
        background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      {/* Color grid */}
      <div style={{ fontSize: 8.5, color: "#4a4a4a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 5 }}>
        Color
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 5, marginBottom: 9 }}>
        {FOLDER_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setFolderStyle(folder.id, { color: c })}
            title={c}
            style={{
              width: "100%", aspectRatio: "1", borderRadius: 5, cursor: "pointer",
              background: c, border: "none", display: "flex",
              alignItems: "center", justifyContent: "center",
              outline: folder.color === c ? "2px solid #e4e4e4" : "none",
              outlineOffset: 1,
            }}
          >
            {folder.color === c && <Check size={10} color="#0c0c0c" strokeWidth={3} />}
          </button>
        ))}
      </div>

      {/* Icon grid */}
      <div style={{ fontSize: 8.5, color: "#4a4a4a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 5 }}>
        Icon
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4, marginBottom: 8 }}>
        {FOLDER_ICONS.map((ic) => {
          const selected = folder.icon === ic;
          return (
            <button
              key={ic}
              onClick={() => setFolderStyle(folder.id, { icon: ic })}
              title={ic}
              style={{
                width: "100%", aspectRatio: "1", borderRadius: 5, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                background: selected ? `${folder.color}2e` : "rgba(255,255,255,0.04)",
                border: `1px solid ${selected ? folder.color : "rgba(255,255,255,0.06)"}`,
              }}
            >
              <FolderIcon name={ic} size={12} color={selected ? folder.color : "#777"} />
            </button>
          );
        })}
      </div>

      <button
        onClick={onClose}
        style={{
          width: "100%", padding: "4px 0", fontSize: 10, borderRadius: 4, cursor: "pointer",
          border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.05)",
          color: "#999",
        }}
      >
        Done
      </button>
    </div>
  );
}
