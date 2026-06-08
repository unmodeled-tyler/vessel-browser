/**
 * DevTools types — main-process-only types are defined here.
 * Types shared with the preload/renderer are re-exported from shared/devtools-types.ts.
 */
export type {
  ConsoleEntry,
  NetworkEntry,
  ErrorEntry,
  DevToolsPanelTab,
  DevToolsActivityEntry,
  DevToolsPanelState,
} from "../../shared/devtools-types";

// Types below are only used within the main process.

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