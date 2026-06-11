import type { WebContents } from "electron";
import type { AgentCheckpoint } from "../../shared/types";
import { selectorHelpersJS } from "../../shared/dom/selector-helpers-js";
import { resolveBookmarkSourceDraft } from "../bookmarks/page-source";
import * as bookmarkManager from "../bookmarks/manager";
import { extractContent } from "../content/extractor";
import * as highlightsManager from "../highlights/manager";
import { highlightOnPage, clearHighlights } from "../highlights/inject";
import {
  captureLiveHighlightSnapshot,
  formatLiveSelectionSection,
} from "../highlights/live-snapshot";

import {
  sleep,
  waitForLoad,
} from "../utils/webcontents-utils";
import { resolveSelector } from "../utils/selector-resolver";
import {
  formatDeadLinkMessage,
  validateLinkDestination,
} from "../network/link-validation";
import { captureScreenshot } from "../content/screenshot";
import { makeImageResult } from "./tool-result";
import { normalizeToolAlias } from "./tool-aliases";
import {
  isRedundantNavigateTarget,
  looksLikeCurrentSiteNameQuery,
  shouldBlockOffGoalDomainNavigation,
} from "./tool-guardrails";
import { isToolGated } from "../premium/manager";
import { trackToolCall } from "../telemetry/posthog";
import * as namedSessionManager from "../sessions/manager";
import type { TabManager } from "../tabs/tab-manager";
import {
  coerceOptionalNumber,
  coerceStringArray,
  normalizeLooseString,
} from "../tools/input-coercion";
import { TOOL_DEFINITIONS } from "../tools/definitions";
import {
  buildScopedContext,
  buildStructuredContext,
} from "./context-builder";
import {
  isInvalidTextTargetQuery,
  resolveTextTargetInDocument,
  type TextTargetMode,
} from "./text-target-resolver";
import { chooseCompactReadMode } from "./compact-listing";
import { buildCompactScopedContext } from "./compact-context";
import { MAX_AGENT_DEBUG_CONTENT_LENGTH } from "./content-limits";
import { formatCompactToolResult } from "./compact-tool-result";
import { normalizeBookmarkMetadata } from "../bookmarks/metadata";
import {
  clearCartClickState,
  getCartAddedSummary,
  hasRecentCartClick,
  isAddToCartText,
  isDuplicateCartClick,
  isProductAlreadyInCart,
  recordCartClick,
} from "./cart-click-state";
import {
  TabMutex,
  PAGE_SCRIPT_TIMEOUT,
  pageBusyError,
  executePageScript,
  loadPermittedUrl,
  waitForPotentialNavigation,
  logger,
  type ActionContext,
  type FillFormFieldInput,
  type FillFormFieldResult,
} from "./page-actions/core";
import {
  fastArticleTextExtract,
  fetchArticleTextExtract,
  glanceExtract,
  normalizeReadPageMode,
  getPostNavSummary,
  getPostSearchSummary,
  getPostClickNavSummary,
} from "./page-actions/summaries";
import {
  fillFormFields,
  focusElement,
  hoverElement,
  pressKey,
  pressKeyDirect,
  selectOption,
  selectOptionDirect,
  setElementValue,
  submitForm,
  submitFormBySelector,
  submitFormDirect,
  typeKeystroke,
  waitForCondition,
  waitForConditionDirect,
} from "./page-actions/interaction";
import {
  buildCartSuccessSuffix,
  clearOverlaysWithHandlers,
  detectPostClickOverlay,
  dismissPopupWithClick,
  getCartDialogActions,
} from "./page-actions/overlays";

export { TabMutex };
export type { ActionContext, FillFormFieldInput, FillFormFieldResult };
export { PAGE_SCRIPT_TIMEOUT } from "./page-actions/core";

export function getBookmarkMetadataFromArgs(args: Record<string, unknown>) {
  return normalizeBookmarkMetadata({
    intent: args.intent ?? args.intent,
    expectedContent: args.expectedContent ?? args.expected_content,
    keyFields: args.keyFields ?? args.key_fields,
    agentHints: args.agentHints ?? args.agent_hints,
  });
}

export async function scrollPage(
  wc: WebContents,
  deltaY: number,
): Promise<{
  beforeY: number;
  afterY: number;
  movedY: number;
}> {
  const getScrollY = async () => {
    const scrollY = await executePageScript<number>(
      wc,
      `
      (function() {
        return Math.max(
          window.scrollY || 0,
          window.pageYOffset || 0,
          document.scrollingElement?.scrollTop || 0,
          document.documentElement?.scrollTop || 0,
          document.body?.scrollTop || 0,
        );
      })()
    `,
      {
        label: "read scroll position",
      },
    );
    return typeof scrollY === "number" ? scrollY : 0;
  };

  const beforeY = await getScrollY();
  const scrolled = await executePageScript(
    wc,
    `window.scrollBy(0, ${deltaY})`,
    {
      label: "scroll page",
    },
  );
  if (scrolled === PAGE_SCRIPT_TIMEOUT) {
    return {
      beforeY,
      afterY: beforeY,
      movedY: 0,
    };
  }
  await sleep(100);
  const afterY = await getScrollY();
  return {
    beforeY,
    afterY,
    movedY: Math.round(afterY - beforeY),
  };
}

async function clickElement(
  wc: WebContents,
  selector: string,
): Promise<string> {
  const target = await executePageScript<{
    x: number;
    y: number;
    obstructed: boolean;
    hiddenWindow: boolean;
    error?: string;
  }>(
    wc,
    `
    (async function() {
      function matchesTarget(candidate, el) {
        return !!candidate && (candidate === el || el.contains(candidate) || candidate.contains(el));
      }

      function samplePoints(rect) {
        const width = window.innerWidth || document.documentElement?.clientWidth || 0;
        const height = window.innerHeight || document.documentElement?.clientHeight || 0;
        const insetX = Math.min(12, rect.width / 4);
        const insetY = Math.min(12, rect.height / 4);
        const raw = [
          [rect.left + rect.width / 2, rect.top + rect.height / 2],
          [rect.left + insetX, rect.top + insetY],
          [rect.right - insetX, rect.top + insetY],
          [rect.left + insetX, rect.bottom - insetY],
          [rect.right - insetX, rect.bottom - insetY],
        ];
        return raw.map(([x, y]) => ({
          x: Math.min(Math.max(1, x), Math.max(1, width - 1)),
          y: Math.min(Math.max(1, y), Math.max(1, height - 1)),
        }));
      }

      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh." };

      if (el instanceof HTMLElement) {
        el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      }

      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve(undefined);
        };
        if (
          typeof requestAnimationFrame === "function" &&
          document.visibilityState === "visible"
        ) {
          requestAnimationFrame(() => finish());
        }
        setTimeout(finish, 32);
      });

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return { error: "Error[hidden]: Element has no visible area. It may be inside a collapsed, lazy-loaded, or virtual-scroll section. Scroll toward it (scroll or scroll_to_element) then call read_page to refresh visible elements before clicking again." };
      }

      const points = samplePoints(rect);
      const hit = points.find((point) => matchesTarget(document.elementFromPoint(point.x, point.y), el));
      const chosen = hit || points[0];
      const top = document.elementFromPoint(chosen.x, chosen.y);

      return {
        x: Math.round(chosen.x),
        y: Math.round(chosen.y),
        obstructed: !matchesTarget(top, el),
        hiddenWindow: document.visibilityState !== "visible",
      };
    })()
  `,
    {
      timeoutMs: 2000,
      label: "resolve click target",
    },
  );

  if (target === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("click");
  }

  if (!target || typeof target !== "object") {
    return "Error: Could not resolve click target";
  }
  if ("error" in target && typeof target.error === "string") {
    return `Error: ${target.error}`;
  }

  const x = typeof target.x === "number" ? target.x : null;
  const y = typeof target.y === "number" ? target.y : null;
  const hiddenWindow = target.hiddenWindow === true;
  if (x == null || y == null) {
    return "Error: Could not resolve click coordinates";
  }

  if (hiddenWindow) {
    const activationResult = await activateElement(wc, selector);
    if (activationResult.startsWith("Error:")) {
      return activationResult;
    }
    await sleep(80);
    return "Clicked via DOM activation";
  }

  wc.sendInputEvent({ type: "mouseMove", x, y });
  await sleep(16);
  wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  await sleep(24);
  wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  await sleep(80);

  return target.obstructed
    ? "Clicked via pointer events (target may be partially obstructed)"
    : "Clicked via pointer events";
}

async function activateElement(
  wc: WebContents,
  selector: string,
): Promise<string> {
  const activated = await executePageScript<{ ok?: boolean; error?: string }>(
    wc,
    `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "Element not found" };
      if (el instanceof HTMLElement) {
        el.focus({ preventScroll: true });
      }
      if (typeof el.click === "function") {
        el.click();
        return { ok: true };
      }
      return { error: "Element is not clickable" };
    })()
  `,
    {
      label: "activate element",
    },
  );

  if (activated === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("activate");
  }

  if (!activated || typeof activated !== "object") {
    return "Error: Could not activate element";
  }
  if ("error" in activated && typeof activated.error === "string") {
    return `Error: ${activated.error}`;
  }

  return "Activated element via DOM click";
}

async function describeElementForClick(
  wc: WebContents,
  selector: string,
): Promise<
  { text: string; href?: string; target?: string; tag?: string; isInteractive?: boolean } | { error: string }
> {
  const result = await executePageScript<{
    text?: string;
    href?: string;
    target?: string;
    tag?: string;
    isInteractive?: boolean;
    error?: string;
  }>(
    wc,
    `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "Element not found" };
      const anchor = el instanceof HTMLAnchorElement ? el : el.closest("a[href]");
      const text = (el.textContent || el.tagName || "Element").trim().slice(0, 100);
      const tag = el.tagName.toLowerCase();
      const interactiveTags = new Set(["a","button","input","select","textarea","summary","details","option"]);
      const hasRole = el.getAttribute("role") === "button" || el.getAttribute("role") === "link" || el.getAttribute("role") === "tab";
      const hasClickListener = el.onclick != null || el.getAttribute("onclick") != null;
      const isInteractive = interactiveTags.has(tag) || hasRole || hasClickListener || !!anchor;
      return {
        text: text || "Element",
        href: anchor instanceof HTMLAnchorElement ? anchor.href : undefined,
        target: anchor instanceof HTMLAnchorElement ? (anchor.getAttribute("target") || "") : undefined,
        tag,
        isInteractive,
      };
    })()
  `,
    {
      label: "describe element",
    },
  );

  if (result === PAGE_SCRIPT_TIMEOUT) {
    return { error: "Page is still busy" };
  }

  if (!result || typeof result !== "object") {
    return { error: "Element not found" };
  }
  if ("error" in result && typeof result.error === "string") {
    return { error: result.error };
  }

  return {
    text:
      "text" in result && typeof result.text === "string"
        ? result.text
        : "Element",
    href:
      "href" in result && typeof result.href === "string"
        ? result.href
        : undefined,
    target:
      "target" in result && typeof result.target === "string"
        ? result.target
        : undefined,
    tag:
      "tag" in result && typeof result.tag === "string"
        ? result.tag
        : undefined,
    isInteractive:
      "isInteractive" in result && typeof result.isInteractive === "boolean"
        ? result.isInteractive
        : undefined,
  };
}

