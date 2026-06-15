/**
 * Shared search-loop guard logic used by the OpenAI-compatible and Codex
 * providers. Detects repeated or drifted search tool calls, tracks the small
 * amount of history needed to identify them, and builds the corrective error
 * message sent back to the model.
 */

export const SEARCH_HISTORY_LIMIT = 4;

export type SearchMode = "repeated" | "drifted";

/**
 * Extract a normalized query string from a search/web_search tool call.
 * Accepts a few common argument names used by different tool schemas.
 */
export function normalizeSearchToolQuery(
  name: string,
  args: Record<string, unknown>,
): string | null {
  if (name !== "search" && name !== "web_search") return null;
  const raw =
    typeof args.query === "string"
      ? args.query
      : typeof args.text === "string"
        ? args.text
        : typeof args.term === "string"
          ? args.term
          : "";
  const normalized = raw.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized || null;
}

/**
 * Build a short "latest browser state" reminder from a tool result preview.
 * This unifies the extraction logic used by both providers so recovery/error
 * prompts can point the model at the freshest URL/title.
 */
export function buildLatestStateReminder(
  toolResultPreview: string | null,
): string {
  const text = (toolResultPreview || "").trim();
  if (!text) return "";

  // If the text already contains a reminder, reuse it rather than appending a
  // duplicate.
  const existingReminder = text.match(
    /\bLatest browser state:\s*URL\s+.+?(?:Trust the latest tool result over the initial page context\.|$)/i,
  )?.[0]?.trim();
  if (existingReminder) return existingReminder;

  const stateMatch = text.match(
    /\[state:\s+url=([^,\]\n]+),\s+title=(?:"([^"]*)"|([^,\]\n]+))/i,
  );
  if (stateMatch) {
    const url = stateMatch[1]?.trim();
    const title = (stateMatch[2] ?? stateMatch[3] ?? "").trim();
    if (url) {
      return `Latest browser state: URL ${url}${title ? `, title "${title}"` : ""}. Trust the latest tool result over the initial page context.`;
    }
  }

  const structuredUrl = text.match(/\*\*URL:\*\*\s*([^\n]+)/i)?.[1]?.trim();
  const structuredTitle = text.match(/\*\*Title:\*\*\s*([^\n]+)/i)?.[1]?.trim();
  if (structuredUrl) {
    return `Latest browser state: URL ${structuredUrl}${structuredTitle ? `, title "${structuredTitle}"` : ""}. Trust the latest tool result over the initial page context.`;
  }

  const navigatedUrl =
    text.match(
      /\b(?:navigated to|went back to|went forward to|searched "[^"]+"(?: \(via search button\))? →)\s+([^\s\n]+)/i,
    )?.[1]?.trim() ??
    text.match(
      /\b(?:web\s+)?searched "[^"]+"[^\n]*?(?:->|→)\s+([^\s\n]+)/i,
    )?.[1]?.trim();
  const pageTitle = text.match(/\bPage title:\s*([^\n]+)/i)?.[1]?.trim();
  if (navigatedUrl) {
    return `Latest browser state: URL ${navigatedUrl}${pageTitle ? `, title "${pageTitle}"` : ""}. Trust the latest tool result over the initial page context.`;
  }

  return "";
}

/**
 * Build a strict, actionable error for a repeated search (same query on
 * `web_search` or `search` already succeeded) or a drifted search (a different
 * `web_search` with no real progress since the previous successful one). The
 * message names the previous tool + query, points the model at the current
 * results, and explicitly forbids using read_page/search as no-op preparation.
 */
