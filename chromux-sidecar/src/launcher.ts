/**
 * launcher.ts — Chrome process lifecycle management
 *
 * Responsibilities:
 *  1. findChromePath()    — locate the Chrome executable
 *  2. launchChrome()      — spawn Chrome with hardened flags + auto-port
 *  3. detectCDPPort()     — poll /json/version until port is known
 *  4. ChromeProcess       — wrapper with graceful shutdown + crash detection
 */

import { type EngineSettings } from "./engine.ts";
import {
  Logger,
  writeStateFile,
  clearStateFile,
  httpGetJson,
  isProcessAlive,
  mkdirp,
  sleep,
} from "./util.ts";
import * as fs from "fs";
import { spawn, type Subprocess } from "bun";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Information about a successfully launched Chrome instance. */
export interface LaunchResult {
  pid: number;
  cdpPort: number;
  /** Full CDP WebSocket URL for the browser target (not a page target). */
  cdpUrl: string;
}

// ─── CDP version endpoint shape ──────────────────────────────────────────────

interface CDPVersionResponse {
  webSocketDebuggerUrl?: string;
  Browser?: string;
}

// ─── Chrome hardened launch flags ────────────────────────────────────────────

/**
 * Build the argv list for Chrome.
 *
 * Security / stability decisions:
 * - `--remote-debugging-address=127.0.0.1`: CDP never listens on 0.0.0.0
 * - `--remote-debugging-port=0`: OS picks a free port (no conflicts)
 * - Isolated user-data-dir: no cross-contamination with real Chrome profile
 * - Disable telemetry / background services for a clean automation context
 */
function buildChromeArgs(settings: EngineSettings): string[] {
  return [
    // CDP - loopback only, auto port
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${settings.cdpPort}`,

    // Isolated profile — never touch the user's real Chrome data
    `--user-data-dir=${settings.chromeProfileDir}`,

    // Suppress first-run / default-browser noise
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",

    // Disable unnecessary background services (faster launch, less noise)
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-client-side-phishing-detection",
    "--disable-sync",
    "--disable-translate",
    "--disable-extensions",   // no user extensions in automation profile

    // Metrics / crash reporting off
    "--metrics-recording-only",
    "--no-report-upload",

    // Allow Playwright and other CDP clients to connect from any origin.
    // Without this flag, Chrome 94+ rejects WebSocket upgrades with a
    // non-loopback Host header, which breaks Playwright's connectOverCDP().
    // Loopback-only *network binding* is still enforced by --remote-debugging-address.
    "--remote-allow-origins=*",

    // Headless mode (optional — omit for visible window)
    ...(settings.headless ? ["--headless=new"] : []),

    // Start with an empty tab (about:blank) so no network request on open
    "about:blank",
  ];
}

// ─── ChromeProcess ─────────────────────────────────────────────────────────

/**
 * Manages the lifetime of a Chrome subprocess.
 *
 * Usage:
 *   const proc = await ChromeProcess.launch(settings, logger);
 *   console.log(proc.cdpPort);
 *   await proc.shutdown();
 */
export class ChromeProcess {
  private readonly proc: Subprocess;
  private _crashed = false;
  private _shutdownInitiated = false;

  readonly pid: number;
  readonly cdpPort: number;
  readonly cdpUrl: string;

  private constructor(proc: Subprocess, pid: number, cdpPort: number, cdpUrl: string) {
    this.proc = proc;
    this.pid = pid;
    this.cdpPort = cdpPort;
    this.cdpUrl = cdpUrl;

    // Watch for unexpected exit
    proc.exited.then((_code) => {
      if (!this._shutdownInitiated) {
        this._crashed = true;
        clearStateFile();
        // Non-fatal — callers check isCrashed() before next CDP call
      }
    });
  }

  /** True if Chrome exited unexpectedly (not via our shutdown()). */
  get isCrashed(): boolean {
    return this._crashed;
  }

  /** True if the Chrome process is still alive. */
  get isAlive(): boolean {
    return !this._crashed && !this._shutdownInitiated && isProcessAlive(this.pid);
  }

  /**
   * Launch Chrome and wait for the CDP endpoint to become available.
   *
   * @throws {Error} if Chrome cannot be found, fails to start, or the CDP
   *   endpoint is not reachable within `settings.launchTimeoutMs`.
   */
  static async launch(settings: EngineSettings, logger: Logger): Promise<ChromeProcess> {
    // Ensure the profile directory exists before Chrome tries to create it
    mkdirp(settings.chromeProfileDir);

    const args = buildChromeArgs(settings);
    logger.debug("Launching Chrome:", settings.chromePath, args.join(" "));

    // Verify executable exists before spawning
    if (!fs.existsSync(settings.chromePath)) {
      throw new Error(
        `Chrome executable not found at: ${settings.chromePath}\n` +
        `Set CHROMUX_CHROME_PATH to override.`
      );
    }

    // Spawn Chrome — stdio piped so output doesn't leak to the terminal
    const proc = spawn([settings.chromePath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pid = proc.pid;
    logger.info(`Chrome launched (PID ${pid}), detecting CDP port...`);

    // Chrome writes the port to stderr as:
    //   DevTools listening on ws://127.0.0.1:<PORT>/devtools/browser/...
    // We can also discover it via /json/version once Chrome is ready.
    let cdpPort: number;
    let cdpUrl: string;

    try {
      const result = await detectCDPPort(pid, settings.launchTimeoutMs, logger);
      cdpPort = result.port;
      cdpUrl = result.wsUrl;
    } catch (err) {
      // Chrome started but CDP never became available — kill it cleanly
      proc.kill("SIGTERM");
      throw err;
    }

    logger.info(`CDP ready on port ${cdpPort}`);
    logger.debug(`CDP URL: ${cdpUrl}`);

    // Persist state so other processes/agents can find this instance
    writeStateFile({
      pid,
      cdpPort,
      cdpUrl,
      profileDir: settings.chromeProfileDir,
      startedAt: new Date().toISOString(),
      headless: settings.headless,
    });

    return new ChromeProcess(proc, pid, cdpPort, cdpUrl);
  }

  /**
   * Gracefully shut down Chrome.
   *
   * Sends SIGTERM first; if the process is still alive after 2 s, sends SIGKILL.
   */
  async shutdown(logger: Logger): Promise<void> {
    if (this._shutdownInitiated) return;
    this._shutdownInitiated = true;

    logger.info(`Shutting down Chrome (PID ${this.pid})...`);
    clearStateFile();

    if (!isProcessAlive(this.pid)) {
      logger.debug("Chrome already exited");
      return;
    }

    this.proc.kill("SIGTERM");

    // Wait up to 2 s for clean exit
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      await sleep(100);
      if (!isProcessAlive(this.pid)) {
        logger.info("Chrome exited cleanly");
        return;
      }
    }

    // Force kill if still alive
    logger.debug("Chrome did not exit after SIGTERM — sending SIGKILL");
    try { this.proc.kill("SIGKILL"); } catch { /* already gone */ }
    logger.info("Chrome force-killed");
  }
}

// ─── CDP port detection ───────────────────────────────────────────────────────

interface PortDetectResult {
  port: number;
  wsUrl: string;
}

/**
 * Poll Chrome's /json/version HTTP endpoint until it responds or we time out.
 *
 * Chrome writes its actual debug port to stderr in the format:
 *   DevTools listening on ws://127.0.0.1:<PORT>/devtools/browser/<id>
 *
 * We discover the port by trying candidate ports; when --remote-debugging-port=0
 * is used, Chrome writes the actual port to stderr. We read stderr to get it.
 *
 * Strategy:
 *  1. Read Chrome's stderr for the "DevTools listening on ws://" line
 *  2. Parse the port from that line
 *  3. Confirm by hitting /json/version
 *  4. Time out after `timeoutMs`
 */
async function detectCDPPort(
  pid: number,
  timeoutMs: number,
  logger: Logger
): Promise<PortDetectResult> {
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 100;

  // We discover the port by scanning known Chrome debug ports.
  // When --remote-debugging-port=0 is used, Chrome picks a port in the
  // ephemeral range. We probe ports by reading /proc or scanning common ranges.
  //
  // The most reliable cross-platform approach: read Chrome's stderr output
  // which contains "DevTools listening on ws://127.0.0.1:<port>/..."
  //
  // Since Bun's spawn with piped stderr gives us a ReadableStream, we
  // use a parallel approach: scan ports 9000-9999 + 1024-65535 subset
  // while also trying to read the stderr hint.

  // Phase 1: Try to read the port from Chrome's stderr output
  // Chrome prints: "DevTools listening on ws://127.0.0.1:PORT/devtools/browser/ID"
  // We spawn a quick helper to scan /proc/<pid>/net/tcp or use lsof.
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      throw new Error("Chrome process exited before CDP became available");
    }

    // Try to detect port via lsof — works reliably on macOS
    const port = await detectPortViaLsof(pid, logger);
    if (port !== null) {
      // Confirm CDP is actually responding
      const wsUrl = await probeCDPVersion(port, logger);
      if (wsUrl !== null) {
        return { port, wsUrl };
      }
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Chrome CDP endpoint did not become available within ${timeoutMs}ms.\n` +
    `Make sure Chrome is installed at the configured path.`
  );
}

