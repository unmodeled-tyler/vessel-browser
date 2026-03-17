import type { WebContents } from "electron";
import type {
  ConsoleEntry,
  ComputedStyle,
  DomNodeInfo,
  ErrorEntry,
  NetworkEntry,
  PerformanceSnapshot,
  StorageData,
} from "./types";

const MAX_CONSOLE_ENTRIES = 500;
const MAX_NETWORK_ENTRIES = 200;
const MAX_ERROR_ENTRIES = 200;

const MAX_PENDING_REQUESTS = 500;

export class DevToolsSession {
  private attached = false;
  private attachingPromise: Promise<void> | null = null;
  private consoleDomainEnabled = false;
  private networkDomainEnabled = false;
  private cssDomainEnabled = false;
  private runtimeExceptionsEnabled = false;

  private consoleBuffer: ConsoleEntry[] = [];
  private networkBuffer: NetworkEntry[] = [];
  private errorBuffer: ErrorEntry[] = [];
  private entryCounter = 0;

  // Track in-flight network requests for matching response data
  private pendingRequests = new Map<
    string,
    { entry: NetworkEntry }
  >();

  // Named handlers so we can remove them on detach/destroy (fixes listener leak)
  private readonly onDetach = () => {
    this.attached = false;
    this.consoleDomainEnabled = false;
    this.networkDomainEnabled = false;
    this.cssDomainEnabled = false;
    this.runtimeExceptionsEnabled = false;
    this.pendingRequests.clear();
  };

  private readonly onMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => {
    this.handleCdpEvent(method, params);
  };

  constructor(
    readonly tabId: string,
    private readonly wc: WebContents,
  ) {}

  get isAttached(): boolean {
    return this.attached;
  }

  async ensureAttached(): Promise<void> {
    if (this.attached) return;
    // Serialize concurrent attach calls to prevent duplicate listeners
    if (this.attachingPromise) return this.attachingPromise;
    this.attachingPromise = this.doAttach().finally(() => {
      this.attachingPromise = null;
    });
    return this.attachingPromise;
  }

  private async doAttach(): Promise<void> {
    if (this.attached) return;
    if (this.wc.isDestroyed()) {
      throw new Error("WebContents is destroyed");
    }
    try {
      this.wc.debugger.attach("1.3");
    } catch (err) {
      // Already attached is fine
      if (
        !(err instanceof Error) ||
        !err.message.includes("Already attached")
      ) {
        throw err;
      }
    }
    this.attached = true;
    this.wc.debugger.on("detach", this.onDetach);
    this.wc.debugger.on("message", this.onMessage);
  }

  private removeListeners(): void {
    try {
      this.wc.debugger.removeListener("detach", this.onDetach);
      this.wc.debugger.removeListener("message", this.onMessage);
    } catch {
      // WebContents may already be destroyed
    }
  }

  detach(): void {
    if (!this.attached) {
      this.removeListeners();
      return;
    }
    this.removeListeners();
    try {
      this.wc.debugger.detach();
    } catch {
      // Already detached
    }
    this.attached = false;
    this.consoleDomainEnabled = false;
    this.networkDomainEnabled = false;
    this.cssDomainEnabled = false;
    this.runtimeExceptionsEnabled = false;
    this.pendingRequests.clear();
  }

  destroy(): void {
    this.detach();
    this.consoleBuffer = [];
    this.networkBuffer = [];
    this.errorBuffer = [];
    this.pendingRequests.clear();
  }

  // ---------------------------------------------------------------------------
  // Console
  // ---------------------------------------------------------------------------

  async ensureConsoleDomain(): Promise<void> {
    await this.ensureAttached();
    if (this.consoleDomainEnabled) return;
    await this.cdpSend("Console.enable");
    await this.cdpSend("Runtime.enable");
    this.consoleDomainEnabled = true;
  }

  getConsoleLogs(options?: {
    level?: string;
    limit?: number;
    search?: string;
  }): ConsoleEntry[] {
    let entries = this.consoleBuffer;
    if (options?.level) {
      entries = entries.filter((e) => e.level === options.level);
    }
    if (options?.search) {
      const term = options.search.toLowerCase();
      entries = entries.filter((e) => e.text.toLowerCase().includes(term));
    }
    if (options?.limit && options.limit > 0) {
      entries = entries.slice(-options.limit);
    }
    return entries;
  }

