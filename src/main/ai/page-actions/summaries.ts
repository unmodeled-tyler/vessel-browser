import type { WebContents } from "electron";
import { extractContent } from "../../content/extractor";
import { waitForLoad } from "../../utils/webcontents-utils";
import { buildScopedContext, chooseAgentReadMode, type ExtractMode } from "../context-builder";
import { buildCompactScopedContext } from "../compact-context";
import { getGlanceExtractScript } from "../scripts/glance-extract";
import { executePageScript, logger, PAGE_SCRIPT_TIMEOUT } from "./core";

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
