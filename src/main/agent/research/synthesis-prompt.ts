import type { ThreadFindings, ResearchObjectives } from "../../../shared/research-types";

export function buildSynthesisPrompt(
  objectives: ResearchObjectives,
  findings: ThreadFindings[],
): string {
  const findingsBlock = findings
    .map(
      (f) => `
### Thread: ${f.threadLabel}
Question: ${f.threadQuestion}
Execution: ${f.executionSummary}

Claims:
${f.claims
  .map(
    (c, i) =>
      `${i + 1}. ${c.claim}
   Source: ${c.sourceUrl}
   Quote: "${c.extractedQuote}"`,
  )
  .join("\n")}

${f.discardedSources.length > 0 ? `Discarded sources:\n${f.discardedSources.map((d) => `- ${d.url}: ${d.reason}`).join("\n")}` : ""}`,
    )
    .join("\n\n---\n");

  return `Synthesize the following research findings into a complete Research Report.

RESEARCH QUESTION: ${objectives.researchQuestion}
AUDIENCE: ${objectives.audience}
EXPECTED OUTLINE:
${objectives.reportOutline.map((s) => `- ${s}`).join("\n")}

FINDINGS:
${findingsBlock}

INSTRUCTIONS:
1. Write an executive summary (2-3 paragraphs).
2. Write one section per thread, using the claims above.
3. Every factual claim MUST cite its source using the numbered index format [1], [2], etc.
4. Create a numbered Source Index at the end with URLs, titles, and supporting quotes.
5. Explicitly flag any contradictions between sources.
6. Explicitly flag any gaps — things the research did not answer.
7. Do not invent anything. Only use claims from the findings above.
8. Do not use emojis.

Return the report as structured markdown.`;
}
