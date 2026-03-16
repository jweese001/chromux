# Chromium Engine (CDP Bridge)

**Status**: Available in `chromux-a` dev build; not yet in production release.  
**Source**: `chromux-sidecar/` (bundled) · `~/sandbox/chromux/` (dev tree)

---

## Overview

cmux ships an optional Chromium browser engine powered by the [Chrome DevTools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/). When enabled, Google Chrome runs as a sidecar process alongside cmux and exposes the full CDP surface for agent-grade automation, testing, and inspection — without embedding a ~300 MB browser engine into the app bundle.

The Chromium engine is **additive and opt-in**. The default WebKit engine is unchanged.

---

## Architecture

```
cmux app
  └─ ChromuxSidecar.swift       starts at app launch (applicationDidFinishLaunching)
       └─ chromux-sidecar/      bundled TypeScript sidecar (app Resources/)
            src/chromux.ts      CLI entry (start / stop / status / screenshot)
            src/launcher.ts     Chrome process lifecycle + CDP port detection
            src/bridge.ts       Unix socket server: /tmp/chromux-bridge.sock
            src/cdp.ts          lightweight CDP WebSocket client
            src/actions.ts      page-level commands (click, fill, find, scroll…)
            src/engine.ts       ChromeProcess class + state file I/O
            src/util.ts         logging, port probing, etc.

cmux TerminalController
  └─ v2ChromuxPassthrough()     routes browser.engine.* → /tmp/chromux-bridge.sock

State file:  /tmp/chromux-state.json   (pid, cdpPort, cdpUrl, profileDir, startedAt)
Bridge sock: /tmp/chromux-bridge.sock  (line-delimited JSON-RPC, newline-terminated)
```

### Startup sequence

1. App launches → `applicationDidFinishLaunching` fires.
2. After 1 s settle, if `browserEngineMode == chromium`, `ChromuxSidecar.start()` runs.
3. `cleanupStaleFiles()` reads `/tmp/chromux-state.json`, SIGTERMs any stale Chrome, removes both tmp files.
4. Bun subprocess launches `src/chromux.ts start` from the bundled sidecar directory.
5. `launcher.ts` spawns Chrome with `--remote-debugging-port=0`, detects the chosen port via `lsof`, confirms via `/json/version`.
6. `engine.ts` writes `/tmp/chromux-state.json`.
7. `bridge.ts` starts the Unix socket server.
8. Swift polls for the state file (up to 20 s); on success updates `@Published` sidecar state.
9. `applicationDidBecomeActive` serves as a fallback retry if launch-time start failed.

---

## Enabling

### Via Settings UI

`cmux Settings → Browser → Browser Engine → Chromium CDP`

### Via `defaults` (scripting / CI)

```sh
defaults write com.cmuxterm.app browserEngineMode chromium
```

### Via environment variable (single launch)

```sh
CMUX_BROWSER_ENGINE=chromium open /Applications/cmux.app
```

> **Note**: `open` with env vars only works for fresh launches; it does not pass env to an already-running app instance. Use `defaults write` for persistent configuration of a running app.

---

## Requirements

| Dependency | Location | Notes |
|---|---|---|
| Google Chrome | `/Applications/Google Chrome.app` | Any channel (stable/beta/canary) |
| Bun runtime | `~/.bun/bin/bun` | `curl -fsSL https://bun.sh/install \| bash` |

Chrome uses an isolated profile at `~/.chromux/profile` — never your real Chrome profile.

---

## Socket API — `browser.engine.*`

All `browser.engine.*` methods are accepted by the cmux socket in the standard v2 request format:

```json
{"v": 2, "id": 1, "method": "browser.engine.status", "params": {}}
```

From any cmux terminal tab, the `cmux browser` subcommand wraps these automatically for common operations.

### Navigation