async function inspectElement(
  wc: WebContents,
  selector: string,
  limit = 8,
): Promise<string> {
  const result = await executePageScript<{
    target?: {
      label: string;
      tag: string;
      text?: string;
      href?: string;
      value?: string;
    };
    region?: {
      tag: string;
      label: string;
      text?: string;
    };
    nearby?: Array<{
      index?: number;
      label: string;
      type: string;
      selector: string;
      href?: string;
    }>;
    purchaseActions?: Array<{
      index?: number;
      label: string;
      type: string;
      selector: string;
      href?: string;
      source: "nearby" | "page";
    }>;
    error?: string;
  }>(
    wc,
    `
    (function() {
      function text(value) {
        const trimmed = value == null ? "" : String(value).trim();
        return trimmed || undefined;
      }

      ${selectorHelpersJS(["data-testid", "name", "form", "aria-label", "title"])}

      function isVisible(el) {
        if (!(el instanceof HTMLElement)) return true;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function labelFor(el) {
        return text(
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.getAttribute("name") ||
          el.getAttribute("placeholder") ||
          el.textContent ||
          el.getAttribute("value") ||
          el.tagName
        ) || "element";
      }

      function purchasePriority(label, href) {
        const haystack = ((label || "") + " " + (href || ""))
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
        if (!haystack) return null;
        if (/\badd(?: item)? to (?:cart|bag|basket)\b/.test(haystack)) return 0;
        if (/\b(?:buy now|preorder|pre-order|reserve now|shop now)\b/.test(haystack)) return 1;
        if (/\b(?:checkout|view cart|view basket|go to cart|view bag)\b/.test(haystack)) return 2;
        return null;
      }

      function chooseRegion(target) {
        const preferred = target.closest(
          "[data-testid], article, [role='article'], [role='listitem'], li, tr, form, section, aside, dialog, [role='dialog']"
        );
        if (preferred) return preferred;
        let current = target.parentElement;
        let depth = 0;
        while (current && depth < 5) {
          const count = current.querySelectorAll("a[href], button, input, select, textarea").length;
          if (count >= 2 && count <= 16) return current;
          current = current.parentElement;
          depth += 1;
        }
        return target.parentElement || target;
      }

      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return { error: "Element not found" };
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      }

      const region = chooseRegion(target);
      const nearby = [];
      const seen = new Set();
      const purchaseActions = [];
      const purchaseSeen = new Set();
      region.querySelectorAll("a[href], button, input:not([type='hidden']), select, textarea").forEach((el) => {
        if (!(el instanceof HTMLElement) || !isVisible(el)) return;
        const candidateSelector = selectorFor(el);
        if (!candidateSelector || seen.has(candidateSelector)) return;
        seen.add(candidateSelector);
        const candidateLabel = labelFor(el).slice(0, 100);
        const candidateHref = el instanceof HTMLAnchorElement ? text(el.href) : undefined;
        nearby.push({
          index: typeof window.__vessel?.getElementIndexBySelector === "function"
            ? window.__vessel.getElementIndexBySelector(candidateSelector) ?? undefined
            : undefined,
          label: candidateLabel,
          type: el.tagName.toLowerCase(),
          selector: candidateSelector,
          href: candidateHref,
        });
        const purchaseRank = purchasePriority(candidateLabel, candidateHref);
        if (purchaseRank !== null && !purchaseSeen.has(candidateSelector)) {
          purchaseSeen.add(candidateSelector);
          purchaseActions.push({
            index: typeof window.__vessel?.getElementIndexBySelector === "function"
              ? window.__vessel.getElementIndexBySelector(candidateSelector) ?? undefined
              : undefined,
            label: candidateLabel,
            type: el.tagName.toLowerCase(),
            selector: candidateSelector,
            href: candidateHref,
            source: "nearby",
            rank: purchaseRank,
          });
        }
      });

      document.querySelectorAll("button, a[href], input[type='submit'], input[type='button']").forEach((el) => {
        if (!(el instanceof HTMLElement) || !isVisible(el)) return;
        const candidateSelector = selectorFor(el);
        if (!candidateSelector || purchaseSeen.has(candidateSelector)) return;
        const candidateLabel = labelFor(el).slice(0, 100);
        const candidateHref = el instanceof HTMLAnchorElement ? text(el.href) : undefined;
        const purchaseRank = purchasePriority(candidateLabel, candidateHref);
        if (purchaseRank === null) return;
        purchaseSeen.add(candidateSelector);
        purchaseActions.push({
          index: typeof window.__vessel?.getElementIndexBySelector === "function"
            ? window.__vessel.getElementIndexBySelector(candidateSelector) ?? undefined
            : undefined,
          label: candidateLabel,
          type: el.tagName.toLowerCase(),
          selector: candidateSelector,
          href: candidateHref,
          source: "page",
          rank: purchaseRank,
        });
      });

      purchaseActions.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (a.source !== b.source) return a.source === "nearby" ? -1 : 1;
        return a.label.localeCompare(b.label);
      });

      return {
        target: {
          label: labelFor(target).slice(0, 120),
          tag: target.tagName.toLowerCase(),
          text: text(target.textContent)?.slice(0, 240),
          href: target instanceof HTMLAnchorElement ? text(target.href) : undefined,
          value: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
            ? text(target.value)?.slice(0, 120)
            : undefined,
        },
        region: {
          tag: region.tagName.toLowerCase(),
          label: labelFor(region).slice(0, 120),
          text: text(region.textContent)?.slice(0, 400),
        },
        nearby: nearby.slice(0, ${Math.max(1, Math.min(20, limit))}),
        purchaseActions: purchaseActions.slice(0, 8).map((item) => ({
          index: item.index,
          label: item.label,
          type: item.type,
          selector: item.selector,
          href: item.href,
          source: item.source,
        })),
      };
    })()
  `,
    {
      timeoutMs: 2000,
      label: "inspect element",
    },
  );

  if (result === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("inspect_element");
  }
  if (!result || typeof result !== "object") {
    return "Error: Could not inspect element";
  }
  if ("error" in result && typeof result.error === "string") {
    return `Error: ${result.error}`;
  }

  const lines: string[] = [];
  if (result.target) {
    lines.push(`Target: ${result.target.label} <${result.target.tag}>`);
    if (result.target.text) lines.push(`Target text: ${result.target.text}`);
    if (result.target.href) lines.push(`Target href: ${result.target.href}`);
    if (result.target.value) lines.push(`Target value: ${result.target.value}`);
  }
  if (result.region) {
    lines.push(`Region: ${result.region.label} <${result.region.tag}>`);
    if (result.region.text) lines.push(`Region text: ${result.region.text}`);
  }
  if (Array.isArray(result.nearby) && result.nearby.length > 0) {
    lines.push("Nearby controls:");
    for (const item of result.nearby) {
      const hrefSuffix = item.href ? ` -> ${item.href}` : "";
      const indexPrefix =
        typeof item.index === "number" ? `[#${item.index}] ` : "";
      lines.push(
        `- ${indexPrefix}${item.label} [${item.type}] selector=${item.selector}${hrefSuffix}`,
      );
    }
  }
  if (Array.isArray(result.purchaseActions) && result.purchaseActions.length > 0) {
    lines.push("Likely purchase actions:");
    for (const item of result.purchaseActions) {
      const hrefSuffix = item.href ? ` -> ${item.href}` : "";
      const sourceSuffix =
        item.source === "nearby" ? " (same region)" : " (elsewhere on page)";
      const indexPrefix =
        typeof item.index === "number" ? `[#${item.index}] ` : "";
      lines.push(
        `- ${indexPrefix}${item.label} [${item.type}] selector=${item.selector}${hrefSuffix}${sourceSuffix}`,
      );
    }
    lines.push(
      "When an index is available, prefer click(index=N) over selector-based clicks because it is more stable.",
    );
  }

  return lines.join("\n");
}

/**
 * Tracks consecutive clicks on the same page URL without any verification step
 * (read_page, inspect_element, screenshot). Used to detect when the model is
 * rapidly clicking elements without checking if anything happened.
 */
let clickStreakUrl: string | null = null;
let clickStreakCount = 0;
const CLICK_STREAK_THRESHOLD = 3;

/**
 * Clear all in-memory cart and click tracking state. Called when the agent
 * starts a new task (goal changes) so that stale entries from a previous
 * run do not confuse the model with false "already in cart" warnings.
 */
export function clearCartState(): void {
  clearCartClickState();
  clickStreakUrl = null;
  clickStreakCount = 0;
}

async function followHrefFromClickResult(
  wc: WebContents,
  beforeUrl: string,
  result: unknown,
  logMessage: string,
): Promise<string | null> {
  const hrefMatch =
    typeof result === "string" ? result.match(/\nhref: (https?:\/\/\S+)/) : null;
  if (!hrefMatch) return null;

  try {
    await loadPermittedUrl(wc, hrefMatch[1]);
    await waitForLoad(wc, 8000);
    const hrefUrl = wc.getURL();
    if (hrefUrl !== beforeUrl) return `${result.split("\n")[0]} -> ${hrefUrl}`;
  } catch (err) {
    logger.warn(logMessage, err);
  }

  return null;
}

