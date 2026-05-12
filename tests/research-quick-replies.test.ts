import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildQuickReplies,
  extractExplicitQuickReplies,
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

test("research quick replies do not invent options for open-ended questions", () => {
  const replies = buildQuickReplies(
    "What scope, sources, timeframe, or format would make this report most useful?",
  );

  assert.deepEqual(replies, []);
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
