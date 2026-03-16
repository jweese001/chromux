/**
 * actions.ts — High-level CDP page actions
 *
 * All functions take a connected page-level CDPClient and perform a single
 * browser automation action. They are intentionally thin wrappers over raw
 * CDP — no Playwright, no extra dependencies.
 *
 * Organisation:
 *   Input:    click, dblclick, hover, fill, type, press, keydown, keyup, scroll
 *   DOM:      querySelector helpers, get.*, is.*, check/uncheck, select, focus, highlight
 *   Find:     find.role, find.text, find.label, find.placeholder, find.alt,
 *             find.title, find.testid, find.first, find.last, find.nth
 *   Nav:      back, forward, reload, url.get, wait, scroll_into_view
 *   Network:  route/unroute/requests, cookies, storage, offline
 *   Page:     viewport.set, addinitscript, addscript, addstyle, console, dialog
 *   Tabs:     tab.new, tab.list, tab.switch, tab.close
 *   Frames:   frame.select, frame.main
 *   Geo:      geolocation.set
 */

import type { CDPClient } from "./cdp.ts";

// ─── Selector helpers ─────────────────────────────────────────────────────────

/**
 * Resolve a CSS selector to a RemoteObjectId using Runtime.evaluate.
 * Throws if the element cannot be found.
 */
async function resolveSelector(
  client: CDPClient,
  selector: string,
  frameContextId?: number
): Promise<string> {
  const evalParams: Record<string, unknown> = {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  };
  if (frameContextId !== undefined) evalParams.contextId = frameContextId;

  const result = await client.send("Runtime.evaluate", evalParams);
  const obj = result["result"] as { objectId?: string; subtype?: string } | undefined;
  if (!obj?.objectId || obj.subtype === "null") {
    throw new Error(`Element not found: ${selector}`);
  }
  return obj.objectId;
}

/**
 * Get the bounding box of an element by selector using getBoundingClientRect().
 *
 * Uses Runtime.evaluate rather than DOM.getBoxModel so it works on all page
 * types including data: URLs (where DOM.getBoxModel often returns no layout).
 */
async function getElementBoxBySelector(
  client: CDPClient,
  selector: string
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const result = await client.send("Runtime.evaluate", {
    expression: `(function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`,
    returnByValue: true,
  });
  const val = (result["result"] as { value?: unknown; subtype?: string } | undefined);
  if (!val || val.subtype === "null" || !val.value) return null;
  return val.value as { x: number; y: number; width: number; height: number };
}

/**
 * Get the bounding box of an element by objectId (used for cdpGetBox public API).
 * Returns null if the element has no layout.
 */
async function getElementBox(
  client: CDPClient,
  objectId: string
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const nodeResult = await client.send("DOM.describeNode", { objectId });
  const nodeId = (nodeResult["node"] as { nodeId?: number } | undefined)?.nodeId;
  if (!nodeId) return null;

  const boxResult = await client.send("DOM.getBoxModel", { nodeId });
  const model = boxResult["model"] as {
    content?: number[];
    width?: number;
    height?: number;
  } | undefined;
  if (!model?.content) return null;

  // content is [x1,y1, x2,y2, x3,y3, x4,y4] (quad)
  const x = model.content[0] ?? 0;
  const y = model.content[1] ?? 0;
  const width = model.width ?? 0;
  const height = model.height ?? 0;
  return { x, y, width, height };
}

/** Get the center point of an element's bounding box. */
async function getElementCenter(
  client: CDPClient,
  selector: string
): Promise<{ x: number; y: number }> {
  const box = await getElementBoxBySelector(client, selector);
  if (!box || (box.width === 0 && box.height === 0)) {
    throw new Error(`Element has no layout box: ${selector}`);
  }
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

// ─── Input actions ────────────────────────────────────────────────────────────

export async function cdpClick(
  client: CDPClient,
  selector: string,
  button: "left" | "right" | "middle" = "left"
): Promise<void> {
  const { x, y } = await getElementCenter(client, selector);
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    clickCount: 1,
  });
}

