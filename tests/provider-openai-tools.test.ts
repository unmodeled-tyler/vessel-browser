import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHighlightToolCompletionPrompt,
  coerceToolArgsForExecution,
  isTargetlessClickArgs,
  parseToolArgsWithRepair,
  recoverAssistantTextToolCalls,
  recoverInlineToolMarkerToolCalls,
  recoverNarratedActionToolCalls,
  recoverTextEncodedToolCalls,
  resolveToolCallName,
  shouldRetryUnexecutedHighlightCompletion,
  stableToolSignature,
} from "../src/main/ai/provider-openai-tools";
import { AGENT_TOOLS } from "../src/main/ai/tools";
import { hasRecentDuplicateToolCall } from "../src/main/ai/tool-guardrails";

test("duplicate tool signatures compare equal regardless of arg key order", () => {
  const a = stableToolSignature("navigate", {
    url: "https://www.powells.com",
    postBody: undefined,
  });
  const b = stableToolSignature("navigate", {
    postBody: undefined,
    url: "https://www.powells.com",
  });

  assert.equal(a, b);
});

test("recent duplicate detection catches repeated tool calls across small gaps", () => {
  const navigate = stableToolSignature("navigate", {
    url: "https://www.powells.com",
  });
  const typeText = stableToolSignature("type_text", {
    text: "bestsellers",
    selector: "#search",
  });

  assert.equal(hasRecentDuplicateToolCall([navigate, typeText], navigate), true);
  assert.equal(hasRecentDuplicateToolCall([typeText], navigate), false);
});

test("tool name resolution maps hallucinated google calls onto web search", () => {
  assert.equal(
    resolveToolCallName(
      "google",
      { text: "best sellers fiction" },
      new Set(["navigate", "web_search", "search", "read_page"]),
    ),
    "web_search",
  );
  assert.equal(
    resolveToolCallName(
      "google",
      { text: "best sellers fiction" },
      new Set(["navigate", "search", "read_page"]),
    ),
    "search",
  );
  assert.equal(
    resolveToolCallName(
      "browser.goto",
      { url: "https://www.powells.com" },
      new Set(["navigate", "search", "read_page"]),
    ),
    "navigate",
  );
  assert.equal(
    resolveToolCallName(
      "save bookmarksave bookmarksave bookmark",
      { url: "https://journeywithjill.net" },
      new Set(["save_bookmark", "organize_bookmark", "read_page"]),
    ),
    "save_bookmark",
  );
});

test("tool name resolution repairs repeated available tool names", () => {
  assert.equal(
    resolveToolCallName(
      "highlighthighlighthighlighthighlighthighlight",
      { text: "Sale price" },
      new Set(["highlight", "clear_highlights", "read_page"]),
    ),
    "highlight",
  );

  assert.equal(
    resolveToolCallName(
      "clear_highlightsclear_highlights",
      {},
      new Set(["highlight", "clear_highlights", "read_page"]),
    ),
    "clear_highlights",
  );
});

test("tool arg coercion and signatures normalize search and navigate variants", () => {
  assert.deepEqual(
    coerceToolArgsForExecution("search", { text: "best sellers" }),
    { text: "best sellers", query: "best sellers" },
  );
  assert.deepEqual(
    coerceToolArgsForExecution("web_search", { text: "cheap flights" }),
    { text: "cheap flights", query: "cheap flights" },
  );

  const navigateA = stableToolSignature("navigate", {
    url: "https://www.powells.com/",
  });
  const navigateB = stableToolSignature("navigate", {
    url: "https://powells.com",
  });
  assert.equal(navigateA, navigateB);

  const searchA = stableToolSignature("search", {
    query: " Best   Sellers ",
  });
  const searchB = stableToolSignature("search", {
    text: "best sellers",
  });
  assert.equal(searchA, searchB);
});

