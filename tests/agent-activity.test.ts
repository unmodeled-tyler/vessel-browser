import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_RUNNING_STALE_WINDOW_MS,
  getAgentPresence,
  getLatestAgentStatusMessage,
} from "../src/renderer/src/lib/agentActivity";
import type { AgentActionEntry, AgentRuntimeState } from "../src/shared/types";

const NOW = Date.parse("2026-05-11T20:00:00.000Z");

function makeRuntimeState(action: AgentActionEntry): AgentRuntimeState {
  return {
    session: null,
    supervisor: {
      paused: false,
      approvalMode: "confirm-dangerous",
      pendingApprovals: [],
    },
    actions: [action],
    checkpoints: [],
    transcript: [],
    mcpStatus: "stopped",
    flowState: null,
    taskTracker: null,
    canUndo: false,
    undoInfo: null,
  };
}

function makeAction(startedAt: number): AgentActionEntry {
  return {
    id: "action-1",
    source: "mcp",
    name: "create_tab",
    args: {},
    argsSummary: "No arguments",
    status: "running",
    startedAt: new Date(startedAt).toISOString(),
  };
}

test("running actions stop driving the address bar after the stale window", () => {
  const state = makeRuntimeState(
    makeAction(NOW - AGENT_RUNNING_STALE_WINDOW_MS - 1_000),
  );

  assert.equal(getLatestAgentStatusMessage(state, NOW), null);
  assert.equal(getAgentPresence(state, NOW), "idle");
});

test("fresh running actions still show active progress", () => {
  const state = makeRuntimeState(makeAction(NOW - 10_000));

  assert.equal(getLatestAgentStatusMessage(state, NOW), "Create Tab in progress");
  assert.equal(getAgentPresence(state, NOW), "active");
});
