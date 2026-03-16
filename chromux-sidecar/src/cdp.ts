/**
 * cdp.ts — Chrome DevTools Protocol (CDP) WebSocket client
 *
 * A minimal, dependency-free CDP client built on Bun's native WebSocket.
 *
 * Features:
 *  - send(method, params) → Promise<result>  (request/response with ID correlation)
 *  - on(event, handler)                      (subscribe to CDP events)
 *  - off(event, handler)                     (unsubscribe)
 *  - disconnect()                            (clean close)
 *
 * This is intentionally thin — it is NOT a Playwright replacement.
 * Its purpose is to let chromux bridge cmux socket commands to Chrome.
 * For full automation, agents should use `connectOverCDP(url)` with Playwright.
 */

import { Logger } from "./util.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A raw CDP command result (the "result" field of the CDP response). */
export type CDPResult = Record<string, unknown>;

/** A CDP event notification from Chrome. */
export interface CDPEvent {
  method: string;
  params: Record<string, unknown>;
}

/** Internal pending request waiting for a response. */
interface PendingRequest {
  resolve: (result: CDPResult) => void;
  reject: (err: Error) => void;
}

/** Shape of a CDP response message. */
interface CDPResponse {
  id?: number;
  result?: CDPResult;
  error?: { code: number; message: string };
  method?: string;            // present for events
  params?: Record<string, unknown>;
}

// ─── CDPClient ───────────────────────────────────────────────────────────────

export class CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;

  /** Map from request ID → pending Promise callbacks. */
  private pending = new Map<number, PendingRequest>();

  /** Map from CDP event method name → set of handlers. */
  private eventHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  private connected = false;

  constructor(private readonly logger: Logger) {}

  /**
   * Open a WebSocket connection to the given CDP URL.
   *
   * `wsUrl` should be the `webSocketDebuggerUrl` from /json/version
   * (the browser-level target), e.g.:
   *   ws://127.0.0.1:9222/devtools/browser/abc123
   */
  async connect(wsUrl: string): Promise<void> {
    if (this.connected) {
      throw new Error("CDPClient already connected");
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.logger.debug(`CDP connected: ${wsUrl}`);
        resolve();
      };

      ws.onerror = (_event) => {
        const msg = `CDP WebSocket error connecting to ${wsUrl}`;
        this.logger.error(msg);
        reject(new Error(msg));
      };

      ws.onclose = (event) => {
        this.connected = false;
        this.logger.debug(`CDP connection closed (code=${event.code})`);

        // Reject all pending requests
        for (const [id, pending] of this.pending) {
          pending.reject(new Error("CDP connection closed"));
          this.pending.delete(id);
        }
      };

      ws.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };
    });
  }

  /** True if the WebSocket is open. */
  get isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Send a CDP command and wait for the response.
   *
   * @param method  CDP method name, e.g. "Page.navigate"
   * @param params  CDP method parameters
   * @returns       The "result" field of the CDP response
   * @throws        CDPError if Chrome returns an error response
   */
  send(method: string, params: Record<string, unknown> = {}): Promise<CDPResult> {
    if (!this.isConnected || this.ws === null) {
      return Promise.reject(new Error("CDPClient is not connected"));
    }

    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });

    this.logger.debug(`CDP → ${method} (id=${id})`);

    return new Promise<CDPResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      try {
        this.ws!.send(message);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Subscribe to a CDP event.
   *
   * @param method   CDP event name, e.g. "Page.loadEventFired"
   * @param handler  Callback invoked with the event's `params` object
   *
   * Most CDP domains require you to call their enable method first:
   *   await client.send("Page.enable")
   *   client.on("Page.loadEventFired", handler)
   */
  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    let handlers = this.eventHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(method, handlers);
    }
    handlers.add(handler);
  }

  /** Unsubscribe a previously registered event handler. */
  off(method: string, handler: (params: Record<string, unknown>) => void): void {
    const handlers = this.eventHandlers.get(method);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.eventHandlers.delete(method);
      }
    }
  }

  /** Close the CDP WebSocket connection cleanly. */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let msg: CDPResponse;
    try {
      msg = JSON.parse(raw) as CDPResponse;
    } catch (err) {
      this.logger.error(`CDP: failed to parse message: ${raw.slice(0, 200)}`);
      return;
    }

    // Event notification (no id, has method)
    if (msg.method && msg.id === undefined) {
      this.logger.debug(`CDP ← event: ${msg.method}`);
      const handlers = this.eventHandlers.get(msg.method);
      if (handlers) {
        const params = msg.params ?? {};
        for (const handler of handlers) {
          try {
            handler(params);
          } catch (err) {
            this.logger.error(`CDP event handler error for ${msg.method}:`, err);
          }
        }
      }
      return;
    }

    // Command response (has id)
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        this.logger.debug(`CDP: received response for unknown id=${msg.id}`);
        return;
      }
      this.pending.delete(msg.id);

      if (msg.error) {
        this.logger.debug(`CDP ← error id=${msg.id}: ${msg.error.message}`);
        pending.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        this.logger.debug(`CDP ← result id=${msg.id}`);
        pending.resolve(msg.result ?? {});
      }
    }
  }
}

