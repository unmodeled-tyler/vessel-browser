import assert from "node:assert/strict";
import test from "node:test";

import { detectPageIssues } from "../src/main/content/page-access-issues";
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

test("detectPageIssues flags Google unusual traffic pages as rate limits", () => {
  const issues = detectPageIssues(
    buildPage({
      url: "https://www.google.com/sorry/index?continue=/search%3Fq%3Dfree%2Bevents%2Bportland",
      title: "429. That’s an error.",
      content:
        "Our systems have detected unusual traffic from your computer network. This page checks to see if it's really you sending the requests, and not a robot.",
    }),
  );

  assert.equal(issues[0]?.kind, "rate-limit");
  assert.match(issues[0]?.recommendation ?? "", /direct sources/i);
});

test("detectPageIssues flags captcha and browser challenges as bot checks", () => {
  const issues = detectPageIssues(
    buildPage({
      url: "https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate",
      title: "Just a moment...",
      content:
        "Checking your browser before accessing the site. Please enable JavaScript and cookies to continue. Attention Required!",
    }),
  );

  assert.equal(issues[0]?.kind, "bot-check");
});

test("detectPageIssues does not flag normal event listing pages", () => {
  const issues = detectPageIssues(
    buildPage({
      url: "https://www.eventbrite.com/d/or--portland/free--events/",
      title: "Free Events in Portland, OR",
      content:
        "Discover upcoming free events in Portland. Browse live music, workshops, networking events, and community gatherings this weekend.",
      headings: [{ level: 1, text: "Free Events in Portland" }],
    }),
  );

  assert.equal(issues.length, 0);
});

test("detectPageIssues flags 404-style not-found pages", () => {
  const issues = detectPageIssues(
    buildPage({
      url: "https://www.allrecipes.com/recipe/missing-page",
      title: "404 - Page Not Found",
      content:
        "Sorry, the page you're looking for could not be found. It may have been removed or is temporarily unavailable.",
    }),
  );

  assert.equal(issues[0]?.kind, "not-found");
  assert.match(issues[0]?.recommendation ?? "", /Navigate back/i);
});
