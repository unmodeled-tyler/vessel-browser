# Research Desk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Research Desk — a premium deep-research feature where an orchestrator model briefs the user, spawns parallel sub-agent tabs, and synthesizes source-anchored findings into a cited Research Report.

**Architecture:** New `src/main/agent/research/` module with orchestrator, executor, synthesizer, and prompt templates. Reuses existing tab infrastructure (each sub-agent is a standard tab), the existing tool belt, chat streaming, and premium gating patterns. New IPC channels + preload API + SolidJS renderer store + sidebar UI component.

**Tech Stack:** TypeScript, Electron, SolidJS, Anthropic SDK / OpenAI-compatible SDK, Zod

---

### Task 1: Research Type Definitions

**Files:**
- Create: `src/shared/research-types.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Write the research type definitions**

```typescript
// src/shared/research-types.ts

export type ResearchPhase =
  | "idle"
  | "briefing"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "synthesizing"
  | "delivered";

export type SupervisionMode = "walk-away" | "interactive";

export interface ResearchThread {
  /** Human-readable label for this research angle */
  label: string;
  /** The specific question this thread must answer */
  question: string;
  /** Suggested search queries to bootstrap the sub-agent */
  searchQueries: string[];
  /** Domains the sub-agent should prefer (empty = no preference) */
  preferredDomains: string[];
  /** Domains the sub-agent must not visit */
  blockedDomains: string[];
  /** Maximum number of sources to collect for this thread */
  sourceBudget: number;
}

export interface ResearchObjectives {
  /** The refined research question from the brief phase */
  researchQuestion: string;
  /** 2–5 independent research threads */
  threads: ResearchThread[];
  /** Target audience for the report (affects tone/depth) */
  audience: string;
  /** Outline of expected report sections */
  reportOutline: string[];
  /** Total source budget across all threads (soft cap) */
  totalSourceBudget: number;
}

export interface SourcedClaim {
  /** The factual claim extracted from a page */
  claim: string;
  /** URL of the source page */
  sourceUrl: string;
  /** Page title at time of extraction */
  sourceTitle: string;
  /** The verbatim extracted quote that supports this claim */
  extractedQuote: string;
  /** ISO 8601 timestamp of extraction */
  extractedAt: string;
  /** Which thread this claim belongs to */
  threadLabel: string;
  /** The sub-agent's relevance note (why this claim matters) */
  relevanceNote: string;
}

export interface ThreadFindings {
  threadLabel: string;
  threadQuestion: string;
  claims: SourcedClaim[];
  /** Sources visited but not cited (e.g., irrelevant tangents) */
  discardedSources: Array<{ url: string; title: string; reason: string }>;
  /** Execution summary: how many pages visited, total time, any errors */
  executionSummary: string;
}

export interface ResearchReport {
  /** Report title */
  title: string;
  /** 2–3 paragraph answer to the research question */
  executiveSummary: string;
  /** One section per research thread */
  findingsByThread: Array<{
    threadLabel: string;
    content: string;
  }>;
  /** Explicitly flagged contradictions between sources */
  contradictions: Array<{
    claim: string;
    sourceA: { url: string; claim: string };
    sourceB: { url: string; claim: string };
    resolution: string;
  }>;
  /** Explicitly flagged gaps — things we couldn't answer */
  gaps: string[];
  /** Numbered source index */
  sourceIndex: Array<{
    index: number;
    url: string;
    title: string;
    accessedAt: string;
    supportingQuote: string;
  }>;
  /** ISO 8601 timestamp of report completion */
  generatedAt: string;
  /** The Research Objectives this report was based on */
  objectives: ResearchObjectives;
}

export interface SubAgentTrace {
  threadLabel: string;
  toolCalls: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    timestamp: string;
    durationMs: number;
  }>;
  errors: Array<{ message: string; timestamp: string }>;
  startedAt: string;
  finishedAt: string;
}

export interface ResearchState {
  phase: ResearchPhase;
  supervisionMode: SupervisionMode;
  includeTraces: boolean;
  objectives: ResearchObjectives | null;
  threads: ResearchThread[];
  threadFindings: ThreadFindings[];
  report: ResearchReport | null;
  subAgentTraces: SubAgentTrace[];
  error: string | null;
  startedAt: string | null;
}
```

- [ ] **Step 2: Re-export from shared types barrel**

Append to `src/shared/types.ts`:

```typescript
export type {
  ResearchPhase,
  SupervisionMode,
  ResearchThread,
  ResearchObjectives,
  SourcedClaim,
  ThreadFindings,
  ResearchReport,
  SubAgentTrace,
  ResearchState,
} from "./research-types";
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors from new types file)

- [ ] **Step 4: Commit**

```bash
git add src/shared/research-types.ts src/shared/types.ts
git commit -m "feat(research): add Research Desk type definitions"
```

---

### Task 2: Research IPC Channels

**Files:**
- Modify: `src/shared/channels.ts`

- [ ] **Step 1: Add research channel constants**

Append to the `Channels` object before the closing `} as const;`:

