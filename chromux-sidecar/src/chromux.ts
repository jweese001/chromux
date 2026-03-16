#!/usr/bin/env bun
/**
 * chromux.ts — CLI entry point
 *
 * Commands:
 *   chromux start [--headless]   Launch Chrome + start bridge
 *   chromux stop                 Kill the running Chrome instance
 *   chromux status               Show running/stopped + PID + CDP port
 *   chromux cdp-url              Print the live CDP WebSocket URL
 *   chromux eval <script>        Evaluate JS in Chrome and print result
 *
 * Environment variables (see engine.ts for full list):
 *   CHROMUX_CHROME_PATH    Override Chrome executable path
 *   CHROMUX_CDP_PORT       Override debug port (default: 0 = auto)
 *   CHROMUX_LOG            Log level: silent | info | debug
 *   CHROMUX_TIMEOUT_MS     Chrome launch timeout in ms (default: 5000)
 *   CMUX_SOCKET_PATH       cmux socket path override
 */

import { loadSettings } from "./engine.ts";
import { Logger, readStateFile, clearStateFile, isProcessAlive } from "./util.ts";
import { ChromeProcess } from "./launcher.ts";
import { startBridgeServer } from "./bridge.ts";
import { cdpEval, cdpNavigate, cdpScreenshot, connectToPageTarget } from "./cdp.ts";
import * as fs from "fs";

// ─── Parse argv ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const commandArgs = args.slice(1);

const settings = loadSettings();
const logger = new Logger(settings.logLevel);

// ─── Bridge socket path ───────────────────────────────────────────────────────