export async function clickResolvedSelector(
  wc: WebContents,
  selector: string,
): Promise<string> {
  // Shadow DOM direct interaction via stored element reference
  if (selector.startsWith("__vessel_idx:")) {
    const idx = Number(selector.slice("__vessel_idx:".length));
    const beforeUrl = wc.getURL();
    let idxCartMatch = false;
    // Pre-check: get element text for cart-click guard
    const idxLabel = await executePageScript<string>(
      wc,
      `window.__vessel?.getElementText?.(${idx}) || ""`,
      { label: "shadow element text" },
    );
    if (
      typeof idxLabel === "string" &&
      (idxCartMatch = isAddToCartText(idxLabel)) &&
      isDuplicateCartClick(beforeUrl, idxLabel)
    ) {
      return `Blocked: "${idxLabel}" was already clicked on this page. The item is in your cart. Call read_page to see available actions (e.g. View Cart, Continue Shopping).`;
    }
    if (idxCartMatch && isProductAlreadyInCart(beforeUrl)) {
      const summary = getCartAddedSummary(beforeUrl);
      return `Blocked: This product was already added to the cart.${summary}\nGo back and select a different product.`;
    }
    const result = await executePageScript<string>(
      wc,
      `window.__vessel?.interactByIndex?.(${idx}, "click") || "Error: interactByIndex not available"`,
      {
        label: "shadow click by index",
      },
    );
    if (result === PAGE_SCRIPT_TIMEOUT) return pageBusyError("click");
    if (typeof result === "string" && result.startsWith("Error")) return result;
    if (idxCartMatch) {
      recordCartClick(beforeUrl);
    }
    await waitForPotentialNavigation(wc, beforeUrl);
    const afterUrl = wc.getURL();
    if (afterUrl !== beforeUrl) return `${result} -> ${afterUrl}`;
    let idxOverlay = await detectPostClickOverlay(wc);
    if (!idxOverlay && idxCartMatch) {
      await sleep(1200);
      idxOverlay = await detectPostClickOverlay(wc);
    }
    if (idxCartMatch) {
      return `${result}${await buildCartSuccessSuffix(wc, beforeUrl, idxOverlay)}`;
    }
    if (!idxOverlay) {
      const hrefFallback = await followHrefFromClickResult(
        wc,
        beforeUrl,
        result,
        "Failed to follow href fallback after click:",
      );
      if (hrefFallback) return hrefFallback;
    }
    return idxOverlay
      ? `${result}\n${idxOverlay}`
      : `${result}\nNote: Page did not change after click.`;
  }

  // Shadow-piercing selector path
  if (selector.includes(" >>> ")) {
    const beforeUrl = wc.getURL();
    let shadowCartMatch = false;
    // Pre-check: get element text for cart-click guard
    const shadowLabel = await executePageScript<string>(
      wc,
      `(function() {
        var el = window.__vessel?.resolveShadowSelector?.(${JSON.stringify(selector)});
        return el ? (el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 60) || "") : "";
      })()`,
      { label: "shadow element text" },
    );
    if (
      typeof shadowLabel === "string" &&
      (shadowCartMatch = isAddToCartText(shadowLabel)) &&
      isDuplicateCartClick(beforeUrl, shadowLabel)
    ) {
      return `Blocked: "${shadowLabel}" was already clicked on this page. The item is in your cart. Call read_page to see available actions (e.g. View Cart, Continue Shopping).`;
    }
    if (shadowCartMatch && isProductAlreadyInCart(beforeUrl)) {
      const summary = getCartAddedSummary(beforeUrl);
      return `Blocked: This product was already added to the cart.${summary}\nGo back and select a different product.`;
    }
    const result = await executePageScript<string>(
      wc,
      `
      (function() {
        var el = window.__vessel?.resolveShadowSelector?.(${JSON.stringify(selector)});
        if (!el || !document.contains(el)) return "Error[stale-index]: Shadow DOM element not found — call read_page to refresh.";
        if (el instanceof HTMLElement) { el.focus(); el.click(); }
        var anchor = el instanceof HTMLAnchorElement ? el : el.closest('a[href]');
        var href = anchor instanceof HTMLAnchorElement ? anchor.href : null;
        return "Clicked: " + (el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 60) || el.tagName.toLowerCase()) + (href ? "\\nhref: " + href : "");
      })()
    `,
      {
        label: "shadow click selector",
      },
    );
    if (result === PAGE_SCRIPT_TIMEOUT) return pageBusyError("click");
    if (typeof result === "string" && result.startsWith("Error")) return result;
    if (shadowCartMatch) {
      recordCartClick(beforeUrl);
    }
    await waitForPotentialNavigation(wc, beforeUrl);
    const afterUrl = wc.getURL();
    if (afterUrl !== beforeUrl) return `${result} -> ${afterUrl}`;
    let shadowOverlay = await detectPostClickOverlay(wc);
    if (!shadowOverlay && shadowCartMatch) {
      await sleep(1200);
      shadowOverlay = await detectPostClickOverlay(wc);
    }
    if (shadowCartMatch) {
      return `${result}${await buildCartSuccessSuffix(wc, beforeUrl, shadowOverlay)}`;
    }
    if (!shadowOverlay) {
      const hrefFallback = await followHrefFromClickResult(
        wc,
        beforeUrl,
        result,
        "Failed to follow href fallback after shadow click:",
      );
      if (hrefFallback) return hrefFallback;
    }
    return shadowOverlay
      ? `${result}\n${shadowOverlay}`
      : `${result}\nNote: Page did not change after click.`;
  }

  const beforeUrl = wc.getURL();
  const elInfo = await describeElementForClick(wc, selector);
  if ("error" in elInfo) return `Error: ${elInfo.error}`;

  // Block duplicate add-to-cart clicks on the same page
  const cartMatch = isAddToCartText(elInfo.text);
  if (cartMatch && isDuplicateCartClick(beforeUrl, elInfo.text)) {
    return `Blocked: "${elInfo.text}" was already clicked on this page. The item is in your cart. Call read_page to see available actions (e.g. View Cart, Continue Shopping).`;
  }

  // Block clicks on background elements while a cart dialog is open
  if (!cartMatch && hasRecentCartClick(beforeUrl)) {
    const dialogActions = await getCartDialogActions(wc);
    if (dialogActions) {
      return `Blocked: a cart confirmation dialog is open. Do not click background elements.\n${dialogActions}\nClick one of these dialog actions instead.`;
    }
  }

  if (elInfo.href) {
    const validation = await validateLinkDestination(elInfo.href);
    if (validation.status === "dead") {
      return formatDeadLinkMessage(elInfo.text, validation);
    }
  }

  // Block add-to-cart on a product page that was already successfully added.
  if (cartMatch && isProductAlreadyInCart(beforeUrl)) {
    const summary = getCartAddedSummary(beforeUrl);
    return `Blocked: This product was already added to the cart.${summary}\nGo back and select a different product.`;
  }

  // Record add-to-cart clicks BEFORE executing so even if overlay detection
  // fails, a second click on the same page will be caught.
  if (cartMatch) {
    recordCartClick(beforeUrl);
  }

  const tagLabel = elInfo.tag && elInfo.tag !== "a" && elInfo.tag !== "button"
    ? ` <${elInfo.tag}>`
    : "";
  const clickText = `Clicked: ${elInfo.text}${tagLabel}`;
  const clickResult = await clickElement(wc, selector);
  if (clickResult.startsWith("Error:")) return clickResult;

  await waitForPotentialNavigation(wc, beforeUrl);
  const afterUrl = wc.getURL();
  if (afterUrl !== beforeUrl) {
    return `${clickText} -> ${afterUrl}`;
  }

  const overlayHint = await detectPostClickOverlay(wc);
  if (overlayHint) {
    if (cartMatch) {
      return `${clickText} (${clickResult})${await buildCartSuccessSuffix(
        wc,
        beforeUrl,
        overlayHint,
      )}`;
    }
    return `${clickText} (${clickResult})\n${overlayHint}`;
  }

  // Do not "recover" cart clicks with a second DOM activation. On sites like
  // Powell's, that fallback can submit Add to Cart twice while the drawer is opening.
  if (cartMatch) {
    await sleep(1200);
    const delayedOverlayHint = await detectPostClickOverlay(wc);
    if (delayedOverlayHint) {
      return `${clickText} (${clickResult})${await buildCartSuccessSuffix(
        wc,
        beforeUrl,
        delayedOverlayHint,
      )}`;
    }
    // Cart click with no overlay — assume success (some sites use toast notifications)
    return `${clickText} (${clickResult})${await buildCartSuccessSuffix(
      wc,
      beforeUrl,
    )}`;
  }

  const activationResult = await activateElement(wc, selector);
  if (!activationResult.startsWith("Error:")) {
    await waitForPotentialNavigation(wc, beforeUrl);
    const fallbackUrl = wc.getURL();
    if (fallbackUrl !== beforeUrl) {
      return `${clickText} -> ${fallbackUrl} (recovered via DOM activation)`;
    }
  }

  const postActivationOverlayHint = await detectPostClickOverlay(wc);
  if (postActivationOverlayHint) {
    return `${clickText} (${clickResult})\n${postActivationOverlayHint}`;
  }

  const sameTabLinkTarget =
    typeof elInfo.href === "string" &&
    elInfo.href.trim().length > 0 &&
    (!elInfo.target || !/^_blank$/i.test(elInfo.target.trim()));
  if (sameTabLinkTarget) {
    const validation = await validateLinkDestination(elInfo.href!);
    if (validation.status !== "dead") {
        try {
          await loadPermittedUrl(wc, elInfo.href!);
          await waitForLoad(wc, 8000);
          const hrefFallbackUrl = wc.getURL();
          if (hrefFallbackUrl !== beforeUrl) {
            return `${clickText} -> ${hrefFallbackUrl} (recovered via href fallback)`;
          }
        } catch (err) {
          logger.warn("Failed href fallback after click, returning generic click result:", err);
        }
      }
  }

  // Final fallback: click didn't navigate, no overlay, no href fallback.
  // Be explicit that nothing happened so the model doesn't hallucinate success.
  const nonInteractiveWarning =
    elInfo.isInteractive === false && !elInfo.href
      ? `\nNote: The clicked element (<${elInfo.tag || "unknown"}>) is not a link or button. Nothing happened. Try clicking the actual link element nearby or use read_page to find the correct interactive element.`
      : `\nNote: Page did not change after click. The element may need a different interaction method. Consider read_page or inspect_element.`;

  return `${clickText} (${clickResult})${nonInteractiveWarning}`;
}

/**
 * After a cart confirmation dialog appears, try to automatically click
 * "Continue Shopping" (or similar) so the model doesn't get stuck trying
 * to dismiss the dialog via regular clicks (which often don't work through
 * overlay layers).
 */
async function clickOverlayCandidate(
  wc: WebContents,
  action?: {
    label?: string;
    selector?: string;
  },
): Promise<string | null> {
  if (!action?.selector) return null;
  const result = await clickResolvedSelector(wc, action.selector);
  return `${action.label || action.selector}: ${result}`;
}

async function dismissPopup(wc: WebContents): Promise<string> {
  return dismissPopupWithClick(wc, clickElement);
}

export async function clearOverlays(
  wc: WebContents,
  strategy: "auto" | "interactive" = "auto",
): Promise<string> {
  return clearOverlaysWithHandlers(wc, strategy, {
    clickOverlayCandidate,
    dismissPopup,
  });
}

async function resolveTargetByText(
  wc: WebContents,
  query: string,
  mode: TextTargetMode,
): Promise<string | null | typeof PAGE_SCRIPT_TIMEOUT> {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (isInvalidTextTargetQuery(trimmed)) return null;

  const result = await executePageScript<{
    selector: string;
    label: string;
    kind: string;
    matchedText: string;
  } | null>(
    wc,
    `(${resolveTextTargetInDocument.toString()})(document, ${JSON.stringify(trimmed)}, ${JSON.stringify(mode)})`,
    {
      timeoutMs: 2200,
      label: `resolve ${mode} target by text`,
    },
  );

  if (result === PAGE_SCRIPT_TIMEOUT) return PAGE_SCRIPT_TIMEOUT;
  if (!result || typeof result.selector !== "string" || !result.selector) {
    return null;
  }

  return result.selector;
}

export function getTabByMatch(
  tabManager: TabManager,
  match?: string,
): { id: string; title: string; url: string } | null {
  if (!match) return null;
  const lowered = match.toLowerCase();
  return (
    tabManager
      .getAllStates()
      .find(
        (tab) =>
          tab.title.toLowerCase().includes(lowered) ||
          tab.url.toLowerCase().includes(lowered),
      ) || null
  );
}

export function isDangerousAction(name: string): boolean {
  return [
    "navigate",
    "open_bookmark",
    "click",
    "type_text",
    "select_option",
    "submit_form",
    "press_key",
    "create_tab",
    "switch_tab",
    "close_tab",
    "restore_checkpoint",
    "load_session",
    "login",
    "fill_form",
    "search",
    "paginate",
  ].includes(name);
}

function findCheckpoint(
  checkpoints: AgentCheckpoint[],
  args: Record<string, unknown>,
): AgentCheckpoint | null {
  if (typeof args.checkpointId === "string" && args.checkpointId.trim()) {
    return (
      checkpoints.find((item) => item.id === args.checkpointId.trim()) || null
    );
  }

  if (typeof args.name === "string" && args.name.trim()) {
    const lowered = args.name.trim().toLowerCase();
    return (
      [...checkpoints]
        .reverse()
        .find((item) => item.name.toLowerCase() === lowered) || null
    );
  }

  return null;
}

export {
  resolveBookmarkFolderTarget,
  describeFolder,
  composeDuplicateBookmarkResponse,
  composeFolderAwareResponse,
} from "./page-bookmarks";

export {
  fillFormFields,
  focusElement,
  hoverElement,
  pressKey,
  pressKeyDirect,
  selectOptionDirect,
  setElementValue,
  submitFormBySelector,
  submitFormDirect,
  typeKeystroke,
  waitForConditionDirect,
  waitForLoad,
  dismissPopup,
  clickElementBySelector,
  searchPage,
};

async function clickElementBySelector(
  wc: WebContents,
  selector: string,
): Promise<string> {
  return clickResolvedSelector(wc, selector);
}

type SearchTargetInfo = {
  selector: string;
  submitSelector?: string | null;
};

import {
  buildHuggingFaceSearchShortcut,
  type SearchShortcut,
} from "./search-huggingface";
import {
  buildCommonSearchUrlShortcut,
  buildDefaultEngineShortcut,
} from "./page-search";

export {
  normalizeSearchQuery,
  buildCommonSearchUrlShortcut,
  buildSearchShortcut,
} from "./page-search";

async function locateSearchTarget(
  wc: WebContents,
  explicitSelector?: string,
): Promise<SearchTargetInfo | null | typeof PAGE_SCRIPT_TIMEOUT> {
  if (explicitSelector) {
    return { selector: explicitSelector, submitSelector: null };
  }

  return executePageScript<SearchTargetInfo | null>(
    wc,
    `
      (function() {
        function text(value) {
          return value == null ? "" : String(value).trim();
        }

        function normalize(value) {
          return text(value).toLowerCase();
        }

        function isVisible(el) {
          if (!(el instanceof HTMLElement)) return true;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            return false;
          }
          if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function inViewport(el) {
          if (!(el instanceof HTMLElement)) return true;
          const rect = el.getBoundingClientRect();
          const vw = window.innerWidth || document.documentElement?.clientWidth || 0;
          const vh = window.innerHeight || document.documentElement?.clientHeight || 0;
          return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
        }

        ${selectorHelpersJS(["data-testid", "name", "form", "aria-label", "placeholder"])}

        function isDisabled(el) {
          return !!(el && el.hasAttribute && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true"));
        }

        function nearestSearchScope(input) {
          return input.closest('[role="search"], form, header, nav, [class*="search" i], [id*="search" i]');
        }

        function collectCandidates() {
          const seen = new Set();
          const ordered = [];
          const specific = document.querySelectorAll(
            'input[type="search"], input[name="q"], input[name="query"], input[name="search"], input[role="searchbox"], input[aria-label*="search" i], input[placeholder*="search" i], textarea[name="q"], textarea[name="query"], textarea[name="search"], textarea[role="searchbox"], textarea[aria-label*="search" i], textarea[placeholder*="search" i]'
          );
          specific.forEach((el) => {
            if (!seen.has(el)) {
              seen.add(el);
              ordered.push(el);
            }
          });
          document.querySelectorAll('input[type="text"], input:not([type]), textarea').forEach((el) => {
            if (seen.has(el)) return;
            const scope = nearestSearchScope(el);
            if (!scope) return;
            seen.add(el);
            ordered.push(el);
          });
          return ordered;
        }

        function scoreInput(el) {
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return -1;
          if (isDisabled(el) || !isVisible(el)) return -1;
          const isTextarea = el instanceof HTMLTextAreaElement;
          const type = isTextarea ? "text" : normalize(el.getAttribute("type") || el.type);
          if (type && !["search", "text", ""].includes(type)) return -1;

          let score = 0;
          if (inViewport(el)) score += 120;
          const rect = el.getBoundingClientRect();
          score += Math.max(0, 40 - Math.min(40, Math.floor(Math.max(0, rect.top) / 20)));

          const name = normalize(el.name);
          const placeholder = normalize(el.getAttribute("placeholder"));
          const aria = normalize(el.getAttribute("aria-label"));
          if (type === "search") score += 80;
          if (name === "q" || name === "query" || name === "search") score += 70;
          if (placeholder.includes("search")) score += 55;
          if (aria.includes("search")) score += 55;

          const scope = nearestSearchScope(el);
          if (scope) {
            score += 35;
            const scopeRole = normalize(scope.getAttribute && scope.getAttribute("role"));
            const scopeLabel = normalize(
              [
                scope.id,
                scope.className,
                scope.getAttribute && scope.getAttribute("aria-label"),
                scope.getAttribute && scope.getAttribute("action"),
              ].filter(Boolean).join(" ")
            );
            if (scopeRole === "search") score += 35;
            if (scopeLabel.includes("search")) score += 30;
            const tag = normalize(scope.tagName);
            if (tag === "header" || tag === "nav") score += 20;
          }

          return score;
        }

        function pickSearchButton(input) {
          const scopes = [
            input.closest('[role="search"]'),
            input.closest('form'),
            nearestSearchScope(input),
            input.parentElement,
          ].filter(Boolean);
          const seen = new Set();
          let best = null;
          let bestScore = -1;

          for (const scope of scopes) {
            scope.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]').forEach((candidate) => {
              if (seen.has(candidate)) return;
              seen.add(candidate);
              if (!(candidate instanceof HTMLElement)) return;
              if (candidate === input || isDisabled(candidate) || !isVisible(candidate)) return;

              const label = normalize(
                candidate.getAttribute("aria-label") ||
                  candidate.textContent ||
                  candidate.getAttribute("title") ||
                  candidate.getAttribute("value")
              );
              const rect = candidate.getBoundingClientRect();
              const inputRect = input.getBoundingClientRect();
              const closeToInput =
                Math.abs(rect.top - inputRect.top) < 80 &&
                Math.abs(rect.left - inputRect.right) < 260;

              let score = 0;
              if (inViewport(candidate)) score += 40;
              if (closeToInput) score += 35;
              if (label.includes("search") || label.includes("go") || label.includes("submit")) score += 45;
              if (candidate.getAttribute("type") === "submit") score += 20;
              if (candidate.closest('[role="search"]') === input.closest('[role="search"]')) score += 20;
              if (candidate.closest('form') && candidate.closest('form') === input.closest('form')) score += 15;

              if (score > bestScore) {
                best = candidate;
                bestScore = score;
              }
            });
          }

          return bestScore >= 35 ? best : null;
        }

        let bestInput = null;
        let bestScore = -1;
        for (const candidate of collectCandidates()) {
          const score = scoreInput(candidate);
          if (score > bestScore) {
            bestInput = candidate;
            bestScore = score;
          }
        }

        if (!bestInput) return null;
        const selector = selectorFor(bestInput);
        if (!selector) return null;
        const submit = pickSearchButton(bestInput);
        return {
          selector: selector,
          submitSelector: submit ? selectorFor(submit) : null,
        };
      })()
    `,
    {
      timeoutMs: 2200,
      label: "find search input",
    },
  );
}

