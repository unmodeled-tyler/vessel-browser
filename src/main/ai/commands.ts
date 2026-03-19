import type { AIProvider } from "./provider";
import type { AIMessage } from "../../shared/types";
import {
  buildSummarizePrompt,
  buildQuestionPrompt,
  buildGeneralPrompt,
  buildStructuredContext,
  detectPageType,
} from "./context-builder";
import { extractContent } from "../content/extractor";
import { AGENT_TOOLS } from "./tools";
import { pruneToolsForContext } from "../tools/pruner";
import { executeAction, type ActionContext } from "./page-actions";
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
      const structuredContext = buildStructuredContext(pageContent);
      const truncated =
        pageContent.content.length > 20000
          ? pageContent.content.slice(0, 20000) + "\n[Content truncated...]"
          : pageContent.content;
      const runtimeState = runtime.getState();
      const recentCheckpoints = runtimeState.checkpoints
        .slice(-3)
        .map((item) => `- ${item.name} (${item.id})`)
        .join("\n");

      const activeTabTitle = pageContent.title || "(untitled)";
      const activeTabUrl = pageContent.url || activeWebContents.getURL();
      const allTabs = tabManager.getAllStates();
      const activeTabId = tabManager.getActiveTabId();
      const tabSummary = allTabs.length > 1
        ? `\nAll open tabs: ${allTabs.map((t) => `${t.id === activeTabId ? "→ " : ""}${t.title || "New Tab"} (${t.url})`).join(" | ")}`
        : "";

      const systemPrompt = `You are Vessel, an AI agent embedded in a web browser. You can see the current page and interact with it using tools.

THE USER IS CURRENTLY LOOKING AT:
  Title: ${activeTabTitle}
  URL: ${activeTabUrl}${tabSummary}

When the user says "this page", "this article", "this site", or asks about what they're viewing, they mean the page above. The content below is from that page — answer directly without needing to call read_page or current_tab first.

Current page context:
${structuredContext}

Page content:
${truncated}

Supervisor state:
- paused: ${runtimeState.supervisor.paused ? "yes" : "no"}
- approval mode: ${runtimeState.supervisor.approvalMode}
- pending approvals: ${runtimeState.supervisor.pendingApprovals.length}

Recent checkpoints:
${recentCheckpoints || "- none"}

Instructions:
- You can see the page the user is viewing. The content above is from the page.
- The structured page context always refers to the tab currently visible to the human unless a later tool call changes tabs.
- Use tools to interact with the page when asked to do something (navigate, click, type, select options, submit forms, press keys, scroll).
- Only say you completed an action after the corresponding tool succeeds. If no tool supports the request, say so plainly.
- Use current_tab when you only need to know what the human is currently looking at. Use list_tabs before switching context across multiple tabs.
- Create a checkpoint before risky multi-step flows or before leaving an important state.
- Use save_session after completing a login flow you may need again later, and load_session to resume that authenticated state in future runs.
- Prefer select_option for dropdowns and submit_form for forms instead of guessing with clicks.
- After clicking or navigating, use read_page to see the updated content.
- If the user says they highlighted or selected text, use read_page before falling back to screenshots because it includes active selection and visible unsaved highlights.
- If a page behaves abnormally or key UI fails to load, consider disabling ad blocking for that tab and reloading before retrying.
- For broad discovery tasks, prefer direct sources, official sites, venue directories, and site-specific search over generic search engines, which often rate-limit automated browser traffic.
- If the page context reports a rate limit, human verification, or access warning, stop using that page and switch to a different source.
- Reference interactive elements by their index number (shown as [#N] in the listings above).
- Be concise. Explain what you're doing as you go.
- For simple questions about the page, just answer directly without using tools.
- VISUAL AWARENESS: The human is watching the browser alongside this chat. Highlights are your pointing finger — they show the user exactly what you're looking at on the page. Use them proactively: highlight key findings, important elements, errors, or anything you're referencing. Don't wait to be asked. If you mention something specific on the page, highlight it. Colors: yellow (default/attention), red (errors/warnings), green (success/good), blue (info/neutral), purple (important/notable), orange (caution). Clear highlights when moving to a new topic or page.
- After completing a task or answering a question, offer 1-2 brief, natural follow-up suggestions that make sense in context (e.g. "Want me to highlight any of these?" or "I can save these to a bookmark folder if you'd like"). Keep suggestions short and conversational — don't list every possible action.
- You can call multiple tools in a single turn when they are independent (e.g. list_tabs + current_tab, or highlight + save_bookmark). This is faster than calling them one at a time.`;

      const actionCtx: ActionContext = { tabManager, runtime };

      // Speedee: dynamically reorder tools based on current page context
      const pageType = detectPageType(pageContent);
      const contextualTools = pruneToolsForContext(AGENT_TOOLS, pageType);

      await provider.streamAgentQuery(
        systemPrompt,
        query,
        contextualTools,
        onChunk,
        (name, args) => executeAction(name, args, actionCtx),
        onEnd,
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

  await provider.streamQuery(prompt.system, prompt.user, onChunk, onEnd, history);
}
