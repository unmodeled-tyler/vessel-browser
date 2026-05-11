import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanDiffSummaryText,
  formatDiffSectionLabel,
  parseDiffSummaryParts,
} from "../src/renderer/src/lib/pageDiffDisplay";

test("parseDiffSummaryParts parses spaced and unspaced pipe delimiters", () => {
  assert.deepEqual(parseDiffSummaryParts("Title: New title | Content: Price changed"), [
    { section: "Title", text: "New title" },
    { section: "Content", text: "Price changed" },
  ]);

  assert.deepEqual(parseDiffSummaryParts("Title: New title|Content: Price changed"), [
    { section: "Title", text: "New title" },
    { section: "Content", text: "Price changed" },
  ]);
});

test("parseDiffSummaryParts supports multi-word and unknown section labels", () => {
  assert.deepEqual(
    parseDiffSummaryParts("Main content: Details changed | Meta-Description: Updated"),
    [
      { section: "Main content", text: "Details changed" },
      { section: "Meta-Description", text: "Updated" },
    ],
  );
});

test("parseDiffSummaryParts cleans markdown formatting", () => {
  assert.deepEqual(
    parseDiffSummaryParts(
      "Content: **Price** changed for [plan](https://example.com) and `CTA` updated",
    ),
    [{ section: "Content", text: "Price changed for plan and CTA updated" }],
  );
});

test("parseDiffSummaryParts falls back when summary has no displayable text", () => {
  assert.deepEqual(parseDiffSummaryParts(""), [{ text: "Change detected." }]);
  assert.deepEqual(parseDiffSummaryParts("   \n\t  "), [{ text: "Change detected." }]);
});

test("cleanDiffSummaryText removes common markdown wrappers", () => {
  assert.equal(
    cleanDiffSummaryText("> ## **Hello** [world](https://example.com)"),
    "Hello world",
  );
});

test("formatDiffSectionLabel normalizes known sections and preserves unknown labels", () => {
  assert.equal(formatDiffSectionLabel(" content "), "Content");
  assert.equal(formatDiffSectionLabel("Custom Section"), "Custom Section");
});
