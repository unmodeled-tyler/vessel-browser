import assert from "node:assert/strict";
import test from "node:test";

import {
  isDocumentViewerUrl,
  isTrackablePageUrl,
} from "../src/shared/page-url";

test("document viewer URLs are not tracked for page snapshots", () => {
  assert.equal(isDocumentViewerUrl("https://example.com/manual.pdf"), true);
  assert.equal(isTrackablePageUrl("https://example.com/manual.pdf"), false);
  assert.equal(
    isDocumentViewerUrl("https://archive.org/details/example-book"),
    true,
  );
  assert.equal(
    isTrackablePageUrl("https://archive.org/details/example-book"),
    false,
  );
});

test("normal web pages remain trackable", () => {
  assert.equal(isDocumentViewerUrl("https://example.com/articles/pdf-tools"), false);
  assert.equal(isTrackablePageUrl("https://example.com/articles/pdf-tools"), true);
  assert.equal(isTrackablePageUrl("https://example.com/search?q=pdf"), true);
});
