# Chromium Engine (CDP Bridge)

**Status**: Complete in `chromux-a` dev build; not yet merged to production.  
**Source**: `chromux-sidecar/` (bundled) · `~/sandbox/chromux/` (dev tree)

---

## Overview

cmux ships an optional Chromium browser engine powered by the [Chrome DevTools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/). When enabled, Google Chrome runs as a sidecar process alongside cmux and exposes the full CDP surface for agent-grade automation, testing, and inspection — without embedding a ~300 MB browser engine into the app bundle.

The Chromium engine is **additive and opt-in**. The default WebKit engine is unchanged.

By default Chrome opens a **visible window** you can interact with directly. You and an agent share the same Chrome instance — same tabs, same DOM, same cookies — making it natural to point at something in the browser and ask the agent to act on it.

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
            src/engine.ts       EngineSettings + state file helpers
            src/util.ts         logging, ChromuxState, port probing

cmux TerminalController
  └─ v2ChromuxPassthrough()     routes browser.engine.* → /tmp/chromux-bridge.sock

State file:  /tmp/chromux-state.json   (pid, cdpPort, cdpUrl, profileDir, startedAt, headless)
Bridge sock: /tmp/chromux-bridge.sock  (line-delimited JSON-RPC, newline-terminated)
Chrome profile: ~/.chromux/profile     (isolated; never touches user's real Chrome)
```

### Startup sequence

1. App launches → `applicationDidFinishLaunching` fires.
2. After 1 s settle, if `browserEngineMode == chromium`, `ChromuxSidecar.start()` runs.
3. `cleanupStaleFiles()`: always `pkill` by `~/.chromux/profile`; also SIGTERMs PID from state file if present. Removes both tmp files.
4. Bun subprocess launches `src/chromux.ts start` from the bundled sidecar directory.
5. `CHROMUX_HEADLESS` env var is set from `browserEngineHeadless` UserDefaults value.
6. `launcher.ts` spawns Chrome with `--remote-debugging-port=0`; omits `--headless=new` unless headless mode is on.
7. CDP port detected via `lsof` + `/json/version` confirmation.
8. `util.ts` writes `/tmp/chromux-state.json` (includes `headless` field).
9. `bridge.ts` starts the Unix socket server.
10. Swift polls for the state file (up to 20 s); on success updates `@Published` sidecar state including `isHeadless`.
11. `applicationDidBecomeActive` serves as a fallback retry if launch-time start failed.

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

## Headless vs Windowed Mode

| Mode | Default | Chrome visible? | Use case |
|---|---|---|---|
| **Windowed** (headless OFF) | ✅ Yes | Yes — real window | Shared human+agent session; point at things in the browser |
| **Headless** (headless ON) | No | No | Pure automation; CI; no GUI needed |

Toggle in Settings: `Settings → Browser → Run Chrome headlessly`

When toggled, the sidecar restarts automatically with the new setting.

### Windowed mode — shared session

With headless off, Chrome opens a visible window you can interact with normally while the agent controls the same Chrome instance via CDP. This makes it natural to say "see that element? fix it" — you're both looking at exactly the same DOM state.

The BrowserPanel in cmux shows a status card (not an embedded browser view) with CDP info and usage hints. Chrome appears as a separate window that you can position next to cmux.

### Headless mode

Chrome runs invisibly. Agents and Playwright/Puppeteer scripts can drive it, but there's no visible window. Use this for CI or pure automation workflows.

---

## Settings Reference

| UserDefaults key | Type | Default | Description |
|---|---|---|---|
| `browserEngineMode` | `String` | `"webkit"` | `"webkit"` or `"chromium"` |
| `browserEngineHeadless` | `Bool` | `false` | `true` = headless, `false` = visible window |

Env var overrides (higher priority than UserDefaults):

| Variable | Values | Description |
|---|---|---|
| `CMUX_BROWSER_ENGINE` | `webkit` \| `chromium` | Override engine mode |
| `CHROMUX_HEADLESS` | `0` \| `1` | Override headless setting |

---

## Requirements

| Dependency | Location | Notes |
|---|---|---|
| Google Chrome | `/Applications/Google Chrome.app` | Any channel (stable/beta/canary) |
| Bun runtime | `~/.bun/bin/bun` | `curl -fsSL https://bun.sh/install \| bash` |

---

## Socket API — `browser.engine.*`

All `browser.engine.*` methods are accepted by the cmux socket in the standard v2 request format:

```json
{"v": 2, "id": 1, "method": "browser.engine.status", "params": {}}
```

From any cmux terminal tab, the `cmux browser` subcommand wraps these for common operations.

### Navigation

| Method | Required params | Description |
|---|---|---|
| `browser.engine.navigate` | `url` | Navigate; responds with `browser.engine.navigated` event |
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
| `browser.engine.get.styles` | `selector` | Computed styles |
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
| `browser.engine.tab.new` | `url?` | Open new tab; returns `{tab: {id, title, url, active}}` |
| `browser.engine.tab.list` | — | All open tabs |
| `browser.engine.tab.switch` | `tab_id` | Activate tab |
| `browser.engine.tab.close` | `tab_id` | Close tab |

> **Note**: `tab.close` requires `tab_id` from `tab.list` or `tab.new`.

### Frames

| Method | Required params | Description |
|---|---|---|
| `browser.engine.frame.list` | — | All frames in current page |
| `browser.engine.frame.main` | — | Switch context back to main frame |

### Storage & cookies

| Method | Notes |
|---|---|
| `browser.engine.cookies.get` | `urls?` — filter by URL |
| `browser.engine.cookies.set` | Standard cookie fields |
| `browser.engine.cookies.clear` | All cookies |
| `browser.engine.storage.get` | `key`, `type` = `local` \| `session` |
| `browser.engine.storage.set` | `key`, `value`, `type?` |
| `browser.engine.storage.clear` | `type?` |

> **Note**: `localStorage` is isolated per origin. Storage operations on `data:` URLs use an opaque origin; use a real URL (e.g. `https://example.com`) for reliable storage tests.

### Network

| Method | Required params | Description |
|---|---|---|
| `browser.engine.network.requests` | — | Captured network requests |
| `browser.engine.network.route` | `pattern`, `response` | Intercept / mock requests |
| `browser.engine.network.unroute` | `pattern` | Remove a route |

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
| `browser.engine.cdp_url` | Current CDP WebSocket URL |
| `browser.engine.targets` | All CDP targets |

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
| `chromux-sidecar/` (repo root) | Bundled copy — synced to repo before building |

Sync from dev tree to repo:

```sh
rsync -av --exclude 'node_modules' --exclude 'tests' --exclude '.git' \
  ~/sandbox/chromux/src/ ~/Documents/Git/chromux/chromux-sidecar/src/
cp ~/sandbox/chromux/package.json ~/sandbox/chromux/bun.lock \
   ~/Documents/Git/chromux/chromux-sidecar/
```

### Running tests

```sh
cd ~/sandbox/chromux
bun test                          # 131 unit + integration tests
node tests/playwright-compat.mjs  # Playwright compat (Node.js required)
```

### Build & launch dev app

```sh
cd ~/Documents/Git/chromux
./scripts/reload.sh --tag chromux-a
```

Dev socket: `/tmp/cmux-debug-chromux-a.sock`  
Dev log: `/tmp/cmux-debug-chromux-a.log`

### Manual bridge test

```sh
echo '{"v":2,"id":1,"method":"browser.engine.status","params":{}}' \
  | nc -U /tmp/cmux-debug-chromux-a.sock -w 5
```

### Diagnostics

```sh
# Sidecar startup log
grep "chromux:" /tmp/cmux-debug-chromux-a.log

# State file
cat /tmp/chromux-state.json

# Chrome process (check for --headless flag)
ps aux | grep "user-data-dir.*chromux" | grep -v "Helper\|grep"
```

Expected startup log sequence:
```
chromux: starting sidecar from <path>
chromux: bun sidecar launched (PID N)
chromux: sidecar ready — Chrome PID N, CDP port N
```

### Key source files

| File | Purpose |
|---|---|
| `Sources/ChromuxSidecar.swift` | Sidecar lifecycle (`BrowserEngineMode`, `BrowserEngineSettings`, `ChromuxSidecar`) |
| `Sources/AppDelegate.swift` | `applicationDidFinishLaunching` → start; `applicationWillTerminate` → stop |
| `Sources/cmuxApp.swift` | Settings UI: engine picker + headless toggle (~line 4047) |
| `Sources/Panels/BrowserPanelView.swift` | `ChromiumBrowserContentView` placeholder; `isChromiumEngineActive` guard |
| `Sources/TerminalController.swift` | `v2ChromuxPassthrough` routes `browser.engine.*` to bridge |
| `chromux-sidecar/src/chromux.ts` | Sidecar entry point |
| `chromux-sidecar/src/bridge.ts` | Unix socket server + full command dispatch |
| `chromux-sidecar/src/actions.ts` | All CDP page actions (700+ lines) |