/** chromux's own Unix socket — separate from cmux's socket. */
const BRIDGE_SOCKET_PATH = "/tmp/chromux-bridge.sock";

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdStart(): Promise<void> {
  // --headless CLI flag overrides the CHROMUX_HEADLESS env var
  if (commandArgs.includes("--headless")) {
    process.env["CHROMUX_HEADLESS"] = "1";
  }

  // Idempotent: if Chrome is already running, do nothing
  const existing = readStateFile();
  if (existing && isProcessAlive(existing.pid)) {
    logger.info(`Chrome already running (PID ${existing.pid}, port ${existing.cdpPort})`);
    logger.info(`CDP URL: ${existing.cdpUrl}`);
    return;
  }

  // Clear stale state file
  clearStateFile();

  logger.info("Starting Chrome...");

  let chrome: ChromeProcess;
  try {
    chrome = await ChromeProcess.launch(settings, logger);
  } catch (err) {
    logger.error("Failed to launch Chrome:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  logger.info(`Chrome ready — PID ${chrome.pid}, CDP port ${chrome.cdpPort}`);
  logger.info(`CDP URL: ${chrome.cdpUrl}`);
  logger.info(`State file: /tmp/chromux-state.json`);

  // Remove stale bridge socket if it exists
  try { fs.unlinkSync(BRIDGE_SOCKET_PATH); } catch { /* not present */ }

  // Start the bridge server
  let stopBridge: (() => void) | null = null;
  try {
    stopBridge = await startBridgeServer(BRIDGE_SOCKET_PATH, chrome, logger);
    logger.info(`Bridge socket: ${BRIDGE_SOCKET_PATH}`);
  } catch (err) {
    logger.error("Failed to start bridge:", err instanceof Error ? err.message : err);
  }

  // Graceful shutdown on SIGTERM / SIGINT
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal} — shutting down...`);
    stopBridge?.();
    try { fs.unlinkSync(BRIDGE_SOCKET_PATH); } catch { /* ok */ }
    await chrome.shutdown(logger);
    process.exit(0);
  };

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT",  () => { void shutdown("SIGINT");  });

  logger.info("chromux running. Press Ctrl+C to stop.");

  // Keep the process alive (bridge server loop)
  await new Promise<void>(() => { /* intentionally never resolves */ });
}

function cmdStop(): void {
  const state = readStateFile();
  if (!state) {
    console.log("chromux: no running instance found (state file missing)");
    process.exit(0);
  }

  if (!isProcessAlive(state.pid)) {
    console.log(`chromux: process ${state.pid} is not alive — clearing state`);
    clearStateFile();
    process.exit(0);
  }

  logger.info(`Stopping Chrome (PID ${state.pid})...`);
  try {
    process.kill(state.pid, "SIGTERM");
  } catch (err) {
    logger.error(`Failed to send SIGTERM: ${err instanceof Error ? err.message : err}`);
  }

  clearStateFile();

  // Clean up bridge socket
  try { fs.unlinkSync(BRIDGE_SOCKET_PATH); } catch { /* ok */ }

  console.log("chromux: stopped");
}

function cmdStatus(): void {
  const state = readStateFile();

  if (!state) {
    console.log(JSON.stringify({ running: false, reason: "no_state_file" }, null, 2));
    return;
  }

  const alive = isProcessAlive(state.pid);

  const output = {
    running: alive,
    pid: state.pid,
    cdp_port: state.cdpPort,
    cdp_url: state.cdpUrl,
    profile_dir: state.profileDir,
    started_at: state.startedAt,
  };

  console.log(JSON.stringify(output, null, 2));

  if (!alive) {
    logger.info("Note: Chrome process is no longer alive — run `chromux stop` to clean up");
  }
}

function cmdCdpUrl(): void {
  const state = readStateFile();

  if (!state) {
    logger.error("Chrome is not running (no state file)");
    process.exit(1);
  }

  if (!isProcessAlive(state.pid)) {
    logger.error(`Chrome (PID ${state.pid}) is no longer alive`);
    process.exit(1);
  }

  // Print the CDP URL — agents can pipe this directly to Playwright:
  //   const browser = await chromium.connectOverCDP(await $`chromux cdp-url`.text())
  console.log(state.cdpUrl);
}

async function cmdEval(): Promise<void> {
  const script = commandArgs.join(" ").trim();
  if (!script) {
    logger.error("Usage: chromux eval <javascript expression>");
    process.exit(1);
  }

  const state = readStateFile();
  if (!state || !isProcessAlive(state.pid)) {
    logger.error("Chrome is not running. Start it with: chromux start");
    process.exit(1);
  }

  // Must connect to a PAGE target — Runtime.evaluate is not available on the
  // browser-level WebSocket URL (which only supports Target/Browser domains).
  const client = await connectToPageTarget(state.cdpPort, logger).catch((err) => {
    logger.error("Failed to connect to page target:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

  try {
    const result = await cdpEval(client, script);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    logger.error("Eval failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    client.disconnect();
  }
}

async function cmdNavigate(): Promise<void> {
  const url = commandArgs[0];
  if (!url) {
    logger.error("Usage: chromux navigate <url>");
    process.exit(1);
  }

  const state = readStateFile();
  if (!state || !isProcessAlive(state.pid)) {
    logger.error("Chrome is not running. Start it with: chromux start");
    process.exit(1);
  }

  // Page.navigate requires a page-level CDP connection
  const client = await connectToPageTarget(state.cdpPort, logger).catch((err) => {
    logger.error("Failed to connect to page target:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

  try {
    logger.info(`Navigating to ${url}...`);
    await cdpNavigate(client, url);
    console.log(`OK — navigated to ${url}`);
  } catch (err) {
    logger.error("Navigate failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    client.disconnect();
  }
}

async function cmdScreenshot(): Promise<void> {
  // Output path: first arg, or default to ./screenshot.png
  const outPath = commandArgs[0] ?? "screenshot.png";

  const state = readStateFile();
  if (!state || !isProcessAlive(state.pid)) {
    logger.error("Chrome is not running. Start it with: chromux start");
    process.exit(1);
  }

  const client = await connectToPageTarget(state.cdpPort, logger).catch((err) => {
    logger.error("Failed to connect to page target:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

  try {
    logger.info(`Capturing screenshot → ${outPath}`);
    const b64 = await cdpScreenshot(client);

    // Decode base64 → binary buffer → write file
    const buf = Buffer.from(b64, "base64");
    await Bun.write(outPath, buf);

    const kb = (buf.byteLength / 1024).toFixed(1);
    console.log(`OK — screenshot saved to ${outPath} (${kb} KB)`);
  } catch (err) {
    logger.error("Screenshot failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    client.disconnect();
  }
}

function cmdHelp(): void {
  console.log(`
chromux — Chromium/CDP bridge for cmux

Usage:
  chromux start [--headless]   Launch Chrome + start CDP bridge
  chromux stop                 Stop the running Chrome instance
  chromux status               Show status (JSON output)
  chromux cdp-url              Print the live CDP WebSocket URL
  chromux eval <script>        Evaluate JS in Chrome
  chromux navigate <url>       Navigate Chrome to a URL
  chromux screenshot [out.png] Capture screenshot (default: screenshot.png)

Environment:
  CHROMUX_CHROME_PATH    Override Chrome executable path
  CHROMUX_CDP_PORT       Override debug port (default: 0 = auto)
  CHROMUX_LOG            Log level: silent | info | debug
  CHROMUX_TIMEOUT_MS     Launch timeout ms (default: 5000)
  CMUX_SOCKET_PATH       cmux socket path

Agent usage:
  # Get CDP URL for Playwright
  const url = await $\`chromux cdp-url\`.text()
  const browser = await chromium.connectOverCDP(url.trim())

  # Via cmux socket (browser.engine.* namespace)
  cmux browser engine status
  cmux browser engine navigate https://example.com
  cmux browser engine eval "document.title"
`.trim());
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  switch (command) {
    case "start":
      await cmdStart();
      break;

    case "stop":
      cmdStop();
      break;

    case "status":
      cmdStatus();
      break;

    case "cdp-url":
    case "cdp_url":
      cmdCdpUrl();
      break;

    case "eval":
      await cmdEval();
      break;

    case "navigate":
    case "goto":
      await cmdNavigate();
      break;

    case "screenshot":
    case "snap":
      await cmdScreenshot();
      break;

    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;

    default:
      logger.error(`Unknown command: ${command}`);
      cmdHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  logger.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
