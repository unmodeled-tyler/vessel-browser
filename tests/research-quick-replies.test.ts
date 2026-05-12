import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildQuickReplies,
  extractExplicitQuickReplies,
  findLatestAssistantQuickReplyTarget,
} from "../src/renderer/src/components/ai/ResearchDesk";

test("research quick replies use explicit assistant options", () => {
  const replies = buildQuickReplies(
    "Which audience should I optimize for?\n1. Technical users\n2. Product leaders\n3. General overview",
  );

  assert.deepEqual(
    replies.map((reply) => reply.label),
    ["Technical users", "Product leaders", "General overview"],
  );
});

test("research quick replies provide a low-friction default for open-ended questions", () => {
  const replies = buildQuickReplies(
    "What scope, sources, timeframe, or format would make this report most useful?",
  );

  assert.deepEqual(
    replies.map((reply) => reply.label),
    ["Use defaults"],
  );
});

test("research quick replies preserve simple yes/no choices", () => {
  const replies = buildQuickReplies(
    "Should I use sensible defaults and proceed if anything is unclear?",
  );

  assert.deepEqual(
    replies.map((reply) => reply.label),
    ["Yes", "No"],
  );
});

test("research quick replies split inline alternatives", () => {
  const replies = extractExplicitQuickReplies(
    "Do you prefer primary sources, analyst coverage, or community reports?",
  );

  assert.deepEqual(
    replies.map((reply) => reply.label),
    ["primary sources", "analyst coverage", "community reports"],
  );
});

test("research quick reply target does not require a literal question mark", () => {
  const target = findLatestAssistantQuickReplyTarget([
    { role: "user", content: "Compare AI browsers." },
    {
      role: "assistant",
      content:
        "Please choose the angle that would be most useful:\n1. Product comparison\n2. Technical architecture\n3. Market landscape",
    },
  ]);

  assert.equal(
    target,
    "Please choose the angle that would be most useful:\n1. Product comparison\n2. Technical architecture\n3. Market landscape",
  );
});

test("research quick reply target keeps open-ended questions actionable", () => {
  const target = findLatestAssistantQuickReplyTarget([
    { role: "user", content: "Compare AI browsers." },
    {
      role: "assistant",
      content:
        "What scope, sources, timeframe, or format would make this report most useful?",
    },
  ]);

  assert.equal(
    target,
    "What scope, sources, timeframe, or format would make this report most useful?",
  );
});
