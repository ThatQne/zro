import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, Globe, Volume2, VolumeX } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Tab, useBrowserStore } from "../store/tabs";

interface Props {
  tab: Tab;
  isActive: boolean;
  isSelected: boolean;
  onContextMenu: (e: React.MouseEvent, tabId: string) => void;
  collapsed?: boolean;
  /** When true, renders without dnd hooks — rail tiles + DragOverlay ghosts
      live outside the DndContext. */
  overlay?: boolean;
  /** Tab lives inside a folder — tint the left accent bar with the folder's
      color so folder membership reads at a glance in the expanded list. */
  folderColor?: string;
}

interface DndBits {
  attributes: Partial<ReturnType<typeof useSortable>["attributes"]>;
  listeners: ReturnType<typeof useSortable>["listeners"];
  setNodeRef: ((el: HTMLElement | null) => void) | undefined;
  style: React.CSSProperties;
  isDragging: boolean;
}

const STATIC_DND: DndBits = {
  attributes: {},
  listeners: undefined,
  setNodeRef: undefined,
  style: {},
  isDragging: false,
};

export default function TabItem(props: Props) {
  // dnd-kit hooks require a DndContext ancestor, so the sortable variant is a
  // separate component — hooks can't be called conditionally.
  if (props.overlay) return <TabItemView {...props} dnd={STATIC_DND} />;
  return <SortableTabItem {...props} />;
}

function SortableTabItem(props: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.tab.id });
  return (
    <TabItemView
      {...props}
      dnd={{
        attributes,
        listeners,
        setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
        isDragging,
      }}
    />
  );
}

