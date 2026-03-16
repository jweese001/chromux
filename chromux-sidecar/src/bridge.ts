/**
 * bridge.ts — cmux v2 socket bridge
 *
 * Connects to the cmux Unix socket and handles `browser.engine.*` method calls,
 * routing them to CDP commands on the running Chrome instance.
 *
 * Protocol recap (from cmux docs/v2-api-migration.md):
 *   Request:  {"id":"<uuid>","method":"<method>","params":{...}}\n
 *   Response: {"id":"<uuid>","ok":true,"result":{...}}\n
 *   Error:    {"id":"<uuid>","ok":false,"error":{"code":"<code>","message":"<msg>"}}\n
 *
 * This bridge only handles the `browser.engine.*` namespace. All other
 * methods are forwarded to cmux normally via the CLI / existing socket.
 */

import * as net from "net";
import { Logger, assertSocketOwnership } from "./util.ts";
import { CDPClient, cdpNavigate, cdpEval, cdpScreenshot, cdpListTargets, connectToPageTarget } from "./cdp.ts";
import { type ChromeProcess } from "./launcher.ts";
import {
  cdpClick, cdpDblClick, cdpHover, cdpFill, cdpType, cdpPress, cdpKeyDown, cdpKeyUp, cdpScroll,
  cdpGetText, cdpGetHtml, cdpGetValue, cdpGetAttr, cdpGetTitle, cdpGetCount, cdpGetBox, cdpGetStyles,
  cdpIsVisible, cdpIsEnabled, cdpIsChecked, cdpCheck, cdpUncheck, cdpSelect, cdpFocus, cdpHighlight,
  cdpFind, cdpBack, cdpForward, cdpReload, cdpGetUrl, cdpScrollIntoView, cdpWait,
  cdpCookiesGet, cdpCookiesSet, cdpCookiesClear,
  cdpStorageGet, cdpStorageSet, cdpStorageClear,
  cdpNetworkRoute, cdpNetworkUnroute, NetworkLog,
  cdpViewportSet, cdpOfflineSet, cdpGeolocationSet,
  cdpAddInitScript, cdpAddScript, cdpAddStyle,
  ConsoleLog,
  cdpDialogHandle,
  cdpTabList, cdpTabNew, cdpTabClose, cdpTabActivate,
  cdpFrameList,
  type RouteHandler,
} from "./actions.ts";

// ─── Method registry ──────────────────────────────────────────────────────────

/** Methods in the browser.engine.* namespace that this bridge handles. */
const BROWSER_ENGINE_METHODS = new Set([
  // Control
  "browser.engine.start",
  "browser.engine.stop",
  "browser.engine.status",
  "browser.engine.cdp_url",
  "browser.engine.targets",
  // Navigation
  "browser.engine.navigate",
  "browser.engine.back",
  "browser.engine.forward",
  "browser.engine.reload",
  "browser.engine.url.get",
  "browser.engine.wait",
  // Eval + screenshot
  "browser.engine.eval",
  "browser.engine.screenshot",
  // Input
  "browser.engine.click",
  "browser.engine.dblclick",
  "browser.engine.hover",
  "browser.engine.fill",
  "browser.engine.type",
  "browser.engine.press",
  "browser.engine.keydown",
  "browser.engine.keyup",
  "browser.engine.scroll",
  "browser.engine.scroll_into_view",
  "browser.engine.focus",
  "browser.engine.check",
  "browser.engine.uncheck",
  "browser.engine.select",
  "browser.engine.highlight",
  // DOM queries
  "browser.engine.get.text",
  "browser.engine.get.html",
  "browser.engine.get.value",
  "browser.engine.get.attr",
  "browser.engine.get.title",
  "browser.engine.get.count",
  "browser.engine.get.box",
  "browser.engine.get.styles",
  "browser.engine.is.visible",
  "browser.engine.is.enabled",
  "browser.engine.is.checked",
  // Find
  "browser.engine.find.role",
  "browser.engine.find.text",
  "browser.engine.find.label",
  "browser.engine.find.placeholder",
  "browser.engine.find.alt",
  "browser.engine.find.title",
  "browser.engine.find.testid",
  "browser.engine.find.first",
  "browser.engine.find.last",
  "browser.engine.find.nth",
  // Storage / cookies
  "browser.engine.cookies.get",
  "browser.engine.cookies.set",
  "browser.engine.cookies.clear",
  "browser.engine.storage.get",
  "browser.engine.storage.set",
  "browser.engine.storage.clear",
  // Network
  "browser.engine.network.route",
  "browser.engine.network.unroute",
  "browser.engine.network.requests",
  // Console / errors
  "browser.engine.console.list",
  "browser.engine.console.clear",
  "browser.engine.errors.list",
  // Tabs
  "browser.engine.tab.new",
  "browser.engine.tab.list",
  "browser.engine.tab.switch",
  "browser.engine.tab.close",
  // Frames
  "browser.engine.frame.list",
  "browser.engine.frame.main",
  // Page config
  "browser.engine.viewport.set",
  "browser.engine.offline.set",
  "browser.engine.geolocation.set",
  "browser.engine.addinitscript",
  "browser.engine.addscript",
  "browser.engine.addstyle",
  // Dialogs
  "browser.engine.dialog.accept",
  "browser.engine.dialog.dismiss",
]);

