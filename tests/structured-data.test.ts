import assert from "node:assert/strict";
import test from "node:test";

import { extractStructuredDataFromJsonLd } from "../src/main/content/structured-data";
import { inferPageSchema } from "../src/shared/page-schema";
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

test("extractStructuredDataFromJsonLd falls back to generic page metadata", () => {
  const entities = extractStructuredDataFromJsonLd(
    [],
    [],
    [],
    {},
    "Example article title",
    "https://example.com/articles/testing",
    "A concise page summary for the current article.",
    "Jane Doe",
    [
      { level: 1, text: "Example article title" },
      { level: 2, text: "How it works" },
    ],
  );

  assert.equal(entities.length, 1);
  assert.equal(entities[0]?.source, "page");
  assert.deepEqual(entities[0]?.types, ["Article"]);
  assert.equal(entities[0]?.name, "Example article title");
  assert.equal(
    entities[0]?.url,
    "https://example.com/articles/testing",
  );
  assert.equal(
    entities[0]?.description,
    "A concise page summary for the current article.",
  );
  assert.equal(entities[0]?.attributes.byline, "Jane Doe");
  assert.deepEqual(entities[0]?.attributes.headings, [
    "Example article title",
    "How it works",
  ]);
});

test("inferPageSchema maps aggregate rating and offer price for products", () => {
  const schema = inferPageSchema(
    makePageContent({
      structuredData: [
        {
          source: "json-ld",
          types: ["Product"],
          name: "Widget",
          attributes: {
            name: "Widget",
            offers: {
              price: "19.99",
              priceCurrency: "USD",
            },
            aggregateRating: {
              ratingValue: 4.8,
              reviewCount: 127,
            },
          },
        },
      ],
    }),
  );

  assert.equal(schema.pageType, "product");
  assert.equal(schema.primaryEntity?.priceField, "19.99");
  assert.equal(schema.primaryEntity?.ratingField, "4.8");
  assert.equal(schema.primaryEntity?.reviewsField, "127");
});