  clearConsoleLogs(): number {
    const count = this.consoleBuffer.length;
    this.consoleBuffer = [];
    return count;
  }

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  async ensureNetworkDomain(): Promise<void> {
    await this.ensureAttached();
    if (this.networkDomainEnabled) return;
    await this.cdpSend("Network.enable", {
      maxTotalBufferSize: 10 * 1024 * 1024,
      maxResourceBufferSize: 5 * 1024 * 1024,
    });
    this.networkDomainEnabled = true;
  }

  getNetworkLog(options?: {
    urlPattern?: string;
    method?: string;
    statusRange?: { min?: number; max?: number };
    limit?: number;
  }): NetworkEntry[] {
    let entries = this.networkBuffer;
    if (options?.urlPattern) {
      try {
        const regex = new RegExp(options.urlPattern, "i");
        entries = entries.filter((e) => regex.test(e.url));
      } catch {
        const term = options.urlPattern.toLowerCase();
        entries = entries.filter((e) => e.url.toLowerCase().includes(term));
      }
    }
    if (options?.method) {
      const method = options.method.toUpperCase();
      entries = entries.filter((e) => e.method === method);
    }
    if (options?.statusRange) {
      const min = options.statusRange.min ?? 0;
      const max = options.statusRange.max ?? 999;
      entries = entries.filter(
        (e) => e.status != null && e.status >= min && e.status <= max,
      );
    }
    if (options?.limit && options.limit > 0) {
      entries = entries.slice(-options.limit);
    }
    return entries;
  }

  async getNetworkResponseBody(
    requestId: string,
  ): Promise<{ body: string; base64Encoded: boolean } | { error: string }> {
    await this.ensureNetworkDomain();
    try {
      const result = await this.cdpSend("Network.getResponseBody", {
        requestId,
      });
      return {
        body: result.body as string,
        base64Encoded: result.base64Encoded as boolean,
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Failed to get body",
      };
    }
  }

