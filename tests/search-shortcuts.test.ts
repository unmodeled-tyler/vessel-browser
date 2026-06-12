import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommonSearchUrlShortcut,
  buildFlightSearchShortcut,
  buildSearchEngineLandingShortcut,
  buildSearchShortcut,
  urlAlreadyHasSearchQuery,
} from "../src/main/ai/page-actions/navigation";
import { buildHuggingFaceSearchShortcut } from "../src/main/ai/search-huggingface";

test("common search shortcut rewrites existing query params and clears pagination", () => {
  const shortcut = buildCommonSearchUrlShortcut(
    "https://example.com/search?q=old+query&page=3",
    "desk lamp",
  );

  assert.ok(shortcut);
  assert.equal(shortcut.source, "page URL");

  const url = new URL(shortcut.url);
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("q"), "desk lamp");
  assert.equal(url.searchParams.has("page"), false);
});

test("common search shortcut does not invent search URLs on arbitrary pages", () => {
  const shortcut = buildCommonSearchUrlShortcut(
    "https://example.com/products/widget-123",
    "wireless mouse",
  );

  assert.equal(shortcut, null);
});

test("search engine landing shortcut opens real results instead of driving homepage inputs", () => {
  const shortcut = buildSearchEngineLandingShortcut(
    "https://www.google.com/",
    "cheapest flight tomorrow from portland to san francisco",
  );

  assert.ok(shortcut);
  assert.equal(shortcut.source, "Google landing page");
  assert.equal(
    shortcut.url,
    "https://www.google.com/search?q=cheapest%20flight%20tomorrow%20from%20portland%20to%20san%20francisco",
  );
});

test("search engine landing shortcut recognizes the app's DuckDuckGo start page", () => {
  const shortcut = buildSearchEngineLandingShortcut(
    "https://start.duckduckgo.com/",
    "cheapest flight tomorrow from portland to san francisco",
  );

  assert.ok(shortcut);
  assert.equal(shortcut.source, "DuckDuckGo landing page");
  assert.equal(
    shortcut.url,
    "https://duckduckgo.com/?q=cheapest%20flight%20tomorrow%20from%20portland%20to%20san%20francisco",
  );
});

test("search engine landing shortcut ignores arbitrary site home pages", () => {
  const shortcut = buildSearchEngineLandingShortcut(
    "https://example.com/",
    "wireless mouse",
  );

  assert.equal(shortcut, null);
});

test("flight shortcut routes flight shopping to Google Flights using the full task goal", () => {
  const shortcut = buildFlightSearchShortcut(
    "cheapest one-way flight Portland",
    "can you help me find the cheapest 1 way flight from Portland to sf on June 23rd? No bags or anything else - just me and a carry on!",
  );

  assert.ok(shortcut);
  assert.equal(shortcut.source, "Google Flights");
  assert.equal(shortcut.section, "flight search");
  assert.equal(
    shortcut.url,
    "https://www.google.com/travel/flights?q=can%20you%20help%20me%20find%20the%20cheapest%201%20way%20flight%20from%20Portland%20to%20sf%20on%20June%2023rd%3F%20No%20bags%20or%20anything%20else%20-%20just%20me%20and%20a%20carry%20on!",
  );
});

test("flight shortcut ignores non-flight shopping queries", () => {
  assert.equal(buildFlightSearchShortcut("cheap hotel Portland"), null);
});

test("flight shortcut keeps a flight-specific tool query when the task goal is generic", () => {
  const shortcut = buildFlightSearchShortcut(
    "cheap flights PDX to SFO June 23",
    "help me with this",
  );

  assert.ok(shortcut);
  assert.equal(
    shortcut.url,
    "https://www.google.com/travel/flights?q=cheap%20flights%20PDX%20to%20SFO%20June%2023",
  );
});

test("search query detection treats matching result URLs as already searched", () => {
  assert.equal(
    urlAlreadyHasSearchQuery(
      "https://duckduckgo.com/?q=cheapest+flight+tomorrow+Portland+to+San+Francisco",
      "cheapest flight tomorrow Portland to San Francisco",
    ),
    true,
  );
  assert.equal(
    urlAlreadyHasSearchQuery(
      "https://duckduckgo.com/?q=cheapest+flight+tomorrow+Portland+to+San+Francisco",
      "cheap hotel tomorrow Portland",
    ),
    false,
  );
});

test("common search shortcut preserves literal query text", () => {
  const shortcut = buildCommonSearchUrlShortcut(
    "https://example.com/search?q=old+query",
    "The Last of Us",
  );

  assert.ok(shortcut);

  const url = new URL(shortcut.url);
  assert.equal(url.searchParams.get("q"), "The Last of Us");
});

test("hugging face shortcut routes model searches into the models index with filters", () => {
  const shortcut = buildHuggingFaceSearchShortcut(
    "https://huggingface.co/",
    "find llama text generation models with transformers 8b",
  );

  assert.ok(shortcut);
  assert.equal(shortcut.source, "Hugging Face");
  assert.equal(shortcut.section, "models");

  const url = new URL(shortcut.url);
  assert.equal(url.pathname, "/models");
  assert.equal(url.searchParams.get("search"), "llama");
  assert.equal(url.searchParams.get("pipeline_tag"), "text-generation");
  assert.equal(url.searchParams.get("library"), "transformers");
  assert.equal(url.searchParams.get("num_parameters"), "6B<n<9B");
});

test("hugging face shortcut ignores non-hub subdomains", () => {
  const shortcut = buildHuggingFaceSearchShortcut(
    "https://cdn-lfs.huggingface.co/repos/example",
    "llama 8b models",
  );

  assert.equal(shortcut, null);
});

test("search shortcut falls back to generic URL rewriting for non-HF search pages", () => {
  const shortcut = buildSearchShortcut(
    "https://docs.example.com/search?query=browser&offset=20",
    "automation agents",
  );

  assert.ok(shortcut);
  assert.equal(shortcut.source, "page URL");

  const url = new URL(shortcut.url);
  assert.equal(url.searchParams.get("query"), "automation agents");
  assert.equal(url.searchParams.has("offset"), false);
});
