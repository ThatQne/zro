// zro installer — frontend. Talks to the Rust backend via Tauri `invoke` when
// running inside the installer app; falls back to a simulated "demo mode" when
// opened in a plain browser (so the design is previewable without a build).

const TAURI = !!window.__TAURI__;
const invoke = TAURI ? window.__TAURI__.core.invoke : null;
const listen = TAURI ? window.__TAURI__.event.listen : null;

const $ = (id) => document.getElementById(id);
const opts = { desktop: true, startmenu: true, launch: true };

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

// ── default install path ─────────────────────────────────────────────────────
async function initPath() {
  let def = "C:\\Users\\you\\AppData\\Local\\zro";
  if (TAURI) {
    try { def = await invoke("default_install_dir"); } catch {}
  }
  $("path").value = def;
}
initPath();

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

// ── install flow ─────────────────────────────────────────────────────────────
let installing = false;
$("install").onclick = async () => {
  if (installing) return;
  installing = true;
  $("setup").classList.add("hide");
  term.classList.add("show");
  $("meter").classList.add("show");
  $("install").classList.add("hide");
  $("title").textContent = "Installing zro…";
  $("subtitle").textContent = $("path").value;

  const path = $("path").value;
  log(`<span class="b">zro installer</span> <span class="d">· target</span> ${path}`);

  try {
    if (TAURI) {
      await invoke("install", { dir: path, options: opts });
    } else {
      await demoInstall(); // preview mode
    }
    onDone();
  } catch (e) {
    log(`<span style="color:#d66">✗ ${e}</span>`);
    setProgress(0, "Install failed.");
    $("install").classList.remove("hide");
    installing = false;
  }
};

function onDone() {
  setProgress(100, "Done.");
  log(`<span class="ok">✓ zro installed successfully.</span>`);
  $("title").textContent = "zro is ready";
  $("subtitle").textContent = "Installation complete.";
  $("finish").classList.remove("hide");
}

$("finish").onclick = async () => {
  if (TAURI) {
    if (opts.launch) { try { await invoke("launch_zro", { dir: $("path").value }); } catch {} }
    window.__TAURI__.window.getCurrentWindow().close();
  } else {
    onDoneDemoReset();
  }
};

// ── demo mode (no Tauri) — simulate the steps so the UI is previewable ───────
async function demoInstall() {
  const steps = [
    [8, "Preparing target directory"],
    [22, "Downloading zro 0.1.0 (4.4 MB)"],
    [55, "Extracting application files"],
    [70, "Writing registry entries"],
    [84, "Creating shortcuts"],
    [96, "Registering uninstaller"],
  ];
  for (const [pct, step] of steps) {
    setProgress(pct, step);
    log(`<span class="d">→</span> ${step}`);
    await sleep(420 + Math.random() * 260);
  }
}
function onDoneDemoReset() {
  log(`<span class="b">demo</span> <span class="d">— nothing was actually installed.</span>`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
