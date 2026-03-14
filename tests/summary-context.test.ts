import assert from "node:assert/strict";
import test from "node:test";

import { buildScopedContext, buildStructuredContext } from "../src/main/ai/context-builder";
import type { PageContent } from "../src/shared/types";

function buildPage(overrides: Partial<PageContent>): PageContent {
  return {
    title: "",
    content: "",
    htmlContent: "",
    byline: "",
    excerpt: "",
    url: "",
    headings: [],
    navigation: [],
    interactiveElements: [],
    forms: [],
    viewport: {
      width: 1280,
      height: 720,
      scrollX: 0,
      scrollY: 0,
    },
    overlays: [],
    dormantOverlays: [],
    landmarks: [],
    jsonLd: [],
    microdata: [],
    rdfa: [],
    metaTags: {},
    structuredData: [],
    pageIssues: [],
    ...overrides,
  };
}

test("summary mode flags large pages and generic metadata fallback", () => {
  const context = buildScopedContext(
    buildPage({
      title: "Large repo page",
      url: "https://github.com/unmodeled-tyler/vessel-browser",
      content: "x".repeat(15032),
      headings: [
        { level: 1, text: "vessel-browser" },
        { level: 2, text: "README" },
        { level: 2, text: "Recent commits" },
      ],
      structuredData: [
        {
          source: "page",
          types: ["WebPage"],
          name: "Large repo page",
          url: "https://github.com/unmodeled-tyler/vessel-browser",
          attributes: { headings: ["vessel-browser", "README"] },
        },
      ],
    }),
    "summary",
  );

  assert.match(
    context,
    /\*\*Reading Hint:\*\* Large page detected: 15032 chars across 3 headings/i,
  );
  assert.match(context, /Structured data: generic page metadata only/);
  assert.match(context, /Stats: 0 interactives, 0 forms, 0 nav links, 3 headings, 15032 chars/);
});

test("full context labels page-only fallback as page metadata", () => {
  const context = buildStructuredContext(
    buildPage({
      title: "Wikipedia",
      url: "https://en.wikipedia.org/wiki/Salmon",
      content: "x".repeat(9000),
      structuredData: [
        {
          source: "page",
          types: ["WebPage"],
          name: "Salmon",
          url: "https://en.wikipedia.org/wiki/Salmon",
          description: "Article overview",
          attributes: { headings: ["Salmon", "Taxonomy"] },
        },
      ],
    }),
  );

  assert.match(context, /### Page Metadata/);
  assert.doesNotMatch(context, /### Structured Data/);
});
