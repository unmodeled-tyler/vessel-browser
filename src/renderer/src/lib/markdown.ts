import DOMPurify from "dompurify";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed, "https://example.com");
    if (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:"
    ) {
      return trimmed;
    }
  } catch {
    return null;
  }

  return null;
}

function applyInlineMarkdown(text: string): string {
  const codeSpans: string[] = [];
  let withCodeTokens = text.replace(/`([^`]+)`/g, (_, code: string) => {
    const token = `\x00CS${codeSpans.length}\x00`;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });
  let html = escapeHtml(withCodeTokens);

  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label: string, href: string) => {
      const safeHref = sanitizeUrl(href);
      const safeLabel = label.trim() || href.trim();
      if (!safeHref) {
        return escapeHtml(safeLabel);
      }
      return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noreferrer">${escapeHtml(safeLabel)}</a>`;
    },
  );

  html = html
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^\*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

  return codeSpans.reduce(
    (output, snippet, index) =>
      output.replace(`\x00CS${index}\x00`, snippet),
    html,
  );
}

function renderList(block: string, ordered: boolean): string {
  const pattern = ordered ? /^\d+\.\s+/ : /^[-*+]\s+/;
  const items = block
    .split("\n")
    .map((line) => line.replace(pattern, "").trim())
    .filter(Boolean)
    .map((item) => `<li>${applyInlineMarkdown(item)}</li>`)
    .join("");

  return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
}

function isTableBlock(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return false;
  // Need at least a header row and a separator row (|---|---|)
  const hasPipes = lines.every((l) => l.trim().includes("|"));
  const hasSeparator = lines.some((l) => /^\|?\s*[-:]+[-|\s:]*$/.test(l.trim()));
  return hasPipes && hasSeparator;
}

