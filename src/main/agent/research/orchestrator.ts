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
  return structuredClone(value);
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
    this.reset();
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
    const _tabId = randomUUID(); // Wire into sub-agent loop in Task 14
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
      const _systemPrompt = buildSubAgentSystemPrompt(thread); // Wire into sub-agent loop in Task 14

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
