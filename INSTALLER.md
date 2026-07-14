# Installing & Running zro

## For Users

### Option 1: Portable Binary (Easiest)
1. Download `zro.exe`
2. Double-click or run from Command Prompt
3. No installation required; runs from any location
4. Installer required for Windows shortcuts/Start menu

### Option 2: MSI Installer (Recommended)
1. Download `zro-0.1.0.msi` (or latest version)
2. Double-click to run the installer
3. Follow prompts (default: `C:\Program Files\zro`)
4. App appears in Add/Remove Programs; Start menu shortcut created
5. To uninstall: Settings → Apps → zro → Remove

### Option 3: NSIS Installer (Lightweight)
1. Download `zro-0.1.0-setup.exe`
2. Run installer; follow prompts
3. Option to create Start menu & Desktop shortcuts
4. Portable version also generated for USB/portable use

## First Run

After installation:
- **WebView2 Runtime Required** — Windows 11 includes it. Older Windows: auto-downloads from Microsoft (~150MB one-time)
- **First Launch** — may take 30s as WebView2 initializes
- **Profile Creation** — browser profile stored at `%LOCALAPPDATA%\com.zro.browser\EBWebView` (~565MB persistent storage)

## System Requirements

- **OS** — Windows 10 (21H2) or Windows 11
- **CPU** — Intel/AMD x86-64 (any modern processor)
- **RAM** — 4GB minimum (8GB recommended)
- **Disk** — ~500MB for binary + runtime + profiles
- **WebView2** — auto-installed if missing (Windows 11 includes it)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+T | New tab |
| Ctrl+W | Close tab |
| Ctrl+Shift+T | Reopen closed tab |
| Ctrl+H | History |
| Ctrl+J | Downloads |
| Ctrl+, | Settings |
| Ctrl+L / Ctrl+E | Focus URL bar |
| Ctrl+Tab | Next tab |
| Ctrl+Shift+Tab | Previous tab |
| Ctrl+1 to Ctrl+8 | Jump to tab 1–8 |
| Ctrl+9 | Jump to last tab |
| Ctrl+R / F5 | Reload |
| Ctrl+Shift+R | Hard reload (clear cache) |
| Ctrl+± / Ctrl+Scroll | Zoom in/out |
| Alt+A | Toggle AI assistant |

## Quick Tips

### Organize Tabs
- Hover sidebar to expand
- Drag tabs to reorder
- Right-click → folder/rename/close
- Create folders to group by project

### Search
- URL bar searches Google by default
- Change provider: Settings → Search Engine (Google/DuckDuckGo/Bing)

### Cookies & Login
- Settings → Cookies (active page)
- View, copy, add, delete cookies
- Great for debugging login issues

### AI Assistant
- Ctrl+Alt+A or click Bot button
- Choose provider: Ollama (local) / OpenAI (API) / mz-code (CLI)
- Ask it to click, fill forms, read pages
- Remembers page context between turns

### Privacy
- Ctrl+Shift+I for Incognito (no history, cookies isolated)
- Settings → Clear cookies/cache/history (with confirmation)

### Performance
- Close unused tabs (each tab is an independent process)
- Disable AI if you don't use it (Settings → AI provider → off)
- Check CPU/memory in Stats panel

## Troubleshooting

### Page doesn't load or shows blank
1. Check internet connection
2. Try different page (google.com)
3. Ctrl+R to reload
4. Close & reopen the browser

### "Add account" button or links don't work
- **This is fixed in current build** (no additionalBrowserArgs in config)
- Rare edge: if problem persists, check Settings → AI provider (some providers can interfere)

### Zooming doesn't work (Ctrl+±)
- Already enabled in this build
- If stuck: Ctrl+0 to reset zoom to 100%

### AI assistant stuck / no response
1. Check provider is running
   - **Ollama**: `ollama serve` in another terminal
   - **OpenAI**: Verify API key in Settings
   - **mz-code**: Ensure `mz` is in PATH
2. Try asking a simple question first
3. Settings → switch to different provider

### Installer won't run / SmartScreen warning
- **Expected for unsigned builds** (certificate cost ~$200/year)
- Click "More info" → "Run anyway" (or unblock file in Properties)
- Signed releases won't show this warning

### WebView2 won't install / app crashes on startup
1. Manually download WebView2: https://developer.microsoft.com/microsoft-edge/webview2/
2. Run the standalone installer
3. Restart zro

### Cookies aren't persisting
- This is now FIXED (profile persisted at startup)
- Hard drive space must be free (profile is ~565MB)
- Incognito mode doesn't save cookies (by design)

## Uninstall

### MSI Installer
Settings → Apps → zro → Uninstall (or Control Panel → Programs → Add/Remove Programs)

### NSIS Installer
Windows Start Menu → zro → Uninstall (runs uninstaller)

### Portable Binary
Just delete the .exe file

### Full Clean
1. Uninstall app
2. Delete `%LOCALAPPDATA%\com.zro.browser\` (removes all history, cookies, AI memory)

## Getting Help

- **GitHub Issues**: Report bugs at repo (if public)
- **Dev Mode**: Ctrl+Shift+I to open DevTools (debug URLs, errors, network)
- **Log Viewer**: Browser console (DevTools Console tab) shows real-time events

---

**Current Version:** 0.1.0 (July 2026)  
**Built with:** Tauri v2.11.2 + WebView2 + React  
**License:** MIT
