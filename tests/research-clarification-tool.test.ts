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

test("Research Desk clarification tool synthesizes options when omitted", async () => {
  const clarifications: ResearchClarification[] = [];
  let toolResult = "";

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
      toolResult = await onToolCall("ask_research_user", {
        question: "What scope, sources, timeframe, or format would make this report useful?",
      });
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

  assert.equal(toolResult, TERMINAL_TOOL_RESULT);
  assert.deepEqual(
    clarifications[0]?.options.map((option) => option.label),
    [
      "Primary sources",
      "Analyst coverage",
      "Community signal",
      "Use sensible defaults",
    ],
  );
});

test("Research Desk clarification tool does not retry default-only options", async () => {
  const clarifications: ResearchClarification[] = [];
  let toolResult = "";

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
      toolResult = await onToolCall("ask_research_user", {
        question: "What scope should Vessel use?",
        options: [{ label: "Use defaults", response: "Use defaults." }],
      });
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

  assert.equal(toolResult, TERMINAL_TOOL_RESULT);
  assert.deepEqual(
    clarifications[0]?.options.map((option) => option.label),
    [
      "Business value",
      "User experience",
      "Security and privacy",
      "Use sensible defaults",
    ],
  );
});

test("Research Desk fallback options follow the current question, not the original query", async () => {
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
      await onToolCall("ask_research_user", {
        question: "What timeframe should Vessel focus on?",
        options: [{ label: "Use defaults", response: "Use defaults." }],
      });
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
    [
      { role: "user", content: "Compare AI browsers" },
      { role: "assistant", content: "Which angle should Vessel use?" },
      { role: "user", content: "Product comparison." },
    ],
    {
      getState: () => ({
        phase: "briefing",
      }),
    } as never,
    (payload) => clarifications.push(payload),
  );

  assert.deepEqual(
    clarifications[0]?.options.map((option) => option.label),
    [
      "Current landscape",
      "Last 12 months",
      "Historical evolution",
      "Use sensible defaults",
    ],
  );
});
