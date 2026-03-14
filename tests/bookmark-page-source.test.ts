import assert from "node:assert/strict";
import test from "node:test";

import { resolveBookmarkSourceDraft } from "../src/main/bookmarks/page-source";

test("resolveBookmarkSourceDraft prefers an explicit URL and title", async () => {
  const result = await resolveBookmarkSourceDraft(undefined, {
    explicitUrl: "https://example.com/event",
    explicitTitle: "Example Event",
  });

  assert.deepEqual(result, {
    url: "https://example.com/event",
    title: "Example Event",
    source: "explicit",
  });
});

test("resolveBookmarkSourceDraft extracts a link target from the current page", async () => {
  const wc = {
    executeJavaScript: async () => ({
      url: "https://events.example.com/green-chapter",
      title: "The Green Chapter",
    }),
    getURL: () => "https://travelportland.com/events",
    getTitle: () => "Events in Portland",
  };

  const result = await resolveBookmarkSourceDraft(wc as never, {
    resolvedSelector: "a.event-link",
  });

  assert.deepEqual(result, {
    url: "https://events.example.com/green-chapter",
    title: "The Green Chapter",
    source: "link",
  });
});

test("resolveBookmarkSourceDraft reports non-link selections clearly", async () => {
  const wc = {
    executeJavaScript: async () => ({
      error: "Selected element is not a link",
    }),
    getURL: () => "https://travelportland.com/events",
    getTitle: () => "Events in Portland",
  };

  const result = await resolveBookmarkSourceDraft(wc as never, {
    resolvedSelector: "div.card",
  });

  assert.deepEqual(result, {
    error: "Selected element is not a link",
  });
});

test("resolveBookmarkSourceDraft falls back to the current page when no link is targeted", async () => {
  const wc = {
    getURL: () => "https://travelportland.com/events",
    getTitle: () => "Events in Portland",
  };

  const result = await resolveBookmarkSourceDraft(wc as never, {});

  assert.deepEqual(result, {
    url: "https://travelportland.com/events",
    title: "Events in Portland",
    source: "page",
  });
});
