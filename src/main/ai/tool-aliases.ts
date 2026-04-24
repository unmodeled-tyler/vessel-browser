const SAFE_TOOL_ALIASES: Record<string, string> = {
  goto_url: "navigate",
  go_to_url: "navigate",
  browser_goto: "navigate",
  browser_navigate: "navigate",
  open_url: "navigate",
  visit_url: "navigate",
  navigate_to: "navigate",
  open_page: "navigate",
  google_search: "search",
  site_search: "search",
  search_site: "search",
  page_search: "search",
  scroll_down: "scroll",
  scroll_up: "scroll",
  read: "read_page",
  read_current_page: "read_page",
  scan_page: "read_page",
  save_bookmark: "save_bookmark",
  bookmark: "save_bookmark",
  bookmark_page: "save_bookmark",
  bookmark_url: "save_bookmark",
  add_bookmark: "save_bookmark",
  create_bookmark: "save_bookmark",
};

const CANONICAL_TOOL_NAMES = new Set([
  "archive_bookmark",
  "click",
  "create_bookmark_folder",
  "current_tab",
  "go_back",
  "go_forward",
  "inspect_element",
  "list_bookmarks",
  "navigate",
  "open_bookmark",
  "organize_bookmark",
  "read_page",
  "save_bookmark",
  "scroll",
  "search",
  "type_text",
]);

function repeatedTokenMatch(value: string, token: string): boolean {
  if (value === token) return true;
  if (token.length === 0 || value.length <= token.length) return false;
  if (value.length % token.length !== 0) return false;
  return token.repeat(value.length / token.length) === value;
}

export function normalizeToolAlias(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[.\s/-]+/g, "_");
  const direct = SAFE_TOOL_ALIASES[normalized] ?? normalized;
  if (CANONICAL_TOOL_NAMES.has(direct)) return direct;

  const knownTokens = [
    ...Object.keys(SAFE_TOOL_ALIASES),
    ...CANONICAL_TOOL_NAMES,
  ];
  for (const token of knownTokens) {
    if (repeatedTokenMatch(normalized, token)) {
      return SAFE_TOOL_ALIASES[token] ?? token;
    }
  }

  return name;
}
