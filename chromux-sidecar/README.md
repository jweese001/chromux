# chromux-sidecar

Chromium/CDP bridge sidecar for cmux. Provides a full-featured browser engine
via Chrome DevTools Protocol (CDP) as an alternative to the default WKWebView.

This directory is bundled into the cmux app at build time (under `Resources/chromux-sidecar/`).
`ChromuxSidecar.swift` launches `bun run src/chromux.ts start` from this directory.

## Architecture

```
cmux app ──► ChromuxSidecar.swift ──► bun run src/chromux.ts start
                                          ├─ launches Google Chrome (CDP)
                                          ├─ writes /tmp/chromux-state.json
                                          └─ listens on /tmp/chromux-bridge.sock
```

## Source files

- `src/chromux.ts` — CLI entry point (start/stop/status/screenshot)
- `src/launcher.ts` — Chrome process launcher with CDP port detection
- `src/bridge.ts` — Unix socket server; dispatches `browser.engine.*` commands
- `src/cdp.ts` — Lightweight CDP WebSocket client
- `src/actions.ts` — All page-level CDP actions (click, fill, find, scroll, …)
- `src/engine.ts` — `ChromeProcess` class + state file I/O
- `src/util.ts` — Shared utilities (logging, port probing, etc.)

## Development

Edit files in `~/sandbox/chromux/` (the canonical dev tree), then sync:
```
rsync -av --exclude 'node_modules' --exclude 'tests' --exclude '.git' \
  ~/sandbox/chromux/src/ ~/Documents/Git/cmux/chromux-sidecar/src/
cp ~/sandbox/chromux/package.json ~/sandbox/chromux/bun.lock \
   ~/Documents/Git/cmux/chromux-sidecar/
```
