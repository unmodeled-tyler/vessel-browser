import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { app } from "electron";
import { AgentRuntime } from "../src/main/agent/runtime";
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
