import type { WebContents } from "electron";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { extractContent } from "../../content/extractor";
import { waitForLoad } from "../../utils/webcontents-utils";
import { assertSafeURL } from "../../network/url-safety";
import { buildScopedContext, chooseAgentReadMode, type ExtractMode } from "../context-builder";
import { buildCompactScopedContext } from "../compact-context";
import { getGlanceExtractScript } from "../scripts/glance-extract";
import { executePageScript, logger, PAGE_SCRIPT_TIMEOUT } from "./core";

interface FastArticleTextResult {
  title: string;
  url: string;
  headings: string[];
  text: string;
}

function cleanArticleText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/(\n\s*){3,}/g, "\n\n")
    .trim();
}

function articleTextResultToOutput(
  result: FastArticleTextResult,
  mode: "summary" | "text_only",
  source: string,
  elapsedMs: number,
): string {
  const sections = [
    `# ${result.title || "(untitled)"}`,
    `URL: ${result.url}`,
    "",
    `[read_page mode=${mode} — ${source}, ${elapsedMs}ms]`,
  ];

  if (result.headings.length > 0) {
    sections.push("", "## Headings", ...result.headings);
  }

  sections.push("", "## Article Text", "", result.text);
  return sections.join("\n");
}

/**
 * Ultra-fast viewport scan — shows what a human would see on the screen.
 */
export async function glanceExtract(wc: WebContents): Promise<string> {
  const startMs = Date.now();
  const result = await executePageScript<{
    title: string;
    url: string;
    headings: string[];
    links: Array<{ text: string; href?: string; index: number }>;
    buttons: Array<{ text: string; index: number }>;
    inputs: Array<{ type: string; label: string; placeholder: string; index: number }>;
    contentSnippet: string;
    viewportHeight: number;
    viewportWidth: number;
    scrollY: number;
  } | null>(wc, getGlanceExtractScript(), { timeoutMs: 2500, label: "glance-extract" });

  const elapsed = Date.now() - startMs;

  if (!result || result === PAGE_SCRIPT_TIMEOUT) {
    return [
      `# ${wc.getTitle() || "(untitled)"}`,
      `URL: ${wc.getURL()}`,
      "",
      "[read_page mode=glance — page JS thread is completely blocked, no content available]",
      "[Try: click or type_text to interact directly, or wait a few seconds and retry]",
    ].join("\n");
  }

  const sections: string[] = [
    `# ${result.title}`,
    `URL: ${result.url}`,
    `Viewport: ${result.viewportWidth}×${result.viewportHeight} scrollY=${result.scrollY}`,
    `[read_page mode=glance — ${elapsed}ms, showing what's visible on screen]`,
  ];

  if (result.headings.length > 0) {
    sections.push("", "## Headings", ...result.headings);
  }
  if (result.inputs.length > 0) {
    sections.push("", "## Input Fields");
    for (const inp of result.inputs) {
      const desc = inp.label || inp.placeholder || inp.type;
      sections.push(`  [#${inp.index}] ${inp.type}: ${desc}`);
    }
  }
  if (result.buttons.length > 0) {
    sections.push("", "## Buttons");
    for (const btn of result.buttons) {
      sections.push(`  [#${btn.index}] ${btn.text}`);
    }
  }
  if (result.links.length > 0) {
    sections.push("", "## Visible Links");
    for (const link of result.links) {
      sections.push(`  [#${link.index}] ${link.text}`);
    }
  }
  if (result.contentSnippet) {
    const truncated =
      result.contentSnippet.length > 6000
        ? result.contentSnippet.slice(0, 6000) + "\n[truncated]"
        : result.contentSnippet;
    sections.push("", "## Page Content (viewport)", "", truncated);
  }

  return sections.join("\n");
}

