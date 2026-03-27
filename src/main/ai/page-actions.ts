import type { WebContents } from "electron";
import type { AgentCheckpoint } from "../../shared/types";
import type { AgentRuntime } from "../agent/runtime";
import { resolveBookmarkSourceDraft } from "../bookmarks/page-source";
import * as bookmarkManager from "../bookmarks/manager";
import {
  buildOverlayInventory,
  getBlockingOverlaySignature,
} from "../content/overlay-inventory";
import * as highlightsManager from "../highlights/manager";
import { highlightOnPage, clearHighlights } from "../highlights/inject";
import {
  captureLiveHighlightSnapshot,
  formatLiveSelectionSection,
} from "../highlights/live-snapshot";
import { extractContent } from "../content/extractor";

import { findSelectorByIndex } from "../mcp/indexed-selector";
import {
  formatDeadLinkMessage,
  validateLinkDestination,
} from "../network/link-validation";
import { assertSafeURL } from "../network/url-safety";
import { captureScreenshot } from "../content/screenshot";
import { makeImageResult } from "./tool-result";
import { isToolGated, isFeatureGated } from "../premium/manager";
import { trackToolCall } from "../telemetry/posthog";
import * as namedSessionManager from "../sessions/manager";
import type { TabManager } from "../tabs/tab-manager";
import {
  coerceOptionalNumber,
  coerceStringArray,
  normalizeLooseString,
} from "../tools/input-coercion";
import {
  buildScopedContext,
  buildStructuredContext,
  chooseAgentReadMode,
  type ExtractMode,
} from "./context-builder";

export interface ActionContext {
  tabManager: TabManager;
  runtime: AgentRuntime;
}

export interface FillFormFieldInput {
  index?: number;
  selector?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  value: string;
}

export interface FillFormFieldResult {
  field: FillFormFieldInput;
  selector: string | null;
  result: string;
}

const DEFAULT_PAGE_SCRIPT_TIMEOUT_MS = 1500;
const QUIET_NAVIGATION_WINDOW_MS = 1200;
const PAGE_SCRIPT_TIMEOUT = Symbol("page-script-timeout");

function pageBusyError(action: string): string {
  return `Error: Page is still busy; ${action} timed out waiting for page scripts. Retry in a moment.`;
}

/**
 * Ultra-fast viewport scan — shows what a human would see on the screen.
 * Uses textContent (no layout reflow) and queries only visible-in-viewport
 * elements. Designed to work even when the page JS thread is saturated
 * with ads, video players, and tracking scripts.
 *
 * Returns: title, URL, visible headings, in-viewport links/buttons/inputs,
 * and a compact text snapshot of the main content area.
 */
async function glanceExtract(wc: WebContents): Promise<string> {
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
  } | null>(
    wc,
    `(function() {
      var vw = window.innerWidth || document.documentElement.clientWidth || 0;
      var vh = window.innerHeight || document.documentElement.clientHeight || 0;
      var sy = window.scrollY || window.pageYOffset || 0;

      function inViewport(el) {
        var r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && r.width > 0 && r.height > 0;
      }

      function label(el) {
        return (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 120);
      }

      // Headings visible on screen
      var headings = [];
      document.querySelectorAll('h1, h2, h3, h4').forEach(function(h) {
        if (!inViewport(h)) return;
        var t = (h.textContent || '').trim();
        if (t && t.length < 200) headings.push(h.tagName.toLowerCase() + ': ' + t);
      });

      // Links visible on screen (deduplicated by text)
      var links = [];
      var seenLinks = {};
      var idx = 1;
      document.querySelectorAll('a[href]').forEach(function(a) {
        if (!inViewport(a)) return;
        var t = (a.textContent || '').trim().slice(0, 100);
        if (!t || t.length < 2 || seenLinks[t]) return;
        seenLinks[t] = true;
        links.push({ text: t, href: (a.href || '').slice(0, 200), index: idx++ });
      });

      // Buttons visible on screen
      var buttons = [];
      document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach(function(b) {
        if (!inViewport(b)) return;
        var t = label(b);
        if (!t || t.length < 1) return;
        buttons.push({ text: t, index: idx++ });
      });

      // Input fields visible on screen
      var inputs = [];
      document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea').forEach(function(inp) {
        if (!inViewport(inp)) return;
        var type = (inp.type || inp.tagName.toLowerCase() || '').toLowerCase();
        var lbl = (inp.getAttribute('aria-label') || inp.getAttribute('placeholder') || inp.name || '').trim();
        inputs.push({ type: type, label: lbl.slice(0, 80), placeholder: (inp.getAttribute('placeholder') || '').slice(0, 80), index: idx++ });
      });

      // Content snapshot from main content area using textContent (instant, no reflow)
      var roots = ['main', 'article', '[role="main"]', '#content', '.content', '.story-body'];
      var contentRoot = null;
      for (var i = 0; i < roots.length; i++) {
        contentRoot = document.querySelector(roots[i]);
        if (contentRoot && contentRoot.textContent.trim().length > 50) break;
        contentRoot = null;
      }
      var snippet = '';
      if (contentRoot) {
        snippet = contentRoot.textContent.replace(/[ \\t]+/g, ' ').replace(/(\\n\\s*){3,}/g, '\\n\\n').trim().slice(0, 8000);
      } else {
        // Fallback: grab text from visible elements only
        var parts = [];
        document.querySelectorAll('h1, h2, h3, p, li, td, span, div').forEach(function(el) {
          if (parts.length > 100 || !inViewport(el)) return;
          var t = (el.textContent || '').trim();
          if (t.length > 10 && t.length < 500) parts.push(t);
        });
        snippet = parts.join('\\n').slice(0, 8000);
      }

      return {
        title: document.title || '',
        url: location.href,
        headings: headings.slice(0, 20),
        links: links.slice(0, 40),
        buttons: buttons.slice(0, 20),
        inputs: inputs.slice(0, 15),
        contentSnippet: snippet,
        viewportHeight: vh,
        viewportWidth: vw,
        scrollY: Math.round(sy),
      };
    })()`,
    { timeoutMs: 2500, label: "glance-extract" },
  );

  const elapsed = Date.now() - startMs;

  if (!result || result === PAGE_SCRIPT_TIMEOUT) {
    // Even glance timed out — return bare minimum from Electron APIs
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
    const truncated = result.contentSnippet.length > 6000
      ? result.contentSnippet.slice(0, 6000) + "\n[truncated]"
      : result.contentSnippet;
    sections.push("", "## Page Content (viewport)", "", truncated);
  }

  return sections.join("\n");
}

function normalizeReadPageMode(
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

async function executePageScript<T>(
  wc: WebContents,
  script: string,
  options?: {
    timeoutMs?: number;
    userGesture?: boolean;
    label?: string;
  },
): Promise<T | typeof PAGE_SCRIPT_TIMEOUT | null> {
  if (wc.isDestroyed()) return null;

  const timeoutMs = Math.max(
    150,
    options?.timeoutMs ?? DEFAULT_PAGE_SCRIPT_TIMEOUT_MS,
  );
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const result = await Promise.race([
      wc.executeJavaScript(script, options?.userGesture ?? false) as Promise<T>,
      new Promise<typeof PAGE_SCRIPT_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(PAGE_SCRIPT_TIMEOUT), timeoutMs);
      }),
    ]);

    if (result === PAGE_SCRIPT_TIMEOUT) {
      return PAGE_SCRIPT_TIMEOUT;
    }

    return result as T;
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Probe the page's JS thread until it responds.  Heavy SPAs (Newegg,
 * Wikipedia) can keep the JS thread busy for 10-20s after the HTML
 * loads while React/Vue hydrate, ads initialise, etc.  Any
 * executeJavaScript call made during that window queues behind the
 * busy work and hangs.  This function polls with a tiny script until
 * the thread is free, so subsequent tool calls work immediately.
 */
async function waitForJsReady(wc: WebContents, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await executePageScript<number>(wc, "1", {
      timeoutMs: 250,
      userGesture: true,
      label: "js-ready probe",
    });
    if (ready === 1) return;
    await sleep(250);
  }
}

function waitForLoad(wc: WebContents, timeout = 5000): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;

    const cleanup = () => {
      wc.removeListener("did-finish-load", onLoadEvent);
      wc.removeListener("did-stop-loading", onLoadEvent);
      wc.removeListener("did-fail-load", onLoadEvent);
    };

    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      resolve();
    };

    const onLoadEvent = () => {
      const loading = wc.isLoading();
      if (!loading) {
        finish("load event");
      }
    };

    const timer = setTimeout(() => finish("timeout"), timeout);

    if (!wc.isLoading()) {
      finish("already loaded");
      return;
    }

    wc.on("did-finish-load", onLoadEvent);
    wc.on("did-stop-loading", onLoadEvent);
    wc.on("did-fail-load", onLoadEvent);
  });
}

function waitForPotentialNavigation(
  wc: WebContents,
  beforeUrl: string,
  timeout = 2500,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let waitingForLoad = false;
    const beforeTitle = wc.getTitle();
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poller);
      wc.removeListener("did-start-loading", onStart);
      wc.removeListener("did-navigate", onNavigate);
      wc.removeListener("did-navigate-in-page", onNavigateInPage);
      wc.removeListener("did-stop-loading", onNativeChange);
      wc.removeListener("page-title-updated", onNativeChange);
      resolve();
    };
    const finishAfterLoad = () => {
      if (waitingForLoad) return;
      waitingForLoad = true;
      void waitForLoad(wc, timeout).then(finish);
    };
    const onNativeChange = () => {
      if (wc.isLoading()) {
        finishAfterLoad();
        return;
      }
      if (wc.getURL() !== beforeUrl || wc.getTitle() !== beforeTitle) {
        finish();
      }
    };
    const onStart = () => {
      finishAfterLoad();
    };
    const onNavigate = () => {
      finishAfterLoad();
    };
    const onNavigateInPage = () => finish();
    const timer = setTimeout(
      finish,
      Math.min(timeout, QUIET_NAVIGATION_WINDOW_MS),
    );
    const poller = setInterval(onNativeChange, 100);

    if (
      wc.getURL() !== beforeUrl ||
      wc.getTitle() !== beforeTitle ||
      wc.isLoading()
    ) {
      onNativeChange();
      return;
    }

    wc.once("did-start-loading", onStart);
    wc.once("did-navigate", onNavigate);
    wc.once("did-navigate-in-page", onNavigateInPage);
    wc.on("did-stop-loading", onNativeChange);
    wc.on("page-title-updated", onNativeChange);
  });
}

/**
 * Grab the page title and do a fast overlay probe. The probe is fire-and-forget
 * with a 1.5s timeout so it never blocks the navigate response significantly.
 */