export function buildRepeatedSearchError(
  previousTool: string,
  previousQuery: string,
  latestToolResultPreview: string | null,
  mode: SearchMode,
): string {
  const stateReminder = buildLatestStateReminder(latestToolResultPreview);
  const lines = [
    mode === "drifted"
      ? `Error: You already performed ${previousTool} successfully for this task.`
      : `Error: You already searched for "${previousQuery}" successfully with ${previousTool}.`,
    mode === "drifted"
      ? `Do not rewrite or broaden the query with another ${previousTool}; use the current search results instead.`
      : `Do not search the same query again with ${previousTool} or its search/web_search alias; use the current search results instead.`,
    `For named venues, businesses, organizations, schools, or local places, prefer opening the official site or clearly direct result from the current results page before answering. Do not switch to a site: restricted web_search when an official or direct result is already available.`,
    `Take the next action from the results you already have: click a result, inspect a specific item, or provide the final answer to the user. Do not call any search tool again as preparation, and do not call read_page as preparation for another search.`,
  ];
  if (stateReminder) {
    lines.push(stateReminder);
  }
  return lines.join(" ");
}

export interface SearchLoopCheckResult {
  mode: SearchMode;
  previousTool: string;
  previousQuery: string;
}

/**
 * Maintains the small amount of search history needed to detect repeated or
 * drifted search tool calls. Providers pass a predicate that decides which
 * successful tools reset the "last web_search" drift anchor (the two
 * providers disagree slightly on whether overlay/cookie housekeeping tools
 * count as forward progress, so the predicate is injected rather than shared).
 */
export class SearchLoopGuard {
  private recentSuccessfulSearchQueries: string[] = [];
  private recentSuccessfulSearchToolByQuery = new Map<string, string>();
  private lastSuccessfulWebSearchQuery: string | null = null;
  private readonly isContextResettingTool: (name: string) => boolean;

  constructor(isContextResettingTool: (name: string) => boolean) {
    this.isContextResettingTool = isContextResettingTool;
  }

  /**
   * Check whether a search/web_search call should be suppressed. Returns the
   * details needed to build the corrective error, or null if the call is OK.
   */
  check(
    toolName: string,
    query: string | null,
  ): SearchLoopCheckResult | null {
    const isRepeatedSearchAcrossTools =
      query !== null && this.recentSuccessfulSearchQueries.includes(query);
    const isQueryDriftedWebSearch =
      toolName === "web_search" &&
      this.lastSuccessfulWebSearchQuery !== null &&
      query !== null &&
      query !== this.lastSuccessfulWebSearchQuery;

    if (!isRepeatedSearchAcrossTools && !isQueryDriftedWebSearch) return null;

    const mode: SearchMode = isRepeatedSearchAcrossTools
      ? "repeated"
      : "drifted";
    const previousTool = isRepeatedSearchAcrossTools
      ? (this.recentSuccessfulSearchToolByQuery.get(query ?? "") ??
        (toolName === "web_search" ? "search" : "web_search"))
      : "web_search";
    const previousQuery = isRepeatedSearchAcrossTools
      ? (query ?? "")
      : (this.lastSuccessfulWebSearchQuery ?? "");

    return { mode, previousTool, previousQuery };
  }

  /**
   * Record a successfully executed tool. Search queries are added to the
   * recent-history ring buffer, and real-progress tools clear the drift anchor
   * so a later distinct search is not flagged as drift.
   */
  recordSuccess(
    toolName: string,
    query: string | null,
    wasSuccessful: boolean,
  ): void {
    if (wasSuccessful && this.isContextResettingTool(toolName)) {
      this.lastSuccessfulWebSearchQuery = null;
    }

    if (wasSuccessful && query) {
      if (!this.recentSuccessfulSearchQueries.includes(query)) {
        this.recentSuccessfulSearchQueries.push(query);
        this.recentSuccessfulSearchToolByQuery.set(query, toolName);
        if (
          this.recentSuccessfulSearchQueries.length > SEARCH_HISTORY_LIMIT
        ) {
          const dropped = this.recentSuccessfulSearchQueries.shift();
          if (dropped) {
            this.recentSuccessfulSearchToolByQuery.delete(dropped);
          }
        }
      }
    }

    if (wasSuccessful && toolName === "web_search" && query) {
      this.lastSuccessfulWebSearchQuery = query;
    }
  }
}
