import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, Shield } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useBrowserStore } from "../store/tabs";

interface Props {
  onClose: () => void;
}

/** Shields — the protection suite in its own panel (opened by the toolbar
 *  crest). Master toggle, four pillars uBlock can't do from inside the page,
 *  and live counters for what they've stopped. */
export default function ShieldPanel({ onClose }: Props) {
  const { settings, setSettings } = useBrowserStore();
  const [stats, setStats] = useState<{ blocked: number; scrubbed: number; ready: boolean }>({
    blocked: 0, scrubbed: 0, ready: false,
  });

  useEffect(() => {
    let alive = true;
    const pull = () =>
      invoke<{ blocked: number; scrubbed: number; ready: boolean }>("get_shield_stats")
        .then((s) => alive && setStats(s))
        .catch(() => {});
    pull();
    const id = setInterval(pull, 2000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const on = settings.shieldsEnabled;

  return (
    <motion.div
      // Opacity-only — an x-slide desyncs the region-hole overlay measurement
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      style={{
        width: 300, flexShrink: 0, background: "#0f0f0f",
        borderLeft: "1px solid rgba(255,255,255,0.1)",
        boxShadow: "inset 16px 0 28px -20px rgba(0,0,0,0.8)",
        display: "flex", flexDirection: "column", height: "100%",
      }}
    >
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 12px 9px", borderBottom: "1px solid rgba(255,255,255,0.05)", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Shield size={13} color="#4f80f5" />
          <span style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Shields
          </span>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#444", display: "flex" }}>
          <X size={13} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
        {/* Status tiles */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          <StatTile label="Trackers blocked" value={on && stats.ready ? stats.blocked : 0} dim={!on} />
          <StatTile label="Links cleaned" value={on && stats.ready ? stats.scrubbed : 0} dim={!on} />
        </div>

        {/* Master switch */}
        <div
          onClick={() => setSettings({ shieldsEnabled: !on })}
          style={{
            display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
            padding: "10px 12px", borderRadius: 9, marginBottom: 12,
            background: on ? "rgba(79,128,245,0.09)" : "rgba(255,255,255,0.02)",
            border: `1px solid ${on ? "rgba(79,128,245,0.35)" : "rgba(255,255,255,0.06)"}`,
          }}
        >
          <Shield size={15} color={on ? "#5b8def" : "#555"} fill={on ? "rgba(79,128,245,0.22)" : "none"} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, color: on ? "#c0c8e8" : "#777" }}>
              {on ? "Shields active" : "Shields off"}
            </div>
            <div style={{ fontSize: 9, color: "#4a4a4a", marginTop: 1 }}>
              {on ? (stats.ready ? "Filter lists loaded" : "Loading filter lists…") : "No protection"}
            </div>
          </div>
          <Toggle checked={on} />
        </div>

        {/* Pillars */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, opacity: on ? 1 : 0.35, pointerEvents: on ? "auto" : "none" }}>
          <PillarRow
            label="Block ads & trackers"
            sub="Brave's engine, at the network layer (beats MV3)"
            checked={settings.shieldsAds}
            onToggle={() => setSettings({ shieldsAds: !settings.shieldsAds })}
          />
          <PillarRow
            label="Anti-fingerprinting"
            sub="Randomizes canvas / WebGL / audio / device signals — new tabs"
            checked={settings.shieldsFingerprint}
            onToggle={() => setSettings({ shieldsFingerprint: !settings.shieldsFingerprint })}
          />
          <PillarRow
            label="Force HTTPS"
            sub="Upgrades http:// to https:// automatically"
            checked={settings.shieldsHttps}
            onToggle={() => setSettings({ shieldsHttps: !settings.shieldsHttps })}
          />
          <PillarRow
            label="Clean tracking links"
            sub="Strips utm_*, fbclid, gclid… off every URL"
            checked={settings.shieldsStrip}
            onToggle={() => setSettings({ shieldsStrip: !settings.shieldsStrip })}
          />
        </div>
      </div>
    </motion.div>
  );
}

function StatTile({ label, value, dim }: { label: string; value: number; dim: boolean }) {
  return (
    <div style={{
      padding: "10px 10px 9px", borderRadius: 9,
      background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)",
    }}>
      <div style={{ fontSize: 17, fontWeight: 600, color: dim ? "#3a3a3a" : "#c9d4f5", lineHeight: 1 }}>
        {value.toLocaleString()}
      </div>
      <div style={{ fontSize: 8.5, color: "#4a4a4a", marginTop: 4, letterSpacing: "0.04em" }}>{label}</div>
    </div>
  );
}

function PillarRow({ label, sub, checked, onToggle }: {
  label: string; sub: string; checked: boolean; onToggle: () => void;
}) {
  return (
    <div onClick={onToggle} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10.5, color: checked ? "#9a9a9a" : "#5a5a5a" }}>{label}</div>
        <div style={{ fontSize: 9, color: "#3a3a3a", marginTop: 1, lineHeight: 1.4 }}>{sub}</div>
      </div>
      <Toggle checked={checked} small />
    </div>
  );
}

function Toggle({ checked, small }: { checked: boolean; small?: boolean }) {
  const w = small ? 22 : 26;
  const h = small ? 13 : 15;
  const k = small ? 9 : 11;
  return (
    <div style={{
      width: w, height: h, borderRadius: h / 2, flexShrink: 0, marginTop: small ? 2 : 0,
      background: checked ? "rgba(79,128,245,0.5)" : "rgba(255,255,255,0.08)",
      position: "relative", transition: "background 0.15s",
    }}>
      <div style={{
        position: "absolute", top: 2, left: checked ? w - k - 2 : 2, width: k, height: k, borderRadius: "50%",
        background: checked ? "#dfe7ff" : "#555", transition: "left 0.15s, background 0.15s",
      }} />
    </div>
  );
}
