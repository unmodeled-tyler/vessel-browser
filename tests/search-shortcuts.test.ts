import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommonSearchUrlShortcut,
  buildHuggingFaceSearchShortcut,
  buildSearchShortcut,
} from "../src/main/ai/page-actions";

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