async function locateImplicitTextTarget(
  wc: WebContents,
): Promise<string | null | typeof PAGE_SCRIPT_TIMEOUT> {
  return executePageScript<string | null>(
    wc,
    `
      (function() {
        function normalize(value) {
          return value == null ? "" : String(value).trim().toLowerCase();
        }

        function isVisible(el) {
          if (!(el instanceof HTMLElement)) return true;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function inViewport(el) {
          if (!(el instanceof HTMLElement)) return true;
          const rect = el.getBoundingClientRect();
          const vw = window.innerWidth || document.documentElement?.clientWidth || 0;
          const vh = window.innerHeight || document.documentElement?.clientHeight || 0;
          return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
        }

        function isFillable(el) {
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
          if (el.disabled || el.readOnly || el.getAttribute("aria-disabled") === "true") return false;
          const type = el instanceof HTMLTextAreaElement ? "text" : normalize(el.getAttribute("type") || el.type || "text");
          return ["", "search", "text", "email", "url", "tel", "number", "password"].includes(type);
        }

        function nearestSearchScope(input) {
          return input.closest('[role="search"], form, header, nav, [class*="search" i], [id*="search" i]');
        }

        ${selectorHelpersJS(["data-testid", "name", "form", "aria-label", "placeholder"])}

        const active = document.activeElement;
        if (active && isFillable(active) && isVisible(active) && inViewport(active)) {
          return selectorFor(active);
        }

        const candidates = Array.from(
          document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), textarea')
        ).filter((el) => isFillable(el) && isVisible(el));

        let best = null;
        let bestScore = -1;
        for (const el of candidates) {
          let score = 0;
          if (inViewport(el)) score += 100;
          const rect = el.getBoundingClientRect();
          score += Math.max(0, 36 - Math.min(36, Math.floor(Math.max(0, rect.top) / 22)));

          const type = el instanceof HTMLTextAreaElement ? "text" : normalize(el.getAttribute("type") || el.type);
          const name = normalize(el.getAttribute("name"));
          const placeholder = normalize(el.getAttribute("placeholder"));
          const aria = normalize(el.getAttribute("aria-label"));
          const role = normalize(el.getAttribute("role"));
          const id = normalize(el.getAttribute("id"));

          if (type === "search") score += 80;
          if (role === "searchbox") score += 70;
          if (name === "q" || name === "query" || name === "search") score += 65;
          if (placeholder.includes("search")) score += 55;
          if (aria.includes("search")) score += 55;
          if (id.includes("search")) score += 35;

          const scope = nearestSearchScope(el);
          if (scope) score += 35;

          if (score > bestScore) {
            best = el;
            bestScore = score;
          }
        }

        return best ? selectorFor(best) : null;
      })()
    `,
    {
      timeoutMs: 2200,
      label: "find implicit text input",
    },
  );
}

async function searchPage(
  wc: WebContents,
  args: Record<string, unknown>,
): Promise<string> {
  const query = String(args.query || "");
  if (!query) return "Error: No search query provided.";

  const queryLower = query.toLowerCase().trim();
  const buttonLikePatterns = [
    "add to cart",
    "add to bag",
    "add to basket",
    "buy now",
    "buy it now",
    "purchase",
    "continue shopping",
    "keep shopping",
    "view cart",
    "view bag",
    "view basket",
    "go to cart",
    "go to checkout",
    "checkout",
    "check out",
    "proceed to checkout",
    "place order",
    "submit",
    "subscribe",
    "sign up",
    "sign in",
    "log in",
    "register",
    "continue",
  ];
  if (buttonLikePatterns.some((p) => queryLower.includes(p))) {
    return `Error: "${query}" looks like a button label, not a search query. Use the click tool to interact with this element instead.`;
  }

  if (looksLikeCurrentSiteNameQuery(query, wc.getURL(), wc.getTitle() || "")) {
    return `Error: "${query}" looks like the current site's name, not a product query. You are already on ${wc.getURL()}. Open a section like staff picks/new releases or search for actual book titles, authors, or genres instead.`;
  }

  const runShortcut = async (shortcut: SearchShortcut): Promise<string> => {
    const beforeUrl = wc.getURL();
    await loadPermittedUrl(wc, shortcut.url);
    await waitForPotentialNavigation(wc, beforeUrl, 4000);
    const afterUrl = wc.getURL();
    const applied =
      shortcut.appliedFilters.length > 0
        ? ` (${shortcut.appliedFilters.join(", ")})`
        : "";
    const destination = shortcut.section ? ` ${shortcut.section}` : "";
    return `Searched "${query}" via ${shortcut.source}${destination} shortcut${applied} → ${afterUrl}${await getPostSearchSummary(wc)}`;
  };

  if (typeof args.selector !== "string") {
    const shortcut =
      buildHuggingFaceSearchShortcut(wc.getURL(), query) ??
      buildCommonSearchUrlShortcut(wc.getURL(), query);
    if (shortcut) {
      return runShortcut(shortcut);
    }
  }

  const searchInfo = await locateSearchTarget(
    wc,
    typeof args.selector === "string" ? args.selector : undefined,
  );
  if (searchInfo === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("search");
  }
  if (!searchInfo?.selector) {
    if (typeof args.selector !== "string") {
      const fallback = buildDefaultEngineShortcut(query);
      if (fallback) {
        return runShortcut(fallback);
      }
    }
    return "Error: Could not find a visible search input. Try read_page(mode=\"visible_only\") or provide a selector.";
  }

  const fillResult = await setElementValue(wc, searchInfo.selector, query);
  if (fillResult.startsWith("Error:")) {
    return fillResult;
  }
  await sleep(100);

  const beforeUrl = wc.getURL();
  const keyResult = await pressKey(wc, {
    key: "Enter",
    selector: searchInfo.selector,
  });
  if (keyResult.startsWith("Error:")) {
    return keyResult;
  }

  await waitForPotentialNavigation(wc, beforeUrl, 3000);
  let afterUrl = wc.getURL();
  if (afterUrl !== beforeUrl) {
    return `Searched "${query}" → ${afterUrl}${await getPostSearchSummary(wc)}`;
  }

  if (searchInfo.submitSelector) {
    const clickResult = await clickElementBySelector(wc, searchInfo.submitSelector);
    if (!clickResult.startsWith("Error:")) {
      await waitForPotentialNavigation(wc, beforeUrl, 3000);
      afterUrl = wc.getURL();
      if (afterUrl !== beforeUrl) {
        return `Searched "${query}" (via search button) → ${afterUrl}${await getPostSearchSummary(wc)}`;
      }
    }
  }

  return `Searched "${query}" (same page — results may have loaded dynamically)${await getPostSearchSummary(wc)}`;
}

