import test from "node:test";
import assert from "node:assert/strict";
import { handleAIQuery } from "../src/main/ai/commands";
import type { AIProvider } from "../src/main/ai/provider";

test("Research Desk briefing uses streamQuery and forwards streamed text", async () => {
  const chunks: string[] = [];
  let completed = false;

  const provider: AIProvider = {
    agentToolProfile: "default",
    async streamQuery(
      systemPrompt,
      _userMessage,
      onChunk,
      onEnd,
    ) {
      assert.ok(systemPrompt.includes("Research Captain"));
      onChunk("What depth are you looking for?");
      onChunk("\n- High-level overview\n- Deep dive\n");
      onEnd();
    },
    async streamAgentQuery() {
      throw new Error("Briefing should not use the agent tool loop");
    },
    cancel() {},
  };

  await handleAIQuery(
    "Compare AI browsers",
    provider,
    undefined,
    (chunk) => chunks.push(chunk),
    () => {
      completed = true;
    },
    undefined,
    undefined,
    [],
    {
      getState: () => ({
        phase: "briefing",
      }),
    } as never,
  );

  assert.equal(completed, true);
  assert.deepEqual(chunks, [
    "What depth are you looking for?",
    "\n- High-level overview\n- Deep dive\n",
  ]);
});

test("Research Desk planning uses streamQuery and parses objectives", async () => {
  const chunks: string[] = [];
  let completed = false;
  let parseCalled = false;

  const provider: AIProvider = {
    agentToolProfile: "default",
    async streamQuery(
      systemPrompt,
      _userMessage,
      onChunk,
      onEnd,
    ) {
      assert.ok(systemPrompt.includes("Research Objectives"));
      onChunk('```json\n{"researchQuestion":"X","threads":[]}\n```');
      onEnd();
    },
    async streamAgentQuery() {
      throw new Error("Planning should not use the agent tool loop");
    },
    cancel() {},
  };

  const orchestrator = {
    getState: () => ({ phase: "planning" }),
    parseAndSetObjectives: (text: string) => {
      parseCalled = true;
      assert.ok(text.includes("researchQuestion"));
      return true;
    },
  } as never;

  await handleAIQuery(
    "Build the Research Objectives from this brief now.",
    provider,
    undefined,
    (chunk) => chunks.push(chunk),
    () => {
      completed = true;
    },
    undefined,
    undefined,
    [],
    orchestrator,
  );

  assert.equal(completed, true);
  assert.equal(parseCalled, true);
});

test("Research Desk planning shows error when objectives parsing fails", async () => {
  const chunks: string[] = [];
  let completed = false;

  const provider: AIProvider = {
    agentToolProfile: "default",
    async streamQuery(_systemPrompt, _userMessage, onChunk, onEnd) {
      onChunk("invalid json");
      onEnd();
    },
    async streamAgentQuery() {
      throw new Error("Planning should not use the agent tool loop");
    },
    cancel() {},
  };

  const orchestrator = {
    getState: () => ({ phase: "planning" }),
    parseAndSetObjectives: () => false,
  } as never;

  await handleAIQuery(
    "Build the Research Objectives from this brief now.",
    provider,
    undefined,
    (chunk) => chunks.push(chunk),
    () => {
      completed = true;
    },
    undefined,
    undefined,
    [],
    orchestrator,
  );

  assert.equal(completed, true);
  assert.ok(
    chunks.some((c) => c.includes("Failed to parse objectives")),
  );
});