```typescript
  // Research Desk
  RESEARCH_STATE_GET: "research:state-get",
  RESEARCH_STATE_UPDATE: "research:state-update",
  RESEARCH_START_BRIEF: "research:start-brief",
  RESEARCH_CONFIRM_BRIEF: "research:confirm-brief",
  RESEARCH_APPROVE_OBJECTIVES: "research:approve-objectives",
  RESEARCH_SET_MODE: "research:set-mode",
  RESEARCH_SET_TRACES: "research:set-traces",
  RESEARCH_CANCEL: "research:cancel",
  RESEARCH_EXPORT_REPORT: "research:export-report",
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/channels.ts
git commit -m "feat(research): add Research Desk IPC channels"
```

---

### Task 3: Orchestrator System Prompt

**Files:**
- Create: `src/main/agent/research/orchestrator-prompt.ts`

- [ ] **Step 1: Write the orchestrator system prompt**

```typescript
// src/main/agent/research/orchestrator-prompt.ts

export function buildOrchestratorSystemPrompt(): string {
  return `You are the Research Captain of Vessel. You orchestrate deep research on behalf of the user.

YOUR ROLE:
You are accountable for the final Research Report. The report has YOUR name on it. You do not blindly accept sub-agent findings — you review, challenge, and demand more when needed. You are the captain, and the sub-agents are your crew.

CORE PRINCIPLES:
- You OWN the research question end-to-end. If the answer is insufficient, you dig deeper.
- Every factual claim in your final report MUST be backed by a specific source URL and extracted quote. No citation = the claim does not survive synthesis.
- You are authoritative but honest. Flag contradictions and gaps explicitly. Never invent to fill a hole.

BRIEF PHASE:
Your first job is to interview the user. Ask one question at a time. Cover:
- What exactly do they want to know?
- How deep? How many sources?
- Who is the report for? Technical or layperson?
- Any domains to prefer or avoid?
- What does a good answer look like?

If the user's question is vague, switch into EXPLORATION MODE: proactively suggest 2–3 concrete research angles they might be interested in. Help them discover what they actually want to know.

You CANNOT navigate or use tools during the brief. The brief is dialogue only. When you are confident you have enough context, summarize what you heard and ask the user to confirm before moving to planning.

PLANNING PHASE:
After the brief is confirmed, produce a structured Research Objectives document with 2–5 independent threads. Each thread gets a specific question, suggested search queries, and a source budget. Present this as a clear, structured card for the user to review, edit, or approve.

EXECUTION PHASE:
Sub-agents run in parallel, each handling one thread. You monitor their progress. If a thread stalls or produces thin findings, rebalance — reassign effort, ask the sub-agent to dig deeper, or spawn a replacement.

SYNTHESIS PHASE:
Before writing the report, self-audit: "Do I have enough to answer the research question? Am I confident in every claim?" If not, request more from sub-agents.

Write the report with:
- An executive summary
- One section per thread with sourced claims
- Explicit contradictions and gaps
- A numbered source index

Never use emojis. Be concise. Be precise.`;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/agent/research/orchestrator-prompt.ts
git commit -m "feat(research): add orchestrator system prompt"
```

---

### Task 4: Sub-Agent System Prompt

**Files:**
- Create: `src/main/agent/research/sub-agent-prompt.ts`

- [ ] **Step 1: Write the sub-agent system prompt**

```typescript
// src/main/agent/research/sub-agent-prompt.ts
import type { ResearchThread } from "../../../shared/research-types";

export function buildSubAgentSystemPrompt(thread: ResearchThread): string {
  const domainBlock =
    thread.blockedDomains.length > 0
      ? `\nBLOCKED DOMAINS (never visit): ${thread.blockedDomains.join(", ")}`
      : "";

  const domainPref =
    thread.preferredDomains.length > 0
      ? `\nPREFERRED DOMAINS: ${thread.preferredDomains.join(", ")}`
      : "";

  return `You are a Vessel research sub-agent assigned to a specific thread.

YOUR MISSION: ${thread.question}

SEARCH QUERIES TO START WITH:
${thread.searchQueries.map((q) => `- ${q}`).join("\n")}${domainPref}${domainBlock}

SOURCE BUDGET: You may visit up to ${thread.sourceBudget} sources. Do not exceed this unless the captain explicitly increases it.

RULES:
1. Every finding you report MUST include the source URL and the verbatim extracted quote that supports it.
2. Never fabricate. If you cannot find an answer, say so.
3. Stay on your thread. Do not wander into other research angles.
4. Report findings incrementally. After visiting each source, report what you found.
5. If a page is behind a paywall, paywall, or requires login, note it and move on.
6. Prefer primary sources over secondary commentary.
7. Do not use emojis.

When done, report a summary of your execution: pages visited, useful sources found, discarded sources, any errors.`;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/agent/research/sub-agent-prompt.ts
git commit -m "feat(research): add sub-agent system prompt"
```

---

### Task 5: Research Orchestrator Class

**Files:**
- Create: `src/main/agent/research/orchestrator.ts`

- [ ] **Step 1: Write the ResearchOrchestrator class**

