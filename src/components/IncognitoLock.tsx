import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { Fingerprint, EyeOff, Delete } from "lucide-react";
import { useBrowserStore, hashPasscode } from "../store/tabs";
import { trackOverlay } from "../store/overlays";

interface Props {
  onUnlock: () => void;
  onCancel: () => void;
}

const PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"] as const;

// StrictMode (dev only) mounts every component twice back-to-back — without
// this, the effect below fired verify_identity twice, stacking two native
// Hello prompts. A real reopen is always at least a user-interaction later,
// so a short time guard tells the two apart without a ref (which wouldn't
// survive the remount anyway).
let lastHelloAttempt = 0;

/** Full-screen gate shown EVERY time incognito is entered. Input is either
 *  the digit PIN (boxes + numpad, auto-submits when full) or Windows Hello. */
export default function IncognitoLock({ onUnlock, onCancel }: Props) {
  const { settings } = useBrowserStore();
  const hasPasscode = !!settings.incognitoPasscode && settings.incognitoPasscodeLen >= 4;
  const len = hasPasscode ? settings.incognitoPasscodeLen : 0;

  const [entry, setEntry] = useState("");
  const [shake, setShake] = useState(0); // increments to retrigger animation
  const [helloBusy, setHelloBusy] = useState(false);
  const [helloErr, setHelloErr] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Punch a hole so this renders over the page webview
  useEffect(() => trackOverlay("incognito-lock", ref.current, 0), []);

  // Windows Hello is the primary input — prompt it immediately instead of
  // making the user click the button. If Hello isn't set up the call errors
  // fast and the passcode pad / button is right there.
  useEffect(() => {
    const now = Date.now();
    if (now - lastHelloAttempt < 500) return;
    lastHelloAttempt = now;
    tryHello();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pushDigit(d: string) {
    if (!hasPasscode || entry.length >= len) return;
    const next = entry + d;
    setEntry(next);
    if (next.length === len) {
      // Let the last dot pop before judging
      setTimeout(() => {
        if (hashPasscode(next) === settings.incognitoPasscode) {
          onUnlock();
        } else {
          setShake((n) => n + 1);
          setTimeout(() => setEntry(""), 320);
        }
      }, 120);
    }
  }

  function popDigit() {
    setEntry((e) => e.slice(0, -1));
  }

  async function tryHello() {
    if (helloBusy) return;
    setHelloBusy(true);
    setHelloErr(false);
    try {
      const ok = await invoke<boolean>("verify_identity", { reason: "Unlock incognito browsing" });
      if (ok) { onUnlock(); return; }
      setHelloErr(true);
    } catch {
      setHelloErr(true);
    }
    setHelloBusy(false);
  }

  // Physical keyboard works too
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pushDigit(e.key); }
      else if (e.key === "Backspace") { e.preventDefault(); popDigit(); }
      else if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, hasPasscode, len]);

  return (
    <div
      ref={ref}
      style={{
        position: "absolute", inset: 0, zIndex: 200,
        background: "rgba(10,6,14,0.94)", backdropFilter: "blur(10px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 264, padding: "22px 20px 16px",
          background: "#141018", border: "1px solid rgba(150,80,220,0.3)",
          borderRadius: 16, boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 14,
        }}
      >
        <div style={{
          width: 44, height: 44, borderRadius: "50%",
          background: "rgba(150,80,220,0.14)", border: "1px solid rgba(150,80,220,0.3)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <EyeOff size={18} color="rgba(180,120,240,0.9)" />
        </div>

        <div style={{ fontSize: 13, color: "#d8cce8", fontWeight: 500, letterSpacing: "0.02em" }}>
          Incognito locked
        </div>

        {hasPasscode ? (
          <>
            {/* PIN dots — pop as they fill, shake row on a wrong code */}
            <motion.div
              key={shake}
              animate={shake > 0 ? { x: [0, -9, 8, -6, 5, -2, 0] } : { x: 0 }}
              transition={{ duration: 0.32 }}
              style={{ display: "flex", gap: 10, padding: "2px 0" }}
            >
              {Array.from({ length: len }).map((_, i) => {
                const filled = i < entry.length;
                return (
                  <motion.div
                    key={i}
                    animate={{
                      scale: filled ? [1, 1.35, 1] : 1,
                      backgroundColor: filled ? "rgba(180,120,240,0.95)" : "rgba(255,255,255,0.08)",
                      borderColor: filled ? "rgba(180,120,240,0.9)" : "rgba(150,80,220,0.35)",
                    }}
                    transition={{ duration: 0.16 }}
                    style={{ width: 13, height: 13, borderRadius: "50%", border: "1px solid" }}
                  />
                );
              })}
            </motion.div>

            {/* Numpad */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, width: "100%" }}>
              {PAD_KEYS.map((k, i) =>
                k === "" ? (
                  <div key={i} />
                ) : (
                  <motion.button
                    key={i}
                    onClick={() => (k === "back" ? popDigit() : pushDigit(k))}
                    whileHover={{ backgroundColor: "rgba(150,80,220,0.16)" }}
                    whileTap={{ scale: 0.88, backgroundColor: "rgba(150,80,220,0.3)" }}
                    transition={{ duration: 0.08 }}
                    style={{
                      height: 46, borderRadius: 12, cursor: "pointer",
                      background: "rgba(255,255,255,0.045)", border: "1px solid rgba(255,255,255,0.06)",
                      color: "#c8b8e0", fontSize: 17, fontWeight: 500,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    {k === "back" ? <Delete size={16} /> : k}
                  </motion.button>
                )
              )}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 10.5, color: "#6a5a7a", textAlign: "center", lineHeight: 1.5 }}>
            No passcode set — use Windows Hello,<br />or set a passcode in Settings → Privacy.
          </div>
        )}

        {/* Windows Hello — the other input */}
        <motion.button
          onClick={tryHello}
          whileHover={{ backgroundColor: "rgba(150,80,220,0.2)" }}
          whileTap={{ scale: 0.95 }}
          transition={{ duration: 0.1 }}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            width: "100%", padding: "9px 0", borderRadius: 12, cursor: "pointer",
            background: "rgba(150,80,220,0.12)", border: "1px solid rgba(150,80,220,0.3)",
            color: helloErr ? "#c96a6a" : "#c9a8f0", fontSize: 11.5,
          }}
        >
          <Fingerprint size={14} />
          {helloBusy ? "Waiting for Windows Hello…" : helloErr ? "Hello failed — try again" : "Use Windows Hello"}
        </motion.button>
      </motion.div>
    </div>
  );
}
