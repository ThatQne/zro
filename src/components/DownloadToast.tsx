import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Download, FolderOpen, X, AlertCircle, Pause, Play } from "lucide-react";
import { useDownloadsStore, type DownloadItem } from "../store/downloads";
import { reportOverlay, trackOverlay } from "../store/overlays";

/**
 * Transient "your download started / finished" card anchored under the
 * downloads button — the thing every other browser shows and zro didn't.
 * Without it the only feedback was a 7px dot on a toolbar icon, so a download
 * that had plainly worked looked like nothing happened and got re-triggered
 * over and over.
 *
 * Lives as long as it's useful and no longer: it stays up while the transfer
 * is running, then holds briefly after it lands so the result is readable.
 */

const HOLD_AFTER_DONE_MS = 6000;

function fmtBytes(n: number): string {
  if (!n || n < 0) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export default function DownloadToast({ onOpenPanel }: { onOpenPanel: () => void }) {
  const items = useDownloadsStore((s) => s.items);
  const control = useDownloadsStore((s) => s.control);
  // Newest row, whatever its state — that's the one the user just acted on.
  const latest: DownloadItem | undefined = items[0];

  const [dismissedId, setDismissedId] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // A new download resets both gates — a fresh action always gets shown, even
  // if the user dismissed the previous card a second ago.
  const id = latest?.id;
  useEffect(() => {
    setExpired(false);
  }, [id]);

  // Hold-then-hide, but only once the transfer is actually over. Re-armed on
  // every state change so a long download doesn't time out mid-flight.
  const state = latest?.state;
  useEffect(() => {
    if (!latest || state === "active") return;
    const t = setTimeout(() => setExpired(true), HOLD_AFTER_DONE_MS);
    return () => clearTimeout(t);
  }, [id, state, latest]);

  const visible = !!latest && !expired && dismissedId !== latest.id;

  // Chrome renders ABOVE the page webview only where a region hole is punched
  // (see store/overlays) — without this the card is invisible over any page.
  //
  // The rect has to be re-measured for a few frames after it appears.
  // trackOverlay measures once and then relies on ResizeObserver, but this card
  // animates in with a transform (scale + translate) and transforms don't fire
  // ResizeObserver — so the hole got punched at the card's *mid-animation*
  // size and position, and the settled card overhung it on the bottom and
  // right. That overhang is the page webview showing through: the card looked
  // clipped by an invisible container.
  useEffect(() => {
    if (!visible) return;
    const stop = trackOverlay("download-toast", ref.current, 10);
    let raf = 0;
    const started = performance.now();
    const settle = () => {
      const el = ref.current;
      if (el) {
        const b = el.getBoundingClientRect();
        reportOverlay("download-toast", {
          x: b.left, y: b.top, w: b.width, h: b.height, r: 10,
        });
      }
      if (performance.now() - started < 400) raf = requestAnimationFrame(settle);
    };
    raf = requestAnimationFrame(settle);
    return () => {
      cancelAnimationFrame(raf);
      stop();
    };
  }, [visible]);

  if (!latest) return null;

  const done = latest.state === "done";
  const failed = latest.state === "failed";
  const pct =
    latest.total && latest.total > 0
      ? Math.min(100, Math.round(((latest.received ?? 0) / latest.total) * 100))
      : null;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: -8, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.98 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: 268,
            zIndex: 60,
            background: "#131313",
            border: "1px solid rgba(255,255,255,0.09)",
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
            padding: "9px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 7,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                display: "flex",
                flexShrink: 0,
                color: failed ? "#e06a6a" : done ? "#4fb56a" : "#4f80f5",
              }}
            >
              {failed ? <AlertCircle size={13} /> : done ? <Check size={13} /> : <Download size={13} />}
            </span>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                title={latest.filename}
                style={{
                  fontSize: 11.5,
                  color: "#e4e4e4",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {latest.filename}
              </div>
              <div style={{ fontSize: 10, color: "#6a6a6a", marginTop: 1 }}>
                {failed
                  ? latest.reason || "failed"
                  : done
                  ? `Downloaded${latest.total ? ` · ${fmtBytes(latest.total)}` : ""}`
                  : latest.paused
                  ? `Paused · ${fmtBytes(latest.received ?? 0)}${latest.total ? " of " + fmtBytes(latest.total) : ""}`
                  : pct != null
                  ? `${pct}% · ${fmtBytes(latest.received ?? 0)} of ${fmtBytes(latest.total ?? 0)}`
                  : `${fmtBytes(latest.received ?? 0)} downloaded`}
              </div>
            </div>

            <button
              onClick={() => setDismissedId(latest.id)}
              title="Dismiss"
              style={{
                flexShrink: 0,
                display: "flex",
                color: "#4a4a4a",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 2,
              }}
            >
              <X size={11} />
            </button>
          </div>

          {/* Progress: real bar when the length is known, indeterminate sweep
              when the server sent no content-length. */}
          {latest.state === "active" && (
            <div
              style={{
                height: 3,
                borderRadius: 2,
                background: "rgba(255,255,255,0.07)",
                overflow: "hidden",
              }}
            >
              {pct != null ? (
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: "#4f80f5",
                    transition: "width 0.2s linear",
                  }}
                />
              ) : (
                <div
                  style={{
                    width: "35%",
                    height: "100%",
                    background: "#4f80f5",
                    animation: "zro-dl-sweep 1.1s ease-in-out infinite",
                  }}
                />
              )}
            </div>
          )}

          {latest.state === "active" && (
            <div style={{ display: "flex", gap: 6 }}>
              <ToastBtn
                icon={latest.paused ? <Play size={11} /> : <Pause size={11} />}
                label={latest.paused ? "Resume" : "Pause"}
                onClick={() => control(latest.id, latest.paused ? "resume" : "pause")}
              />
              <ToastBtn label="Cancel" onClick={() => control(latest.id, "cancel")} />
            </div>
          )}

          {done && (
            <div style={{ display: "flex", gap: 6 }}>
              <ToastBtn
                label="Open"
                // path, not id — that's the command's argument (see downloads.rs)
                onClick={() => {
                  invoke("open_download", { path: latest.path }).catch(() => {});
                  setDismissedId(latest.id);
                }}
              />
              <ToastBtn
                icon={<FolderOpen size={11} />}
                label="Show"
                onClick={() => {
                  invoke("reveal_download", { path: latest.path }).catch(() => {});
                  setDismissedId(latest.id);
                }}
              />
              <ToastBtn
                label="All"
                onClick={() => {
                  setDismissedId(latest.id);
                  onOpenPanel();
                }}
              />
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ToastBtn({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ backgroundColor: "rgba(79,128,245,0.16)", color: "#9ab4f5" }}
      transition={{ duration: 0.1 }}
      style={{
        flex: 1,
        height: 24,
        borderRadius: 6,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.07)",
        color: "#9a9a9a",
        fontSize: 10.5,
      }}
    >
      {icon}
      {label}
    </motion.button>
  );
}