/**
 * Use lsof to find the TCP port Chrome is listening on.
 * Returns the port number, or null if not yet found.
 *
 * This is the most reliable method on macOS for auto-port detection
 * without needing to parse Chrome's stderr stream.
 */
async function detectPortViaLsof(pid: number, logger: Logger): Promise<number | null> {
  try {
    const proc = spawn(
      ["lsof", "-Pan", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    // lsof output format (macOS):
    // COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
    // Google C 1234 user  123u  IPv4 ...  TCP 127.0.0.1:9222 (LISTEN)
    const lines = stdout.split("\n");
    for (const line of lines) {
      // Match "127.0.0.1:PORT (LISTEN)" or "*:PORT (LISTEN)"
      const match = line.match(/:(\d{4,5})\s*\(LISTEN\)/);
      if (match && match[1]) {
        const port = parseInt(match[1], 10);
        if (port > 1023) {
          logger.debug(`lsof detected Chrome listening on port ${port}`);
          return port;
        }
      }
    }
  } catch {
    // lsof not available or failed — fall back gracefully
    logger.debug("lsof port detection failed, retrying...");
  }

  return null;
}

/**
 * Probe Chrome's /json/version HTTP endpoint.
 * Returns the browser WebSocket debugger URL, or null if not ready.
 */
async function probeCDPVersion(port: number, logger: Logger): Promise<string | null> {
  try {
    const url = `http://127.0.0.1:${port}/json/version`;
    const data = await httpGetJson(url) as CDPVersionResponse;

    if (typeof data.webSocketDebuggerUrl === "string") {
      logger.debug(`CDP /json/version OK on port ${port}`);
      return data.webSocketDebuggerUrl;
    }
  } catch {
    // Not ready yet
  }
  return null;
}
