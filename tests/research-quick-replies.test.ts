import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildQuickReplies,
  extractExplicitQuickReplies,
  findLatestResearchClarification,
  findLatestAssistantQuickReplyTarget,
  pickResearchClarificationQuickReplies,
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

test("research quick replies turn example answers into options", () => {
  const replies = buildQuickReplies(
    'What would make this report useful? Example answers: "Focus on pricing and enterprise readiness", "Prioritize open-source browsers", or "Use current market defaults".',
  );

  assert.deepEqual(
    replies.map((reply) => reply.label),
    [
      "Focus on pricing and enterprise readiness",
      "Prioritize open-source browsers",
      "Use current market defaults",
    ],
  );
});

test("research quick replies parse semicolon-separated example answers", () => {
  const replies = buildQuickReplies(
    "What would make this report useful? Examples include: focus on pricing and enterprise readiness; prioritize open-source browsers; compare technical architecture.",
  );

  assert.deepEqual(
    replies.map((reply) => reply.label),
    [
      "focus on pricing and enterprise readiness",
      "prioritize open-source browsers",
      "compare technical architecture",
    ],
  );
});

test("research clarification examples override injected default option", () => {
  const replies = pickResearchClarificationQuickReplies({
    id: "clarification:test",
    question:
      "What would make this report useful? Examples include: focus on pricing; prioritize open source; compare technical architecture.",
    options: [
      {
        label: "Use defaults",
        response: "Use sensible defaults and proceed.",
      },
    ],
    allowTypedResponse: true,
  });

  assert.deepEqual(
    replies.map((reply) => reply.label),
    ["focus on pricing", "prioritize open source", "compare technical architecture"],
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

test("research quick reply target clears after the user answers", () => {
  const target = findLatestAssistantQuickReplyTarget([
    { role: "user", content: "Compare AI browsers." },
    {
      role: "assistant",
      content:
        "Which angle should I optimize for?\n1. Product comparison\n2. Technical architecture",
    },
    { role: "user", content: "Product comparison." },
  ]);

  assert.equal(target, "");
});

test("research clarification chips only follow the latest assistant question", () => {
  const clarifications = [
    {
      id: "clarification:first",
      question: "Which angle should I optimize for?",
      options: [
        {
          label: "Product comparison",
          response: "Focus on product comparison.",
        },
      ],
      allowTypedResponse: true,
    },
  ];

  assert.equal(
    findLatestResearchClarification(
      [
        { role: "user", content: "Compare AI browsers." },
        { role: "assistant", content: "Which angle should I optimize for?" },
        { role: "user", content: "Product comparison." },
      ],
      clarifications,
    ),
    null,
  );

  assert.equal(
    findLatestResearchClarification(
      [
        { role: "user", content: "Compare AI browsers." },
        { role: "assistant", content: "Which angle should I optimize for?" },
        { role: "user", content: "Product comparison." },
        { role: "assistant", content: "Which sources should I prioritize?" },
      ],
      clarifications,
    ),
    null,
  );
});

test("research quick replies parse unicode bullet options", () => {
  const replies = buildQuickReplies(
    "What depth are you after?\n• High-level overview\n• Deep dive\n• Both",
  );

  assert.deepEqual(
    replies.map((reply) => reply.label),
    ["High-level overview", "Deep dive", "Both"],
  );
});

test("research quick replies catch options on the line after a question", () => {
  const replies = buildQuickReplies(
    "What depth are you after?\nHigh-level overview, deep dive, or both",
  );

  assert.deepEqual(
    replies.map((reply) => reply.label),
    ["High-level overview", "deep dive", "both"],
  );
});

test("research quick replies catch labelled options like Options or Choices", () => {
  const replies = buildQuickReplies(
    "How many sources do you want? Options: a handful, a moderate amount, or exhaustive",
  );

  assert.deepEqual(
    replies.map((reply) => reply.label),
    ["a handful", "a moderate amount", "exhaustive"],
  );
});

test("research quick replies labelled options stop at end of sentence", () => {
  const replies = buildQuickReplies(
    "How many sources? Choices: a handful, a moderate amount, or exhaustive.",
  );

  assert.deepEqual(
    replies.map((reply) => reply.label),
    ["a handful", "a moderate amount", "exhaustive"],
  );
});