async function getPostActionState(
  ctx: ActionContext,
  name: string,
): Promise<string> {
  const tab = ctx.tabManager.getActiveTab();
  if (!tab) return "";

  const wc = tab.view.webContents;
  const navActions = [
    "navigate",
    "open_bookmark",
    "go_back",
    "go_forward",
    "click",
    "submit_form",
    "reload",
    "press_key",
    "login",
    "search",
    "paginate",
  ];
  const interactActions = [
    "type_text",
    "select_option",
    "hover",
    "focus",
    "fill_form",
    "inspect_element",
    "clear_overlays",
  ];
  const tabActions = [
    "create_tab",
    "switch_tab",
    "set_ad_blocking",
    "load_session",
  ];

  if (navActions.includes(name)) {
    // If the page is still loading (spinner visible), wait for it to
    // finish — just like a human waits for the spinner to stop.
    if (wc.isLoading()) {
      await waitForLoad(wc);
    }
    const currentUrl = wc.getURL();
    let warnings = "";
    if (isProductAlreadyInCart(currentUrl)) {
      warnings += `\nWARNING: This product is already in your cart.${getCartAddedSummary(currentUrl)}\nGo back and select a different product.`;
    }
    // Detect domain drift: if a click/navigate took us off the requested site,
    // warn the model to go back immediately.
    const taskGoal = ctx.runtime.getState().taskTracker?.goal;
    if (taskGoal && name === "click") {
      const drift = shouldBlockOffGoalDomainNavigation(taskGoal, currentUrl);
      if (drift) {
        warnings += `\nWARNING: You drifted to ${drift.targetDomain} but the task requires staying on ${drift.requestedDomain}. Call go_back immediately to return to the previous page.`;
      }
    }

    // After going back or searching, always show what's already in the cart
    // so the model doesn't re-click the same products from memory.
    if (name === "go_back" || name === "search") {
      const cartSummary = getCartAddedSummary(currentUrl);
      if (cartSummary) {
        warnings += `${cartSummary}\nSelect a DIFFERENT product that is not in the cart. Call read_page if needed to see available results.`;
      }
      // Compact models often skip read_page after going back and click blindly.
      // Force them to refresh context before interacting.
      if (ctx.toolProfile === "compact" && name === "go_back") {
        warnings += `\nCall read_page(mode="results_only") to see available products before clicking.`;
      }
    }

    // Detect when a click navigated to a filter/sort URL instead of a product
    // page — common mistake for small models on listing pages.
    if (name === "click" && ctx.toolProfile === "compact") {
      const filterParams = /\b(condition|binding|format|availability|sort|filter|price|category_id|view)\b=[^&]/i;
      const filterPath = /\/(condition|binding|format|availability|sort|filter|price|category)\/[^/?#]+/i;
      if (filterParams.test(currentUrl) || filterPath.test(currentUrl)) {
        warnings += `\nWARNING: The clicked link appears to be a filter or sort control, not a product. If you intended to click a product, call go_back and use click(index=N) on a result from read_page(mode="results_only").`;
      }
    }

    return `\n[state: url=${currentUrl}, title=${JSON.stringify(wc.getTitle() || "")}, canGoBack=${tab.canGoBack()}, canGoForward=${tab.canGoForward()}, loading=${wc.isLoading()}]${warnings}`;
  }

  // After a click that stays on the same page, check if we landed on an
  // empty/no-results page — common when clicking filter links by mistake.
  if (name === "click" && !wc.isLoading()) {
    try {
      const emptyPage = await executePageScript<boolean>(
        wc,
        `(function() {
          var body = (document.body.textContent || '').toLowerCase();
          return /\b(no results|no items found|nothing matched|0 results|zero results|no products|your search.*did not match|no books found)\b/.test(body)
            && body.length < 8000;
        })()`,
        { timeoutMs: 1000, label: "empty page check" },
      );
      if (emptyPage && emptyPage !== PAGE_SCRIPT_TIMEOUT) {
        return `\n[state: url=${wc.getURL()}, title=${JSON.stringify(wc.getTitle() || "")}, canGoBack=${tab.canGoBack()}, canGoForward=${tab.canGoForward()}, loading=false]\nWARNING: This page shows no results. You likely clicked a filter or category link instead of a product. Call go_back to return to the search results.`;
      }
    } catch {
      // Ignore — this is a best-effort check
    }
  }

  if (interactActions.includes(name)) {
    return `\n[state: url=${wc.getURL()}, title=${JSON.stringify(wc.getTitle() || "")}, tabId=${ctx.tabManager.getActiveTabId()}]`;
  }

  if (tabActions.includes(name)) {
    const activeId = ctx.tabManager.getActiveTabId();
    const activeTab = ctx.tabManager.getActiveTab();
    const count = ctx.tabManager.getAllStates().length;
    const activeTitle = activeTab?.view.webContents.getTitle() || "";
    const activeUrl = activeTab?.view.webContents.getURL() || "";
    return `\n[state: activeTab=${activeId}, title=${JSON.stringify(activeTitle)}, url=${activeUrl}, totalTabs=${count}]`;
  }

  return "";
}

/** All known tool names — used to detect concatenated tool calls from models */
const KNOWN_TOOLS = new Set(TOOL_DEFINITIONS.map((d) => d.name));

export async function executeAction(
  name: string,
  args: Record<string, unknown>,
  ctx: ActionContext,
): Promise<string> {
  name = normalizeToolAlias(name);

  // When a sub-agent targets its own tab, serialize all browser access
  // through a mutex so parallel sub-agents don't race on the active tab.
  if (ctx.tabId && ctx._tabMutex) {
    return ctx._tabMutex.enqueue(async () => {
      const prevActiveId = ctx.tabManager.getActiveTabId();
      if (prevActiveId !== ctx.tabId) ctx.tabManager.switchTab(ctx.tabId!);
      try {
        return await executeAction(name, args, { ...ctx, tabId: undefined, _tabMutex: undefined });
      } finally {
        if (prevActiveId && prevActiveId !== ctx.tabId) {
          ctx.tabManager.switchTab(prevActiveId);
        }
      }
    });
  }

  // Detect concatenated tool names (e.g. "create_checkpointcurrent_tablist_tabs")
  // from models that don't properly support parallel tool calls
  if (!KNOWN_TOOLS.has(name)) {
    // Try to find the first matching tool name at the start
    for (const known of KNOWN_TOOLS) {
      if (name.startsWith(known) && name.length > known.length) {
        const remaining = name.slice(known.length);
        const otherTools = [...KNOWN_TOOLS].filter((t) =>
          remaining.includes(t),
        );
        return `Error: It looks like you tried to call multiple tools at once (${known}, ${otherTools.join(", ")}). Please call them one at a time — send one tool call per message.`;
      }
    }
  }

  const tab = ctx.tabManager.getActiveTab();
  const tabId = ctx.tabManager.getActiveTabId();

  if (
    !tab &&
    ![
      "current_tab",
      "list_tabs",
      "create_tab",
      "set_ad_blocking",
      "restore_checkpoint",
      "save_session",
      "load_session",
      "list_sessions",
      "delete_session",
      "list_bookmarks",
      "search_bookmarks",
      "create_bookmark_folder",
      "save_bookmark",
      "organize_bookmark",
      "archive_bookmark",
      "open_bookmark",
      "flow_start",
      "flow_advance",
      "flow_status",
      "flow_end",
      "suggest",
    ].includes(name)
  ) {
    return "Error: No active tab";
  }

  // Track tool usage (anonymous, name only)
  trackToolCall(name);

  // Premium feature gate — return a helpful upgrade message for gated tools
  if (isToolGated(name)) {
    return `This tool (${name}) requires Vessel Premium. Upgrade at Settings > Premium to unlock screenshot, session management, workflow tracking, and more.`;
  }

  const wc = tab?.view.webContents;

  const result = await ctx.runtime.runControlledAction({
    source: "ai",
    name,
    args,
    tabId,
    dangerous: isDangerousAction(name),
    executor: async () => {
      switch (name) {
        case "screenshot": {
          if (!wc) return "Error: No active tab";
          const screenshotStart = Date.now();
          const shot = await captureScreenshot(wc);
          if (!shot.ok) return `Error: ${shot.error}`;
          const screenshotMs = Date.now() - screenshotStart;
          const title = wc.getTitle() || "(untitled)";
          const url = wc.getURL();
          return makeImageResult(
            shot.base64,
            `Screenshot of "${title}" (${url}) — ${shot.width}x${shot.height}, captured in ${screenshotMs}ms. Analyze the image to understand the current visual state of the page.`,
          );
        }

        case "current_tab": {
          const active = ctx.tabManager.getActiveTab();
          const activeId = ctx.tabManager.getActiveTabId();
          if (!active || !activeId) return "Error: No active tab";
          const state = active.state;
          return JSON.stringify(
            {
              tabId: activeId,
              title: state.title,
              url: state.url,
              isLoading: state.isLoading,
              canGoBack: state.canGoBack,
              canGoForward: state.canGoForward,
              adBlockingEnabled: state.adBlockingEnabled,
              humanFocused: true,
            },
            null,
            2,
          );
        }

        case "list_tabs": {
          const activeId = ctx.tabManager.getActiveTabId();
          const lines = ctx.tabManager.getAllStates().map((item) => {
            const prefix = item.id === activeId ? "->" : "  ";
            const adBlock = item.adBlockingEnabled ? "on" : "off";
            return `${prefix} [${item.id}] ${item.title} — ${item.url} [adblock:${adBlock}]`;
          });
          return lines.join("\n") || "No tabs open";
        }

        case "switch_tab": {
          let targetId =
            typeof args.tabId === "string" ? args.tabId.trim() : "";
          if (!targetId) {
            targetId = getTabByMatch(ctx.tabManager, args.match)?.id || "";
          }
          if (!targetId) return "Error: No matching tab found";
          ctx.tabManager.switchTab(targetId);
          const active = ctx.tabManager.getActiveTab();
          return active
            ? `Switched to ${active.view.webContents.getTitle() || active.view.webContents.getURL()}`
            : `Switched to tab ${targetId}`;
        }

        case "create_tab": {
          const createdId = ctx.tabManager.createTab(
            typeof args.url === "string" && args.url.trim()
              ? args.url.trim()
              : "about:blank",
          );
          const created = ctx.tabManager.getTab(createdId);
          if (created) {
            await waitForLoad(created.view.webContents);
            return `Created tab ${createdId}${await getPostNavSummary(created.view.webContents)}`;
          }
          return `Created tab ${createdId}`;
        }

        case "navigate": {
          if (!wc || !tabId) return "Error: No active tab";
          const taskGoal = ctx.runtime.getState().taskTracker?.goal;
          if (taskGoal && typeof args.url === "string") {
            const domainDrift = shouldBlockOffGoalDomainNavigation(
              taskGoal,
              args.url,
            );
            if (domainDrift) {
              return `Navigation blocked: ${args.url} drifts away from the requested site ${domainDrift.requestedDomain}. Stay on the requested domain and continue the original task there.`;
            }
          }
          if (
            typeof args.url === "string" &&
            !args.postBody &&
            isRedundantNavigateTarget(wc.getURL(), args.url)
          ) {
            return `Already on ${wc.getURL()}. Do not navigate to the same URL again. Use click, inspect_element, read_page, or search for actual book terms instead.`;
          }
          const navValidation = await validateLinkDestination(args.url);
          if (navValidation.status === "dead") {
            return `Navigation blocked: ${args.url} returned ${navValidation.detail || "dead link"}. Try a different URL or go back and choose another link.`;
          }
          const navError = ctx.tabManager.navigateTab(tabId, args.url, args.postBody);
          if (navError) return navError;
          await waitForLoad(wc);
          return `Navigated to ${wc.getURL()}${await getPostNavSummary(wc)}`;
        }

        case "go_back": {
          if (!tab || !wc || !tabId) return "Error: No active tab";
          if (!tab.canGoBack()) {
            return "No previous page in history";
          }
          const beforeUrl = wc.getURL();
          ctx.tabManager.goBack(tabId);
          await waitForLoad(wc);
          const afterUrl = wc.getURL();
          return afterUrl !== beforeUrl
            ? `Went back to ${afterUrl}${await getPostNavSummary(wc)}`
            : `Back action completed but page stayed on ${afterUrl}`;
        }

        case "go_forward": {
          if (!tab || !wc || !tabId) return "Error: No active tab";
          if (!tab.canGoForward()) {
            return "No forward page in history";
          }
          const beforeUrl = wc.getURL();
          ctx.tabManager.goForward(tabId);
          await waitForLoad(wc);
          const afterUrl = wc.getURL();
          return afterUrl !== beforeUrl
            ? `Went forward to ${afterUrl}${await getPostNavSummary(wc)}`
            : `Forward action completed but page stayed on ${afterUrl}`;
        }

        case "reload": {
          if (!wc || !tabId) return "Error: No active tab";
          ctx.tabManager.reloadTab(tabId);
          await waitForLoad(wc);
          return `Reloaded ${wc.getURL()}`;
        }

        case "click": {
          if (!wc) return "Error: No active tab";
          let selector: string | null | typeof PAGE_SCRIPT_TIMEOUT = null;
          const textTarget =
            typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";
          if (typeof args.selector === "string" && args.selector.trim()) {
            selector = await resolveSelector(wc, undefined, args.selector);
          } else if (textTarget) {
            if (isInvalidTextTargetQuery(textTarget)) {
              return `Error: "${textTarget}" looks like HTML or markup, not a visible page label. Use a book title, button text, or element index instead.`;
            }
            selector = await resolveTargetByText(wc, textTarget, "interactive");
            if (!selector && typeof args.index === "number") {
              selector = `__vessel_idx:${args.index}`;
            }
          } else if (typeof args.index === "number") {
            selector = await resolveSelector(wc, args.index);
            if (!selector) selector = `__vessel_idx:${args.index}`;
          } else {
            selector = await resolveSelector(wc, args.index, args.selector);
          }
          if (selector === PAGE_SCRIPT_TIMEOUT) return pageBusyError("click");
          if (!selector) {
            return "Error: No element index, selector, or visible text provided";
          }
          return clickResolvedSelector(wc, selector);
        }

        case "inspect_element": {
          if (!wc) return "Error: No active tab";
          let selector: string | null | typeof PAGE_SCRIPT_TIMEOUT = null;
          const textTarget =
            typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";
          if (textTarget) {
            if (isInvalidTextTargetQuery(textTarget)) {
              return `Error: "${textTarget}" looks like HTML or markup, not visible page text. Use a section title, book title, or element index instead.`;
            }
            selector = await resolveTargetByText(wc, textTarget, "context");
          } else {
            selector = await resolveSelector(wc, args.index, args.selector);
          }
          if (selector === PAGE_SCRIPT_TIMEOUT) {
            return pageBusyError("inspect_element");
          }
          if (!selector) {
            return "Error: No element index, selector, or visible text provided";
          }
          return inspectElement(
            wc,
            selector,
            typeof args.limit === "number" ? args.limit : 8,
          );
        }

        case "type_text": {
          if (!wc) return "Error: No active tab";
          let selector = await resolveSelector(wc, args.index, args.selector);
          if (selector === PAGE_SCRIPT_TIMEOUT) {
            return pageBusyError("type_text");
          }
          if (!selector) {
            selector = await locateImplicitTextTarget(wc);
          }
          if (selector === PAGE_SCRIPT_TIMEOUT) {
            return pageBusyError("type_text");
          }
          if (!selector) {
            return "Error: No element index or selector provided, and no focused or visible text input could be found.";
          }
          const mode = typeof args.mode === "string" ? args.mode : "default";
          if (mode === "keystroke") {
            return typeKeystroke(wc, selector, String(args.text || ""));
          }
          return setElementValue(wc, selector, String(args.text || ""));
        }

        case "select_option": {
          if (!wc) return "Error: No active tab";
          return selectOption(wc, args);
        }

        case "submit_form": {
          if (!wc) return "Error: No active tab";
          const beforeUrl = wc.getURL();
          const result = await submitForm(wc, args);
          if (
            result.startsWith("Error") ||
            result.startsWith("Target") ||
            result.startsWith("No parent") ||
            result.startsWith("Submit control")
          ) {
            return result;
          }
          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          return afterUrl !== beforeUrl ? `${result} -> ${afterUrl}` : result;
        }

        case "press_key": {
          if (!wc) return "Error: No active tab";
          const beforeUrl = wc.getURL();
          const result = await pressKey(wc, args);
          const key = typeof args.key === "string" ? args.key.trim() : "";
          if (key === "Enter") {
            await waitForPotentialNavigation(wc, beforeUrl, 3000);
            const afterUrl = wc.getURL();
            if (afterUrl !== beforeUrl) {
              return `${result} -> ${afterUrl}`;
            }
          } else {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return result;
        }

        case "scroll": {
          if (!wc) return "Error: No active tab";
          const pixels = coerceOptionalNumber(args.amount) ?? 500;
          const dir = args.direction === "up" ? -pixels : pixels;
          const result = await scrollPage(wc, dir);
          return `Scrolled ${args.direction} by ${pixels}px (moved ${Math.abs(result.movedY)}px, now at y=${Math.round(result.afterY)})`;
        }

        case "hover": {
          if (!wc) return "Error: No active tab";
          const selector = await resolveSelector(wc, args.index, args.selector);
          if (!selector) return "Error: No element index or selector provided";
          return hoverElement(wc, selector);
        }

        case "focus": {
          if (!wc) return "Error: No active tab";
          const selector = await resolveSelector(wc, args.index, args.selector);
          if (!selector) return "Error: No element index or selector provided";
          return focusElement(wc, selector);
        }

        case "set_ad_blocking": {
          const enabled =
            typeof args.enabled === "boolean" ? args.enabled : null;
          if (enabled == null) {
            return "Error: enabled must be true or false";
          }

          let targetId =
            typeof args.tabId === "string" ? args.tabId.trim() : "";
          if (!targetId) {
            targetId = getTabByMatch(ctx.tabManager, args.match)?.id || "";
          }
          if (!targetId) {
            targetId = ctx.tabManager.getActiveTabId() || "";
          }
          if (!targetId) return "Error: No target tab found";

          const targetTab = ctx.tabManager.getTab(targetId);
          if (!targetTab) return "Error: Target tab not found";

          ctx.tabManager.setAdBlockingEnabled(targetId, enabled);

          const shouldReload = args.reload !== false;
          if (shouldReload) {
            targetTab.reload();
            await waitForLoad(targetTab.view.webContents);
          }

          const state = targetTab.state;
          return `${enabled ? "Enabled" : "Disabled"} ad blocking for "${state.title}"${shouldReload ? " and reloaded the tab" : ""}`;
        }

        case "dismiss_popup": {
          if (!wc) return "Error: No active tab";
          return dismissPopup(wc);
        }

        case "clear_overlays": {
          if (!wc) return "Error: No active tab";
          const strategy =
            args.strategy === "interactive" ? "interactive" : "auto";
          return clearOverlays(wc, strategy);
        }

        case "read_page": {
          if (!wc) return "Error: No active tab";

          // Glance mode: ultra-fast viewport scan using textContent (no layout
          // reflow). Shows what a human would see — headings, links, buttons,
          // inputs in the viewport. Ideal for heavy pages where full extraction
          // times out. Always available as an explicit mode, and used as the
          // automatic fallback when full extraction fails.
          const requestedGlance =
            typeof args.mode === "string" && args.mode.trim().toLowerCase() === "glance";

          if (requestedGlance) {
            return glanceExtract(wc);
          }

          const requestedTextMode =
            typeof args.mode === "string"
              ? args.mode.trim().toLowerCase()
              : "";
          if (
            requestedTextMode === "summary" ||
            requestedTextMode === "text_only"
          ) {
            const fastArticleText = await fastArticleTextExtract(
              wc,
              requestedTextMode,
            );
            if (fastArticleText) {
              return fastArticleText;
            }
            const fetchedArticleText = await fetchArticleTextExtract(
              wc,
              requestedTextMode,
            );
            if (fetchedArticleText) {
              return fetchedArticleText;
            }
          }

          // Try full extraction first; if the page JS thread is busy
          // (common on heavy SPAs after navigation), fall back to a
          // lightweight native-only read so the agent isn't blocked.
          let content: Awaited<ReturnType<typeof extractContent>> | null = null;
          try {
            content = await Promise.race([
              extractContent(wc),
              new Promise<null>((resolve) =>
                setTimeout(() => {
                  resolve(null);
                }, 6000),
              ),
            ]);
          } catch (err) {
            logger.warn("Failed to extract content for read_page, falling back to lighter recovery:", err);
            content = null;
          }

          // If extraction failed or returned empty content, try a quick iframe
          // consent dismiss (2s budget) then fall through to emergency extraction.
          // We intentionally avoid calling clearOverlays here because it does
          // another full extractContent internally which will also time out on
          // heavy pages, adding 10+ seconds of dead time.
          if (!content || content.content.length === 0) {
            try {
              const iframeResult = await Promise.race([
                tryDismissConsentIframe(wc),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
              ]);
              if (iframeResult) {
                await sleep(500);
                // Quick retry — only 3s budget since we don't want to block long
                try {
                  content = await Promise.race([
                    extractContent(wc),
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
                  ]);
                } catch (err) {
                  logger.warn("Failed to re-extract content after iframe consent dismissal:", err);
                  content = null;
                }
              }
            } catch (err) {
              logger.warn("Failed iframe consent dismissal during read_page recovery:", err);
            }
          }

          if (content && content.content.length > 0) {
            const liveSelectionSection = formatLiveSelectionSection(
              await captureLiveHighlightSnapshot(
                wc,
                highlightsManager.getHighlightsForUrl(content.url),
              ),
            );
            const livePrefix = liveSelectionSection
              ? `${liveSelectionSection}\n\n`
              : "";
            const baseMode = normalizeReadPageMode(args.mode, content);
            const requestedMode =
              ctx.toolProfile === "compact" &&
              (args.mode == null ||
                (typeof args.mode === "string" && !args.mode.trim()))
                ? chooseCompactReadMode(content, baseMode)
                : baseMode;

            if (requestedMode === "debug" || requestedMode === "full") {
              const structured = buildStructuredContext(content);
              const truncated =
                content.content.length > MAX_AGENT_DEBUG_CONTENT_LENGTH
                  ? content.content.slice(0, MAX_AGENT_DEBUG_CONTENT_LENGTH) + "\n[Content truncated...]"
                  : content.content;
              return `${livePrefix}[read_page mode=debug]\n\n${structured}\n\n## PAGE CONTENT\n\n${truncated}`;
            }

            const scoped =
              ctx.toolProfile === "compact"
                ? buildCompactScopedContext(content, requestedMode)
                : buildScopedContext(content, requestedMode);
            return [
              livePrefix ? livePrefix.trimEnd() : "",
              `[read_page mode=${requestedMode}]`,
              "",
              scoped,
              "",
              `Need more detail? Escalate with read_page(mode="debug") only if the narrow modes are insufficient.`,
            ]
              .filter(Boolean)
              .join("\n\n");
          }

          // Full extraction failed — fall back to glance mode which uses
          // textContent (no layout reflow) and can work on blocked JS threads
          return glanceExtract(wc);
        }

        case "wait_for": {
          if (!wc) return "Error: No active tab";
          return waitForCondition(wc, args);
        }

        case "wait_for_navigation": {
          if (!wc) return "Error: No active tab";
          const timeout =
            typeof args.timeoutMs === "number" ? args.timeoutMs : 10000;
          const beforeUrl = wc.getURL();
          if (wc.isLoading()) {
            // Page is currently loading — wait for it to finish
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, timeout);
              wc.once("did-stop-loading", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          } else {
            // Page already loaded — wait briefly in case a navigation is about to start
            await new Promise<void>((resolve) => {
              let navigated = false;
              const timer = setTimeout(
                () => {
                  if (!navigated) resolve();
                },
                Math.min(timeout, 2000),
              );
              wc.once("did-start-loading", () => {
                navigated = true;
                clearTimeout(timer);
                // Now wait for it to finish
                const loadTimer = setTimeout(resolve, timeout);
                wc.once("did-stop-loading", () => {
                  clearTimeout(loadTimer);
                  resolve();
                });
              });
            });
          }
          const afterUrl = wc.getURL();
          const title = wc.getTitle();
          if (afterUrl !== beforeUrl) {
            return `Navigation complete: ${title} (${afterUrl})`;
          }
          return `Page loaded: ${title} (${afterUrl})`;
        }

        case "create_checkpoint": {
          const checkpoint = ctx.runtime.createCheckpoint(args.name, args.note);
          return `Created checkpoint ${checkpoint.name} (${checkpoint.id})`;
        }

        case "restore_checkpoint": {
          const checkpoint = findCheckpoint(
            ctx.runtime.getState().checkpoints,
            args,
          );
          if (!checkpoint) {
            return "Error: No matching checkpoint found";
          }
          ctx.runtime.restoreCheckpoint(checkpoint.id);
          return `Restored checkpoint ${checkpoint.name}`;
        }

        case "save_session": {
          const name = typeof args.name === "string" ? args.name.trim() : "";
          if (!name) return "Error: Session name is required";
          const saved = await namedSessionManager.saveNamedSession(
            ctx.tabManager,
            name,
          );
          return `Saved session "${saved.name}" (${saved.cookieCount} cookies, ${saved.originCount} localStorage origins)`;
        }

        case "load_session": {
          const name = typeof args.name === "string" ? args.name.trim() : "";
          if (!name) return "Error: Session name is required";
          const loaded = await namedSessionManager.loadNamedSession(
            ctx.tabManager,
            name,
          );
          return `Loaded session "${loaded.name}" (${loaded.cookieCount} cookies, ${loaded.originCount} localStorage origins)`;
        }

        case "list_sessions": {
          const sessions = namedSessionManager.listNamedSessions();
          if (sessions.length === 0) return "No saved sessions";
          return sessions
            .map(
              (item) =>
                `- ${item.name} | updated=${item.updatedAt} | cookies=${item.cookieCount} | origins=${item.originCount}${item.domains.length ? ` | domains=${item.domains.slice(0, 6).join(", ")}${item.domains.length > 6 ? ", ..." : ""}` : ""}`,
            )
            .join("\n");
        }

        case "delete_session": {
          const name = typeof args.name === "string" ? args.name.trim() : "";
          if (!name) return "Error: Session name is required";
          return namedSessionManager.deleteNamedSession(name)
            ? `Deleted session "${name}"`
            : `Session "${name}" not found`;
        }

        case "list_bookmarks": {
          const state = bookmarkManager.getState();
          const folderId =
            typeof args.folderId === "string" ? args.folderId.trim() : "";
          const folderName =
            typeof args.folderName === "string" ? args.folderName.trim() : "";
          const resolvedFolderId =
            folderId ||
            (folderName
              ? (state.folders.find(
                  (folder) =>
                    folder.name.toLowerCase() === folderName.toLowerCase(),
                )?.id ?? "")
              : "");

          if (folderName && !resolvedFolderId) {
            return `Folder "${folderName}" not found`;
          }

          const folders = [
            { id: "unsorted", name: "Unsorted" },
            ...state.folders,
          ];
          const lines: string[] = [];
          for (const folder of folders) {
            if (resolvedFolderId && folder.id !== resolvedFolderId) continue;
            const items = state.bookmarks.filter(
              (bookmark) => bookmark.folderId === folder.id,
            );
            lines.push(
              `[${folder.name}] (id=${folder.id}, ${items.length} items)`,
            );
            if ("summary" in folder && typeof folder.summary === "string") {
              lines.push(`summary: ${folder.summary}`);
            }
            for (const bookmark of items) {
              lines.push(
                `- ${bookmark.title} | ${bookmark.url} | id=${bookmark.id}${bookmark.note ? ` | note: ${bookmark.note}` : ""}`,
              );
            }
          }
          return lines.length ? lines.join("\n") : "No bookmarks saved yet";
        }

        case "search_bookmarks": {
          const query = typeof args.query === "string" ? args.query.trim() : "";
          if (!query) return "Error: query is required";

          const matches = bookmarkManager.searchBookmarks(query);
          if (matches.length === 0) {
            return `No bookmarks matched "${query}"`;
          }

          const lines = matches.map(({ bookmark, folder, matchedFields }) => {
            const folderLabel =
              bookmark.folderId === "unsorted"
                ? "Unsorted"
                : (folder?.name ?? bookmark.folderId);
            return `- ${bookmark.title} | ${bookmark.url} | folder=${folderLabel} | matched=${matchedFields.join(",")} | id=${bookmark.id}${bookmark.note ? ` | note: ${bookmark.note}` : ""}`;
          });
          return [`Matches for "${query}" (${matches.length})`, ...lines].join(
            "\n",
          );
        }

        case "create_bookmark_folder": {
          const name = typeof args.name === "string" ? args.name.trim() : "";
          const summary =
            typeof args.summary === "string" && args.summary.trim()
              ? args.summary.trim()
              : undefined;
          if (!name) return "Error: Folder name is required";
          const existing = bookmarkManager
            .getState()
            .folders.find(
              (folder) => folder.name.toLowerCase() === name.toLowerCase(),
            );
          if (existing) {
            return composeFolderAwareResponse(
              `Folder "${existing.name}" already exists (id=${existing.id})`,
            );
          }
          const folder = bookmarkManager.createFolderWithSummary(name, summary);
          return composeFolderAwareResponse(
            `Created folder "${folder.name}" (id=${folder.id})`,
          );
        }

        case "save_bookmark": {
          const resolvedSelector =
            wc &&
            (typeof args.index === "number" ||
              typeof args.selector === "string")
              ? await resolveSelector(wc, args.index, args.selector)
              : null;
          const source = await resolveBookmarkSourceDraft(wc, {
            explicitUrl: args.url,
            explicitTitle: args.title,
            resolvedSelector,
          });
          if ("error" in source) return `Error: ${source.error}`;

          const target = resolveBookmarkFolderTarget(args);
          if (target.error) return target.error;
          const note =
            typeof args.note === "string" && args.note.trim()
              ? args.note.trim()
              : undefined;
          const onDuplicate =
            typeof args.onDuplicate === "string" &&
            ["ask", "update", "duplicate"].includes(args.onDuplicate)
              ? (args.onDuplicate as bookmarkManager.DuplicateBookmarkPolicy)
              : "ask";
          const result = bookmarkManager.saveBookmarkWithPolicy(
            source.url,
            source.title,
            target.folderId,
            note,
            {
              onDuplicate,
              extra: getBookmarkMetadataFromArgs(args),
            },
          );
          if (result.status === "conflict" && result.existing) {
            return composeFolderAwareResponse(
              composeDuplicateBookmarkResponse({
                url: source.url,
                folderName: describeFolder(target.folderId),
                bookmarkId: result.existing.id,
              }),
              target.createdFolder,
            );
          }
          const bookmark = result.bookmark;
          if (!bookmark) return "Error: Bookmark save failed";
          const verb = result.status === "updated" ? "Updated" : "Saved";
          return composeFolderAwareResponse(
            `${verb} "${bookmark.title}" (${bookmark.url}) in "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
            target.createdFolder,
          );
        }

        case "organize_bookmark": {
          const target = resolveBookmarkFolderTarget(args);
          if (target.error) return target.error;

          const bookmarkId =
            typeof args.bookmarkId === "string" ? args.bookmarkId.trim() : "";
          const note =
            typeof args.note === "string" && args.note.trim()
              ? args.note.trim()
              : undefined;
          const resolvedSelector =
            wc &&
            (typeof args.index === "number" ||
              typeof args.selector === "string")
              ? await resolveSelector(wc, args.index, args.selector)
              : null;
          const source = await resolveBookmarkSourceDraft(wc, {
            explicitUrl: args.url,
            explicitTitle: args.title,
            resolvedSelector,
          });

          const existing = bookmarkId
            ? bookmarkManager.getBookmark(bookmarkId)
            : "error" in source
              ? undefined
              : bookmarkManager.getBookmarkByUrl(source.url);
          if (bookmarkId && !existing) {
            return `Bookmark ${bookmarkId} not found`;
          }

          if (existing) {
            const updated = bookmarkManager.updateBookmark(existing.id, {
              folderId: target.folderId,
              title:
                typeof args.title === "string" && args.title.trim()
                  ? args.title.trim()
                  : undefined,
              note,
              ...getBookmarkMetadataFromArgs(args),
            });
            if (!updated) {
              return `Bookmark ${existing.id} not found`;
            }
            return composeFolderAwareResponse(
              `Organized existing bookmark "${updated.title}" into "${describeFolder(updated.folderId)}" (id=${updated.id})`,
              target.createdFolder,
            );
          }

          if ("error" in source) return `Error: ${source.error}`;

          const result = bookmarkManager.saveBookmarkWithPolicy(
            source.url,
            source.title,
            target.folderId,
            note,
            {
              onDuplicate: "update",
              extra: getBookmarkMetadataFromArgs(args),
            },
          );
          const bookmark = result.bookmark;
          if (!bookmark) return "Error: Bookmark save failed";
          return composeFolderAwareResponse(
            `Saved and organized "${bookmark.title}" (${bookmark.url}) into "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
            target.createdFolder,
          );
        }

        case "archive_bookmark": {
          const target = resolveBookmarkFolderTarget({ archive: true });
          if (target.error) return target.error;

          const bookmarkId =
            typeof args.bookmarkId === "string" ? args.bookmarkId.trim() : "";
          const note =
            typeof args.note === "string" && args.note.trim()
              ? args.note.trim()
              : undefined;
          const resolvedSelector =
            wc &&
            (typeof args.index === "number" ||
              typeof args.selector === "string")
              ? await resolveSelector(wc, args.index, args.selector)
              : null;
          const source = await resolveBookmarkSourceDraft(wc, {
            explicitUrl: args.url,
            explicitTitle: args.title,
            resolvedSelector,
          });

          const existing = bookmarkId
            ? bookmarkManager.getBookmark(bookmarkId)
            : "error" in source
              ? undefined
              : bookmarkManager.getBookmarkByUrl(source.url);
          if (bookmarkId && !existing) {
            return `Bookmark ${bookmarkId} not found`;
          }

          if (existing) {
            const updated = bookmarkManager.updateBookmark(existing.id, {
              folderId: target.folderId,
              title:
                typeof args.title === "string" && args.title.trim()
                  ? args.title.trim()
                  : undefined,
              note,
            });
            if (!updated) {
              return `Bookmark ${existing.id} not found`;
            }
            return composeFolderAwareResponse(
              `Archived bookmark "${updated.title}" into "${describeFolder(updated.folderId)}" (id=${updated.id})`,
              target.createdFolder,
            );
          }

          if ("error" in source) {
            return bookmarkId
              ? `Bookmark ${bookmarkId} not found`
              : `Error: ${source.error}`;
          }

          const bookmark = bookmarkManager.saveBookmark(
            source.url,
            source.title,
            target.folderId,
            note,
          );
          return composeFolderAwareResponse(
            `Saved and archived "${bookmark.title}" (${bookmark.url}) into "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
            target.createdFolder,
          );
        }

        case "open_bookmark": {
          const bookmarkId =
            typeof args.bookmarkId === "string" ? args.bookmarkId.trim() : "";
          if (!bookmarkId) return "Error: bookmarkId is required";

          const bookmark = bookmarkManager.getBookmark(bookmarkId);
          if (!bookmark) {
            return `Bookmark ${bookmarkId} not found`;
          }

          const validation = await validateLinkDestination(bookmark.url);
          if (validation.status === "dead") {
            return formatDeadLinkMessage(bookmark.title, validation);
          }

          const openInNewTab = Boolean(args.newTab);
          if (openInNewTab || !tabId || !wc) {
            const createdId = ctx.tabManager.createTab(bookmark.url);
            const created = ctx.tabManager.getActiveTab();
            if (created) {
              await waitForLoad(created.view.webContents);
            }
            return `Opened bookmark "${bookmark.title}" in new tab ${createdId}`;
          }

          ctx.tabManager.navigateTab(tabId, bookmark.url);
          await waitForLoad(wc);
          return `Opened bookmark "${bookmark.title}" in current tab`;
        }

        case "highlight": {
          if (!wc) return "Error: No active tab";
          const selector = await resolveSelector(wc, args.index, args.selector);
          const highlightColor = args.color || "yellow";
          const highlightText = normalizeLooseString(args.text);
          const url = wc.getURL();

          // Persist highlight to database so it survives navigation/reload
          if (url && url !== "about:blank") {
            highlightsManager.addHighlight(
              url,
              typeof selector === "string" ? selector : undefined,
              highlightText,
              typeof args.label === "string" ? args.label : undefined,
              highlightColor,
              "agent",
            );
          }

          return highlightOnPage(
            wc,
            selector,
            highlightText,
            args.label,
            args.durationMs,
            highlightColor,
          );
        }

        case "clear_highlights": {
          if (!wc) return "Error: No active tab";
          return clearHighlights(wc);
        }

        // --- Speedee System ---

        case "flow_start": {
          const goal = typeof args.goal === "string" ? args.goal : "";
          const steps = coerceStringArray(args.steps) ?? [];
          if (!goal || steps.length === 0)
            return "Error: goal and steps are required";
          const flow = ctx.runtime.startFlow(goal, steps, wc?.getURL());
          return `Flow started: ${flow.goal}\n${flow.steps.map((s, i) => `  ${i === 0 ? "→" : " "} ${s.label}`).join("\n")}`;
        }

        case "flow_advance": {
          const flow = ctx.runtime.advanceFlow(
            typeof args.detail === "string" ? args.detail : undefined,
          );
          if (!flow) return "No active flow to advance";
          return `Step completed.${ctx.runtime.getFlowContext()}`;
        }

        case "flow_status": {
          const flow = ctx.runtime.getFlowState();
          if (!flow) return "No active workflow.";
          return ctx.runtime.getFlowContext();
        }

        case "flow_end": {
          ctx.runtime.clearFlow();
          return "Workflow ended.";
        }

        case "undo_last_action": {
          const undone = ctx.runtime.undoLastAction();
          if (!undone) return "Nothing to undo. No undo snapshots available.";
          return `Undid action: ${undone}. Browser restored to state before that action.`;
        }

        case "suggest": {
          if (!wc) return "No active tab. Use navigate to open a page.";
          let page;
          try {
            page = await extractContent(wc);
          } catch (err) {
            logger.warn("Failed to extract content for suggest:", err);
            return "Could not read page. Try navigate to a working URL.";
          }

          const suggestions: string[] = [];
          suggestions.push(`Page: ${page.title || "(untitled)"}`);
          suggestions.push(`URL: ${page.url}`);
          suggestions.push("");

          const flowCtx = ctx.runtime.getFlowContext();
          if (flowCtx) {
            suggestions.push(flowCtx);
            suggestions.push("");
          }

          const hasPasswordField = page.forms.some((f) =>
            f.fields.some((el) => el.inputType === "password"),
          );
          const hasSearchInput = page.interactiveElements.some(
            (el) =>
              el.inputType === "search" ||
              el.name === "q" ||
              el.name === "query" ||
              (el.placeholder || "").toLowerCase().includes("search"),
          );
          const formCount = page.forms.length;
          const totalFields = page.forms.reduce(
            (n, f) => n + f.fields.length,
            0,
          );
          const linkCount = page.interactiveElements.filter(
            (el) => el.type === "link",
          ).length;
          const hasPagination = page.interactiveElements.some(
            (el) =>
              (el.text || "").toLowerCase() === "next" ||
              el.text === "›" ||
              el.text === "»",
          );
          const hasOverlays = page.overlays.some((o) => o.blocksInteraction);
          const hasCookieConsent = page.overlays.some(
            (overlay) =>
              overlay.blocksInteraction && overlay.kind === "cookie_consent",
          );

          if (hasOverlays) {
            suggestions.push("BLOCKING OVERLAY detected — dismiss it first:");
            if (hasCookieConsent) {
              suggestions.push("  → accept_cookies for consent banners");
              suggestions.push("  → clear_overlays only if consent handling does not unblock the page");
            } else {
              suggestions.push("  → clear_overlays for stacked modals");
              suggestions.push("  → or dismiss_popup for a single popup");
            }
            suggestions.push("");
          }

          if (hasPasswordField) {
            suggestions.push("LOGIN PAGE detected:");
            suggestions.push(
              "  → login(username, password) — handles the full flow",
            );
            suggestions.push(
              "  → Or fill_form + submit_form for manual control",
            );
          } else if (hasSearchInput && linkCount < 10) {
            suggestions.push("SEARCH PAGE detected:");
            suggestions.push(
              "  → search(query) — finds the box, types, submits",
            );
          } else if (hasSearchInput && linkCount >= 10) {
            suggestions.push("SEARCH RESULTS detected:");
            suggestions.push(
              "  → inspect_element(index) to inspect one result card",
            );
            suggestions.push("  → click on a result link");
            if (hasPagination)
              suggestions.push("  → paginate('next') for more results");
          } else if (formCount > 0) {
            suggestions.push(`FORM detected (${totalFields} fields):`);
            suggestions.push("  → fill_form(fields) — fill all fields at once");
          } else if (hasPagination) {
            suggestions.push("PAGINATED CONTENT:");
            suggestions.push(
              "  → read_page(mode='results_only') to inspect likely results",
            );
            suggestions.push("  → paginate('next') for the next page");
          } else if (
            page.content.length > 3000 &&
            page.interactiveElements.length < 10
          ) {
            suggestions.push("ARTICLE/CONTENT page:");
            suggestions.push("  → read_page(mode='summary') for a fast brief");
            suggestions.push(
              "  → read_page(mode='text_only') for readable text",
            );
            suggestions.push("  → scroll to see more");
          } else {
            suggestions.push("GENERAL PAGE:");
            suggestions.push(
              "  → read_page(mode='visible_only') to inspect active controls",
            );
            suggestions.push("  → click on any element by index");
            suggestions.push("  → navigate to go somewhere new");
          }

          suggestions.push("");
          suggestions.push(
            `Available: ${page.interactiveElements.length} interactive elements, ${formCount} forms, ${linkCount} links`,
          );
          return suggestions.join("\n");
        }

        case "fill_form": {
          if (!wc) return "Error: No active tab";
          const fields = Array.isArray(args.fields) ? args.fields : [];
          if (fields.length === 0) return "Error: No fields provided";
          const fillResults = await fillFormFields(wc, fields);
          const results = fillResults.map((item) => item.result);
          if (args.submit) {
            const firstSel =
              fillResults.find((item) => item.selector)?.selector ?? null;
            if (firstSel) {
              const beforeUrl = wc.getURL();
              const submitResult = await submitForm(wc, { selector: firstSel });
              await waitForPotentialNavigation(wc, beforeUrl);
              const afterUrl = wc.getURL();
              results.push(
                afterUrl !== beforeUrl
                  ? `Submitted → ${afterUrl}`
                  : submitResult,
              );
            }
          }
          return `Filled ${results.length} field(s):\n${results.join("\n")}`;
        }

        case "login": {
          if (!wc) return "Error: No active tab";
          const steps: string[] = [];

          if (typeof args.url === "string" && args.url.trim()) {
            const id = ctx.tabManager.getActiveTabId()!;
            ctx.tabManager.navigateTab(id, args.url);
            await waitForLoad(wc);
            steps.push(`Navigated to ${wc.getURL()}`);
          }

          const userSel =
            args.username_selector ||
            (await executePageScript<string | null>(
              wc,
              `
              (function() {
                var el = document.querySelector('input[type="email"], input[name="email"], input[name="username"], input[name="user"], input[autocomplete="username"], input[autocomplete="email"], input[type="text"]:not([name="search"]):not([name="q"])');
                return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
              })()
            `,
              {
                label: "find username field",
              },
            ));
          if (!userSel)
            return "Error: Could not find username/email field. Try providing username_selector.";

          const passSel =
            args.password_selector ||
            (await executePageScript<string | null>(
              wc,
              `
              (function() {
                var el = document.querySelector('input[type="password"]');
                return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
              })()
            `,
              {
                label: "find password field",
              },
            ));
          if (!passSel)
            return "Error: Could not find password field. Try providing password_selector.";

          const userResult = await setElementValue(
            wc,
            userSel,
            String(args.username || ""),
          );
          steps.push(userResult);
          const passResult = await setElementValue(
            wc,
            passSel,
            String(args.password || ""),
          );
          steps.push(passResult);

          const beforeUrl = wc.getURL();
          if (args.submit_selector) {
            await clickResolvedSelector(wc, args.submit_selector);
          } else {
            const clicked = await executePageScript<boolean>(
              wc,
              `
              (function() {
                var btn = document.querySelector('button[type="submit"], input[type="submit"], form button:not([type="button"])');
                if (btn) { btn.click(); return true; }
                var form = document.querySelector('input[type="password"]')?.closest('form');
                if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return true; }
                return false;
              })()
            `,
              {
                label: "submit login form",
              },
            );
            if (clicked === PAGE_SCRIPT_TIMEOUT) {
              return pageBusyError("login");
            }
            if (!clicked)
              return (
                steps.join("\n") +
                "\nWarning: Could not find submit button. Credentials filled but form not submitted."
              );
          }

          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          steps.push(
            afterUrl !== beforeUrl
              ? `Submitted → ${afterUrl}`
              : "Form submitted (same page)",
          );
          return `Login flow complete:\n${steps.join("\n")}`;
        }

        case "search": {
          if (!wc) return "Error: No active tab";
          return searchPage(wc, args);
        }

        case "paginate": {
          if (!wc) return "Error: No active tab";
          const beforeUrl = wc.getURL();

          if (args.selector) {
            return clickResolvedSelector(wc, args.selector);
          }

          const isNext = args.direction === "next";
          const clicked = await executePageScript<boolean>(
            wc,
            `
            (function() {
              var patterns = ${
                isNext
                  ? '["next", "Next", "›", "»", "→", ">", "Next Page", "Load More"]'
                  : '["prev", "Prev", "Previous", "‹", "«", "←", "<", "Previous Page"]'
              };
              var links = document.querySelectorAll('a, button');
              for (var i = 0; i < links.length; i++) {
                var el = links[i];
                var text = (el.textContent || '').trim();
                var ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
                var rel = (el.getAttribute('rel') || '').toLowerCase();
                if (rel === '${isNext ? "next" : "prev"}') { el.click(); return true; }
                for (var j = 0; j < patterns.length; j++) {
                  if (text === patterns[j] || ariaLabel.includes(patterns[j].toLowerCase())) {
                    el.click();
                    return true;
                  }
                }
              }
              return false;
            })()
          `,
            {
              label: "paginate",
            },
          );
          if (clicked === PAGE_SCRIPT_TIMEOUT) {
            return pageBusyError("paginate");
          }

          if (!clicked)
            return `Error: Could not find ${args.direction} pagination control. Try providing a selector.`;

          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          return afterUrl !== beforeUrl
            ? `Paginated ${args.direction} → ${afterUrl}`
            : `Clicked ${args.direction} (page may have updated dynamically)`;
        }

        case "accept_cookies": {
          if (!wc) return "Error: No active tab";
          const dismissed = await tryAcceptCookiesQuickly(wc);
          if (dismissed === PAGE_SCRIPT_TIMEOUT) {
            return pageBusyError("accept_cookies");
          }
          if (dismissed) return dismissed.message;

          return "No cookie consent banner detected. Try dismiss_popup for other overlays.";
        }

        case "extract_table": {
          if (!wc) return "Error: No active tab";
          const selector = args.selector
            ? args.selector
            : args.index != null
              ? await resolveSelector(wc, args.index, undefined)
              : null;
          const tableJson = await wc.executeJavaScript(`
            (function() {
              var table = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.querySelector('table')"};
              if (!table) return null;
              var headers = [];
              var headerRow = table.querySelector('thead tr') || table.querySelector('tr');
              if (headerRow) {
                headerRow.querySelectorAll('th, td').forEach(function(cell) {
                  headers.push(cell.textContent.trim());
                });
              }
              var rows = [];
              var bodyRows = table.querySelectorAll('tbody tr');
              if (bodyRows.length === 0) bodyRows = table.querySelectorAll('tr');
              bodyRows.forEach(function(tr, idx) {
                if (idx === 0 && headers.length > 0 && !table.querySelector('thead')) return;
                var row = {};
                tr.querySelectorAll('td, th').forEach(function(cell, ci) {
                  var key = headers[ci] || ("col_" + ci);
                  row[key] = cell.textContent.trim();
                });
                if (Object.keys(row).length > 0) rows.push(row);
              });
              return { headers: headers, rows: rows, rowCount: rows.length };
            })()
          `);
          if (!tableJson) return "Error: No table found on the page.";
          return `Extracted table (${tableJson.rowCount} rows):\n${JSON.stringify(tableJson, null, 2)}`;
        }

        case "metrics": {
          const m = ctx.runtime.getMetrics();
          const lines = [
            `Session Metrics:`,
            `  Total actions: ${m.totalActions}`,
            `  Completed: ${m.completedActions}`,
            `  Failed: ${m.failedActions}`,
            `  Average duration: ${m.averageDurationMs}ms`,
            ``,
            `Tool breakdown:`,
          ];
          for (const [name, stats] of Object.entries(m.toolBreakdown)) {
            lines.push(
              `  ${name}: ${stats.count} calls, avg ${stats.avgMs}ms${stats.errors > 0 ? `, ${stats.errors} errors` : ""}`,
            );
          }
          return lines.join("\n");
        }

        case "scroll_to_element": {
          if (!wc) return "Error: No active tab";
          let sel: string | null | typeof PAGE_SCRIPT_TIMEOUT = null;
          const textTarget =
            typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";
          if (textTarget) {
            if (isInvalidTextTargetQuery(textTarget)) {
              return `Error: "${textTarget}" looks like HTML or markup, not visible page text. Use a section title or element index instead.`;
            }
            sel = await resolveTargetByText(wc, textTarget, "context");
          } else {
            sel = await resolveSelector(wc, args.index, args.selector);
          }
          if (sel === PAGE_SCRIPT_TIMEOUT) return pageBusyError("scroll_to_element");
          if (!sel) {
            return "Error: Provide an index, selector, or visible text for the element to scroll to.";
          }
          const block =
            args.position === "top"
              ? "start"
              : args.position === "bottom"
                ? "end"
                : "center";
          if (sel.startsWith("__vessel_idx:")) {
            const idx = Number(sel.slice("__vessel_idx:".length));
            return wc.executeJavaScript(`
              (function() {
                var el = window.__vessel?.interactByIndex && Object.values(window.__vessel)[2];
                var ref = (function() { try { return document.querySelector('[data-vessel-idx="${idx}"]'); } catch(e) { return null; } })();
                if (!ref) return "Error: Element not found";
                ref.scrollIntoView({ behavior: "smooth", block: "${block}" });
                return "Scrolled to element #${idx}";
              })()
            `);
          }
          if (sel.includes(" >>> ")) {
            return wc.executeJavaScript(`
              (function() {
                var el = window.__vessel?.resolveShadowSelector?.(${JSON.stringify(sel)});
                if (!el) return "Error: Shadow DOM element not found";
                el.scrollIntoView({ behavior: "smooth", block: "${block}" });
                return "Scrolled to shadow DOM element";
              })()
            `);
          }
          return wc.executeJavaScript(`
            (function() {
              var el = document.querySelector(${JSON.stringify(sel)});
              if (!el) return "Error: Element not found";
              el.scrollIntoView({ behavior: "smooth", block: "${block}" });
              return "Scrolled to element";
            })()
          `);
        }

        default:
          return `Unknown tool: ${name}`;
      }
    },
  });

  const formattedResult =
    ctx.toolProfile === "compact"
      ? formatCompactToolResult(name, result)
      : result;
  const flowCtx = ctx.runtime.getFlowContext();

  // When a click causes navigation, include a lightweight page snapshot so the
  // model can see interactive elements without calling read_page. This prevents
  // the click→read_page→click→read_page loop.
  let clickNavSummary = "";
  if (
    name === "click" &&
    !result.startsWith("Error") &&
    !result.startsWith("Blocked") &&
    result.includes(" -> ")
  ) {
    const summaryWc = ctx.tabManager.getActiveTab()?.view.webContents;
    if (summaryWc) {
      clickNavSummary = await getPostClickNavSummary(
        summaryWc,
        ctx.toolProfile,
      );
    }
  }

  // Detect rapid same-page click streaks: the model keeps clicking elements
  // on the same URL without verifying what happened. After CLICK_STREAK_THRESHOLD
  // consecutive clicks, append a strong warning.
  let streakWarning = "";
  if (name === "click" && !result.startsWith("Error") && !result.startsWith("Blocked")) {
    const currentUrl = ctx.tabManager.getActiveTab()?.view.webContents.getURL() ?? "";
    if (currentUrl === clickStreakUrl) {
      clickStreakCount++;
    } else {
      clickStreakUrl = currentUrl;
      clickStreakCount = 1;
    }
    if (clickStreakCount >= CLICK_STREAK_THRESHOLD) {
      streakWarning =
        `\nWARNING: You have clicked ${clickStreakCount} elements on this page without verifying the result. ` +
        `Call read_page or inspect_element to check the current page state before clicking again. ` +
        `If clicks are having no effect, the elements may not be interactive — try different element indices or read the page to find clickable links.`;
    }
  } else if (["read_page", "inspect_element", "screenshot", "wait_for"].includes(name)) {
    // Verification tools reset the streak
    clickStreakCount = 0;
    clickStreakUrl = null;
  }

  return (
    formattedResult +
    (await getPostActionState(ctx, name)) +
    clickNavSummary +
    streakWarning +
    flowCtx
  );
}