export async function cdpDblClick(
  client: CDPClient,
  selector: string
): Promise<void> {
  const { x, y } = await getElementCenter(client, selector);
  for (let i = 1; i <= 2; i++) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: i,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: i,
    });
  }
}

export async function cdpHover(
  client: CDPClient,
  selector: string
): Promise<void> {
  const { x, y } = await getElementCenter(client, selector);
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
}

export async function cdpScroll(
  client: CDPClient,
  selector: string | null,
  deltaX: number,
  deltaY: number
): Promise<void> {
  if (selector) {
    const { x, y } = await getElementCenter(client, selector);
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });
  } else {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 400,
      y: 300,
      deltaX,
      deltaY,
    });
  }
}

/**
 * Fill an input by focusing it and using Input.insertText.
 * Clears the existing value first.
 */
export async function cdpFill(
  client: CDPClient,
  selector: string,
  value: string
): Promise<void> {
  // Click to focus
  await cdpClick(client, selector);
  // Select all existing text
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 4, // Ctrl
    key: "a",
    code: "KeyA",
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 4,
    key: "a",
    code: "KeyA",
  });
  // Insert new value
  await client.send("Input.insertText", { text: value });
  // Dispatch change event via eval
  await client.send("Runtime.evaluate", {
    expression: `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) nativeInputValueSetter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `,
    returnByValue: true,
  });
}

/**
 * Type text character by character (simulates real typing).
 * Use cdpFill for setting values directly; use cdpType for simulating keystrokes.
 */
export async function cdpType(
  client: CDPClient,
  selector: string,
  text: string
): Promise<void> {
  await cdpClick(client, selector);
  await client.send("Input.insertText", { text });
}

/** Map of common key names to CDP key identifiers. */
const KEY_MAP: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter:      { key: "Enter",     code: "Enter",       keyCode: 13  },
  Tab:        { key: "Tab",       code: "Tab",         keyCode: 9   },
  Escape:     { key: "Escape",    code: "Escape",      keyCode: 27  },
  Backspace:  { key: "Backspace", code: "Backspace",   keyCode: 8   },
  Delete:     { key: "Delete",    code: "Delete",      keyCode: 46  },
  ArrowUp:    { key: "ArrowUp",   code: "ArrowUp",     keyCode: 38  },
  ArrowDown:  { key: "ArrowDown", code: "ArrowDown",   keyCode: 40  },
  ArrowLeft:  { key: "ArrowLeft", code: "ArrowLeft",   keyCode: 37  },
  ArrowRight: { key: "ArrowRight",code: "ArrowRight",  keyCode: 39  },
  Home:       { key: "Home",      code: "Home",        keyCode: 36  },
  End:        { key: "End",       code: "End",         keyCode: 35  },
  PageUp:     { key: "PageUp",    code: "PageUp",      keyCode: 33  },
  PageDown:   { key: "PageDown",  code: "PageDown",    keyCode: 34  },
  Space:      { key: " ",         code: "Space",       keyCode: 32  },
  " ":        { key: " ",         code: "Space",       keyCode: 32  },
};

function resolveKey(keyName: string): { key: string; code: string; keyCode: number } {
  if (KEY_MAP[keyName]) return KEY_MAP[keyName]!;
  // Single character — derive keyCode from charCode
  const ch = keyName.length === 1 ? keyName : keyName[0] ?? "a";
  return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0) };
}

export async function cdpKeyDown(
  client: CDPClient,
  key: string,
  modifiers = 0
): Promise<void> {
  const k = resolveKey(key);
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
    modifiers,
  });
}

export async function cdpKeyUp(
  client: CDPClient,
  key: string,
  modifiers = 0
): Promise<void> {
  const k = resolveKey(key);
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
    modifiers,
  });
}

export async function cdpPress(
  client: CDPClient,
  selector: string,
  key: string
): Promise<void> {
  await cdpClick(client, selector);
  await cdpKeyDown(client, key);
  await cdpKeyUp(client, key);
}

