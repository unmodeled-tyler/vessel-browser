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

  if (trimmed.split("\n").every((line) => /^[-*+]\s+/.test(line))) {
    return renderList(trimmed, false);
  }

  if (trimmed.split("\n").every((line) => /^\d+\.\s+/.test(line))) {
    return renderList(trimmed, true);
  }

  return `<p>${applyInlineMarkdown(trimmed).replace(/\n/g, "<br>")}</p>`;
}

export function renderMarkdown(source: string): string {
  const codeBlocks: string[] = [];

  const normalized = source
    .replace(/\r\n?/g, "\n")
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
    .map(renderBlock)
    .filter(Boolean)
    .join("");

  const withCodeBlocks = codeBlocks.reduce(
    (output, snippet, index) =>
      output.replace(`\x00CB${index}\x00`, snippet),
    rendered,
  );

  return DOMPurify.sanitize(withCodeBlocks, {
    ALLOWED_TAGS: [
      "a",
      "blockquote",
      "br",
      "code",
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
      "strong",
      "ul",
    ],
    ALLOWED_ATTR: ["href", "target", "rel", "data-language"],
  });
}
