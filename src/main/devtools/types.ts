export interface ConsoleEntry {
  id: number;
  timestamp: string;
  level: "log" | "warning" | "error" | "info" | "debug" | "verbose";
  text: string;
  url?: string;
  line?: number;
  column?: number;
  stackTrace?: string;
}

export interface NetworkEntry {
  id: number;
  requestId: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
  contentLength?: number;
  timing?: {
    startTime: number;
    endTime?: number;
    durationMs?: number;
  };
  error?: string;
  fromCache?: boolean;
}

export interface DomNodeInfo {
  nodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  attributes: Record<string, string>;
  childCount: number;
  innerText?: string;
  innerHTML?: string;
  outerHTML?: string;
}

export interface ComputedStyle {
  property: string;
  value: string;
}

export interface StorageData {
  type: "localStorage" | "sessionStorage" | "cookie" | "indexedDB";
  origin: string;
  entries: Record<string, string>;
}

export interface PerformanceSnapshot {
  timestamp: string;
  pageUrl: string;
  timing: {
    navigationStart?: number;
    domContentLoaded?: number;
    loadComplete?: number;
    firstPaint?: number;
    firstContentfulPaint?: number;
  };
  memory?: {
    jsHeapSizeLimit: number;
    totalJSHeapSize: number;
    usedJSHeapSize: number;
  };
  resources: {
    total: number;
    byType: Record<string, number>;
    totalTransferSize: number;
    totalDecodedSize: number;
  };
}

export interface ErrorEntry {
  id: number;
  timestamp: string;
  type: "exception" | "unhandled-rejection";
  message: string;
  description?: string;
  url?: string;
  line?: number;
  column?: number;
  stackTrace?: string;
}

export type DevToolsPanelTab = "console" | "network" | "activity";

export interface DevToolsActivityEntry {
  id: number;
  timestamp: string;
  tool: string;
  args: string;
  result: string;
  durationMs: number;
  status: "running" | "completed" | "failed";
}

export interface DevToolsPanelState {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  errors: ErrorEntry[];
  activity: DevToolsActivityEntry[];
}