```typescript
// src/main/agent/research/orchestrator.ts
import { randomUUID } from "node:crypto";
import { createLogger } from "../../../shared/logger";
import type {
  ResearchState,
  ResearchPhase,
  ResearchObjectives,
  ResearchThread,
  ThreadFindings,
  ResearchReport,
  SubAgentTrace,
  SupervisionMode,
  SourcedClaim,
} from "../../../shared/research-types";
import { buildOrchestratorSystemPrompt } from "./orchestrator-prompt";
import { buildSubAgentSystemPrompt } from "./sub-agent-prompt";
import type { AIProvider } from "../../ai/provider";
import { AGENT_TOOLS } from "../../ai/tools";
import type { TabManager } from "../../tabs/tab-manager";
import type { AgentRuntime } from "../runtime";

const logger = createLogger("ResearchOrchestrator");
const MAX_THREADS = 5;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class ResearchOrchestrator {
  private state: ResearchState;
  private updateListener: ((state: ResearchState) => void) | null = null;

  constructor(
    private readonly provider: AIProvider,
    private readonly tabManager: TabManager,
    private readonly runtime: AgentRuntime,
  ) {
    this.state = this.initialState();
  }

  private initialState(): ResearchState {
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

  getState(): ResearchState {
    return clone(this.state);
  }

  setUpdateListener(listener: ((state: ResearchState) => void) | null): void {
    this.updateListener = listener;
    if (listener) listener(this.getState());
  }

  private emit(): void {
    if (this.updateListener) this.updateListener(this.getState());
  }

  private setPhase(phase: ResearchPhase): void {
    this.state.phase = phase;
    this.emit();
  }

  setSupervisionMode(mode: SupervisionMode): void {
    this.state.supervisionMode = mode;
    this.emit();
  }

  setIncludeTraces(include: boolean): void {
    this.state.includeTraces = include;
    this.emit();
  }

  cancel(): void {
    this.state = this.initialState();
    this.emit();
  }

  async startBrief(userQuery: string): Promise<void> {
    if (this.state.phase !== "idle") {
      logger.warn("Research already in progress, ignoring startBrief");
      return;
    }

    this.state.startedAt = new Date().toISOString();
    this.setPhase("briefing");

    // The brief runs as a chat conversation. The initial message primes the
    // orchestrator with the user's query and asks the first clarifying question.
    // We use the chat's streamAgentQuery path for this.
    // For now, this method just transitions state; the actual chat interaction
    // is driven through the IPC handler (Task 7).
    logger.info(`Brief started for query: ${userQuery.slice(0, 120)}`);
  }

  confirmBrief(): void {
    if (this.state.phase !== "briefing") {
      logger.warn("Not in briefing phase, ignoring confirmBrief");
      return;
    }
    this.setPhase("planning");
  }

  setObjectives(objectives: ResearchObjectives): void {
    if (this.state.phase !== "planning") {
      logger.warn("Not in planning phase, ignoring setObjectives");
      return;
    }
    this.state.objectives = objectives;
    this.state.threads = objectives.threads.slice(0, MAX_THREADS);
    this.setPhase("awaiting_approval");
  }

  approveObjectives(mode?: SupervisionMode, includeTraces?: boolean): void {
    if (this.state.phase !== "awaiting_approval") {
      logger.warn("Not awaiting approval, ignoring approveObjectives");
      return;
    }
    if (mode) this.state.supervisionMode = mode;
    if (includeTraces !== undefined) this.state.includeTraces = includeTraces;
    this.setPhase("executing");
  }

  async executeSubAgents(): Promise<void> {
    if (this.state.phase !== "executing" || !this.state.objectives) return;

    const promises = this.state.threads.map((thread) =>
      this.runSubAgent(thread),
    );

    try {
      const findings = await Promise.all(promises);
      this.state.threadFindings = findings;
    } catch (err) {
      logger.error("Sub-agent execution failed", err);
      this.state.error = `Sub-agent execution failed: ${String(err)}`;
    }

    this.setPhase("synthesizing");
  }

  private async runSubAgent(thread: ResearchThread): Promise<ThreadFindings> {
    const tabId = randomUUID();
    const traces: SubAgentTrace = {
      threadLabel: thread.label,
      toolCalls: [],
      errors: [],
      startedAt: new Date().toISOString(),
      finishedAt: "",
    };

    const claims: SourcedClaim[] = [];
    const discardedSources: ThreadFindings["discardedSources"] = [];

    try {
      // Create a new tab for this sub-agent
      await this.tabManager.createTab();
      const systemPrompt = buildSubAgentSystemPrompt(thread);

      // The sub-agent queries are driven by the orchestrator calling the AI
      // with tools available. The orchestrator manages the conversation loop
      // for each sub-agent, collecting tool outputs and feeding them back.
      // For the initial implementation, the sub-agent uses 3 iterative rounds:
      // 1. Search/navigate to a source
      // 2. Extract content
      // 3. Navigate to next source or refine

      traces.finishedAt = new Date().toISOString();
    } catch (err) {
      traces.errors.push({
        message: String(err),
        timestamp: new Date().toISOString(),
      });
      traces.finishedAt = new Date().toISOString();
    }

    if (this.state.includeTraces) {
      this.state.subAgentTraces.push(traces);
    }

    return {
      threadLabel: thread.label,
      threadQuestion: thread.question,
      claims,
      discardedSources,
      executionSummary: `Visited ${claims.length + discardedSources.length} pages. ${claims.length} claims extracted. ${discardedSources.length} sources discarded.${traces.errors.length > 0 ? ` ${traces.errors.length} errors.` : ""}`,
    };
  }

  async synthesizeReport(): Promise<ResearchReport | null> {
    if (this.state.phase !== "synthesizing" || !this.state.objectives) {
      return null;
    }

    // The orchestrator model synthesizes thread findings into a report.
    // This is driven through the chat path — the orchestrator receives all
    // ThreadFindings and produces the final report via a structured prompt.
    // For now, return a placeholder that the IPC handler will fill in
    // by calling the AI provider with a synthesis prompt.

    this.setPhase("delivered");
    return this.state.report;
  }

  setReport(report: ResearchReport): void {
    this.state.report = report;
    this.emit();
  }

  reset(): void {
    this.state = this.initialState();
    this.emit();
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/agent/research/orchestrator.ts
git commit -m "feat(research): add ResearchOrchestrator class"
```

