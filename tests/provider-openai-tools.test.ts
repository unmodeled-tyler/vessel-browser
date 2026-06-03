import assert from "node:assert/strict";
import test from "node:test";

import {
  coerceToolArgsForExecution,
  isTargetlessClickArgs,
  parseToolArgsWithRepair,
  recoverNarratedActionToolCalls,
  recoverTextEncodedToolCalls,
  resolveToolCallName,
  stableToolSignature,
} from "../src/main/ai/provider-openai-tools";
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

test("tool name resolution maps hallucinated google calls onto search", () => {
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
    new Set(["navigate", "search", "read_page"]),
  );
  assert.equal(search.length, 1);
  assert.equal(search[0]?.name, "search");
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

  const read = recoverNarratedActionToolCalls(
    'I\'ll use readpage(mode="visibleonly") to extract the visible book titles and their links.',
    new Set(["navigate", "search", "read_page", "inspect_element"]),
  );
  assert.equal(read.length, 1);
  assert.equal(read[0]?.name, "read_page");
  assert.equal(read[0]?.argsJson, '{"mode":"visible_only"}');
});
