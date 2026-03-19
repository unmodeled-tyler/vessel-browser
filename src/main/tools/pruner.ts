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
    highlight: "💡 Mark interesting results — ",
  },
  SHOPPING: {
    fill_form: "⚡ CHECKOUT FIELDS DETECTED — ",
    select_option: "⚡ Payment/shipping options available — ",
  },
  FORM: {
    fill_form: "⚡ FORM DETECTED — ",
    select_option: "⚡ Dropdown fields on page — ",
    submit_form: "⚡ Form ready to submit — ",
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

  const isRelevant =
    !def.relevance || def.relevance.includes(pageType);

  if (tier === 1 && isRelevant) return 10; // promoted contextual
  if (tier === 1 && !isRelevant) return 30; // demoted contextual
  if (tier === 2 && isRelevant) return 20; // promoted utility
  return 40; // tier 2, not relevant
}

/**
 * Reorder and annotate Anthropic tools for the current page context.
 * Returns a new array — does not mutate the input.
 */
export function pruneToolsForContext(
  tools: Anthropic.Tool[],
  pageType: PageType | null,
): Anthropic.Tool[] {
  const ctx = pageType ?? "GENERAL";
  const hints = CONTEXT_HINTS[ctx] ?? {};

  // Score, sort, annotate
  const scored = tools.map((tool) => ({
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
