import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { AIProvider } from "./provider";
import type { AIMessage } from "../../shared/types";
import type { ResearchClarification } from "../../shared/research-types";
import { createTraceSession } from "../telemetry/dev-trace";
import {
  buildSummarizePrompt,
  buildQuestionPrompt,
  buildGeneralPrompt,
  buildScopedContext,
  chooseAgentReadMode,
  detectPageType,
} from "./context-builder";
import { buildAgentSystemPrompt } from "./agent-prompt";
import { buildCompactScopedContext } from "./compact-context";
import { extractContent } from "../content/extractor";
import { AGENT_TOOLS } from "./tools";
import { pruneToolsForContext } from "../tools/pruner";
import { executeAction, type ActionContext, clearCartState } from "./page-actions";
import type { TabManager } from "../tabs/tab-manager";
import type { WebContents } from "electron";
import type { AgentRuntime } from "../agent/runtime";
import { buildOrchestratorSystemPrompt } from "../agent/research/orchestrator-prompt";
import type { ResearchOrchestrator } from "../agent/research/orchestrator";

const ASK_RESEARCH_USER_TOOL: Anthropic.Tool = {
  name: "ask_research_user",
  description:
    "Ask the user one Research Desk briefing question with optional clickable answer choices. Use this when the research brief needs clarification. Do not also write the question in normal assistant text.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The concise question to show in the Research Desk chat.",
      },
      options: {
        type: "array",
        description:
          "Optional answer choices to render as clickable buttons. Keep labels short and user-facing.",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Short button label.",
            },
            response: {
              type: "string",
              description:
                "Optional full response to send when the user selects this choice.",
            },
          },
          required: ["label"],
        },
        maxItems: 6,
      },
      allowTypedResponse: {
        type: "boolean",
        description:
          "Whether the user should also be able to answer in their own words. Defaults to true.",
      },
    },
    required: ["question"],
  },
};

const RESEARCH_BRIEFING_TOOLS: Anthropic.Tool[] = [ASK_RESEARCH_USER_TOOL];

function cleanResearchString(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function normalizeResearchClarification(
  args: Record<string, unknown>,
): ResearchClarification | null {
  const question = cleanResearchString(args.question, 500);
  if (question.length < 2) return null;

  const rawOptions = Array.isArray(args.options) ? args.options : [];
  const options = rawOptions
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const label = cleanResearchString(record.label, 80);
      if (label.length < 1) return null;
      const response = cleanResearchString(record.response, 500) || label;
      return { label, response };
    })
    .filter((item): item is { label: string; response: string } => item !== null)
    .slice(0, 6);

  return {
    id: randomUUID(),
    question,
    options,
    allowTypedResponse: args.allowTypedResponse !== false,
  };
}

function stripResearchQuestionToolMarkers(text: string): string {
  return text.replace(/\n?<<tool:ask_research_user(?::[^>]*)?>>\n?/g, "");
}