// ─── DOM query actions ────────────────────────────────────────────────────────

async function evalOnElement(
  client: CDPClient,
  selector: string,
  expression: string // receives `el` as the element
): Promise<unknown> {
  const result = await client.send("Runtime.evaluate", {
    expression: `(function() { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; return (${expression})(el); })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const r = result["result"] as { value?: unknown; subtype?: string } | undefined;
  if (!r || r.subtype === "null") return null;
  return r.value ?? null;
}

export async function cdpGetText(client: CDPClient, selector: string): Promise<string | null> {
  return (await evalOnElement(client, selector, "el => el.innerText ?? el.textContent")) as string | null;
}

export async function cdpGetHtml(client: CDPClient, selector: string): Promise<string | null> {
  return (await evalOnElement(client, selector, "el => el.outerHTML")) as string | null;
}

export async function cdpGetValue(client: CDPClient, selector: string): Promise<string | null> {
  return (await evalOnElement(client, selector, "el => el.value ?? null")) as string | null;
}

export async function cdpGetAttr(client: CDPClient, selector: string, attr: string): Promise<string | null> {
  return (await evalOnElement(client, selector, `el => el.getAttribute(${JSON.stringify(attr)})`)) as string | null;
}

export async function cdpGetTitle(client: CDPClient): Promise<string> {
  const result = await client.send("Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true,
  });
  return ((result["result"] as { value?: unknown } | undefined)?.value as string | undefined) ?? "";
}

export async function cdpGetCount(client: CDPClient, selector: string): Promise<number> {
  const result = await client.send("Runtime.evaluate", {
    expression: `document.querySelectorAll(${JSON.stringify(selector)}).length`,
    returnByValue: true,
  });
  return ((result["result"] as { value?: unknown } | undefined)?.value as number | undefined) ?? 0;
}

export async function cdpGetBox(
  client: CDPClient,
  selector: string
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const objectId = await resolveSelector(client, selector);
  return getElementBox(client, objectId);
}

export async function cdpGetStyles(
  client: CDPClient,
  selector: string
): Promise<Record<string, string>> {
  const result = await evalOnElement(
    client,
    selector,
    `el => { const s = window.getComputedStyle(el); return Object.fromEntries([...s].map(k => [k, s.getPropertyValue(k)])); }`
  );
  return (result as Record<string, string> | null) ?? {};
}

export async function cdpIsVisible(client: CDPClient, selector: string): Promise<boolean> {
  const result = await client.send("Runtime.evaluate", {
    expression: `(function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })()`,
    returnByValue: true,
  });
  return ((result["result"] as { value?: unknown } | undefined)?.value as boolean | undefined) ?? false;
}

export async function cdpIsEnabled(client: CDPClient, selector: string): Promise<boolean> {
  const result = await evalOnElement(client, selector, "el => !el.disabled");
  return (result as boolean | null) ?? false;
}

export async function cdpIsChecked(client: CDPClient, selector: string): Promise<boolean> {
  const result = await evalOnElement(client, selector, "el => el.checked ?? false");
  return (result as boolean | null) ?? false;
}

export async function cdpCheck(client: CDPClient, selector: string): Promise<void> {
  const checked = await cdpIsChecked(client, selector);
  if (!checked) await cdpClick(client, selector);
}

export async function cdpUncheck(client: CDPClient, selector: string): Promise<void> {
  const checked = await cdpIsChecked(client, selector);
  if (checked) await cdpClick(client, selector);
}

export async function cdpSelect(
  client: CDPClient,
  selector: string,
  value: string
): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: `(function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
    returnByValue: true,
  });
}

