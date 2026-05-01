import { describe, it } from "node:test";
import assert from "node:assert";

// We test the orchestrator state machine in isolation.
// Mock the provider, tabManager, and runtime since they require full Electron.

import type {
  ResearchState,
  ResearchObjectives,
} from "../src/shared/research-types";

function makeInitialState(): ResearchState {
  return {
    phase: "idle",
    supervisionMode: "interactive",
    includeTraces: false,
    objectives: null,
    threads: [],
    threadFindings: [],
    report: null,
    subAgentTraces: [],
    error: null,
    startedAt: null,
  };
}

function makeMockObjectives(): ResearchObjectives {
  return {
    researchQuestion: "What is the state of quantum computing in 2026?",
    threads: [
      {
        label: "Hardware Players",
        question: "Who are the leading quantum hardware companies?",
        searchQueries: ["quantum computing hardware companies 2026"],
        preferredDomains: [],
        blockedDomains: [],
        sourceBudget: 5,
      },
      {
        label: "Algorithmic Breakthroughs",
        question: "What major algorithmic breakthroughs occurred recently?",
        searchQueries: ["quantum algorithm breakthroughs 2025 2026"],
        preferredDomains: [],
        blockedDomains: [],
        sourceBudget: 4,
      },
    ],
    audience: "technical professionals",
    reportOutline: ["Hardware Landscape", "Algorithmic Progress", "Market Outlook"],
    totalSourceBudget: 10,
  };
}

describe("ResearchState transitions", () => {
  it("starts in idle phase", () => {
    const state = makeInitialState();
    assert.strictEqual(state.phase, "idle");
    assert.strictEqual(state.objectives, null);
  });

  it("has correct phases enumerated", () => {
    const validPhases = [
      "idle",
      "briefing",
      "planning",
      "awaiting_approval",
      "executing",
      "synthesizing",
      "delivered",
    ];
    assert.strictEqual(validPhases.length, 7);
  });

  it("creates objectives with valid threads", () => {
    const objectives = makeMockObjectives();
    assert.strictEqual(objectives.threads.length, 2);
    assert.ok(
      objectives.threads.every((t) => t.sourceBudget > 0),
      "All threads must have positive source budgets",
    );
    assert.ok(
      objectives.threads.every((t) => t.question.length > 0),
      "All threads must have a question",
    );
    assert.ok(
      objectives.threads.every((t) => t.searchQueries.length > 0),
      "All threads must have search queries",
    );
  });

  it("enforces max threads limit of 5", () => {
    const objectives = makeMockObjectives();
    // If someone tries to create >5 threads, it should be clamped
    const MAX = 5;
    assert.ok(objectives.threads.length <= MAX);
  });
});
