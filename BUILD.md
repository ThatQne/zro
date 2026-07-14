# Build & Deployment Guide

This document covers building the release binary and generating installers for distribution.

## Quick Start

### Development Build
```bash
npm run tauri:dev
```
Hot-reload enabled; rebuilds Rust on file changes (slower).

### Release Build (Portable Binary)
```bash
npm run tauri:build
```

Outputs:
- `src-tauri/target/release/zro.exe` — standalone executable (~180MB with WebView2 runtime embedded)
- `src-tauri/target/release/bundle/msi/` — Windows MSI installer
- `src-tauri/target/release/bundle/nsis/` — Windows NSIS installer (portable + uninstaller)

## Installers

### MSI (Microsoft Installer)
```bash
npm run tauri:build:msi
```

**Pros:**
- Standard Windows installer format
- Can integrate with Windows Add/Remove Programs
- Allows per-user vs. per-machine installation
- Smaller file size

**Cons:**
- Requires Windows Installer service running
- Slower installation

**File location:** `src-tauri/target/release/bundle/msi/zro_*.msi`

### NSIS (Nullsoft Installer System)
```bash
npm run tauri:build:nsis
```

**Pros:**
- Lightweight, fast installer
- Generates both installer (.exe) and portable version
- No dependencies

**Cons:**
- Less "official" on Windows

**File location:** `src-tauri/target/release/bundle/nsis/zro_*.exe`

### Both
```bash
npm run tauri:build:all
```

Generates MSI + NSIS in one go. Takes longer.

## Build Configuration

Edit `src-tauri/tauri.conf.json`:
- `version` — bump for each release (semantic versioning)
- `bundle.targets` — control which installers to generate (`["msi", "nsis"]`, `["msi"]`, etc.)
- `bundle.icon` — app icon (PNG, should be 1024×1024+)

Example minimal config:
```json
{
  "productName": "zro",
  "version": "0.2.0",
  "bundle": {
    "active": true,
    "targets": ["msi", "nsis"],
    "icon": ["icons/icon.png"]
  }
}
```

## Distribution

### Option 1: Portable Binary (Simplest)
Copy `zro.exe` to users via email or cloud storage. No installation required.

```bash
cp src-tauri/target/release/zro.exe ~/Downloads/zro-0.1.0.exe
```

### Option 2: MSI Installer (Professional)
Users run the `.msi` from `bundle/msi/`:
```bash
# Users double-click this in File Explorer or run:
msiexec /i zro_0.1.0_x64_en-US.msi
```

For silent install:
```bash
msiexec /i zro_0.1.0_x64_en-US.msi /quiet /qn
```

For uninstall:
```bash
msiexec /x zro_0.1.0_x64_en-US.msi /quiet
```

### Option 3: NSIS Installer (Lightweight)
Users run the `.exe` from `bundle/nsis/`:
```bash
# Double-click, or:
zro_0.1.0_x64-setup.exe
```

NSIS also generates a portable version in the same directory.

## Signing & Certificates

### Unsigned Builds (Current)
Installers are **not signed**. Windows will show a warning on first run (SmartScreen).

To suppress the warning for testing:
1. Right-click installer
2. Properties → Unblock (checkbox)
3. Proceed

### Signed Builds (Production)
To sign installers for distribution:

1. Obtain a code-signing certificate (DigiCert, Sectigo, etc.; ~$200–400/year)
2. Export as PFX file
3. Update `src-tauri/tauri.conf.json`:
   ```json
   "bundle": {
     "windows": {
       "certificateThumbprint": "<YOUR_THUMBPRINT>",
       "timestampUrl": "http://timestamp.sectigo.com"
     }
   }
   ```
4. Run build:
   ```bash
   npm run tauri:build
   ```

Signing adds ~30s to the build time. Verifies authenticity to Windows (SmartScreen approved).

## Versioning & Release Notes

Update version in multiple places:
- `src-tauri/tauri.conf.json` — `"version": "x.y.z"`
- `package.json` — `"version": "x.y.z"`

Then rebuild:
```bash
npm run tauri:build
```

GitHub releases can link to the installer:
```markdown
## zro 0.2.0

**Features:**
- UI-on-top compositing fixes overlays rendering under pages
- YouTube video→video no longer shows stale URLs
- Cookie editor + AI cookie access

**Downloads:**
- [zro-0.2.0.exe](https://github.com/yourname/zro/releases/download/v0.2.0/zro-0.2.0.exe) (portable)
- [zro-0.2.0-setup.msi](https://github.com/yourname/zro/releases/download/v0.2.0/zro-0.2.0-setup.msi) (installer)
```

## Troubleshooting

### Build fails: "Vite dist not found"
Run frontend build first:
```bash
npm run build
npm run tauri:build
```

### Build fails: "Rust error"
Ensure Rust is up-to-date:
```bash
rustup update
cargo clean
npm run tauri:build
```

### Installer is too large
WebView2 runtime is ~180MB (only downloaded once per machine). To reduce size:
- Use NSIS (slightly smaller)
- Exclude unrequired assets from `bundle.resources`

### MSI installer fails on user's machine
- User may not have msiexec (rare on modern Windows)
- Fallback to NSIS installer or portable `.exe`

### SmartScreen blocks NSIS installer
- Expected for unsigned builds
- Users click "More info" → "Run anyway"
- Signing the installer removes the warning

## Automatic Updates (Future)

Tauri supports auto-updates via `tauri-updater`:

1. Set up an update server (GitHub releases, custom JSON endpoint)
2. Add to `tauri.conf.json`:
   ```json
   "updater": {
     "active": true,
     "endpoints": ["https://updates.example.com/{{target}}/{{current_version}}"],
     "dialog": true,
     "pubkey": "<YOUR_PUBLIC_KEY>"
   }
   ```
3. Users auto-check for updates on startup

Details: https://tauri.app/docs/guides/updater/

## Testing Installers

Before distributing:

1. **Clean test:**
   - Run installer on fresh VM or separate user account
   - Verify shortcuts work
   - Check uninstall removes files

2. **Manual test:**
   - Use the portable binary directly from `target/release/`
   - Ensure WebView2 is accessible

3. **Launch verification:**
   - App should start, display UI, navigate pages
   - Settings panel, cookies, AI should work

## Publishing Checklist

- [ ] Bump version in `tauri.conf.json` and `package.json`
- [ ] `npm run build` passes (no TS errors)
- [ ] `npm run tauri:build` succeeds
- [ ] Test installer on a fresh machine or VM
- [ ] Update CHANGELOG or release notes
- [ ] Sign installers (if using production certificate)
- [ ] Upload `.exe` / `.msi` to distribution channel
- [ ] Tag git release: `git tag v0.x.y`

---

Questions? Check `README.md` or run `npm run tauri:build -- --help` for Tauri CLI options.
