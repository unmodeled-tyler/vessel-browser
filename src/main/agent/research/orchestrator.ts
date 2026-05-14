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
  ResearchThreadProgressStatus,
} from "../../../shared/research-types";
import { buildOrchestratorSystemPrompt } from "./orchestrator-prompt";
import { buildSubAgentSystemPrompt } from "./sub-agent-prompt";
import { buildSynthesisPrompt } from "./synthesis-prompt";
import type { AIProvider } from "../../ai/provider";
import { AGENT_TOOLS } from "../../ai/tools";
import { executeAction, type ActionContext, TabMutex } from "../../ai/page-actions";
import type { TabManager } from "../../tabs/tab-manager";
import type { AgentRuntime } from "../runtime";
import { loadSettings } from "../../config/settings";

const logger = createLogger("ResearchOrchestrator");
const MAX_THREADS = 5;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeSourceDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  try {
    return new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    ).hostname.replace(/^www\./, "");
  } catch {
    return trimmed.replace(/^www\./, "");
  }
}

function mergeBlockedSourceDomains(thread: ResearchThread): ResearchThread {
  const globalBlocked = loadSettings().sourceDoNotAllowList
    .map(normalizeSourceDomain)
    .filter(Boolean);
  if (globalBlocked.length === 0) return thread;

  const blockedDomains = Array.from(
    new Set([
      ...thread.blockedDomains.map(normalizeSourceDomain).filter(Boolean),
      ...globalBlocked,
    ]),
  );

  return {
    ...thread,
    blockedDomains,
  };
}

function matchesSourceDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function getBlockedSourceNavigation(
  url: unknown,
  blockedDomains: string[],
): string | null {
  if (typeof url !== "string" || blockedDomains.length === 0) return null;
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return (
      blockedDomains.find((domain) =>
        matchesSourceDomain(hostname, normalizeSourceDomain(domain)),
      ) ?? null
    );
  } catch {
    return null;
  }
}

function buildFallbackSourceIndex(
  findings: ThreadFindings[],
): ResearchReport["sourceIndex"] {
  const seen = new Set<string>();
  const sources: ResearchReport["sourceIndex"] = [];

  for (const claim of findings.flatMap((finding) => finding.claims)) {
    if (!claim.sourceUrl || seen.has(claim.sourceUrl)) continue;
    seen.add(claim.sourceUrl);
    sources.push({
      index: sources.length + 1,
      url: claim.sourceUrl,
      title: claim.sourceTitle || claim.sourceUrl,
      accessedAt: claim.extractedAt,
      supportingQuote: claim.extractedQuote,
    });
  }

  return sources;
}

function citationForClaim(
  claim: SourcedClaim,
  sourceIndex: ResearchReport["sourceIndex"],
): string {
  const index =
    sourceIndex.find((source) => source.url === claim.sourceUrl)?.index ?? 0;
  return index > 0 ? `[${index}]` : "";
}

function buildFallbackFindingsByThread(
  findings: ThreadFindings[],
  sourceIndex = buildFallbackSourceIndex(findings),
): ResearchReport["findingsByThread"] {
  return findings.map((finding) => {
    const claimLines = finding.claims.map((claim) => {
      const citation = citationForClaim(claim, sourceIndex);
      return citation
        ? `${claim.claim} ${citation}`
        : claim.claim;
    });

    return {
      threadLabel: finding.threadLabel,
      content:
        claimLines.length > 0
          ? claimLines.join("\n\n")
          : `No citeable claims were extracted for this thread. ${finding.executionSummary}`,
    };
  });
}

function buildFallbackReport(
  objectives: ResearchObjectives,
  findings: ThreadFindings[],
  reason: string,
): ResearchReport {
  const sourceIndex = buildFallbackSourceIndex(findings);
  const findingsByThread = buildFallbackFindingsByThread(findings, sourceIndex);
  const claimCount = findings.reduce(
    (sum, finding) => sum + finding.claims.length,
    0,
  );
  const executiveSummary =
    claimCount > 0
      ? `The model's final synthesis response could not be parsed, so Vessel generated this sourced fallback from ${claimCount} extracted claim${claimCount === 1 ? "" : "s"} across ${sourceIndex.length} source${sourceIndex.length === 1 ? "" : "s"}.`
      : `The model's final synthesis response could not be parsed, and no citeable claims were extracted from the research threads.`;

  return {
    title: objectives.researchQuestion,
    executiveSummary,
    findingsByThread,
    contradictions: [],
    gaps: [`Final synthesis JSON could not be parsed: ${reason}`],
    sourceIndex,
    generatedAt: new Date().toISOString(),
    objectives,
  };
}

