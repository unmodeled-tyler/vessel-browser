import type Anthropic from "@anthropic-ai/sdk";
import type { PageType } from "../ai/context-builder";
import { TOOL_DEFINITIONS, type ToolDefinition } from "./definitions";

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
function scoreForContext(toolName: string, pageType: PageType): number {
  const def = defByName[toolName];
  if (!def) return 500; // unknown tool, push to end

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
  "inspect_element",
]);

function inferIntent(query: string): Set<string> {
  const lowered = query.toLowerCase();
  const intents = new Set<string>();

  if (/\b(tab|tabs|window|windows)\b/.test(lowered)) intents.add("tabs");
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
): boolean {
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
): Anthropic.Tool[] {
  const ctx = pageType ?? "GENERAL";
  const hints = CONTEXT_HINTS[ctx] ?? {};
  const intents = inferIntent(query);

  // Score, sort, annotate
  const scored = tools
    .filter((tool) => shouldIncludeTool(tool.name, ctx, intents))
    .map((tool) => ({
      tool,
      score: scoreForContext(tool.name, ctx),
    }));

  scored.sort((a, b) => a.score - b.score);

  return scored.map(({ tool, score }) => {
    const hint = hints[tool.name];
    if (hint && score <= 20) {
      // Promoted tool — prepend context hint to description
      return {
        ...tool,
        description: hint + tool.description,
      };
    }
    return tool;
  });
}
