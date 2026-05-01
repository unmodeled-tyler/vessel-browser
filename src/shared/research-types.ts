/**
 * Type definitions for the Research Desk feature.
 *
 * Data flow:
 *   ResearchThread -> ResearchObjectives -> SourcedClaim[] -> ThreadFindings[] -> ResearchReport
 *   SubAgentTrace mirrors the execution path for each thread.
 *   ResearchState is the top-level state container for the research UI.
 */

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