  clearNetworkLog(): number {
    const count = this.networkBuffer.length;
    this.networkBuffer = [];
    this.pendingRequests.clear();
    return count;
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  async queryDom(
    selector: string,
    options?: { includeHtml?: boolean },
  ): Promise<DomNodeInfo[]> {
    await this.ensureAttached();
    const doc = await this.cdpSend("DOM.getDocument", { depth: 0 });
    const rootNodeId = doc.root.nodeId as number;

    const result = await this.cdpSend("DOM.querySelectorAll", {
      nodeId: rootNodeId,
      selector,
    });
    const nodeIds = result.nodeIds as number[];
    if (!nodeIds || nodeIds.length === 0) return [];

    const nodes: DomNodeInfo[] = [];
    for (const nodeId of nodeIds.slice(0, 50)) {
      try {
        const desc = await this.cdpSend("DOM.describeNode", {
          nodeId,
          depth: 0,
        });
        const node = desc.node as Record<string, unknown>;
        const attrs: Record<string, string> = {};
        const rawAttrs = node.attributes as string[] | undefined;
        if (rawAttrs) {
          for (let i = 0; i < rawAttrs.length; i += 2) {
            attrs[rawAttrs[i]] = rawAttrs[i + 1];
          }
        }

        const info: DomNodeInfo = {
          nodeId,
          nodeType: node.nodeType as number,
          nodeName: node.nodeName as string,
          localName: node.localName as string,
          attributes: attrs,
          childCount: (node.childNodeCount as number) ?? 0,
        };

        if (options?.includeHtml) {
          try {
            const html = await this.cdpSend("DOM.getOuterHTML", { nodeId });
            const outer = html.outerHTML as string;
            info.outerHTML = outer.length > 5000 ? outer.slice(0, 5000) + "..." : outer;
          } catch {
            // Some nodes may not support getOuterHTML
          }
        }

        nodes.push(info);
      } catch {
        // Skip nodes that fail to describe (e.g., stale nodeIds)
      }
    }
    return nodes;
  }

  async ensureCssDomain(): Promise<void> {
    await this.ensureAttached();
    if (this.cssDomainEnabled) return;
    await this.cdpSend("CSS.enable");
    this.cssDomainEnabled = true;
  }

  async getComputedStyles(
    selector: string,
    properties?: string[],
  ): Promise<ComputedStyle[]> {
    await this.ensureAttached();
    await this.ensureCssDomain();
    const doc = await this.cdpSend("DOM.getDocument", { depth: 0 });
    const result = await this.cdpSend("DOM.querySelector", {
      nodeId: doc.root.nodeId as number,
      selector,
    });
    const nodeId = result.nodeId as number;
    if (!nodeId) throw new Error(`No element found for selector: ${selector}`);

    const computed = await this.cdpSend("CSS.getComputedStyleForNode", {
      nodeId,
    });
    let styles = (computed.computedStyle as Array<{ name: string; value: string }>) ?? [];
    if (properties && properties.length > 0) {
      const propSet = new Set(properties.map((p) => p.toLowerCase()));
      styles = styles.filter((s) => propSet.has(s.name.toLowerCase()));
    }
    return styles.map((s) => ({ property: s.name, value: s.value }));
  }

  async modifyDomAttribute(
    selector: string,
    name: string,
    value: string | null,
  ): Promise<string> {
    await this.ensureAttached();
    const selectorJson = JSON.stringify(selector);
    const nameJson = JSON.stringify(name);
    const expression =
      value === null
        ? `(function(){var el=document.querySelector(${selectorJson});if(!el)throw new Error('No element found for selector: '+${selectorJson});el.removeAttribute(${nameJson});return true;})()`
        : `(function(){var el=document.querySelector(${selectorJson});if(!el)throw new Error('No element found for selector: '+${selectorJson});el.setAttribute(${nameJson},${JSON.stringify(value)});return true;})()`;

    const response = await this.cdpSend("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });

    if (response.exceptionDetails) {
      const ex = response.exceptionDetails as Record<string, unknown>;
      const desc =
        (ex.exception as Record<string, unknown>)?.description ??
        (ex.exception as Record<string, unknown>)?.value ??
        "Failed to modify DOM";
      throw new Error(String(desc));
    }

    if (value === null) {
      return `Removed attribute "${name}" from ${selector}`;
    }
    return `Set ${selector} ${name}="${value}"`;
  }

  // ---------------------------------------------------------------------------
  // JavaScript Execution
  // ---------------------------------------------------------------------------

  async executeJs(expression: string): Promise<{
    result: string;
    type: string;
    exceptionDetails?: string;
  }> {
    await this.ensureAttached();
    const response = await this.cdpSend("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      generatePreview: true,
      timeout: 10000,
    });

    const result = response.result as Record<string, unknown>;
    const exceptionDetails = response.exceptionDetails as
      | Record<string, unknown>
      | undefined;

    let resultText: string;
    if (result.type === "undefined") {
      resultText = "undefined";
    } else if (result.value !== undefined) {
      resultText =
        typeof result.value === "string"
          ? result.value
          : JSON.stringify(result.value, null, 2);
    } else if (result.description) {
      resultText = result.description as string;
    } else {
      resultText = String(result.type);
    }

    return {
      result: resultText.length > 10000
        ? resultText.slice(0, 10000) + "..."
        : resultText,
      type: result.type as string,
      exceptionDetails: exceptionDetails
        ? formatExceptionDetails(exceptionDetails)
        : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  async getStorage(
    type: "localStorage" | "sessionStorage" | "cookie" | "indexedDB",
  ): Promise<StorageData> {
    // Storage is best accessed via executeJavaScript since CDP storage
    // domains require security origins and are more complex
    const origin = this.wc.getURL();

    if (type === "cookie") {
      const cookies = await this.wc.session.cookies.get({
        url: origin,
      });
      const entries: Record<string, string> = {};
      for (const cookie of cookies) {
        entries[cookie.name] = cookie.value;
      }
      return { type, origin, entries };
    }

    if (type === "indexedDB") {
      const result = await this.wc.executeJavaScript(`
        (async function() {
          try {
            const dbs = await indexedDB.databases();
            const entries = {};
            for (const db of dbs) {
              entries[db.name || '(unnamed)'] = 'version=' + (db.version || '?');
            }
            return entries;
          } catch(e) { return { __error: e.message }; }
        })()
      `);
      if (result?.__error) throw new Error(result.__error);
      return { type, origin, entries: result ?? {} };
    }

    // localStorage / sessionStorage
    const storageType = type === "localStorage" ? "localStorage" : "sessionStorage";
    const result = await this.wc.executeJavaScript(`
      (function() {
        try {
          const storage = window.${storageType};
          const entries = {};
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            entries[key] = storage.getItem(key);
          }
          return entries;
        } catch(e) { return { __error: e.message }; }
      })()
    `);
    if (result?.__error) throw new Error(result.__error);
    return { type, origin, entries: result ?? {} };
  }

  async setStorage(
    type: "localStorage" | "sessionStorage",
    key: string,
    value: string | null,
  ): Promise<string> {
    const storageType = type === "localStorage" ? "localStorage" : "sessionStorage";
    if (value === null) {
      await this.wc.executeJavaScript(
        `window.${storageType}.removeItem(${JSON.stringify(key)})`,
      );
      return `Removed "${key}" from ${type}`;
    }
    await this.wc.executeJavaScript(
      `window.${storageType}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
    );
    return `Set ${type}["${key}"] = ${value.length > 80 ? value.slice(0, 77) + "..." : value}`;
  }

  // ---------------------------------------------------------------------------
  // Performance
  // ---------------------------------------------------------------------------

  async getPerformanceSnapshot(): Promise<PerformanceSnapshot> {
    const url = this.wc.getURL();
    const perf = await this.wc.executeJavaScript(`
      (function() {
        const nav = performance.getEntriesByType('navigation')[0] || {};
        const paint = performance.getEntriesByType('paint') || [];
        const resources = performance.getEntriesByType('resource') || [];
        const fp = paint.find(p => p.name === 'first-paint');
        const fcp = paint.find(p => p.name === 'first-contentful-paint');

        const byType = {};
        let totalTransfer = 0;
        let totalDecoded = 0;
        for (const r of resources) {
          const type = r.initiatorType || 'other';
          byType[type] = (byType[type] || 0) + 1;
          totalTransfer += r.transferSize || 0;
          totalDecoded += r.decodedBodySize || 0;
        }

        let memory = null;
        if (performance.memory) {
          memory = {
            jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
            usedJSHeapSize: performance.memory.usedJSHeapSize,
          };
        }

        return {
          timing: {
            navigationStart: nav.startTime || 0,
            domContentLoaded: nav.domContentLoadedEventEnd || null,
            loadComplete: nav.loadEventEnd || null,
            firstPaint: fp ? fp.startTime : null,
            firstContentfulPaint: fcp ? fcp.startTime : null,
          },
          memory: memory,
          resources: {
            total: resources.length,
            byType: byType,
            totalTransferSize: totalTransfer,
            totalDecodedSize: totalDecoded,
          },
        };
      })()
    `);

    return {
      timestamp: new Date().toISOString(),
      pageUrl: url,
      timing: perf.timing ?? {},
      memory: perf.memory ?? undefined,
      resources: perf.resources ?? { total: 0, byType: {}, totalTransferSize: 0, totalDecodedSize: 0 },
    };
  }

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  async ensureErrorCapture(): Promise<void> {
    await this.ensureAttached();
    if (this.runtimeExceptionsEnabled) return;
    await this.cdpSend("Runtime.enable");
    await this.cdpSend("Runtime.setAsyncCallStackDepth", { maxDepth: 8 });
    this.runtimeExceptionsEnabled = true;
  }

  getErrors(options?: { limit?: number; type?: string }): ErrorEntry[] {
    let entries = this.errorBuffer;
    if (options?.type) {
      entries = entries.filter((e) => e.type === options.type);
    }
    if (options?.limit && options.limit > 0) {
      entries = entries.slice(-options.limit);
    }
    return entries;
  }

  clearErrors(): number {
    const count = this.errorBuffer.length;
    this.errorBuffer = [];
    return count;
  }

  // ---------------------------------------------------------------------------
  // CDP helpers
  // ---------------------------------------------------------------------------

  private async cdpSend(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.attached || this.wc.isDestroyed()) {
      throw new Error("DevTools session is not attached");
    }
    return this.wc.debugger.sendCommand(method, params) as Promise<
      Record<string, unknown>
    >;
  }

  private handleCdpEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "Console.messageAdded":
        this.onConsoleMessage(params);
        break;
      case "Runtime.consoleAPICalled":
        this.onRuntimeConsoleApi(params);
        break;
      case "Runtime.exceptionThrown":
        this.onExceptionThrown(params);
        break;
      case "Network.requestWillBeSent":
        this.onNetworkRequest(params);
        break;
      case "Network.responseReceived":
        this.onNetworkResponse(params);
        break;
      case "Network.loadingFinished":
        this.onNetworkFinished(params);
        break;
      case "Network.loadingFailed":
        this.onNetworkFailed(params);
        break;
    }
  }

  // --- Console events ---

  private onConsoleMessage(params: Record<string, unknown>): void {
    const message = params.message as Record<string, unknown> | undefined;
    if (!message) return;
    this.pushConsoleEntry({
      level: mapConsoleLevel(message.level as string),
      text: (message.text as string) ?? "",
      url: message.url as string | undefined,
      line: message.line as number | undefined,
      column: message.column as number | undefined,
    });
  }

  private onRuntimeConsoleApi(params: Record<string, unknown>): void {
    const type = params.type as string;
    const args = params.args as Array<Record<string, unknown>> | undefined;
    const trace = params.stackTrace as Record<string, unknown> | undefined;

    const textParts: string[] = [];
    if (args) {
      for (const arg of args) {
        if (arg.value !== undefined) {
          textParts.push(
            typeof arg.value === "string"
              ? arg.value
              : JSON.stringify(arg.value),
          );
        } else if (arg.description) {
          textParts.push(arg.description as string);
        } else {
          textParts.push(`[${arg.type}]`);
        }
      }
    }

    let url: string | undefined;
    let line: number | undefined;
    let column: number | undefined;
    const callFrames = trace?.callFrames as
      | Array<Record<string, unknown>>
      | undefined;
    if (callFrames && callFrames.length > 0) {
      url = callFrames[0].url as string | undefined;
      line = callFrames[0].lineNumber as number | undefined;
      column = callFrames[0].columnNumber as number | undefined;
    }

    this.pushConsoleEntry({
      level: mapConsoleLevel(type),
      text: textParts.join(" "),
      url,
      line,
      column,
      stackTrace: callFrames ? formatCallFrames(callFrames) : undefined,
    });
  }

  private pushConsoleEntry(
    data: Omit<ConsoleEntry, "id" | "timestamp">,
  ): void {
    const entry: ConsoleEntry = {
      id: ++this.entryCounter,
      timestamp: new Date().toISOString(),
      ...data,
    };
    this.consoleBuffer.push(entry);
    if (this.consoleBuffer.length > MAX_CONSOLE_ENTRIES) {
      this.consoleBuffer = this.consoleBuffer.slice(-MAX_CONSOLE_ENTRIES);
    }
  }

  // --- Network events ---

  private onNetworkRequest(params: Record<string, unknown>): void {
    const requestId = params.requestId as string;
    const request = params.request as Record<string, unknown>;
    const type = params.type as string | undefined;
    const timestamp = params.timestamp as number | undefined;

    const entry: NetworkEntry = {
      id: ++this.entryCounter,
      requestId,
      timestamp: new Date().toISOString(),
      method: (request.method as string) ?? "GET",
      url: (request.url as string) ?? "",
      resourceType: type,
      requestHeaders: request.headers as Record<string, string> | undefined,
      timing: {
        startTime: timestamp ?? Date.now() / 1000,
      },
    };

    this.networkBuffer.push(entry);
    if (this.networkBuffer.length > MAX_NETWORK_ENTRIES) {
      this.networkBuffer = this.networkBuffer.slice(-MAX_NETWORK_ENTRIES);
    }

    // Cap pending requests to prevent unbounded growth from cancelled requests
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      const oldest = this.pendingRequests.keys().next().value;
      if (oldest !== undefined) this.pendingRequests.delete(oldest);
    }
    this.pendingRequests.set(requestId, { entry });
  }

  private onNetworkResponse(params: Record<string, unknown>): void {
    const requestId = params.requestId as string;
    const response = params.response as Record<string, unknown>;
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    pending.entry.status = response.status as number;
    pending.entry.statusText = response.statusText as string | undefined;
    pending.entry.mimeType = response.mimeType as string | undefined;
    pending.entry.responseHeaders = response.headers as
      | Record<string, string>
      | undefined;
    pending.entry.fromCache = response.fromDiskCache === true ||
      response.fromServiceWorker === true;

    const contentLength = response.headers
      ? ((response.headers as Record<string, string>)["content-length"] ??
        (response.headers as Record<string, string>)["Content-Length"])
      : undefined;
    if (contentLength) {
      pending.entry.contentLength = parseInt(contentLength, 10) || undefined;
    }
  }

  private onNetworkFinished(params: Record<string, unknown>): void {
    const requestId = params.requestId as string;
    const timestamp = params.timestamp as number | undefined;
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    if (timestamp && pending.entry.timing) {
      pending.entry.timing.endTime = timestamp;
      pending.entry.timing.durationMs = Math.round(
        (timestamp - pending.entry.timing.startTime) * 1000,
      );
    }
    pending.entry.contentLength =
      pending.entry.contentLength ??
      ((params.encodedDataLength as number) || undefined);
    this.pendingRequests.delete(requestId);
  }

  private onNetworkFailed(params: Record<string, unknown>): void {
    const requestId = params.requestId as string;
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    pending.entry.error =
      (params.errorText as string) ?? "Request failed";
    const timestamp = params.timestamp as number | undefined;
    if (timestamp && pending.entry.timing) {
      pending.entry.timing.endTime = timestamp;
      pending.entry.timing.durationMs = Math.round(
        (timestamp - pending.entry.timing.startTime) * 1000,
      );
    }
    this.pendingRequests.delete(requestId);
  }

  // --- Error events ---

  private onExceptionThrown(params: Record<string, unknown>): void {
    const details = params.exceptionDetails as Record<string, unknown>;
    if (!details) return;

    const exception = details.exception as Record<string, unknown> | undefined;
    const trace = details.stackTrace as Record<string, unknown> | undefined;
    const callFrames = trace?.callFrames as
      | Array<Record<string, unknown>>
      | undefined;

    // Detect unhandled promise rejections from the exception text/description
    const text = (details.text as string) ?? "Unknown error";
    const desc = exception?.description as string | undefined;
    const isUnhandledRejection =
      text.includes("Unhandled") ||
      text.includes("promise") ||
      (desc != null && (desc.includes("Unhandled") || desc.includes("promise rejection")));

    const entry: ErrorEntry = {
      id: ++this.entryCounter,
      timestamp: new Date().toISOString(),
      type: isUnhandledRejection ? "unhandled-rejection" : "exception",
      message: text,
      description: desc,
      url: details.url as string | undefined,
      line: details.lineNumber as number | undefined,
      column: details.columnNumber as number | undefined,
      stackTrace: callFrames ? formatCallFrames(callFrames) : undefined,
    };

    this.errorBuffer.push(entry);
    if (this.errorBuffer.length > MAX_ERROR_ENTRIES) {
      this.errorBuffer = this.errorBuffer.slice(-MAX_ERROR_ENTRIES);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapConsoleLevel(
  level: string,
): ConsoleEntry["level"] {
  switch (level) {
    case "warning":
    case "warn":
      return "warning";
    case "error":
      return "error";
    case "info":
      return "info";
    case "debug":
      return "debug";
    case "verbose":
    case "trace":
      return "verbose";
    default:
      return "log";
  }
}

function formatCallFrames(
  frames: Array<Record<string, unknown>>,
): string {
  return frames
    .slice(0, 10)
    .map((f) => {
      const fn = (f.functionName as string) || "(anonymous)";
      const url = f.url as string;
      const line = f.lineNumber as number;
      const col = f.columnNumber as number;
      return `  at ${fn} (${url}:${line}:${col})`;
    })
    .join("\n");
}

function formatExceptionDetails(
  details: Record<string, unknown>,
): string {
  const text = details.text as string | undefined;
  const exception = details.exception as Record<string, unknown> | undefined;
  const desc = exception?.description as string | undefined;
  return desc || text || "Unknown exception";
}