test("tool arg coercion normalizes small-model click target aliases", () => {
  assert.deepEqual(
    coerceToolArgsForExecution("click", {
      label: "100 Best Gardening Blogs to Follow in 2026",
    }),
    {
      label: "100 Best Gardening Blogs to Follow in 2026",
      text: "100 Best Gardening Blogs to Follow in 2026",
    },
  );

  assert.deepEqual(coerceToolArgsForExecution("click", { index: "3" }), {
    index: 3,
  });
  assert.equal(isTargetlessClickArgs({}), true);
  assert.equal(
    isTargetlessClickArgs({
      title: "60+ Best Gardening Blogs and Websites On The Internet",
    }),
    false,
  );
});

test("tool arg repair recovers malformed navigate args from bare domains and JS-style objects", () => {
  assert.deepEqual(parseToolArgsWithRepair("navigate", "powells.com"), {
    args: { url: "https://powells.com" },
    repaired: true,
  });
  assert.deepEqual(
    parseToolArgsWithRepair("navigate", '{url:"https://www.powells.com"}'),
    { args: { url: "https://www.powells.com" }, repaired: true },
  );
  assert.deepEqual(
    parseToolArgsWithRepair("navigate", 'url: "https://www.powells.com/books"'),
    { args: { url: "https://www.powells.com/books" }, repaired: true },
  );
});

test("tool arg repair recovers text targets for click-style tools", () => {
  assert.deepEqual(parseToolArgsWithRepair("click", '"Bestsellers"'), {
    args: { text: "Bestsellers" },
    repaired: true,
  });
  assert.deepEqual(
    parseToolArgsWithRepair("inspect_element", "Picks of the Month"),
    { args: { text: "Picks of the Month" }, repaired: true },
  );
});

test("recovers text-encoded tool calls from assistant content", () => {
  const navigate = recoverTextEncodedToolCalls(
    'navigate[ARGS]{"url": "https://www.powells.com/"}',
    new Set(["navigate", "search", "read_page"]),
  );
  assert.equal(navigate.length, 1);
  assert.equal(navigate[0]?.name, "navigate");
  assert.equal(navigate[0]?.argsJson, '{"url": "https://www.powells.com/"}');

  const search = recoverTextEncodedToolCalls(
    'google[ARGS]{"text":"best sellers fiction"}',
    new Set(["navigate", "web_search", "search", "read_page"]),
  );
  assert.equal(search.length, 1);
  assert.equal(search[0]?.name, "web_search");

  const legacySearch = recoverTextEncodedToolCalls(
    'google[ARGS]{"text":"best sellers fiction"}',
    new Set(["navigate", "search", "read_page"]),
  );
  assert.equal(legacySearch.length, 1);
  assert.equal(legacySearch[0]?.name, "search");
});

test("recovers narrated action lines as browser tool calls", () => {
  const navigate = recoverNarratedActionToolCalls(
    `I will now navigate to powells.com and begin searching for books.

Action: Navigate to https://www.powells.com/.`,
    new Set(["navigate", "search", "read_page", "current_tab"]),
  );
  assert.equal(navigate.length, 1);
  assert.equal(navigate[0]?.name, "navigate");
  assert.equal(navigate[0]?.argsJson, '{"url":"https://www.powells.com/"}');

  const search = recoverNarratedActionToolCalls(
    'Action: Search for "Theo of Golden" by Allen Levi using the search box.',
    new Set(["navigate", "search", "read_page", "current_tab"]),
  );
  assert.equal(search.length, 1);
  assert.equal(search[0]?.name, "search");

  const webSearch = recoverNarratedActionToolCalls(
    'Action: Search the web for "cheapest flight tomorrow from Portland to San Francisco".',
    new Set(["navigate", "web_search", "search", "read_page", "current_tab"]),
  );
  assert.equal(webSearch.length, 1);
  assert.equal(webSearch[0]?.name, "web_search");

  const read = recoverNarratedActionToolCalls(
    'I\'ll use readpage(mode="visibleonly") to extract the visible book titles and their links.',
    new Set(["navigate", "search", "read_page", "inspect_element"]),
  );
  assert.equal(read.length, 1);
  assert.equal(read[0]?.name, "read_page");
  assert.equal(read[0]?.argsJson, '{"mode":"visible_only"}');
});

