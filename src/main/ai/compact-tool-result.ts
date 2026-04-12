function normalizeWhitespace(text: string): string {
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function limitText(text: string, maxLines: number, maxChars: number): string {
  const normalized = normalizeWhitespace(text);
  const lines = normalized.split("\n");
  const trimmedLines = lines.slice(0, maxLines);
  let limited = trimmedLines.join("\n");
  if (limited.length > maxChars) {
    limited = `${limited.slice(0, maxChars - 1)}…`;
  } else if (lines.length > maxLines) {
    limited += "\n…";
  }
  return limited;
}

function extractSection(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(`${escaped}\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`),
  );
  if (!match) return null;
  return `${heading}\n${match[1].trim()}`;
}

function compactReadPageResult(text: string): string {
  const cleaned = normalizeWhitespace(
    text.replace(
      /\n+Need more detail\? Escalate with read_page\(mode="debug"\) only if the narrow modes are insufficient\.\s*$/s,
      "",
    ),
  );
  const readHeader = cleaned.match(/^\[read_page mode=[^\]]+\]/m)?.[0];

  // Purchase/control sections are mandatory — they must always survive
  // truncation because missing "Add to Cart" breaks shopping flows.
  const mandatoryHeadings = [
    "### Action Status",
    "### Visible Purchase Controls",
    "### Offscreen Purchase Actions",
  ];
  const optionalHeadings = [
    "### Access Warnings",
    "### Immediate Blockers",
    "### Likely Search Results",
    "### Primary Results",
    "### Form Fields",
    "### Visible Controls",
    "### Top Headings",
    "### Text Snapshot",
  ];

  const mandatorySections = mandatoryHeadings
    .map((heading) => extractSection(cleaned, heading))
    .filter((value): value is string => Boolean(value));
  const optionalSections = optionalHeadings
    .map((heading) => extractSection(cleaned, heading))
    .filter((value): value is string => Boolean(value));

  const allSections = [...mandatorySections, ...optionalSections];
  if (allSections.length === 0) {
    return limitText(cleaned, 22, 1800);
  }

  const metaLines = cleaned
    .split("\n")
    .filter((line) => /^\*\*(URL|Title|Page Type|Mode|Author):\*\*/.test(line))
    .slice(0, 5);

  // Mandatory sections always included; add optional ones up to 5 total
  const maxOptional = Math.max(0, 5 - mandatorySections.length);
  const keptSections = [
    ...mandatorySections,
    ...optionalSections.slice(0, maxOptional),
  ];

  return [
    readHeader,
    metaLines.join("\n"),
    keptSections.join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function compactSearchLikeResult(text: string): string {
  const cleaned = normalizeWhitespace(text);
  const marker = "\nSearch results snapshot:\n";
  const markerIndex = cleaned.indexOf(marker);
  if (markerIndex === -1) {
    return limitText(cleaned, 16, 1400);
  }

  const summary = cleaned.slice(0, markerIndex).trim();
  const snapshot = cleaned.slice(markerIndex + marker.length).trim();
  return [summary, compactReadPageResult(snapshot)].filter(Boolean).join("\n\n");
}

function compactCurrentTabResult(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      title?: string;
      url?: string;
      isLoading?: boolean;
      canGoBack?: boolean;
      canGoForward?: boolean;
    };
    if (!parsed || typeof parsed !== "object") return limitText(text, 8, 500);
    return [
      `Current tab: ${parsed.title || "(untitled)"}`,
      parsed.url ? `URL: ${parsed.url}` : "",
      `State: loading=${parsed.isLoading ? "yes" : "no"}, back=${parsed.canGoBack ? "yes" : "no"}, forward=${parsed.canGoForward ? "yes" : "no"}`,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return limitText(text, 8, 500);
  }
}

function looksLikeRichToolResult(text: string): boolean {
  return text.startsWith("{") && text.includes('"__richResult":true');
}

export function formatCompactToolResult(name: string, result: string): string {
  if (!result || looksLikeRichToolResult(result)) return result;

  switch (name) {
    case "current_tab":
      return compactCurrentTabResult(result);
    case "read_page":
      return compactReadPageResult(result);
    case "search":
    case "navigate":
    case "go_back":
    case "go_forward":
    case "paginate":
    case "wait_for_navigation":
      return compactSearchLikeResult(result);
    case "list_tabs":
      return limitText(result, 10, 900);
    default:
      return limitText(result, 18, 1400);
  }
}