function TabItemView({ tab, isActive, isSelected, onContextMenu, collapsed, folderColor, dnd }: Props & { dnd: DndBits }) {
  const { switchTab, closeTab, toggleSelectTab, toggleMute } = useBrowserStore();
  const [hovered, setHovered] = useState(false);
  const showAudio = !!tab.audible || !!tab.muted;
  // Sleeping tabs only wake on click — pre-warming on hover meant a mouse
  // gliding down the list spun up a renderer per row it crossed, and those
  // renderers never re-slept (no lastActiveAt until an actual switch), which
  // is what was piling up RAM/CPU over a long session.
  const sleeping = !!tab.hibernated && !isActive;
  const awake = !!tab.keepAwake; // user-pinned: never auto-sleeps

  function getDisplayTitle(): string {
    if (tab.title && tab.title !== "New Tab") return tab.title;
    try {
      return new URL(tab.url).hostname || "New Tab";
    } catch {
      return "New Tab";
    }
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(tab.id);
    }
  }

  function handleClick(e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.stopPropagation();
      toggleSelectTab(tab.id);
    } else {
      switchTab(tab.id);
    }
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    onContextMenu(e, tab.id);
  }

  // Incognito tabs are marked purple everywhere
  const incog = !!tab.incognito;
  const bg = isSelected
    ? "rgba(79,128,245,0.14)"
    : isActive
    ? (incog ? "rgba(150,80,220,0.14)" : "rgba(255,255,255,0.07)")
    : "rgba(0,0,0,0)";

  const accentBar = isSelected
    ? "rgba(79,128,245,0.7)"
    : isActive
    ? (incog ? "rgba(150,80,220,0.8)" : "rgba(255,255,255,0.18)")
    : incog
    ? "rgba(150,80,220,0.35)"
    : hovered
    ? "rgba(255,255,255,0.22)" // hover keeps the accent on the tab's left edge
    : folderColor
    ? `${folderColor}70` // resting state inside a folder — tinted with its color
    : "transparent";

  // Collapsed = square favicon-only tile
  if (collapsed) {
    return (
      <motion.div
        ref={dnd.setNodeRef}
        {...dnd.attributes}
        {...dnd.listeners}
        animate={{ backgroundColor: bg }}
        whileHover={{ backgroundColor: "rgba(255,255,255,0.07)" }}
        transition={{ duration: 0.12 }}
        title={sleeping ? `${getDisplayTitle()} (sleeping)` : getDisplayTitle()}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          ...dnd.style,
          // Plain style, NOT framer `animate`: after a drop, framer could sit
          // on the stale 0 until the next hover retriggered it — the row
          // "flashed blank until rehovered". A direct style re-renders right.
          opacity: dnd.isDragging ? 0 : 1,
          width: 32, height: 32, borderRadius: 6,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "default", userSelect: "none", position: "relative",
          flexShrink: 0, margin: "0 auto",
          // Rail = glance surface: the active tab must read instantly
          border: `1px solid ${isSelected ? "rgba(79,128,245,0.5)" : isActive ? (incog ? "rgba(150,80,220,0.5)" : "rgba(255,255,255,0.18)") : "transparent"}`,
        }}
      >
        {(isActive || isSelected || incog || hovered) && (
          <div style={{ position: "absolute", left: 2, top: 8, bottom: 8, width: 2, borderRadius: 2, background: isSelected ? "rgba(79,128,245,0.7)" : incog ? "rgba(150,80,220,0.8)" : isActive ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.25)" }} />
        )}
        <span style={{ opacity: sleeping ? 0.82 : 1, display: "flex" }}>
          <Favicon tab={tab} isActive={isActive} size={14} />
        </span>
        {/* Audio indicator — click the corner dot to mute/unmute */}
        {showAudio && (
          <button
            onClick={(e) => { e.stopPropagation(); toggleMute(tab.id); }}
            onMouseDown={(e) => e.stopPropagation()}
            title={tab.muted ? "Unmute tab" : "Mute tab"}
            style={{
              position: "absolute", right: 1, bottom: 1, width: 13, height: 13, borderRadius: "50%",
              display: "flex", alignItems: "center", justifyContent: "center", padding: 0, cursor: "pointer",
              background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.12)",
              color: tab.muted ? "#a55" : "#4f80f5",
            }}
          >
            {tab.muted ? <VolumeX size={8} /> : <Volume2 size={8} />}
          </button>
        )}
        {/* Sleep indicator — small dot, not a badge, so it doesn't compete
            with the favicon at this size */}
        {sleeping && !showAudio && (
          <div style={{
            position: "absolute", right: 0, bottom: 0, width: 5, height: 5, borderRadius: "50%",
            pointerEvents: "none", background: "#5a5a5a",
          }} />
        )}
      </motion.div>
    );
  }

  return (
    <motion.div
      ref={dnd.setNodeRef}
      {...dnd.attributes}
      {...dnd.listeners}
      animate={{ backgroundColor: bg }}
      whileHover={{ backgroundColor: isActive || isSelected ? bg : "rgba(255,255,255,0.05)" }}
      transition={{ duration: 0.12, ease: "easeOut" }}
      style={{
        ...dnd.style,
        // Direct style, not framer animate — see the collapsed variant
        opacity: dnd.isDragging ? 0 : 1,
        // 32px row + favicon column centered at the same x as the rail's
        // 32px tiles — hover-expanding the sidebar must not shift/shrink tabs
        height: 32,
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 4px 0 2px",
        cursor: "default",
        userSelect: "none",
        position: "relative",
        flexShrink: 0,
      }}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Active / selected / hover accent bar */}
      <motion.div
        animate={{ backgroundColor: accentBar }}
        transition={{ duration: 0.15 }}
        style={{
          position: "absolute",
          left: 0,
          top: 5,
          bottom: 5,
          width: 2,
          borderRadius: 2,
        }}
      />

      {/* Favicon — 32px column matches the collapsed rail tile exactly */}
      <div style={{
        width: 32, height: 32, flexShrink: 0, display: "flex", alignItems: "center",
        justifyContent: "center", opacity: sleeping ? 0.82 : 1, position: "relative",
      }}>
        <Favicon tab={tab} isActive={isActive} size={14} />
        {/* Sleep indicator — small dot, not a badge */}
        {sleeping && !showAudio && (
          <div style={{
            position: "absolute", right: 2, bottom: 2, width: 5, height: 5, borderRadius: "50%",
            pointerEvents: "none", background: "#5a5a5a",
          }} />
        )}
        {/* Keep-awake indicator — amber dot (exempt from auto-sleep) */}
        {awake && !sleeping && (
          <div style={{
            position: "absolute", right: 2, top: 2, width: 5, height: 5, borderRadius: "50%",
            pointerEvents: "none", background: "#e8a030",
          }} title="Kept awake" />
        )}
      </div>

      {/* Title */}
      <span
        style={{
          flex: 1, fontSize: 12,
          color: isActive || isSelected ? "#e4e4e4" : sleeping ? "#8f8f8f" : "#bcbcbc",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          transition: "color 0.1s", pointerEvents: "none",
        }}
      >
        {getDisplayTitle()}
      </span>

      {/* Audio / mute toggle */}
      {showAudio && (
        <button
          onClick={(e) => { e.stopPropagation(); toggleMute(tab.id); }}
          onMouseDown={(e) => e.stopPropagation()}
          title={tab.muted ? "Unmute tab" : "Mute tab"}
          style={{
            width: 16, height: 16, borderRadius: 4, background: "transparent", border: "none",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0, padding: 0, color: tab.muted ? "#a55" : isActive || isSelected ? "#7a9cf5" : "#666",
          }}
        >
          {tab.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
        </button>
      )}

      {/* Close button — revealed on row hover for every tab */}
      {!tab.isLoading && (
        <motion.button
          initial={{ opacity: 0, scale: 0.7 }}
          whileHover={{ opacity: 1, scale: 1, backgroundColor: "rgba(255,255,255,0.1)" }}
          animate={{ opacity: hovered ? 0.9 : isActive || isSelected ? 0.5 : 0, scale: 1 }}
          whileFocus={{ opacity: 1 }}
          transition={{ duration: 0.1 }}
          onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            width: 16,
            height: 16,
            borderRadius: 4,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: "#888",
            padding: 0,
          }}
        >
          <X size={10} />
        </motion.button>
      )}
    </motion.div>
  );
}

