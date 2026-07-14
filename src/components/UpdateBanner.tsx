import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Download, X, RefreshCw, ArrowUpCircle } from "lucide-react";
import { trackOverlay } from "../store/overlays";

type Phase = "idle" | "available" | "downloading" | "ready" | "error";

// Auto-update surface. Silently checks GitHub Releases a few seconds after
// launch (once), then shows a themed toast if a newer signed build exists.
// Manual re-check is exposed via the `zro:check-update` window event so the
// Settings panel button can trigger it without prop drilling.
export default function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState("");
  const updRef = useRef<Update | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const total = useRef(0);
  const got = useRef(0);

  // UI-on-top compositing: the page webview draws in a region hole, so a
  // plain fixed toast over the page area would be occluded. Register the
  // banner's rect as an overlay so Rust punches a matching hole for it.
  useEffect(() => {
    if (phase === "idle") return;
    return trackOverlay("update-banner", boxRef.current, 10);
  }, [phase]);

  async function runCheck(manual = false) {
    try {
      setErr("");
      const upd = await check();
      if (upd) {
        updRef.current = upd;
        setVersion(upd.version);
        setNotes((upd.body || "").trim());
        setPhase("available");
        window.dispatchEvent(new CustomEvent("zro:update-available"));
      } else if (manual) {
        // brief "up to date" flash on manual checks only
        setPhase("idle");
        window.dispatchEvent(new CustomEvent("zro:update-uptodate"));
      }
    } catch (e) {
      if (manual) {
        setErr(String(e));
        setPhase("error");
      }
      // startup auto-check failures stay silent (offline, no release yet, etc.)
    }
  }

  async function download() {
    const upd = updRef.current;
    if (!upd) return;
    setPhase("downloading");
    setPct(0);
    got.current = 0;
    total.current = 0;
    try {
      await upd.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total.current = ev.data.contentLength || 0;
        } else if (ev.event === "Progress") {
          got.current += ev.data.chunkLength;
          if (total.current > 0) {
            setPct(Math.min(100, Math.round((got.current / total.current) * 100)));
          }
        } else if (ev.event === "Finished") {
          setPct(100);
        }
      });
      setPhase("ready");
    } catch (e) {
      setErr(String(e));
      setPhase("error");
    }
  }

  useEffect(() => {
    const t = setTimeout(() => runCheck(false), 4000);
    const onManual = () => runCheck(true);
    window.addEventListener("zro:check-update", onManual);
    return () => {
      clearTimeout(t);
      window.removeEventListener("zro:check-update", onManual);
    };
  }, []);

  if (phase === "idle") return null;

  return (
    <div
      ref={boxRef}
      style={{ zIndex: 2147483000 }}
      className="fixed bottom-4 right-4 w-[320px] rounded-lg border border-border bg-overlay/95 backdrop-blur shadow-2xl overflow-hidden animate-[fadeIn_.2s_ease]"
    >
      <div className="flex items-start gap-3 p-3">
        <ArrowUpCircle size={18} className="mt-0.5 shrink-0 text-accent" />
        <div className="flex-1 min-w-0">
          {phase === "available" && (
            <>
              <div className="text-primary text-sm font-medium">Update available</div>
              <div className="text-secondary text-xs mt-0.5">
                zro {version} is ready to install.
              </div>
              {notes && (
                <div className="text-secondary/80 text-2xs mt-1.5 max-h-16 overflow-y-auto whitespace-pre-wrap leading-snug">
                  {notes}
                </div>
              )}
              <div className="flex gap-2 mt-2.5">
                <button
                  onClick={download}
                  className="flex items-center gap-1.5 rounded-md bg-accent hover:bg-accent-dim text-white text-xs px-2.5 py-1 transition-colors"
                >
                  <Download size={13} /> Update now
                </button>
                <button
                  onClick={() => setPhase("idle")}
                  className="text-secondary hover:text-primary text-xs px-2 py-1"
                >
                  Later
                </button>
              </div>
            </>
          )}

          {phase === "downloading" && (
            <>
              <div className="text-primary text-sm font-medium">Downloading update…</div>
              <div className="mt-2 h-1.5 w-full rounded-full bg-hover overflow-hidden">
                <div
                  className="h-full bg-accent transition-[width] duration-150"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="text-secondary text-2xs mt-1">{pct}%</div>
            </>
          )}

          {phase === "ready" && (
            <>
              <div className="text-primary text-sm font-medium">Update installed</div>
              <div className="text-secondary text-xs mt-0.5">
                Restart zro to finish updating to {version}.
              </div>
              <button
                onClick={() => relaunch()}
                className="flex items-center gap-1.5 mt-2.5 rounded-md bg-accent hover:bg-accent-dim text-white text-xs px-2.5 py-1 transition-colors"
              >
                <RefreshCw size={13} /> Restart now
              </button>
            </>
          )}

          {phase === "error" && (
            <>
              <div className="text-primary text-sm font-medium">Update failed</div>
              <div className="text-secondary text-2xs mt-1 max-h-16 overflow-y-auto break-words">
                {err}
              </div>
              <button
                onClick={() => runCheck(true)}
                className="flex items-center gap-1.5 mt-2.5 rounded-md bg-hover hover:bg-active text-primary text-xs px-2.5 py-1 transition-colors"
              >
                <RefreshCw size={13} /> Retry
              </button>
            </>
          )}
        </div>
        {phase !== "downloading" && (
          <button
            onClick={() => setPhase("idle")}
            className="text-secondary hover:text-primary shrink-0"
            title="Dismiss"
          >
            <X size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
