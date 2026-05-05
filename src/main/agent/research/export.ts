import type { ResearchReport, SubAgentTrace } from "../../../shared/research-types";

export function renderReportAsMarkdown(
  report: ResearchReport,
  traces?: SubAgentTrace[],
): string {
  const sections: string[] = [];

  sections.push(`# ${report.title}`);
  sections.push("");
  sections.push(`*Generated: ${report.generatedAt}*`);
  sections.push("");

  sections.push("## Executive Summary");
  sections.push(report.executiveSummary);
  sections.push("");

  for (const section of report.findingsByThread) {
    sections.push(`## ${section.threadLabel}`);
    sections.push(section.content);
    sections.push("");
  }

  if (report.contradictions.length > 0) {
    sections.push("## Contradictions & Discrepancies");
    for (const c of report.contradictions) {
      sections.push(`- **Claim:** ${c.claim}`);
      sections.push(`  - Source A: [${c.sourceA.url}](${c.sourceA.url}) — "${c.sourceA.claim}"`);
      sections.push(`  - Source B: [${c.sourceB.url}](${c.sourceB.url}) — "${c.sourceB.claim}"`);
      sections.push(`  - **Resolution:** ${c.resolution}`);
    }
    sections.push("");
  }

  if (report.gaps.length > 0) {
    sections.push("## Gaps & Unanswered Questions");
    for (const gap of report.gaps) {
      sections.push(`- ${gap}`);
    }
    sections.push("");
  }

  sections.push("## Source Index");
  for (const source of report.sourceIndex) {
    sections.push(
      `${source.index}. [${source.title}](${source.url}) — accessed ${source.accessedAt}`,
    );
    sections.push(`   > "${source.supportingQuote}"`);
  }
  sections.push("");

  if (traces && traces.length > 0) {
    sections.push("---");
    sections.push("");
    sections.push("## Appendix: Agent Traces");
    for (const trace of traces) {
      sections.push(`### ${trace.threadLabel}`);
      sections.push(`Started: ${trace.startedAt} | Finished: ${trace.finishedAt}`);
      sections.push(`Tool calls: ${trace.toolCalls.length}`);
      if (trace.errors.length > 0) {
        sections.push(`Errors: ${trace.errors.length}`);
        for (const err of trace.errors) {
          sections.push(`- [${err.timestamp}] ${err.message}`);
        }
      }
      sections.push("");
    }
  }

  return sections.join("\n");
}