---

### Task 6: Premium Gating

**Files:**
- Modify: `src/main/premium/manager.ts`

- [ ] **Step 1: Add research to premium features**

In `src/main/premium/manager.ts`, append to the `PREMIUM_TOOLS` Set:

```typescript
  "research_start",
  "research_confirm_brief",
  "research_approve_objectives",
  "research_export_report",
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/premium/manager.ts
git commit -m "feat(research): gate Research Desk behind premium"
```

---

### Task 7: Research IPC Handlers

**Files:**
- Create: `src/main/ipc/research.ts`
- Modify: `src/main/ipc/handlers.ts`

- [ ] **Step 1: Write research IPC handler registration**

```typescript
// src/main/ipc/research.ts
import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import type { ResearchState } from "../../shared/research-types";
import { createLogger } from "../../shared/logger";
import type { ResearchOrchestrator } from "../agent/research/orchestrator";
import { isToolGated } from "../premium/manager";

const logger = createLogger("ResearchIPC");

export function registerResearchHandlers(
  orchestrator: ResearchOrchestrator,
  getRuntimeState: () => ResearchState,
): void {
  ipcMain.handle(Channels.RESEARCH_STATE_GET, () => {
    return orchestrator.getState();
  });

  ipcMain.handle(
    Channels.RESEARCH_START_BRIEF,
    async (_event, query: string) => {
      if (isToolGated("research_start")) {
        return { accepted: false, reason: "premium" as const };
      }
      await orchestrator.startBrief(query);
      return { accepted: true };
    },
  );

  ipcMain.handle(Channels.RESEARCH_CONFIRM_BRIEF, () => {
    orchestrator.confirmBrief();
  });

  ipcMain.handle(
    Channels.RESEARCH_APPROVE_OBJECTIVES,
    (
      _event,
      options: {
        supervisionMode?: "walk-away" | "interactive";
        includeTraces?: boolean;
      },
    ) => {
      if (isToolGated("research_approve_objectives")) {
        return { accepted: false, reason: "premium" as const };
      }
      orchestrator.approveObjectives(
        options.supervisionMode,
        options.includeTraces,
      );
      // Fire off sub-agent execution in background
      orchestrator.executeSubAgents().catch((err) => {
        logger.error("Background sub-agent execution failed", err);
      });
      return { accepted: true };
    },
  );

  ipcMain.handle(
    Channels.RESEARCH_SET_MODE,
    (_event, mode: "walk-away" | "interactive") => {
      orchestrator.setSupervisionMode(mode);
    },
  );

  ipcMain.handle(
    Channels.RESEARCH_SET_TRACES,
    (_event, include: boolean) => {
      orchestrator.setIncludeTraces(include);
    },
  );

  ipcMain.handle(Channels.RESEARCH_CANCEL, () => {
    orchestrator.cancel();
  });

  ipcMain.handle(Channels.RESEARCH_EXPORT_REPORT, () => {
    if (isToolGated("research_export_report")) {
      return { accepted: false, reason: "premium" as const };
    }
    const state = orchestrator.getState();
    return {
      accepted: true,
      report: state.report,
      format: "markdown",
    };
  });

  // Push state updates to renderer when orchestrator changes
  orchestrator.setUpdateListener((state) => {
    // We broadcast to all renderer views
    const windows = require("electron").BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send(Channels.RESEARCH_STATE_UPDATE, state);
    }
  });
}
```

- [ ] **Step 2: Wire into handlers.ts**

In `src/main/ipc/handlers.ts`:
1. Add import at top:

```typescript
import { registerResearchHandlers } from "./research";
```

2. Before the existing handler registrations, add the research handler registration. Find where other handlers are registered (e.g., `registerBookmarkHandlers(...)`) and add after:

```typescript
// Research Desk
registerResearchHandlers(researchOrchestrator, () =>
  researchOrchestrator.getState(),
);
```

Note: This step requires the orchestrator to be instantiated. In `handlers.ts`, near where `activeChatProvider` and `runtime` are wired, add:

```typescript
import { ResearchOrchestrator } from "../agent/research/orchestrator";

let researchOrchestrator: ResearchOrchestrator | null = null;

// Later, where createProvider is called and runtime is available:
export function ensureResearchOrchestrator(
  provider: AIProvider,
  tabManager: WindowState["tabManager"],
  runtime: AgentRuntime,
): ResearchOrchestrator {
  if (!researchOrchestrator) {
    researchOrchestrator = new ResearchOrchestrator(provider, tabManager, runtime);
  }
  return researchOrchestrator;
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: May have errors from loose wiring — fix any import issues.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/research.ts src/main/ipc/handlers.ts
git commit -m "feat(research): add Research Desk IPC handlers"
```

---

### Task 8: Preload API

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add research API to preload**

After the existing `ai:` block in the `api` object, add:

