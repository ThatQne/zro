import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, Download, FolderOpen, FileCheck2, FileX2, Trash2, ExternalLink, Puzzle, Check } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useDownloadsStore, DownloadItem } from "../store/downloads";
import { useBrowserStore } from "../store/tabs";
import { useExtStore } from "../store/extensions";

interface Props {
  onClose: () => void;
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Extension id when the URL is a Chrome Web Store detail page. */
function webstoreExtId(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(
    /(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\/detail\/(?:[^/]+\/)?([a-p]{32})/
  );
  return m ? m[1] : null;
}

export default function DownloadsPanel({ onClose }: Props) {
  const { items, markSeen, clearFinished } = useDownloadsStore();
  const { tabs, activeTabId } = useBrowserStore();
  const { autoInstall, autoErrors, items: exts } = useExtStore();
  const extId = webstoreExtId(tabs.find((t) => t.id === activeTabId)?.url);
  const alreadyInstalled = !!extId && exts.some((e) => e.id === extId);
  const extError = extId ? autoErrors[extId] : undefined;

  useEffect(() => { markSeen(); }, [items.length, markSeen]);
  // No button — a Web Store detail page installs itself automatically.
  useEffect(() => { if (extId) autoInstall(extId); }, [extId, autoInstall]);

  const hasFinished = items.some((i) => i.state !== "active");

  return (
    <motion.div
      // Opacity-only — see AiPanel: an x-slide desyncs the region-hole
      // overlay measurement from the panel's actual on-screen position.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      style={{
        width: 290,
        flexShrink: 0,
        background: "#0f0f0f",
        borderLeft: "1px solid rgba(255,255,255,0.1)",
        boxShadow: "inset 16px 0 28px -20px rgba(0,0,0,0.8)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 12px 9px",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Download size={13} color="#4f80f5" />
          <span style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Downloads
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {hasFinished && (
            <button
              onClick={clearFinished}
              title="Clear finished"
              style={{ background: "none", border: "none", cursor: "pointer", color: "#444", display: "flex" }}
            >
              <Trash2 size={12} />
            </button>
          )}
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#444", display: "flex" }}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* On a Web Store extension page → installs itself automatically (see
          effect above). Status only, no button. */}
      {extId && alreadyInstalled && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          margin: "8px 10px 0", padding: "7px 0",
          background: "rgba(79,181,106,0.1)", border: "1px solid rgba(79,181,106,0.3)",
          borderRadius: 6, color: "#5aa06a", fontSize: 10.5, flexShrink: 0,
        }}>
          <Check size={12} /> Extension installed
        </div>
      )}
      {extId && !alreadyInstalled && !extError && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          margin: "8px 10px 0", padding: "7px 0",
          background: "rgba(79,128,245,0.1)", border: "1px solid rgba(79,128,245,0.3)",
          borderRadius: 6, color: "#7a9cf5", fontSize: 10.5, flexShrink: 0,
        }}>
          <Puzzle size={12} /> Installing extension…
        </div>
      )}
      {extId && extError && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          margin: "8px 10px 0", padding: "6px 2px",
          color: "#c96a6a", fontSize: 10, flexShrink: 0,
        }}>
          <FileX2 size={11} /> {extError}
        </div>
      )}

      {/* Items */}
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px 10px" }}>
        {items.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 36, gap: 8 }}>
            <Download size={22} color="#222" />
            <div style={{ fontSize: 11, color: "#2a2a2a", textAlign: "center", lineHeight: 1.5 }}>
              No downloads yet
            </div>
          </div>
        )}
        {items.map((item) => <DownloadRow key={item.id} item={item} />)}
      </div>

      <style>{`
        @keyframes zro-dl-pulse { 0%,100%{opacity:0.4} 50%{opacity:1} }
      `}</style>
    </motion.div>
  );
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const deleteFile = useDownloadsStore((s) => s.deleteFile);
  const [confirming, setConfirming] = useState(false);
  const icon =
    item.state === "active" ? (
      <Download size={13} color="#4f80f5" style={{ animation: "zro-dl-pulse 1.2s ease-in-out infinite" }} />
    ) : item.state === "done" ? (
      <FileCheck2 size={13} color="#4fb56a" />
    ) : (
      <FileX2 size={13} color="#d66" />
    );

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "7px 8px", borderRadius: 7, marginBottom: 3,
      background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)",
    }}>
      <span style={{ flexShrink: 0, display: "flex" }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 11, color: item.state === "failed" ? "#a55" : "#999",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {item.filename}
        </div>
        <div style={{ fontSize: 9, color: item.state === "failed" ? "#a55" : "#3a3a3a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {item.state === "active"
            ? "downloading…"
            : item.state === "failed"
            ? item.reason || "failed"
            : timeLabel(item.started_at)}
        </div>
      </div>
      {item.state === "done" && (
        <>
          <button
            onClick={() => invoke("open_download", { path: item.path }).catch(() => {})}
            title="Open file"
            style={{ background: "none", border: "none", cursor: "pointer", color: "#4a5a7a", display: "flex", padding: 2, flexShrink: 0 }}
          >
            <ExternalLink size={12} />
          </button>
          <button
            onClick={() => invoke("reveal_download", { path: item.path }).catch(() => {})}
            title="Show in folder"
            style={{ background: "none", border: "none", cursor: "pointer", color: "#4a5a7a", display: "flex", padding: 2, flexShrink: 0 }}
          >
            <FolderOpen size={12} />
          </button>
          <button
            onClick={() => {
              // Two-step: first click arms (turns red), second click deletes
              // the FILE from disk — no room for an accidental single click
              if (!confirming) { setConfirming(true); setTimeout(() => setConfirming(false), 2500); return; }
              deleteFile(item.id).catch(() => setConfirming(false));
            }}
            title={confirming ? "Click again — deletes the file from disk" : "Delete file from disk"}
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: confirming ? "#d66" : "#4a5a7a", display: "flex", padding: 2, flexShrink: 0,
            }}
          >
            <Trash2 size={12} />
          </button>
        </>
      )}
    </div>
  );
}
