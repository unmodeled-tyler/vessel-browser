import type { WebContents } from "electron";
import { executePageScript } from "./core";
import { waitForLoad } from "../../utils/webcontents-utils";
import { TOOL_DEFINITIONS } from "../../tools/definitions";
import { isToolGated } from "../../premium/manager";
import { trackToolCall } from "../../telemetry/posthog";
import { formatCompactToolResult } from "../compact-tool-result";
import { normalizeToolAlias } from "../tool-aliases";
import { shouldBlockOffGoalDomainNavigation } from "../tool-guardrails";
import {
  getCartAddedSummary,
  isProductAlreadyInCart,
  clearCartClickState,
} from "../cart-click-state";
import { getPostClickNavSummary } from "./summaries";
import {
  handleCurrentTab,
  handleListTabs,
  handleSwitchTab,
  handleCreateTab,
  handleSetAdBlocking,
} from "./handlers/tabs";
import {
  handleNavigate,
  handleWebSearch,
  handleGoBack,
  handleGoForward,
  handleReload,
} from "./handlers/navigation";
import { handleCreateCheckpoint, handleRestoreCheckpoint } from "./handlers/checkpoints";
import {
  handleSaveSession,
  handleLoadSession,
  handleListSessions,
  handleDeleteSession,
} from "./handlers/sessions";
import {
  handleFlowStart,
  handleFlowAdvance,
  handleFlowStatus,
  handleFlowEnd,
} from "./handlers/flow";
import {
  handleScreenshot,
  handleWaitFor,
  handleWaitForNavigation,
  handleMetrics,
  handleUndoLastAction,
} from "./handlers/utility";
import {
  handleClick,
  handleInspectElement,
  handleTypeText,
  handleSelectOption,
  handleSubmitForm,
  handlePressKey,
  handleScroll,
  handleHover,
  handleFocus,
  handleDismissPopup,
  handleClearOverlays,
  handleScrollToElement,
} from "./handlers/interaction";
import { handleReadPage } from "./handlers/page-reading";
import { handleFillForm, handleLogin, handleSearch, handlePaginate } from "./handlers/forms";
import { handleSuggest } from "./handlers/suggest";
import { handleAcceptCookies } from "./handlers/cookie";
import { handleExtractTable } from "./handlers/extract";
import { handleHighlight, handleClearHighlights } from "./handlers/highlights";
import { handleBookmarks, isBookmarkAction } from "./handlers/bookmarks";
import type { ActionContext } from "./core";

/** All known tool names — used to detect concatenated tool calls from models */
const KNOWN_TOOLS = new Set(TOOL_DEFINITIONS.map((d) => d.name));

/** Tool names that don't need an active tab to operate */
const NO_ACTIVE_TAB_TOOLS = new Set([
  "current_tab",
  "list_tabs",
  "create_tab",
  "set_ad_blocking",
  "restore_checkpoint",
  "save_session",
  "load_session",
  "list_sessions",
  "delete_session",
  "list_bookmarks",
  "search_bookmarks",
  "create_bookmark_folder",
  "save_bookmark",
  "organize_bookmark",
  "archive_bookmark",
  "open_bookmark",
  "flow_start",
  "flow_advance",
  "flow_status",
  "flow_end",
  "suggest",
]);

/** Tools that reset the click-streak counter (verification actions) */
const STREAK_RESET_TOOLS = new Set(["read_page", "inspect_element", "screenshot", "wait_for"]);

/**
 * Tracks consecutive clicks on the same page URL without any verification
 * step (read_page, inspect_element, screenshot). Used to detect when the
 * model is rapidly clicking elements without checking if anything
 * happened.
 */
let clickStreakUrl: string | null = null;
let clickStreakCount = 0;
const CLICK_STREAK_THRESHOLD = 3;

/**
 * Clear all in-memory cart and click tracking state. Called when the
 * agent starts a new task (goal changes) so that stale entries from a
 * previous run do not confuse the model with false "already in cart"
 * warnings.
 */
export function clearCartState(): void {
  clearCartClickState();
  clickStreakUrl = null;
  clickStreakCount = 0;
}

/**
 * Detect concatenated tool names (e.g.
 * "create_checkpointcurrent_tablist_tabs") from models that don't
 * properly support parallel tool calls. Returns a friendly error
 * message, or null if the name looks fine.
 */
function detectConcatenatedToolName(name: string): string | null {
  if (KNOWN_TOOLS.has(name)) return null;
  for (const known of KNOWN_TOOLS) {
    if (name.startsWith(known) && name.length > known.length) {
      const remaining = name.slice(known.length);
      const otherTools = [...KNOWN_TOOLS].filter((t) => remaining.includes(t));
      return `Error: It looks like you tried to call multiple tools at once (${known}, ${otherTools.join(", ")}). Please call them one at a time — send one tool call per message.`;
    }
  }
  return null;
}