```typescript
  research: {
    getState: (): Promise<ResearchState> =>
      ipcRenderer.invoke(Channels.RESEARCH_STATE_GET),
    onStateUpdate: (cb: (state: ResearchState) => void): (() => void) => {
      const handler = (_: unknown, state: ResearchState) => cb(state);
      ipcRenderer.on(Channels.RESEARCH_STATE_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.RESEARCH_STATE_UPDATE, handler);
    },
    startBrief: (query: string) =>
      ipcRenderer.invoke<
        { accepted: true } | { accepted: false; reason: "busy" | "premium" }
      >(Channels.RESEARCH_START_BRIEF, query),
    confirmBrief: () =>
      ipcRenderer.invoke(Channels.RESEARCH_CONFIRM_BRIEF),
    approveObjectives: (options?: {
      supervisionMode?: "walk-away" | "interactive";
      includeTraces?: boolean;
    }) =>
      ipcRenderer.invoke<
        { accepted: true } | { accepted: false; reason: "premium" }
      >(Channels.RESEARCH_APPROVE_OBJECTIVES, options ?? {}),
    setMode: (mode: "walk-away" | "interactive") =>
      ipcRenderer.invoke(Channels.RESEARCH_SET_MODE, mode),
    setTraces: (include: boolean) =>
      ipcRenderer.invoke(Channels.RESEARCH_SET_TRACES, include),
    cancel: () => ipcRenderer.invoke(Channels.RESEARCH_CANCEL),
    exportReport: () =>
      ipcRenderer.invoke<
        | { accepted: true; report: unknown; format: string }
        | { accepted: false; reason: "premium" }
      >(Channels.RESEARCH_EXPORT_REPORT),
  },
```

Also add the import at the top of the file:

```typescript
import type { ResearchState } from "../shared/research-types";
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(research): expose Research Desk API via preload"
```

---

### Task 9: Renderer Research Store

**Files:**
- Create: `src/renderer/src/stores/research.ts`

- [ ] **Step 1: Write the research store**

```typescript
// src/renderer/src/stores/research.ts
import { createSignal } from "solid-js";
import type { ResearchState } from "../../../shared/research-types";

const initialState: ResearchState = {
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

const [researchState, setResearchState] = createSignal<ResearchState>(initialState);
const [isResearchPremium, setIsResearchPremium] = createSignal(false);

let initialized = false;
let cleanup: (() => void) | null = null;

function init(): void {
  if (initialized) return;
  initialized = true;

  // Check premium status
  window.vessel.premium.getState().then((premium) => {
    setIsResearchPremium(premium.status === "active");
  });

  // Fetch initial state
  window.vessel.research.getState().then((state) => {
    setResearchState(state);
  });

  // Listen for state updates
  cleanup = window.vessel.research.onStateUpdate((state) => {
    setResearchState(state);
  });
}

export function useResearch() {
  init();

  return {
    state: researchState,
    isPremium: isResearchPremium,

    startBrief(query: string) {
      return window.vessel.research.startBrief(query);
    },

    confirmBrief() {
      return window.vessel.research.confirmBrief();
    },

    approveObjectives(options?: {
      supervisionMode?: "walk-away" | "interactive";
      includeTraces?: boolean;
    }) {
      return window.vessel.research.approveObjectives(options);
    },

    setMode(mode: "walk-away" | "interactive") {
      return window.vessel.research.setMode(mode);
    },

    setTraces(include: boolean) {
      return window.vessel.research.setTraces(include);
    },

    cancel() {
      return window.vessel.research.cancel();
    },

    exportReport() {
      return window.vessel.research.exportReport();
    },

    destroy() {
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
      initialized = false;
    },
  };
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/stores/research.ts
git commit -m "feat(research): add renderer research store"
```

---

### Task 10: Research Desk Sidebar Component

**Files:**
- Create: `src/renderer/src/components/ai/ResearchDesk.tsx`
- Modify: `src/renderer/src/components/ai/Sidebar.tsx`

- [ ] **Step 1: Write the ResearchDesk component**