| Method | Required params | Description |
|---|---|---|
| `browser.engine.navigate` | `url` | Navigate; returns `browser.engine.navigated` event |
| `browser.engine.back` | — | History back |
| `browser.engine.forward` | — | History forward |
| `browser.engine.reload` | — | Reload page |
| `browser.engine.url.get` | — | Current URL |
| `browser.engine.wait` | `selector?` · `url?` · `timeout_ms?` | Wait for condition |

### DOM queries

| Method | Required params | Description |
|---|---|---|
| `browser.engine.get.title` | — | Page title |
| `browser.engine.get.text` | `selector` | Element inner text |
| `browser.engine.get.html` | `selector` | Element innerHTML |
| `browser.engine.get.value` | `selector` | Input / select value |
| `browser.engine.get.attr` | `selector`, `name` | Element attribute |
| `browser.engine.get.count` | `selector` | Number of matching elements |
| `browser.engine.get.box` | `selector` | Bounding rect `{x,y,width,height}` |
| `browser.engine.is.visible` | `selector` | Visibility check |
| `browser.engine.is.enabled` | `selector` | Enabled state |
| `browser.engine.is.checked` | `selector` | Checkbox / radio state |

### Finding elements

All `find.*` methods stamp `data-chromux-ref="<id>"` on the matched element and return `{selector}` for use in subsequent commands.

| Method | Required params |
|---|---|
| `browser.engine.find.text` | `value` |
| `browser.engine.find.role` | `value` |
| `browser.engine.find.label` | `value` |
| `browser.engine.find.placeholder` | `value` |
| `browser.engine.find.alt` | `value` |
| `browser.engine.find.title` | `value` |
| `browser.engine.find.testid` | `value` |
| `browser.engine.find.first` | `value` (CSS selector) |
| `browser.engine.find.last` | `value` |
| `browser.engine.find.nth` | `value`, `nth` |

### Interaction

| Method | Required params | Description |
|---|---|---|
| `browser.engine.click` | `selector` | Left click |
| `browser.engine.dblclick` | `selector` | Double click |
| `browser.engine.hover` | `selector` | Mouse hover |
| `browser.engine.fill` | `selector`, `value` | Clear + type |
| `browser.engine.type` | `selector`, `value` | Append keystrokes |
| `browser.engine.press` | `key` | Key press (e.g. `Enter`, `Tab`) |
| `browser.engine.keydown` | `key` | Key down |
| `browser.engine.keyup` | `key` | Key up |
| `browser.engine.check` | `selector` | Check checkbox |
| `browser.engine.uncheck` | `selector` | Uncheck checkbox |
| `browser.engine.select` | `selector`, `value` | Select `<option>` by value |
| `browser.engine.focus` | `selector` | Focus element |
| `browser.engine.scroll` | `selector?`, `dx?`, `dy?` | Scroll |
| `browser.engine.scroll_into_view` | `selector` | Scroll element into view |
| `browser.engine.highlight` | `selector` | Flash yellow highlight |

### Tabs

| Method | Required params | Description |
|---|---|---|
| `browser.engine.tab.new` | `url?` | Open new tab; returns `{tab}` |
| `browser.engine.tab.list` | — | All open tabs |
| `browser.engine.tab.switch` | `tab_id` | Activate tab |
| `browser.engine.tab.close` | `tab_id` | Close tab |

### Storage & cookies

| Method | Notes |
|---|---|
| `browser.engine.cookies.get` | `urls?` — filter by URL |
| `browser.engine.cookies.set` | Standard cookie fields |
| `browser.engine.cookies.clear` | All cookies |
| `browser.engine.storage.get` | `key`, `type` = `local` \| `session` |
| `browser.engine.storage.set` | `key`, `value`, `type?` |
| `browser.engine.storage.clear` | `type?` |

### Page config & scripts

