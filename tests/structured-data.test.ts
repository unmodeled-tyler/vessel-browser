import assert from "node:assert/strict";
import test from "node:test";

import { extractStructuredDataFromJsonLd } from "../src/main/content/structured-data";

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
