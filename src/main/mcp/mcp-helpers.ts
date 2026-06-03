import { createLogger } from "../../shared/logger";
import { getErrorMessage } from "../../shared/result";
import { isDangerousAction } from "../ai/page-actions";
import { extractContent } from "../content/extractor";
import { getRecoverableAccessIssue } from "../content/page-access-issues";
import { assertToolUnlocked } from "../premium/manager";
import { waitForLoad } from "../utils/webcontents-utils";
import type { AgentRuntime } from "../agent/runtime";
import type { TabManager } from "../tabs/tab-manager";
import { waitForConditionDirect as waitForCondition } from "../ai/page-actions";

const logger = createLogger("MCP");

export function asTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function asErrorTextResponse(message: string) {
  return asTextResponse(`Error: ${message}`);
}

export function asNoActiveTabResponse() {
  return asErrorTextResponse("No active tab");
}

export function getPremiumToolGateResponse(toolName: string) {
  try {
    assertToolUnlocked(toolName);
    return null;
  } catch (error) {
    return asTextResponse(getErrorMessage(error));
  }
}

export function asPromptResponse(text: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text,
        },
      },
    ],
  };
}

export function isDangerousMcpAction(name: string): boolean {
  return name === "close_tab" || isDangerousAction(name);
}

export function requiresExplicitMcpApproval(name: string, args: Record<string, unknown>): boolean {
  if (name === "delete_session" || name === "close_tab" || name === "load_session") return true;
  if (name === "remove_bookmark_folder" && args.delete_contents === true) return true;
  return false;
}

export function getActiveTabSummary(tabManager: TabManager) {
  const activeTab = tabManager.getActiveTab();
  const activeTabId = tabManager.getActiveTabId();
  if (!activeTab || !activeTabId) return null;
  const state = activeTab.state;
  return {
    tabId: activeTabId,
    title: state.title,
    url: state.url,
    isLoading: state.isLoading,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    adBlockingEnabled: state.adBlockingEnabled,
    humanFocused: true,
  };
}

export async function getPostActionState(
  tabManager: TabManager,
  name: string,
): Promise<string> {
  // Append state context for navigation/interaction actions
  const tab = tabManager.getActiveTab();
  if (!tab) return "";

  const wc = tab.view.webContents;
  const navActions = [
    "navigate",
    "go_back",
    "go_forward",
    "click",
    "submit_form",
    "reload",
    "press_key",
  ];
  const interactActions = [
    "type",
    "type_text",
    "select_option",
    "hover",
    "focus",
  ];
  const tabActions = ["create_tab", "switch_tab", "close_tab"];

  if (navActions.includes(name)) {
    let warning = "";

    try {
      const page = await extractContent(wc);
      const issue = getRecoverableAccessIssue(page);
      if (issue) {
        const blockedUrl = wc.getURL();
        const canRecover =
          [
            "navigate",
            "open_bookmark",
            "click",
            "submit_form",
            "reload",
            "press_key",
          ].includes(name) && tab.canGoBack();

        if (canRecover && tab.goBack()) {
          await waitForLoad(wc);
          warning = `\n[warning: ${issue.summary} ${issue.recommendation ?? ""} Automatically returned to ${wc.getURL()} after landing on ${blockedUrl}.]`;
        } else {
          warning = `\n[warning: ${issue.summary} ${issue.recommendation ?? ""}${tab.canGoBack() ? "" : " No previous page was available for automatic recovery."}]`;
        }
      }
    } catch (err) {
      logger.warn("Failed to compute post-action state warning:", err);
    }

    return `${warning}\n[state: url=${wc.getURL()}, canGoBack=${tab.canGoBack()}, canGoForward=${tab.canGoForward()}, loading=${wc.isLoading()}]`;
  }

  if (interactActions.includes(name)) {
    return `\n[state: url=${wc.getURL()}, title=${JSON.stringify(wc.getTitle() || "")}, tabId=${tabManager.getActiveTabId()}]`;
  }

  if (tabActions.includes(name)) {
    const activeId = tabManager.getActiveTabId();
    const active = getActiveTabSummary(tabManager);
    const count = tabManager.getAllStates().length;
    return `\n[state: activeTab=${activeId}, title=${JSON.stringify(active?.title ?? "")}, url=${active?.url ?? ""}, totalTabs=${count}]`;
  }

  return "";
}

