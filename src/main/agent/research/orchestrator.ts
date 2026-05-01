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
import { buildSynthesisPrompt } from "./synthesis-prompt";
import type { AIProvider } from "../../ai/provider";
import { AGENT_TOOLS } from "../../ai/tools";
import { executeAction, type ActionContext } from "../../ai/page-actions";
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

  // ── state access ──────────────────────────────────────────────

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

  // ── supervision / config ──────────────────────────────────────

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

  // ── phase: idle → briefing ────────────────────────────────────

  async startBrief(userQuery: string): Promise<void> {
    if (this.state.phase !== "idle") {
      logger.warn("Research already in progress, ignoring startBrief");
      return;
    }
    this.state.startedAt = new Date().toISOString();
    this.setPhase("briefing");
    logger.info(`Brief started for query: ${userQuery.slice(0, 120)}`);
  }

  // ── phase: briefing → planning ─────────────────────────────────

  confirmBrief(): void {
    if (this.state.phase !== "briefing") {
      logger.warn("Not in briefing phase, ignoring confirmBrief");
      return;
    }
    this.setPhase("planning");
  }

  // ── phase: planning → awaiting_approval ────────────────────────

  setObjectives(objectives: ResearchObjectives): void {
    if (this.state.phase !== "planning") {
      logger.warn("Not in planning phase, ignoring setObjectives");
      return;
    }
    this.state.objectives = objectives;
    this.state.threads = objectives.threads.slice(0, MAX_THREADS);
    this.setPhase("awaiting_approval");
  }

  /**
   * Parse a planning-phase LLM response into ResearchObjectives.
   * Expects JSON (optionally wrapped in ```json fences).
   * Returns true if parsing succeeded and objectives were set.
   */
  parseAndSetObjectives(text: string): boolean {
    if (this.state.phase !== "planning") return false;

    // Extract JSON from markdown fences if present
    let json = text;
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      json = fenceMatch[1].trim();
    } else {
      // Try to find a JSON object starting with { and ending with }
      const objMatch = text.match(/\{[\s\S]*\}/);
      if (objMatch) json = objMatch[0];
    }

    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;

      // Validate required fields
      if (typeof parsed.researchQuestion !== "string" || !parsed.researchQuestion.trim()) {
        logger.warn("Missing researchQuestion in objectives JSON");
        return false;
      }
      if (!Array.isArray(parsed.threads) || parsed.threads.length === 0) {
        logger.warn("Missing or empty threads array in objectives JSON");
        return false;
      }

      const threads: ResearchThread[] = parsed.threads
        .map((t: unknown, i: number) => {
          const obj = t as Record<string, unknown>;
          const question = String(obj.question || "").trim();
          const searchQueries = Array.isArray(obj.searchQueries)
            ? obj.searchQueries
                .map((q) => String(q).trim())
                .filter(Boolean)
            : [];
          const sourceBudget =
            typeof obj.sourceBudget === "number" &&
            Number.isFinite(obj.sourceBudget)
              ? Math.max(1, Math.floor(obj.sourceBudget))
              : 5;
          return {
            label: String(obj.label || `Thread ${i + 1}`),
            question,
            searchQueries,
            preferredDomains: Array.isArray(obj.preferredDomains)
              ? obj.preferredDomains.map((d) => String(d).trim()).filter(Boolean)
              : [],
            blockedDomains: Array.isArray(obj.blockedDomains)
              ? obj.blockedDomains.map((d) => String(d).trim()).filter(Boolean)
              : [],
            sourceBudget,
          };
        })
        .filter((thread) => thread.question && thread.searchQueries.length > 0)
        .slice(0, MAX_THREADS);

      if (threads.length === 0) {
        logger.warn("Objectives JSON did not contain any valid research threads");
        return false;
      }

      const objectives: ResearchObjectives = {
        researchQuestion: String(parsed.researchQuestion).trim(),
        threads,
        audience: String(parsed.audience || "general").trim(),
        reportOutline: Array.isArray(parsed.reportOutline)
          ? parsed.reportOutline.map((s) => String(s).trim()).filter(Boolean)
          : [],
        totalSourceBudget: threads.reduce((sum, t) => sum + t.sourceBudget, 0),
      };

      this.setObjectives(objectives);
      logger.info(`Parsed ${objectives.threads.length} threads from objectives`);
      return true;
    } catch (err) {
      logger.warn("Failed to parse objectives JSON", err);
      return false;
    }
  }

  // ── phase: awaiting_approval → executing ───────────────────────

  approveObjectives(mode?: SupervisionMode, includeTraces?: boolean): void {
    if (this.state.phase !== "awaiting_approval") {
      logger.warn("Not awaiting approval, ignoring approveObjectives");
      return;
    }
    if (mode) this.state.supervisionMode = mode;
    if (includeTraces !== undefined) this.state.includeTraces = includeTraces;
    this.setPhase("executing");
  }

  // ── phase: executing → synthesizing ────────────────────────────

  async executeSubAgents(): Promise<void> {
    if (this.state.phase !== "executing" || !this.state.objectives) return;

    const findings: ThreadFindings[] = [];

    // Run sub-agents sequentially to avoid tab-switching race conditions
    for (const thread of this.state.threads) {
      if (this.state.phase !== "executing") return;
      try {
        const result = await this.runSubAgent(thread);
        if (this.state.phase !== "executing") return;
        findings.push(result);
      } catch (err) {
        if (this.state.phase !== "executing") return;
        logger.error(`Sub-agent "${thread.label}" failed`, err);
        findings.push({
          threadLabel: thread.label,
          threadQuestion: thread.question,
          claims: [],
          discardedSources: [],
          executionSummary: `Failed: ${String(err)}`,
        });
      }
    }

    if (this.state.phase !== "executing") return;
    this.state.threadFindings = findings;
    this.setPhase("synthesizing");

    // Auto-start synthesis
    try {
      await this.synthesizeReport();
    } catch (err) {
      logger.error("Auto-synthesis failed", err);
      this.state.error = `Synthesis failed: ${String(err)}`;
      this.setPhase("delivered");
    }
  }

  // ── sub-agent loop ─────────────────────────────────────────────

  private async runSubAgent(thread: ResearchThread): Promise<ThreadFindings> {
    const trace: SubAgentTrace = {
      threadLabel: thread.label,
      toolCalls: [],
      errors: [],
      startedAt: new Date().toISOString(),
      finishedAt: "",
    };

    const saveActiveId = this.tabManager.getActiveTabId();
    // Create a dedicated tab for this sub-agent
    const tabId = this.tabManager.createTab();

    // Switch to the sub-agent's tab so all tool calls target it
    if (tabId) this.tabManager.switchTab(tabId);

    const discardedSources: ThreadFindings["discardedSources"] = [];
    let transcript = "";

    try {
      if (!this.provider.streamAgentQuery) {
        throw new Error("Provider does not support agent tool loops");
      }

      const systemPrompt = buildSubAgentSystemPrompt(thread);
      const userMessage = `Begin researching: ${thread.question}\n\nStart by searching for: ${thread.searchQueries.join(" or ")}`;

      const actionCtx: ActionContext = {
        tabManager: this.tabManager,
        runtime: this.runtime,
        toolProfile: this.provider.agentToolProfile,
      };

      await this.provider.streamAgentQuery(
        systemPrompt,
        userMessage,
        AGENT_TOOLS,
        (chunk) => {
          transcript += chunk;
        },
        async (name, args) => {
          const t0 = Date.now();
          try {
            const output = await executeAction(name, args, actionCtx);
            trace.toolCalls.push({
              tool: name,
              args,
              result: output,
              timestamp: new Date().toISOString(),
              durationMs: Date.now() - t0,
            });
            return output;
          } catch (err) {
            // Check if it's a page access issue to track as discarded
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("paywall") || msg.includes("login required") || msg.includes("403")) {
              discardedSources.push({
                url: String(args.url || ""),
                title: String(args.url || "unknown"),
                reason: msg,
              });
            }
            trace.errors.push({
              message: msg,
              timestamp: new Date().toISOString(),
            });
            trace.toolCalls.push({
              tool: name,
              args,
              result: `Error: ${msg}`,
              timestamp: new Date().toISOString(),
              durationMs: Date.now() - t0,
            });
            return `Error: ${msg}`;
          }
        },
        () => {
          // onEnd — no-op; the streamAgentQuery Promise resolves after this
        },
      );
    } catch (err) {
      trace.errors.push({
        message: String(err),
        timestamp: new Date().toISOString(),
      });
    } finally {
      // Restore the original active tab
      if (saveActiveId) this.tabManager.switchTab(saveActiveId);
      trace.finishedAt = new Date().toISOString();
    }

    // Extract claims from the research transcript
    let claims: SourcedClaim[] = [];
    try {
      claims = await this.extractClaimsFromTranscript(thread, transcript);
    } catch (err) {
      logger.warn(`Claim extraction failed for "${thread.label}"`, err);
    }

    if (this.state.includeTraces) {
      this.state.subAgentTraces.push(trace);
    }

    const pagesVisited = trace.toolCalls.filter((t) =>
      ["navigate", "read_page", "search"].includes(t.tool),
    ).length;

    return {
      threadLabel: thread.label,
      threadQuestion: thread.question,
      claims,
      discardedSources,
      executionSummary: `Visited ${pagesVisited} pages (${trace.toolCalls.length} tool calls). ${claims.length} claims extracted. ${discardedSources.length} sources discarded.${trace.errors.length > 0 ? ` ${trace.errors.length} errors.` : ""}`,
    };
  }

  /**
   * Extract structured claims from the sub-agent's research transcript.
   * Makes a follow-up LLM call asking it to parse claims with source URLs and quotes.
   */
  private async extractClaimsFromTranscript(
    thread: ResearchThread,
    transcript: string,
  ): Promise<SourcedClaim[]> {
    if (!transcript.trim()) return [];

    const prompt = `You are a claim extractor. Given a research transcript, extract every factual claim along with its source URL and the exact supporting quote from the page.

CRITICAL RULES:
- Only extract claims that are explicitly supported by a source URL AND a verbatim quote in the transcript.
- If a claim has no source URL or no extracted quote, do NOT include it.
- Do not fabricate claims. Only use what is explicitly stated in the transcript.
- Return ONLY valid JSON — a JSON array of claim objects.

Each claim object must have these fields:
- claim: the factual claim text
- sourceUrl: the URL of the source page
- sourceTitle: the title of the source page (or "Unknown" if not mentioned)
- extractedQuote: the verbatim quote from the page that supports this claim
- relevanceNote: a one-sentence note on why this claim matters to the research question

Return format:
\`\`\`json
[{"claim": "...", "sourceUrl": "...", "sourceTitle": "...", "extractedQuote": "...", "relevanceNote": "..."}]
\`\`\`

RESEARCH QUESTION: ${thread.question}
THREAD LABEL: ${thread.label}

TRANSCRIPT:
${transcript.slice(0, 32000)}`;

    let response = "";
    await this.provider.streamQuery(
      prompt,
      "Extract the claims.",
      (chunk) => {
        response += chunk;
      },
      () => {},
    );

    // Parse JSON from response
    let json = response;
    const fenceMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) json = fenceMatch[1].trim();
    else {
      const arrMatch = response.match(/\[[\s\S]*\]/);
      if (arrMatch) json = arrMatch[0];
    }

    try {
      const raw = JSON.parse(json);
      if (!Array.isArray(raw)) return [];
      return raw
        .map((item: unknown) => {
          const c = item as Record<string, unknown>;
          return {
            claim: String(c.claim || "").trim(),
            sourceUrl: String(c.sourceUrl || "").trim(),
            sourceTitle: String(c.sourceTitle || c.sourceUrl || "Unknown").trim(),
            extractedQuote: String(c.extractedQuote || "").trim(),
            extractedAt: new Date().toISOString(),
            threadLabel: thread.label,
            relevanceNote: String(c.relevanceNote || "").trim(),
          };
        })
        .filter(
          (claim) => claim.claim && claim.sourceUrl && claim.extractedQuote,
        );
    } catch {
      logger.warn(`Failed to parse claims JSON for "${thread.label}"`);
      return [];
    }
  }

  // ── phase: synthesizing → delivered ───────────────────────────

  async synthesizeReport(): Promise<ResearchReport | null> {
    if (this.state.phase !== "synthesizing" || !this.state.objectives) {
      return null;
    }

    const objectives = this.state.objectives;
    const findings = this.state.threadFindings;

    const synthesisPrompt = buildSynthesisPrompt(objectives, findings);

    let response = "";
    await this.provider.streamQuery(
      synthesisPrompt,
      "Produce the final research report now.",
      (chunk) => {
        response += chunk;
      },
      () => {},
    );

    // Parse the markdown response into a ResearchReport
    const report = this.parseReportFromMarkdown(response, objectives);
    this.setReport(report);
    this.setPhase("delivered");
    return report;
  }

  /**
   * Parse the LLM's markdown synthesis response into a structured ResearchReport.
   * Extracts sections by markdown headers and builds the source index.
   */
  private parseReportFromMarkdown(
    markdown: string,
    objectives: ResearchObjectives,
  ): ResearchReport {
    // Extract title from first h1
    const titleMatch = markdown.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : objectives.researchQuestion;

    // Extract executive summary (between "Executive Summary" header and next h2)
    const execMatch = markdown.match(
      /##\s+Executive\s+Summary\s*\n([\s\S]*?)(?=\n##\s|\n---|\n$)/i,
    );
    const executiveSummary = execMatch ? execMatch[1].trim() : "";

    // Extract per-thread sections
    const findingsByThread: ResearchReport["findingsByThread"] = [];
    for (const thread of objectives.threads) {
      const escaped = thread.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const sectionRegex = new RegExp(
        `##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|\\n---|\\n#|\\n$)`,
        "i",
      );
      const sectionMatch = markdown.match(sectionRegex);
      if (sectionMatch) {
        findingsByThread.push({
          threadLabel: thread.label,
          content: sectionMatch[1].trim(),
        });
      }
    }

    // Extract contradictions
    const contradictions: ResearchReport["contradictions"] = [];
    const contraMatch = markdown.match(
      /##\s+Contradictions\s+&?\s*Discrepancies\s*\n([\s\S]*?)(?=\n##\s|\n---|\n$)/i,
    );
    if (contraMatch) {
      const lines = contraMatch[1].split("\n");
      let current: Partial<ResearchReport["contradictions"][number]> = {};
      for (const line of lines) {
        const claimMatch = line.match(/^\-\s+\*\*Claim:\*\*\s+(.+)/);
        const aMatch = line.match(/Source\s+A:\s+\[(.+?)\]\((.+?)\)\s+—\s+"(.+)"/);
        const bMatch = line.match(/Source\s+B:\s+\[(.+?)\]\((.+?)\)\s+—\s+"(.+)"/);
        const resMatch = line.match(/\*\*Resolution:\*\*\s+(.+)/);

        if (claimMatch) current.claim = claimMatch[1].trim();
        if (aMatch)
          current.sourceA = { url: aMatch[2], claim: aMatch[3] };
        if (bMatch)
          current.sourceB = { url: bMatch[2], claim: bMatch[3] };
        if (resMatch) {
          current.resolution = resMatch[1].trim();
          if (current.claim && current.sourceA && current.sourceB && current.resolution) {
            contradictions.push(current as ResearchReport["contradictions"][number]);
          }
          current = {};
        }
      }
    }

    // Extract gaps
    const gaps: string[] = [];
    const gapsMatch = markdown.match(
      /##\s+Gaps\s+&?\s*Unanswered\s+Questions\s*\n([\s\S]*?)(?=\n##\s|\n---|\n$)/i,
    );
    if (gapsMatch) {
      for (const line of gapsMatch[1].split("\n")) {
        const gap = line.match(/^\-\s+(.+)/);
        if (gap) gaps.push(gap[1].trim());
      }
    }

    // Extract source index
    const sourceIndex: ResearchReport["sourceIndex"] = [];
    const sourcesMatch = markdown.match(
      /##\s+Source\s+Index\s*\n([\s\S]*?)(?=\n---|\n##\s|\n#\s|\n$)/i,
    );
    if (sourcesMatch) {
      for (const line of sourcesMatch[1].split("\n")) {
        const srcMatch = line.match(
          /^(\d+)\.\s+\[(.+?)\]\((.+?)\)\s+—\s+accessed\s+(.+)/,
        );
        const quoteMatch = line.match(/^\s*>\s*"(.+)"/);
        if (srcMatch) {
          sourceIndex.push({
            index: parseInt(srcMatch[1], 10),
            title: srcMatch[2],
            url: srcMatch[3],
            accessedAt: srcMatch[4],
            supportingQuote: "",
          });
        } else if (quoteMatch && sourceIndex.length > 0) {
          sourceIndex[sourceIndex.length - 1].supportingQuote = quoteMatch[1];
        }
      }
    }

    return {
      title,
      executiveSummary,
      findingsByThread,
      contradictions,
      gaps,
      sourceIndex,
      generatedAt: new Date().toISOString(),
      objectives,
    };
  }

  // ── report management ──────────────────────────────────────────

  setReport(report: ResearchReport): void {
    this.state.report = report;
    this.emit();
  }

  // ── reset ──────────────────────────────────────────────────────

  reset(): void {
    this.state = this.initialState();
    this.emit();
  }
}