export async function fastArticleTextExtract(
  wc: WebContents,
  mode: "summary" | "text_only",
): Promise<string | null> {
  const startMs = Date.now();
  const result = await executePageScript<FastArticleTextResult | null>(
    wc,
    `(function() {
      function clean(value) {
        return String(value || '').replace(/[ \\t]+/g, ' ').replace(/(\\n\\s*){3,}/g, '\\n\\n').trim();
      }

      var rootSelectors = [
        '#mw-content-text .mw-parser-output',
        '#mw-content-text',
        'main article',
        'article',
        'main',
        '[role="main"]',
        '#content'
      ];
      var root = null;
      for (var i = 0; i < rootSelectors.length; i++) {
        var candidate = document.querySelector(rootSelectors[i]);
        if (candidate && clean(candidate.textContent).length > 300) {
          root = candidate;
          break;
        }
      }
      if (!root) return null;

      var unwantedSelector = [
        'script',
        'style',
        'noscript',
        'nav',
        'header',
        'footer',
        'aside',
        '.mw-editsection',
        '.reference',
        '.reflist',
        '.navbox',
        '.infobox',
        '.metadata',
        '.ambox',
        '.toc',
        '#toc'
      ].join(',');

      var headings = [];
      var parts = [];
      var nodes = root.querySelectorAll('h1, h2, h3, p, li');
      for (var j = 0; j < nodes.length && parts.length < 180; j++) {
        var node = nodes[j];
        if (node.closest && node.closest(unwantedSelector)) continue;
        var tag = String(node.tagName || '').toLowerCase();
        var text = clean(node.textContent);
        if (!text) continue;
        if (/^h[1-3]$/.test(tag)) {
          if (text.length < 180) headings.push(tag + ': ' + text);
          parts.push('\\n## ' + text);
          continue;
        }
        if (text.length < 40) continue;
        parts.push(text);
      }

      var articleText = clean(parts.join('\\n\\n'));
      if (articleText.length < 300) {
        articleText = clean(root.textContent).slice(0, 12000);
      }
      if (articleText.length < 300) return null;

      return {
        title: document.title || '',
        url: location.href,
        headings: headings.slice(0, 18),
        text: articleText.slice(0, ${mode === "summary" ? 9000 : 14000}),
      };
    })()`,
    {
      timeoutMs: 1800,
      label: "fast article text",
    },
  );

  if (!result || result === PAGE_SCRIPT_TIMEOUT || !result.text.trim()) {
    return null;
  }

  return articleTextResultToOutput(
    {
      title: result.title || wc.getTitle() || "(untitled)",
      url: result.url || wc.getURL(),
      headings: result.headings,
      text: result.text,
    },
    mode,
    "fast article text",
    Date.now() - startMs,
  );
}