export async function cdpFocus(client: CDPClient, selector: string): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})?.focus()`,
    returnByValue: true,
  });
}

export async function cdpHighlight(
  client: CDPClient,
  selector: string,
  color = "rgba(255,165,0,0.4)"
): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: `(function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      const prev = el.style.outline;
      el.style.outline = '3px solid ${color}';
      setTimeout(() => { el.style.outline = prev; }, 1500);
    })()`,
    returnByValue: true,
  });
}

// ─── Find helpers ─────────────────────────────────────────────────────────────

/** Build a CSS selector from a find-by-* strategy. */
function buildFindSelector(strategy: string, value: string, nth?: number): string {
  let base: string;
  switch (strategy) {
    case "role":
      base = `[role="${value}"]`;
      break;
    case "text":
      // Handled via JS evaluation — return special marker
      return `__text__${value}__nth__${nth ?? 0}`;
    case "label":
      base = `[aria-label="${value}"], label[for]:has-text("${value}")`;
      break;
    case "placeholder":
      base = `[placeholder="${value}"]`;
      break;
    case "alt":
      base = `[alt="${value}"]`;
      break;
    case "title":
      base = `[title="${value}"]`;
      break;
    case "testid":
      base = `[data-testid="${value}"], [data-test-id="${value}"], [data-cy="${value}"]`;
      break;
    default:
      base = value; // treat as raw CSS selector
  }
  return base;
}

/**
 * Find elements by various strategies. Returns a synthetic "ref" string that
 * subsequent actions can use as a selector (we use `data-chromux-ref` attribute).
 *
 * Returns an array of CSS selectors (we stamp with a data attr).
 */
export async function cdpFind(
  client: CDPClient,
  strategy: string,
  value: string,
  nth?: number
): Promise<string | null> {
  const selector = buildFindSelector(strategy, value, nth);

  if (selector.startsWith("__text__")) {
    // Text-based find — use TreeWalker in JS
    const text = value;
    const index = nth ?? 0;
    const result = await client.send("Runtime.evaluate", {
      expression: `(function() {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        const matches = [];
        let node;
        while ((node = walker.nextNode())) {
          if ((node.innerText || node.textContent || '').trim().includes(${JSON.stringify(text)})) {
            const id = 'chromux-' + Math.random().toString(36).slice(2);
            node.setAttribute('data-chromux-ref', id);
            matches.push('[data-chromux-ref="' + id + '"]');
          }
        }
        return matches[${index}] ?? null;
      })()`,
      returnByValue: true,
    });
    return ((result["result"] as { value?: unknown } | undefined)?.value as string | null) ?? null;
  }

  // CSS-based find — stamp a ref attribute
  const result = await client.send("Runtime.evaluate", {
    expression: `(function() {
      const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const target = els[${nth ?? 0}];
      if (!target) return null;
      const id = 'chromux-' + Math.random().toString(36).slice(2);
      target.setAttribute('data-chromux-ref', id);
      return '[data-chromux-ref="' + id + '"]';
    })()`,
    returnByValue: true,
  });
  return ((result["result"] as { value?: unknown } | undefined)?.value as string | null) ?? null;
}

// ─── Navigation helpers ───────────────────────────────────────────────────────

export async function cdpBack(client: CDPClient): Promise<void> {
  await client.send("Page.enable");
  const hist = await client.send("Page.getNavigationHistory");
  const entries = (hist["entries"] as Array<{ id: number; url: string }> | undefined) ?? [];
  const currentIndex = (hist["currentIndex"] as number | undefined) ?? 0;
  if (currentIndex > 0) {
    const prev = entries[currentIndex - 1];
    if (prev) await client.send("Page.navigateToHistoryEntry", { entryId: prev.id });
  }
}

export async function cdpForward(client: CDPClient): Promise<void> {
  await client.send("Page.enable");
  const hist = await client.send("Page.getNavigationHistory");
  const entries = (hist["entries"] as Array<{ id: number; url: string }> | undefined) ?? [];
  const currentIndex = (hist["currentIndex"] as number | undefined) ?? 0;
  if (currentIndex < entries.length - 1) {
    const next = entries[currentIndex + 1];
    if (next) await client.send("Page.navigateToHistoryEntry", { entryId: next.id });
  }
}

export async function cdpReload(client: CDPClient, ignoreCache = false): Promise<void> {
  await client.send("Page.reload", { ignoreCache });
}

export async function cdpGetUrl(client: CDPClient): Promise<string> {
  const result = await client.send("Runtime.evaluate", {
    expression: "location.href",
    returnByValue: true,
  });
  return ((result["result"] as { value?: unknown } | undefined)?.value as string | undefined) ?? "";
}

export async function cdpScrollIntoView(client: CDPClient, selector: string): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ behavior: 'smooth', block: 'center' })`,
    returnByValue: true,
  });
}

