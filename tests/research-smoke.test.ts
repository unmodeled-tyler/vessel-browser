import { describe, it } from "node:test";
import assert from "node:assert";
import { renderReportAsMarkdown } from "../src/main/agent/research/export";
import type { ResearchReport } from "../src/shared/research-types";

const mockReport: ResearchReport = {
  title: "Test Report",
  executiveSummary: "This is a test summary with a cited claim [1].",
  findingsByThread: [
    {
      threadLabel: "Test Thread",
      content: "Test finding with citation [1]. More details follow.",
    },
  ],
  contradictions: [
    {
      claim: "Test contradiction",
      sourceA: { url: "https://a.example.com", claim: "X is true" },
      sourceB: { url: "https://b.example.com", claim: "X is false" },
      resolution: "Source B appears more authoritative.",
    },
  ],
  gaps: ["We could not determine Y."],
  sourceIndex: [
    {
      index: 1,
      url: "https://example.com",
      title: "Example Source",
      accessedAt: "2026-05-01T12:00:00Z",
      supportingQuote: "The relevant quote from the source.",
    },
  ],
  generatedAt: "2026-05-01T12:00:00Z",
  objectives: {
    researchQuestion: "Test question?",
    threads: [
      {
        label: "Test Thread",
        question: "Test thread question?",
        searchQueries: ["test query"],
        preferredDomains: [],
        blockedDomains: [],
        sourceBudget: 3,
      },
    ],
    audience: "general",
    reportOutline: ["Introduction", "Findings"],
    totalSourceBudget: 3,
  },
};

describe("Research Desk smoke tests", () => {
  it("renders report as markdown", () => {
    const md = renderReportAsMarkdown(mockReport);
    assert.ok(md.includes("# Test Report"));
    assert.ok(md.includes("## Executive Summary"));
    assert.ok(md.includes("This is a test summary with a cited claim [1]"));
    assert.ok(md.includes("## Test Thread"));
    assert.ok(md.includes("## Contradictions & Discrepancies"));
    assert.ok(md.includes("## Gaps & Unanswered Questions"));
    assert.ok(md.includes("## Source Index"));
    assert.ok(md.includes("1. [Example Source](https://example.com)"));
  });

  it("includes agent traces when provided", () => {
    const md = renderReportAsMarkdown(mockReport, [
      {
        threadLabel: "Test Thread",
        toolCalls: [
          {
            tool: "navigate",
            args: { url: "https://example.com" },
            result: "Navigated to https://example.com",
            timestamp: "2026-05-01T12:00:00Z",
            durationMs: 1500,
          },
        ],
        errors: [],
        startedAt: "2026-05-01T12:00:00Z",
        finishedAt: "2026-05-01T12:01:00Z",
      },
    ]);
    assert.ok(md.includes("## Appendix: Agent Traces"));
    assert.ok(md.includes("Tool calls: 1"));
  });

  it("source-anchored claims have citations", () => {
    const md = renderReportAsMarkdown(mockReport);
    assert.ok(md.includes("[1]"));
    assert.ok(md.includes("https://example.com"));
  });

  it("empty contradictions and gaps render cleanly", () => {
    const cleanReport = { ...mockReport, contradictions: [], gaps: [] };
    const md = renderReportAsMarkdown(cleanReport);
    assert.ok(!md.includes("## Contradictions"));
    assert.ok(!md.includes("## Gaps"));
  });
});
