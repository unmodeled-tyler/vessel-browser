import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  AgentRuntime,
  AgentRuntimeActionLifecycleEvent,
} from "../agent/runtime";
import { assertFeatureUnlocked } from "../premium/manager";
import type { TabManager } from "../tabs/tab-manager";
import { getOrCreateSession, getSession, destroySession } from "./manager";
import type {
  DevToolsActivityEntry,
  DevToolsAgentTraceEntry,
  DevToolsPageMapSnapshot,
  DevToolsPanelState,
} from "./types";

function asTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const DANGEROUS_DEVTOOLS_ACTIONS = new Set([
  "devtools_execute_js",
  "devtools_modify_dom",
  "devtools_set_storage",
]);

// State broadcast for the DevTools panel UI
let stateListener: ((state: DevToolsPanelState) => void) | null = null;
const activityLog: DevToolsActivityEntry[] = [];
const agentTraceLog: DevToolsAgentTraceEntry[] = [];
const MAX_ACTIVITY_ENTRIES = 100;
const MAX_TRACE_ENTRIES = 200;
let activityCounter = 0;
let traceCounter = 0;
let latestPageMap: DevToolsPageMapSnapshot | null = null;
let pageMapRefreshInFlight = false;
const traceEntriesByActionId = new Map<string, DevToolsAgentTraceEntry>();

export function setDevToolsPanelListener(
  listener: ((state: DevToolsPanelState) => void) | null,
): void {
  stateListener = listener;
}

export function getDevToolsPanelState(tabId: string | null): DevToolsPanelState {
  const session = tabId ? getSession(tabId) : undefined;
  return {
    console: session?.getConsoleLogs() ?? [],
    network: session?.getNetworkLog() ?? [],
    errors: session?.getErrors() ?? [],
    activity: activityLog,
    agentTrace: agentTraceLog,
    pageMap: latestPageMap,
  };
}

export function broadcastDevToolsPanelState(tabManager: TabManager): void {
  if (!stateListener) return;
  const tabId = tabManager.getActiveTabId();
  stateListener(getDevToolsPanelState(tabId));
}

// Coalesce bursts of CDP capture events (a page load fires many
// Network.* events in quick succession) into a single panel push per tick.
let panelBroadcastScheduled = false;
let panelBroadcastTabManager: TabManager | null = null;
let panelCapturedTabId: string | null = null;
const panelOwnedCaptureTabs = new Set<string>();

function schedulePanelBroadcast(tabManager: TabManager): void {
  panelBroadcastTabManager = tabManager;
  if (panelBroadcastScheduled) return;
  panelBroadcastScheduled = true;
  queueMicrotask(() => {
    panelBroadcastScheduled = false;
    if (panelBroadcastTabManager) {
      broadcastDevToolsPanelState(panelBroadcastTabManager);
    }
  });
}

function releasePanelCaptureForTab(tabId: string): void {
  const session = getSession(tabId);
  session?.setOnCaptureChange(null);
  if (panelCapturedTabId === tabId) {
    panelCapturedTabId = null;
  }
  if (panelOwnedCaptureTabs.delete(tabId)) {
    destroySession(tabId);
  }
}

function markActiveSessionToolOwned(tabManager: TabManager): void {
  const tabId = tabManager.getActiveTabId();
  if (tabId) {
    panelOwnedCaptureTabs.delete(tabId);
  }
}

/**
 * Enable console/network/error capture for the active tab and wire its
 * capture-change callback to the coalesced panel broadcaster. Used when the
 * DevTools panel opens so manual browsing is captured without an agent action.
 * Idempotent: enabling domains is guarded inside DevToolsSession.
 */
export async function enableCaptureForTab(
  tabManager: TabManager,
): Promise<void> {
  const tabId = tabManager.getActiveTabId();
  if (!tabId) return;
  if (panelCapturedTabId && panelCapturedTabId !== tabId) {
    releasePanelCaptureForTab(panelCapturedTabId);
  }

  let session = getSession(tabId);
  const panelCreatedSession = !session;
  session ??= getOrCreateSession(tabManager);
  if (panelCreatedSession) {
    panelOwnedCaptureTabs.add(tabId);
  }

  panelCapturedTabId = tabId;
  session.setOnCaptureChange(() => {
    if (panelCapturedTabId === tabId) {
      schedulePanelBroadcast(tabManager);
    }
  });
  await session.enableCapture();
  // Push the current (possibly pre-existing) buffer contents immediately.
  if (panelCapturedTabId === tabId) {
    broadcastDevToolsPanelState(tabManager);
  }
}