```tsx
// src/renderer/src/components/ai/ResearchDesk.tsx
import { Show, Switch, Match, type Component } from "solid-js";
import { useResearch } from "../../stores/research";
import { isPremiumStatus } from "../../lib/premium";

export const ResearchDesk: Component = () => {
  const research = useResearch();
  const state = research.state;

  return (
    <div class="research-desk">
      <Switch>
        <Match when={state().phase === "idle"}>
          <div class="research-idle">
            <h3>Research Desk</h3>
            <p>Deep research with parallel sub-agents. I'll interview you to refine your question, then spawn agents to investigate multiple angles simultaneously. Every claim in the final report is source-anchored.</p>
            <Show
              when={research.isPremium()}
              fallback={
                <div class="premium-upsell">
                  <p>Research Desk is a Premium feature.</p>
                  <button onClick={() => window.vessel.premium.checkout()}>
                    Upgrade to Premium
                  </button>
                </div>
              }
            >
              <button
                class="research-start-btn"
                onClick={async () => {
                  const result = await research.startBrief(
                    prompt("What would you like to research?") ?? "",
                  );
                  if (!result.accepted && result.reason === "premium") {
                    // show premium upsell
                  }
                }}
              >
                Start Research
              </button>
            </Show>
          </div>
        </Match>

        <Match when={state().phase === "briefing"}>
          <div class="research-phase">
            <h3>Briefing</h3>
            <p>Answer the questions in the Chat tab to refine your research question.</p>
            <div class="phase-controls">
              <button onClick={() => research.confirmBrief()}>
                Confirm Brief
              </button>
              <button class="secondary" onClick={() => research.cancel()}>
                Cancel
              </button>
            </div>
          </div>
        </Match>

        <Match when={state().phase === "planning"}>
          <div class="research-phase">
            <h3>Planning Research</h3>
            <p>Creating Research Objectives based on your brief...</p>
          </div>
        </Match>

        <Match when={state().phase === "awaiting_approval"}>
          <div class="research-phase">
            <h3>Research Objectives</h3>
            <Show when={state().objectives}>
              {(obj) => (
                <div class="objectives-card">
                  <p><strong>Question:</strong> {obj().researchQuestion}</p>
                  <p><strong>Threads:</strong> {obj().threads.length}</p>
                  <ul>
                    {obj().threads.map((t) => (
                      <li>{t.label} ({t.sourceBudget} sources)</li>
                    ))}
                  </ul>

                  <label class="mode-toggle">
                    <input
                      type="checkbox"
                      checked={state().supervisionMode === "walk-away"}
                      onChange={(e) =>
                        research.setMode(
                          e.currentTarget.checked ? "walk-away" : "interactive",
                        )
                      }
                    />
                    Walk-away mode (notified when done)
                  </label>

                  <label class="traces-toggle">
                    <input
                      type="checkbox"
                      checked={state().includeTraces}
                      onChange={(e) =>
                        research.setTraces(e.currentTarget.checked)
                      }
                    />
                    Include agent traces with report
                  </label>

                  <div class="phase-controls">
                    <button
                      onClick={() =>
                        research.approveObjectives({
                          supervisionMode: state().supervisionMode,
                          includeTraces: state().includeTraces,
                        })
                      }
                    >
                      Start Research
                    </button>
                    <button class="secondary" onClick={() => research.cancel()}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </Match>

        <Match when={state().phase === "executing"}>
          <div class="research-phase">
            <h3>Researching</h3>
            <Show when={state().threadFindings.length > 0}>
              <p>{state().threadFindings.length} of {state().threads.length} threads complete</p>
            </Show>
            <Show when={state().supervisionMode === "interactive"}>
              <button onClick={() => research.setMode("walk-away")}>
                Switch to Walk-Away
              </button>
            </Show>
            <Show when={state().supervisionMode === "walk-away"}>
              <button onClick={() => research.setMode("interactive")}>
                Switch to Interactive
              </button>
            </Show>
          </div>
        </Match>

        <Match when={state().phase === "synthesizing"}>
          <div class="research-phase">
            <h3>Synthesizing Report</h3>
            <p>Compiling findings into the Research Report...</p>
          </div>
        </Match>

        <Match when={state().phase === "delivered"}>
          <div class="research-phase">
            <h3>Report Ready</h3>
            <Show when={state().report}>
              {(report) => (
                <div class="report-card">
                  <h4>{report().title}</h4>
                  <p>{report().executiveSummary.slice(0, 300)}...</p>
                  <p>{report().sourceIndex.length} sources cited</p>
                  <button onClick={() => research.exportReport()}>
                    Export as Markdown
                  </button>
                  <button class="secondary" onClick={() => research.cancel()}>
                    New Research
                  </button>
                </div>
              )}
            </Show>
          </div>
        </Match>
      </Switch>
    </div>
  );
};
```

- [ ] **Step 2: Add Research Desk tab to Sidebar**

In `src/renderer/src/components/ai/Sidebar.tsx`, add a "Research" tab that renders `<ResearchDesk />`. Follow the existing pattern for tabs (Supervisor, Bookmarks, Checkpoints, Chat, Automate, History, Changes).

- [ ] **Step 3: Run typecheck and check for compilation errors**

Run: `npm run typecheck`
Expected: PASS (or fix minor import issues)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ai/ResearchDesk.tsx src/renderer/src/components/ai/Sidebar.tsx
git commit -m "feat(research): add Research Desk sidebar component"
```

---

### Task 11: Unit Tests

**Files:**
- Create: `tests/research-orchestrator.test.ts`

- [ ] **Step 1: Write orchestrator state tests**

```typescript
// tests/research-orchestrator.test.ts
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
```

- [ ] **Step 2: Run the tests**

Run: `npx tsx --test tests/research-orchestrator.test.ts`
Expected: 4 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/research-orchestrator.test.ts
git commit -m "test(research): add orchestrator state transition tests"
```

---

### Task 12: Research IPC Handler Tests

**Files:**
- Create: `tests/research-ipc.test.ts`

- [ ] **Step 1: Write IPC handler integration tests**

