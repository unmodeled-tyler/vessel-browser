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
   Title: ${c.sourceTitle}
   Accessed: ${c.extractedAt}
   Quote: "${c.extractedQuote}"
   Relevance: ${c.relevanceNote}`,
  )
  .join("\n")}

${f.discardedSources.length > 0 ? `Discarded sources:\n${f.discardedSources.map((d) => `- ${d.url}: ${d.reason}`).join("\n")}` : ""}`,
    )
    .join("\n\n---\n");

  return `Synthesize the following research findings into a structured JSON Research Report.

RESEARCH QUESTION: ${objectives.researchQuestion}
AUDIENCE: ${objectives.audience}
EXPECTED OUTLINE:
${objectives.reportOutline.map((s) => `- ${s}`).join("\n")}

FINDINGS:
${findingsBlock}

Return ONLY valid JSON — no markdown, no code fences, no commentary. The JSON object must have these exact fields:

{
  "title": "Report title (string)",
  "executiveSummary": "2-3 paragraph answer to the research question",
  "findingsByThread": [
    { "threadLabel": "Label", "content": "Section content with claims and numbered citations [1], [2], etc." }
  ],
  "contradictions": [
    {
      "claim": "The disputed claim",
      "sourceA": { "url": "https://...", "claim": "What source A says" },
      "sourceB": { "url": "https://...", "claim": "What source B says" },
      "resolution": "How to resolve the contradiction (or why it cannot be resolved)"
    }
  ],
  "gaps": ["Gap or unanswered question 1", "Gap 2"],
  "sourceIndex": [
    {
      "index": 1,
      "url": "https://...",
      "title": "Page title",
      "accessedAt": "ISO timestamp from claim metadata",
      "supportingQuote": "Verbatim quote from the claim"
    }
  ]
}

RULES:
1. Every factual claim MUST cite its source using the numbered index format [1], [2], etc.
2. The sourceIndex numbers must correspond to the [n] citations in the text.
3. Do not invent anything. Only use claims from the findings above.
4. Omit empty arrays entirely (contradictions, gaps) — do not include "contradictions": [] if there are none.
5. Do not use emojis.`;
}
