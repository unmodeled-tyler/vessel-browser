/**
 * DevTools types shared between main process and preload/renderer.
 * Moved from src/main/devtools/types.ts to fix the process boundary —
 * the preload was importing from the main process, which is not allowed
 * in Electron's context isolation model.
 */

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

export type DevToolsPanelTab =
  | "console"
  | "network"
  | "activity"
  | "agentTrace"
  | "pageMap";

export interface DevToolsActivityEntry {
  id: number;
  timestamp: string;
  tool: string;
  args: string;
  result: string;
  durationMs: number;
  status: "running" | "completed" | "failed";
}

export interface DevToolsAgentTraceEntry {
  id: number;
  actionId?: string;
  timestamp: string;
  kind: "tool-start" | "tool-complete" | "tool-error";
  title: string;
  detail: string;
  status: "running" | "completed" | "failed";
  tool?: string;
  durationMs?: number;
}

export interface DevToolsPageMapElement {
  id: number;
  tag: string;
  role?: string;
  label: string;
  selector: string;
  href?: string;
  type?: string;
  visible: boolean;
  interactable: boolean;
  disabled: boolean;
  issue?: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface DevToolsPageMapSnapshot {
  timestamp: string;
  pageUrl: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  counts: {
    total: number;
    visible: number;
    interactable: number;
    disabled: number;
    blocked: number;
  };
  elements: DevToolsPageMapElement[];
  accessIssues: string[];
}

export type DevToolsPageMapRevealStatus =
  | "revealed"
  | "not-found"
  | "invalid-selector"
  | "no-active-tab";

export interface DevToolsPanelState {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  errors: ErrorEntry[];
  activity: DevToolsActivityEntry[];
  agentTrace: DevToolsAgentTraceEntry[];
  pageMap: DevToolsPageMapSnapshot | null;
}

export interface DevToolsPanelHostState {
  open: boolean;
  detached: boolean;
  height: number;
}