/**
 * Wait for a selector to appear in DOM (visibility optional), or for URL to match.
 *
 * @param type  "selector" | "url"
 * @param value CSS selector or URL substring/regex string
 * @param timeoutMs  Max wait time
 */
export async function cdpWait(
  client: CDPClient,
  type: "selector" | "url",
  value: string,
  timeoutMs = 10_000
): Promise<void> {
  const start = Date.now();
  const pollMs = 150;

  while (Date.now() - start < timeoutMs) {
    if (type === "selector") {
      const result = await client.send("Runtime.evaluate", {
        expression: `!!document.querySelector(${JSON.stringify(value)})`,
        returnByValue: true,
      });
      const found = ((result["result"] as { value?: unknown } | undefined)?.value as boolean | undefined) ?? false;
      if (found) return;
    } else {
      const result = await client.send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      });
      const url = ((result["result"] as { value?: unknown } | undefined)?.value as string | undefined) ?? "";
      if (url.includes(value)) return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`cdpWait timed out after ${timeoutMs}ms waiting for ${type}="${value}"`);
}

// ─── Storage, cookies, network ────────────────────────────────────────────────

interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export async function cdpCookiesGet(
  client: CDPClient,
  urls?: string[]
): Promise<Cookie[]> {
  const params: Record<string, unknown> = {};
  if (urls) params["urls"] = urls;
  const result = await client.send("Network.getCookies", params);
  return (result["cookies"] as Cookie[] | undefined) ?? [];
}

export async function cdpCookiesSet(client: CDPClient, cookie: Cookie): Promise<void> {
  await client.send("Network.setCookie", cookie as unknown as Record<string, unknown>);
}

export async function cdpCookiesClear(client: CDPClient, name?: string, url?: string): Promise<void> {
  if (name && url) {
    await client.send("Network.deleteCookies", { name, url });
  } else {
    await client.send("Network.clearBrowserCookies");
  }
}

export async function cdpStorageGet(
  client: CDPClient,
  key: string,
  storageType: "local" | "session" = "local"
): Promise<string | null> {
  const result = await client.send("Runtime.evaluate", {
    expression: `${storageType}Storage.getItem(${JSON.stringify(key)})`,
    returnByValue: true,
  });
  return ((result["result"] as { value?: unknown } | undefined)?.value as string | null) ?? null;
}