| Method | Description |
|---|---|
| `browser.engine.viewport.set` | `width`, `height` |
| `browser.engine.offline.set` | `offline` boolean |
| `browser.engine.geolocation.set` | `lat`, `lng`, `accuracy?` |
| `browser.engine.addinitscript` | `script` — run before each page load |
| `browser.engine.addscript` | `script` — inject into current page |
| `browser.engine.addstyle` | `css` — inject stylesheet |

### Capture

| Method | Description |
|---|---|
| `browser.engine.screenshot` | `path?` — save to file, or returns base64 PNG |
| `browser.engine.console.list` | Browser console entries |
| `browser.engine.console.clear` | Clear console log |
| `browser.engine.errors.list` | JS errors + unhandled rejections |
| `browser.engine.errors.clear` | Clear error log |

### Dialogs

| Method | Description |
|---|---|
| `browser.engine.dialog.accept` | `text?` — accept + optional prompt text |
| `browser.engine.dialog.dismiss` | Dismiss dialog |

### Status

| Method | Description |
|---|---|
| `browser.engine.status` | `{running, pid, cdp_port, cdp_url, crashed}` |

---

## Playwright / Puppeteer compatibility

The CDP endpoint is fully compatible with Playwright, Puppeteer, and any tool that speaks CDP:

```js
// Playwright
const { chromium } = require('playwright');
const state = JSON.parse(require('fs').readFileSync('/tmp/chromux-state.json', 'utf8'));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.cdpPort}`);
const page = await browser.contexts()[0].pages()[0];

// Puppeteer
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.connect({
  browserURL: `http://127.0.0.1:${state.cdpPort}`
});
```

> **Important**: Playwright compat tests must run under **Node.js** (`.mjs`), not Bun. Playwright's internal WebSocket client has a known incompatibility with Bun's networking layer.

---

## Development

### Dev tree vs bundled copy

| Path | Purpose |
|---|---|
| `~/sandbox/chromux/` | Development tree — run tests here |
| `chromux-sidecar/` (repo root) | Bundled copy — synced manually |

Sync from dev tree to repo:

```sh
rsync -av --exclude 'node_modules' --exclude 'tests' --exclude '.git' \
  ~/sandbox/chromux/src/ ~/Documents/Git/cmux/chromux-sidecar/src/
cp ~/sandbox/chromux/package.json ~/sandbox/chromux/bun.lock \
   ~/Documents/Git/cmux/chromux-sidecar/
```

### Running tests

```sh
cd ~/sandbox/chromux
bun test                          # 131 unit + integration tests
node tests/playwright-compat.mjs  # Playwright compat (Node.js required)
```

### Build & launch dev app

```sh
cd ~/Documents/Git/cmux
./scripts/reload.sh --tag chromux-a
```

The debug app uses socket `/tmp/cmux-debug-chromux-a.sock`, log `/tmp/cmux-debug-chromux-a.log`.

### Manual bridge test

```sh
echo '{"v":2,"id":1,"method":"browser.engine.status","params":{}}' \
  | nc -U /tmp/cmux-debug-chromux-a.sock -w 5
```

### Key files

| File | Purpose |
|---|---|
| `Sources/ChromuxSidecar.swift` | Sidecar lifecycle (`BrowserEngineMode`, `BrowserEngineSettings`, `ChromuxSidecar`) |
| `Sources/AppDelegate.swift` | `applicationDidFinishLaunching` → start; `applicationWillTerminate` → stop |
| `Sources/cmuxApp.swift` | Settings UI picker (line ~4043) |
| `Sources/Panels/BrowserPanelView.swift` | `ChromiumBrowserContentView` placeholder when engine = chromium |
| `Sources/TerminalController.swift` | `v2ChromuxPassthrough` routes `browser.engine.*` to bridge |
| `chromux-sidecar/src/chromux.ts` | Sidecar entry point |
| `chromux-sidecar/src/bridge.ts` | Unix socket server + command dispatch |
| `chromux-sidecar/src/actions.ts` | All CDP page actions (700+ lines) |