export class ResearchOrchestrator {
  private state: ResearchState;
  private updateListener: ((state: ResearchState) => void) | null = null;
  private stopRequested = false;
  private synthesizeAfterStop = false;

  constructor(
    private provider: AIProvider | null,
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
      threadProgress: [],
      threadFindings: [],
      report: null,
      subAgentTraces: [],
      error: null,
      startedAt: null,
      originalQuery: null,
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
    // Reset visible state immediately. Running sub-agents observe phase !== "executing"
    // and bail at their next checkpoint without delivering stale results.
    this.stopRequested = true;
    this.synthesizeAfterStop = false;
    this.provider?.cancel();
    this.state = this.initialState();
    this.emit();
  }

  stopAndSynthesizeCurrentFindings(): void {
    if (this.state.phase !== "executing") {
      logger.warn("Not executing, ignoring stopAndSynthesizeCurrentFindings");
      return;
    }
    this.stopRequested = true;
    this.synthesizeAfterStop = true;
    this.state.threadProgress = this.state.threadProgress.map((progress) =>
      progress.status === "completed" || progress.status === "failed"
        ? progress
        : {
            ...progress,
            status: "stopping",
            message: "Stopping and preparing to synthesize current findings",
            updatedAt: new Date().toISOString(),
          },
    );
    this.emit();
    this.provider?.cancel();
  }

  /**
   * Swap the AI provider used by this orchestrator.
   * Safe to call while research is in progress — running sub-agents
   * pick up the new provider on their next LLM call.
   */
  setProvider(provider: AIProvider): void {
    this.provider = provider;
  }

  private getProvider(): AIProvider {
    if (!this.provider) {
      throw new Error("Chat provider not configured - required for Research Desk");
    }
    return this.provider;
  }

  // ── phase: idle → briefing ────────────────────────────────────

  async startBrief(userQuery: string): Promise<void> {
    const query = userQuery.trim();
    if (!query) {
      logger.warn("Ignoring empty Research Desk query");
      return;
    }
    if (this.state.phase !== "idle") {
      logger.warn("Research already in progress, ignoring startBrief");
      return;
    }

    // Ensure a fresh run never inherits stale objectives, reports, traces, or errors.
    this.state = this.initialState();
    this.state.originalQuery = query;
    this.state.startedAt = new Date().toISOString();
    this.setPhase("briefing");
    logger.info(`Brief started for query: ${query.slice(0, 120)}`);
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
    const threads = objectives.threads
      .slice(0, MAX_THREADS)
      .map(mergeBlockedSourceDomains);
    this.state.objectives = {
      ...objectives,
      threads,
    };
    this.state.threads = threads;
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
    this.stopRequested = false;
    this.synthesizeAfterStop = false;
    this.state.threadFindings = [];
    this.state.threadProgress = this.state.threads.map((thread) => ({
      threadLabel: thread.label,
      status: "queued",
      message: "Queued",
      updatedAt: new Date().toISOString(),
    }));
    this.setPhase("executing");
  }

  private updateThreadProgress(
    threadLabel: string,
    status: ResearchThreadProgressStatus,
    message: string,
  ): void {
    const updatedAt = new Date().toISOString();
    const existingIndex = this.state.threadProgress.findIndex(
      (progress) => progress.threadLabel === threadLabel,
    );
    const next = { threadLabel, status, message, updatedAt };
    this.state.threadProgress =
      existingIndex >= 0
        ? this.state.threadProgress.map((progress, index) =>
            index === existingIndex ? next : progress,
          )
        : [...this.state.threadProgress, next];
    this.emit();
  }

  // ── phase: executing → synthesizing ────────────────────────────

  async executeSubAgents(): Promise<void> {
    if (this.state.phase !== "executing" || !this.state.objectives) return;

    // Shared mutex so parallel sub-agents serialize browser access
    const tabMutex = new TabMutex();

    const results = await Promise.all(
      this.state.threads.map((thread) => {
        if (this.state.phase !== "executing") return null;
        return this.runSubAgent(thread, tabMutex).catch((err) => {
          logger.error(`Sub-agent "${thread.label}" failed`, err);
          return {
            threadLabel: thread.label,
            threadQuestion: thread.question,
            claims: [],
            discardedSources: [],
            executionSummary: `Failed: ${String(err)}`,
          } satisfies ThreadFindings;
        });
      }),
    );

    const shouldSynthesize = this.synthesizeAfterStop;
    if (this.state.phase !== "executing") return;
    this.state.threadFindings = results.filter((f): f is ThreadFindings => f !== null);
    this.stopRequested = false;
    this.synthesizeAfterStop = false;
    if (!shouldSynthesize) {
      for (const finding of this.state.threadFindings) {
        this.updateThreadProgress(
          finding.threadLabel,
          finding.claims.length > 0 ? "completed" : "failed",
          finding.claims.length > 0
            ? `${finding.claims.length} claim${finding.claims.length === 1 ? "" : "s"} extracted`
            : "No citeable claims extracted",
        );
      }
    }
    this.setPhase("synthesizing");

    try {
      await this.synthesizeReport();
    } catch (err) {
      logger.error("Auto-synthesis failed", err);
      this.state.error = `Synthesis failed: ${String(err)}`;
      this.setPhase("delivered");
    }
  }