export async function handleAIQuery(
  query: string,
  provider: AIProvider,
  activeWebContents: WebContents | undefined,
  onChunk: (text: string) => void,
  onEnd: () => void,
  tabManager?: TabManager,
  runtime?: AgentRuntime,
  history?: AIMessage[],
  researchOrchestrator?: ResearchOrchestrator,
  onResearchClarification?: (payload: ResearchClarification) => void,
): Promise<void> {
  // Research Desk: during briefing/planning, use the orchestrator's system prompt
  if (researchOrchestrator) {
    const researchState = researchOrchestrator.getState();
    if (researchState.phase === "briefing" || researchState.phase === "planning") {
      const isPlanning = researchState.phase === "planning";
      const phaseInstruction = isPlanning
        ? "\n\nNow produce the Research Objectives based on the brief conversation above. Output them as a JSON object with researchQuestion, threads (array of {label, question, searchQueries, sourceBudget}), audience, reportOutline, and totalSourceBudget fields."
        : "\n\nContinue the briefing interview. Ask one question at a time. When you need input from the user, call ask_research_user with the exact question and any useful answer options instead of writing a freeform question.";

      let fullResponse = "";
      let clarificationPresented = false;
      const wrappedOnChunk = (text: string) => {
        if (clarificationPresented) return;
        const visibleText = stripResearchQuestionToolMarkers(text);
        fullResponse += visibleText;
        if (visibleText) onChunk(visibleText);
      };

      const wrappedOnEnd = () => {
        // In planning phase, try to parse objectives from the response
        if (isPlanning) {
          const parsed = researchOrchestrator.parseAndSetObjectives(fullResponse);
          if (!parsed) {
            // Parsing failed — the LLM didn't produce valid JSON
            onChunk(
              "\n\n[Failed to parse objectives. Please try confirming the brief again or refine your research question.]",
            );
          }
        }
        onEnd();
      };

      if (!isPlanning && provider.streamAgentQuery) {
        await provider.streamAgentQuery(
          buildOrchestratorSystemPrompt() + phaseInstruction,
          query,
          RESEARCH_BRIEFING_TOOLS,
          wrappedOnChunk,
          async (name, args) => {
            if (name !== ASK_RESEARCH_USER_TOOL.name) {
              return `Error: Unsupported Research Desk briefing tool "${name}".`;
            }

            const clarification = normalizeResearchClarification(args);
            if (!clarification) {
              return "Error: ask_research_user requires a non-empty question.";
            }

            clarificationPresented = true;
            if (onResearchClarification) {
              onResearchClarification(clarification);
            } else {
              onChunk(clarification.question);
            }

            return "Question presented to the user. Stop and wait for the user's answer.";
          },
          wrappedOnEnd,
          history,
        );
        return;
      }

      await provider.streamQuery(
        buildOrchestratorSystemPrompt() + phaseInstruction,
        query,
        wrappedOnChunk,
        wrappedOnEnd,
        history,
      );
      return;
    }
  }

  const lowerQuery = query.toLowerCase().trim();

  const isSummarize =
    lowerQuery.startsWith("summarize") ||
    lowerQuery.startsWith("tldr") ||
    lowerQuery === "summary";

  // Use agent path when provider supports tools and we have a tab manager
  if (provider.streamAgentQuery && tabManager && activeWebContents && runtime) {
    try {
      const pageContent = await extractContent(activeWebContents);
      const pageType = detectPageType(pageContent);
      const defaultReadMode = chooseAgentReadMode(pageContent);
      if (provider.agentToolProfile === "compact") {
        const prevGoal = runtime.getState().taskTracker?.goal?.trim();
        runtime.ensureTaskTracker(query, pageContent.url || activeWebContents.getURL());
        // Clear stale cart tracking when the user starts a different task
        // so the model does not see false "already in cart" warnings from
        // a previous run.
        if (prevGoal !== query.trim()) {
          clearCartState();
        }
      } else {
        runtime.clearTaskTracker();
        clearCartState();
      }
      const structuredContext =
        provider.agentToolProfile === "compact"
          ? buildCompactScopedContext(
              pageContent,
              defaultReadMode,
              pageType,
            )
          : buildScopedContext(pageContent, defaultReadMode);
      const runtimeState = runtime.getState();
      const recentCheckpoints = runtimeState.checkpoints
        .slice(-3)
        .map((item) => `- ${item.name} (${item.id})`)
        .join("\n");
      const taskTrackerContext = runtime.getTaskTrackerContext();

      const activeTabTitle = pageContent.title || "(untitled)";
      const activeTabUrl = pageContent.url || activeWebContents.getURL();
      const allTabs = tabManager.getAllStates();
      const activeTabId = tabManager.getActiveTabId();
      const tabSummary =
        allTabs.length > 1
          ? `\nAll open tabs: ${allTabs.map((t) => `${t.id === activeTabId ? "→ " : ""}${t.title || "New Tab"} (${t.url})`).join(" | ")}`
          : "";

      const systemPrompt = buildAgentSystemPrompt({
        profile: provider.agentToolProfile,
        activeTabTitle,
        activeTabUrl,
        tabSummary,
        defaultReadMode,
        pageType,
        structuredContext,
        supervisorPaused: runtimeState.supervisor.paused,
        approvalMode: runtimeState.supervisor.approvalMode,
        pendingApprovals: runtimeState.supervisor.pendingApprovals.length,
        recentCheckpoints: recentCheckpoints || "- none",
        taskTrackerContext: taskTrackerContext || "- none",
      });

      const actionCtx: ActionContext = {
        tabManager,
        runtime,
        toolProfile: provider.agentToolProfile,
      };

      // Speedee: dynamically reorder tools based on current page context
      const contextualTools = pruneToolsForContext(
        AGENT_TOOLS,
        pageType,
        query,
        { profile: provider.agentToolProfile },
      );

      const trace = createTraceSession(query, activeTabUrl, activeTabTitle);

      let accumulatedResponse = "";
      const tracedOnChunk = (text: string) => {
        accumulatedResponse += text;
        onChunk(text);
      };

      const tracedOnEnd = () => {
        trace.end(accumulatedResponse);
        onEnd();
      };

      const tracedExecuteAction = async (
        name: string,
        args: Record<string, unknown>,
      ): Promise<string> => {
        const t0 = Date.now();
        let output = "";
        let isError = false;
        try {
          output = await executeAction(name, args, actionCtx);
          if (provider.agentToolProfile === "compact") {
            runtime.updateTaskTracker(name, output);
            const trackerCtx = runtime.getTaskTrackerContext();
            if (trackerCtx) {
              output = `${output}\n${trackerCtx}`;
            }
          }
        } catch (err) {
          isError = true;
          output = err instanceof Error ? err.message : String(err);
          throw err;
        } finally {
          trace.logToolCall(name, args, output, Date.now() - t0, isError);
        }
        return output;
      };

      await provider.streamAgentQuery(
        systemPrompt,
        query,
        contextualTools,
        tracedOnChunk,
        tracedExecuteAction,
        tracedOnEnd,
        history,
      );
      return;
    } catch {
      // Fall through to simple path on error
    }
  }

  // Simple path (no tools) — for non-Anthropic providers or when no tab is active
  let prompt: { system: string; user: string };

  if (activeWebContents) {
    try {
      const pageContent = await extractContent(activeWebContents);

      if (isSummarize) {
        prompt = buildSummarizePrompt(pageContent);
      } else {
        prompt = buildQuestionPrompt(pageContent, query);
      }
    } catch {
      prompt = buildGeneralPrompt(query);
    }
  } else {
    prompt = buildGeneralPrompt(query);
  }

  await provider.streamQuery(
    prompt.system,
    prompt.user,
    onChunk,
    onEnd,
    history,
  );
}
