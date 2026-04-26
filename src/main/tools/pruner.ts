import type Anthropic from "@anthropic-ai/sdk";
import type { PageType } from "../ai/context-builder";
import type { AgentToolProfile } from "../ai/tool-profile";
import { TOOL_DEFINITIONS, type ToolDefinition } from "./definitions";
import { isToolGated } from "../premium/manager";

/**
 * Speedee System — Progressive Disclosure
 *
 * Dynamically reorders and annotates the tool list based on the current page context.
 * Tools are never removed (safety valve), but are sorted so the most relevant ones
 * appear first and receive contextual description boosts.
 *
 * Tier 0 (core): always at the top — click, type, navigate, read_page, scroll
 * Tier 1 (contextual): promoted when their relevance matches the page type
 * Tier 2 (utility): pushed to the bottom when not relevant
 */

/** Map base tool name → definition for fast relevance lookup */
const defByName: Record<string, ToolDefinition> = Object.fromEntries(
  TOOL_DEFINITIONS.map((d) => [d.name, d]),
);

/** Context-specific hints prepended to descriptions when a tool is promoted */
const CONTEXT_HINTS: Partial<Record<PageType, Record<string, string>>> = {
  LOGIN: {
    login: "⚡ LOGIN PAGE DETECTED — ",
    fill_form: "⚡ Login fields detected — ",
    type_text: "⚡ Credential fields on page — ",
    save_session: "💡 Save session after successful login — ",
  },
  SEARCH_READY: {
    search: "⚡ SEARCH BOX DETECTED — ",
    type_text: "⚡ Search input available — ",
  },
  SEARCH_RESULTS: {
    paginate: "⚡ PAGINATION DETECTED — ",
    search: "⚡ Refine search — ",
    inspect_element:
      "⚡ Inspect one result card without reading the whole page — ",
    highlight: "💡 Mark interesting results — ",
  },
  SHOPPING: {
    fill_form: "⚡ CHECKOUT FIELDS DETECTED — ",
    select_option: "⚡ Payment/shipping options available — ",
    inspect_element: "⚡ Inspect the current product card or option group — ",
  },
  FORM: {
    fill_form: "⚡ FORM DETECTED — ",
    select_option: "⚡ Dropdown fields on page — ",
    submit_form: "⚡ Form ready to submit — ",
    inspect_element: "⚡ Inspect just this form section — ",
  },
  PAGINATED_LIST: {
    paginate: "⚡ PAGINATION DETECTED — ",
    scroll: "💡 Scroll to see more — ",
  },
  ARTICLE: {
    highlight: "💡 Mark interesting passages — ",
    save_bookmark: "💡 Save for later — ",
    scroll: "💡 Long content — scroll to continue — ",
  },
};

/**
 * Score a tool for the given page context.
 * Lower score = higher position in the reordered list.
 */
function scoreForContext(
  toolName: string,
  pageType: PageType,
  intents: Set<string>,
): number {
  const def = defByName[toolName];
  if (!def) return 500; // unknown tool, push to end

  if (pageType === "SEARCH_READY") {
    if (intents.has("navigate")) {
      if (toolName === "navigate") return -30;
      if (toolName === "search") return 2;
      if (toolName === "type_text") return 5;
      if (toolName === "press_key") return 6;
    }
    if (toolName === "search") return -20;
    if (toolName === "type_text") return 5;
    if (toolName === "press_key") return 6;
  }

  if (pageType === "SEARCH_RESULTS") {
    if (toolName === "search") return -10;
    if (toolName === "type_text") return 12;
    if (toolName === "press_key") return 13;
  }

  const tier = def.tier ?? 1;

  // Tier 0 always comes first
  if (tier === 0) return 0;

  const isRelevant = !def.relevance || def.relevance.includes(pageType);

  if (tier === 1 && isRelevant) return 10; // promoted contextual
  if (tier === 1 && !isRelevant) return 30; // demoted contextual
  if (tier === 2 && isRelevant) return 20; // promoted utility
  return 40; // tier 2, not relevant
}

const ALWAYS_FAST_TOOL_NAMES = new Set([
  "current_tab",
  "navigate",
  "click",
  "type_text",
  "press_key",
  "search",
  "scroll",
  "dismiss_popup",
  "clear_overlays",
  "accept_cookies",
  "wait_for",
  "read_page",
  "screenshot",
  "inspect_element",
]);

const COMPACT_CORE_TOOL_NAMES = new Set([
  "navigate",
  "go_back",
  "click",
  "type_text",
  "press_key",
  "scroll",
  "dismiss_popup",
  "clear_overlays",
  "accept_cookies",
  "read_page",
  "wait_for",
  "inspect_element",
  "search",
]);

const COMPACT_CONTEXTUAL_TOOL_NAMES: Partial<Record<PageType, string[]>> = {
  LOGIN: ["fill_form", "submit_form", "login"],
  FORM: ["fill_form", "select_option", "submit_form"],
  SHOPPING: ["select_option", "fill_form", "submit_form"],
  SEARCH_RESULTS: ["paginate", "scroll_to_element"],
  PAGINATED_LIST: ["paginate", "scroll_to_element"],
};

const COMPACT_INTENT_TOOL_NAMES: Record<string, string[]> = {
  tabs: ["current_tab", "list_tabs", "switch_tab", "create_tab"],
  bookmarks: [
    "list_bookmarks",
    "search_bookmarks",
    "create_bookmark_folder",
    "save_bookmark",
    "organize_bookmark",
    "archive_bookmark",
    "open_bookmark",
  ],
  sessions: ["login", "save_session", "load_session", "list_sessions", "delete_session"],
  workflow: ["create_checkpoint", "restore_checkpoint", "flow_start", "flow_advance", "flow_status", "flow_end"],
  metrics: ["metrics"],
  highlight: ["highlight", "clear_highlights"],
  table: ["extract_table"],
  debug: ["current_tab", "reload", "set_ad_blocking", "suggest", "screenshot"],
};

