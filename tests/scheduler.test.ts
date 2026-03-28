import assert from "node:assert/strict";
import test from "node:test";

import {
  isValidScheduleConfig,
  normalizeScheduledJob,
} from "../src/main/automation/scheduler";
import type { ScheduledJob } from "../src/shared/types";

function buildJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "job-1",
    kitId: "kit-1",
    kitName: "Kit",
    kitIcon: "Zap",
    renderedPrompt: "Do the thing",
    schedule: {
      type: "daily",
      hour: 9,
      minute: 15,
    },
    enabled: true,
    createdAt: "2026-03-27T15:00:00.000Z",
    nextRunAt: "2026-03-27T09:15:00.000Z",
    ...overrides,
  };
}

test("schedule validation rejects out-of-range fields", () => {
  assert.equal(isValidScheduleConfig({ type: "daily", hour: 24, minute: 0 }), false);
  assert.equal(isValidScheduleConfig({ type: "daily", hour: 9, minute: 60 }), false);
  assert.equal(
    isValidScheduleConfig({ type: "weekly", hour: 9, minute: 0, dayOfWeek: 7 }),
    false,
  );
  assert.equal(isValidScheduleConfig({ type: "once", runAt: "not-a-date" }), false);
});

test("normalizeScheduledJob skips stale one-time jobs", () => {
  const now = new Date("2026-03-27T12:00:00.000Z");
  const job = buildJob({
    schedule: { type: "once", runAt: "2026-03-27T11:00:00.000Z" },
    nextRunAt: "2026-03-27T11:00:00.000Z",
  });

  const changed = normalizeScheduledJob(job, now);

  assert.equal(changed, true);
  assert.equal(job.enabled, false);
});

test("normalizeScheduledJob advances recurring jobs instead of replaying missed runs", () => {
  const now = new Date("2026-03-27T20:00:00.000Z");
  const job = buildJob({
    nextRunAt: "2026-03-27T16:15:00.000Z",
  });

  const changed = normalizeScheduledJob(job, now);

  assert.equal(changed, true);
  assert.equal(job.enabled, true);
  assert.equal(job.nextRunAt, "2026-03-28T16:15:00.000Z");
});