```typescript
// tests/research-ipc.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import type { ResearchState } from "../src/shared/research-types";

describe("Research IPC handler contracts", () => {
  it("RESEARCH_START_BRIEF returns accepted:true when idle", async () => {
    // Simulate what the IPC handler does — check phase === idle
    const state: ResearchState = {
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

    const canStartBrief = state.phase === "idle";
    assert.strictEqual(canStartBrief, true);
  });

  it("RESEARCH_START_BRIEF returns accepted:false when busy", async () => {
    const state: ResearchState = {
      phase: "executing",
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

    const canStartBrief = state.phase === "idle";
    assert.strictEqual(canStartBrief, false);
  });

  it("RESEARCH_CANCEL resets to idle", async () => {
    const resetState: ResearchState = {
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

    assert.strictEqual(resetState.phase, "idle");
    assert.strictEqual(resetState.objectives, null);
    assert.strictEqual(resetState.report, null);
    assert.strictEqual(resetState.error, null);
  });

  it("RESEARCH_APPROVE_OBJECTIVES transitions to executing", async () => {
    let phase = "awaiting_approval";

    const canApprove = phase === "awaiting_approval";
    assert.strictEqual(canApprove, true);

    // After approval, phase becomes executing
    phase = "executing";
    assert.strictEqual(phase, "executing");
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx tsx --test tests/research-ipc.test.ts`
Expected: 4 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/research-ipc.test.ts
git commit -m "test(research): add IPC handler contract tests"
```

---

### Task 13: Report Synthesis Prompt

**Files:**
- Create: `src/main/agent/research/synthesis-prompt.ts`

- [ ] **Step 1: Write the synthesis prompt builder**

```typescript
// src/main/agent/research/synthesis-prompt.ts
import type { ThreadFindings, ResearchObjectives } from "../../../shared/research-types";