/**
 * Tear down panel-owned capture. Existing agent/tool sessions keep their
 * buffers and debugger attachment; sessions created solely for the panel are
 * destroyed so capture does not keep running in the background.
 */
export function disableCaptureForTab(tabId?: string | null): void {
  const targetTabId = tabId ?? panelCapturedTabId;
  if (targetTabId) {
    releasePanelCaptureForTab(targetTabId);
  }
  if (tabId == null) {
    for (const ownedTabId of [...panelOwnedCaptureTabs]) {
      releasePanelCaptureForTab(ownedTabId);
    }
    panelBroadcastTabManager = null;
  }
}

function pushTrace(
  entry: Omit<DevToolsAgentTraceEntry, "id" | "timestamp">,
): DevToolsAgentTraceEntry {
  const traceEntry: DevToolsAgentTraceEntry = {
    id: ++traceCounter,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  agentTraceLog.push(traceEntry);
  if (agentTraceLog.length > MAX_TRACE_ENTRIES) {
    const removed = agentTraceLog.splice(
      0,
      agentTraceLog.length - MAX_TRACE_ENTRIES,
    );
    for (const trace of removed) {
      if (trace.actionId) traceEntriesByActionId.delete(trace.actionId);
    }
  }
  return traceEntry;
}

function formatTraceActionName(name: string): string {
  return name
    .replace(/^devtools_/, "")
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function traceDetail(event: AgentRuntimeActionLifecycleEvent): string {
  const sourcePrefix = event.source === "ai" ? "Agent" : event.source.toUpperCase();
  return [sourcePrefix, event.detail].filter(Boolean).join(": ").slice(0, 240);
}

export function recordDevToolsAgentAction(
  event: AgentRuntimeActionLifecycleEvent,
  tabManager: TabManager,
): void {
  const actionName = formatTraceActionName(event.name);
  if (event.phase === "started") {
    const entry = pushTrace({
      actionId: event.actionId,
      kind: "tool-start",
      title: `Started ${actionName}`,
      detail: traceDetail(event),
      status: "running",
      tool: event.name,
    });
    traceEntriesByActionId.set(event.actionId, entry);
    broadcastDevToolsPanelState(tabManager);
    return;
  }

  const startEntry = traceEntriesByActionId.get(event.actionId);
  if (startEntry) {
    startEntry.status =
      event.phase === "completed" ? "completed" : "failed";
    startEntry.durationMs = event.durationMs;
    if (event.phase === "waiting-approval") {
      startEntry.status = "running";
      startEntry.detail = traceDetail(event);
    }
  }

  if (event.phase === "waiting-approval") {
    broadcastDevToolsPanelState(tabManager);
    return;
  }

  pushTrace({
    actionId: event.actionId,
    kind: event.phase === "completed" ? "tool-complete" : "tool-error",
    title:
      event.phase === "completed"
        ? `Completed ${actionName}`
        : `${event.phase === "rejected" ? "Rejected" : "Failed"} ${actionName}`,
    detail: traceDetail(event),
    status: event.phase === "completed" ? "completed" : "failed",
    tool: event.name,
    durationMs: event.durationMs,
  });
  traceEntriesByActionId.delete(event.actionId);
  broadcastDevToolsPanelState(tabManager);
}

const PAGE_MAP_SCRIPT = `
(() => {
  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[role='tab']",
    "[role='menuitem']",
    "[contenteditable='true']",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function textFor(el) {
    const direct =
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("alt") ||
      el.value ||
      el.innerText ||
      el.textContent ||
      "";
    return String(direct).replace(/\\s+/g, " ").trim().slice(0, 140);
  }

  function selectorFor(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
      let part = node.localName;
      const classes = Array.from(node.classList || []).slice(0, 2);
      if (classes.length) part += "." + classes.map((c) => CSS.escape(c)).join(".");
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.localName === node.localName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function isVisible(el, style, rect) {
    return rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0.01;
  }

  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };

  const candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  const elements = candidates.slice(0, 120).map((el, index) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible = isVisible(el, style, rect);
    const disabled = Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true";
    const inViewport = rect.bottom >= 0 && rect.right >= 0 && rect.top <= viewport.height && rect.left <= viewport.width;
    let issue = "";
    let blocked = false;
    if (!visible) issue = "hidden";
    else if (!inViewport) issue = "offscreen";
    else {
      const centerX = Math.min(Math.max(rect.left + rect.width / 2, 0), viewport.width - 1);
      const centerY = Math.min(Math.max(rect.top + rect.height / 2, 0), viewport.height - 1);
      const top = document.elementFromPoint(centerX, centerY);
      if (top && top !== el && !el.contains(top)) {
        blocked = true;
        issue = "covered by " + top.localName;
      }
    }
    return {
      id: index + 1,
      tag: el.localName,
      role: el.getAttribute("role") || undefined,
      label: textFor(el) || "(unlabeled)",
      selector: selectorFor(el),
      href: el.href || undefined,
      type: el.type || undefined,
      visible,
      interactable: visible && inViewport && !disabled && !blocked,
      disabled,
      issue: issue || undefined,
      bounds: {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
      },
    };
  });

  const counts = elements.reduce((acc, element) => {
    acc.total += 1;
    if (element.visible) acc.visible += 1;
    if (element.interactable) acc.interactable += 1;
    if (element.disabled) acc.disabled += 1;
    if (element.issue && element.issue.startsWith("covered")) acc.blocked += 1;
    return acc;
  }, { total: 0, visible: 0, interactable: 0, disabled: 0, blocked: 0 });

  return {
    timestamp: new Date().toISOString(),
    pageUrl: location.href,
    title: document.title || "",
    viewport,
    counts,
    elements,
    accessIssues: elements.length === 0 ? ["No obvious interactive elements found."] : [],
  };
})()
`;

async function capturePageMapSnapshot(
  tabManager: TabManager,
): Promise<DevToolsPageMapSnapshot | null> {
  const tab = tabManager.getActiveTab();
  if (!tab || tab.view.webContents.isDestroyed()) {
    return {
      timestamp: new Date().toISOString(),
      pageUrl: "",
      title: "No active tab",
      viewport: { width: 0, height: 0, scrollX: 0, scrollY: 0 },
      counts: { total: 0, visible: 0, interactable: 0, disabled: 0, blocked: 0 },
      elements: [],
      accessIssues: ["No active tab is available."],
    };
  }

  try {
    return await tab.view.webContents.executeJavaScript(PAGE_MAP_SCRIPT, true);
  } catch (error) {
    return {
      timestamp: new Date().toISOString(),
      pageUrl: tab.view.webContents.getURL(),
      title: "Page map unavailable",
      viewport: { width: 0, height: 0, scrollX: 0, scrollY: 0 },
      counts: { total: 0, visible: 0, interactable: 0, disabled: 0, blocked: 0 },
      elements: [],
      accessIssues: [
        error instanceof Error ? error.message : "Could not inspect active page.",
      ],
    };
  }
}

export async function refreshDevToolsPageMap(
  tabManager: TabManager,
): Promise<DevToolsPanelState> {
  if (pageMapRefreshInFlight) {
    return getDevToolsPanelState(tabManager.getActiveTabId());
  }
  pageMapRefreshInFlight = true;
  try {
    latestPageMap = await capturePageMapSnapshot(tabManager);
  } finally {
    pageMapRefreshInFlight = false;
  }
  broadcastDevToolsPanelState(tabManager);
  return getDevToolsPanelState(tabManager.getActiveTabId());
}

function broadcastState(tabManager: TabManager): void {
  broadcastDevToolsPanelState(tabManager);
  void refreshDevToolsPageMap(tabManager);
}

async function withDevToolsAction(
  runtime: AgentRuntime,
  tabManager: TabManager,
  name: string,
  args: Record<string, unknown>,
  executor: () => Promise<string>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    assertFeatureUnlocked("devtools", "DevTools");
  } catch (error) {
    return asTextResponse(
      `Error: ${error instanceof Error ? error.message : "DevTools require Vessel Premium."}`,
    );
  }
  markActiveSessionToolOwned(tabManager);

  const activityEntry: DevToolsActivityEntry = {
    id: ++activityCounter,
    timestamp: new Date().toISOString(),
    tool: name,
    args: JSON.stringify(args).slice(0, 200),
    result: "",
    durationMs: 0,
    status: "running",
  };
  activityLog.push(activityEntry);
  if (activityLog.length > MAX_ACTIVITY_ENTRIES) {
    activityLog.splice(0, activityLog.length - MAX_ACTIVITY_ENTRIES);
  }
  broadcastState(tabManager);

  const startTime = Date.now();
  try {
    const result = await runtime.runControlledAction({
      source: "mcp",
      name,
      args,
      tabId: tabManager.getActiveTabId(),
      dangerous: DANGEROUS_DEVTOOLS_ACTIONS.has(name),
      executor,
    });
    activityEntry.status = "completed";
    activityEntry.result = result.slice(0, 200);
    activityEntry.durationMs = Date.now() - startTime;
    broadcastState(tabManager);
    return asTextResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    activityEntry.status = "failed";
    activityEntry.result = message.slice(0, 200);
    activityEntry.durationMs = Date.now() - startTime;
    broadcastState(tabManager);
    return asTextResponse(`Error: ${message}`);
  }
}

export function registerDevTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  // ---------------------------------------------------------------------------
  // Console
  // ---------------------------------------------------------------------------

  server.registerTool(
    "vessel_devtools_console_logs",
    {
      title: "DevTools: Get Console Logs",
      description:
        "Get console log entries captured from the active tab. Returns a rolling buffer of recent console.log, console.warn, console.error, etc. calls. Automatically starts capturing on first use.",
      inputSchema: {
        level: z
          .enum(["log", "warning", "error", "info", "debug", "verbose"])
          .optional()
          .describe("Filter by log level"),
        limit: z
          .number()
          .optional()
          .describe("Maximum number of entries to return (default: all)"),
        search: z
          .string()
          .optional()
          .describe("Filter entries containing this text (case-insensitive)"),
      },
    },
    async ({ level, limit, search }) => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_console_logs",
        { level, limit, search },
        async () => {
          const session = getOrCreateSession(tabManager);
          await session.ensureConsoleDomain();
          const entries = session.getConsoleLogs({ level, limit, search });
          if (entries.length === 0) {
            return "No console entries captured yet. Console monitoring is now active — new entries will be captured as they occur.";
          }
          return JSON.stringify(entries, null, 2);
        },
      );
    },
  );

  server.registerTool(
    "vessel_devtools_console_clear",
    {
      title: "DevTools: Clear Console Logs",
      description: "Clear the captured console log buffer for the active tab.",
    },
    async () => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_console_clear",
        {},
        async () => {
          const session = getOrCreateSession(tabManager);
          const count = session.clearConsoleLogs();
          return `Cleared ${count} console entries.`;
        },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  server.registerTool(
    "vessel_devtools_network_log",
    {
      title: "DevTools: Get Network Log",
      description:
        "Get captured network requests/responses from the active tab. Returns method, URL, status, timing, headers, and size. Automatically starts capturing on first use.",
      inputSchema: {
        url_pattern: z
          .string()
          .optional()
          .describe("Filter by URL pattern (regex or substring match)"),
        method: z
          .string()
          .optional()
          .describe("Filter by HTTP method (GET, POST, etc.)"),
        status_min: z
          .number()
          .optional()
          .describe("Minimum HTTP status code (e.g., 400 for errors)"),
        status_max: z
          .number()
          .optional()
          .describe("Maximum HTTP status code"),
        limit: z
          .number()
          .optional()
          .describe("Maximum number of entries to return (default: all)"),
      },
    },
    async ({ url_pattern, method, status_min, status_max, limit }) => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_network_log",
        { url_pattern, method, status_min, status_max, limit },
        async () => {
          const session = getOrCreateSession(tabManager);
          await session.ensureNetworkDomain();
          const entries = session.getNetworkLog({
            urlPattern: url_pattern,
            method,
            statusRange:
              status_min != null || status_max != null
                ? { min: status_min, max: status_max }
                : undefined,
            limit,
          });
          if (entries.length === 0) {
            return "No network requests captured yet. Network monitoring is now active — new requests will be captured as they occur.";
          }
          return JSON.stringify(entries, null, 2);
        },
      );
    },
  );

  server.registerTool(
    "vessel_devtools_network_response_body",
    {
      title: "DevTools: Get Network Response Body",
      description:
        "Get the response body for a specific network request by its request ID. Use vessel_devtools_network_log first to find the request ID.",
      inputSchema: {
        request_id: z
          .string()
          .describe("The requestId from a network log entry"),
      },
    },
    async ({ request_id }) => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_network_response_body",
        { request_id },
        async () => {
          const session = getOrCreateSession(tabManager);
          const result = await session.getNetworkResponseBody(request_id);
          if ("error" in result) return `Error: ${result.error}`;
          if (result.base64Encoded) {
            return `[Base64-encoded body, ${result.body.length} chars. Likely binary content.]`;
          }
          const body = result.body;
          return body.length > 20000
            ? body.slice(0, 20000) + `\n... [truncated, total ${body.length} chars]`
            : body;
        },
      );
    },
  );

  server.registerTool(
    "vessel_devtools_network_clear",
    {
      title: "DevTools: Clear Network Log",
      description: "Clear the captured network request buffer for the active tab.",
    },
    async () => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_network_clear",
        {},
        async () => {
          const session = getOrCreateSession(tabManager);
          const count = session.clearNetworkLog();
          return `Cleared ${count} network entries.`;
        },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  server.registerTool(
    "vessel_devtools_query_dom",
    {
      title: "DevTools: Query DOM",
      description:
        "Query the DOM of the active tab using a CSS selector. Returns matching elements with their attributes, node type, and optionally their HTML content. Limited to 50 results.",
      inputSchema: {
        selector: z.string().describe("CSS selector to query"),
        include_html: z
          .boolean()
          .optional()
          .describe("Include outerHTML of matched elements (default: false)"),
      },
    },
    async ({ selector, include_html }) => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_query_dom",
        { selector, include_html },
        async () => {
          const session = getOrCreateSession(tabManager);
          const nodes = await session.queryDom(selector, {
            includeHtml: include_html,
          });
          if (nodes.length === 0) {
            return `No elements found matching "${selector}"`;
          }
          return JSON.stringify(nodes, null, 2);
        },
      );
    },
  );

  server.registerTool(
    "vessel_devtools_get_styles",
    {
      title: "DevTools: Get Computed Styles",
      description:
        "Get computed CSS styles for an element matching a CSS selector. Optionally filter to specific properties.",
      inputSchema: {
        selector: z.string().describe("CSS selector for the target element"),
        properties: z
          .array(z.string())
          .optional()
          .describe(
            'Specific CSS properties to return (e.g., ["color", "font-size", "display"]). Omit for all properties.',
          ),
      },
    },
    async ({ selector, properties }) => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_get_styles",
        { selector, properties },
        async () => {
          const session = getOrCreateSession(tabManager);
          const styles = await session.getComputedStyles(selector, properties);
          if (styles.length === 0) {
            return `No computed styles found for "${selector}"`;
          }
          return JSON.stringify(styles, null, 2);
        },
      );
    },
  );

  server.registerTool(
    "vessel_devtools_modify_dom",
    {
      title: "DevTools: Modify DOM Attribute",
      description:
        "Set or remove an HTML attribute on an element matching a CSS selector. This is a dangerous action that modifies the page.",
      inputSchema: {
        selector: z.string().describe("CSS selector for the target element"),
        attribute: z.string().describe("Attribute name to set or remove"),
        value: z
          .string()
          .nullable()
          .describe("Attribute value to set, or null to remove the attribute"),
      },
    },
    async ({ selector, attribute, value }) => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_modify_dom",
        { selector, attribute, value },
        async () => {
          const session = getOrCreateSession(tabManager);
          return session.modifyDomAttribute(selector, attribute, value);
        },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // JavaScript Execution
  // ---------------------------------------------------------------------------

  server.registerTool(
    "vessel_devtools_execute_js",
    {
      title: "DevTools: Execute JavaScript",
      description:
        "Execute a JavaScript expression in the context of the active tab's page via the Runtime.evaluate CDP method. Supports async/await. This is a dangerous action — it can modify page state.",
      inputSchema: {
        expression: z
          .string()
          .describe("JavaScript expression to evaluate in the page context"),
      },
    },
    async ({ expression }) => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_execute_js",
        { expression: expression.slice(0, 200) },
        async () => {
          const session = getOrCreateSession(tabManager);
          const result = await session.executeJs(expression);
          const parts = [`[${result.type}] ${result.result}`];
          if (result.exceptionDetails) {
            parts.push(`\nException: ${result.exceptionDetails}`);
          }
          return parts.join("");
        },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  server.registerTool(
    "vessel_devtools_get_storage",
    {
      title: "DevTools: Get Storage",
      description:
        "Read browser storage for the active tab's origin. Supports localStorage, sessionStorage, cookies, and IndexedDB database listing.",
      inputSchema: {
        type: z
          .enum(["localStorage", "sessionStorage", "cookie", "indexedDB"])
          .describe("Storage type to read"),
      },
    },
    async ({ type }) => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_get_storage",
        { type },
        async () => {
          const session = getOrCreateSession(tabManager);
          const data = await session.getStorage(type);
          const count = Object.keys(data.entries).length;
          if (count === 0) {
            return `No ${type} entries found for ${data.origin}`;
          }
          return JSON.stringify(data, null, 2);
        },
      );
    },
  );

  server.registerTool(
    "vessel_devtools_set_storage",
    {
      title: "DevTools: Set Storage",
      description:
        "Set or remove a key in localStorage or sessionStorage for the active tab. This is a dangerous action that modifies page state.",
      inputSchema: {
        type: z
          .enum(["localStorage", "sessionStorage"])
          .describe("Storage type to modify"),
        key: z.string().describe("Storage key"),
        value: z
          .string()
          .nullable()
          .describe("Value to set, or null to remove the key"),
      },
    },
    async ({ type, key, value }) => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_set_storage",
        { type, key, value: value ? value.slice(0, 100) : null },
        async () => {
          const session = getOrCreateSession(tabManager);
          return session.setStorage(type, key, value);
        },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Performance
  // ---------------------------------------------------------------------------

  server.registerTool(
    "vessel_devtools_performance",
    {
      title: "DevTools: Performance Snapshot",
      description:
        "Get a performance snapshot for the active tab including navigation timing, paint metrics, memory usage, and resource loading statistics.",
    },
    async () => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_performance",
        {},
        async () => {
          const session = getOrCreateSession(tabManager);
          const snapshot = await session.getPerformanceSnapshot();
          return JSON.stringify(snapshot, null, 2);
        },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  server.registerTool(
    "vessel_devtools_get_errors",
    {
      title: "DevTools: Get Errors",
      description:
        "Get captured JavaScript errors and unhandled promise rejections from the active tab. Automatically starts capturing on first use.",
      inputSchema: {
        type: z
          .enum(["exception", "unhandled-rejection"])
          .optional()
          .describe("Filter by error type"),
        limit: z
          .number()
          .optional()
          .describe("Maximum number of entries to return (default: all)"),
      },
    },
    async ({ type, limit }) => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_get_errors",
        { type, limit },
        async () => {
          const session = getOrCreateSession(tabManager);
          await session.ensureErrorCapture();
          const entries = session.getErrors({ type, limit });
          if (entries.length === 0) {
            return "No errors captured yet. Error monitoring is now active — exceptions and unhandled rejections will be captured as they occur.";
          }
          return JSON.stringify(entries, null, 2);
        },
      );
    },
  );

  server.registerTool(
    "vessel_devtools_clear_errors",
    {
      title: "DevTools: Clear Errors",
      description: "Clear the captured error buffer for the active tab.",
    },
    async () => {
      return withDevToolsAction(
        runtime,
        tabManager,
        "devtools_clear_errors",
        {},
        async () => {
          const session = getOrCreateSession(tabManager);
          const count = session.clearErrors();
          return `Cleared ${count} error entries.`;
        },
      );
    },
  );
}
