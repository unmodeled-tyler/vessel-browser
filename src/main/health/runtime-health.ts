import type {
  McpConnectionStatus,
  RuntimeHealthIssue,
  RuntimeHealthState,
} from "../../shared/types";

type McpStatusChangeListener = (status: McpConnectionStatus) => void;
type RuntimeHealthChangeListener = (state: RuntimeHealthState) => void;
const mcpStatusChangeListeners = new Set<McpStatusChangeListener>();
const runtimeHealthChangeListeners = new Set<RuntimeHealthChangeListener>();

export function onMcpStatusChange(
  listener: McpStatusChangeListener,
): () => void {
  mcpStatusChangeListeners.add(listener);
  return () => {
    mcpStatusChangeListeners.delete(listener);
  };
}

export function onRuntimeHealthChange(
  listener: RuntimeHealthChangeListener,
): () => void {
  runtimeHealthChangeListeners.add(listener);
  return () => {
    runtimeHealthChangeListeners.delete(listener);
  };
}

export function getMcpStatus(): McpConnectionStatus {
  return state.mcp.status;
}

function emitRuntimeHealthChange(): void {
  const snapshot = getRuntimeHealth();
  for (const listener of runtimeHealthChangeListeners) {
    listener(snapshot);
  }
}

const state: RuntimeHealthState = {
  userDataPath: "",
  settingsPath: "",
  startupIssues: [],
  mcp: {
    configuredPort: 3100,
    activePort: null,
    endpoint: null,
    status: "stopped",
    message: "MCP server has not started yet.",
  },
};

export function initializeRuntimeHealth(paths: {
  userDataPath: string;
  settingsPath: string;
  configuredPort: number;
}): void {
  state.userDataPath = paths.userDataPath;
  state.settingsPath = paths.settingsPath;
  state.mcp.configuredPort = paths.configuredPort;
  state.mcp.activePort = null;
  state.mcp.endpoint = null;
  state.mcp.status = "stopped";
  state.mcp.message = "MCP server has not started yet.";
  emitRuntimeHealthChange();
}

export function setStartupIssues(issues: RuntimeHealthIssue[]): void {
  state.startupIssues = issues.map((issue) => ({ ...issue }));
  emitRuntimeHealthChange();
}

export function getRuntimeHealth(): RuntimeHealthState {
  return {
    userDataPath: state.userDataPath,
    settingsPath: state.settingsPath,
    startupIssues: state.startupIssues.map((issue) => ({ ...issue })),
    mcp: { ...state.mcp },
  };
}

export function setMcpHealth(update: {
  configuredPort?: number;
  activePort?: number | null;
  endpoint?: string | null;
  status: RuntimeHealthState["mcp"]["status"];
  message: string;
}): void {
  if (typeof update.configuredPort === "number") {
    state.mcp.configuredPort = update.configuredPort;
  }
  if ("activePort" in update) {
    state.mcp.activePort = update.activePort ?? null;
  }
  if ("endpoint" in update) {
    state.mcp.endpoint = update.endpoint ?? null;
  }
  const prevStatus = state.mcp.status;
  state.mcp.status = update.status;
  state.mcp.message = update.message;
  if (prevStatus !== state.mcp.status) {
    for (const listener of mcpStatusChangeListeners) {
      listener(state.mcp.status);
    }
  }
  emitRuntimeHealthChange();
}