function renderTable(block: string): string {
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const parseRow = (line: string): string[] =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  // Find separator row to split header from body
  const sepIndex = lines.findIndex((l) =>
    /^\|?\s*[-:]+[-|\s:]*$/.test(l),
  );

  const headerRows = sepIndex > 0 ? lines.slice(0, sepIndex) : [lines[0]];
  const bodyRows = lines.slice(sepIndex + 1);

  // Parse alignment from separator
  const sepCells = sepIndex >= 0 ? parseRow(lines[sepIndex]) : [];
  const alignments = sepCells.map((cell) => {
    const trimmed = cell.replace(/\s/g, "");
    if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center";
    if (trimmed.endsWith(":")) return "right";
    return "left";
  });

  const alignAttr = (i: number): string => {
    const align = alignments[i];
    return align && align !== "left" ? ` style="text-align:${align}"` : "";
  };

  const thead = headerRows
    .map(
      (row) =>
        `<tr>${parseRow(row)
          .map((cell, i) => `<th${alignAttr(i)}>${applyInlineMarkdown(cell)}</th>`)
          .join("")}</tr>`,
    )
    .join("");

  const tbody = bodyRows
    .map(
      (row) =>
        `<tr>${parseRow(row)
          .map((cell, i) => `<td${alignAttr(i)}>${applyInlineMarkdown(cell)}</td>`)
          .join("")}</tr>`,
    )
    .join("");

  return `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

function renderBlock(block: string): string {
  const trimmed = block.trim();
  if (!trimmed) return "";

  const codeMatch = trimmed.match(/^\x00CB\d+\x00$/);
  if (codeMatch) {
    return trimmed;
  }

  const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    return `<h${level}>${applyInlineMarkdown(heading[2].trim())}</h${level}>`;
  }

  if (
    /^>\s?/m.test(trimmed) &&
    trimmed.split("\n").every((line) => /^>\s?/.test(line))
  ) {
    const content = trimmed
      .split("\n")
      .map((line) => line.replace(/^>\s?/, ""))
      .join("\n");
    return `<blockquote>${applyInlineMarkdown(content).replace(/\n/g, "<br>")}</blockquote>`;
  }

  if (trimmed === "---" || trimmed === "***") {
    return "<hr />";
  }

  if (isTableBlock(trimmed)) {
    return renderTable(trimmed);
  }

  if (trimmed.split("\n").every((line) => /^[-*+]\s+/.test(line))) {
    return renderList(trimmed, false);
  }

  if (trimmed.split("\n").every((line) => /^\d+\.\s+/.test(line))) {
    return renderList(trimmed, true);
  }

  return `<p>${applyInlineMarkdown(trimmed).replace(/\n/g, "<br>")}</p>`;
}

/** Map tool names to icons (single-char symbols) */
const TOOL_ICONS: Record<string, string> = {
  navigate: "→",
  go_back: "←",
  go_forward: "→",
  reload: "↻",
  click: "◉",
  type_text: "⌨",
  select_option: "▾",
  submit_form: "⏎",
  press_key: "⌥",
  scroll: "↕",
  hover: "◌",
  focus: "◎",
  read_page: "◫",
  search: "⌕",
  login: "🔑",
  fill_form: "⌨",
  paginate: "⟫",
  suggest: "✦",
  highlight: "🖍",
  clear_highlights: "✕",
  flow_start: "▶",
  flow_advance: "▸",
  flow_status: "◈",
  flow_end: "■",
  dismiss_popup: "✕",
  wait_for: "◴",
  create_tab: "+",
  switch_tab: "⇥",
  close_tab: "✕",
  current_tab: "◉",
  list_tabs: "≡",
  save_bookmark: "★",
  list_bookmarks: "☆",
  create_checkpoint: "⚑",
  restore_checkpoint: "⟲",
};

function renderToolChip(name: string, args: string): string {
  const icon = TOOL_ICONS[name] || "⚙";
  const displayName = name.replace(/_/g, " ");
  const argsHtml = args
    ? `<span class="tool-chip-args">${escapeHtml(args.length > 60 ? args.slice(0, 57) + "..." : args)}</span>`
    : "";
  return `<div class="tool-chip"><span class="tool-chip-icon">${icon}</span><span class="tool-chip-name">${escapeHtml(displayName)}</span>${argsHtml}</div>`;
}

export function renderMarkdown(source: string): string {
  const codeBlocks: string[] = [];
  const toolChips: string[] = [];

  const normalized = source
    .replace(/\r\n?/g, "\n")
    // Extract tool call tokens before any other processing
    .replace(
      /<<tool:([^:>\n]+)(?::([^>\n]*))?>>/g,
      (_, name: string, args: string | undefined) => {
        const token = `\x00TC${toolChips.length}\x00`;
        toolChips.push(renderToolChip(name.trim(), (args || "").trim()));
        return `\n\n${token}\n\n`;
      },
    )
    .replace(
      /```([\w-]+)?\n([\s\S]*?)```/g,
      (_, language: string | undefined, code: string) => {
        const token = `\x00CB${codeBlocks.length}\x00`;
        const langAttr = language
          ? ` data-language="${escapeHtml(language)}"`
          : "";
        codeBlocks.push(
          `<pre><code${langAttr}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`,
        );
        return token;
      },
    );

  const rendered = normalized
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      // Tool chip tokens pass through as-is
      if (/^\x00TC\d+\x00$/.test(trimmed)) return trimmed;
      return renderBlock(block);
    })
    .filter(Boolean)
    .join("");

  let output = rendered;
  output = codeBlocks.reduce(
    (out, snippet, index) => out.replace(`\x00CB${index}\x00`, snippet),
    output,
  );
  output = toolChips.reduce(
    (out, snippet, index) => out.replace(`\x00TC${index}\x00`, snippet),
    output,
  );

  return DOMPurify.sanitize(output, {
    ALLOWED_TAGS: [
      "a",
      "blockquote",
      "br",
      "code",
      "div",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "li",
      "ol",
      "p",
      "pre",
      "span",
      "strong",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "ul",
    ],
    ALLOWED_ATTR: ["href", "target", "rel", "data-language", "style", "class"],
  });
}