  // ── sub-agent loop ─────────────────────────────────────────────

  private async runSubAgent(
    thread: ResearchThread,
    tabMutex: TabMutex,
  ): Promise<ThreadFindings> {
    const trace: SubAgentTrace = {
      threadLabel: thread.label,
      toolCalls: [],
      errors: [],
      startedAt: new Date().toISOString(),
      finishedAt: "",
    };

    const tabId = this.tabManager.createTab();
    let sourcesConsumed = 0;
    this.updateThreadProgress(thread.label, "running", "Researching sources");

    // Switch to the sub-agent's tab so initial navigation targets it
    if (tabId) this.tabManager.switchTab(tabId);

    const discardedSources: ThreadFindings["discardedSources"] = [];
    let transcript = "";

    try {
      const provider = this.getProvider();
      if (!provider.streamAgentQuery) {
        throw new Error("Provider does not support agent tool loops");
      }

      const systemPrompt = buildSubAgentSystemPrompt(thread);
      const userMessage = `Begin researching: ${thread.question}\n\nStart by searching for: ${thread.searchQueries.join(" or ")}`;

      const actionCtx: ActionContext = {
        tabManager: this.tabManager,
        runtime: this.runtime,
        toolProfile: provider.agentToolProfile,
        tabId: tabId ?? undefined,
        _tabMutex: tabMutex,
      };

      await provider.streamAgentQuery(
        systemPrompt,
        userMessage,
        AGENT_TOOLS,
        (chunk) => {
          transcript += chunk;
        },
        async (name, args) => {
          const t0 = Date.now();

          // Honour cancellation
          if (this.state.phase !== "executing" || this.stopRequested) {
            const msg = "Research cancelled — stopping.";
            return msg;
          }

          // Enforce source budget
          if (name === "navigate") {
            const blockedDomain = getBlockedSourceNavigation(
              args.url,
              thread.blockedDomains,
            );
            if (blockedDomain) {
              const msg = `Source skipped: ${String(args.url)} matches the Research Desk source do-not-allow list (${blockedDomain}). Choose a different source.`;
              discardedSources.push({
                url: String(args.url || ""),
                title: String(args.url || "excluded source"),
                reason: msg,
              });
              trace.toolCalls.push({
                tool: name,
                args,
                result: msg,
                timestamp: new Date().toISOString(),
                durationMs: 0,
              });
              return msg;
            }
          }

          if (name === "navigate" || name === "search") {
            sourcesConsumed++;
            if (sourcesConsumed > thread.sourceBudget) {
              const msg = `Source budget (${thread.sourceBudget}) exceeded. Summarize findings and stop.`;
              trace.toolCalls.push({
                tool: name,
                args,
                result: msg,
                timestamp: new Date().toISOString(),
                durationMs: 0,
              });
              return msg;
            }
          }

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
        () => {},
      );
    } catch (err) {
      trace.errors.push({
        message: String(err),
        timestamp: new Date().toISOString(),
      });
      if (this.state.phase === "executing") {
        this.updateThreadProgress(thread.label, "stopping", "Stopping thread");
      }
    } finally {
      trace.finishedAt = new Date().toISOString();
      // Close the sub-agent's dedicated tab to prevent tab leak
      if (tabId) {
        try {
          this.tabManager.closeTab(tabId);
        } catch (err) {
          logger.warn(`Failed to close sub-agent tab ${tabId}`, err);
        }
      }
    }

    let claims: SourcedClaim[] = [];
    if (this.state.phase === "executing") {
      try {
        claims = await this.extractClaimsFromTranscript(thread, transcript);
      } catch (err) {
        logger.warn(`Claim extraction failed for "${thread.label}"`, err);
      }
    }

    if (this.state.phase === "executing" && this.state.includeTraces) {
      this.state.subAgentTraces.push(trace);
    }

    const pagesVisited = trace.toolCalls.filter((t) =>
      ["navigate", "read_page", "search"].includes(t.tool),
    ).length;

    if (this.state.phase === "executing") {
      this.updateThreadProgress(
        thread.label,
        claims.length > 0 ? "completed" : this.stopRequested ? "stopping" : "failed",
        claims.length > 0
          ? `${claims.length} claim${claims.length === 1 ? "" : "s"} extracted`
          : this.stopRequested
            ? "Stopped before citeable claims were extracted"
            : "No citeable claims extracted",
      );
    }

    return {
      threadLabel: thread.label,
      threadQuestion: thread.question,
      claims,
      discardedSources,
      executionSummary: `Visited ${pagesVisited} pages (${trace.toolCalls.length} tool calls, ${sourcesConsumed} sources). ${claims.length} claims extracted. ${discardedSources.length} sources discarded.${trace.errors.length > 0 ? ` ${trace.errors.length} errors.` : ""}`,
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
    await this.getProvider().streamQuery(
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
    await this.getProvider().streamQuery(
      synthesisPrompt,
      "Return ONLY the JSON object now.",
      (chunk) => {
        response += chunk;
      },
      () => {},
    );

    const report = this.parseReportFromJson(response, objectives, findings);
    this.setReport(report);
    this.setPhase("delivered");
    return report;
  }

  /**
   * Parse the LLM's JSON synthesis response into a structured ResearchReport.
   * Handles both bare JSON and JSON wrapped in markdown fences.
   */
  private parseReportFromJson(
    text: string,
    objectives: ResearchObjectives,
    findings: ThreadFindings[],
  ): ResearchReport {
    let json = text.trim();

    // Strip markdown fences if present
    const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) json = fenceMatch[1].trim();

    // Find the outermost JSON object
    const objMatch = json.match(/\{[\s\S]*\}/);
    if (objMatch) json = objMatch[0];

    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;

      const sourceIndex = Array.isArray(parsed.sourceIndex)
        ? parsed.sourceIndex
            .map((s: unknown) => {
              const obj = s as Record<string, unknown>;
              return {
                index:
                  typeof obj.index === "number"
                    ? obj.index
                    : parseInt(String(obj.index), 10) || 0,
                url: String(obj.url || "").trim(),
                title: String(obj.title || "").trim(),
                accessedAt: String(obj.accessedAt || "").trim(),
                supportingQuote: String(obj.supportingQuote || "").trim(),
              };
            })
            .filter((s) => s.url && s.title)
        : [];

      const findingsByThread = Array.isArray(parsed.findingsByThread)
        ? parsed.findingsByThread.map((s: unknown) => {
            const obj = s as Record<string, unknown>;
            return {
              threadLabel: String(obj.threadLabel || "").trim(),
              content: String(obj.content || "").trim(),
            };
          })
        : [];

      return {
        title: String(parsed.title || objectives.researchQuestion).trim(),
        executiveSummary: String(parsed.executiveSummary || "").trim(),
        findingsByThread:
          findingsByThread.length > 0
            ? findingsByThread
            : buildFallbackFindingsByThread(findings),
        contradictions: Array.isArray(parsed.contradictions)
          ? parsed.contradictions
              .map((c: unknown) => {
                const obj = c as Record<string, unknown>;
                const sourceA = (obj.sourceA ?? {}) as Record<string, unknown>;
                const sourceB = (obj.sourceB ?? {}) as Record<string, unknown>;
                return {
                  claim: String(obj.claim || "").trim(),
                  sourceA: {
                    url: String(sourceA.url || "").trim(),
                    claim: String(sourceA.claim || "").trim(),
                  },
                  sourceB: {
                    url: String(sourceB.url || "").trim(),
                    claim: String(sourceB.claim || "").trim(),
                  },
                  resolution: String(obj.resolution || "").trim(),
                };
              })
              .filter(
                (c) => c.claim && c.sourceA.url && c.sourceB.url && c.resolution,
              )
          : [],
        gaps: Array.isArray(parsed.gaps)
          ? parsed.gaps.map((g) => String(g).trim()).filter(Boolean)
          : [],
        sourceIndex:
          sourceIndex.length > 0 ? sourceIndex : buildFallbackSourceIndex(findings),
        generatedAt: new Date().toISOString(),
        objectives,
      };
    } catch (err) {
      logger.warn("Failed to parse synthesis JSON, using sourced fallback report", err);
      return buildFallbackReport(objectives, findings, String(err));
    }
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
