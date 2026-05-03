export interface DisplayDiffSummaryPart {
  section?: string;
  text: string;
}

const SECTION_LABELS: Record<string, string> = {
  content: "Content",
  headings: "Headings",
  title: "Title",
};

export function cleanDiffSummaryText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, (match) =>
      match.replace(/```[a-z]*\n?/gi, "").replace(/```/g, ""),
    )
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatDiffSectionLabel(section: string): string {
  const normalized = section.trim().toLowerCase();
  return SECTION_LABELS[normalized] ?? section.trim();
}

export function parseDiffSummaryParts(summary: string): DisplayDiffSummaryPart[] {
  return summary
    .split(/\s+\|\s+/)
    .map((part) => {
      const match = part.match(/^([a-z]+):\s*(.+)$/i);
      if (!match) {
        return { text: cleanDiffSummaryText(part) };
      }

      return {
        section: formatDiffSectionLabel(match[1]),
        text: cleanDiffSummaryText(match[2]),
      };
    })
    .filter((part) => part.text.length > 0);
}