export async function cdpStorageSet(
  client: CDPClient,
  key: string,
  value: string,
  storageType: "local" | "session" = "local"
): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: `${storageType}Storage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
    returnByValue: true,
  });
}

export async function cdpStorageClear(
  client: CDPClient,
  storageType: "local" | "session" = "local"
): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: `${storageType}Storage.clear()`,
    returnByValue: true,
  });
}

/** Simple request log entry. */
interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  timestamp: number;
}

/** In-memory network request log managed by startNetworkLog(). */
export class NetworkLog {
  readonly requests: NetworkRequest[] = [];

  private responseHandler = (params: Record<string, unknown>) => {
    const req = params["response"] as { url?: string; mimeType?: string; status?: number } | undefined;
    const existing = this.requests.find((r) => r.requestId === params["requestId"]);
    if (existing && req) {
      if (req.status !== undefined) existing.status = req.status;
      if (req.mimeType !== undefined) existing.mimeType = req.mimeType;
    }
  };

  private requestHandler = (params: Record<string, unknown>) => {
    const req = params["request"] as { url?: string; method?: string } | undefined;
    this.requests.push({
      requestId: params["requestId"] as string ?? "",
      url: req?.url ?? "",
      method: req?.method ?? "GET",
      timestamp: Date.now(),
    });
  };

  constructor(private readonly client: CDPClient) {}

  async start(): Promise<void> {
    await this.client.send("Network.enable");
    this.client.on("Network.requestWillBeSent", this.requestHandler);
    this.client.on("Network.responseReceived", this.responseHandler);
  }

  stop(): void {
    this.client.off("Network.requestWillBeSent", this.requestHandler);
    this.client.off("Network.responseReceived", this.responseHandler);
  }

  clear(): void {
    this.requests.length = 0;
  }
}

/** Route map: pattern → response. Used by cdpNetworkRoute. */
export type RouteHandler = {
  pattern: string;
  response: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    abort?: boolean;
  };
};

/**
 * Intercept network requests matching `pattern` and return a mocked response.
 *
 * Uses Fetch domain (more flexible than Network interception for response mocking).
 */
export async function cdpNetworkRoute(
  client: CDPClient,
  pattern: string,
  response: RouteHandler["response"]
): Promise<void> {
  await client.send("Fetch.enable", {
    patterns: [{ urlPattern: pattern, requestStage: "Request" }],
  });

  client.on("Fetch.requestPaused", async (params) => {
    const requestId = params["requestId"] as string;
    if (response.abort) {
      await client.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
    } else {
      const body = response.body ?? "";
      const base64Body = Buffer.from(body).toString("base64");
      await client.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: response.status ?? 200,
        responseHeaders: Object.entries(response.headers ?? {}).map(([name, value]) => ({ name, value })),
        body: base64Body,
      });
    }
  });
}

export async function cdpNetworkUnroute(client: CDPClient): Promise<void> {
  await client.send("Fetch.disable");
}

// ─── Page config ──────────────────────────────────────────────────────────────

export async function cdpViewportSet(
  client: CDPClient,
  width: number,
  height: number,
  deviceScaleFactor = 1
): Promise<void> {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor,
    mobile: false,
  });
}

export async function cdpOfflineSet(client: CDPClient, offline: boolean): Promise<void> {
  await client.send("Network.emulateNetworkConditions", {
    offline,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
}

export async function cdpGeolocationSet(
  client: CDPClient,
  latitude: number,
  longitude: number,
  accuracy = 1
): Promise<void> {
  await client.send("Emulation.setGeolocationOverride", { latitude, longitude, accuracy });
}

export async function cdpAddInitScript(client: CDPClient, source: string): Promise<string> {
  const result = await client.send("Page.addScriptToEvaluateOnNewDocument", { source });
  return (result["identifier"] as string | undefined) ?? "";
}

export async function cdpAddScript(client: CDPClient, source: string): Promise<void> {
  await client.send("Runtime.evaluate", { expression: source, returnByValue: false });
}

export async function cdpAddStyle(client: CDPClient, css: string): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: `(function() {
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(css)};
      document.head.appendChild(style);
    })()`,
    returnByValue: true,
  });
}

// ─── Console + errors ─────────────────────────────────────────────────────────

export interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: number;
}

export class ConsoleLog {
  readonly entries: ConsoleEntry[] = [];
  readonly errors: ConsoleEntry[] = [];

  private messageHandler = (params: Record<string, unknown>) => {
    const entry: ConsoleEntry = {
      level: (params["level"] as string | undefined) ?? "log",
      text: (params["text"] as string | undefined) ?? "",
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    if (entry.level === "error") this.errors.push(entry);
  };

  private exceptionHandler = (params: Record<string, unknown>) => {
    const detail = params["exceptionDetails"] as { text?: string; exception?: { description?: string } } | undefined;
    const text = detail?.exception?.description ?? detail?.text ?? "Unknown JS exception";
    const entry: ConsoleEntry = { level: "error", text, timestamp: Date.now() };
    this.entries.push(entry);
    this.errors.push(entry);
  };

  constructor(private readonly client: CDPClient) {}

  async start(): Promise<void> {
    await this.client.send("Runtime.enable");
    this.client.on("Runtime.consoleAPICalled", this.messageHandler);
    this.client.on("Runtime.exceptionThrown", this.exceptionHandler);
  }

  stop(): void {
    this.client.off("Runtime.consoleAPICalled", this.messageHandler);
    this.client.off("Runtime.exceptionThrown", this.exceptionHandler);
  }

  clear(): void {
    this.entries.length = 0;
    this.errors.length = 0;
  }
}

// ─── Dialog handling ──────────────────────────────────────────────────────────

/**
 * Set up a one-shot dialog handler. Call before triggering the action that
 * opens the dialog.
 */
export async function cdpDialogHandle(
  client: CDPClient,
  accept: boolean,
  promptText = ""
): Promise<void> {
  await client.send("Page.enable");

  const handler = async (params: Record<string, unknown>) => {
    client.off("Page.javascriptDialogOpening", handler);
    const type = params["type"] as string | undefined;
    await client.send("Page.handleJavaScriptDialog", {
      accept,
      promptText: type === "prompt" ? promptText : "",
    });
  };

  client.on("Page.javascriptDialogOpening", handler);
}

// ─── Tab management ───────────────────────────────────────────────────────────

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export async function cdpTabList(cdpPort: number): Promise<TabInfo[]> {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
  const targets = await res.json() as Array<{
    id: string;
    type: string;
    url: string;
    title: string;
    webSocketDebuggerUrl?: string;
  }>;
  return targets
    .filter((t) => t.type === "page")
    .map((t, i) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: i === 0, // first target is the active one
    }));
}

export async function cdpTabNew(
  cdpPort: number,
  url = "about:blank"
): Promise<TabInfo> {
  // /json/new was removed in Chrome 109+. Use Target.createTarget via CDP instead.
  const versionRes = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
  if (!versionRes.ok) throw new Error(`/json/version HTTP ${versionRes.status}`);
  const version = await versionRes.json() as { webSocketDebuggerUrl?: string };
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error("No webSocketDebuggerUrl in /json/version");

  // Use a temporary browser-level CDP connection
  const { CDPClient } = await import("./cdp.ts");
  const { Logger } = await import("./util.ts");
  const client = new CDPClient(new Logger("silent"));
  await client.connect(wsUrl);
  try {
    const result = await client.send("Target.createTarget", { url });
    const targetId = result["targetId"] as string;
    return { id: targetId, url, title: "", active: true };
  } finally {
    client.disconnect();
  }
}

export async function cdpTabClose(cdpPort: number, targetId: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/close/${targetId}`);
  if (!res.ok) throw new Error(`/json/close HTTP ${res.status}`);
}

