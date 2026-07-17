// zro installer — frontend. Talks to the Rust backend via Tauri `invoke` when
// running inside the installer app; falls back to a simulated "demo mode" when
// opened in a plain browser (so the design is previewable without a build).
// The same UI serves both modes: install, and (as uninstall.exe --uninstall)
// the themed uninstaller. Preview the latter with ?uninstall in a browser.

const TAURI = !!window.__TAURI__;
const invoke = TAURI ? window.__TAURI__.core.invoke : null;
const listen = TAURI ? window.__TAURI__.event.listen : null;

const $ = (id) => document.getElementById(id);
const opts = { desktop: true, startmenu: true, launch: true, purge: false };
let mode = "install";

// ── window controls ──────────────────────────────────────────────────────────
$("min").onclick = () => TAURI && window.__TAURI__.window.getCurrentWindow().minimize();
$("close").onclick = () => TAURI ? window.__TAURI__.window.getCurrentWindow().close() : window.close();

// ── option checkboxes ────────────────────────────────────────────────────────
document.querySelectorAll(".opt").forEach((el) => {
  el.onclick = () => {
    const k = el.dataset.opt;
    opts[k] = !opts[k];
    el.classList.toggle("on", opts[k]);
  };
});

// ── mode + default paths ─────────────────────────────────────────────────────
async function init() {
  if (TAURI) {
    try { mode = await invoke("install_mode"); } catch {}
  } else if (location.search.includes("uninstall")) {
    mode = "uninstall"; // browser preview of the uninstaller
  }

  if (mode === "uninstall") {
    $("barMode").textContent = "uninstaller";
    $("title").innerHTML = 'uninstall zro<span class="cur"></span>';
    $("subtitle").textContent = "removes the app, shortcuts and registry entries";
    $("setup").classList.add("hide");
    $("unsetup").classList.remove("hide");
    $("install").classList.add("hide");
    $("uninstall").classList.remove("hide");
    $("status").textContent = "ready to uninstall";
    let dir = "C:\\Users\\you\\AppData\\Local\\zro";
    if (TAURI) { try { dir = await invoke("uninstall_info"); } catch {} }
    $("unpath").value = dir;
    return;
  }

  let def = "C:\\Users\\you\\AppData\\Local\\zro";
  if (TAURI) {
    try { def = await invoke("default_install_dir"); } catch {}
  }
  $("path").value = def;
}
init();

$("browse").onclick = async () => {
  if (!TAURI) return;
  try {
    const dir = await invoke("pick_install_dir");
    if (dir) $("path").value = dir;
  } catch (e) { console.error(e); }
};

// ── terminal log ─────────────────────────────────────────────────────────────
const term = $("term");
function log(html) {
  const line = document.createElement("div");
  line.className = "l";
  line.innerHTML = html;
  term.appendChild(line);
  term.scrollTop = term.scrollHeight;
}
function setProgress(pct, status) {
  $("bar").style.width = Math.max(0, Math.min(100, pct)) + "%";
  if (status != null) $("status").textContent = status;
}

// Backend streams progress as { pct, step } on the "install-progress" event.
if (TAURI) {
  listen("install-progress", (e) => {
    const { pct, step } = e.payload;
    setProgress(pct, step);
    if (step) log(`<span class="d">→</span> ${step}`);
  });
}

function enterStage(title, subtitle) {
  $("setup").classList.add("hide");
  $("unsetup").classList.add("hide");
  term.classList.add("show");
  $("meter").classList.add("show");
  $("title").innerHTML = title + '<span class="cur"></span>';
  $("subtitle").textContent = subtitle;
}

// ── install flow ─────────────────────────────────────────────────────────────
let busy = false;
$("install").onclick = async () => {
  if (busy) return;
  busy = true;
  $("install").classList.add("hide");
  const path = $("path").value;
  enterStage("installing zro", path);
  log(`<span class="b">zro installer</span> <span class="d">· target</span> ${path}`);

  try {
    if (TAURI) {
      await invoke("install", { dir: path, options: opts });
    } else {
      await demoRun([
        [8, "Preparing target directory"],
        [22, "Downloading zro 0.1.0 (4.4 MB)"],
        [55, "Extracting application files"],
        [70, "Writing registry entries"],
        [84, "Creating shortcuts"],
        [96, "Registering uninstaller"],
      ]);
    }
    setProgress(100, "done");
    log(`<span class="ok">✓ zro installed successfully.</span>`);
    $("title").innerHTML = 'zro is ready<span class="cur"></span>';
    $("subtitle").textContent = "installation complete";
    $("finish").classList.remove("hide");
  } catch (e) {
    log(`<span style="color:#d66">✗ ${e}</span>`);
    setProgress(0, "install failed");
    $("install").classList.remove("hide");
    busy = false;
  }
};

// ── uninstall flow ───────────────────────────────────────────────────────────
$("uninstall").onclick = async () => {
  if (busy) return;
  busy = true;
  $("uninstall").classList.add("hide");
  enterStage("uninstalling zro", $("unpath").value);
  log(`<span class="b">zro uninstaller</span> <span class="d">· target</span> ${$("unpath").value}`);
  if (opts.purge) log(`<span class="warn">→ browsing data will be deleted</span>`);

  try {
    if (TAURI) {
      await invoke("uninstall", { purge: opts.purge });
    } else {
      await demoRun([
        [10, "Removing shortcuts"],
        [30, "Removing registry entries"],
        [65, "Removing application files"],
        [90, "Scheduling final cleanup"],
      ]);
    }
    setProgress(100, "done");
    log(`<span class="ok">✓ zro removed.</span>`);
    $("title").innerHTML = 'zro removed<span class="cur"></span>';
    $("subtitle").textContent = "the folder disappears once this window closes";
    $("finish").textContent = "close";
    $("finish").classList.remove("hide");
  } catch (e) {
    log(`<span style="color:#d66">✗ ${e}</span>`);
    setProgress(0, "uninstall failed");
    $("uninstall").classList.remove("hide");
    busy = false;
  }
};

// ── finish ───────────────────────────────────────────────────────────────────
$("finish").onclick = async () => {
  if (TAURI) {
    if (mode === "install" && opts.launch) {
      try { await invoke("launch_zro", { dir: $("path").value }); } catch {}
    }
    window.__TAURI__.window.getCurrentWindow().close();
  } else {
    log(`<span class="b">demo</span> <span class="d">— nothing was actually ${mode}ed.</span>`);
  }
};

// ── demo mode (no Tauri) — simulate the steps so the UI is previewable ───────
async function demoRun(steps) {
  for (const [pct, step] of steps) {
    setProgress(pct, step);
    log(`<span class="d">→</span> ${step}`);
    await sleep(420 + Math.random() * 260);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
