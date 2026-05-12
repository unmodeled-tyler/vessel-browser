import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { handleAIQuery } from "../src/main/ai/commands";
import type { AIProvider } from "../src/main/ai/provider";
import type { ResearchClarification } from "../src/shared/research-types";

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
      onChunk("\n<<tool:ask_research_user:Which angle?>>\n");
      await onToolCall("ask_research_user", {
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
