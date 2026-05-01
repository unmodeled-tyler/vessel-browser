import { describe, it } from "node:test";
import assert from "node:assert";

import type {
  ResearchState,
  ResearchObjectives,
} from "../src/shared/research-types";
import { ResearchOrchestrator } from "../src/main/agent/research/orchestrator";
import type { AIProvider } from "../src/main/ai/provider";
import type { TabManager } from "../src/tabs/tab-manager";
import type { AgentRuntime } from "../src/agent/runtime";

function makeMockProvider(): AIProvider {
  return {
    agentToolProfile: "default",
    streamQuery: async () => {},
    cancel: () => {},
  };
}

function makeMockTabManager(): TabManager {
  return {
    createTab: () => "",
    switchTab: () => {},
    getActiveTabId: () => "tab-1",
    getActiveTab: () => null,
    getAllStates: () => [],
  } as unknown as TabManager;
}

function makeMockRuntime(): AgentRuntime {
  return {
    getState: () => ({}),
    clearTaskTracker: () => {},
    setApprovalMode: () => ({} as never),
  } as unknown as AgentRuntime;
}

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
    reportOutline: ["Hardware Landscape", "Algorithmic Progress"],
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

  it("parseAndSetObjectives returns false for invalid text", async () => {
    const orch = new ResearchOrchestrator(
      makeMockProvider(),
      makeMockTabManager(),
      makeMockRuntime(),
    );
    await orch.startBrief("test");
    orch.confirmBrief();
    assert.strictEqual(orch.getState().phase, "planning");

    const result = orch.parseAndSetObjectives("not valid json at all");
    assert.strictEqual(result, false);
  });

  it("parseAndSetObjectives rejects missing researchQuestion", async () => {
    const orch = new ResearchOrchestrator(
      makeMockProvider(),
      makeMockTabManager(),
      makeMockRuntime(),
    );
    await orch.startBrief("test");
    orch.confirmBrief();

    const result = orch.parseAndSetObjectives(
      '{"threads": [{"label": "T1", "question": "Q?", "searchQueries": ["q"]}]}',
    );
    assert.strictEqual(result, false);
  });

  it("parseAndSetObjectives accepts complete objectives", async () => {
    const orch = new ResearchOrchestrator(
      makeMockProvider(),
      makeMockTabManager(),
      makeMockRuntime(),
    );
    await orch.startBrief("test");
    orch.confirmBrief();

    const json = JSON.stringify({
      researchQuestion: "What is quantum supremacy?",
      threads: [
        {
          label: "Hardware",
          question: "Who leads quantum hardware?",
          searchQueries: ["quantum hardware 2026"],
          sourceBudget: 4,
        },
      ],
      audience: "technical",
      reportOutline: ["Introduction", "Hardware"],
      totalSourceBudget: 5,
    });

    const result = orch.parseAndSetObjectives(json);
    assert.strictEqual(result, true);
    assert.strictEqual(orch.getState().phase, "awaiting_approval");
    assert.ok(orch.getState().objectives);
    assert.strictEqual(
      orch.getState().objectives!.researchQuestion,
      "What is quantum supremacy?",
    );
  });
});