function Favicon({ tab, isActive, size }: { tab: Tab; isActive: boolean; size: number }) {
  // Keyed by url — a failed favicon must re-attempt (and be allowed to fail
  // again) after navigation, not stay stuck on the old broken state forever.
  const [broken, setBroken] = useState(false);
  const url = tab.favicon;
  useEffect(() => setBroken(false), [url]);

  if (url && !broken) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        style={{ borderRadius: 2 }}
        onError={() => setBroken(true)}
      />
    );
  }
  if (tab.isLoading) {
    return (
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
        style={{ width: 10, height: 10, border: "1.5px solid #333", borderTopColor: "#4f80f5", borderRadius: "50%" }}
      />
    );
  }
  return <Globe size={size - 3} color={isActive ? "#888" : "#3a3a3a"} />;
}

/** Lightweight version for drag stack — no dnd hooks, simplified display.
 *  `padRight` reserves room for the stack's count badge so long titles
 *  never run underneath it. */
export function TabItemGhost({ tab, depth = 0, padRight = false }: { tab: Tab; depth?: number; padRight?: boolean }) {
  function getDisplayTitle() {
    if (tab.title && tab.title !== "New Tab") return tab.title;
    try { return new URL(tab.url).hostname || "New Tab"; } catch { return "New Tab"; }
  }

  return (
    <div
      style={{
        height: 32,
        borderRadius: 6,
        background: depth === 0 ? "#282828" : "#1e1e1e",
        border: `1px solid rgba(255,255,255,${0.12 - depth * 0.03})`,
        display: "flex",
        alignItems: "center",
        padding: `0 ${padRight ? 30 : 8}px 0 8px`,
        gap: 6,
        opacity: 1 - depth * 0.22,
        pointerEvents: "none",
      }}
    >
      {tab.favicon ? (
        <img src={tab.favicon} alt="" width={12} height={12} style={{ borderRadius: 2 }} />
      ) : (
        <Globe size={11} color="#555" />
      )}
      <span style={{ fontSize: 12, color: "#c0c0c0", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {getDisplayTitle()}
      </span>
    </div>
  );
}