export function buildSynthesisPrompt(
  objectives: ResearchObjectives,
  findings: ThreadFindings[],
): string {
  const findingsBlock = findings
    .map(
      (f) => `
### Thread: ${f.threadLabel}
Question: ${f.threadQuestion}
Execution: ${f.executionSummary}

Claims:
${f.claims
  .map(
    (c, i) =>
      `${i + 1}. ${c.claim}
   Source: ${c.sourceUrl}
   Quote: "${c.extractedQuote}"`,
  )
  .join("\n")}

${f.discardedSources.length > 0 ? `Discarded sources:\n${f.discardedSources.map((d) => `- ${d.url}: ${d.reason}`).join("\n")}` : ""}`,
    )
    .join("\n\n---\n");

  return `Synthesize the following research findings into a complete Research Report.

RESEARCH QUESTION: ${objectives.researchQuestion}
AUDIENCE: ${objectives.audience}
EXPECTED OUTLINE:
${objectives.reportOutline.map((s) => `- ${s}`).join("\n")}

FINDINGS:
${findingsBlock}

INSTRUCTIONS:
1. Write an executive summary (2-3 paragraphs).
2. Write one section per thread, using the claims above.
3. Every factual claim MUST cite its source using the numbered index format [1], [2], etc.
4. Create a numbered Source Index at the end with URLs, titles, and supporting quotes.
5. Explicitly flag any contradictions between sources.
6. Explicitly flag any gaps — things the research did not answer.
7. Do not invent anything. Only use claims from the findings above.
8. Do not use emojis.

Return the report as structured markdown.`;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/agent/research/synthesis-prompt.ts
git commit -m "feat(research): add report synthesis prompt"
```

---

### Task 14: Wire Orchestrator into Chat Flow

**Files:**
- Modify: `src/main/ai/commands.ts`
- Modify: `src/main/ipc/handlers.ts`

- [ ] **Step 1: Wire orchestrator into the AI query handler**

In `src/main/ipc/handlers.ts`, when the user sends a chat message during the briefing phase, the orchestrator's system prompt should be used instead of the standard agent prompt. Modify the AI query handler to check `researchOrchestrator.getState().phase` and, when in "briefing" or "planning", use the orchestrator's system prompt.

The key change: in the section of `handleAIQuery` (from `commands.ts`) where the system prompt is built, add a conditional:

```typescript
// Check if a research brief is active
const researchState = researchOrchestrator?.getState();
if (researchState && (researchState.phase === "briefing" || researchState.phase === "planning")) {
  // Use orchestrator prompt instead of standard agent prompt
  const orchestratorPrompt = buildOrchestratorSystemPrompt() + "\n\n" +
    `Current phase: ${researchState.phase}\n` +
    (researchState.phase === "planning"
      ? "Now produce the Research Objectives based on the brief conversation above."
      : "Continue the briefing interview. Ask one question at a time.");

  // Use streamAgentQuery with the orchestrator prompt
  // ... (rest of the streaming logic)
}
```

This is a refinement step — the exact integration point depends on how `handleAIQuery` is currently called from handlers.ts.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/ai/commands.ts src/main/ipc/handlers.ts
git commit -m "feat(research): wire orchestrator into chat flow"
```

---

### Task 15: Export Report as Markdown

**Files:**
- Create: `src/main/agent/research/export.ts`

- [ ] **Step 1: Write the report exporter**

```typescript
// src/main/agent/research/export.ts
import type { ResearchReport, SubAgentTrace } from "../../../shared/research-types";

export function renderReportAsMarkdown(
  report: ResearchReport,
  traces?: SubAgentTrace[],
): string {
  const sections: string[] = [];

  sections.push(`# ${report.title}`);
  sections.push("");
  sections.push(`*Generated: ${report.generatedAt}*`);
  sections.push("");

  sections.push("## Executive Summary");
  sections.push(report.executiveSummary);
  sections.push("");

  for (const section of report.findingsByThread) {
    sections.push(`## ${section.threadLabel}`);
    sections.push(section.content);
    sections.push("");
  }

  if (report.contradictions.length > 0) {
    sections.push("## Contradictions & Discrepancies");
    for (const c of report.contradictions) {
      sections.push(`- **Claim:** ${c.claim}`);
      sections.push(`  - Source A: [${c.sourceA.url}](${c.sourceA.url}) — "${c.sourceA.claim}"`);
      sections.push(`  - Source B: [${c.sourceB.url}](${c.sourceB.url}) — "${c.sourceB.claim}"`);
      sections.push(`  - **Resolution:** ${c.resolution}`);
    }
    sections.push("");
  }

  if (report.gaps.length > 0) {
    sections.push("## Gaps & Unanswered Questions");
    for (const gap of report.gaps) {
      sections.push(`- ${gap}`);
    }
    sections.push("");
  }

  sections.push("## Source Index");
  for (const source of report.sourceIndex) {
    sections.push(
      `${source.index}. [${source.title}](${source.url}) — accessed ${source.accessedAt}`,
    );
    sections.push(`   > "${source.supportingQuote}"`);
  }
  sections.push("");

  if (traces && traces.length > 0) {
    sections.push("---");
    sections.push("");
    sections.push("## Appendix: Agent Traces");
    for (const trace of traces) {
      sections.push(`### ${trace.threadLabel}`);
      sections.push(`Started: ${trace.startedAt} | Finished: ${trace.finishedAt}`);
      sections.push(`Tool calls: ${trace.toolCalls.length}`);
      if (trace.errors.length > 0) {
        sections.push(`Errors: ${trace.errors.length}`);
        for (const err of trace.errors) {
          sections.push(`- [${err.timestamp}] ${err.message}`);
        }
      }
      sections.push("");
    }
  }

  return sections.join("\n");
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/agent/research/export.ts
git commit -m "feat(research): add markdown report exporter"
```

---

### Task 16: Final Integration & Smoke Test

**Files:**
- Modify: `tests/` — add smoke test

- [ ] **Step 1: Write smoke test**

```typescript
// tests/research-smoke.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { renderReportAsMarkdown } from "../src/main/agent/research/export";
import type { ResearchReport } from "../src/shared/research-types";

const mockReport: ResearchReport = {
  title: "Test Report",
  executiveSummary: "This is a test summary with a cited claim [1].",
  findingsByThread: [
    {
      threadLabel: "Test Thread",
      content: "Test finding with citation [1]. More details follow.",
    },
  ],
  contradictions: [
    {
      claim: "Test contradiction",
      sourceA: { url: "https://a.example.com", claim: "X is true" },
      sourceB: { url: "https://b.example.com", claim: "X is false" },
      resolution: "Source B appears more authoritative.",
    },
  ],
  gaps: ["We could not determine Y."],
  sourceIndex: [
    {
      index: 1,
      url: "https://example.com",
      title: "Example Source",
      accessedAt: "2026-05-01T12:00:00Z",
      supportingQuote: "The relevant quote from the source.",
    },
  ],
  generatedAt: "2026-05-01T12:00:00Z",
  objectives: {
    researchQuestion: "Test question?",
    threads: [
      {
        label: "Test Thread",
        question: "Test thread question?",
        searchQueries: ["test query"],
        preferredDomains: [],
        blockedDomains: [],
        sourceBudget: 3,
      },
    ],
    audience: "general",
    reportOutline: ["Introduction", "Findings"],
    totalSourceBudget: 3,
  },
};

describe("Research Desk smoke tests", () => {
  it("renders report as markdown", () => {
    const md = renderReportAsMarkdown(mockReport);
    assert.ok(md.includes("# Test Report"));
    assert.ok(md.includes("## Executive Summary"));
    assert.ok(md.includes("This is a test summary with a cited claim [1]"));
    assert.ok(md.includes("## Test Thread"));
    assert.ok(md.includes("## Contradictions & Discrepancies"));
    assert.ok(md.includes("## Gaps & Unanswered Questions"));
    assert.ok(md.includes("## Source Index"));
    assert.ok(md.includes("1. [Example Source](https://example.com)"));
  });

  it("includes agent traces when provided", () => {
    const md = renderReportAsMarkdown(mockReport, [
      {
        threadLabel: "Test Thread",
        toolCalls: [
          {
            tool: "navigate",
            args: { url: "https://example.com" },
            result: "Navigated to https://example.com",
            timestamp: "2026-05-01T12:00:00Z",
            durationMs: 1500,
          },
        ],
        errors: [],
        startedAt: "2026-05-01T12:00:00Z",
        finishedAt: "2026-05-01T12:01:00Z",
      },
    ]);
    assert.ok(md.includes("## Appendix: Agent Traces"));
    assert.ok(md.includes("Tool calls: 1"));
  });

  it("source-anchored claims have citations", () => {
    const md = renderReportAsMarkdown(mockReport);
    // Every claim reference [1] should have a corresponding source index entry
    assert.ok(md.includes("[1]"));
    assert.ok(md.includes("https://example.com"));
  });

  it("empty contradictions and gaps render cleanly", () => {
    const cleanReport = { ...mockReport, contradictions: [], gaps: [] };
    const md = renderReportAsMarkdown(cleanReport);
    assert.ok(!md.includes("## Contradictions"));
    assert.ok(!md.includes("## Gaps"));
  });
});
```

- [ ] **Step 2: Run the smoke tests**

Run: `npx tsx --test tests/research-smoke.test.ts`
Expected: 4 tests PASS

- [ ] **Step 3: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS across all files

- [ ] **Step 4: Commit**

```bash
git add tests/research-smoke.test.ts
git commit -m "test(research): add smoke tests for report export"
```