// ─── V2 envelope helpers ──────────────────────────────────────────────────────

interface V2Request {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface V2Success {
  id: string | number | undefined;
  ok: true;
  result: Record<string, unknown>;
}

interface V2Error {
  id: string | number | undefined;
  ok: false;
  error: { code: string; message: string };
}

type V2Response = V2Success | V2Error;

function okResponse(id: string | number | undefined, result: Record<string, unknown>): V2Response {
  return { id, ok: true, result };
}

function errResponse(
  id: string | number | undefined,
  code: string,
  message: string
): V2Response {
  return { id, ok: false, error: { code, message } };
}

// ─── CmuxBridge ───────────────────────────────────────────────────────────────

/**
 * CmuxBridge listens on the cmux socket for `browser.engine.*` requests
 * and dispatches them to CDP.
 *
 * It does NOT steal other methods from cmux — it is additive.
 *
 * Usage:
 *   const bridge = new CmuxBridge(socketPath, chromeProcess, logger);
 *   await bridge.start();
 *   // ... later:
 *   bridge.stop();
 */
export class CmuxBridge {
  private client: net.Socket | null = null;
  /** Browser-level CDP client — for Target/Browser domains only. */
  private cdp: CDPClient | null = null;
  /** Whether the bridge loop is active. */
  isRunning = false;

  /** Accumulated bytes from the socket, waiting for a complete newline-terminated JSON line. */
  private buffer = "";

  constructor(
    private readonly socketPath: string,
    private readonly chrome: ChromeProcess,
    private readonly logger: Logger
  ) {}

  /**
   * Connect to the cmux socket and start handling requests.
   * Resolves once connected; rejects if the socket cannot be reached.
   */
  async start(): Promise<void> {
    // Security: verify socket ownership before connecting
    assertSocketOwnership(this.socketPath);

    // Establish CDP connection to Chrome
    this.cdp = new CDPClient(this.logger);
    await this.cdp.connect(this.chrome.cdpUrl);
    this.logger.info(`CDP client connected to ${this.chrome.cdpUrl}`);

    // Connect to cmux socket
    await this.connectToSocket();
    this.isRunning = true;
    this.logger.info(`Bridge active on ${this.socketPath}`);
  }