/** Navigation actions that should get a post-action state block. */
const NAV_ACTIONS = new Set([
  "navigate",
  "web_search",
  "open_bookmark",
  "go_back",
  "go_forward",
  "click",
  "submit_form",
  "reload",
  "press_key",
  "login",
  "search",
  "paginate",
]);

const INTERACT_ACTIONS = new Set([
  "type_text",
  "select_option",
  "hover",
  "focus",
  "fill_form",
  "inspect_element",
  "clear_overlays",
]);

const TAB_ACTIONS = new Set(["create_tab", "switch_tab", "set_ad_blocking", "load_session"]);

async function getPostActionState(ctx: ActionContext, name: string): Promise<string> {
  const tab = ctx.tabManager.getActiveTab();
  if (!tab) return "";

  const wc = tab.view.webContents;

  if (NAV_ACTIONS.has(name)) {
    // If the page is still loading (spinner visible), wait for it to
    // finish — just like a human waits for the spinner to stop.
    if (wc.isLoading()) {
      await waitForLoad(wc);
    }
    const currentUrl = wc.getURL();
    let warnings = "";
    if (isProductAlreadyInCart(currentUrl)) {
      warnings += `\nWARNING: This product is already in your cart.${getCartAddedSummary(currentUrl)}\nGo back and select a different product.`;
    }
    // Detect domain drift: if a click/navigate took us off the requested site,
    // warn the model to go back immediately.
    const taskGoal = ctx.runtime.getState().taskTracker?.goal;
    if (taskGoal && name === "click") {
      const drift = shouldBlockOffGoalDomainNavigation(taskGoal, currentUrl);
      if (drift) {
        warnings += `\nWARNING: You drifted to ${drift.targetDomain} but the task requires staying on ${drift.requestedDomain}. Call go_back immediately to return to the previous page.`;
      }
    }

    // After going back or searching, always show what's already in the cart
    // so the model doesn't re-click the same products from memory.
    if (name === "go_back" || name === "search") {
      const cartSummary = getCartAddedSummary(currentUrl);
      if (cartSummary) {
        warnings += `${cartSummary}\nSelect a DIFFERENT product that is not in the cart. Call read_page if needed to see available results.`;
      }
      // Compact models often skip read_page after going back and click blindly.
      // Force them to refresh context before interacting.
      if (ctx.toolProfile === "compact" && name === "go_back") {
        warnings += `\nCall read_page(mode="results_only") to see available products before clicking.`;
      }
    }

    // Detect when a click navigated to a filter/sort URL instead of a product
    // page — common mistake for small models on listing pages.
    if (name === "click" && ctx.toolProfile === "compact") {
      const filterParams =
        /\b(condition|binding|format|availability|sort|filter|price|category_id|view)\b=[^&]/i;
      const filterPath =
        /\/(condition|binding|format|availability|sort|filter|price|category)\/[^/?#]+/i;
      if (filterParams.test(currentUrl) || filterPath.test(currentUrl)) {
        warnings += `\nWARNING: The clicked link appears to be a filter or sort control, not a product. If you intended to click a product, call go_back and use click(index=N) on a result from read_page(mode="results_only").`;
      }
    }

    return `\n[state: url=${currentUrl}, title=${JSON.stringify(wc.getTitle() || "")}, canGoBack=${tab.canGoBack()}, canGoForward=${tab.canGoForward()}, loading=${wc.isLoading()}]${warnings}`;
  }

  // After a click that stays on the same page, check if we landed on an
  // empty/no-results page — common when clicking filter links by mistake.
  if (name === "click" && !wc.isLoading()) {
    try {
      const emptyPage = await executePageScript<boolean>(
        wc,
        `(function() {
          var body = (document.body.textContent || '').toLowerCase();
          return /\b(no results|no items found|nothing matched|0 results|zero results|no products|your search.*did not match|no books found)\b/.test(body)
            && body.length < 8000;
        })()`,
        { timeoutMs: 1000, label: "empty page check" },
      );
      if (emptyPage && emptyPage !== undefined) {
        return `\n[state: url=${wc.getURL()}, title=${JSON.stringify(wc.getTitle() || "")}, canGoBack=${tab.canGoBack()}, canGoForward=${tab.canGoForward()}, loading=false]\nWARNING: This page shows no results. You likely clicked a filter or category link instead of a product. Call go_back to return to the search results.`;
      }
    } catch {
      // Ignore — this is a best-effort check
    }
  }

  if (INTERACT_ACTIONS.has(name)) {
    return `\n[state: url=${wc.getURL()}, title=${JSON.stringify(wc.getTitle() || "")}, tabId=${ctx.tabManager.getActiveTabId()}]`;
  }

  if (TAB_ACTIONS.has(name)) {
    const activeId = ctx.tabManager.getActiveTabId();
    const activeTab = ctx.tabManager.getActiveTab();
    const count = ctx.tabManager.getAllStates().length;
    const activeTitle = activeTab?.view.webContents.getTitle() || "";
    const activeUrl = activeTab?.view.webContents.getURL() || "";
    return `\n[state: activeTab=${activeId}, title=${JSON.stringify(activeTitle)}, url=${activeUrl}, totalTabs=${count}]`;
  }

  return "";
}

/**
 * Detect rapid same-page click streaks: the model keeps clicking elements
 * on the same URL without verifying what happened. After
 * CLICK_STREAK_THRESHOLD consecutive clicks, append a strong warning.
 */
function updateClickStreak(name: string, result: string): string {
  if (name === "click" && !result.startsWith("Error") && !result.startsWith("Blocked")) {
    return ""; // streak warning is applied in executeAction where we have url context
  }
  if (STREAK_RESET_TOOLS.has(name)) {
    clickStreakCount = 0;
    clickStreakUrl = null;
  }
  return "";
}

function clickStreakWarning(name: string, currentUrl: string): string {
  if (name !== "click") return "";
  if (currentUrl === clickStreakUrl) {
    clickStreakCount++;
  } else {
    clickStreakUrl = currentUrl;
    clickStreakCount = 1;
  }
  if (clickStreakCount >= CLICK_STREAK_THRESHOLD) {
    return (
      `\nWARNING: You have clicked ${clickStreakCount} elements on this page without verifying the result. ` +
      `Call read_page or inspect_element to check the current page state before clicking again. ` +
      `If clicks are having no effect, the elements may not be interactive — try different element indices or read the page to find clickable links.`
    );
  }
  return "";
}

export async function executeAction(
  rawName: string,
  args: Record<string, unknown>,
  ctx: ActionContext,
): Promise<string> {
  const name = normalizeToolAlias(rawName);

  // When a sub-agent targets its own tab, serialize all browser access
  // through a mutex so parallel sub-agents don't race on the active tab.
  if (ctx.tabId && ctx._tabMutex) {
    return ctx._tabMutex.enqueue(async () => {
      const prevActiveId = ctx.tabManager.getActiveTabId();
      if (prevActiveId !== ctx.tabId) ctx.tabManager.switchTab(ctx.tabId!);
      try {
        return await executeAction(name, args, { ...ctx, tabId: undefined, _tabMutex: undefined });
      } finally {
        if (prevActiveId && prevActiveId !== ctx.tabId) {
          ctx.tabManager.switchTab(prevActiveId);
        }
      }
    });
  }

  const concatError = detectConcatenatedToolName(name);
  if (concatError) return concatError;

  const tab = ctx.tabManager.getActiveTab();
  const tabId = ctx.tabManager.getActiveTabId();

  if (!tab && !NO_ACTIVE_TAB_TOOLS.has(name)) {
    return "Error: No active tab";
  }

  // Track tool usage (anonymous, name only)
  trackToolCall(name);

  // Premium feature gate — return a helpful upgrade message for gated tools
  if (isToolGated(name)) {
    return `This tool (${name}) requires Vessel Premium. Upgrade at Settings > Premium to unlock screenshot, session management, workflow tracking, and more.`;
  }

  const wc = tab?.view.webContents;

  const result = await ctx.runtime.runControlledAction({
    source: "ai",
    name,
    args,
    tabId,
    dangerous: isDangerousAction(name),
    executor: () => dispatch(name, args, ctx, wc, tabId),
  });

  // Reset streak when verification tools ran
  updateClickStreak(name, result);

  const formattedResult =
    ctx.toolProfile === "compact" ? formatCompactToolResult(name, result) : result;
  const flowCtx = ctx.runtime.getFlowContext();

  // When a click causes navigation, include a lightweight page snapshot
  // so the model can see interactive elements without calling read_page.
  let clickNavSummary = "";
  if (
    name === "click" &&
    !result.startsWith("Error") &&
    !result.startsWith("Blocked") &&
    result.includes(" -> ")
  ) {
    const summaryWc = ctx.tabManager.getActiveTab()?.view.webContents;
    if (summaryWc) {
      clickNavSummary = await getPostClickNavSummary(summaryWc, ctx.toolProfile);
    }
  }

  // Click-streak warning uses the current URL (after the click)
  const currentUrl = ctx.tabManager.getActiveTab()?.view.webContents.getURL() ?? "";
  const streakWarning = clickStreakWarning(name, currentUrl);

  return (
    formattedResult +
    (await getPostActionState(ctx, name)) +
    clickNavSummary +
    streakWarning +
    flowCtx
  );
}

/**
 * Inner dispatcher — runs the per-tool handler. Kept separate from
 * `executeAction` so the orchestrator's framework logic (mutex,
 * post-enrichment) is visually distinct from the case-by-case
 * dispatch.
 */
async function dispatch(
  name: string,
  args: Record<string, unknown>,
  ctx: ActionContext,
  wc: WebContents | undefined,
  tabId: string | null,
): Promise<string> {
  switch (name) {
    case "screenshot":
      return handleScreenshot(ctx);
    case "current_tab":
      return handleCurrentTab(ctx);
    case "list_tabs":
      return handleListTabs(ctx);
    case "switch_tab":
      return handleSwitchTab(ctx, args);
    case "create_tab":
      return handleCreateTab(ctx, args);
    case "navigate":
      return handleNavigate(ctx, tabId, args);
    case "web_search":
      return handleWebSearch(ctx, tabId, args);
    case "go_back":
      return handleGoBack(ctx, tabId);
    case "go_forward":
      return handleGoForward(ctx, tabId);
    case "reload":
      return handleReload(ctx, tabId);
    case "click":
      return handleClick(ctx, args);
    case "inspect_element":
      return handleInspectElement(ctx, args);
    case "type_text":
      return handleTypeText(ctx, args);
    case "select_option":
      return handleSelectOption(ctx, args);
    case "submit_form":
      return handleSubmitForm(ctx, args);
    case "press_key":
      return handlePressKey(ctx, args);
    case "scroll":
      return handleScroll(ctx, args);
    case "hover":
      return handleHover(ctx, args);
    case "focus":
      return handleFocus(ctx, args);
    case "set_ad_blocking":
      return handleSetAdBlocking(ctx, args);
    case "dismiss_popup":
      return handleDismissPopup(ctx);
    case "clear_overlays":
      return handleClearOverlays(ctx, args);
    case "read_page":
      return handleReadPage(ctx, args);
    case "wait_for":
      return handleWaitFor(ctx, args);
    case "wait_for_navigation":
      return handleWaitForNavigation(ctx, args);
    case "create_checkpoint":
      return handleCreateCheckpoint(ctx, args);
    case "restore_checkpoint":
      return handleRestoreCheckpoint(ctx, args);
    case "save_session":
      return handleSaveSession(ctx, args);
    case "load_session":
      return handleLoadSession(ctx, args);
    case "list_sessions":
      return handleListSessions();
    case "delete_session":
      return handleDeleteSession(args);
    case "list_bookmarks":
    case "search_bookmarks":
    case "create_bookmark_folder":
    case "save_bookmark":
    case "organize_bookmark":
    case "archive_bookmark":
    case "open_bookmark":
      return handleBookmarks(ctx, wc, tabId, name, args);
    case "highlight":
      return handleHighlight(ctx, args);
    case "clear_highlights":
      return handleClearHighlights(ctx);
    case "flow_start":
      return handleFlowStart(ctx, args);
    case "flow_advance":
      return handleFlowAdvance(ctx, args);
    case "flow_status":
      return handleFlowStatus(ctx);
    case "flow_end":
      return handleFlowEnd(ctx);
    case "undo_last_action":
      return handleUndoLastAction(ctx);
    case "suggest":
      return handleSuggest(ctx);
    case "fill_form":
      return handleFillForm(ctx, args);
    case "login":
      return handleLogin(ctx, args);
    case "search":
      return handleSearch(ctx, args);
    case "paginate":
      return handlePaginate(ctx, args);
    case "accept_cookies":
      return handleAcceptCookies(ctx);
    case "extract_table":
      return handleExtractTable(ctx, args);
    case "metrics":
      return handleMetrics(ctx);
    case "scroll_to_element":
      return handleScrollToElement(ctx, args);
    default:
      if (isBookmarkAction(name)) {
        return handleBookmarks(ctx, wc, tabId, name, args);
      }
      return `Unknown tool: ${name}`;
  }
}

/**
 * Tools that trigger supervisor approval. Mirrors the `isDangerousAction`
 * list from the original page-actions barrel — kept as a single source
 * of truth here in the orchestrator.
 */
export const DANGEROUS_ACTIONS: ReadonlySet<string> = new Set([
  "navigate",
  "web_search",
  "open_bookmark",
  "click",
  "type_text",
  "select_option",
  "submit_form",
  "press_key",
  "create_tab",
  "switch_tab",
  "close_tab",
  "restore_checkpoint",
  "load_session",
  "login",
  "fill_form",
  "search",
  "paginate",
]);

export function isDangerousAction(name: string): boolean {
  return DANGEROUS_ACTIONS.has(name);
}
