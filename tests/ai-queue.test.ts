import assert from "node:assert/strict";
import test from "node:test";

import {
  clearPendingPromptQueue,
  dequeuePendingPrompt,
  enqueuePendingPrompt,
  removePendingPrompt,
} from "../src/renderer/src/stores/ai-queue";

test("queue enforces the prompt cap", () => {
  let queue: string[] = [];

  for (let i = 0; i < 5; i++) {
    const result = enqueuePendingPrompt(queue, `prompt-${i + 1}`);
    assert.equal(result.status, "queued");
    queue = result.queue;
  }

  const rejected = enqueuePendingPrompt(queue, "prompt-6");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.queue.length, 5);
  assert.match(rejected.notice, /Queue full/i);
});

test("dequeue returns the next prompt and updates the remaining notice", () => {
  const result = dequeuePendingPrompt(["first", "second", "third"]);

  assert.equal(result.nextPrompt, "first");
  assert.deepEqual(result.queue, ["second", "third"]);
  assert.equal(result.notice, "2 queued prompts remaining.");
});

test("remove and clear queue helpers update queue state predictably", () => {
  const removed = removePendingPrompt(["one", "two", "three"], 1);
  assert.deepEqual(removed.queue, ["one", "three"]);
  assert.match(removed.notice ?? "", /Queued 2\/5/i);

  const cleared = clearPendingPromptQueue();
  assert.deepEqual(cleared.queue, []);
  assert.equal(cleared.notice, null);
});