async function getPostNavSummary(wc: WebContents): Promise<string> {
  const title = wc.getTitle();
  const titleLine = title ? `\nPage title: ${title}` : "";

  // Quick probe: detect blocking overlays via common signals without a full extraction
  const overlaySignal = await executePageScript<string | null>(
    wc,
    `(function() {
      var signals = [];
      // Body scroll lock is a strong overlay signal
      var bodyStyle = window.getComputedStyle(document.body);
      var htmlStyle = window.getComputedStyle(document.documentElement);
      if (bodyStyle.overflow === 'hidden' || htmlStyle.overflow === 'hidden') {
        signals.push('body-scroll-locked');
      }
      // Check for known consent manager containers
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
        } catch(e) {}
      }
      // Check for large fixed/sticky elements covering viewport
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

async function scrollPage(
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        return { error: "Error[hidden]: Element has no visible area" };
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
): Promise<{ text: string; href?: string } | { error: string }> {
  const result = await executePageScript<{
    text?: string;
    href?: string;
    error?: string;
  }>(
    wc,
    `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "Element not found" };
      const anchor = el instanceof HTMLAnchorElement ? el : el.closest("a[href]");
      const text = (el.textContent || el.tagName || "Element").trim().slice(0, 100);
      return {
        text: text || "Element",
        href: anchor instanceof HTMLAnchorElement ? anchor.href : undefined,
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
      label: string;
      type: string;
      selector: string;
      href?: string;
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

      function escapeSelectorValue(value) {
        if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
          return CSS.escape(value);
        }
        return String(value).replace(/["\\\\]/g, "\\\\$&");
      }

      function uniqueSelector(candidate) {
        if (!candidate) return null;
        try {
          return document.querySelectorAll(candidate).length === 1 ? candidate : null;
        } catch {
          return null;
        }
      }

      function uniqueAttributeSelector(el, attribute) {
        const value = text(el.getAttribute && el.getAttribute(attribute));
        if (!value) return null;
        const candidate = el.tagName.toLowerCase() + "[" + attribute + "=\\"" + escapeSelectorValue(value) + "\\"]";
        return uniqueSelector(candidate);
      }

      function selectorFor(el) {
        if (!el) return null;
        if (el.id) return "#" + escapeSelectorValue(el.id);
        for (const attribute of ["data-testid", "name", "form", "aria-label", "title"]) {
          const candidate = uniqueAttributeSelector(el, attribute);
          if (candidate) return candidate;
        }
        const parts = [];
        let current = el;
        while (current) {
          if (current.id) {
            parts.unshift("#" + escapeSelectorValue(current.id));
            break;
          }
          const tag = current.tagName.toLowerCase();
          const parent = current.parentElement;
          if (!parent) { parts.unshift(tag); break; }
          const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          const index = siblings.indexOf(current) + 1;
          parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
          current = parent;
        }
        const selector = parts.join(" > ");
        return uniqueSelector(selector) || selector;
      }

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
      region.querySelectorAll("a[href], button, input:not([type='hidden']), select, textarea").forEach((el) => {
        if (!(el instanceof HTMLElement) || !isVisible(el)) return;
        const candidateSelector = selectorFor(el);
        if (!candidateSelector || seen.has(candidateSelector)) return;
        seen.add(candidateSelector);
        nearby.push({
          label: labelFor(el).slice(0, 100),
          type: el.tagName.toLowerCase(),
          selector: candidateSelector,
          href: el instanceof HTMLAnchorElement ? text(el.href) : undefined,
        });
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
      lines.push(
        `- ${item.label} [${item.type}] selector=${item.selector}${hrefSuffix}`,
      );
    }
  }

  return lines.join("\n");
}

async function getLocaleSnapshot(
  wc: WebContents,
): Promise<{ lang: string; url: string; title: string } | null> {
  const snapshot = await executePageScript<{
    lang?: string;
    url?: string;
    title?: string;
  }>(
    wc,
    `
    (function() {
      return {
        lang:
          document.documentElement?.lang ||
          document.body?.lang ||
          navigator.language ||
          "",
        url: window.location.href || "",
        title: document.title || "",
      };
    })()
  `,
    {
      label: "locale snapshot",
    },
  );

  if (
    !snapshot ||
    snapshot === PAGE_SCRIPT_TIMEOUT ||
    typeof snapshot !== "object"
  ) {
    return null;
  }

  return {
    lang: typeof snapshot.lang === "string" ? snapshot.lang.trim() : "",
    url: typeof snapshot.url === "string" ? snapshot.url : wc.getURL(),
    title: typeof snapshot.title === "string" ? snapshot.title : wc.getTitle(),
  };
}

function primaryLanguageTag(value: string): string {
  return value.trim().toLowerCase().split(/[-_]/)[0] || "";
}

function localeChanged(
  before: { lang: string; url: string; title: string } | null,
  after: { lang: string; url: string; title: string } | null,
): boolean {
  if (!before || !after) return false;
  const beforeLang = primaryLanguageTag(before.lang);
  const afterLang = primaryLanguageTag(after.lang);
  if (beforeLang && afterLang && beforeLang !== afterLang) {
    return true;
  }
  const localeHint =
    /[?&](lang|locale|language|hl)=|\/(ja|jp|en|fr|de|es|it|ko|zh)(\/|$)/i;
  return before.url !== after.url && localeHint.test(after.url);
}

async function restoreLocaleSnapshot(
  wc: WebContents,
  snapshot: { lang: string; url: string; title: string } | null,
): Promise<void> {
  if (!snapshot || wc.isDestroyed()) return;

  try {
    if (typeof wc.canGoBack === "function" && wc.canGoBack()) {
      wc.goBack();
      await waitForLoad(wc, 3000);
      const reverted = await getLocaleSnapshot(wc);
      if (!localeChanged(snapshot, reverted)) {
        return;
      }
    }
  } catch {
    // Fall back to reloading the last known-good URL below.
  }

  if (snapshot.url && snapshot.url !== wc.getURL()) {
    try {
      assertSafeURL(snapshot.url);
      await wc.loadURL(snapshot.url);
      await waitForLoad(wc, 3000);
      return;
    } catch {
      // Ignore and let the caller continue with the restored best effort.
    }
  }

  if (snapshot.url) {
    try {
      await wc.reload();
      await waitForLoad(wc, 3000);
    } catch {
      // Best-effort recovery only.
    }
  }
}

const ADD_TO_CART_PATTERNS = [
  "add to cart",
  "add to bag",
  "add to basket",
  "add to my cart",
  "add to my bag",
  "add to my basket",
  "add item to cart",
  "add item to bag",
  "add item to basket",
];

/**
 * Tracks the most recent add-to-cart click per page URL so we can block
 * accidental duplicate clicks that the model fires before reading the page.
 */
const recentCartClicks = new Map<string, { text: string; ts: number }>();
const CART_CLICK_COOLDOWN_MS = 15_000;

function isAddToCartText(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return ADD_TO_CART_PATTERNS.some((p) => normalized.includes(p));
}

function recordCartClick(url: string, text: string): void {
  recentCartClicks.set(url, { text, ts: Date.now() });
  // Prune stale entries
  for (const [key, entry] of recentCartClicks) {
    if (Date.now() - entry.ts > CART_CLICK_COOLDOWN_MS) {
      recentCartClicks.delete(key);
    }
  }
}

function isDuplicateCartClick(url: string, text: string): boolean {
  const recent = recentCartClicks.get(url);
  if (!recent) return false;
  if (Date.now() - recent.ts > CART_CLICK_COOLDOWN_MS) {
    recentCartClicks.delete(url);
    return false;
  }
  return isAddToCartText(text);
}

async function clickResolvedSelector(
  wc: WebContents,
  selector: string,
): Promise<string> {
  // Shadow DOM direct interaction via stored element reference
  if (selector.startsWith("__vessel_idx:")) {
    const idx = Number(selector.slice("__vessel_idx:".length));
    const beforeUrl = wc.getURL();
    // Pre-check: get element text for cart-click guard
    const idxLabel = await executePageScript<string>(
      wc,
      `window.__vessel?.getElementText?.(${idx}) || ""`,
      { label: "shadow element text" },
    );
    if (
      typeof idxLabel === "string" &&
      isAddToCartText(idxLabel) &&
      isDuplicateCartClick(beforeUrl, idxLabel)
    ) {
      return `Blocked: "${idxLabel}" was already clicked on this page. The item is in your cart. Call read_page to see available actions (e.g. View Cart, Continue Shopping).`;
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
    if (typeof idxLabel === "string" && isAddToCartText(idxLabel)) {
      recordCartClick(beforeUrl, idxLabel);
    }
    await waitForPotentialNavigation(wc, beforeUrl);
    const afterUrl = wc.getURL();
    if (afterUrl !== beforeUrl) return `${result} -> ${afterUrl}`;
    const idxOverlay = await detectPostClickOverlay(wc);
    return idxOverlay ? `${result}\n${idxOverlay}` : result;
  }

  // Shadow-piercing selector path
  if (selector.includes(" >>> ")) {
    const beforeUrl = wc.getURL();
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
      isAddToCartText(shadowLabel) &&
      isDuplicateCartClick(beforeUrl, shadowLabel)
    ) {
      return `Blocked: "${shadowLabel}" was already clicked on this page. The item is in your cart. Call read_page to see available actions (e.g. View Cart, Continue Shopping).`;
    }
    const result = await executePageScript<string>(
      wc,
      `
      (function() {
        var el = window.__vessel?.resolveShadowSelector?.(${JSON.stringify(selector)});
        if (!el) return "Error[stale-index]: Shadow DOM element not found — call read_page to refresh.";
        if (el instanceof HTMLElement) { el.focus(); el.click(); }
        return "Clicked: " + (el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 60) || el.tagName.toLowerCase());
      })()
    `,
      {
        label: "shadow click selector",
      },
    );
    if (result === PAGE_SCRIPT_TIMEOUT) return pageBusyError("click");
    if (typeof result === "string" && result.startsWith("Error")) return result;
    if (typeof shadowLabel === "string" && isAddToCartText(shadowLabel)) {
      recordCartClick(beforeUrl, shadowLabel);
    }
    await waitForPotentialNavigation(wc, beforeUrl);
    const afterUrl = wc.getURL();
    if (afterUrl !== beforeUrl) return `${result} -> ${afterUrl}`;
    const shadowOverlay = await detectPostClickOverlay(wc);
    return shadowOverlay ? `${result}\n${shadowOverlay}` : result;
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
  if (!cartMatch && recentCartClicks.has(beforeUrl)) {
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

  // Record add-to-cart clicks BEFORE executing so even if overlay detection
  // fails, a second click on the same page will be caught.
  if (cartMatch) {
    recordCartClick(beforeUrl, elInfo.text);
  }

  const clickText = `Clicked: ${elInfo.text}`;
  const clickResult = await clickElement(wc, selector);
  if (clickResult.startsWith("Error:")) return clickResult;

  await waitForPotentialNavigation(wc, beforeUrl);
  const afterUrl = wc.getURL();
  if (afterUrl !== beforeUrl) {
    return `${clickText} -> ${afterUrl}`;
  }

  const overlayHint = await detectPostClickOverlay(wc);
  if (overlayHint) {
    // If this was a cart click, also fetch dialog actions inline
    const dialogActions = cartMatch ? await getCartDialogActions(wc) : null;
    const actionsSuffix = dialogActions
      ? `\n${dialogActions}\nClick one of these dialog actions. Do NOT click any other element.`
      : "";
    return `${clickText} (${clickResult})\n${overlayHint}${actionsSuffix}`;
  }

  // Do not "recover" cart clicks with a second DOM activation. On sites like
  // Powell's, that fallback can submit Add to Cart twice while the drawer is opening.
  if (cartMatch) {
    return `${clickText} (${clickResult})`;
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

  return `${clickText} (${clickResult})`;
}

/**
 * When a cart dialog is open, extract its interactive actions (buttons/links)
 * so the model can act on them without needing to call read_page.
 */
async function getCartDialogActions(wc: WebContents): Promise<string | null> {
  const result = await executePageScript<{
    found: boolean;
    actions: string[];
  }>(
    wc,
    `
    (function() {
      var dialog = document.querySelector('[role="dialog"], dialog[open], [role="alertdialog"], [aria-modal="true"]');
      if (!dialog) return { found: false, actions: [] };
      var cs = getComputedStyle(dialog);
      if (cs.display === 'none' || cs.visibility === 'hidden') return { found: false, actions: [] };
      var text = (dialog.textContent || '').slice(0, 500).toLowerCase();
      var cartSignals = ['added to cart','added to bag','added to basket',
        'item added','your basket','your cart','your bag',
        'view basket','view cart','continue shopping'];
      var isCart = cartSignals.some(function(s) { return text.indexOf(s) !== -1; });
      if (!isCart) return { found: false, actions: [] };
      var actions = [];
      dialog.querySelectorAll('button, a[href], [role="button"]').forEach(function(el) {
        var cs2 = getComputedStyle(el);
        if (cs2.display === 'none' || cs2.visibility === 'hidden') return;
        var r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) return;
        var label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80);
        if (!label || label.length < 2) return;
        var href = el.getAttribute('href') || '';
        var sel = el.id ? '#' + el.id
          : el.getAttribute('data-test') ? '[data-test="' + el.getAttribute('data-test') + '"]'
          : el.getAttribute('aria-label') ? '[aria-label="' + el.getAttribute('aria-label') + '"]'
          : null;
        if (sel) actions.push({ label: label, selector: sel, href: href });
      });
      return {
        found: true,
        actions: actions.map(function(a) {
          return '- "' + a.label + '"' + (a.href ? ' → ' + a.href : '') + (a.selector ? ' (selector: ' + a.selector + ')' : '');
        }),
      };
    })()
    `,
    { timeoutMs: 800, label: "get cart dialog actions" },
  );

  if (!result || result === PAGE_SCRIPT_TIMEOUT || !result.found) return null;
  if (result.actions.length === 0) return null;

  return `Available dialog actions:\n${result.actions.join("\n")}`;
}

/**
 * Lightweight post-click check: did a dialog / cart-drawer appear?
 * Runs a small DOM query instead of a full extraction so it stays fast.
 */
async function detectPostClickOverlay(wc: WebContents): Promise<string | null> {
  const result = await executePageScript<{
    found: boolean;
    label: string;
    cartLike: boolean;
  }>(
    wc,
    `
    (function() {
      var vw = window.innerWidth || document.documentElement.clientWidth;
      var vh = window.innerHeight || document.documentElement.clientHeight;
      var vpArea = Math.max(1, vw * vh);

      function isVis(el) {
        var cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' &&
          el.getBoundingClientRect().width > 0;
      }

      function hasFixedAncestor(el) {
        var cur = el.parentElement;
        while (cur && cur !== document.body) {
          var ps = getComputedStyle(cur).position;
          if (ps === 'fixed' || ps === 'sticky') return true;
          cur = cur.parentElement;
        }
        return false;
      }

      function effectiveZ(el) {
        var cur = el;
        while (cur && cur !== document.body) {
          var z = parseInt(getComputedStyle(cur).zIndex, 10);
          if (z > 0) return z;
          cur = cur.parentElement;
        }
        return 0;
      }

      function edgePad(r) {
        return r.left <= 24 || r.top <= 24 ||
          r.right >= vw - 24 || r.bottom >= vh - 24;
      }

      var cartPhrases = ['added to cart','added to bag','added to basket',
        'added to your cart','added to your bag','added to your basket'];
      var cartActions = ['view cart','go to cart','continue shopping',
        'keep shopping','checkout','view basket','go to basket'];

      // Phase 1: semantic dialog elements
      var selectors = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
      var candidates = document.querySelectorAll(selectors);
      var hit = null;
      for (var j = 0; j < candidates.length; j++) {
        if (isVis(candidates[j])) { hit = candidates[j]; break; }
      }

      // Phase 2: positioned drawer-like elements
      if (!hit) {
        var els = document.querySelectorAll('*');
        for (var i = 0; i < els.length; i++) {
          var s = getComputedStyle(els[i]);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          var pos = s.position;
          var isFixed = pos === 'fixed' || pos === 'sticky';
          var isAbs = pos === 'absolute';
          if (!isFixed && !isAbs) continue;
          if (isAbs && !hasFixedAncestor(els[i])) continue;
          if (effectiveZ(els[i]) < 5) continue;
          var r = els[i].getBoundingClientRect();
          var area = (r.width * r.height) / vpArea;
          if (r.width >= 160 && r.height >= 100 && area >= 0.05 && edgePad(r)) {
            hit = els[i]; break;
          }
        }
      }

      // Phase 3: text-based fallback — any positioned element with cart confirmation text
      if (!hit) {
        var els2 = document.querySelectorAll('*');
        for (var k = 0; k < els2.length; k++) {
          var s2 = getComputedStyle(els2[k]);
          if (s2.display === 'none' || s2.visibility === 'hidden') continue;
          var p2 = s2.position;
          if (p2 !== 'fixed' && p2 !== 'sticky' && p2 !== 'absolute') continue;
          var r2 = els2[k].getBoundingClientRect();
          if (r2.width < 120 || r2.height < 80) continue;
          var innerText = (els2[k].textContent || '').slice(0, 500).toLowerCase();
          var hasConfirm = cartPhrases.some(function(ph) { return innerText.indexOf(ph) !== -1; });
          if (hasConfirm) { hit = els2[k]; break; }
        }
      }

      if (!hit) return { found: false, label: '', cartLike: false };
      var text = (hit.textContent || '').slice(0, 500).toLowerCase();
      var cartLike = cartPhrases.concat(cartActions).some(function(s) { return text.indexOf(s) !== -1; });
      var label = (hit.getAttribute('aria-label') || (hit.querySelector('h1,h2,h3,h4') || {}).textContent || '').trim().slice(0, 80);
      return { found: true, label: label, cartLike: cartLike };
    })()
    `,
    { timeoutMs: 800, label: "post-click overlay check" },
  );

  if (!result || result === PAGE_SCRIPT_TIMEOUT || !result.found) return null;

  if (result.cartLike) {
    const desc = result.label ? ` ("${result.label}")` : "";
    return `A cart confirmation dialog appeared${desc}. Call read_page to see available actions — do not click Add to Cart again.`;
  }

  const desc = result.label ? ` ("${result.label}")` : "";
  return `A dialog or overlay appeared${desc}. Call read_page to see available actions.`;
}

async function dismissPopup(wc: WebContents): Promise<string> {
  const before = await extractContent(wc);
  const initialBlocking = before.overlays.filter(
    (overlay) => overlay.blocksInteraction,
  ).length;

  // Refuse to dismiss cart confirmation dialogs — the model should interact
  // with the dialog buttons (View Cart, Continue Shopping) instead.
  if (initialBlocking > 0) {
    const overlayText = before.overlays
      .map((o) => [o.label, o.text].filter(Boolean).join(" "))
      .join(" ")
      .toLowerCase();
    const cartSignals = [
      "added to cart",
      "added to bag",
      "added to basket",
      "item added",
      "items in your basket",
      "items in your cart",
      "items in your bag",
      "your basket",
      "your cart",
      "your bag",
      "view basket",
      "view cart",
      "continue shopping",
    ];
    if (cartSignals.some((s) => overlayText.includes(s))) {
      // Instead of refusing, try to click "Continue Shopping" automatically
      const continueResult = await executePageScript<string>(
        wc,
        `
        (function() {
          var dialog = document.querySelector('[role="dialog"], dialog[open], [role="alertdialog"], [aria-modal="true"]');
          if (!dialog) return "Error: dialog not found";
          var buttons = dialog.querySelectorAll('button, a[href], [role="button"]');
          var continueBtn = null;
          var viewCartBtn = null;
          for (var i = 0; i < buttons.length; i++) {
            var label = (buttons[i].getAttribute('aria-label') || buttons[i].textContent || '').trim().toLowerCase();
            if (/continue shopping|keep shopping/.test(label)) { continueBtn = buttons[i]; break; }
            if (/view (basket|cart|bag)|checkout/.test(label) && !viewCartBtn) { viewCartBtn = buttons[i]; }
          }
          var target = continueBtn || viewCartBtn;
          if (!target) return "Error: no dialog action found";
          var actionLabel = (target.getAttribute('aria-label') || target.textContent || '').trim();
          if (target.tagName === 'A' && target.href) {
            window.location.href = target.href;
            return "Clicked: " + actionLabel + " -> " + target.href;
          }
          target.click();
          return "Clicked: " + actionLabel;
        })()
        `,
        { timeoutMs: 1500, label: "cart dialog continue shopping" },
      );

      if (
        continueResult &&
        continueResult !== PAGE_SCRIPT_TIMEOUT &&
        typeof continueResult === "string" &&
        !continueResult.startsWith("Error")
      ) {
        return `Cart confirmation handled: ${continueResult}. Item was already added to your cart.`;
      }

      // Fallback: return refusal with available actions
      const dialogActions = await getCartDialogActions(wc);
      return `Cannot dismiss: this is a cart confirmation dialog. Item is in your cart.${dialogActions ? "\n" + dialogActions + "\nClick one of these instead." : " Use read_page to see dialog actions."}`;
    }
  }

  const initialDormant = before.dormantOverlays.length;
  const initialLocale = await getLocaleSnapshot(wc);

  const candidates = await executePageScript<
    Array<{ selector: string; label?: string; score: number }>
  >(
    wc,
    `
    (function() {
      function text(value) {
        const trimmed = value == null ? "" : String(value).trim();
        return trimmed || "";
      }

      function escapeSelectorValue(value) {
        if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
          return CSS.escape(value);
        }
        return String(value).replace(/["\\\\]/g, "\\\\$&");
      }

      function uniqueSelector(candidate) {
        if (!candidate) return null;
        try {
          return document.querySelectorAll(candidate).length === 1 ? candidate : null;
        } catch {
          return null;
        }
      }

      function selectorFor(el) {
        if (!el) return null;
        if (el.id) return "#" + escapeSelectorValue(el.id);
        const attrs = ["data-testid", "data-test", "aria-label", "name", "title"];
        for (const attr of attrs) {
          const value = text(el.getAttribute && el.getAttribute(attr));
          if (!value) continue;
          const candidate = el.tagName.toLowerCase() + "[" + attr + "=\\"" + escapeSelectorValue(value) + "\\"]";
          const unique = uniqueSelector(candidate);
          if (unique) return unique;
        }
        const parts = [];
        let current = el;
        while (current) {
          if (current.id) {
            parts.unshift("#" + escapeSelectorValue(current.id));
            break;
          }
          const tag = current.tagName.toLowerCase();
          const parent = current.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          const index = siblings.indexOf(current) + 1;
          parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
          current = parent;
        }
        const selector = parts.join(" > ");
        return uniqueSelector(selector) || selector;
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

      function overlayRoots() {
        const nodes = [];
        document.querySelectorAll("dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']").forEach((el) => {
          if (isVisible(el)) nodes.push(el);
        });
        // Detect known consent manager containers by ID/class patterns
        document.querySelectorAll("#onetrust-consent-sdk, #onetrust-banner-sdk, [id*='onetrust'], [class*='onetrust'], #CybotCookiebotDialog, #truste-consent-track, [id*='cookie-banner'], [id*='consent-banner'], [class*='cookie-consent'], [class*='consent-banner'], [id*='gdpr'], [class*='gdpr']").forEach((el) => {
          if (el instanceof HTMLElement && isVisible(el)) nodes.push(el);
        });
        document.querySelectorAll("body *").forEach((el) => {
          if (!(el instanceof HTMLElement) || !isVisible(el)) return;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const zIndex = Number.parseInt(style.zIndex, 10);
          const coversCenter =
            rect.left <= (window.innerWidth || 0) / 2 &&
            rect.right >= (window.innerWidth || 0) / 2 &&
            rect.top <= (window.innerHeight || 0) / 2 &&
            rect.bottom >= (window.innerHeight || 0) / 2;
          if (
            (style.position === "fixed" || style.position === "sticky") &&
            Number.isFinite(zIndex) &&
            zIndex >= 10 &&
            coversCenter
          ) {
            nodes.push(el);
          }
        });
        return Array.from(new Set(nodes));
      }

      function scoreCandidate(el, rooted) {
        const label = text(
          el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.textContent ||
            el.getAttribute("value"),
        ).toLowerCase();
        const classText = text(typeof el.className === "string" ? el.className : "").toLowerCase();
        const idText = text(el.id).toLowerCase();
        const hrefText = text(el.getAttribute && el.getAttribute("href")).toLowerCase();
        const combined = label + " " + classText + " " + idText + " " + hrefText;
        let score = rooted ? 30 : 0;
        if (/^x$|^×$/.test(label)) score += 120;
        if (/no thanks|no, thanks|not now|maybe later|dismiss|close|skip|cancel|continue without|no thank you|reject|decline/.test(label)) score += 100;
        if (/close|dismiss|modal-close|overlay-close/.test(combined)) score += 90;
        // Known consent manager dismiss/reject buttons get a big boost
        if (/onetrust-close|onetrust-reject|cookie.*close|consent.*close|cookie.*reject|consent.*reject/.test(combined)) score += 110;
        // OneTrust "Accept" is valid for dismissing the banner (user just wants it gone)
        if (/onetrust-accept|cookie.*accept|consent.*accept/.test(combined)) score += 80;
        if (el.getAttribute("aria-label")) score += 20;
        if (/(language|locale|region|country|currency)\b/.test(combined)) score -= 320;
        if (/\b(english|japanese|japan|francais|espanol|deutsch|italiano|portuguese|nihongo)\b/.test(label)) score -= 280;
        if (/\u65e5\u672c\u8a9e|\u4e2d\u6587|\ud55c\uad6d\uc5b4/.test(label)) score -= 280;
        if (/[?&](lang|locale|language|hl)=/.test(hrefText)) score -= 260;
        if (/\/(ja|jp|en|fr|de|es|it|ko|zh)(\/|$)/.test(hrefText)) score -= 220;
        // Penalize general accept/subscribe buttons that aren't consent-related
        if (/accept|continue|submit|sign up|subscribe|join|start|next/.test(label) && !/cookie|consent|onetrust/.test(combined)) score -= 80;
        const rect = el.getBoundingClientRect();
        if (rect.top < 120) score += 10;
        if (rect.right > (window.innerWidth || 0) - 120) score += 15;
        return score;
      }

      const selector = "button, [role='button'], a[href], input[type='button'], input[type='submit'], [aria-label], [title]";
      const results = [];
      const roots = overlayRoots();

      function collect(container, rooted) {
        container.querySelectorAll(selector).forEach((el) => {
          if (!(el instanceof HTMLElement) || !isVisible(el)) return;
          const candidateSelector = selectorFor(el);
          if (!candidateSelector) return;
          var label = text(
            el.getAttribute("aria-label") ||
              el.getAttribute("title") ||
              el.textContent ||
              el.getAttribute("value"),
          );
          // Don't skip empty-label buttons from known consent managers
          if (!label) {
            var idLower = (el.id || "").toLowerCase();
            var classLower = (typeof el.className === "string" ? el.className : "").toLowerCase();
            var combined = idLower + " " + classLower;
            if (/onetrust|consent|cookie|banner|gdpr|trustarc|cookiebot/.test(combined)) {
              label = idLower.includes("accept") ? "Accept cookies"
                : idLower.includes("reject") ? "Reject cookies"
                : idLower.includes("close") || classLower.includes("close") ? "Close"
                : "Consent button";
            } else {
              return;
            }
          }
          results.push({
            selector: candidateSelector,
            label: label.slice(0, 120),
            score: scoreCandidate(el, rooted),
          });
        });
      }

      roots.forEach((root) => collect(root, true));
      if (results.length === 0) {
        collect(document, false);
      }

      const seen = new Set();
      return results
        .filter((candidate) => {
          if (seen.has(candidate.selector)) return false;
          seen.add(candidate.selector);
          return candidate.score > 0;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    })()
  `,
    {
      timeoutMs: 2000,
      label: "inspect popup candidates",
    },
  );

  if (candidates === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("dismiss_popup");
  }

  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        typeof candidate.selector !== "string"
      ) {
        continue;
      }
      const result = await clickElement(wc, candidate.selector);
      if (result.startsWith("Error:")) continue;
      await sleep(250);
      const postClickLocale = await getLocaleSnapshot(wc);
      if (localeChanged(initialLocale, postClickLocale)) {
        await restoreLocaleSnapshot(wc, initialLocale);
        continue;
      }
      const after = await extractContent(wc);
      const blocking = after.overlays.filter(
        (overlay) => overlay.blocksInteraction,
      ).length;
      if (
        blocking < initialBlocking ||
        (initialBlocking > 0 && blocking === 0)
      ) {
        const label =
          typeof candidate.label === "string" && candidate.label
            ? candidate.label
            : "popup control";
        return `Dismissed popup using "${label}"`;
      }
    }
  }

  wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await sleep(16);
  wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await sleep(200);

  const afterEscape = await extractContent(wc);
  const escapeBlocking = afterEscape.overlays.filter(
    (overlay) => overlay.blocksInteraction,
  ).length;
  if (
    escapeBlocking < initialBlocking ||
    (initialBlocking > 0 && escapeBlocking === 0)
  ) {
    return "Dismissed popup with Escape";
  }

  return initialBlocking > 0
    ? "Could not dismiss the blocking popup automatically"
    : initialDormant > 0
      ? `No active blocking popup detected. Found ${initialDormant} dormant consent/modal surface(s) in the DOM, likely geo-gated or inactive in this session.`
      : "No blocking popup detected";
}

function describeOverlayState(
  page: Awaited<ReturnType<typeof extractContent>>,
): {
  inventory: ReturnType<typeof buildOverlayInventory>;
  blocking: number;
  total: number;
  signature: string;
} {
  const inventory = buildOverlayInventory(page);
  return {
    inventory,
    blocking: inventory.filter((overlay) => overlay.blocksInteraction).length,
    total: inventory.length,
    signature: getBlockingOverlaySignature(inventory),
  };
}

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

/**
 * Try to dismiss consent overlays that live inside iframes (common for
 * Sourcepoint, OneTrust hosted, TrustArc, etc.). Electron's
 * executeJavaScript only runs in the main frame, so we iterate over all
 * child frames looking for accept/dismiss buttons.
 */
async function tryDismissConsentIframe(wc: WebContents): Promise<string | null> {
  try {
    // Check if body is scroll-locked or a consent container is visible — if not, skip
    const hasSignal = await executePageScript<boolean>(
      wc,
      `(function() {
        var bs = window.getComputedStyle(document.body);
        var hs = window.getComputedStyle(document.documentElement);
        if (bs.overflow === 'hidden' || hs.overflow === 'hidden') return true;
        var sels = '#onetrust-consent-sdk, [class*="consent"], [class*="cookie-banner"], [id*="consent"], [id*="sp_message"], .fc-consent-root, [class*="cmp-"]';
        var el = document.querySelector(sels);
        return !!(el && el.offsetHeight > 20);
      })()`,
      { timeoutMs: 1000, label: "iframe-consent-signal" },
    );
    if (!hasSignal || hasSignal === PAGE_SCRIPT_TIMEOUT) return null;

    // Iterate child frames and try to click consent buttons inside them
    const frames = wc.mainFrame.framesInSubtree;
    for (const frame of frames) {
      if (frame === wc.mainFrame) continue; // skip main frame, already handled
      try {
        const result = await frame.executeJavaScript(`
          (function() {
            var selectors = [
              'button[title*="Accept"], button[title*="Agree"], button[title*="OK"]',
              '[class*="accept"], [class*="agree"], [class*="consent-accept"]',
              'button[aria-label*="accept" i], button[aria-label*="agree" i]',
              '.sp_choice_type_11', '.message-component.message-button',
            ];
            // Try selectors first
            for (var i = 0; i < selectors.length; i++) {
              try {
                var els = document.querySelectorAll(selectors[i]);
                for (var j = 0; j < els.length; j++) {
                  var el = els[j];
                  if (!(el instanceof HTMLElement)) continue;
                  var text = (el.textContent || '').trim().toLowerCase();
                  if (/accept|agree|consent|got it|ok|continue|i understand/i.test(text) || el.offsetHeight > 0) {
                    el.click();
                    return 'Clicked iframe consent button: ' + text.slice(0, 60);
                  }
                }
              } catch(e) {}
            }
            // Text-match fallback on all buttons
            var buttons = document.querySelectorAll('button, [role="button"], a.message-component');
            for (var k = 0; k < buttons.length; k++) {
              var btn = buttons[k];
              var label = (btn.textContent || '').trim().toLowerCase();
              if (/^(accept|agree|accept all|i agree|i accept|ok|got it|allow|continue|yes)$/i.test(label) ||
                  /accept all|agree and|accept & continue|accept and continue/i.test(label)) {
                btn.click();
                return 'Clicked iframe consent button: ' + label.slice(0, 60);
              }
            }
            return null;
          })()
        `);
        if (result) return result;
      } catch {
        // Frame may be cross-origin or destroyed — skip
        continue;
      }
    }
  } catch {
    // framesInSubtree may not be available on older Electron
  }
  return null;
}

export async function clearOverlays(
  wc: WebContents,
  strategy: "auto" | "interactive" = "auto",
): Promise<string> {
  const steps: string[] = [];
  let cleared = 0;
  const maxIterations = 8;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const before = await extractContent(wc);
    const beforeState = describeOverlayState(before);
    const blockingOverlays = beforeState.inventory.filter(
      (overlay) => overlay.blocksInteraction,
    );

    if (blockingOverlays.length === 0) {
      // No blocking overlays in main frame — check for iframe-based consent
      if (cleared === 0) {
        const iframeResult = await tryDismissConsentIframe(wc);
        if (iframeResult) {
          steps.push(`Iframe consent: ${iframeResult}`);
          await sleep(500);
          return steps.join("\n");
        }
        return "No blocking overlays detected";
      }
      steps.push(`Overlays remaining: ${beforeState.total}`);
      steps.push("Page still blocked: false");
      return steps.join("\n");
    }

    const overlay = blockingOverlays[0];
    let actionMessage: string | null = null;

    if (overlay.kind === "cookie_consent") {
      actionMessage = await clickOverlayCandidate(
        wc,
        overlay.acceptAction || overlay.dismissAction || overlay.actions[0],
      );
    } else if (overlay.kind === "selection_modal") {
      if (!overlay.correctOption?.selector) {
        if (strategy === "interactive") {
          steps.push(
            "Stopped: selection modal needs human judgment because no likely-correct option was detected.",
          );
          steps.push(`Overlays remaining: ${beforeState.total}`);
          steps.push("Page still blocked: true");
          return steps.join("\n");
        }
      } else {
        const optionResult = await clickOverlayCandidate(
          wc,
          overlay.correctOption,
        );
        if (optionResult) {
          actionMessage = `Selected likely-correct option: ${optionResult}`;
          await sleep(120);
          const submitResult = await clickOverlayCandidate(
            wc,
            overlay.submitAction || overlay.acceptAction,
          );
          if (submitResult) {
            actionMessage += `\nSubmitted modal: ${submitResult}`;
          }
        }
      }
    }

    if (!actionMessage) {
      actionMessage = `Fallback popup handling: ${await dismissPopup(wc)}`;
    }

    steps.push(actionMessage);
    await sleep(250);

    const after = await extractContent(wc);
    const afterState = describeOverlayState(after);
    steps.push(`Overlays remaining: ${afterState.total}`);
    steps.push(`Page still blocked: ${afterState.blocking > 0}`);

    if (afterState.blocking === 0) {
      return steps.join("\n");
    }
    const progressMade =
      afterState.blocking < beforeState.blocking ||
      afterState.total !== beforeState.total ||
      afterState.signature !== beforeState.signature;
    if (progressMade) {
      cleared += 1;
      continue;
    }

    return steps.join("\n");
  }

  return steps.join("\n");
}

async function resolveSelector(
  wc: WebContents,
  index?: number,
  selector?: string,
): Promise<string | null> {
  if (selector) return selector;
  if (index == null) return null;

  const authoritativeSelector = await executePageScript<string | null>(
    wc,
    `
      (function() {
        return window.__vessel?.getElementSelector
          ? window.__vessel.getElementSelector(${index})
          : null;
      })()
    `,
  );
  if (typeof authoritativeSelector === "string" && authoritativeSelector) {
    // Shadow-piercing selector (contains " >>> ") — resolve via __vessel
    if (authoritativeSelector.includes(" >>> ")) {
      const resolves = await executePageScript<boolean>(
        wc,
        `!!window.__vessel?.resolveShadowSelector?.(${JSON.stringify(authoritativeSelector)})`,
      );
      if (resolves) return authoritativeSelector;
      return `__vessel_idx:${index}`;
    }
    // Verify the selector resolves in light DOM — shadow DOM elements need direct interaction
    const resolves = await executePageScript<boolean>(
      wc,
      `!!document.querySelector(${JSON.stringify(authoritativeSelector)})`,
    );
    if (resolves) return authoritativeSelector;
    return `__vessel_idx:${index}`;
  }

  const fallbackSelector = await executePageScript<string | null>(
    wc,
    `
      (function() {
        // Final fallback: replicate the legacy extraction order.
        function escapeSelectorValue(value) {
          if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
            return CSS.escape(value);
          }
          return String(value).replace(/["\\]/g, "\\$&");
        }

        function uniqueSelector(candidate) {
          if (!candidate) return null;
          try {
            return document.querySelectorAll(candidate).length === 1 ? candidate : null;
          } catch {
            return null;
          }
        }

        function uniqueAttributeSelector(el, attribute) {
          var value = el.getAttribute(attribute);
          if (!value) return null;
          value = value.trim();
          if (!value) return null;
          var candidate = el.tagName.toLowerCase() + "[" + attribute + "=\\"" + escapeSelectorValue(value) + "\\"]";
          return uniqueSelector(candidate);
        }

        function selectorFor(el) {
          if (!el) return null;
          if (el.id) return "#" + escapeSelectorValue(el.id);
          var attributes = ["data-testid", "name", "form", "aria-label"];
          for (var i = 0; i < attributes.length; i += 1) {
            var attributeCandidate = uniqueAttributeSelector(el, attributes[i]);
            if (attributeCandidate) return attributeCandidate;
          }
          var parts = [];
          var current = el;
          while (current) {
            if (current.id) {
              parts.unshift("#" + escapeSelectorValue(current.id));
              break;
            }
            var tag = current.tagName.toLowerCase();
            var parent = current.parentElement;
            if (!parent) { parts.unshift(tag); break; }
            var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === current.tagName; });
            var index = siblings.indexOf(current) + 1;
            parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
            current = parent;
          }
          var selector = parts.join(" > ");
          return uniqueSelector(selector) || selector;
        }

        var seen = new Set();
        var ordered = [];
        document.querySelectorAll("nav a[href], [role='navigation'] a[href]").forEach(function(el) {
          if (!seen.has(el)) { seen.add(el); ordered.push(el); }
        });
        document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button']").forEach(function(el) {
          if (!seen.has(el)) { seen.add(el); ordered.push(el); }
        });
        document.querySelectorAll("a[href]").forEach(function(el) {
          if (!seen.has(el)) { seen.add(el); ordered.push(el); }
        });
        document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']), select, textarea").forEach(function(el) {
          if (!seen.has(el)) { seen.add(el); ordered.push(el); }
        });

        var target = ordered[${index} - 1];
        return target ? selectorFor(target) : null;
      })()
    `,
  );
  if (typeof fallbackSelector === "string" && fallbackSelector) {
    return fallbackSelector;
  }

  const page = await extractContent(wc);
  const extractedSelector = findSelectorByIndex(page, index);
  if (extractedSelector) return extractedSelector;

  return null;
}

function normalizeFieldToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function describeFillField(field: FillFormFieldInput): string {
  if (field.selector) return `selector=${field.selector}`;
  if (field.index != null) return `index=${field.index}`;
  if (field.name) return `name=${field.name}`;
  if (field.label) return `label=${field.label}`;
  if (field.placeholder) return `placeholder=${field.placeholder}`;
  return "field";
}

export async function resolveFieldSelector(
  wc: WebContents,
  field: FillFormFieldInput,
): Promise<string | null> {
  const directSelector = await resolveSelector(wc, field.index, field.selector);
  if (directSelector) return directSelector;

  const name = normalizeFieldToken(field.name);
  const label = normalizeFieldToken(field.label);
  const placeholder = normalizeFieldToken(field.placeholder);
  if (!name && !label && !placeholder) return null;

  const selector = await executePageScript<string | null>(
    wc,
    `
      (function() {
        function normalize(value) {
          return value == null ? "" : String(value).trim().toLowerCase();
        }

        function text(value) {
          return value == null ? "" : String(value).trim();
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

        function escapeSelectorValue(value) {
          if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
            return CSS.escape(value);
          }
          return String(value).replace(/["\\\\]/g, "\\\\$&");
        }

        function uniqueSelector(candidate) {
          if (!candidate) return null;
          try {
            return document.querySelectorAll(candidate).length === 1 ? candidate : null;
          } catch {
            return null;
          }
        }

        function uniqueAttributeSelector(el, attribute) {
          const value = text(el.getAttribute && el.getAttribute(attribute));
          if (!value) return null;
          const candidate = el.tagName.toLowerCase() + "[" + attribute + "=\\"" + escapeSelectorValue(value) + "\\"]";
          return uniqueSelector(candidate);
        }

        function selectorFor(el) {
          if (!el) return null;
          if (el.id) return "#" + escapeSelectorValue(el.id);
          const attributes = ["data-testid", "name", "form", "aria-label", "placeholder"];
          for (const attribute of attributes) {
            const attributeCandidate = uniqueAttributeSelector(el, attribute);
            if (attributeCandidate) return attributeCandidate;
          }
          const parts = [];
          let current = el;
          while (current) {
            if (current.id) {
              parts.unshift("#" + escapeSelectorValue(current.id));
              break;
            }
            const tag = current.tagName.toLowerCase();
            const parent = current.parentElement;
            if (!parent) {
              parts.unshift(tag);
              break;
            }
            const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
            const index = siblings.indexOf(current) + 1;
            parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
            current = parent;
          }
          const candidate = parts.join(" > ");
          return uniqueSelector(candidate) || candidate;
        }

        function getLabelText(el) {
          const parts = [];
          if (el.labels) {
            Array.from(el.labels).forEach((labelEl) => {
              const value = text(labelEl.textContent);
              if (value) parts.push(value);
            });
          }
          const ariaLabel = text(el.getAttribute && el.getAttribute("aria-label"));
          if (ariaLabel) parts.push(ariaLabel);
          const labelledBy = text(el.getAttribute && el.getAttribute("aria-labelledby"));
          if (labelledBy) {
            labelledBy.split(/\\s+/).forEach((id) => {
              const ref = document.getElementById(id);
              const value = text(ref && ref.textContent);
              if (value) parts.push(value);
            });
          }
          return normalize(parts.join(" "));
        }

        function scoreField(el) {
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
            return -1;
          }
          if (!isVisible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") {
            return -1;
          }

          const normalizedName = normalize(el.getAttribute("name")) || normalize(el.id);
          const normalizedLabel = getLabelText(el);
          const normalizedPlaceholder = normalize(el.getAttribute("placeholder"));
          let score = 0;

          if (${JSON.stringify(name)}) {
            if (normalizedName === ${JSON.stringify(name.toLowerCase())}) score += 120;
            else if (normalizedName.includes(${JSON.stringify(name.toLowerCase())})) score += 70;
          }

          if (${JSON.stringify(label)}) {
            if (normalizedLabel === ${JSON.stringify(label.toLowerCase())}) score += 110;
            else if (normalizedLabel.includes(${JSON.stringify(label.toLowerCase())})) score += 65;
          }

          if (${JSON.stringify(placeholder)}) {
            if (normalizedPlaceholder === ${JSON.stringify(placeholder.toLowerCase())}) score += 105;
            else if (normalizedPlaceholder.includes(${JSON.stringify(placeholder.toLowerCase())})) score += 60;
          }

          if (score === 0) return -1;
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) score += 5;
          return score;
        }

        const candidates = Array.from(document.querySelectorAll("input, textarea, select"));
        let best = null;
        let bestScore = -1;
        for (const el of candidates) {
          const score = scoreField(el);
          if (score > bestScore) {
            best = el;
            bestScore = score;
          }
        }

        return best ? selectorFor(best) : null;
      })()
    `,
    {
      label: "resolve form field",
    },
  );

  return typeof selector === "string" && selector ? selector : null;
}

export async function fillFormFields(
  wc: WebContents,
  fields: FillFormFieldInput[],
): Promise<FillFormFieldResult[]> {
  const results: FillFormFieldResult[] = [];

  for (const field of fields) {
    const selector = await resolveFieldSelector(wc, field);
    if (!selector) {
      results.push({
        field,
        selector: null,
        result: `Skipped: no selector for ${describeFillField(field)}`,
      });
      continue;
    }

    const result = await setElementValue(
      wc,
      selector,
      String(field.value || ""),
    );
    results.push({ field, selector, result });
  }

  return results;
}

function getTabByMatch(
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

function isDangerousAction(name: string): boolean {
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
    "restore_checkpoint",
    "load_session",
    "login",
    "fill_form",
    "search",
    "paginate",
  ].includes(name);
}

async function setElementValue(
  wc: WebContents,
  selector: string,
  value: string,
): Promise<string> {
  if (selector.startsWith("__vessel_idx:")) {
    const idx = Number(selector.slice("__vessel_idx:".length));
    const result = await executePageScript<string>(
      wc,
      `window.__vessel?.interactByIndex?.(${idx}, "value", ${JSON.stringify(value)}) || "Error: interactByIndex not available"`,
    );
    return result === PAGE_SCRIPT_TIMEOUT
      ? pageBusyError("type_text")
      : result || "Error: interactByIndex not available";
  }
  // Shadow-piercing selector — use interactByIndex-style value setter via __vessel
  if (selector.includes(" >>> ")) {
    const result = await executePageScript<string>(
      wc,
      `
      (function() {
        var el = window.__vessel?.resolveShadowSelector?.(${JSON.stringify(selector)});
        if (!el) return "Error[stale-index]: Shadow DOM element not found — call read_page to refresh.";
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return "Error[not-input]: Element is not a text input";
        var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) { desc.set.call(el, ${JSON.stringify(value)}); } else { el.value = ${JSON.stringify(value)}; }
        el.focus();
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return "Typed into: " + (el.getAttribute("aria-label") || el.placeholder || el.name || "input");
      })()
    `,
      {
        label: "type text in shadow input",
      },
    );
    return result === PAGE_SCRIPT_TIMEOUT
      ? pageBusyError("type_text")
      : result || "Error: Could not type into element";
  }
  const result = await executePageScript<string>(
    wc,
    `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh.';
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        return 'Error[not-input]: Element is not a text input';
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return 'Error[disabled]: Input is disabled';
      }

      const prototype = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, ${JSON.stringify(value)});
      } else {
        el.value = ${JSON.stringify(value)};
      }

      el.focus();
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: ${JSON.stringify(value)},
        inputType: 'insertText',
      }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'Typed into: ' +
        (el.getAttribute('aria-label') || el.placeholder || el.name || 'input') +
        ' = ' + (el.type === 'password' ? '[hidden]' : String(el.value).slice(0, 80));
    })()
  `,
    {
      label: "type text",
    },
  );
  return result === PAGE_SCRIPT_TIMEOUT
    ? pageBusyError("type_text")
    : result || "Error: Could not type into element";
}

async function typeKeystroke(
  wc: WebContents,
  selector: string,
  value: string,
): Promise<string> {
  const result = await executePageScript<string>(
    wc,
    `
    (async function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh.';
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        return 'Error[not-input]: Element is not a text input';
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return 'Error[disabled]: Input is disabled';
      }
      el.focus();
      const prototype = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, '');
      } else {
        el.value = '';
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: '', inputType: 'deleteContentBackward' }));
      const chars = ${JSON.stringify(value)}.split('');
      for (const ch of chars) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true, cancelable: true }));
        if (descriptor && descriptor.set) {
          descriptor.set.call(el, el.value + ch);
        } else {
          el.value += ch;
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: ch, inputType: 'insertText' }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, cancelable: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'Typed into: ' +
        (el.getAttribute('aria-label') || el.placeholder || el.name || 'input') +
        ' = ' + (el.type === 'password' ? '[hidden]' : String(el.value).slice(0, 80));
    })()
  `,
    {
      timeoutMs: 2000,
      label: "type keystrokes",
    },
  );
  return result === PAGE_SCRIPT_TIMEOUT
    ? pageBusyError("type_text")
    : result || "Error: Could not type into element";
}

async function hoverElement(
  wc: WebContents,
  selector: string,
): Promise<string> {
  const pos = await wc.executeJavaScript(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh.' };
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      }
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { error: 'Error[hidden]: Element has no visible area' };
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      const label = (el.textContent || el.tagName || 'Element').trim().slice(0, 80);
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        label: label,
      };
    })()
  `);

  if (!pos || typeof pos !== "object") return "Error: Could not hover element";
  if ("error" in pos && typeof pos.error === "string") return pos.error;
  const x = typeof pos.x === "number" ? pos.x : null;
  const y = typeof pos.y === "number" ? pos.y : null;
  if (x == null || y == null)
    return "Error: Could not resolve hover coordinates";

  wc.sendInputEvent({ type: "mouseMove", x, y });
  const label = typeof pos.label === "string" ? pos.label : "element";
  return `Hovered: ${label}`;
}

async function focusElement(
  wc: WebContents,
  selector: string,
): Promise<string> {
  return wc.executeJavaScript(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh.';
      if (!(el instanceof HTMLElement)) return 'Error[not-interactive]: Element is not focusable';
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
        return 'Error[disabled]: Element is disabled';
      }
      el.focus({ preventScroll: false });
      return 'Focused: ' + (el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60) || el.tagName.toLowerCase());
    })()
  `);
}