test("recovers inline tool markers emitted as text by some providers", () => {
  const available = new Set([
    "navigate",
    "search",
    "read_page",
    "highlight",
  ]);

  const single = recoverInlineToolMarkerToolCalls(
    '<<tool=highlight:text="Show HN: Homebrew 6.0.0">>',
    available,
  );
  assert.equal(single.length, 1);
  assert.equal(single[0]?.name, "highlight");
  assert.deepEqual(JSON.parse(single[0]?.argsJson ?? "{}"), {
    text: "Show HN: Homebrew 6.0.0",
  });

  const colon = recoverInlineToolMarkerToolCalls(
    '<<tool:highlight:text="MiMo Code released & open-source">>',
    available,
  );
  assert.equal(colon.length, 1);
  assert.deepEqual(JSON.parse(colon[0]?.argsJson ?? "{}"), {
    text: "MiMo Code released & open-source",
  });

  const multiple = recoverInlineToolMarkerToolCalls(
    `<<tool=highlight:text="Story A">>\n<<tool=highlight:text="Story B">>`,
    available,
  );
  assert.equal(multiple.length, 2);
  assert.equal(multiple[0]?.name, "highlight");
  assert.equal(multiple[1]?.name, "highlight");

  const navigate = recoverInlineToolMarkerToolCalls(
    '<<tool:navigate:url="https://example.com">>',
    available,
  );
  assert.equal(navigate.length, 1);
  assert.equal(navigate[0]?.name, "navigate");
  assert.deepEqual(JSON.parse(navigate[0]?.argsJson ?? "{}"), {
    url: "https://example.com",
  });

  const quotedDelimiter = recoverInlineToolMarkerToolCalls(
    '<<tool=highlight:text="Revenue > costs">>',
    available,
  );
  assert.equal(quotedDelimiter.length, 1);
  assert.deepEqual(JSON.parse(quotedDelimiter[0]?.argsJson ?? "{}"), {
    text: "Revenue > costs",
  });

  const unsupported = recoverInlineToolMarkerToolCalls(
    '<<tool=unsupported:text="nope">>',
    available,
  );
  assert.equal(unsupported.length, 0);
});

test("assistant text recovery prefers explicit inline markers over narrated fallback", () => {
  const available = new Set(["highlight", "navigate", "search", "read_page"]);
  const recovered = recoverAssistantTextToolCalls(
    'Action: Use highlight tool. <<tool=highlight:text="Story A">>',
    available,
  );

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.name, "highlight");
  assert.deepEqual(JSON.parse(recovered[0]?.argsJson ?? "{}"), {
    text: "Story A",
  });
});

test("detects highlight completion claims without a successful highlight tool", () => {
  assert.equal(
    shouldRetryUnexecutedHighlightCompletion(
      "Take me to Hacker News and highlight the most important stories",
      `Top Stories Highlighted:

"MAI-Code-1-Flash" - Green highlight
"HP re-releases classic computer science calculator" - Green highlight`,
      ["navigate", "read_page"],
    ),
    true,
  );

  assert.equal(
    shouldRetryUnexecutedHighlightCompletion(
      "Take me to Hacker News and highlight the most important stories",
      "I found several important stories and can highlight them next.",
      ["navigate", "read_page"],
    ),
    false,
  );

  assert.equal(
    shouldRetryUnexecutedHighlightCompletion(
      "Take me to Hacker News and highlight the most important stories",
      "I highlighted the most important stories.",
      ["navigate", "read_page", "highlight"],
    ),
    false,
  );

  assert.match(
    buildHighlightToolCompletionPrompt(),
    /"text":"exact visible title or passage"/,
  );
});

test("highlight tool schema prefers exact visible text over indexes", () => {
  const highlight = AGENT_TOOLS.find((tool) => tool.name === "highlight");
  assert.ok(highlight);
  assert.match(highlight.description ?? "", /prefer text with the exact visible title\/text/i);

  const properties = highlight.input_schema.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(properties).slice(0, 3), [
    "text",
    "index",
    "selector",
  ]);
  assert.match(
    JSON.stringify(properties.text),
    /Preferred for story titles, result titles, links, headings, and passages/,
  );
});
