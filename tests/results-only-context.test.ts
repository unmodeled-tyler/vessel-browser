import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScopedContext,
  chooseAgentReadMode,
  detectPageType,
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

test("results_only detects GitHub-style repository search results", () => {
  const context = buildScopedContext(
    buildPage({
      url: "https://github.com/search?q=vessel&type=repositories",
      title: "Repository search results · GitHub",
      headings: [{ level: 1, text: "Repository search results" }],
      interactiveElements: [
        {
          type: "link",
          text: "unmodeled-tyler/vessel-browser",
          href: "https://github.com/unmodeled-tyler/vessel-browser",
          context: "content",
          selector: "a.repo-link",
          index: 12,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        {
          type: "link",
          text: "octocat/hello-world",
          href: "https://github.com/octocat/hello-world",
          context: "content",
          selector: "a.repo-link-2",
          index: 13,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
        {
          type: "link",
          text: "Next",
          href: "https://github.com/search?p=2&q=vessel&type=repositories",
          context: "content",
          selector: "a.next-page",
          index: 14,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
      ],
    }),
    "results_only",
  );

  assert.match(context, /Likely Search Results/);
  assert.match(context, /unmodeled-tyler\/vessel-browser/);
  assert.match(context, /octocat\/hello-world/);
  assert.doesNotMatch(context, /Next/);
});

test("results_only treats Hacker News story titles as results and skips utility links", () => {
  const page = buildPage({
    url: "https://news.ycombinator.com/",
    title: "Hacker News",
    interactiveElements: [
      {
        type: "link",
        text: "Every Frame Perfect",
        href: "https://everyframeperfect.com/",
        context: "content",
        selector: "a.storylink-1",
        index: 22,
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
      {
        type: "link",
        text: "hide",
        href: "https://news.ycombinator.com/hide?id=123&goto=news",
        context: "content",
        selector: "a.hide-1",
        index: 23,
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
      {
        type: "link",
        text: "42 comments",
        href: "https://news.ycombinator.com/item?id=123",
        context: "content",
        selector: "a.comments-1",
        index: 24,
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
      {
        type: "link",
        text: "longusername",
        href: "https://news.ycombinator.com/user?id=longusername",
        context: "content",
        selector: "a.user-1",
        index: 25,
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
      {
        type: "link",
        text: "Ask HN: How do you debug agents?",
        href: "https://news.ycombinator.com/item?id=456",
        context: "content",
        selector: "a.storylink-2",
        index: 26,
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
    ],
  });
  const context = buildScopedContext(page, "results_only");

  assert.match(context, /Likely Search Results/);
  assert.match(context, /\[#22\] \[Every Frame Perfect\]/);
  assert.match(context, /\[#26\] \[Ask HN: How do you debug agents\?\]/);
  assert.doesNotMatch(context, /\[#23\] \[hide\]/);
  assert.doesNotMatch(context, /\[#24\] \[42 comments\]/);
  assert.doesNotMatch(context, /\[#25\] \[longusername\]/);
  assert.equal(detectPageType(page), "PAGINATED_LIST");
  assert.equal(chooseAgentReadMode(page), "results_only");
});

test("results_only does not invent results on ordinary content pages", () => {
  const context = buildScopedContext(
    buildPage({
      url: "https://example.com/about",
      title: "About Example",
      interactiveElements: [
        {
          type: "link",
          text: "Contact",
          href: "https://example.com/contact",
          context: "content",
          selector: "a.contact",
          index: 1,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
      ],
    }),
    "results_only",
  );

  assert.match(context, /No likely primary result links were detected/);
});