async function waitForCondition(
  wc: WebContents,
  args: Record<string, any>,
): Promise<string> {
  const timeoutMs = Math.max(250, Number(args.timeoutMs) || 5000);
  const selector =
    typeof args.selector === "string" && args.selector.trim()
      ? args.selector.trim()
      : "";
  const text =
    typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";

  if (!selector && !text) {
    return "Error: wait_for requires text or selector";
  }

  // Wait for any pending load to finish first
  if (wc.isLoading()) {
    await waitForLoad(wc, Math.min(timeoutMs, 5000));
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await executePageScript<string>(
      wc,
      `
      (function() {
        var selector = ${JSON.stringify(selector)};
        var text = ${JSON.stringify(text)};
        if (selector) {
          try {
            if (document.querySelector(selector)) return 'selector';
          } catch (e) {
            return 'invalid_selector:' + e.message;
          }
        }
        if (text && document.body && document.body.innerText && document.body.innerText.includes(text)) return 'text';
        return '';
      })()
    `,
      {
        label: "wait_for probe",
      },
    );
    if (result === PAGE_SCRIPT_TIMEOUT) {
      return pageBusyError("wait_for");
    }
    if (result === "selector") {
      return `Matched selector ${selector}`;
    }
    if (result === "text") {
      return `Matched text "${text.slice(0, 80)}"`;
    }
    if (typeof result === "string" && result.startsWith("invalid_selector:")) {
      return `Error: Invalid selector "${selector}" — ${result.slice(17)}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return selector
    ? `Timed out waiting for selector ${selector}`
    : `Timed out waiting for text "${text.slice(0, 80)}"`;
}

function findCheckpoint(
  checkpoints: AgentCheckpoint[],
  args: Record<string, any>,
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

function resolveBookmarkFolderTarget(args: Record<string, any>): {
  folderId?: string;
  folderName: string;
  createdFolder?: string;
  error?: string;
} {
  const folderId =
    typeof args.folderId === "string" ? args.folderId.trim() : "";
  if (folderId) {
    if (folderId === bookmarkManager.UNSORTED_ID) {
      return {
        folderId: bookmarkManager.UNSORTED_ID,
        folderName: "Unsorted",
      };
    }
    const folder = bookmarkManager.getFolder(folderId);
    if (!folder) {
      return { folderName: "Unsorted", error: `Folder ${folderId} not found` };
    }
    return { folderId: folder.id, folderName: folder.name };
  }

  const folderName =
    typeof args.folderName === "string" && args.folderName.trim()
      ? args.folderName.trim()
      : args.archive
        ? bookmarkManager.ARCHIVE_FOLDER_NAME
        : "";
  if (!folderName || folderName.toLowerCase() === "unsorted") {
    return {
      folderId: bookmarkManager.UNSORTED_ID,
      folderName: "Unsorted",
    };
  }

  const existing = bookmarkManager.findFolderByName(folderName);
  if (existing) {
    return { folderId: existing.id, folderName: existing.name };
  }

  if (args.createFolderIfMissing === false) {
    return { folderName, error: `Folder "${folderName}" not found` };
  }

  const folderSummary =
    typeof args.folderSummary === "string" && args.folderSummary.trim()
      ? args.folderSummary.trim()
      : undefined;
  const { folder } = bookmarkManager.ensureFolder(folderName, folderSummary);
  return {
    folderId: folder.id,
    folderName: folder.name,
    createdFolder: folder.name,
  };
}

function formatFolderStatus(limit = 6): string {
  const folders = bookmarkManager.listFolderOverviews();
  const summary = folders
    .slice(0, limit)
    .map((folder) => `${folder.name} (${folder.count})`)
    .join(", ");
  return `Folder status: ${summary}${folders.length > limit ? ", ..." : ""}`;
}

function describeFolder(folderId?: string): string {
  if (!folderId || folderId === bookmarkManager.UNSORTED_ID) {
    return "Unsorted";
  }
  return bookmarkManager.getFolder(folderId)?.name ?? folderId;
}

function composeDuplicateBookmarkResponse(args: {
  url: string;
  folderName: string;
  bookmarkId: string;
}): string {
  return `Bookmark already exists for ${args.url} in "${args.folderName}" (id=${args.bookmarkId}). Retry with onDuplicate="update" to refresh the existing bookmark or onDuplicate="duplicate" to keep both entries.`;
}

function composeFolderAwareResponse(
  message: string,
  createdFolder?: string,
): string {
  const prefix = createdFolder ? `Created folder "${createdFolder}".\n` : "";
  return `${prefix}${message}\n${formatFolderStatus()}`;
}

async function selectOption(
  wc: WebContents,
  args: Record<string, any>,
): Promise<string> {
  const selector = await resolveSelector(wc, args.index, args.selector);
  if (!selector) return "Error: No select element index or selector provided";

  const result = await executePageScript<string>(
    wc,
    `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLSelectElement)) {
        return 'Element is not a select dropdown';
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return 'Select is disabled';
      }
      const requestedLabel = ${JSON.stringify(args.label || "")}.trim().toLowerCase();
      const requestedValue = ${JSON.stringify(args.value || "")}.trim();
      const option = Array.from(el.options).find((item) => {
        const label = (item.textContent || '').trim().toLowerCase();
        return (requestedLabel && label === requestedLabel) ||
          (requestedValue && item.value === requestedValue);
      });
      if (!option) {
        return 'Option not found';
      }
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'Selected: ' + ((option.textContent || option.value).trim().slice(0, 100));
    })()
  `,
    {
      label: "select option",
    },
  );
  return result === PAGE_SCRIPT_TIMEOUT
    ? pageBusyError("select_option")
    : result || "Error: Could not select option";
}

async function submitForm(
  wc: WebContents,
  args: Record<string, any>,
): Promise<string> {
  const beforeUrl = wc.getURL();
  let selector = await resolveSelector(wc, args.index, args.selector);

  // If no index/selector provided, find the first visible form on the page
  if (!selector) {
    const discoveredSelector = await executePageScript<string | null>(
      wc,
      `
      (function() {
        var forms = document.querySelectorAll('form');
        for (var i = 0; i < forms.length; i++) {
          var f = forms[i];
          var rect = f.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return 'form';
        }
        return forms.length > 0 ? 'form' : null;
      })()
    `,
      {
        label: "discover form",
      },
    );
    if (discoveredSelector === PAGE_SCRIPT_TIMEOUT) {
      return pageBusyError("submit_form");
    }
    selector = discoveredSelector || null;
    if (!selector) return "Error: No form found on the page";
  }

  // Get form info to determine submission method
  const formInfo = await executePageScript<Record<string, any>>(
    wc,
    `
    (function() {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return { error: 'Target not found' };
      var form = target instanceof HTMLFormElement ? target : target.closest('form');
      if (!form) {
        const formId = target.getAttribute('form');
        if (formId) {
          const linked = document.getElementById(formId);
          if (linked instanceof HTMLFormElement) form = linked;
        }
      }
      if (!form) return { error: 'No parent form found' };
      function isSubmitControl(el) {
        return (
          (el instanceof HTMLButtonElement &&
            ((el.getAttribute('type') || '').trim().toLowerCase() === '' ||
              el.type === 'submit')) ||
          (el instanceof HTMLInputElement &&
            (el.type === 'submit' || el.type === 'image'))
        );
      }
      const submitter = isSubmitControl(target)
        ? target
        : Array.from(document.querySelectorAll('button, input[type="submit"], input[type="image"]')).find(
            (candidate) => isSubmitControl(candidate) && candidate.form === form,
          );
      if (
        submitter instanceof HTMLElement &&
        (submitter.hasAttribute('disabled') ||
          submitter.getAttribute('aria-disabled') === 'true')
      ) {
        return { error: 'Submit control is disabled' };
      }
      // Collect form data and determine method
      const submitterActionAttr =
        (submitter instanceof HTMLButtonElement ||
          submitter instanceof HTMLInputElement
          ? submitter.getAttribute('formaction')?.trim()
          : '') || '';
      const action = submitterActionAttr
        ? new URL(submitterActionAttr, document.baseURI).toString()
        : form.action || window.location.href;
      const submitterMethodAttr =
        (submitter instanceof HTMLButtonElement ||
          submitter instanceof HTMLInputElement
          ? submitter.getAttribute('formmethod')?.trim()
          : '') || '';
      const method = (
        submitterMethodAttr ||
        form.getAttribute('method') ||
        form.method ||
        'GET'
      ).toUpperCase();
      let fd;

      try {
        fd = submitter instanceof HTMLElement
          ? new FormData(form, submitter)
          : new FormData(form);
      } catch {
        fd = new FormData(form);
      }
      const params = new URLSearchParams();
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') params.append(k, v);
      }
      // Use requestSubmit to fire JS submit handlers for all methods
      if (typeof form.requestSubmit === 'function') {
        try {
          if (
            submitter instanceof HTMLButtonElement ||
            submitter instanceof HTMLInputElement
          ) {
            form.requestSubmit(submitter);
          } else {
            form.requestSubmit();
          }
        } catch {
          form.requestSubmit();
        }
        return { submitted: true, method };
      }
      if (submitter instanceof HTMLElement && typeof submitter.click === 'function') {
        submitter.click();
        return { submitted: true, method };
      }
      // Last resort: form.submit() bypasses JS handlers but at least submits
      if (method === 'GET') {
        return { action, method, params: params.toString(), found: true };
      }
      form.submit();
      return { submitted: true, method };
    })()
  `,
    {
      timeoutMs: 2000,
      label: "submit form",
    },
  );

  if (formInfo === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("submit_form");
  }
  if (!formInfo || typeof formInfo !== "object") {
    return "Error: Could not inspect form";
  }

  if (formInfo.error) return formInfo.error;

  // Fallback for GET when requestSubmit was unavailable
  if (formInfo.found && formInfo.method === "GET") {
    const url = new URL(formInfo.action);
    if (formInfo.params) {
      url.search = formInfo.params;
    }
    assertSafeURL(url.toString());
    wc.loadURL(url.toString());
    await waitForPotentialNavigation(wc, beforeUrl);
    const afterUrl = wc.getURL();
    return afterUrl !== beforeUrl
      ? `Submitted form via GET -> ${afterUrl}`
      : "Submitted form via GET";
  }

  if (formInfo.submitted) {
    await waitForPotentialNavigation(wc, beforeUrl);
    const afterUrl = wc.getURL();
    if (afterUrl !== beforeUrl) {
      return `Submitted form via ${formInfo.method} -> ${afterUrl}`;
    }

    // Form submitted but URL didn't change — JS-heavy sites like Google
    // intercept requestSubmit. Try pressing Enter on the active input as fallback.
    await executePageScript(
      wc,
      `
      (function() {
        var active = document.activeElement;
        if (!active || active === document.body) {
          var inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
          for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].value) { active = inputs[i]; active.focus(); break; }
          }
        }
        if (active && active !== document.body) {
          active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
          active.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
          active.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
        }
      })()
    `,
      {
        label: "submit form enter fallback",
      },
    );
    // Also send native Enter via Electron input events for sites that listen at the browser level
    wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    await new Promise((r) => setTimeout(r, 50));
    wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });

    await waitForPotentialNavigation(wc, beforeUrl, 3000);
    const finalUrl = wc.getURL();
    return finalUrl !== beforeUrl
      ? `Submitted form (Enter fallback) -> ${finalUrl}`
      : `Submitted form via ${formInfo.method} (page may have updated dynamically)`;
  }

  return "Submitted form";
}

export {
  waitForLoad,
  setElementValue,
  pressKey,
  dismissPopup,
  isAddToCartText,
  isDuplicateCartClick,
  recordCartClick,
};

export async function clickElementBySelector(
  wc: WebContents,
  selector: string,
): Promise<string> {
  return clickResolvedSelector(wc, selector);
}

export async function submitFormBySelector(
  wc: WebContents,
  selector: string,
): Promise<string> {
  return submitForm(wc, { selector });
}

async function pressKey(
  wc: WebContents,
  args: Record<string, any>,
): Promise<string> {
  const key = typeof args.key === "string" ? args.key.trim() : "";
  if (!key) return "Error: No key provided";

  const selector = await resolveSelector(wc, args.index, args.selector);
  const focusResult = await executePageScript<{
    ok?: boolean;
    error?: string;
    label?: string;
  }>(
    wc,
    `
    (function() {
      const selector = ${JSON.stringify(selector)};
      const target =
        selector ? document.querySelector(selector) : document.activeElement;
      if (!target || !(target instanceof HTMLElement)) {
        return { error: selector ? 'Target not found' : 'No focused element' };
      }
      target.focus({ preventScroll: false });
      return {
        ok: true,
        label:
          target.getAttribute('aria-label') ||
          target.getAttribute('name') ||
          target.getAttribute('placeholder') ||
          target.textContent?.trim().slice(0, 60) ||
          target.tagName.toLowerCase(),
      };
    })()
  `,
    {
      label: "focus before key press",
    },
  );
  if (focusResult === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("press_key");
  }
  if (!focusResult || typeof focusResult !== "object") {
    return "Error: Could not prepare key press";
  }
  if ("error" in focusResult && typeof focusResult.error === "string") {
    return focusResult.error;
  }

  wc.focus();

  const normalizedKey =
    key.length === 1 ? key : key[0].toUpperCase() + key.slice(1);
  const electronKeyCode =
    normalizedKey === "Enter"
      ? "Return"
      : normalizedKey === "ArrowUp"
        ? "Up"
        : normalizedKey === "ArrowDown"
          ? "Down"
          : normalizedKey === "ArrowLeft"
            ? "Left"
            : normalizedKey === "ArrowRight"
              ? "Right"
              : normalizedKey;

  wc.sendInputEvent({ type: "keyDown", keyCode: electronKeyCode });
  if (key.length === 1) {
    wc.sendInputEvent({ type: "char", keyCode: key });
  }
  await sleep(16);
  wc.sendInputEvent({ type: "keyUp", keyCode: electronKeyCode });

  const label =
    "label" in focusResult && typeof focusResult.label === "string"
      ? focusResult.label
      : null;
  return label ? `Pressed key: ${key} on ${label}` : `Pressed key: ${key}`;
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
    return `\n[state: url=${wc.getURL()}, title=${JSON.stringify(wc.getTitle() || "")}, canGoBack=${tab.canGoBack()}, canGoForward=${tab.canGoForward()}, loading=${wc.isLoading()}]`;
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
const KNOWN_TOOLS = new Set([
  "current_tab",
  "list_tabs",
  "switch_tab",
  "create_tab",
  "navigate",
  "go_back",
  "go_forward",
  "reload",
  "click",
  "inspect_element",
  "type_text",
  "select_option",
  "submit_form",
  "press_key",
  "scroll",
  "hover",
  "focus",
  "set_ad_blocking",
  "dismiss_popup",
  "clear_overlays",
  "read_page",
  "screenshot",
  "wait_for",
  "create_checkpoint",
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
  "highlight",
  "clear_highlights",
  "flow_start",
  "flow_advance",
  "flow_status",
  "flow_end",
  "suggest",
  "fill_form",
  "login",
  "search",
  "paginate",
  "accept_cookies",
  "extract_table",
  "scroll_to_element",
  "metrics",
  "wait_for_navigation",
]);

export async function executeAction(
  name: string,
  args: Record<string, any>,
  ctx: ActionContext,
): Promise<string> {
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
          const selector = await resolveSelector(wc, args.index, args.selector);
          if (!selector) return "Error: No element index or selector provided";
          return clickResolvedSelector(wc, selector);
        }

        case "inspect_element": {
          if (!wc) return "Error: No active tab";
          const selector = await resolveSelector(wc, args.index, args.selector);
          if (!selector) return "Error: No element index or selector provided";
          return inspectElement(
            wc,
            selector,
            typeof args.limit === "number" ? args.limit : 8,
          );
        }

        case "type_text": {
          if (!wc) return "Error: No active tab";
          const selector = await resolveSelector(wc, args.index, args.selector);
          if (!selector) return "Error: No element index or selector provided";
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
          } catch {
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
                } catch {
                  content = null;
                }
              }
            } catch {
              // iframe dismiss failed — fall through to emergency extraction
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
            const requestedMode = normalizeReadPageMode(args.mode, content);

            if (requestedMode === "debug" || requestedMode === "full") {
              const structured = buildStructuredContext(content);
              const truncated =
                content.content.length > 20000
                  ? content.content.slice(0, 20000) + "\n[Content truncated...]"
                  : content.content;
              return `${livePrefix}[read_page mode=debug]\n\n${structured}\n\n## PAGE CONTENT\n\n${truncated}`;
            }

            const scoped = buildScopedContext(content, requestedMode);
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
            { onDuplicate },
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

          const bookmark = bookmarkManager.saveBookmark(
            source.url,
            source.title,
            target.folderId,
            note,
          );
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

        case "suggest": {
          if (!wc) return "No active tab. Use navigate to open a page.";
          let page;
          try {
            page = await extractContent(wc);
          } catch {
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

          if (hasOverlays) {
            suggestions.push("BLOCKING OVERLAY detected — dismiss it first:");
            suggestions.push("  → clear_overlays for stacked modals");
            suggestions.push("  → or dismiss_popup for a single popup");
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
          const query = String(args.query || "");
          if (!query) return "Error: No search query provided.";

          // Guard: reject queries that look like button/UI labels, not search terms
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

          // Step 1: Find the search input — polls inside the page for up
          // to 5 seconds so we catch it as soon as the framework renders
          // it, without needing the JS thread to be fully idle.
          const searchInfo = args.selector
            ? { selector: args.selector, formAction: null, formMethod: null }
            : await executePageScript<{
                selector: string;
                formAction: string | null;
                formMethod: string | null;
                inputName?: string;
              } | null>(
                wc,
                `
              (function() {
                var SELECTORS = 'input[type="search"], input[name="q"], input[name="query"], input[name="search"], input[role="searchbox"], input[aria-label*="search" i], input[placeholder*="search" i]';
                function find() {
                  var el = document.querySelector(SELECTORS);
                  if (!el) {
                    var inputs = document.querySelectorAll('input[type="text"]');
                    for (var i = 0; i < inputs.length; i++) {
                      var form = inputs[i].closest('form');
                      if (form && (form.getAttribute('role') === 'search' || (form.action && form.action.includes('search')))) {
                        el = inputs[i];
                        break;
                      }
                    }
                  }
                  if (!el) return null;
                  var sel = el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null;
                  var form = el.closest('form');
                  return {
                    selector: sel,
                    formAction: form ? form.action : null,
                    formMethod: form ? (form.method || 'GET').toUpperCase() : null,
                    inputName: el.name || 'q',
                  };
                }
                return new Promise(function(resolve) {
                  var result = find();
                  if (result) { resolve(result); return; }
                  var attempts = 0;
                  var timer = setInterval(function() {
                    result = find();
                    if (result || ++attempts >= 20) {
                      clearInterval(timer);
                      resolve(result);
                    }
                  }, 250);
                });
              })()
            `,
                {
                  timeoutMs: 1800,
                  label: "find search input",
                },
              );
          if (searchInfo === PAGE_SCRIPT_TIMEOUT) {
            return pageBusyError("search");
          }
          if (!searchInfo?.selector)
            return "Error: Could not find search input. Try providing a selector.";

          // Step 2: Fill the search box
          const fillResult = await setElementValue(
            wc,
            searchInfo.selector,
            query,
          );
          if (fillResult.startsWith("Error:")) {
            return fillResult;
          }
          await sleep(100); // Let autocomplete/JS process the input

          // Step 3: Focus and press Enter via native input events
          const focusResult = await executePageScript(
            wc,
            `
            (function() {
              var el = document.querySelector(${JSON.stringify(searchInfo.selector)});
              if (el) el.focus();
            })()
          `,
            {
              label: "focus search input",
            },
          );
          if (focusResult === PAGE_SCRIPT_TIMEOUT) {
            return pageBusyError("search");
          }
          await sleep(50);
          const beforeUrl = wc.getURL();
          wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
          await sleep(16);
          wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });

          await waitForPotentialNavigation(wc, beforeUrl, 3000);
          let afterUrl = wc.getURL();
          if (afterUrl !== beforeUrl) {
            return `Searched "${query}" → ${afterUrl}`;
          }

          // Step 4: Enter didn't navigate — try clicking the submit/search button
          const clickedSubmit = await executePageScript<boolean>(
            wc,
            `
            (function() {
              var form = document.querySelector(${JSON.stringify(searchInfo.selector)})?.closest('form');
              if (!form) return false;
              var btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
              if (btn) { btn.click(); return true; }
              // Try any button in the form
              var anyBtn = form.querySelector('button');
              if (anyBtn) { anyBtn.click(); return true; }
              return false;
            })()
          `,
            {
              label: "click search submit",
            },
          );
          if (clickedSubmit === PAGE_SCRIPT_TIMEOUT) {
            return pageBusyError("search");
          }
          if (clickedSubmit) {
            await waitForPotentialNavigation(wc, beforeUrl, 3000);
            afterUrl = wc.getURL();
            if (afterUrl !== beforeUrl) {
              return `Searched "${query}" (via submit button) → ${afterUrl}`;
            }
          }

          // Step 5: Button click didn't work either — construct URL directly for GET forms
          if (searchInfo.formAction && searchInfo.formMethod === "GET") {
            try {
              const url = new URL(searchInfo.formAction);
              url.searchParams.set(searchInfo.inputName || "q", query);
              assertSafeURL(url.toString());
              wc.loadURL(url.toString());
              await waitForPotentialNavigation(wc, beforeUrl);
              afterUrl = wc.getURL();
              return `Searched "${query}" (via direct URL) → ${afterUrl}`;
            } catch {
              // URL construction failed, continue to final fallback
            }
          }

          return `Searched "${query}" (same page — results may have loaded dynamically)`;
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
          const dismissed = await executePageScript<string | null>(
            wc,
            `
            (function() {
              // Common cookie consent selectors — OneTrust, CookieBot, GDPR banners
              var selectors = [
                '#onetrust-accept-btn-handler',
                '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
                '[data-cookiefirst-action="accept"]',
                '.cookie-consent-accept-all',
                '#accept-cookies',
                '.cc-accept',
                '.cc-btn.cc-allow',
                '[aria-label="Accept cookies"]',
                '[aria-label="Accept all cookies"]',
                '[data-testid="cookie-accept"]',
                // CNN / WarnerMedia / common consent SDKs
                '[data-testid="consent-accept"]',
                '[data-testid="accept-all"]',
                'button[class*="consent"][class*="accept"]',
                'button[class*="privacy"][class*="accept"]',
                '.fc-cta-consent',
                '#sp_choice_button_accept',
                '.message-component.message-button.no-children.focusable.sp_choice_type_11',
                '[class*="truste"] [class*="accept"]',
                '[id*="consent-accept"]',
                '[class*="cmp-accept"]',
              ];
              // Also try text-matching on buttons
              var textPatterns = ['accept all', 'accept cookies', 'allow all', 'allow cookies', 'agree', 'got it', 'ok', 'i agree', 'i accept', 'consent', 'continue', 'accept and continue', 'accept & continue'];
              for (var i = 0; i < selectors.length; i++) {
                var el = document.querySelector(selectors[i]);
                if (el && el instanceof HTMLElement) { el.click(); return "Dismissed cookie banner via: " + selectors[i]; }
              }
              var buttons = document.querySelectorAll('button, a[role="button"], [type="submit"]');
              for (var j = 0; j < buttons.length; j++) {
                var btn = buttons[j];
                var text = (btn.textContent || '').trim().toLowerCase();
                for (var k = 0; k < textPatterns.length; k++) {
                  if (text === textPatterns[k] || text.startsWith(textPatterns[k])) {
                    btn.click();
                    return "Dismissed cookie banner via text match: " + text;
                  }
                }
              }
              return null;
            })()
          `,
            {
              label: "accept cookies",
            },
          );
          if (dismissed === PAGE_SCRIPT_TIMEOUT) {
            return pageBusyError("accept_cookies");
          }
          if (dismissed) return dismissed;

          // Main frame selectors didn't match — try iframe-based consent (Sourcepoint, etc.)
          const iframeResult = await tryDismissConsentIframe(wc);
          if (iframeResult) return iframeResult;

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
          const sel = await resolveSelector(wc, args.index, args.selector);
          if (!sel)
            return "Error: Provide an index or selector for the element to scroll to.";
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

  const flowCtx = ctx.runtime.getFlowContext();
  return result + (await getPostActionState(ctx, name)) + flowCtx;
}
