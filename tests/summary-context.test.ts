import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScopedContext,
  buildStructuredContext,
  chooseAgentReadMode,
} from "../src/main/ai/context-builder";
import { buildAgentSystemPrompt } from "../src/main/ai/agent-prompt";
import { buildCompactScopedContext } from "../src/main/ai/compact-context";
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
  const storefrontHomePage = chooseAgentReadMode(
    buildPage({
      title: "Newegg",
      url: "https://www.newegg.com/",
      interactiveElements: [
        {
          type: "input",
          label: "Search products",
          inputType: "search",
          placeholder: "Search products",
          context: "header",
          index: 1,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        ...Array.from({ length: 14 }, (_, i) => ({
          type: "link" as const,
          text: `Promo ${i + 1}`,
          href: `https://www.newegg.com/promo-${i + 1}`,
          context: i < 4 ? "nav" : "content",
          selector: `a.promo-${i + 1}`,
          index: i + 2,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        })),
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
  assert.equal(storefrontHomePage, "visible_only");
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

test("visible_only omits arbitrary form field contents from context", () => {
  const context = buildScopedContext(
    buildPage({
      title: "Checkout",
      url: "https://example.com/checkout",
      interactiveElements: [
        {
          type: "input",
          label: "Full name",
          inputType: "text",
          value: "Ada Lovelace",
          name: "name",
          index: 4,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        {
          type: "input",
          label: "Email",
          inputType: "email",
          value: "ada@example.com",
          name: "email",
          index: 5,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
      ],
      forms: [
        {
          id: "checkout-form",
          action: "/checkout",
          method: "post",
          fields: [
            {
              type: "input",
              label: "Full name",
              inputType: "text",
              value: "Ada Lovelace",
              name: "name",
              index: 4,
              visible: true,
              inViewport: true,
              fullyInViewport: true,
            },
            {
              type: "input",
              label: "Email",
              inputType: "email",
              value: "ada@example.com",
              name: "email",
              index: 5,
              visible: true,
              inViewport: true,
              fullyInViewport: true,
            },
          ],
        },
      ],
    }),
    "visible_only",
  );

  assert.doesNotMatch(context, /Ada Lovelace/);
  assert.doesNotMatch(context, /ada@example\.com/);
  assert.doesNotMatch(context, /current="/);
  assert.doesNotMatch(context, /value="/);
  assert.doesNotMatch(context, /Full name.*empty/);
});

test("visible_only marks travel-style fields as empty and directly fillable", () => {
  const page = buildPage({
    title: "Google Flights",
    url: "https://www.google.com/travel/flights",
    interactiveElements: [
      {
        type: "input",
        label: "Where from?",
        inputType: "combobox",
        role: "combobox",
        hasValue: true,
        ariaExpanded: false,
        index: 12,
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
      {
        type: "input",
        label: "Where to?",
        inputType: "combobox",
        role: "combobox",
        focused: true,
        ariaExpanded: false,
        index: 13,
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
      {
        type: "input",
        label: "Departure date",
        inputType: "text",
        role: "textbox",
        index: 14,
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
    ],
    forms: [
      {
        fields: [
          {
            type: "input",
            label: "Where from?",
            inputType: "combobox",
            role: "combobox",
            hasValue: true,
            index: 12,
            visible: true,
            inViewport: true,
            fullyInViewport: true,
          },
        ],
      },
    ],
  });

  const context = buildScopedContext(page, "visible_only");

  assert.match(
    context,
    /\[#12\] \[Where from\?\] combobox input fillable already has value; use type_text\(index=12\) only to change it \(role=combobox, has-value, expanded=false\)/,
  );
  assert.match(
    context,
    /\[#13\] \[Where to\?\] combobox input fillable empty cursor is here; type_text\(text="\.\.\."\) or type_text\(index=13\) \(role=combobox, focused, expanded=false\)/,
  );
  assert.match(
    context,
    /\[#14\] \[Departure date\] text input fillable empty use type_text\(index=14\)/,
  );
  assert.doesNotMatch(context, /current="/);
  assert.doesNotMatch(context, /value="/);
});

test("visible_only tells agents to use flight booking controls before direct URLs", () => {
  const context = buildScopedContext(
    buildPage({
      title: "Google Flights",
      url: "https://www.google.com/travel/flights",
      interactiveElements: [
        {
          type: "input",
          label: "Where from?",
          inputType: "combobox",
          role: "combobox",
          hasValue: true,
          index: 12,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        {
          type: "input",
          label: "Where to?",
          inputType: "combobox",
          role: "combobox",
          focused: true,
          index: 13,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        {
          type: "input",
          label: "Departure date",
          inputType: "text",
          role: "textbox",
          index: 14,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
      ],
    }),
    "visible_only",
  );

  assert.match(context, /### Flight Booking Hint/);
  assert.match(
    context,
    /use the visible route, destination, and date controls/i,
  );
  assert.match(context, /Direct travel URLs are a fallback only/i);
});

test("agent prompt makes direct travel URLs a fallback after visible controls", () => {
  const prompt = buildAgentSystemPrompt({
    profile: "compact",
    activeTabTitle: "Google Flights",
    activeTabUrl: "https://www.google.com/travel/flights",
    defaultReadMode: "visible_only",
    pageType: "FORM",
    structuredContext: "",
    supervisorPaused: false,
    approvalMode: "auto",
    pendingApprovals: 0,
    recentCheckpoints: "",
    taskTrackerContext: "",
  });

  assert.match(
    prompt,
    /On flight\/travel booking pages with visible route, destination, or date fields/i,
  );
  assert.match(prompt, /Direct travel URLs are a fallback only/i);
});

test("compact context keeps fill hints for visible fields", () => {
  const context = buildCompactScopedContext(
    buildPage({
      title: "Google Flights",
      url: "https://www.google.com/travel/flights",
      interactiveElements: [
        {
          type: "input",
          label: "Where from?",
          inputType: "combobox",
          role: "combobox",
          hasValue: true,
          index: 12,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        {
          type: "input",
          label: "Where to?",
          inputType: "combobox",
          role: "combobox",
          focused: true,
          index: 13,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
      ],
    }),
    "visible_only",
  );

  assert.match(
    context,
    /\[#12\] Where from\? \(combobox input; has value; type_text\(index=12\) changes it\)/,
  );
  assert.match(
    context,
    /\[#13\] Where to\? \(combobox input; empty; focused; type_text\(text="\.\.\."\) targets this\)/,
  );
});

test("visible_only focuses cart confirmation dialog actions over background add-to-cart buttons", () => {
  const context = buildScopedContext(
    buildPage({
      title: "Powell's Books",
      url: "https://www.powells.com/book/example",
      overlays: [
        {
          type: "dialog",
          role: "dialog",
          label: "Added to cart",
          text: "Added to cart. Continue shopping or view cart.",
          blocksInteraction: true,
        },
      ],
      interactiveElements: [
        {
          type: "button",
          text: "Add to Cart",
          index: 4,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        {
          type: "button",
          text: "Continue Shopping",
          context: "dialog",
          index: 12,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        {
          type: "link",
          text: "View Cart",
          href: "https://www.powells.com/cart",
          context: "dialog",
          index: 13,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
      ],
    }),
    "visible_only",
  );

  assert.match(context, /### Immediate Overlay Actions/);
  assert.match(
    context,
    /Cart confirmation detected: choose a dialog action such as Continue Shopping, View Cart, or Checkout\. Do not click background Add to Cart again\./,
  );
  assert.match(
    context,
    /Background controls hidden while the dialog is active: 1/,
  );
  assert.match(context, /### Visible In-Viewport Interactive Elements \(2\)/);
  assert.match(
    context,
    /\[#12\] \[Continue Shopping\] button \(context=dialog\)/,
  );
  assert.match(
    context,
    /\[#13\] \[View Cart\] link → https:\/\/www\.powells\.com\/cart \(context=dialog\)/,
  );
  assert.doesNotMatch(context, /\[#4\] \[Add to Cart\]/);
});

test("visible_only surfaces primary purchase actions on product pages", () => {
  const context = buildScopedContext(
    buildPage({
      title: "Interesting Book",
      url: "https://www.example.com/book/interesting-book",
      interactiveElements: [
        {
          type: "link",
          text: "Author",
          href: "https://www.example.com/authors/example",
          index: 2,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        {
          type: "button",
          text: "Add to Cart",
          index: 8,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        {
          type: "input",
          label: "Quantity",
          inputType: "number",
          value: "1",
          name: "quantity",
          index: 9,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        {
          type: "link",
          text: "View Cart",
          href: "https://www.example.com/cart",
          index: 10,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
      ],
    }),
    "visible_only",
  );

  assert.match(context, /### Primary Purchase Actions/);
  assert.match(context, /\[#8\] \[Add to Cart\] button/);
  assert.match(
    context,
    /\[#10\] \[View Cart\] link → https:\/\/www\.example\.com\/cart/,
  );
});

test("visible_only surfaces offscreen purchase actions on product pages", () => {
  const context = buildScopedContext(
    buildPage({
      title: "Interesting Book",
      url: "https://www.example.com/book/interesting-book",
      interactiveElements: [
        {
          type: "button",
          text: "Add to Cart",
          index: 18,
          visible: true,
          inViewport: false,
          fullyInViewport: false,
        },
        {
          type: "link",
          text: "Checkout",
          href: "https://www.example.com/checkout",
          index: 19,
          visible: true,
          inViewport: false,
          fullyInViewport: false,
        },
      ],
    }),
    "visible_only",
  );

  assert.match(context, /### Offscreen Purchase Actions/);
  assert.match(
    context,
    /outside the viewport\. You can scroll to reveal them or click them by index\./,
  );
  assert.match(context, /\[#18\] \[Add to Cart\] button \(offscreen/);
  assert.match(
    context,
    /\[#19\] \[Checkout\] link → https:\/\/www\.example\.com\/checkout \(offscreen/,
  );
});
