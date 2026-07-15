# zro installer (Option C — custom themed installer)

A small **Tauri app** whose window *is* the installer: dark terminal aesthetic,
rounded frameless window, custom buttons, animated progress log. This is the
"full control over the look" path that NSIS can't give.

It replaces the wizard chrome only — it does the real install work:
download the zro payload → extract to the chosen folder → shortcuts →
uninstall entry → launch.

```
zro-installer/
  ui/                 self-contained frontend (no bundler)
    index.html        themed installer UI
    main.js           flow + Tauri invoke (falls back to demo mode)
  src-tauri/
    src/lib.rs        install logic (download/extract/shortcuts/registry)
    tauri.conf.json   frameless + transparent window (rounded via CSS)
    capabilities/     window + event permissions
```

## Preview the look (no build)

Open `ui/index.html` in any browser — with no Tauri present it runs in **demo
mode** (simulated progress), so you can see the design immediately. Nothing is
installed.

## Build

```bash
cd zro-installer
pnpm install
pnpm tauri build      # → src-tauri/target/release/ (zro Setup.exe)
```

`pnpm tauri dev` runs it live.

## Integration — required before it can install a real build

This installer downloads a **portable zip** of zro, but zro currently ships only
an NSIS installer. Two things to wire up:

1. **Publish a portable zip** on the zro release. In the main repo's
   `release.yml`, after the Tauri build, zip the portable output
   (`zro.exe` + `WebView2Loader.dll` + resources) as `zro-portable.zip` and
   attach it to the GitHub release. The installer fetches
   `releases/latest/download/zro-portable.zip` (see `PAYLOAD_URL` in
   [lib.rs](src-tauri/src/lib.rs)).

2. **Uninstaller.** `register_uninstall` currently points `UninstallString` at
   `zro.exe --uninstall`. Either implement a `--uninstall` mode in zro (remove
   the install dir + shortcuts + this registry key), or copy a tiny uninstaller
   binary into the install dir and point at that.

## Status

Scaffold — **not yet built or runtime-tested.** The UI is complete; the Rust
install flow is implemented but needs the payload zip (above) and a build+test
pass on Windows. Icons are borrowed from the main app
(`../src-tauri/icons`).

## Why this over NSIS

NSIS is Win32 wizard dialogs — no rounded corners, no custom buttons, no real
theming. A Tauri window is just a web page, so the installer can look like the
product. Trade-off: the `zro Setup.exe` is larger than an NSIS stub (it carries
a WebView2 shell), but it downloads the actual browser rather than embedding it.
