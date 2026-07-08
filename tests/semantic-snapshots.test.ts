import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSemanticSnapshot,
  diffSemanticSnapshots,
} from "../src/main/content/semantic-snapshots";
import { diffSnapshots } from "../src/main/content/page-diff";
import type { PageSnapshot } from "../src/main/content/page-snapshots";
import type { PageContent } from "../src/shared/types";

function makePageContent(overrides: Partial<PageContent> = {}): PageContent {
  return {
    title: "Example product",
    content: "",
    htmlContent: "",
    byline: "",
    excerpt: "",
    url: "https://example.com/product/widget",
    headings: [],
    navigation: [],
    interactiveElements: [],
    forms: [],
    viewport: {
      width: 1440,
      height: 900,
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

test("buildSemanticSnapshot captures page meaning without field values", () => {
  const snapshot = buildSemanticSnapshot(
    "https://example.com/product/widget?ref=ad#details",
    makePageContent({
      headings: [{ level: 1, text: "Widget" }],
      interactiveElements: [
        {
          type: "button",
          label: "Add to Cart",
          visible: true,
          inViewport: true,
        },
      ],
      forms: [
        {
          fields: [
            {
              type: "input",
              inputType: "email",
              label: "Email",
              name: "email",
              value: "private@example.com",
              hasValue: true,
            },
          ],
        },
      ],
      pageSchema: {
        pageType: "product",
        confidence: 0.9,
        primaryEntity: {
          type: "Product",
          nameField: "Widget",
          priceField: "$19.99",
          ratingField: "4.8",
        },
        actionButtons: [
          {
            label: "Add to Cart",
            selector: "button.add",
            intent: "addToCart",
          },
        ],
      },
    }),
    "2026-01-01T00:00:00.000Z",
  );

  assert.equal(snapshot.url, "https://example.com/product/widget");
  assert.equal(snapshot.pageType, "product");
  assert.equal(snapshot.primaryEntity?.name, "Widget");
  assert.equal(snapshot.primaryEntity?.price, "$19.99");
  assert.deepEqual(snapshot.headings, ["H1: Widget"]);
  assert.equal(snapshot.visibleActions[0]?.intent, "addToCart");
  assert.deepEqual(snapshot.formFields, [{ name: "email", type: "email", label: "Email" }]);
  assert.equal(JSON.stringify(snapshot).includes("private@example.com"), false);
});

test("semantic fingerprint ignores capture time", () => {
  const page = makePageContent({
    pageSchema: { pageType: "article", confidence: 0.8, actionButtons: [] },
  });
  const first = buildSemanticSnapshot(page.url, page, "2026-01-01T00:00:00.000Z");
  const second = buildSemanticSnapshot(page.url, page, "2026-01-01T00:01:00.000Z");

  assert.equal(first.semanticFingerprint, second.semanticFingerprint);
});

test("buildSemanticSnapshot reuses canonical page schema normalization", () => {
  const snapshot = buildSemanticSnapshot(
    "https://example.com/product/widget",
    makePageContent({
      forms: [
        {
          fields: [
            {
              type: "input",
              inputType: "range",
              label: "Quantity",
              name: "quantity",
            },
          ],
        },
      ],
      structuredData: [
        {
          source: "json-ld",
          types: ["Product"],
          attributes: {
            name: "Widget",
            offers: { price: "29.99" },
          },
        },
      ],
      pageSchema: {
        pageType: "product",
        confidence: 0.8,
        actionButtons: [],
      },
    }),
    "2026-01-01T00:00:00.000Z",
  );

  assert.equal(snapshot.primaryEntity?.name, "Widget");
  assert.equal(snapshot.primaryEntity?.price, "29.99");
  assert.deepEqual(snapshot.formFields, [{ name: "quantity", type: "number", label: "Quantity" }]);
});

test("diffSemanticSnapshots reports meaningful semantic changes", () => {
  const oldSnapshot = buildSemanticSnapshot(
    "https://example.com/product/widget",
    makePageContent({
      pageSchema: {
        pageType: "product",
        confidence: 0.9,
        primaryEntity: {
          type: "Product",
          nameField: "Widget",
          priceField: "$19.99",
        },
        actionButtons: [{ label: "Add to Cart", selector: "button", intent: "addToCart" }],
      },
    }),
    "2026-01-01T00:00:00.000Z",
  );
  const newSnapshot = buildSemanticSnapshot(
    "https://example.com/product/widget",
    makePageContent({
      overlays: [
        {
          type: "modal",
          kind: "cart_confirmation",
          label: "Added to cart",
          blocksInteraction: true,
        },
      ],
      pageSchema: {
        pageType: "product",
        confidence: 0.9,
        primaryEntity: {
          type: "Product",
          nameField: "Widget",
          priceField: "$24.99",
        },
        actionButtons: [{ label: "Checkout", selector: "button", intent: "submit" }],
      },
    }),
    "2026-01-01T00:01:00.000Z",
  );

  const diff = diffSemanticSnapshots(oldSnapshot, newSnapshot);

  assert.equal(diff.hasChanges, true);
  assert.ok(diff.changes.every((change) => change.section === "semantic"));
  assert.ok(diff.changes.some((change) => /Price/.test(change.summary)));
  assert.ok(diff.changes.some((change) => /Actions/.test(change.summary)));
  assert.ok(diff.changes.some((change) => /Blockers/.test(change.summary)));
});

test("diffSnapshots includes semantic changes from the same stored baseline", () => {
  const oldSemantic = buildSemanticSnapshot(
    "https://example.com/product/widget",
    makePageContent({
      pageSchema: {
        pageType: "product",
        confidence: 0.9,
        primaryEntity: {
          type: "Product",
          nameField: "Widget",
          priceField: "$19.99",
        },
        actionButtons: [{ label: "Add to Cart", selector: "button", intent: "addToCart" }],
      },
    }),
    "2026-01-01T00:00:00.000Z",
  );
  const newSemantic = buildSemanticSnapshot(
    "https://example.com/product/widget",
    makePageContent({
      pageSchema: {
        pageType: "product",
        confidence: 0.9,
        primaryEntity: {
          type: "Product",
          nameField: "Widget",
          priceField: "$24.99",
        },
        actionButtons: [{ label: "Add to Cart", selector: "button", intent: "addToCart" }],
      },
    }),
    "2026-01-01T00:01:00.000Z",
  );
  const oldSnapshot: PageSnapshot = {
    url: "https://example.com/product/widget",
    title: "Example product",
    textContent: "Stable copy",
    headings: "# Widget",
    capturedAt: "2026-01-01T00:00:00.000Z",
    semantic: oldSemantic,
  };

  const diff = diffSnapshots(
    oldSnapshot,
    "Stable copy",
    "Example product",
    "# Widget",
    newSemantic,
  );

  assert.equal(diff.hasChanges, true);
  assert.deepEqual(
    diff.changes.map((change) => change.section),
    ["semantic"],
  );
  assert.ok(diff.changes.some((change) => /Price/.test(change.summary)));
});
