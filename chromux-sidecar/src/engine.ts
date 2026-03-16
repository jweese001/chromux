/**
 * engine.ts — BrowserEngine enum and EngineSettings
 *
 * Defines the two browser engine modes (WebKit vs Chromium) and loads
 * runtime settings from environment variables with sensible defaults.
 */

import { existsSync } from "fs";

// ─── Engine enum ────────────────────────────────────────────────────────────

/** The two supported browser backends in cmux. */
export enum BrowserEngine {
  /** Default: macOS WKWebView (built into cmux). */
  WebKit = "webkit",
  /** Sidecar: full Chrome/Chromium via CDP. */
  Chromium = "chromium",
}

// ─── Log level ──────────────────────────────────────────────────────────────

export type LogLevel = "silent" | "info" | "debug";

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === "silent" || raw === "debug") return raw;
  return "info";
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** Runtime configuration for the Chromium engine. */
export interface EngineSettings {
  /** Absolute path to the Chrome/Chromium executable. */
  chromePath: string;

  /**
   * Port for Chrome's remote debugging protocol.
   * 0 = let the OS pick a free port (recommended).
   */
  cdpPort: number;

  /** Milliseconds to wait for Chrome to expose its CDP endpoint. */
  launchTimeoutMs: number;

  /** Verbosity of chromux log output. */
  logLevel: LogLevel;

  /** Path to the cmux control socket. */
  cmuxSocketPath: string;

  /**
   * Isolated Chrome user-data-dir so chromux never touches the user's
   * real Chrome profile or cookies.
   */
  chromeProfileDir: string;

  /**
   * Run Chrome headlessly (no visible window).
   * false = Chrome opens a real, interactable window alongside cmux.
   * Default: false — visible window so users can point-and-click with agents.
   */
  headless: boolean;
}

/**
 * Canonical macOS paths where Google Chrome is typically installed.
 * Checked in order; first existing path wins.
 */
const CHROME_CANDIDATE_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  `${process.env["HOME"] ?? ""}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
];

/**
 * Resolve the Chrome executable path.
 *
 * Priority:
 *  1. `CHROMUX_CHROME_PATH` env var (explicit override)
 *  2. First path in CHROME_CANDIDATE_PATHS that exists on disk
 *  3. Fallback to the default candidate (will surface a clear error at launch)
 */
export function resolveChromePath(): string {
  const envOverride = process.env["CHROMUX_CHROME_PATH"];
  if (envOverride && envOverride.trim().length > 0) {
    return envOverride.trim();
  }

  for (const candidate of CHROME_CANDIDATE_PATHS) {
    // Bun.file().exists() is synchronous-friendly via Bun.statSync
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // not found — try next
    }
  }

  // Return the most likely path; launcher will emit a clear error if missing
  return CHROME_CANDIDATE_PATHS[0]!;
}

/**
 * Resolve the cmux socket path.
 *
 * Checks CMUX_SOCKET_PATH, then CMUX_SOCKET, then the stable default
 * that cmux writes to Application Support.
 */
function resolveCmuxSocketPath(): string {
  for (const key of ["CMUX_SOCKET_PATH", "CMUX_SOCKET"]) {
    const val = process.env[key]?.trim();
    if (val && val.length > 0) return val;
  }

  // cmux stable socket location (mirrors SocketControlSettings.stableDefaultSocketPath)
  const appSupport =
    process.env["HOME"] != null
      ? `${process.env["HOME"]}/Library/Application Support/cmux/cmux.sock`
      : "/tmp/cmux.sock";

  return appSupport;
}

/**
 * Load EngineSettings from environment variables + defaults.
 * Call once at startup; treat the result as immutable.
 */
export function loadSettings(): EngineSettings {
  const home = process.env["HOME"] ?? "/tmp";

  return {
    chromePath: resolveChromePath(),

    cdpPort: (() => {
      const raw = process.env["CHROMUX_CDP_PORT"];
      const parsed = raw != null ? parseInt(raw, 10) : NaN;
      return isNaN(parsed) ? 0 : parsed;
    })(),

    launchTimeoutMs: (() => {
      const raw = process.env["CHROMUX_TIMEOUT_MS"];
      const parsed = raw != null ? parseInt(raw, 10) : NaN;
      return isNaN(parsed) ? 5000 : parsed;
    })(),

    logLevel: parseLogLevel(process.env["CHROMUX_LOG"]),

    cmuxSocketPath: resolveCmuxSocketPath(),

    chromeProfileDir: `${home}/.chromux/profile`,

    // CHROMUX_HEADLESS=1 → headless. Default: 0 (visible window).
    headless: process.env["CHROMUX_HEADLESS"] === "1",
  };
}
