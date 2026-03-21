import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScopedContext,
  buildStructuredContext,
  chooseAgentReadMode,
} from "../src/main/ai/context-builder";
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
  assert.match(
    context,
    /Stats: 0 interactives, 0 forms, 0 nav links, 3 headings, 15032 chars/,
  );
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

test("agent default read mode stays narrow for navigation-heavy pages", () => {
  const searchReady = chooseAgentReadMode(
    buildPage({
      title: "Newegg",
      url: "https://www.newegg.com/",
      interactiveElements: [
        {
          type: "input",
          label: "Search",
          inputType: "search",
          placeholder: "Search",
          index: 1,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
      ],
    }),
  );
  const resultsPage = chooseAgentReadMode(
    buildPage({
      title: "GPU Search Results",
      url: "https://www.newegg.com/p/pl?d=rtx+4060",
      interactiveElements: [
        {
          type: "input",
          label: "Search",
          inputType: "search",
          placeholder: "Search",
          index: 1,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        ...Array.from({ length: 12 }, (_, i) => ({
          type: "link" as const,
          text: `Result ${i + 1}`,
          href: `https://example.com/result-${i + 1}`,
          context: "content",
          selector: `a.result-${i + 1}`,
          index: i + 2,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        })),
      ],
    }),
  );
  const articlePage = chooseAgentReadMode(
    buildPage({
      title: "Long Article",
      url: "https://example.com/article",
      content: "x".repeat(5000),
      headings: [{ level: 1, text: "Long Article" }],
      interactiveElements: [],
    }),
  );

  assert.equal(searchReady, "visible_only");
  assert.equal(resultsPage, "results_only");
  assert.equal(articlePage, "summary");
});

test("visible_only surfaces cart quantity values clearly", () => {
  const quantityField = {
    type: "input" as const,
    label: "Quantity",
    inputType: "number",
    value: "2",
    name: "quantity",
    index: 7,
    visible: true,
    inViewport: true,
    fullyInViewport: true,
  };

  const context = buildScopedContext(
    buildPage({
      title: "Cart",
      url: "https://www.powells.com/cart",
      content: `
        Subtotal $94.95
        Shipping $4.99
        Order Total $99.94
      `,
      interactiveElements: [
        {
          type: "link",
          text: "Interesting Book",
          href: "https://www.powells.com/book/interesting-book",
          index: 3,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        quantityField,
        {
          type: "link",
          text: "Second Interesting Book",
          href: "https://www.powells.com/book/second-interesting-book",
          index: 8,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
      ],
      forms: [
        {
          id: "cart-form",
          action: "/cart",
          method: "post",
          fields: [
            quantityField,
            {
              ...quantityField,
              index: 9,
            },
          ],
        },
      ],
    }),
    "visible_only",
  );

  assert.match(context, /### Cart Snapshot/);
  assert.match(context, /Distinct items: 2/);
  assert.match(context, /Quantity controls: 2 \(all set to 2\)/);
  assert.match(context, /Total units inferred: 4/);
  assert.match(context, /Attention: 2 distinct items but 4 total units/);
  assert.match(context, /- Subtotal \$94\.95/);
  assert.match(context, /- Order Total \$99\.94/);
  assert.match(context, /### Quantity \/ Count Controls/);
  assert.match(context, /\[#7\] \[Quantity\] input current="2"/);
  assert.match(context, /\[Quantity\] number input current="2"/);
});