export async function cdpTabActivate(cdpPort: number, targetId: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/activate/${targetId}`);
  if (!res.ok) throw new Error(`/json/activate HTTP ${res.status}`);
}

// ─── Frame management ─────────────────────────────────────────────────────────

/** Context info for a frame. */
export interface FrameInfo {
  frameId: string;
  contextId: number;
  url: string;
  name: string;
}

export async function cdpFrameList(client: CDPClient): Promise<FrameInfo[]> {
  await client.send("Page.enable");
  // Use Runtime.evaluate to enumerate frames
  const framesResult = await client.send("Runtime.evaluate", {
    expression: `(function() {
      const frames = [];
      function collect(win, depth) {
        try {
          frames.push({ url: win.location.href, name: win.name || '' });
          for (let i = 0; i < win.frames.length; i++) collect(win.frames[i], depth + 1);
        } catch(e) {}
      }
      collect(window, 0);
      return JSON.stringify(frames);
    })()`,
    returnByValue: true,
  });
  const raw = ((framesResult["result"] as { value?: unknown } | undefined)?.value as string | undefined) ?? "[]";
  const frames = JSON.parse(raw) as Array<{ url: string; name: string }>;
  return frames.map((f, i) => ({
    frameId: String(i),
    contextId: i,
    url: f.url,
    name: f.name,
  }));
}