export async function withAction(
  runtime: AgentRuntime,
  tabManager: TabManager,
  name: string,
  args: Record<string, unknown>,
  executor: () => Promise<string>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const premiumGate = getPremiumToolGateResponse(name);
  if (premiumGate) return premiumGate;

  try {
    const result = await runtime.runControlledAction({
      source: "mcp",
      name,
      args,
      tabId: tabManager.getActiveTabId(),
      dangerous: isDangerousMcpAction(name),
      requiresApproval: requiresExplicitMcpApproval(name, args),
      executor,
    });
    const stateInfo = await getPostActionState(tabManager, name);
    const flowCtx = runtime.getFlowContext();
    return asTextResponse(result + stateInfo + flowCtx);
  } catch (error) {
    return asErrorTextResponse(getErrorMessage(error));
  }
}

export async function waitForConditionMcp(
  wc: Electron.WebContents,
  text?: string,
  selector?: string,
  timeoutMs?: number,
): Promise<string> {
  const effectiveTimeout = Math.max(250, timeoutMs || 5000);
  const expectedText = (text || "").trim();
  const expectedSelector = (selector || "").trim();
  const startedAt = Date.now();

  const result = await waitForCondition(
    wc,
    expectedText,
    expectedSelector,
    effectiveTimeout,
  );
  const elapsedMs = Date.now() - startedAt;

  if (result === "Error: wait_for requires text or selector") {
    return JSON.stringify({
      matched: false,
      error: "wait_for requires text or selector",
    });
  }

  if (result.startsWith("Error: Invalid selector ")) {
    return JSON.stringify({
      matched: false,
      error: result.slice("Error: ".length),
    });
  }

  if (result.startsWith("Error: Page is still busy; wait_for timed out")) {
    return JSON.stringify({
      matched: false,
      error: result.slice("Error: ".length),
      elapsed_ms: elapsedMs,
      timeout_ms: effectiveTimeout,
    });
  }

  if (expectedSelector && result === `Matched selector ${expectedSelector}`) {
    return JSON.stringify({
      matched: true,
      type: "selector",
      value: expectedSelector,
      elapsed_ms: elapsedMs,
    });
  }

  const matchedTextPrefix = 'Matched text "';
  if (result.startsWith(matchedTextPrefix) && result.endsWith('"')) {
    return JSON.stringify({
      matched: true,
      type: "text",
      value: result.slice(matchedTextPrefix.length, -1),
      elapsed_ms: elapsedMs,
    });
  }

  const timeoutPayload: {
    matched: false;
    type: "selector" | "text";
    value: string;
    elapsed_ms: number;
    timeout_ms: number;
    diagnostic?: string;
  } = {
    matched: false,
    type: expectedSelector ? "selector" : "text",
    value: expectedSelector || expectedText.slice(0, 80),
    elapsed_ms: elapsedMs,
    timeout_ms: effectiveTimeout,
  };

  if (expectedSelector) {
  const diagnostic = await wc.executeJavaScript(`
      (function() {
        try {
          var count = document.querySelectorAll(${JSON.stringify(expectedSelector)}).length;
          return count > 0 ? 'found ' + count + ' after timeout' : 'not found (page has ' + document.querySelectorAll('*').length + ' elements)';
        } catch (e) {
          return 'selector error: ' + e.message;
        }
      })()
    `).catch((err) => {
      logger.warn("Failed to gather wait_for timeout diagnostic:", err);
      return null;
    });
    if (typeof diagnostic === "string" && diagnostic.trim()) {
      timeoutPayload.diagnostic = diagnostic;
    }
  }

  return JSON.stringify(timeoutPayload);
}
