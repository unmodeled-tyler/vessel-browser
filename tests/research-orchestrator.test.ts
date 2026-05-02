import { describe, it } from "node:test";
import assert from "node:assert";

import type {
  ResearchState,
  ResearchObjectives,
} from "../src/shared/research-types";
import { ResearchOrchestrator } from "../src/main/agent/research/orchestrator";
import type { AIProvider } from "../src/main/ai/provider";
import type { AgentRuntime } from "../src/main/agent/runtime";
import type { TabManager } from "../src/main/tabs/tab-manager";

function makeMockProvider(): AIProvider {
  return {
    agentToolProfile: "default",
    streamQuery: async (
      systemPrompt,
      _userMessage,
      onChunk,
      onEnd,
    ) => {
      if (systemPrompt.includes("claim extractor")) {
        onChunk("[]");
      } else {
        onChunk(JSON.stringify({
          title: "Test Report",
          executiveSummary: "Completed test synthesis.",
          findingsByThread: [],
          sourceIndex: [],
        }));
      }
      onEnd();
    },
    streamAgentQuery: async (
      _systemPrompt,
      _userMessage,
      _tools,
      onChunk,
      _onToolCall,
      onEnd,
    ) => {
      onChunk("Visited no pages.");
      onEnd();
    },
    cancel: () => {},
  };
}

function makeMockTabManager(): TabManager & { activeId: string } {
  let activeId = "tab-1";
  let prevActiveId = "tab-1";
  let nextId = 1;
  return {
    get activeId() {
      return activeId;
    },
    createTab: () => {
      prevActiveId = activeId;
      nextId += 1;
      activeId = `tab-${nextId}`;
      return activeId;
    },
    switchTab: (id: string) => {
      if (activeId !== id) {
        prevActiveId = activeId;
        activeId = id;
      }
    },
    closeTab: (id: string) => {
      if (activeId === id) {
        activeId = prevActiveId;
      }
    },
    getActiveTabId: () => activeId,
    getActiveTab: () => null,
    getAllStates: () => [],
  } as unknown as TabManager & { activeId: string };
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
    originalQuery: null,
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

  it("parseAndSetObjectives rejects threads without questions or searches", async () => {
    const orch = new ResearchOrchestrator(
      makeMockProvider(),
      makeMockTabManager(),
      makeMockRuntime(),
    );
    await orch.startBrief("test");
    orch.confirmBrief();

    const result = orch.parseAndSetObjectives(
      JSON.stringify({
        researchQuestion: "What should we research?",
        threads: [
          { label: "Missing question", searchQueries: ["topic"] },
          { label: "Missing search", question: "What happened?" },
        ],
      }),
    );

    assert.strictEqual(result, false);
    assert.strictEqual(orch.getState().phase, "planning");
  });

  it("parseAndSetObjectives clamps threads and recomputes source budget", async () => {
    const orch = new ResearchOrchestrator(
      makeMockProvider(),
      makeMockTabManager(),
      makeMockRuntime(),
    );
    await orch.startBrief("test");
    orch.confirmBrief();

    const result = orch.parseAndSetObjectives(
      JSON.stringify({
        researchQuestion: "What should we research?",
        threads: Array.from({ length: 6 }, (_, index) => ({
          label: `Thread ${index + 1}`,
          question: `Question ${index + 1}?`,
          searchQueries: [`query ${index + 1}`],
          sourceBudget: index === 0 ? -10 : 2,
        })),
        totalSourceBudget: 999,
      }),
    );

    const state = orch.getState();
    assert.strictEqual(result, true);
    assert.strictEqual(state.objectives?.threads.length, 5);
    assert.strictEqual(state.objectives?.threads[0].sourceBudget, 1);
    assert.strictEqual(state.objectives?.totalSourceBudget, 9);
  });

  it("executeSubAgents restores the originally active tab", async () => {
    const tabManager = makeMockTabManager();
    const orch = new ResearchOrchestrator(
      makeMockProvider(),
      tabManager,
      makeMockRuntime(),
    );
    await orch.startBrief("test");
    orch.confirmBrief();
    orch.setObjectives({
      researchQuestion: "What should we research?",
      threads: [
        {
          label: "Hardware",
          question: "Who leads quantum hardware?",
          searchQueries: ["quantum hardware"],
          preferredDomains: [],
          blockedDomains: [],
          sourceBudget: 1,
        },
      ],
      audience: "general",
      reportOutline: ["Hardware"],
      totalSourceBudget: 1,
    });
    orch.approveObjectives();

    await orch.executeSubAgents();

    assert.strictEqual(tabManager.activeId, "tab-1");
    assert.strictEqual(orch.getState().phase, "delivered");
    assert.ok(orch.getState().report);
  });

  it("does not deliver a report after cancellation during execution", async () => {
    let releaseAgent!: () => void;
    let synthesisCalled = false;
    const provider: AIProvider = {
      agentToolProfile: "default",
      streamQuery: async (systemPrompt, _userMessage, onChunk, onEnd) => {
        if (!systemPrompt.includes("claim extractor")) {
          synthesisCalled = true;
        }
        onChunk("[]");
        onEnd();
      },
      streamAgentQuery: async (
        _systemPrompt,
        _userMessage,
        _tools,
        onChunk,
        _onToolCall,
        onEnd,
      ) => {
        onChunk("Research in progress.");
        await new Promise<void>((resolve) => {
          releaseAgent = resolve;
        });
        onEnd();
      },
      cancel: () => {},
    };
    const orch = new ResearchOrchestrator(
      provider,
      makeMockTabManager(),
      makeMockRuntime(),
    );
    await orch.startBrief("test");
    orch.confirmBrief();
    orch.setObjectives({
      researchQuestion: "What should we research?",
      threads: [
        {
          label: "Hardware",
          question: "Who leads quantum hardware?",
          searchQueries: ["quantum hardware"],
          preferredDomains: [],
          blockedDomains: [],
          sourceBudget: 1,
        },
      ],
      audience: "general",
      reportOutline: ["Hardware"],
      totalSourceBudget: 1,
    });
    orch.approveObjectives();

    const execution = orch.executeSubAgents();
    await Promise.resolve();
    orch.cancel();
    releaseAgent();
    await execution;

    assert.strictEqual(orch.getState().phase, "idle");
    assert.strictEqual(orch.getState().report, null);
    assert.strictEqual(synthesisCalled, false);
  });
});
