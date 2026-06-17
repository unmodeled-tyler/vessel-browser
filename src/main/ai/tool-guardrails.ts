function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/www\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalizeUrlForComparison(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hostname = url.hostname.replace(/^www\./, "");
    url.hash = "";
    if (url.pathname.endsWith("/") && url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function isRedundantNavigateTarget(
  currentUrl: string,
  targetUrl: string,
): boolean {
  const current = canonicalizeUrlForComparison(currentUrl);
  const target = canonicalizeUrlForComparison(targetUrl);
  return current !== null && target !== null && current === target;
}

export function looksLikeCurrentSiteNameQuery(
  query: string,
  currentUrl: string,
  currentTitle: string,
): boolean {
  const normalizedQuery = normalizeForComparison(query);
  if (!normalizedQuery) return false;

  let hostnameLabel = "";
  try {
    const url = new URL(currentUrl);
    hostnameLabel = url.hostname.replace(/^www\./, "").split(".")[0] || "";
  } catch {
    // Ignore malformed current URL
  }

  const normalizedTitle = normalizeForComparison(currentTitle);
  const normalizedHost = normalizeForComparison(hostnameLabel);
  const normalizedTitlePrefix = normalizeForComparison(
    currentTitle.split("|")[0]?.split("—")[0]?.split("-")[0] || currentTitle,
  );

  if (normalizedTitle && normalizedQuery === normalizedTitle) return true;
  if (normalizedTitlePrefix && normalizedQuery === normalizedTitlePrefix) {
    return true;
  }
  if (normalizedHost && normalizedQuery === normalizedHost) return true;

  const titleTokens = new Set(normalizedTitle.split(/\s+/).filter(Boolean));
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (
    normalizedHost &&
    queryTokens.includes(normalizedHost) &&
    queryTokens.every((token) => titleTokens.has(token) || token === normalizedHost)
  ) {
    return true;
  }

  return false;
}

function extractExplicitDomains(goal: string): string[] {
  const matches = goal
    .toLowerCase()
    .match(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.(?:com|org|net|io|dev|app|ai|co|edu|gov))\b/g);

  if (!matches) return [];

  const normalized = matches.map((match) =>
    match
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .toLowerCase(),
  );

  return [...new Set(normalized)];
}

function apexDomain(hostname: string): string {
  const parts = hostname.replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

export function shouldBlockOffGoalDomainNavigation(
  goal: string,
  targetUrl: string,
): { requestedDomain: string; targetDomain: string } | null {
  const explicitDomains = extractExplicitDomains(goal);
  if (explicitDomains.length !== 1) return null;

  let targetHost = "";
  try {
    const url = new URL(targetUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    targetHost = url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }

  const requestedDomain = explicitDomains[0];
  if (
    targetHost === requestedDomain ||
    targetHost.endsWith(`.${requestedDomain}`) ||
    apexDomain(targetHost) === apexDomain(requestedDomain)
  ) {
    return null;
  }

  return {
    requestedDomain,
    targetDomain: targetHost,
  };
}

export function hasRecentDuplicateToolCall(
  recentToolSignatures: string[],
  signature: string,
): boolean {
  return recentToolSignatures.includes(signature);
}

export function isClickReadLoop(names: string[]): boolean {
  if (names.length < 6) return false;
  const tail = names.slice(-6);
  let clickReadPairs = 0;
  for (let i = 0; i < tail.length - 1; i++) {
    if (tail[i] === 'click' && tail[i + 1] === 'read_page') {
      clickReadPairs++;
    }
  }
  return clickReadPairs >= 2;
}

/**
 * Number of sustained click→read_page loop "strikes" (failed clicks within an
 * active alternation) before the harness stops executing further clicks and
 * returns a suppression result instead. The run is NOT terminated — the model
 * is free to choose another action (scroll, inspect_element, answer from
 * visible results). This bounds failing loops without violating the
 * "nudge, don't terminate" provider parity contract.
 */
export const CLICK_READ_LOOP_SUPPRESS_THRESHOLD = 3;

export type ClickFailureKind = "hidden" | "stale" | "other";

export function classifyClickFailure(output: string): ClickFailureKind | null {
  if (/Error\[hidden\]/i.test(output)) return "hidden";
  if (/Error\[stale-index\]/i.test(output)) return "stale";
  if (/^\s*Error:/i.test(output)) return "other";
  return null;
}

/** True when a click tool result indicates a hidden/not-yet-rendered target. */
export function isHiddenClickFailure(output: string): boolean {
  return classifyClickFailure(output) === "hidden";
}

export type ClickReadLoopIntervention =
  | { kind: "nudge"; message: string }
  | { kind: "suppress"; message: string };

/**
 * Decide how to intervene in a sustained click→read_page loop given the
 * current strike count and why the most recent click failed.
 *
 * - strike 0 → no intervention
 * - strike 1 → gentle nudge (click already includes a snapshot; use
 *   inspect_element or proceed directly)
 * - strike 2 → stronger nudge; hidden targets point at scroll first, stale
 *   targets point at read_page/index refresh first
 * - strike ≥ CLICK_READ_LOOP_SUPPRESS_THRESHOLD → suppress: return a tool-
 *   result-style error (so the model sees it as the click's outcome) telling
 *   it to stop clicking and scroll / inspect / answer from visible results
 *
 * `nudge` messages are injected as a [System] user message alongside the
 * click result (the click still executes). `suppress` messages are returned
 * AS the click's tool result in place of executing it.
 */
export function buildClickReadLoopIntervention(
  strikes: number,
  lastClickFailureKind: ClickFailureKind | null,
): ClickReadLoopIntervention | null {
  if (strikes <= 0) return null;

  if (strikes >= CLICK_READ_LOOP_SUPPRESS_THRESHOLD) {
    const lines = [
      `Error: Suppressed repeated click — you have alternated click and read_page ${strikes} times without making progress and the clicks are not landing.`,
      `Stop calling click. Instead do one of: scroll (scroll or scroll_to_element) to load more of the page then read_page to refresh, inspect_element on a specific indexed result, or answer from the results already visible in the conversation.`,
    ];
    if (lastClickFailureKind === "hidden") {
      lines.push(
        `The last click target was hidden / not laid out — scrolling toward it first usually reveals it.`,
      );
    } else if (lastClickFailureKind === "stale") {
      lines.push(
        `The last click target was stale — refresh page state with read_page and choose a currently listed target before clicking again.`,
      );
    }
    return { kind: "suppress", message: lines.join("\n") };
  }

  // strikes 1 or 2: nudge (click still executes)
  if (strikes >= 2) {
    const lines = [
      `[System] You are alternating between click and read_page without advancing the task, and the last click did not complete.`,
      `The click result already includes a page snapshot, so do not read_page after every click.`,
    ];
    if (lastClickFailureKind === "hidden") {
      lines.push(
        `The click failed on a hidden element — call scroll (scroll or scroll_to_element) to reveal it, then read_page to refresh visible elements, before clicking again.`,
      );
    } else if (lastClickFailureKind === "stale") {
      lines.push(
        `The click failed on a stale element index — call read_page to refresh current indexes before clicking again.`,
      );
    } else {
      lines.push(
        `If you need detail on a specific element, use inspect_element. Otherwise continue the original task directly.`,
      );
    }
    return { kind: "nudge", message: lines.join("\n") };
  }

  // strike 1
  return {
    kind: "nudge",
    message:
      `[System] You are alternating between click and read_page without advancing the task. ` +
      `The click result already includes a page snapshot when it navigates, so do not read_page after every click. ` +
      `If you need detail on a specific element, use inspect_element. Otherwise continue the original task directly.`,
  };
}

export class ClickReadLoopGuard {
  private readonly recentToolNames: string[] = [];
  private strikes = 0;
  private lastClickFailureKind: ClickFailureKind | null = null;

  beforeTool(toolName: string): ClickReadLoopIntervention | null {
    if (
      toolName === "click" &&
      this.strikes >= CLICK_READ_LOOP_SUPPRESS_THRESHOLD &&
      isClickReadLoop(this.recentToolNames)
    ) {
      return buildClickReadLoopIntervention(
        this.strikes,
        this.lastClickFailureKind,
      );
    }
    return null;
  }

  afterToolResult(
    toolName: string,
    output: string,
    succeeded: boolean,
  ): ClickReadLoopIntervention | null {
    if (toolName === "click") {
      this.lastClickFailureKind = succeeded ? null : classifyClickFailure(output);
    }

    this.recentToolNames.push(toolName);
    if (this.recentToolNames.length > 8) this.recentToolNames.shift();

    if (toolName === "click" && succeeded) {
      this.strikes = 0;
      return null;
    }
    if (toolName !== "click" && toolName !== "read_page") {
      this.strikes = 0;
      return null;
    }
    if (isClickReadLoop(this.recentToolNames) && this.lastClickFailureKind) {
      this.strikes += 1;
      if (this.strikes >= CLICK_READ_LOOP_SUPPRESS_THRESHOLD) {
        return null;
      }
      return buildClickReadLoopIntervention(
        this.strikes,
        this.lastClickFailureKind,
      );
    }
    return null;
  }
}
