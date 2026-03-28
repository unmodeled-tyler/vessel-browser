import test from "node:test";
import assert from "node:assert/strict";
import {
  appendAutomationActivityChunk,
  finishAutomationActivity,
  MAX_AUTOMATION_ACTIVITY_ENTRIES,
  startAutomationActivity,
} from "../src/renderer/src/stores/ai-activity";
import type { AutomationActivityEntry } from "../src/shared/types";

function makeActivity(id: string): AutomationActivityEntry {
  return {
    id,
    source: "scheduled",
    title: `Job ${id}`,
    status: "running",
    startedAt: "2026-03-27T12:00:00.000Z",
    output: "",
  };
}

test("automation activity keeps newest entries first and trims history", () => {
  let entries: AutomationActivityEntry[] = [];

  for (let index = 0; index < MAX_AUTOMATION_ACTIVITY_ENTRIES + 2; index += 1) {
    entries = startAutomationActivity(entries, makeActivity(String(index)));
  }

  assert.equal(entries.length, MAX_AUTOMATION_ACTIVITY_ENTRIES);
  assert.equal(entries[0]?.id, String(MAX_AUTOMATION_ACTIVITY_ENTRIES + 1));
  assert.equal(entries.at(-1)?.id, "2");
});

test("automation activity appends output and marks completion", () => {
  let entries = startAutomationActivity([], makeActivity("alpha"));
  entries = appendAutomationActivityChunk(entries, "alpha", "step one");
  entries = appendAutomationActivityChunk(entries, "alpha", "\nstep two");
  entries = finishAutomationActivity(
    entries,
    "alpha",
    "completed",
    "2026-03-27T12:02:00.000Z",
  );

  assert.equal(entries[0]?.output, "step one\nstep two");
  assert.equal(entries[0]?.status, "completed");
  assert.equal(entries[0]?.finishedAt, "2026-03-27T12:02:00.000Z");
});
