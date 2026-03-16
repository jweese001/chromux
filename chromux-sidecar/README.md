# chromux-sidecar

Chromium/CDP bridge sidecar for cmux. Provides a full-featured browser engine via Chrome DevTools Protocol (CDP) as an alternative to the default WKWebView.

Bundled into the cmux app at build time (under `Resources/chromux-sidecar/`).  
`ChromuxSidecar.swift` launches `bun run src/chromux.ts start` from this directory.

---

## Architecture

```
cmux app ──► ChromuxSidecar.swift ──► bun run src/chromux.ts start
                                          ├─ spawns Google Chrome (--remote-debugging-port=0)
                                          ├─ writes /tmp/chromux-state.json
                                          └─ listens on /tmp/chromux-bridge.sock

cmux TerminalController
  └─ v2ChromuxPassthrough() ──► /tmp/chromux-bridge.sock ──► CDP ──► Chrome
```

**Runtime files**:

| Path | Contents |
|---|---|
| `/tmp/chromux-state.json` | `{pid, cdpPort, cdpUrl, profileDir, startedAt, headless}` |
| `/tmp/chromux-bridge.sock` | Line-delimited JSON-RPC bridge socket |
| `~/.chromux/profile` | Isolated Chrome profile (never your real Chrome data) |

---

## Source files

| File | Purpose |
|---|---|
| `src/chromux.ts` | CLI entry point (`start` / `stop` / `status` / `screenshot`) |
| `src/launcher.ts` | Chrome process spawn, CDP port detection, `ChromeProcess` class |
| `src/bridge.ts` | Unix socket server; dispatches all `browser.engine.*` commands |
| `src/cdp.ts` | Lightweight CDP WebSocket client |
| `src/actions.ts` | All page-level CDP actions: click, fill, find, scroll, … (700+ lines) |
| `src/engine.ts` | `EngineSettings` interface + `loadSettings()` from env vars |
| `src/util.ts` | `ChromuxState`, `Logger`, state file I/O, port probing |

---

## Settings (env vars consumed by sidecar)

| Variable | Default | Description |
|---|---|---|
| `CHROMUX_HEADLESS` | `0` | `1` = headless, `0` = visible Chrome window |
| `CHROMUX_LOG` | `info` | `silent` \| `info` \| `debug` |
| `CHROMUX_CDP_PORT` | `0` | `0` = OS picks free port |
| `CHROMUX_CHROME_PATH` | (auto-detected) | Override Chrome executable path |
| `CHROMUX_TIMEOUT_MS` | `5000` | CDP startup timeout (ms) |
| `CMUX_SOCKET_PATH` | (auto) | cmux control socket path |

---

## Supported commands (`browser.engine.*`)

75+ methods across: navigation, DOM queries, element finders, interaction, tabs, frames, storage, cookies, network interception, scripts/styles, dialogs, screenshots, console/error capture, emulation.

See [`docs/chromium-engine.md`](../docs/chromium-engine.md) for the full API table.

---

## Development

The canonical dev tree is `~/sandbox/chromux/` — run tests there. This directory is the bundled copy synced from the dev tree before each build.

### Sync dev tree → bundled copy

```sh
rsync -av --exclude 'node_modules' --exclude 'tests' --exclude '.git' \
  ~/sandbox/chromux/src/ ~/Documents/Git/cmux/chromux-sidecar/src/
cp ~/sandbox/chromux/package.json ~/sandbox/chromux/bun.lock \
   ~/Documents/Git/cmux/chromux-sidecar/
```

### Run tests (from dev tree)

```sh
cd ~/sandbox/chromux
bun test                          # 131 unit + integration tests
node tests/playwright-compat.mjs  # Playwright compat (Node.js required, not Bun)
```

### Build app

```sh
cd ~/Documents/Git/cmux
./scripts/reload.sh --tag chromux-a
```
