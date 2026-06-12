import type { ActionContext } from "../core";
import { waitForLoad } from "../../../utils/webcontents-utils";
import {
  isRedundantNavigateTarget,
  shouldBlockOffGoalDomainNavigation,
} from "../../tool-guardrails";
import { buildDefaultEngineShortcut } from "../../page-search";
import { validateLinkDestination } from "../../../network/link-validation";
import { getPostNavSummary } from "../summaries";

export async function handleNavigate(
  ctx: ActionContext,
  tabId: string | null,
  args: Record<string, unknown>,
): Promise<string> {
  const tab = ctx.tabManager.getActiveTab();
  if (!tab || !tabId) return "Error: No active tab";
  const wc = tab.view.webContents;

  const taskGoal = ctx.runtime.getState().taskTracker?.goal;
  if (taskGoal && typeof args.url === "string") {
    const domainDrift = shouldBlockOffGoalDomainNavigation(taskGoal, args.url);
    if (domainDrift) {
      return `Navigation blocked: ${args.url} drifts away from the requested site ${domainDrift.requestedDomain}. Stay on the requested domain and continue the original task there.`;
    }
  }
  if (
    typeof args.url === "string" &&
    !args.postBody &&
    isRedundantNavigateTarget(wc.getURL(), args.url)
  ) {
    return `Already on ${wc.getURL()}. Do not navigate to the same URL again. Use click, inspect_element, read_page, or search for actual book terms instead.`;
  }
  const navValidation = await validateLinkDestination(args.url);
  if (navValidation.status === "dead") {
    return `Navigation blocked: ${args.url} returned ${navValidation.detail || "dead link"}. Try a different URL or go back and choose another link.`;
  }
  const navError = ctx.tabManager.navigateTab(tabId, args.url, args.postBody);
  if (navError) return navError;
  await waitForLoad(wc);
  return `Navigated to ${wc.getURL()}${await getPostNavSummary(wc)}`;
}

export async function handleWebSearch(
  ctx: ActionContext,
  tabId: string | null,
  args: Record<string, unknown>,
): Promise<string> {
  const tab = ctx.tabManager.getActiveTab();
  if (!tab || !tabId) return "Error: No active tab";
  const query = String(args.query || "").trim();
  if (!query) return "Error: No web search query provided.";

  const shortcut = buildDefaultEngineShortcut(query);
  if (!shortcut) {
    return "Error: No default search engine is configured. Navigate to a search engine or set a default search engine first.";
  }

  const navError = ctx.tabManager.navigateTab(tabId, shortcut.url);
  if (navError) return navError;
  const wc = tab.view.webContents;
  await waitForLoad(wc);
  return `Web searched "${query}" via ${shortcut.source} → ${wc.getURL()}${await getPostNavSummary(wc)}`;
}

export async function handleGoBack(ctx: ActionContext, tabId: string | null): Promise<string> {
  const tab = ctx.tabManager.getActiveTab();
  if (!tab || !tabId) return "Error: No active tab";
  const wc = tab.view.webContents;
  if (!tab.canGoBack()) {
    return "No previous page in history";
  }
  const beforeUrl = wc.getURL();
  ctx.tabManager.goBack(tabId);
  await waitForLoad(wc);
  const afterUrl = wc.getURL();
  return afterUrl !== beforeUrl
    ? `Went back to ${afterUrl}${await getPostNavSummary(wc)}`
    : `Back action completed but page stayed on ${afterUrl}`;
}

export async function handleGoForward(ctx: ActionContext, tabId: string | null): Promise<string> {
  const tab = ctx.tabManager.getActiveTab();
  if (!tab || !tabId) return "Error: No active tab";
  const wc = tab.view.webContents;
  if (!tab.canGoForward()) {
    return "No forward page in history";
  }
  const beforeUrl = wc.getURL();
  ctx.tabManager.goForward(tabId);
  await waitForLoad(wc);
  const afterUrl = wc.getURL();
  return afterUrl !== beforeUrl
    ? `Went forward to ${afterUrl}${await getPostNavSummary(wc)}`
    : `Forward action completed but page stayed on ${afterUrl}`;
}

export async function handleReload(ctx: ActionContext, tabId: string | null): Promise<string> {
  const tab = ctx.tabManager.getActiveTab();
  if (!tab || !tabId) return "Error: No active tab";
  const wc = tab.view.webContents;
  ctx.tabManager.reloadTab(tabId);
  await waitForLoad(wc);
  return `Reloaded ${wc.getURL()}`;
}