function inferIntent(query: string): Set<string> {
  const lowered = query.toLowerCase();
  const intents = new Set<string>();

  if (/\b(tab|tabs|window|windows)\b/.test(lowered)) intents.add("tabs");
  if (
    /\b(go to|goto|open|visit|navigate to)\b/.test(lowered) ||
    /\b[a-z0-9-]+\.(com|org|net|io|dev|app|ai|co|edu|gov)\b/.test(lowered) ||
    /\bhttps?:\/\//.test(lowered)
  ) {
    intents.add("navigate");
  }
  if (/\b(bookmark|bookmarks|save this|folder)\b/.test(lowered)) {
    intents.add("bookmarks");
  }
  if (
    /\b(session|cookies|log in|login|sign in|sign-in|resume)\b/.test(lowered)
  ) {
    intents.add("sessions");
  }
  if (/\b(flow|workflow|checkpoint|step|progress|plan)\b/.test(lowered)) {
    intents.add("workflow");
  }
  if (/\b(metric|metrics|performance|slow|latency)\b/.test(lowered)) {
    intents.add("metrics");
  }
  if (/\b(highlight|mark|annotate)\b/.test(lowered)) intents.add("highlight");
  if (/\b(table|csv|rows|columns)\b/.test(lowered)) intents.add("table");
  if (/\b(overlay|modal|popup|consent|cookie|blocking ui)\b/.test(lowered)) {
    intents.add("debug");
  }
  if (/\b(debug|diagnose|what should i do|stuck|inspect)\b/.test(lowered)) {
    intents.add("debug");
  }

  return intents;
}

function shouldIncludeTool(
  toolName: string,
  pageType: PageType,
  intents: Set<string>,
  profile: AgentToolProfile,
): boolean {
  if (profile === "compact") {
    if (COMPACT_CORE_TOOL_NAMES.has(toolName)) return true;

    const contextualTools = COMPACT_CONTEXTUAL_TOOL_NAMES[pageType] ?? [];
    if (contextualTools.includes(toolName)) return true;

    for (const intent of intents) {
      if ((COMPACT_INTENT_TOOL_NAMES[intent] ?? []).includes(toolName)) {
        return true;
      }
    }

    return false;
  }

  if (ALWAYS_FAST_TOOL_NAMES.has(toolName)) return true;

  switch (toolName) {
    case "select_option":
    case "submit_form":
    case "fill_form":
      return (
        pageType === "FORM" || pageType === "SHOPPING" || pageType === "LOGIN"
      );
    case "paginate":
      return pageType === "SEARCH_RESULTS" || pageType === "PAGINATED_LIST";
    case "login":
      return pageType === "LOGIN" || intents.has("sessions");
    case "focus":
      return (
        pageType === "FORM" ||
        pageType === "LOGIN" ||
        pageType === "SEARCH_READY"
      );
    case "scroll_to_element":
      return (
        pageType === "SEARCH_RESULTS" ||
        pageType === "SHOPPING" ||
        intents.has("debug")
      );
    case "go_back":
      return true;
    case "go_forward":
    case "reload":
    case "hover":
      return intents.has("debug");
    case "highlight":
    case "clear_highlights":
      return intents.has("highlight");
    case "list_tabs":
    case "switch_tab":
    case "create_tab":
    case "set_ad_blocking":
    case "list_groups":
    case "create_group":
    case "assign_to_group":
    case "remove_from_group":
    case "toggle_group":
    case "set_group_color":
      return intents.has("tabs") || intents.has("debug");
    case "save_session":
    case "load_session":
    case "list_sessions":
    case "delete_session":
      return intents.has("sessions");
    case "list_bookmarks":
    case "search_bookmarks":
    case "create_bookmark_folder":
    case "save_bookmark":
    case "organize_bookmark":
    case "archive_bookmark":
    case "open_bookmark":
      return intents.has("bookmarks");
    case "flow_start":
    case "flow_advance":
    case "flow_status":
    case "flow_end":
      return intents.has("workflow");
    case "suggest":
    case "wait_for_navigation":
    case "metrics":
      return intents.has("debug") || intents.has("metrics");
    case "extract_table":
      return intents.has("table");
    default:
      return !defByName[toolName]?.hiddenByDefault;
  }
}

/**
 * Reorder and annotate Anthropic tools for the current page context.
 * Returns a new array — does not mutate the input.
 */
export function pruneToolsForContext(
  tools: Anthropic.Tool[],
  pageType: PageType | null,
  query = "",
  options: { profile?: AgentToolProfile } = {},
): Anthropic.Tool[] {
  const ctx = pageType ?? "GENERAL";
  const hints = CONTEXT_HINTS[ctx] ?? {};
  const intents = inferIntent(query);
  const profile = options.profile ?? "default";

  // Score, sort, annotate — keep premium tools visible but tag their descriptions
  const scored = tools
    .filter((tool) => shouldIncludeTool(tool.name, ctx, intents, profile))
    .map((tool) => ({
      tool,
      score: scoreForContext(tool.name, ctx, intents),
    }));

  scored.sort((a, b) => a.score - b.score);

  return scored.map(({ tool, score }) => {
    let description = tool.description ?? "";
    const hint = hints[tool.name];
    if (hint && score <= 20) {
      // Promoted tool — prepend context hint to description
      description = hint + description;
    }
    if (isToolGated(tool.name)) {
      description = `[Premium — requires Vessel Premium] ${description}`;
    }
    return description !== tool.description ? { ...tool, description } : tool;
  });
}