// ─── High-level CDP helpers ───────────────────────────────────────────────────

/**
 * Navigate to a URL and wait for the page load event.
 *
 * @param client  Connected CDPClient
 * @param url     URL to navigate to
 * @param timeoutMs  Max wait for load event (default 15 s)
 */
export async function cdpNavigate(
  client: CDPClient,
  url: string,
  timeoutMs = 15_000
): Promise<void> {
  // Enable Page domain so we receive load events
  await client.send("Page.enable");

  // Set up a promise that resolves on the next loadEventFired
  const loadPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("Page.loadEventFired", handler);
      reject(new Error(`Navigation to ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = () => {
      clearTimeout(timer);
      client.off("Page.loadEventFired", handler);
      resolve();
    };

    client.on("Page.loadEventFired", handler);
  });

  // Trigger navigation
  await client.send("Page.navigate", { url });

  // Wait for load
  await loadPromise;
}

/**
 * Evaluate a JavaScript expression in the main frame's context.
 *
 * @param client  Connected CDPClient
 * @param expression  JS to evaluate (should be an expression, not a statement)
 * @returns The serialized result value, or null for undefined/void
 */
export async function cdpEval(
  client: CDPClient,
  expression: string
): Promise<unknown> {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,        // serialize the result as JSON
    awaitPromise: true,         // if expression returns a Promise, await it
    userGesture: true,
  });

  const evalResult = result["result"] as { type?: string; value?: unknown; description?: string } | undefined;

  if (!evalResult) return null;
  if (evalResult.type === "undefined") return null;
  return evalResult.value ?? evalResult.description ?? null;
}

/**
 * Capture a screenshot of the current page.
 *
 * @param client  Connected CDPClient
 * @returns Base64-encoded PNG data
 */
export async function cdpScreenshot(client: CDPClient): Promise<string> {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });

  const data = result["data"] as string | undefined;
  if (typeof data !== "string") {
    throw new Error("CDP screenshot returned no data");
  }
  return data;
}

/**
 * List all open CDP targets in this Chrome instance.
 *
 * Returns the raw /json/list response (each entry has id, type, url, webSocketDebuggerUrl).
 */
export async function cdpListTargets(cdpPort: number): Promise<unknown[]> {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
  return res.json() as Promise<unknown[]>;
}

/**
 * Get the WebSocket debugger URL for the first active page target.
 *
 * This is critical: Runtime.evaluate, Page.navigate, etc. must be sent to a
 * PAGE-level target ws URL (`/devtools/page/<id>`), not the browser-level URL
 * (`/devtools/browser/<id>`). The browser-level URL only supports the Target
 * and Browser CDP domains.
 *
 * @param cdpPort  The Chrome remote debugging port
 * @returns        The page-level WebSocket URL, or null if no page target exists
 */
export async function getPageTargetUrl(cdpPort: number): Promise<string | null> {
  interface CDPTarget {
    type: string;
    webSocketDebuggerUrl?: string;
    url: string;
  }

  const targets = await cdpListTargets(cdpPort) as CDPTarget[];

  // Prefer a real page over special chrome:// or about: pages
  const realPage = targets.find(
    (t) => t.type === "page" && !t.url.startsWith("chrome-extension://") && t.url !== "about:blank"
  );

  // Fall back to any page target (including about:blank on fresh launch)
  const anyPage = targets.find((t) => t.type === "page");

  const target = realPage ?? anyPage;
  return target?.webSocketDebuggerUrl ?? null;
}

/**
 * Get a CDPClient connected to the first page target.
 *
 * Use this instead of connecting to the browser-level URL when you need
 * to run Runtime.evaluate, Page.navigate, Page.captureScreenshot, etc.
 *
 * @param cdpPort  The Chrome remote debugging port
 * @param logger   Logger instance
 * @returns        A connected CDPClient aimed at a page target
 * @throws         If no page target is available
 */
export async function connectToPageTarget(cdpPort: number, logger: Logger): Promise<CDPClient> {
  const pageUrl = await getPageTargetUrl(cdpPort);
  if (!pageUrl) {
    throw new Error(
      "No page target found. Chrome must have at least one open tab. " +
      "This is unexpected — check /json/list output."
    );
  }

  logger.debug(`Connecting CDP to page target: ${pageUrl}`);
  const client = new CDPClient(logger);
  await client.connect(pageUrl);
  return client;
}
