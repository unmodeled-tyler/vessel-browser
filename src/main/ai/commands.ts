import type { AIProvider } from "./provider";
import type { AIMessage } from "../../shared/types";
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

export async function handleAIQuery(
  query: string,
  provider: AIProvider,
  activeWebContents: WebContents | undefined,
  onChunk: (text: string) => void,
  onEnd: () => void,
  tabManager?: TabManager,
  runtime?: AgentRuntime,
  history?: AIMessage[],
): Promise<void> {
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          output = await executeAction(name, args as Record<string, any>, actionCtx);
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
