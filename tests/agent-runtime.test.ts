import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { app } from "electron";
import {
  AgentRuntime,
  type AgentRuntimeActionLifecycleEvent,
} from "../src/main/agent/runtime";
import { executeAction } from "../src/main/ai/page-actions/orchestrator";
import { setSetting } from "../src/main/config/settings";
import type { TabGroupColor } from "../src/shared/types";
import type { SessionSnapshot } from "../src/shared/types";

function makeRuntime(): AgentRuntime {
  const tabManager = {
    snapshotSession: (): SessionSnapshot => ({ tabs: [], activeTabId: null }),
    restoreSession: () => {},
  };
  return new AgentRuntime(tabManager as never);
}

test("updateCheckpointNote updates the matching checkpoint by id", async () => {
  const statePath = path.join(app.getPath("userData"), "vessel-agent-runtime.json");
  await fs.rm(statePath, { force: true });

  const runtime = makeRuntime();
  const checkpoint = runtime.createCheckpoint("Before risky flow", "old note");

  const updated = runtime.updateCheckpointNote(checkpoint.id, "new note");

  assert.ok(updated);
  assert.equal(updated.id, checkpoint.id);
  assert.equal(updated.note, "new note");
  assert.equal(runtime.getState().checkpoints[0]?.note, "new note");
});

test("auto approval mode bypasses explicitly approval-gated actions", async () => {
  const runtime = makeRuntime();
  runtime.setApprovalMode("auto");

  const result = await runtime.runControlledAction({
    source: "ai",
    name: "navigate",
    dangerous: true,
    requiresApproval: true,
    executor: async () => "navigated",
  });

  assert.equal(result, "navigated");
  assert.equal(runtime.getState().supervisor.pendingApprovals.length, 0);
  assert.equal(runtime.getState().actions[0]?.status, "completed");
});

test("confirm-dangerous still pauses explicitly approval-gated actions", async () => {
  const runtime = makeRuntime();
  runtime.setApprovalMode("confirm-dangerous");

  const resultPromise = runtime.runControlledAction({
    source: "ai",
    name: "navigate",
    dangerous: true,
    requiresApproval: true,
    executor: async () => "navigated",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const approval = runtime.getState().supervisor.pendingApprovals[0];
  assert.ok(approval);
  assert.equal(runtime.getState().actions[0]?.status, "waiting-approval");

  runtime.resolveApproval(approval.id, true);
  assert.equal(await resultPromise, "navigated");
});

test("paused supervisor still requires approval even in auto mode", async () => {
  const runtime = makeRuntime();
  runtime.setApprovalMode("auto");
  runtime.pause();

  const resultPromise = runtime.runControlledAction({
    source: "ai",
    name: "read_page",
    executor: async () => "read",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const approval = runtime.getState().supervisor.pendingApprovals[0];
  assert.ok(approval);
  assert.match(approval.reason, /paused/i);

  runtime.resolveApproval(approval.id, false);
  assert.equal(await resultPromise, "Action rejected: read_page");
});

test("runControlledAction emits lifecycle events for agent tools", async () => {
  const runtime = makeRuntime();
  const events: AgentRuntimeActionLifecycleEvent[] = [];
  runtime.setActionLifecycleListener((event) => events.push(event));

  const result = await runtime.runControlledAction({
    source: "ai",
    name: "read_page",
    args: { mode: "results_only" },
    tabId: "tab-1",
    executor: async () => "page text",
  });

  assert.equal(result, "page text");
  assert.equal(events.length, 2);
  assert.equal(events[0].phase, "started");
  assert.equal(events[0].name, "read_page");
  assert.equal(events[0].source, "ai");
  assert.equal(events[0].detail, "mode=results_only");
  assert.equal(events[1].phase, "completed");
  assert.equal(events[1].detail, "page text");
  assert.equal(events[1].actionId, events[0].actionId);
  assert.equal(typeof events[1].durationMs, "number");
});

test("advertised API group tools dispatch to tab group operations", async () => {
  setSetting("telemetryEnabled", false);
  const runtime = makeRuntime();
  const groups = [{ id: "group-1", name: "Research", color: "blue" as TabGroupColor, collapsed: false }];
  const tabs = [{ id: "tab-1", title: "Docs", url: "https://example.test", groupId: "group-1" }];
  const colorChanges: Array<{ groupId: string; color: TabGroupColor }> = [];
  const tabManager = {
    getActiveTab: () => null,
    getActiveTabId: () => null,
    getGroups: () => groups,
    getAllStates: () => tabs,
    createGroupFromTab: () => "group-created",
    assignTabToGroup: () => undefined,
    removeTabFromGroup: () => undefined,
    toggleGroupCollapsed: () => false,
    setGroupColor: (groupId: string, color: TabGroupColor) => {
      colorChanges.push({ groupId, color });
    },
  };

  assert.match(
    await executeAction("list_groups", {}, { runtime, tabManager: tabManager as never }),
    /\[group-1\] Research/,
  );
  assert.equal(
    await executeAction(
      "set_group_color",
      { groupId: "group-1", color: "green" },
      { runtime, tabManager: tabManager as never },
    ),
    "Set group group-1 color to green",
  );
  assert.deepEqual(colorChanges, [{ groupId: "group-1", color: "green" }]);
  assert.notEqual(
    await executeAction("toggle_group", { groupId: "group-1" }, { runtime, tabManager: tabManager as never }),
    "Unknown tool: toggle_group",
  );
});
