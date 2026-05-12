import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { handleAIQuery } from "../src/main/ai/commands";
import type { AIProvider } from "../src/main/ai/provider";
import type { ResearchClarification } from "../src/shared/research-types";
import { TERMINAL_TOOL_RESULT } from "../src/main/ai/tool-control";

test("Research Desk briefing exposes a structured user question tool", async () => {
  const chunks: string[] = [];
  const clarifications: ResearchClarification[] = [];
  let completed = false;
  let toolNames: string[] = [];

  const provider: AIProvider = {
    agentToolProfile: "default",
    async streamQuery() {
      throw new Error("Expected Research Desk briefing to use tool path");
    },
    async streamAgentQuery(
      _systemPrompt,
      _userMessage,
      tools: Anthropic.Tool[],
      onChunk,
      onToolCall,
      onEnd,
    ) {
      toolNames = tools.map((tool) => tool.name);
      onChunk("I need a few details before I can start. ");
      onChunk("\n<<tool:ask_research_user:Which angle?>>\n");
      const result = await onToolCall("ask_research_user", {
        question: "Which angle should Vessel use?",
        options: [
          {
            label: "Product comparison",
            response: "Focus on product comparison.",
          },
          {
            label: "Technical architecture",
            response: "Focus on technical architecture.",
          },
        ],
      });
      assert.equal(result, TERMINAL_TOOL_RESULT);
      onChunk("Which angle should Vessel use?");
      onEnd();
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
    (payload) => clarifications.push(payload),
  );

  assert.equal(completed, true);
  assert.deepEqual(toolNames, ["ask_research_user"]);
  assert.deepEqual(chunks, []);
  assert.equal(clarifications[0]?.question, "Which angle should Vessel use?");
  assert.deepEqual(
    clarifications[0]?.options.map((option) => option.label),
    ["Product comparison", "Technical architecture"],
  );
});

test("Research Desk clarification tool supplies a default option when omitted", async () => {
  const clarifications: ResearchClarification[] = [];

  const provider: AIProvider = {
    agentToolProfile: "default",
    async streamQuery() {
      throw new Error("Expected Research Desk briefing to use tool path");
    },
    async streamAgentQuery(
      _systemPrompt,
      _userMessage,
      _tools: Anthropic.Tool[],
      _onChunk,
      onToolCall,
      onEnd,
    ) {
      const result = await onToolCall("ask_research_user", {
        question: "What scope, sources, timeframe, or format would make this report useful?",
      });
      assert.equal(result, TERMINAL_TOOL_RESULT);
      onEnd();
    },
    cancel() {},
  };

  await handleAIQuery(
    "Compare AI browsers",
    provider,
    undefined,
    () => undefined,
    () => undefined,
    undefined,
    undefined,
    [],
    {
      getState: () => ({
        phase: "briefing",
      }),
    } as never,
    (payload) => clarifications.push(payload),
  );

  assert.equal(clarifications[0]?.options[0]?.label, "Use defaults");
});
