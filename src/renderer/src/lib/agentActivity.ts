import type {
  ActionSource,
  AgentActionEntry,
  AgentRuntimeState,
} from "../../../shared/types";

export const AGENT_ACTIVITY_WINDOW_MS = 6000;

function isAgentActionSource(source: ActionSource): boolean {
  return source === "ai" || source === "mcp";
}

function isAgentActionActive(
  action: AgentActionEntry,
  currentTime: number,
): boolean {
  if (!isAgentActionSource(action.source)) return false;

  if (action.status === "running" || action.status === "waiting-approval") {
    return true;
  }

  if (action.status !== "completed" || !action.finishedAt) {
    return false;
  }

  const finishedAt = new Date(action.finishedAt).getTime();
  if (Number.isNaN(finishedAt)) return false;

  return currentTime - finishedAt < AGENT_ACTIVITY_WINDOW_MS;
}

export function hasRecentAgentActivity(
  state: AgentRuntimeState,
  currentTime = Date.now(),
): boolean {
  return state.actions.some((action) => isAgentActionActive(action, currentTime));
}

export function getAgentActiveTabIds(
  state: AgentRuntimeState,
  currentTime = Date.now(),
): Set<string> {
  const activeTabIds = new Set<string>();

  for (const action of state.actions) {
    if (!action.tabId || !isAgentActionActive(action, currentTime)) {
      continue;
    }

    activeTabIds.add(action.tabId);
  }

  return activeTabIds;
}
