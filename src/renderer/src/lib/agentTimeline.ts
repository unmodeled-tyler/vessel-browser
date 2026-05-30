import type {
  AgentActionEntry,
  AgentRuntimeState,
  AgentTranscriptEntry,
} from "../../../shared/types";

export type AgentTimelineItem =
  | {
      id: string;
      type: "transcript";
      timestamp: string;
      status: AgentTranscriptEntry["status"];
      kind: AgentTranscriptEntry["kind"];
      label: string;
      detail: string;
    }
  | {
      id: string;
      type: "action";
      timestamp: string;
      status: AgentActionEntry["status"];
      kind: "action";
      label: string;
      detail: string;
      durationMs?: number;
    };

export function formatAgentActionName(name: string): string {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function summarizeAgentAction(action: AgentActionEntry): string {
  if (action.status === "waiting-approval") {
    return action.argsSummary || "Waiting for approval";
  }
  if (action.status === "running") {
    return action.argsSummary || "Running";
  }
  if (action.status === "failed") {
    return action.error || action.resultSummary || "Action failed";
  }
  return action.resultSummary || action.argsSummary || "Completed";
}

export function formatAgentTimelineDuration(
  durationMs?: number,
): string | null {
  if (!durationMs || durationMs < 1) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

export function buildAgentTimelineItems(
  state: AgentRuntimeState,
  limit = 12,
): AgentTimelineItem[] {
  const transcriptItems: AgentTimelineItem[] = state.transcript.map((entry) => ({
    id: `transcript:${entry.id}`,
    type: "transcript",
    timestamp: entry.updatedAt,
    status: entry.status,
    kind: entry.kind,
    label: entry.title || entry.kind,
    detail: entry.text,
  }));
  const actionItems: AgentTimelineItem[] = state.actions.map((action) => ({
    id: `action:${action.id}`,
    type: "action",
    timestamp: action.finishedAt || action.startedAt,
    status: action.status,
    kind: "action",
    label: formatAgentActionName(action.name),
    detail: summarizeAgentAction(action),
    durationMs: action.durationMs,
  }));

  return [...transcriptItems, ...actionItems]
    .sort(
      (left, right) =>
        new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
    )
    .slice(0, limit);
}

export function isLiveAgentTimelineItem(item: AgentTimelineItem): boolean {
  return item.status === "streaming" || item.status === "running";
}
