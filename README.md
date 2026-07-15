<div align="center">

# zro

**A fast, lightweight, open-source minimalist browser for Windows.**

Native Rust shell over WebView2 — no bundled Chromium, no telemetry, no bloat.

[**Download**](https://github.com/ThatQne/zro/releases/latest) · [**Website**](https://thatqne.github.io/zro) · AGPL-3.0 + Commercial

</div>

---

- **Lightweight** — 4.4 MB installer, ~16 MB on disk, uses the system WebView2 runtime.
- **Snappy** — per-tab renderers; inactive tabs freeze then sleep, so RAM stays flat.
- **Shields** — Brave's native adblock engine, HTTPS upgrade, tracking-param strip.
- **AI agent** — reads the page, clicks, fills, searches history; local semantic memory.
- **Private** — incognito with a Windows Hello lock, built-in cookie editor, no tracking.
- **Auto-updating** — signed builds delivered in-app from GitHub Releases.

## Build from source

Requires Node 18+, Rust 1.70+, Windows 10/11.

```bash
pnpm install
pnpm tauri dev      # run with hot-reload
pnpm tauri build    # release installer → src-tauri/target/release/bundle/nsis
```

## Release

Tag a version to build + publish a signed installer via CI:

```bash
git tag v0.1.1 && git push --tags
```

Stack: Rust · Tauri v2 · React · TypeScript.

## License

zro is **dual-licensed**:

- **[AGPL-3.0](./LICENSE)** — free and open source. Use it, fork it, contribute.
  Any distributed or network-served derivative must also be open-sourced under
  AGPL-3.0.
- **[Commercial](./LICENSE-COMMERCIAL.md)** — a paid license that removes the
  AGPL copyleft so you can build zro into a closed-source or proprietary
  product. Email **thatqne@gmail.com**.

Contributions are accepted under the CLA in [CONTRIBUTING.md](./CONTRIBUTING.md),
which keeps the dual-license model possible. Not legal advice.

If you find zro useful, you can [buy me a coffee](https://www.buymeacoffee.com/thatqne). ☕