export async function fetchArticleTextExtract(
  wc: WebContents,
  mode: "summary" | "text_only",
): Promise<string | null> {
  const startMs = Date.now();
  const url = wc.getURL();
  try {
    assertSafeURL(url);
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "VesselBrowser/0.1 read-page-fallback",
      },
    });
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") || "0");
    if (contentLength > 5_000_000) return null;

    const html = await response.text();
    if (html.trim().length < 300) return null;

    const { document } = parseHTML(html);
    const readable = new Readability(document as unknown as Document, {
      charThreshold: 300,
    }).parse();

    const title =
      cleanArticleText(readable?.title || document.title || wc.getTitle()) ||
      wc.getTitle() ||
      "(untitled)";
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((node) => {
        const tag = String(node.tagName || "").toLowerCase();
        const text = cleanArticleText(node.textContent || "");
        return text.length > 0 && text.length < 180 ? `${tag}: ${text}` : "";
      })
      .filter(Boolean)
      .slice(0, 18);

    const fallbackRoot =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.body;
    const text = cleanArticleText(
      readable?.textContent || fallbackRoot?.textContent || "",
    );
    if (text.length < 300) return null;

    return articleTextResultToOutput(
      {
        title,
        url,
        headings,
        text: text.slice(0, mode === "summary" ? 9000 : 14000),
      },
      mode,
      "network article fallback",
      Date.now() - startMs,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.warn("Network article fallback timed out:", url);
    } else {
      logger.warn("Network article fallback failed:", err);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeReadPageMode(
  mode: unknown,
  pageContent?: Awaited<ReturnType<typeof extractContent>>,
): ExtractMode | "debug" {
  if (typeof mode === "string") {
    const normalized = mode.trim().toLowerCase();
    if (normalized === "debug") return "debug";
    if (normalized === "glance") return "glance";
    if (
      normalized === "full" ||
      normalized === "summary" ||
      normalized === "interactives_only" ||
      normalized === "forms_only" ||
      normalized === "text_only" ||
      normalized === "visible_only" ||
      normalized === "results_only"
    ) {
      return normalized;
    }
  }
  return pageContent ? chooseAgentReadMode(pageContent) : "visible_only";
}

/**
 * Grab the page title and do a fast overlay probe.
 */
export async function getPostNavSummary(wc: WebContents): Promise<string> {
  const title = wc.getTitle();
  const titleLine = title ? `\nPage title: ${title}` : "";

  const overlaySignal = await executePageScript<string | null>(
    wc,
    `(function() {
      var signals = [];
      var bodyStyle = window.getComputedStyle(document.body);
      var htmlStyle = window.getComputedStyle(document.documentElement);
      if (bodyStyle.overflow === 'hidden' || htmlStyle.overflow === 'hidden') {
        signals.push('body-scroll-locked');
      }
      var consentSelectors = [
        '#onetrust-consent-sdk', '#CybotCookiebotDialog', '[class*="consent-banner"]',
        '[class*="cookie-banner"]', '[class*="privacy-banner"]', '[id*="consent"]',
        '[class*="gdpr"]', '[data-testid*="consent"]', '[data-testid*="cookie"]',
        '.fc-consent-root', '#sp_message_container_', '[id*="trustarc"]',
        '[class*="cmp-"]', '[id*="cmp-"]'
      ];
      for (var i = 0; i < consentSelectors.length; i++) {
        try {
          var el = document.querySelector(consentSelectors[i]);
          if (el && el.offsetHeight > 50) {
            signals.push('consent-banner:' + consentSelectors[i]);
            break;
          }
        } catch {
          // Swallow — cross-origin frames may block selector access
        }
      }
      var vw = window.innerWidth || 0;
      var vh = window.innerHeight || 0;
      var vpArea = Math.max(1, vw * vh);
      var els = document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]');
      if (els.length > 0) signals.push('dialog-open');
      if (signals.length === 0) {
        var fixed = document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]');
        for (var j = 0; j < fixed.length && j < 20; j++) {
          var r = fixed[j].getBoundingClientRect();
          if ((r.width * r.height) / vpArea > 0.3) {
            signals.push('large-fixed-overlay');
            break;
          }
        }
      }
      return signals.length > 0 ? signals.join(', ') : null;
    })()`,
    { timeoutMs: 1500, label: "overlay-probe" },
  );

  if (overlaySignal && overlaySignal !== PAGE_SCRIPT_TIMEOUT) {
    return `${titleLine}\nWARNING: Blocking overlay detected (${overlaySignal}). Call clear_overlays or accept_cookies before reading the page.`;
  }
  return titleLine;
}

export async function getPostSearchSummary(wc: WebContents): Promise<string> {
  await waitForLoad(wc, 2000);
  try {
    const content = await Promise.race([
      extractContent(wc),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    if (content && content.content.length > 0) {
      const scoped = buildScopedContext(content, "results_only");
      const truncated =
        scoped.length > 2600
          ? `${scoped.slice(0, 2600)}\n[Search results snapshot truncated...]`
          : scoped;
      return `\nSearch results snapshot:\n${truncated}`;
    }
  } catch (err) {
    logger.warn("Failed to build post-search summary, falling back to nav summary:", err);
  }
  const fallback = await getPostNavSummary(wc);
  return fallback
    ? `${fallback}\nSearch results snapshot unavailable. Use read_page(mode="results_only") if needed.`
    : `\nSearch results snapshot unavailable. Use read_page(mode="results_only") if needed.`;
}

export async function getPostClickNavSummary(
  wc: WebContents,
  toolProfile: string,
): Promise<string> {
  try {
    const content = await Promise.race([
      extractContent(wc),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (content && content.content.length > 0) {
      const scoped =
        toolProfile === "compact"
          ? buildCompactScopedContext(content, "visible_only")
          : buildScopedContext(content, "visible_only");
      const maxLen = toolProfile === "compact" ? 1800 : 3000;
      const truncated =
        scoped.length > maxLen
          ? `${scoped.slice(0, maxLen)}\n[Page snapshot truncated. Use read_page for full details.]`
          : scoped;
      return `\nPage snapshot after navigation:\n${truncated}`;
    }
  } catch (err) {
    logger.warn("Failed to build post-click navigation summary:", err);
  }
  return "";
}
