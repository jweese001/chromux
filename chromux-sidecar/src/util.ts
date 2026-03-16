/**
 * util.ts — Shared helpers
 *
 * Logger, file I/O helpers, Unix socket ownership check, and small
 * utilities used across the chromux modules.
 */

import { type LogLevel } from "./engine.ts";
import * as fs from "fs";
import * as path from "path";

// ─── Logger ──────────────────────────────────────────────────────────────────

/** Minimal structured logger. All output goes to stderr to keep stdout clean. */
export class Logger {
  constructor(private readonly level: LogLevel) {}

  info(msg: string, ...args: unknown[]): void {
    if (this.level === "silent") return;
    console.error(`[chromux] ${msg}`, ...args);
  }

  debug(msg: string, ...args: unknown[]): void {
    if (this.level !== "debug") return;
    console.error(`[chromux:debug] ${msg}`, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    // Errors always print regardless of log level
    console.error(`[chromux:error] ${msg}`, ...args);
  }
}

// ─── State file ──────────────────────────────────────────────────────────────

/** Shape of /tmp/chromux-state.json */
export interface ChromuxState {
  pid: number;
  cdpPort: number;
  cdpUrl: string;       // e.g. ws://127.0.0.1:9222/devtools/browser/<id>
  profileDir: string;
  startedAt: string;    // ISO 8601
  headless: boolean;    // true = no visible window; false = Chrome window visible
}

const STATE_PATH = "/tmp/chromux-state.json";

/**
 * Write the state file atomically with 0600 permissions.
 * Only the owner can read the CDP port / PID.
 */
export function writeStateFile(state: ChromuxState): void {
  const json = JSON.stringify(state, null, 2) + "\n";
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  fs.renameSync(tmp, STATE_PATH);
}

/** Read the state file. Returns null if missing or unparseable. */
export function readStateFile(): ChromuxState | null {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    return JSON.parse(raw) as ChromuxState;
  } catch {
    return null;
  }
}

/** Remove the state file (called on shutdown). */
export function clearStateFile(): void {
  try {
    fs.unlinkSync(STATE_PATH);
  } catch {
    // already gone — fine
  }
}

// ─── Socket ownership check ──────────────────────────────────────────────────

/**
 * Verify that the Unix socket at `socketPath` is owned by the current user.
 *
 * This mirrors cmux's own policy: refuse to connect to sockets owned by
 * other users to prevent fake-socket privilege escalation.
 *
 * @throws {Error} if the socket is missing, not a socket, or owned by another UID
 */
export function assertSocketOwnership(socketPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(socketPath);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Socket not found at ${socketPath}: ${msg}`);
  }

  if (!stat.isSocket()) {
    throw new Error(`Path exists at ${socketPath} but is not a Unix socket`);
  }

  // process.getuid() returns the effective UID of the current process
  const myUid = process.getuid?.() ?? -1;
  if (stat.uid !== myUid) {
    throw new Error(
      `Socket at ${socketPath} is owned by UID ${stat.uid} but running as UID ${myUid} — refusing to connect`
    );
  }
}

// ─── Directory helpers ───────────────────────────────────────────────────────

/** Ensure a directory exists, creating it (and parents) if needed. */
export function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ─── Sleep ───────────────────────────────────────────────────────────────────

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── HTTP GET helper ─────────────────────────────────────────────────────────

/**
 * Simple GET request using the built-in fetch.
 * Returns the parsed JSON body or throws on any error.
 */
export async function httpGetJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

// ─── Process alive check ─────────────────────────────────────────────────────

/**
 * Check whether a process with the given PID is still running.
 * Uses `kill -0` (signal 0 = existence check, no actual signal sent).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/** Join path segments — re-exported so callers don't need to import path. */
export { path };