  /** Disconnect cleanly. */
  stop(): void {
    this.isRunning = false;
    this.cdp?.disconnect();
    this.client?.destroy();
    this.client = null;
    this.logger.info("Bridge stopped");
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private connectToSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      this.client = socket;

      socket.once("connect", () => {
        this.logger.debug(`Connected to cmux socket: ${this.socketPath}`);
        this.attachSocketHandlers(socket);
        resolve();
      });

      socket.once("error", (err) => {
        reject(new Error(`Cannot connect to cmux socket at ${this.socketPath}: ${err.message}`));
      });
    });
  }

  private attachSocketHandlers(socket: net.Socket): void {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");

      // Process complete newline-delimited JSON lines
      let newlineIdx: number;
      while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);

        if (line.length > 0) {
          this.handleLine(line, socket);
        }
      }
    });

    socket.on("close", () => {
      this.logger.debug("cmux socket closed");
      this.isRunning = false;
    });

    socket.on("error", (err) => {
      this.logger.error(`cmux socket error: ${err.message}`);
      this.isRunning = false;
    });
  }

  private handleLine(line: string, socket: net.Socket): void {
    let req: V2Request;

    try {
      req = JSON.parse(line) as V2Request;
    } catch {
      // Not valid JSON — ignore (could be a v1 plain-text response)
      this.logger.debug(`Ignoring non-JSON line: ${line.slice(0, 100)}`);
      return;
    }

    // Only handle our namespace
    if (!BROWSER_ENGINE_METHODS.has(req.method)) {
      this.logger.debug(`Skipping non-engine method: ${req.method}`);
      return;
    }

    this.logger.debug(`Handling ${req.method}`);

    // Dispatch asynchronously and write response
    this.handleEngineMethod(req).then((response) => {
      const payload = JSON.stringify(response) + "\n";
      socket.write(payload);
    }).catch((err) => {
      this.logger.error(`Unhandled error in ${req.method}:`, err);
      const response = errResponse(req.id, "internal_error", String(err));
      socket.write(JSON.stringify(response) + "\n");
    });
  }

  /**
   * Dispatch a `browser.engine.*` method to the appropriate handler.
   * All handlers return a V2Response (never throw — errors are encoded as V2 error envelopes).
   */
  private async handleEngineMethod(req: V2Request): Promise<V2Response> {
    const { id, method, params = {} } = req;

    try {
      switch (method) {
        // ── Status / control ──────────────────────────────────────────────

        case "browser.engine.status":
          return this.handleStatus(id);

        case "browser.engine.cdp_url":
          return this.handleCdpUrl(id);

        case "browser.engine.start":
          // Chrome is already running (bridge wouldn't be active otherwise)
          return okResponse(id, {
            message: "Chrome already running",
            pid: this.chrome.pid,
            cdp_port: this.chrome.cdpPort,
            cdp_url: this.chrome.cdpUrl,
          });

        case "browser.engine.stop":
          return errResponse(
            id,
            "not_supported",
            "Use `chromux stop` from the CLI to stop Chrome"
          );

        case "browser.engine.targets":
          return await this.handleTargets(id);

        // ── Page actions ──────────────────────────────────────────────────

        case "browser.engine.navigate": {
          const url = params["url"] as string | undefined;
          if (!url || typeof url !== "string") {
            return errResponse(id, "invalid_params", "url is required");
          }
          const timeoutMs = (params["timeout_ms"] as number | undefined) ?? 15_000;
          return await this.handleNavigate(id, url, timeoutMs);
        }

        case "browser.engine.eval": {
          const script = params["script"] as string | undefined;
          if (!script || typeof script !== "string") {
            return errResponse(id, "invalid_params", "script is required");
          }
          return await this.handleEval(id, script);
        }

        case "browser.engine.screenshot":
          return await this.handleScreenshot(id);

        default:
          return errResponse(id, "not_found", `Unknown method: ${method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`CDP error in ${method}: ${message}`);
      return errResponse(id, "cdp_error", message);
    }
  }

  // ── Method handlers ────────────────────────────────────────────────────────

  private handleStatus(id: string | number | undefined): V2Response {
    const alive = this.chrome.isAlive;

    return okResponse(id, {
      running: alive,
      pid: alive ? this.chrome.pid : null,
      cdp_port: alive ? this.chrome.cdpPort : null,
      cdp_url: alive ? this.chrome.cdpUrl : null,
      crashed: this.chrome.isCrashed,
    });
  }

  private handleCdpUrl(id: string | number | undefined): V2Response {
    if (!this.chrome.isAlive) {
      return errResponse(id, "not_running", "Chrome is not running");
    }
    return okResponse(id, { cdp_url: this.chrome.cdpUrl });
  }

  private async handleTargets(id: string | number | undefined): Promise<V2Response> {
    if (!this.chrome.isAlive) {
      return errResponse(id, "not_running", "Chrome is not running");
    }
    const targets = await cdpListTargets(this.chrome.cdpPort);
    return okResponse(id, { targets });
  }

  /**
   * Get a short-lived page-level CDP client.
   *
   * Page actions (navigate, eval, screenshot) must run on a page target URL,
   * not the browser-level URL. We create and destroy a fresh client per call
   * so we always have a valid connection after navigations change the target.
   */
  private async withPageClient<T>(
    id: string | number | undefined,
    action: (client: CDPClient) => Promise<T>
  ): Promise<V2Response> {
    if (!this.chrome.isAlive) {
      return errResponse(id, "not_running", "Chrome is not running");
    }
    const pageClient = await connectToPageTarget(this.chrome.cdpPort, this.logger);
    try {
      const result = await action(pageClient);
      return okResponse(id, result as Record<string, unknown>);
    } finally {
      pageClient.disconnect();
    }
  }

  private async handleNavigate(
    id: string | number | undefined,
    url: string,
    timeoutMs: number
  ): Promise<V2Response> {
    return this.withPageClient(id, async (client) => {
      await cdpNavigate(client, url, timeoutMs);
      return { url, loaded: true };
    });
  }

  private async handleEval(
    id: string | number | undefined,
    script: string
  ): Promise<V2Response> {
    return this.withPageClient(id, async (client) => {
      const value = await cdpEval(client, script);
      return { result: value ?? null };
    });
  }

  private async handleScreenshot(id: string | number | undefined): Promise<V2Response> {
    return this.withPageClient(id, async (client) => {
      const data = await cdpScreenshot(client);
      return { data, format: "png", encoding: "base64" };
    });
  }
}

// ─── Event streaming ──────────────────────────────────────────────────────────

/**
 * V2 event push — unsolicited notification sent to all connected bridge clients.
 *
 * Format (no `id` field — this is a push, not a response):
 *   {"event":"browser.engine.navigated","data":{"url":"...","title":"..."}}

 *
 * Agents detect these by the presence of the `event` key (no `ok` field).
 */
interface V2Event {
  event: string;
  data: Record<string, unknown>;
}

/**
 * PageEventWatcher — subscribes to CDP page events on the current page target
 * and broadcasts them to all connected bridge clients.
 *
 * Handles reconnection: when a navigation changes the page target's WebSocket
 * (common with cross-origin navigations and some SPAs), it reconnects.
 *
 * Events emitted:
 *   browser.engine.navigated   — main-frame URL changed
 *   browser.engine.title       — document.title changed
 *   browser.engine.crashed     — Chrome process died unexpectedly
 */
class PageEventWatcher {
  private pageClient: CDPClient | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly chrome: ChromeProcess,
    private readonly broadcast: (event: V2Event) => void,
    private readonly logger: Logger,
  ) {}

  /** Start watching. Returns immediately; watching runs in the background. */
  start(): void {
    void this.connectLoop();
  }

  /** Stop watching and disconnect. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pageClient?.disconnect();
    this.pageClient = null;
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped && this.chrome.isAlive) {
      try {
        await this.connectAndWatch();
      } catch (err) {
        if (this.stopped) break;
        this.logger.debug(
          `PageEventWatcher reconnecting: ${err instanceof Error ? err.message : err}`
        );
        await new Promise<void>((r) => {
          this.reconnectTimer = setTimeout(r, 1000);
        });
        this.reconnectTimer = null;
      }
    }

    // Chrome died unexpectedly
    if (!this.chrome.isAlive && !this.stopped) {
      this.broadcast({
        event: "browser.engine.crashed",
        data: { reason: "Chrome process exited unexpectedly" },
      });
    }
  }

  private async connectAndWatch(): Promise<void> {
    if (this.stopped) return;

    const { getPageTargetUrl } = await import("./cdp.ts");
    const pageUrl = await getPageTargetUrl(this.chrome.cdpPort);
    if (!pageUrl) {
      await new Promise<void>((r) => setTimeout(r, 500));
      return;
    }

    const client = new CDPClient(this.logger);
    this.pageClient = client;
    await client.connect(pageUrl);
    this.logger.debug("PageEventWatcher: connected to page target");

    // Enable Page domain events
    await client.send("Page.enable");

    let lastUrl = "";
    let lastTitle = "";

    // Main-frame navigation committed
    client.on("Page.frameNavigated", (params) => {
      const frame = params["frame"] as { url?: string; name?: string } | undefined;
      if (!frame) return;
      // Skip sub-frames (main frame has empty name)
      if (frame.name !== "" && frame.name !== undefined) return;
      const url = frame.url ?? "";
      if (url === lastUrl) return;
      lastUrl = url;
      this.logger.debug(`PageEventWatcher: navigated → ${url}`);
      this.broadcast({ event: "browser.engine.navigated", data: { url, title: lastTitle } });
    });

    // document.title changed
    client.on("Page.titleUpdated", (params) => {
      const title = (params["title"] as string | undefined) ?? "";
      if (title === lastTitle) return;
      lastTitle = title;
      this.logger.debug(`PageEventWatcher: title → "${title}"`);
      this.broadcast({ event: "browser.engine.title", data: { title, url: lastUrl } });
    });

    // Wait until disconnected or stopped
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (this.stopped || !client.isConnected || !this.chrome.isAlive) {
          clearInterval(poll);
          resolve();
        }
      }, 250);
    });

    client.disconnect();
    this.pageClient = null;
    this.logger.debug("PageEventWatcher: page client disconnected, will reconnect");
  }
}

// ─── Standalone bridge server ─────────────────────────────────────────────────

/**
 * Start a bridge that relays `browser.engine.*` commands from a Unix socket
 * to an already-running Chrome instance, and streams page lifecycle events
 * (navigation, title changes, crashes) to all connected clients as push lines.
 *
 * Protocol:
 *   Request/Response: standard v2 JSON lines with id/ok fields
 *   Push events:      {"event":"browser.engine.navigated","data":{...}}\n
 *                     Agents detect these by presence of "event" key (no "ok").
 *
 * @param socketPath  Path to chromux's own Unix socket (separate from cmux's)
 * @param chrome      Running Chrome process handle
 * @param logger      Logger instance
 */
export async function startBridgeServer(
  socketPath: string,
  chrome: ChromeProcess,
  logger: Logger
): Promise<() => void> {
  // Browser-level CDP for status/targets queries (no page context needed)
  const cdp = new CDPClient(logger);
  await cdp.connect(chrome.cdpUrl);
  logger.info("CDP client connected for bridge server");

  // Track all connected clients so we can broadcast push events
  const clients = new Set<net.Socket>();

  function broadcast(event: V2Event): void {
    const line = JSON.stringify(event) + "\n";
    for (const sock of clients) {
      if (!sock.destroyed) sock.write(line);
    }
  }

  // Start page lifecycle event watcher
  const watcher = new PageEventWatcher(chrome, broadcast, logger);
  watcher.start();

  // Shared session state for all connected clients
  const state = createSessionState();

  const server = net.createServer((socket) => {
    logger.debug("Bridge server: new client connected");
    clients.add(socket);
    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIdx: number;

      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (line.length === 0) continue;

        let req: V2Request;
        try {
          req = JSON.parse(line) as V2Request;
        } catch {
          continue;
        }

        if (!BROWSER_ENGINE_METHODS.has(req.method)) {
          const res = errResponse(req.id, "not_handled", `Method ${req.method} is not in browser.engine namespace`);
          socket.write(JSON.stringify(res) + "\n");
          continue;
        }

        dispatchEngineMethod(req, cdp, chrome, logger, state).then((response) => {
          socket.write(JSON.stringify(response) + "\n");
        }).catch((err) => {
          const res = errResponse(req.id, "internal_error", String(err));
          socket.write(JSON.stringify(res) + "\n");
        });
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
      logger.debug("Bridge server: client disconnected");
    });

    socket.on("error", (err) => {
      clients.delete(socket);
      logger.debug(`Bridge client socket error: ${err.message}`);
    });
  });

  server.listen(socketPath, () => {
    logger.info(`Bridge server listening at ${socketPath}`);
  });

  return () => {
    watcher.stop();
    cdp.disconnect();
    for (const sock of clients) {
      try { sock.destroy(); } catch { /* ok */ }
    }
    clients.clear();
    server.close();
    logger.info("Bridge server stopped");
  };
}

// ─── Per-session state ────────────────────────────────────────────────────────

/**
 * Mutable state that persists across multiple method calls within a Chrome session.
 * Created once per `startBridgeServer()` call and shared across all socket clients.
 */
interface BridgeSessionState {
  /** Per-target console logs, keyed by page target websocket URL */
  consoleLogs: Map<string, ConsoleLog>;
  /** Per-target network logs */
  networkLogs: Map<string, NetworkLog>;
  /** Active route handlers: pattern → handler */
  routeHandlers: Map<string, RouteHandler>;
  /** Currently selected frame context id (null = main frame) */
  selectedFrameContextId: number | null;
}

function createSessionState(): BridgeSessionState {
  return {
    consoleLogs: new Map(),
    networkLogs: new Map(),
    routeHandlers: new Map(),
    selectedFrameContextId: null,
  };
}

/**
 * Get or create a ConsoleLog for the current page target.
 * Starts listening on first access.
 */
async function getConsoleLog(
  client: CDPClient,
  targetUrl: string,
  state: BridgeSessionState
): Promise<ConsoleLog> {
  let log = state.consoleLogs.get(targetUrl);
  if (!log) {
    log = new ConsoleLog(client);
    await log.start();
    state.consoleLogs.set(targetUrl, log);
  }
  return log;
}

/**
 * Get or create a NetworkLog for the current page target.
 */
async function getNetworkLog(
  client: CDPClient,
  targetUrl: string,
  state: BridgeSessionState
): Promise<NetworkLog> {
  let log = state.networkLogs.get(targetUrl);
  if (!log) {
    log = new NetworkLog(client);
    await log.start();
    state.networkLogs.set(targetUrl, log);
  }
  return log;
}

/**
 * Dispatch a single engine method, shared between CmuxBridge and the
 * standalone bridge server.
 */
async function dispatchEngineMethod(
  req: V2Request,
  _cdp: CDPClient,
  chrome: ChromeProcess,
  logger: Logger,
  state: BridgeSessionState
): Promise<V2Response> {
  const { id, method, params = {} } = req;

  // Helper: run an action on a fresh page-level client, then disconnect
  async function withPage<T>(action: (client: CDPClient, targetUrl: string) => Promise<T>): Promise<T> {
    const { getPageTargetUrl } = await import("./cdp.ts");
    const targetUrl = await getPageTargetUrl(chrome.cdpPort);
    if (!targetUrl) throw new Error("No page target found");
    const client = new CDPClient(logger);
    await client.connect(targetUrl);
    try {
      return await action(client, targetUrl);
    } finally {
      client.disconnect();
    }
  }

  // Helper: require a string param or return an error response
  function requireString(key: string): string | V2Response {
    const v = params[key];
    if (typeof v !== "string" || !v) return errResponse(id, "invalid_params", `${key} is required`);
    return v;
  }

  try {
    switch (method) {

      // ── Control ────────────────────────────────────────────────────────────

      case "browser.engine.status":
        return okResponse(id, {
          running: chrome.isAlive,
          pid: chrome.pid,
          cdp_port: chrome.cdpPort,
          cdp_url: chrome.cdpUrl,
          crashed: chrome.isCrashed,
        });

      case "browser.engine.cdp_url":
        if (!chrome.isAlive) return errResponse(id, "not_running", "Chrome is not running");
        return okResponse(id, { cdp_url: chrome.cdpUrl });

      case "browser.engine.targets": {
        const targets = await cdpListTargets(chrome.cdpPort);
        return okResponse(id, { targets });
      }

      case "browser.engine.start":
        return okResponse(id, { message: "Chrome already running", pid: chrome.pid });

      case "browser.engine.stop":
        return errResponse(id, "not_supported", "Use `chromux stop` CLI to stop Chrome");

      // ── Navigation ─────────────────────────────────────────────────────────

      case "browser.engine.navigate": {
        const url = requireString("url");
        if (typeof url !== "string") return url;
        const ms = (params["timeout_ms"] as number | undefined) ?? 15_000;
        await withPage(async (client) => {
          await cdpNavigate(client, url, ms);
        });
        return okResponse(id, { url, loaded: true });
      }

      case "browser.engine.back":
        await withPage(async (client) => { await cdpBack(client); });
        return okResponse(id, { ok: true });

      case "browser.engine.forward":
        await withPage(async (client) => { await cdpForward(client); });
        return okResponse(id, { ok: true });

      case "browser.engine.reload": {
        const ignoreCache = (params["ignore_cache"] as boolean | undefined) ?? false;
        await withPage(async (client) => { await cdpReload(client, ignoreCache); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.url.get": {
        const url = await withPage(async (client) => cdpGetUrl(client));
        return okResponse(id, { url });
      }

      case "browser.engine.wait": {
        const type = (params["type"] as "selector" | "url" | undefined) ?? "selector";
        const value = requireString("value");
        if (typeof value !== "string") return value;
        const ms = (params["timeout_ms"] as number | undefined) ?? 10_000;
        await withPage(async (client) => { await cdpWait(client, type, value, ms); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.scroll_into_view": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        await withPage(async (client) => { await cdpScrollIntoView(client, selector); });
        return okResponse(id, { ok: true });
      }

      // ── Eval + screenshot ──────────────────────────────────────────────────

      case "browser.engine.eval": {
        const script = requireString("script");
        if (typeof script !== "string") return script;
        const value = await withPage(async (client) => cdpEval(client, script));
        return okResponse(id, { result: value ?? null } as Record<string, unknown>);
      }

      case "browser.engine.screenshot": {
        const data = await withPage(async (client) => cdpScreenshot(client));
        return okResponse(id, { data, format: "png", encoding: "base64" });
      }

      // ── Input ──────────────────────────────────────────────────────────────

      case "browser.engine.click": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const button = (params["button"] as "left" | "right" | "middle" | undefined) ?? "left";
        await withPage(async (client) => { await cdpClick(client, selector, button); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.dblclick": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        await withPage(async (client) => { await cdpDblClick(client, selector); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.hover": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        await withPage(async (client) => { await cdpHover(client, selector); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.fill": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const value = (params["value"] as string | undefined) ?? "";
        await withPage(async (client) => { await cdpFill(client, selector, value); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.type": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const text = (params["text"] as string | undefined) ?? "";
        await withPage(async (client) => { await cdpType(client, selector, text); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.press": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const key = requireString("key");
        if (typeof key !== "string") return key;
        await withPage(async (client) => { await cdpPress(client, selector, key); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.keydown": {
        const key = requireString("key");
        if (typeof key !== "string") return key;
        const modifiers = (params["modifiers"] as number | undefined) ?? 0;
        await withPage(async (client) => { await cdpKeyDown(client, key, modifiers); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.keyup": {
        const key = requireString("key");
        if (typeof key !== "string") return key;
        const modifiers = (params["modifiers"] as number | undefined) ?? 0;
        await withPage(async (client) => { await cdpKeyUp(client, key, modifiers); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.scroll": {
        const selector = (params["selector"] as string | undefined) ?? null;
        const deltaX = (params["delta_x"] as number | undefined) ?? 0;
        const deltaY = (params["delta_y"] as number | undefined) ?? 0;
        await withPage(async (client) => { await cdpScroll(client, selector, deltaX, deltaY); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.focus": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        await withPage(async (client) => { await cdpFocus(client, selector); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.check": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        await withPage(async (client) => { await cdpCheck(client, selector); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.uncheck": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        await withPage(async (client) => { await cdpUncheck(client, selector); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.select": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const value = requireString("value");
        if (typeof value !== "string") return value;
        await withPage(async (client) => { await cdpSelect(client, selector, value); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.highlight": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const color = (params["color"] as string | undefined);
        await withPage(async (client) => { await cdpHighlight(client, selector, color); });
        return okResponse(id, { ok: true });
      }

      // ── DOM queries ────────────────────────────────────────────────────────

      case "browser.engine.get.text": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const text = await withPage(async (client) => cdpGetText(client, selector));
        return okResponse(id, { text });
      }

      case "browser.engine.get.html": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const html = await withPage(async (client) => cdpGetHtml(client, selector));
        return okResponse(id, { html });
      }

      case "browser.engine.get.value": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const value = await withPage(async (client) => cdpGetValue(client, selector));
        return okResponse(id, { value });
      }

      case "browser.engine.get.attr": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const attr = requireString("attr");
        if (typeof attr !== "string") return attr;
        const value = await withPage(async (client) => cdpGetAttr(client, selector, attr));
        return okResponse(id, { value });
      }

      case "browser.engine.get.title": {
        const title = await withPage(async (client) => cdpGetTitle(client));
        return okResponse(id, { title });
      }

      case "browser.engine.get.count": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const count = await withPage(async (client) => cdpGetCount(client, selector));
        return okResponse(id, { count });
      }

      case "browser.engine.get.box": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const box = await withPage(async (client) => cdpGetBox(client, selector));
        return okResponse(id, { box });
      }

      case "browser.engine.get.styles": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const styles = await withPage(async (client) => cdpGetStyles(client, selector));
        return okResponse(id, { styles });
      }

      case "browser.engine.is.visible": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const visible = await withPage(async (client) => cdpIsVisible(client, selector));
        return okResponse(id, { visible });
      }

      case "browser.engine.is.enabled": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const enabled = await withPage(async (client) => cdpIsEnabled(client, selector));
        return okResponse(id, { enabled });
      }

      case "browser.engine.is.checked": {
        const selector = requireString("selector");
        if (typeof selector !== "string") return selector;
        const checked = await withPage(async (client) => cdpIsChecked(client, selector));
        return okResponse(id, { checked });
      }

      // ── Find ───────────────────────────────────────────────────────────────

      case "browser.engine.find.role":
      case "browser.engine.find.text":
      case "browser.engine.find.label":
      case "browser.engine.find.placeholder":
      case "browser.engine.find.alt":
      case "browser.engine.find.title":
      case "browser.engine.find.testid":
      case "browser.engine.find.first":
      case "browser.engine.find.last":
      case "browser.engine.find.nth": {
        const strategy = method.replace("browser.engine.find.", "");
        const value = requireString("value");
        if (typeof value !== "string") return value;
        const nth = (params["nth"] as number | undefined) ??
          (strategy === "last" ? -1 : 0);
        const selector = await withPage(async (client) =>
          cdpFind(client, strategy, value, nth < 0 ? undefined : nth)
        );
        if (!selector) return errResponse(id, "not_found", `No element found: ${strategy}="${value}"`);
        return okResponse(id, { selector });
      }

      // ── Storage / cookies ──────────────────────────────────────────────────

      case "browser.engine.cookies.get": {
        const urls = params["urls"] as string[] | undefined;
        const cookies = await withPage(async (client) => cdpCookiesGet(client, urls));
        return okResponse(id, { cookies });
      }

      case "browser.engine.cookies.set": {
        const name = requireString("name");
        if (typeof name !== "string") return name;
        const value = requireString("value");
        if (typeof value !== "string") return value;
        const domain = params["domain"] as string | undefined;
        const path = params["path"] as string | undefined;
        await withPage(async (client) => cdpCookiesSet(client, {
          name,
          value,
          ...(domain !== undefined && { domain }),
          ...(path !== undefined && { path }),
        }));
        return okResponse(id, { ok: true });
      }

      case "browser.engine.cookies.clear": {
        const name = params["name"] as string | undefined;
        const url = params["url"] as string | undefined;
        await withPage(async (client) => cdpCookiesClear(client, name, url));
        return okResponse(id, { ok: true });
      }

      case "browser.engine.storage.get": {
        const key = requireString("key");
        if (typeof key !== "string") return key;
        const storageType = (params["type"] as "local" | "session" | undefined) ?? "local";
        const value = await withPage(async (client) => cdpStorageGet(client, key, storageType));
        return okResponse(id, { value });
      }

      case "browser.engine.storage.set": {
        const key = requireString("key");
        if (typeof key !== "string") return key;
        const value = requireString("value");
        if (typeof value !== "string") return value;
        const storageType = (params["type"] as "local" | "session" | undefined) ?? "local";
        await withPage(async (client) => cdpStorageSet(client, key, value, storageType));
        return okResponse(id, { ok: true });
      }

      case "browser.engine.storage.clear": {
        const storageType = (params["type"] as "local" | "session" | undefined) ?? "local";
        await withPage(async (client) => cdpStorageClear(client, storageType));
        return okResponse(id, { ok: true });
      }

      // ── Network ────────────────────────────────────────────────────────────

      case "browser.engine.network.route": {
        const pattern = requireString("pattern");
        if (typeof pattern !== "string") return pattern;
        const response = (params["response"] as RouteHandler["response"] | undefined) ?? { status: 200 };
        await withPage(async (client) => {
          await cdpNetworkRoute(client, pattern, response);
        });
        state.routeHandlers.set(pattern, { pattern, response });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.network.unroute": {
        const pattern = params["pattern"] as string | undefined;
        await withPage(async (client) => { await cdpNetworkUnroute(client); });
        if (pattern) state.routeHandlers.delete(pattern);
        else state.routeHandlers.clear();
        return okResponse(id, { ok: true });
      }

      case "browser.engine.network.requests": {
        const requests = await withPage(async (client, targetUrl) => {
          const log = await getNetworkLog(client, targetUrl, state);
          return log.requests;
        });
        return okResponse(id, { requests });
      }

      // ── Console / errors ───────────────────────────────────────────────────

      case "browser.engine.console.list": {
        const entries = await withPage(async (client, targetUrl) => {
          const log = await getConsoleLog(client, targetUrl, state);
          return log.entries;
        });
        return okResponse(id, { entries });
      }

      case "browser.engine.console.clear": {
        await withPage(async (_client, targetUrl) => {
          const log = state.consoleLogs.get(targetUrl);
          if (log) log.clear();
        });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.errors.list": {
        const errors = await withPage(async (client, targetUrl) => {
          const log = await getConsoleLog(client, targetUrl, state);
          return log.errors;
        });
        return okResponse(id, { errors });
      }

      // ── Tabs ───────────────────────────────────────────────────────────────

      case "browser.engine.tab.list": {
        const tabs = await cdpTabList(chrome.cdpPort);
        return okResponse(id, { tabs });
      }

      case "browser.engine.tab.new": {
        const url = (params["url"] as string | undefined) ?? "about:blank";
        const tab = await cdpTabNew(chrome.cdpPort, url);
        return okResponse(id, { tab });
      }

      case "browser.engine.tab.switch": {
        const tabId = requireString("tab_id");
        if (typeof tabId !== "string") return tabId;
        await cdpTabActivate(chrome.cdpPort, tabId);
        return okResponse(id, { ok: true });
      }

      case "browser.engine.tab.close": {
        const tabId = requireString("tab_id");
        if (typeof tabId !== "string") return tabId;
        await cdpTabClose(chrome.cdpPort, tabId);
        return okResponse(id, { ok: true });
      }

      // ── Frames ─────────────────────────────────────────────────────────────

      case "browser.engine.frame.list": {
        const frames = await withPage(async (client) => cdpFrameList(client));
        return okResponse(id, { frames });
      }

      case "browser.engine.frame.main":
        state.selectedFrameContextId = null;
        return okResponse(id, { ok: true as const });

      // ── Page config ────────────────────────────────────────────────────────

      case "browser.engine.viewport.set": {
        const width = (params["width"] as number | undefined) ?? 1280;
        const height = (params["height"] as number | undefined) ?? 800;
        const scale = (params["device_scale_factor"] as number | undefined) ?? 1;
        await withPage(async (client) => { await cdpViewportSet(client, width, height, scale); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.offline.set": {
        const offline = (params["offline"] as boolean | undefined) ?? false;
        await withPage(async (client) => { await cdpOfflineSet(client, offline); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.geolocation.set": {
        const latitude = (params["latitude"] as number | undefined) ?? 0;
        const longitude = (params["longitude"] as number | undefined) ?? 0;
        const accuracy = (params["accuracy"] as number | undefined) ?? 1;
        await withPage(async (client) => { await cdpGeolocationSet(client, latitude, longitude, accuracy); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.addinitscript": {
        const source = requireString("source");
        if (typeof source !== "string") return source;
        const scriptId = await withPage(async (client) => cdpAddInitScript(client, source));
        return okResponse(id, { script_id: scriptId });
      }

      case "browser.engine.addscript": {
        const source = requireString("source");
        if (typeof source !== "string") return source;
        await withPage(async (client) => { await cdpAddScript(client, source); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.addstyle": {
        const css = requireString("css");
        if (typeof css !== "string") return css;
        await withPage(async (client) => { await cdpAddStyle(client, css); });
        return okResponse(id, { ok: true });
      }

      // ── Dialogs ────────────────────────────────────────────────────────────

      case "browser.engine.dialog.accept": {
        const promptText = (params["prompt_text"] as string | undefined) ?? "";
        await withPage(async (client) => { await cdpDialogHandle(client, true, promptText); });
        return okResponse(id, { ok: true });
      }

      case "browser.engine.dialog.dismiss":
        await withPage(async (client) => { await cdpDialogHandle(client, false); });
        return okResponse(id, { ok: true });

      default:
        return errResponse(id, "not_handled", `Method ${method} is not handled`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Engine method ${method} failed: ${message}`);
    return errResponse(id, "cdp_error", message);
  }
}
