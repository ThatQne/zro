import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Settings as SettingsIcon, Shield, Search, Bot, Trash2, KeyRound, Cookie,
  Puzzle, Pin, PinOff, FolderOpen, Power, ChevronDown, EyeOff, Eye, Fingerprint,
  Check, AlertCircle, Delete, Lock, Users, Moon, Plus, Copy, RefreshCw,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { useBrowserStore, Settings, hashPasscode, FOLDER_COLORS } from "../store/tabs";
import { useExtStore } from "../store/extensions";
import CookieEditor from "./CookieEditor";

interface Props {
  onClose: () => void;
}

export default function SettingsPanel({ onClose }: Props) {
  const { settings, setSettings } = useBrowserStore();

  async function togglePasswordAutosave() {
    const next = !settings.passwordAutosave;
    setSettings({ passwordAutosave: next });
    invoke("set_password_autosave", { enabled: next }).catch(console.error);
  }

  return (
    <motion.div
      // Opacity-only — see AiPanel: an x-slide desyncs the region-hole
      // overlay measurement from the panel's actual on-screen position.
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
          <SettingsIcon size={13} color="#4f80f5" />
          <span style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Settings
          </span>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#444", display: "flex" }}>
          <X size={13} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {/* Extensions — top section */}
        <ExtensionsSection />

        <div style={{ padding: "4px 14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <Card icon={<Search size={12} />} title="Search Engine">
            <div style={{ display: "flex", gap: 4 }}>
              {(["google", "duckduckgo", "bing"] as const).map((e) => (
                <Choice
                  key={e}
                  active={settings.searchEngine === e}
                  onClick={() => setSettings({ searchEngine: e })}
                  label={e === "google" ? "Google" : e === "duckduckgo" ? "DuckDuckGo" : "Bing"}
                />
              ))}
            </div>
          </Card>

          <Card icon={<Users size={12} />} title="Profiles" defaultOpen={false}>
            <ProfilesSection />
          </Card>

          <Card icon={<Moon size={12} />} title="Performance" defaultOpen={false}>
            <Label>Max awake background tabs</Label>
            <div style={{ display: "flex", gap: 4 }}>
              {([[2, "2"], [3, "3"], [5, "5"], [8, "8"], [0, "No cap"]] as const).map(([v, l]) => (
                <Choice
                  key={v}
                  active={settings.liveTabLimit === v}
                  onClick={() => setSettings({ liveTabLimit: v })}
                  label={l}
                />
              ))}
            </div>
            <Hint>The memory ceiling — extra tabs sleep instantly, so total RAM stays flat at hundreds of tabs.</Hint>
            <Label>Sleep inactive tabs after</Label>
            <div style={{ display: "flex", gap: 4 }}>
              {([[0, "Off"], [5, "5 min"], [10, "10 min"], [20, "20 min"]] as const).map(([v, l]) => (
                <Choice
                  key={v}
                  active={settings.hibernateAfterMin === v}
                  onClick={() => setSettings({ hibernateAfterMin: v })}
                  label={l}
                />
              ))}
            </div>
            <Hint>Background tabs freeze after a minute, then fully sleep after this. They wake on click; audio tabs never sleep.</Hint>
            <Label>Freeze everything when idle for</Label>
            <div style={{ display: "flex", gap: 4 }}>
              {([[0, "Off"], [1, "1 min"], [3, "3 min"], [5, "5 min"]] as const).map(([v, l]) => (
                <Choice
                  key={v}
                  active={settings.idleFreezeMin === v}
                  onClick={() => setSettings({ idleFreezeMin: v })}
                  label={l}
                />
              ))}
            </div>
            <Hint>Idle machine → every tab freezes (active too), so nothing burns CPU overnight. Any input thaws it instantly.</Hint>
          </Card>

          <Card icon={<Bot size={12} />} title="AI Assistant" defaultOpen={false}>
            <Label>Provider</Label>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              {([["ollama", "Ollama"], ["mzcode", "mz-code"], ["openai", "Custom API"]] as const).map(([key, label]) => (
                <Choice key={key} active={settings.aiProvider === key} onClick={() => setSettings({ aiProvider: key })} label={label} />
              ))}
            </div>
            {settings.aiProvider === "openai" && (
              <>
                <Label>Endpoint (OpenAI-compatible, include /v1)</Label>
                <TextInput value={settings.aiBaseUrl} placeholder="http://localhost:1234/v1" onChange={(v) => setSettings({ aiBaseUrl: v })} />
                <Label>API key (optional for local servers)</Label>
                <TextInput value={settings.aiApiKey} placeholder="sk-…" password onChange={(v) => setSettings({ aiApiKey: v })} />
              </>
            )}
            {settings.aiProvider === "mzcode" && (
              <Hint>Runs your local <code style={{ color: "#666" }}>mz</code> agent — its own tools (shell, web, files, MCP) with all open tabs as context.</Hint>
            )}
            {settings.aiProvider === "ollama" && (
              <Hint>Local models via Ollama. The model picker in the AI panel scans installed models automatically.</Hint>
            )}
          </Card>

          <Card icon={<Shield size={12} />} title="Privacy & Security">
            <ToggleRow
              icon={<KeyRound size={11} />}
              label="Save passwords & autofill"
              sub="Encrypted at rest by Windows (DPAPI), same store Edge uses"
              checked={settings.passwordAutosave}
              onToggle={togglePasswordAutosave}
            />
            <div style={{ height: 12 }} />
            <IncognitoLockRow />
            <div style={{ height: 12 }} />
            <ClearDataSection />
            <Hint>Browsing history is cleared from the History panel (Ctrl+H).</Hint>
          </Card>

          <Card icon={<KeyRound size={12} />} title="Passwords" defaultOpen={false}>
            <PasswordsSection />
          </Card>

          <Card icon={<Cookie size={12} />} title="Cookies (active page)" defaultOpen={false}>
            <CookieEditor />
          </Card>

          <Card icon={<RefreshCw size={12} />} title="Updates" defaultOpen={false}>
            <UpdatesSection />
          </Card>

          <div style={{ fontSize: 9, color: "#2a2a2a", textAlign: "center", lineHeight: 1.6, marginTop: 4 }}>
            zro 0.1 · Chromium via WebView2<br />
            Ctrl+T new · Ctrl+W close · Ctrl+Shift+T reopen · Ctrl+H history · Ctrl+Tab cycle
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ── Updates ───────────────────────────────────────────────────────────────────

/** Manual update trigger. The actual check/download/install UI lives in the
 *  global <UpdateBanner/>; this just fires the `zro:check-update` event it
 *  listens for, and reflects the "already up to date" reply. */
function UpdatesSection() {
  const [ver, setVer] = useState("");
  const [checking, setChecking] = useState(false);
  const [upToDate, setUpToDate] = useState(false);

  useEffect(() => {
    getVersion().then(setVer).catch(() => {});
    const onUtd = () => { setChecking(false); setUpToDate(true); };
    // any banner state change (update found) also ends the "checking" spinner
    const onFound = () => { setChecking(false); setUpToDate(false); };
    window.addEventListener("zro:update-uptodate", onUtd);
    window.addEventListener("zro:update-available", onFound);
    return () => {
      window.removeEventListener("zro:update-uptodate", onUtd);
      window.removeEventListener("zro:update-available", onFound);
    };
  }, []);

  function check() {
    setChecking(true);
    setUpToDate(false);
    window.dispatchEvent(new CustomEvent("zro:check-update"));
    // safety: drop the spinner even if nothing responds
    setTimeout(() => setChecking(false), 8000);
  }

  return (
    <div>
      <div style={{ fontSize: 11, color: "#6b6b6b", marginBottom: 8 }}>
        Current version <span style={{ color: "#e4e4e4" }}>zro {ver || "…"}</span>
      </div>
      <button
        onClick={check}
        disabled={checking}
        style={{
          display: "flex", alignItems: "center", gap: 6, width: "100%",
          justifyContent: "center", padding: "7px 10px", borderRadius: 6,
          background: checking ? "#161616" : "#1c1c1c", color: "#e4e4e4",
          border: "1px solid rgba(255,255,255,0.07)", cursor: checking ? "default" : "pointer",
          fontSize: 12,
        }}
      >
        <RefreshCw size={13} className={checking ? "animate-spin" : ""} />
        {checking ? "Checking…" : "Check for updates"}
      </button>
      {upToDate && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8, fontSize: 11, color: "#4f80f5" }}>
          <Check size={12} /> You're on the latest version.
        </div>
      )}
      <div style={{ fontSize: 9, color: "#3a3a3a", marginTop: 8, lineHeight: 1.5 }}>
        Updates are downloaded from GitHub Releases and verified with a signature before install.
      </div>
    </div>
  );
}

// ── Profiles ──────────────────────────────────────────────────────────────────

/** Named identities: each non-default profile is its own WebView2 user data
 *  folder — cookies, logins, storage and site data fully separated. Each
 *  profile is its own browser: switching swaps the whole tab space. */
function ProfilesSection() {
  const { settings, setSettings, tabs, switchProfile, deleteProfile } = useBrowserStore();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const profiles = settings.profiles;

  function addProfile() {
    const n = name.trim();
    if (!n) return;
    const id = n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!id) { setErr("name needs letters or digits"); return; }
    if (profiles.some((p) => p.id === id)) { setErr("a profile with that name exists"); return; }
    const color = FOLDER_COLORS[profiles.length % FOLDER_COLORS.length];
    setSettings({ profiles: [...profiles, { id, name: n, color }], activeProfileId: id });
    setName("");
    setErr(null);
  }

  /** Confirmed delete: close the profile's tabs, drop it, wipe its data. */
  async function removeProfile(id: string) {
    if (id === "default") return;
    setConfirmId(null);
    setErr(null);
    await deleteProfile(id);
    try {
      await invoke("delete_profile_data", { profile: id });
    } catch {
      // Environment still holds file locks this session — list entry goes now,
      // the folder is re-deletable after restart
      setErr("profile data is in use — it will clear after a restart");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {profiles.map((p) => {
        const active = p.id === settings.activeProfileId;
        const openTabs = tabs.filter((t) => (t.profileId ?? "default") === p.id).length;
        const confirming = confirmId === p.id;
        return (
          <div key={p.id}>
            <div
              onClick={() => switchProfile(p.id)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                borderRadius: 7, cursor: "pointer",
                background: active ? "rgba(79,128,245,0.08)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${active ? "rgba(79,128,245,0.35)" : "rgba(255,255,255,0.05)"}`,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 11, color: active ? "#c0c8e8" : "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.name}
              </span>
              <span style={{ fontSize: 9, color: "#3a3a3a", flexShrink: 0 }}>
                {openTabs > 0 ? `${openTabs} tab${openTabs !== 1 ? "s" : ""}` : ""}
              </span>
              {active && <Check size={11} color="#4f80f5" style={{ flexShrink: 0 }} />}
              {p.id !== "default" && (
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmId(confirming ? null : p.id); }}
                  title="Delete profile and its data"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#6a4444", display: "flex", padding: 2, flexShrink: 0 }}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
            {confirming && (
              <div style={{
                display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", marginTop: 3,
                borderRadius: 7, background: "rgba(220,60,60,0.06)", border: "1px solid rgba(220,60,60,0.2)",
              }}>
                <span style={{ flex: 1, fontSize: 9.5, color: "#b07070", lineHeight: 1.4 }}>
                  {openTabs > 0
                    ? `Closes ${openTabs} open tab${openTabs !== 1 ? "s" : ""} and deletes all logins, cookies & site data.`
                    : "Deletes all logins, cookies & site data."}
                </span>
                <button
                  onClick={() => removeProfile(p.id)}
                  style={{ padding: "4px 9px", borderRadius: 5, cursor: "pointer", border: "none", background: "rgba(220,60,60,0.25)", color: "#e88", fontSize: 10, flexShrink: 0 }}
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmId(null)}
                  style={{ padding: "4px 8px", borderRadius: 5, cursor: "pointer", border: "none", background: "rgba(255,255,255,0.05)", color: "#777", fontSize: 10, flexShrink: 0 }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
        <input
          value={name}
          onChange={(e) => { setName(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") addProfile(); }}
          placeholder="New profile name…"
          spellCheck={false}
          style={{
            flex: 1, fontSize: 10.5, color: "#aaa",
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 5, padding: "5px 8px",
          }}
        />
        <button
          onClick={addProfile}
          disabled={!name.trim()}
          style={{
            display: "flex", alignItems: "center", gap: 3, padding: "0 9px", borderRadius: 5,
            cursor: name.trim() ? "pointer" : "default",
            background: "rgba(79,128,245,0.12)", border: "1px solid rgba(79,128,245,0.3)",
            color: name.trim() ? "#7a9cf5" : "#3a4a6a", fontSize: 10,
          }}
        >
          <Plus size={11} /> Add
        </button>
      </div>

      {err && <div style={{ fontSize: 9.5, color: "#c96a6a" }}>{err}</div>}
      <Hint>Each profile is its own browser — separate tabs, logins, cookies and site data. Switching swaps the whole tab space.</Hint>
    </div>
  );
}

// ── Extensions ────────────────────────────────────────────────────────────────

function ExtensionsSection() {
  const { items, pinned, icons, loading, error, autoErrors, refresh, autoInstall, installUnpacked, remove, setEnabled, togglePin } = useExtStore();
  const [open, setOpen] = useState(true);
  const { tabs, activeTabId } = useBrowserStore();
  const activeUrl = tabs.find((t) => t.id === activeTabId)?.url;

  useEffect(() => { refresh(); }, [refresh]);

  // Active tab is a Web Store detail page → install it automatically, no
  // button needed. Fires once per id per session (autoInstall dedupes).
  const storeId = (() => {
    if (!activeUrl) return null;
    const m = activeUrl.match(/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\/detail\/(?:[^/]+\/)?([a-p]{32})/);
    return m ? m[1] : null;
  })();
  useEffect(() => { if (storeId) autoInstall(storeId); }, [storeId, autoInstall]);
  const storeInstalled = !!storeId && items.some((i) => i.id === storeId);
  const storeError = storeId ? autoErrors[storeId] : undefined;

  return (
    <div style={{
      borderBottom: "1px solid rgba(255,255,255,0.06)",
      background: "linear-gradient(180deg, rgba(79,128,245,0.04), transparent)",
    }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "12px 14px", background: "none", border: "none", cursor: "pointer",
        }}
      >
        <Puzzle size={13} color="#4f80f5" />
        <span style={{ fontSize: 11.5, color: "#bbb", fontWeight: 500, flex: 1, textAlign: "left" }}>
          Extensions
        </span>
        <span style={{ fontSize: 10, color: "#4a4a4a" }}>{items.length}</span>
        <ChevronDown size={13} color="#555" style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16 }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 7 }}>
              {/* Store page open → auto-installs (see effect above). Status
                  only, no button — installing is automatic. */}
              {storeId && storeInstalled && (
                <div style={{ ...primaryBtn, background: "rgba(79,181,106,0.1)", border: "1px solid rgba(79,181,106,0.3)", color: "#5aa06a", cursor: "default" }}>
                  <Check size={12} /> Installed
                </div>
              )}
              {storeId && !storeInstalled && !storeError && (
                <div style={{ ...primaryBtn, cursor: "default" }}>
                  <Puzzle size={12} /> Installing extension…
                </div>
              )}
              {storeId && storeError && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "#c96a6a", padding: "2px 0" }}>
                  <AlertCircle size={11} /> {storeError}
                </div>
              )}

              {error && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "#c96a6a", padding: "2px 0" }}>
                  <AlertCircle size={11} /> {error}
                </div>
              )}

              {items.length === 0 && !loading && (
                <div style={{ fontSize: 10.5, color: "#3a3a3a", padding: "6px 2px", lineHeight: 1.5 }}>
                  No extensions installed. Load an unpacked folder, or open a Chrome Web Store page and install it here.
                </div>
              )}

              {items.map((ext) => (
                <div
                  key={ext.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "7px 8px",
                    borderRadius: 8, background: "rgba(255,255,255,0.025)",
                    border: "1px solid rgba(255,255,255,0.05)",
                    opacity: ext.enabled ? 1 : 0.5,
                  }}
                >
                  <span style={{ width: 18, height: 18, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {icons[ext.id]
                      ? <img src={icons[ext.id]} alt="" style={{ width: 18, height: 18, borderRadius: 4 }} />
                      : <Puzzle size={13} color="#555" />}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: "#bbb", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {ext.name}
                    </div>
                    <div style={{ fontSize: 8.5, color: "#3a3a3a" }}>
                      {ext.version ? `v${ext.version}` : ext.id.slice(0, 8)}{!ext.enabled && " · disabled"}
                    </div>
                  </div>
                  <IconBtn
                    active={pinned.includes(ext.id)}
                    onClick={() => togglePin(ext.id)}
                    title={pinned.includes(ext.id) ? "Unpin from toolbar" : "Pin to toolbar"}
                  >
                    {pinned.includes(ext.id) ? <Pin size={12} /> : <PinOff size={12} />}
                  </IconBtn>
                  <IconBtn
                    active={ext.enabled}
                    onClick={() => setEnabled(ext.id, !ext.enabled)}
                    title={ext.enabled ? "Disable" : "Enable"}
                  >
                    <Power size={12} />
                  </IconBtn>
                  <IconBtn onClick={() => remove(ext.id)} title="Remove" danger>
                    <Trash2 size={12} />
                  </IconBtn>
                </div>
              ))}

              <button
                onClick={() => installUnpacked().catch(() => {})}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  padding: "7px 0", marginTop: 2, borderRadius: 7, cursor: "pointer",
                  background: "rgba(255,255,255,0.03)", border: "1px dashed rgba(255,255,255,0.12)",
                  color: "#777", fontSize: 10.5,
                }}
              >
                <FolderOpen size={12} /> Load unpacked…
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
  padding: "8px 0", borderRadius: 7, cursor: "pointer",
  background: "rgba(79,128,245,0.12)", border: "1px solid rgba(79,128,245,0.3)",
  color: "#7a9cf5", fontSize: 10.5,
};

// ── Incognito lock ──────────────────────────────────────────────────────────

/** Compact PIN dots — fixed slot count, filled ones pop and highlight. */
function PinDots({ count, filled, shakeKey, size = 9 }: { count: number; filled: number; shakeKey: number; size?: number }) {
  return (
    <motion.div
      key={shakeKey}
      animate={shakeKey > 0 ? { x: [0, -8, 7, -5, 4, -2, 0] } : { x: 0 }}
      transition={{ duration: 0.3 }}
      style={{ display: "flex", gap: 6 }}
    >
      {Array.from({ length: count }).map((_, i) => {
        const on = i < filled;
        return (
          <motion.div
            key={i}
            animate={{
              scale: on ? [1, 1.3, 1] : 1,
              backgroundColor: on ? "rgba(180,120,240,0.95)" : "rgba(255,255,255,0.08)",
              borderColor: on ? "rgba(180,120,240,0.9)" : "rgba(150,80,220,0.3)",
            }}
            transition={{ duration: 0.15 }}
            style={{ width: size, height: size, borderRadius: "50%", border: "1px solid" }}
          />
        );
      })}
    </motion.div>
  );
}

/** Compact numpad — same satisfying tap feel as the incognito lock screen,
 *  sized down to fit inline in a settings row. */
function MiniPinPad({ onDigit, onBack }: { onDigit: (d: string) => void; onBack: () => void }) {
  const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"] as const;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5, width: 132 }}>
      {KEYS.map((k, i) =>
        k === "" ? (
          <div key={i} />
        ) : (
          <motion.button
            key={i}
            onClick={() => (k === "back" ? onBack() : onDigit(k))}
            whileHover={{ backgroundColor: "rgba(150,80,220,0.16)" }}
            whileTap={{ scale: 0.85, backgroundColor: "rgba(150,80,220,0.3)" }}
            transition={{ duration: 0.08 }}
            style={{
              height: 26, borderRadius: 6, cursor: "pointer",
              background: "rgba(255,255,255,0.045)", border: "1px solid rgba(255,255,255,0.06)",
              color: "#c8b8e0", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            {k === "back" ? <Delete size={11} /> : k}
          </motion.button>
        )
      )}
    </div>
  );
}

function IncognitoLockRow() {
  const { settings, setSettings } = useBrowserStore();
  const [showPass, setShowPass] = useState(false);
  const [pass, setPass] = useState("");
  const [helloState, setHelloState] = useState<"idle" | "ok" | "fail">("idle");

  // Changing (or clearing) an EXISTING passcode requires proving you know it
  // first — Settings has no lock of its own, so without this gate anyone at
  // the keyboard could silently swap out the fallback passcode.
  const [verifying, setVerifying] = useState(false);
  const [verifyPass, setVerifyPass] = useState("");
  const [verifyShake, setVerifyShake] = useState(0);
  const [verifyHelloBusy, setVerifyHelloBusy] = useState(false);
  const [verifyHelloErr, setVerifyHelloErr] = useState(false);

  async function toggle() {
    const next = !settings.incognitoLock;
    setSettings({ incognitoLock: next });
    // First-time enable with no passcode yet → prompt setup directly (there's
    // nothing to verify). Re-enabling with one already set needs no prompt —
    // changing it later goes through the verify gate via the row below.
    if (next && !settings.incognitoPasscode) setShowPass(true);
  }

  function openEditor() {
    if (settings.incognitoPasscode) {
      setVerifying(true);
      setVerifyPass("");
      setVerifyHelloErr(false);
    } else {
      setShowPass(true);
    }
  }

  function closeAll() {
    setVerifying(false);
    setShowPass(false);
    setPass("");
    setVerifyPass("");
  }

  function pushVerifyDigit(d: string) {
    const len = settings.incognitoPasscodeLen;
    if (verifyPass.length >= len) return;
    const next = verifyPass + d;
    setVerifyPass(next);
    if (next.length === len) {
      setTimeout(() => {
        if (hashPasscode(next) === settings.incognitoPasscode) {
          setVerifying(false);
          setShowPass(true);
          setVerifyPass("");
        } else {
          setVerifyShake((n) => n + 1);
          setTimeout(() => setVerifyPass(""), 300);
        }
      }, 100);
    }
  }

  async function verifyHello() {
    if (verifyHelloBusy) return;
    setVerifyHelloBusy(true);
    setVerifyHelloErr(false);
    try {
      const ok = await invoke<boolean>("verify_identity", { reason: "Confirm it's you before changing the passcode" });
      if (ok) {
        setVerifying(false);
        setShowPass(true);
      } else {
        setVerifyHelloErr(true);
      }
    } catch {
      setVerifyHelloErr(true);
    }
    setVerifyHelloBusy(false);
  }

  async function testHello() {
    try {
      const ok = await invoke<boolean>("verify_identity", { reason: "Test Windows Hello" });
      setHelloState(ok ? "ok" : "fail");
    } catch {
      setHelloState("fail");
    }
    setTimeout(() => setHelloState("idle"), 2500);
  }

  const passValid = /^\d{4,6}$/.test(pass);

  function savePass() {
    if (!passValid) return;
    setSettings({ incognitoPasscode: hashPasscode(pass), incognitoPasscodeLen: pass.length });
    closeAll();
  }

  function removePass() {
    setSettings({ incognitoPasscode: "", incognitoPasscodeLen: 0 });
    closeAll();
  }

  return (
    <div>
      <ToggleRow
        icon={<EyeOff size={11} />}
        label="Lock incognito"
        sub="Require Windows Hello or a passcode to enter incognito"
        checked={settings.incognitoLock}
        onToggle={toggle}
      />
      {settings.incognitoLock && (
        <div style={{ marginTop: 8, marginLeft: 19, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              onClick={testHello}
              style={{
                display: "flex", alignItems: "center", gap: 5, padding: "5px 9px", borderRadius: 5, cursor: "pointer",
                background: "rgba(150,80,220,0.12)", border: "1px solid rgba(150,80,220,0.3)", color: "#b088e0", fontSize: 10,
              }}
            >
              <Fingerprint size={11} /> Test Windows Hello
            </button>
            {helloState === "ok" && <span style={{ fontSize: 10, color: "#5aa06a" }}>✓ works</span>}
            {helloState === "fail" && <span style={{ fontSize: 10, color: "#c96a6a" }}>unavailable</span>}
          </div>

          {!verifying && !showPass && (
            <button
              onClick={openEditor}
              style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", color: "#5a5a5a", fontSize: 10, textAlign: "left", padding: 0 }}
            >
              <Lock size={10} /> {settings.incognitoPasscode ? "Change fallback passcode" : "Set a fallback passcode"}
            </button>
          )}

          {/* Verify-first gate — must prove the current passcode (or Hello)
              before the editor below will open. */}
          {verifying && (
            <div style={{
              display: "flex", flexDirection: "column", gap: 8, padding: "10px 10px 9px",
              borderRadius: 8, background: "rgba(150,80,220,0.05)", border: "1px solid rgba(150,80,220,0.2)",
            }}>
              <span style={{ fontSize: 9.5, color: "#8a7a9a" }}>Enter the current passcode to change it</span>
              <PinDots count={settings.incognitoPasscodeLen} filled={verifyPass.length} shakeKey={verifyShake} />
              <MiniPinPad
                onDigit={pushVerifyDigit}
                onBack={() => setVerifyPass((p) => p.slice(0, -1))}
              />
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button
                  onClick={verifyHello}
                  style={{
                    display: "flex", alignItems: "center", gap: 5, padding: "5px 9px", borderRadius: 5, cursor: "pointer",
                    background: "rgba(150,80,220,0.12)", border: "1px solid rgba(150,80,220,0.3)",
                    color: verifyHelloErr ? "#c96a6a" : "#b088e0", fontSize: 10,
                  }}
                >
                  <Fingerprint size={11} /> {verifyHelloBusy ? "Waiting…" : verifyHelloErr ? "Failed — retry" : "Use Hello instead"}
                </button>
                <button onClick={closeAll} style={{ background: "none", border: "none", cursor: "pointer", color: "#4a4a4a", fontSize: 10, padding: 0 }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* New-passcode editor — same PIN-pad language as the lock screen
              instead of a plain text box. */}
          {showPass && (
            <div style={{
              display: "flex", flexDirection: "column", gap: 8, padding: "10px 10px 9px",
              borderRadius: 8, background: "rgba(150,80,220,0.05)", border: "1px solid rgba(150,80,220,0.2)",
            }}>
              <span style={{ fontSize: 9.5, color: "#8a7a9a" }}>New passcode — 4 to 6 digits</span>
              <PinDots count={6} filled={pass.length} shakeKey={0} />
              <MiniPinPad
                onDigit={(d) => setPass((p) => (p.length < 6 ? p + d : p))}
                onBack={() => setPass((p) => p.slice(0, -1))}
              />
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button
                  onClick={savePass}
                  disabled={!passValid}
                  style={{
                    padding: "5px 12px", borderRadius: 5, cursor: passValid ? "pointer" : "default",
                    background: "rgba(150,80,220,0.2)", border: "none",
                    color: passValid ? "#b088e0" : "#554a66", fontSize: 10,
                  }}
                >
                  Save
                </button>
                <button onClick={closeAll} style={{ background: "none", border: "none", cursor: "pointer", color: "#4a4a4a", fontSize: 10, padding: 0 }}>
                  Cancel
                </button>
                {settings.incognitoPasscode && (
                  <button onClick={removePass} style={{ background: "none", border: "none", cursor: "pointer", color: "#a55", fontSize: 10, padding: 0, marginLeft: "auto" }}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Clear data ────────────────────────────────────────────────────────────────

function ClearDataSection() {
  const { tabs, activeTabId } = useBrowserStore();
  const activeUrl = tabs.find((t) => t.id === activeTabId)?.url ?? "";
  const host = (() => { try { return new URL(activeUrl).hostname; } catch { return ""; } })();

  const [scope, setScope] = useState<"site" | "all">("site");
  const [kinds, setKinds] = useState<Set<string>>(new Set(["cookies", "cache", "storage"]));
  const [confirming, setConfirming] = useState(false);
  const [phase, setPhase] = useState<"idle" | "busy" | "done" | "err">("idle");

  function toggleKind(k: string) {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }

  const effectiveKinds = [...kinds].filter((k) => !(scope === "site" && k === "cache"));
  const disabled = effectiveKinds.length === 0 || (scope === "site" && !host);

  async function doClear() {
    setConfirming(false);
    setPhase("busy");
    try {
      await invoke("clear_site_data", { scope, kinds: effectiveKinds, url: activeUrl });
      setPhase("done");
    } catch (e) {
      console.error("clear_site_data", e);
      setPhase("err");
    }
    setTimeout(() => setPhase("idle"), 2000);
  }

  return (
    <div style={{ padding: 8, borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ fontSize: 9.5, color: "#4a4a4a", marginBottom: 6 }}>Clear browsing data</div>
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {([["site", host ? `This site (${host})` : "This site"], ["all", "All sites"]] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setScope(key)}
            style={{
              flex: 1, padding: "5px 4px", fontSize: 9.5, borderRadius: 5, cursor: "pointer",
              border: `1px solid ${scope === key ? "rgba(79,128,245,0.5)" : "rgba(255,255,255,0.07)"}`,
              background: scope === key ? "rgba(79,128,245,0.12)" : "rgba(255,255,255,0.03)",
              color: scope === key ? "#7a9cf5" : "#666",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 9 }}>
        {([
          ["cookies", "Cookies", false],
          ["cache", "Cache", scope === "site"],
          ["storage", "Site data (localStorage, IndexedDB…)", false],
        ] as const).map(([key, label, off]) => (
          <label
            key={key}
            style={{ display: "flex", alignItems: "center", gap: 6, cursor: off ? "default" : "pointer", opacity: off ? 0.35 : 1, fontSize: 10, color: "#888" }}
            title={off ? "WebView2 can only clear the cache for all sites" : undefined}
          >
            <span
              onClick={() => !off && toggleKind(key)}
              style={{
                width: 12, height: 12, borderRadius: 3, flexShrink: 0,
                border: `1px solid ${kinds.has(key) && !off ? "rgba(79,128,245,0.7)" : "rgba(255,255,255,0.15)"}`,
                background: kinds.has(key) && !off ? "rgba(79,128,245,0.4)" : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#dfe7ff", lineHeight: 1,
              }}
            >
              {kinds.has(key) && !off ? "✓" : ""}
            </span>
            <span onClick={() => !off && toggleKind(key)}>{label}</span>
            {off && <span style={{ fontSize: 8, color: "#4a4a4a" }}>all-sites only</span>}
          </label>
        ))}
      </div>
      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          disabled={disabled || phase === "busy"}
          style={{
            width: "100%", padding: "6px 0", fontSize: 10.5, borderRadius: 5, cursor: disabled ? "default" : "pointer",
            border: "1px solid rgba(220,60,60,0.2)", background: "rgba(220,60,60,0.07)",
            color: phase === "done" ? "#4fb56a" : phase === "err" ? "#c96a6a" : disabled ? "#555" : "#c96a6a",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6, opacity: disabled ? 0.5 : 1,
          }}
        >
          <Trash2 size={11} />
          {phase === "busy" ? "Clearing…" : phase === "done" ? "Cleared" : phase === "err" ? "Failed — see logs" : "Clear selected"}
        </button>
      ) : (
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={doClear} style={{ flex: 1, padding: "6px 0", fontSize: 10, borderRadius: 5, cursor: "pointer", border: "none", background: "rgba(220,60,60,0.25)", color: "#e88" }}>
            Clear {scope === "site" ? host || "this site" : "all sites"}
          </button>
          <button onClick={() => setConfirming(false)} style={{ flex: 1, padding: "6px 0", fontSize: 10, borderRadius: 5, cursor: "pointer", border: "none", background: "rgba(255,255,255,0.05)", color: "#777" }}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ── Primitives ────────────────────────────────────────────────────────────────

function Card({ icon, title, children, defaultOpen = true }: {
  icon: React.ReactNode; title: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  // Collapse state persists across panel closes AND restarts, keyed by title
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem(`zro-card:${title}`);
    return saved === null ? defaultOpen : saved === "1";
  });
  function toggle() {
    setOpen((o) => {
      localStorage.setItem(`zro-card:${title}`, o ? "0" : "1");
      return !o;
    });
  }
  return (
    <div style={{ padding: 12, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
      <div
        onClick={toggle}
        style={{
          display: "flex", alignItems: "center", gap: 7, marginBottom: open ? 10 : 0,
          fontSize: 11, color: "#b0b0b0", fontWeight: 500, cursor: "pointer", userSelect: "none",
        }}
      >
        <span style={{ color: "#4f80f5", display: "flex" }}>{icon}</span>
        <span style={{ flex: 1 }}>{title}</span>
        <ChevronDown
          size={12}
          style={{ color: "#666", transform: open ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }}
        />
      </div>
      {open && children}
    </div>
  );
}

function Choice({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: "6px 0", fontSize: 10, borderRadius: 5, cursor: "pointer",
        border: `1px solid ${active ? "rgba(79,128,245,0.5)" : "rgba(255,255,255,0.07)"}`,
        background: active ? "rgba(79,128,245,0.12)" : "rgba(255,255,255,0.03)",
        color: active ? "#7a9cf5" : "#666", transition: "all 0.12s",
      }}
    >
      {label}
    </button>
  );
}

function IconBtn({ children, onClick, title, active, danger }: {
  children: React.ReactNode; onClick: () => void; title: string; active?: boolean; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: "none", border: "none", cursor: "pointer", display: "flex", padding: 3, flexShrink: 0, borderRadius: 4,
        color: danger ? "#6a4444" : active ? "#7a9cf5" : "#555",
      }}
    >
      {children}
    </button>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 9.5, color: "#3f3f3f", marginBottom: 4 }}>{children}</div>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 9.5, color: "#3a3a3a", marginTop: 6, lineHeight: 1.5 }}>{children}</div>;
}

interface SavedPassword { id: string; origin: string; username: string; password: string; }

/** Read-only viewer for WebView2's own saved passwords (the chrome://passwords
 *  equivalent). Lists origin + username; reveal/copy decrypt one entry on
 *  demand via the Rust `reveal_password` command. No editing/deleting — writing
 *  to the live Login Data DB would risk corrupting the store. */
function PasswordsSection() {
  const [rows, setRows] = useState<SavedPassword[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState<Record<string, string>>({}); // id → plaintext
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    invoke<SavedPassword[]>("list_passwords")
      .then(setRows)
      .catch((e) => setErr(String(e)));
  }, []);

  async function reveal(id: string) {
    if (shown[id] !== undefined) {
      setShown((s) => { const n = { ...s }; delete n[id]; return n; });
      return;
    }
    try {
      const pw = await invoke<string>("reveal_password", { id });
      setShown((s) => ({ ...s, [id]: pw }));
    } catch (e) {
      setErr(String(e));
    }
  }

  async function copy(id: string) {
    try {
      const pw = shown[id] ?? (await invoke<string>("reveal_password", { id }));
      await navigator.clipboard.writeText(pw);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
    } catch (e) {
      setErr(String(e));
    }
  }

  if (err) return <Hint>Couldn't read saved passwords: {err}</Hint>;
  if (rows === null) return <Hint>Loading…</Hint>;
  if (rows.length === 0)
    return <Hint>No saved passwords yet. Sites you sign into with autofill on will appear here.</Hint>;

  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? rows.filter((r) => r.origin.toLowerCase().includes(ql) || r.username.toLowerCase().includes(ql))
    : rows;

  return (
    <div>
      <div style={{ position: "relative", marginBottom: 8 }}>
        <Search size={11} style={{ position: "absolute", left: 8, top: 8, color: "#4a4a4a" }} />
        <input
          value={q}
          placeholder={`Search ${rows.length} password${rows.length === 1 ? "" : "s"}`}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
          style={{
            width: "100%", fontSize: 11, color: "#aaa",
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 5, padding: "6px 8px 6px 24px",
          }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto" }}>
        {filtered.map((r) => {
          const open = shown[r.id] !== undefined;
          return (
            <div key={r.id} style={{
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)",
              borderRadius: 6, padding: "7px 8px",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "#bcbcbc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.origin}
                  </div>
                  <div style={{ fontSize: 9.5, color: "#6a6a6a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.username || "(no username)"}
                  </div>
                </div>
                <IconBtn title={open ? "Hide" : "Reveal"} onClick={() => reveal(r.id)}>
                  {open ? <EyeOff size={12} /> : <Eye size={12} />}
                </IconBtn>
                <IconBtn title="Copy password" onClick={() => copy(r.id)}>
                  {copied === r.id ? <Check size={12} color="#69cf85" /> : <Copy size={12} />}
                </IconBtn>
              </div>
              {open && (
                <div style={{
                  marginTop: 6, fontSize: 11, color: "#e0e0e0", fontFamily: "monospace",
                  background: "rgba(0,0,0,0.35)", borderRadius: 4, padding: "5px 7px",
                  wordBreak: "break-all", userSelect: "all",
                }}>
                  {shown[r.id]}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <Hint>No matches.</Hint>}
      </div>
      <Hint>Your saved logins, decrypted locally with your Windows account. Read-only.</Hint>
    </div>
  );
}

function TextInput({ value, placeholder, onChange, password }: {
  value: string; placeholder: string; onChange: (v: string) => void; password?: boolean;
}) {
  return (
    <input
      type={password ? "password" : "text"}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      style={{
        width: "100%", fontSize: 11, color: "#aaa",
        background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 5, padding: "6px 8px", marginBottom: 8,
      }}
    />
  );
}

function ToggleRow({ icon, label, sub, checked, onToggle }: {
  icon: React.ReactNode; label: string; sub?: string; checked: boolean; onToggle: () => void;
}) {
  return (
    <div onClick={onToggle} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
      <span style={{ color: "#3a3a3a", display: "flex", marginTop: 2 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: "#888" }}>{label}</div>
        {sub && <div style={{ fontSize: 9, color: "#3a3a3a", marginTop: 1, lineHeight: 1.4 }}>{sub}</div>}
      </div>
      <div style={{
        width: 26, height: 15, borderRadius: 8, flexShrink: 0, marginTop: 2,
        background: checked ? "rgba(79,128,245,0.5)" : "rgba(255,255,255,0.08)",
        position: "relative", transition: "background 0.15s",
      }}>
        <div style={{
          position: "absolute", top: 2, left: checked ? 13 : 2, width: 11, height: 11, borderRadius: "50%",
          background: checked ? "#dfe7ff" : "#555", transition: "left 0.15s, background 0.15s",
        }} />
      </div>
    </div>
  );
}
