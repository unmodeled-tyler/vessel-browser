import type { WebContents } from "electron";
import type { AgentCheckpoint } from "../../../shared/types";
import { selectorHelpersJS } from "../../../shared/dom/selector-helpers-js";
import type { TabManager } from "../../tabs/tab-manager";
import { looksLikeCurrentSiteNameQuery } from "../tool-guardrails";
import { buildHuggingFaceSearchShortcut, type SearchShortcut } from "../search-huggingface";
import {
  buildCommonSearchUrlShortcut,
  buildDefaultEngineShortcut,
  buildFlightSearchShortcut,
  buildSearchEngineLandingShortcut,
  buildSearchShortcut,
  normalizeSearchQuery,
} from "../page-search";
import { getPostSearchSummary } from "./summaries";
import {
  executePageScript,
  loadPermittedUrl,
  logger,
  PAGE_SCRIPT_TIMEOUT,
  pageBusyError,
} from "./core";
import { pressKey, setElementValue } from "./interaction";
import { sleep, waitForLoad, waitForPotentialNavigation } from "../../utils/webcontents-utils";
import { formatDeadLinkMessage, validateLinkDestination } from "../../network/link-validation";
import {
  getCartAddedSummary,
  hasRecentCartClick,
  isAddToCartText,
  isDuplicateCartClick,
  isProductAlreadyInCart,
  recordCartClick,
} from "../cart-click-state";
import { buildCartSuccessSuffix, detectPostClickOverlay, getCartDialogActions } from "./overlays";
import { activateElement, clickElement, describeElementForClick } from "./click-targets";

export {
  buildCommonSearchUrlShortcut,
  buildFlightSearchShortcut,
  buildSearchEngineLandingShortcut,
  buildSearchShortcut,
  normalizeSearchQuery,
};

export function urlAlreadyHasSearchQuery(currentUrl: string, query: string): boolean {
  try {
    const url = new URL(currentUrl);
    const currentQuery = ["q", "search", "query", "keyword", "keywords", "term", "text"]
      .map((param) => url.searchParams.get(param))
      .find((value): value is string => Boolean(value));
    return currentQuery
      ? normalizeSearchQuery(currentQuery).toLowerCase() === normalizeSearchQuery(query).toLowerCase()
      : false;
  } catch {
    return false;
  }
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
          tab.title.toLowerCase().includes(lowered) || tab.url.toLowerCase().includes(lowered),
      ) || null
  );
}

export function findCheckpoint(
  checkpoints: AgentCheckpoint[],
  args: Record<string, unknown>,
): AgentCheckpoint | null {
  if (typeof args.checkpointId === "string" && args.checkpointId.trim()) {
    return checkpoints.find((item) => item.id === args.checkpointId.trim()) || null;
  }

  if (typeof args.name === "string" && args.name.trim()) {
    const lowered = args.name.trim().toLowerCase();
    return [...checkpoints].reverse().find((item) => item.name.toLowerCase() === lowered) || null;
  }

  return null;
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
  const scrolled = await executePageScript(wc, `window.scrollBy(0, ${deltaY})`, {
    label: "scroll page",
  });
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

async function followHrefFromClickResult(
  wc: WebContents,
  beforeUrl: string,
  result: unknown,
  logMessage: string,
): Promise<string | null> {
  const hrefMatch = typeof result === "string" ? result.match(/\nhref: (https?:\/\/\S+)/) : null;
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

export async function clickResolvedSelector(wc: WebContents, selector: string): Promise<string> {
  if (selector.startsWith("__vessel_idx:")) {
    const idx = Number(selector.slice("__vessel_idx:".length));
    const beforeUrl = wc.getURL();
    let idxCartMatch = false;
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

  if (selector.includes(" >>> ")) {
    const beforeUrl = wc.getURL();
    let shadowCartMatch = false;
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

  const cartMatch = isAddToCartText(elInfo.text);
  if (cartMatch && isDuplicateCartClick(beforeUrl, elInfo.text)) {
    return `Blocked: "${elInfo.text}" was already clicked on this page. The item is in your cart. Call read_page to see available actions (e.g. View Cart, Continue Shopping).`;
  }

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

  if (cartMatch && isProductAlreadyInCart(beforeUrl)) {
    const summary = getCartAddedSummary(beforeUrl);
    return `Blocked: This product was already added to the cart.${summary}\nGo back and select a different product.`;
  }

  if (cartMatch) {
    recordCartClick(beforeUrl);
  }

  const tagLabel =
    elInfo.tag && elInfo.tag !== "a" && elInfo.tag !== "button" ? ` <${elInfo.tag}>` : "";
  const clickText = `Clicked: ${elInfo.text}${tagLabel}`;
  const clickResult = await clickElement(wc, selector);
  if (clickResult.startsWith("Error:")) return clickResult;

  const initialNavigationWaitMs =
    /DOM activation/i.test(clickResult) && !elInfo.href ? 800 : undefined;
  await waitForPotentialNavigation(wc, beforeUrl, initialNavigationWaitMs);
  const afterUrl = wc.getURL();
  if (afterUrl !== beforeUrl) {
    if (/DOM activation/i.test(clickResult)) {
      return `${clickText} -> ${afterUrl} (recovered via DOM activation)`;
    }
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
    return `${clickText} (${clickResult})${await buildCartSuccessSuffix(wc, beforeUrl)}`;
  }

  if (/DOM activation/i.test(clickResult) && (!elInfo.href || elInfo.target === "_blank")) {
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

  const nonInteractiveWarning =
    elInfo.isInteractive === false && !elInfo.href
      ? `\nNote: The clicked element (<${elInfo.tag || "unknown"}>) is not a link or button. Nothing happened. Try clicking the actual link element nearby or use read_page to find the correct interactive element.`
      : `\nNote: Page did not change after click. The element may need a different interaction method. Consider read_page or inspect_element.`;

  return `${clickText} (${clickResult})${nonInteractiveWarning}`;
}

type SearchTargetInfo = {
  selector: string;
  submitSelector?: string | null;
};

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

export async function locateImplicitTextTarget(
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
          if (!(el instanceof HTMLElement)) return false;
          if (
            el.getAttribute("aria-disabled") === "true" ||
            (el instanceof HTMLInputElement && (el.disabled || el.readOnly)) ||
            (el instanceof HTMLTextAreaElement && (el.disabled || el.readOnly))
          ) {
            return false;
          }
          const role = normalize(el.getAttribute("role"));
          if (
            el.isContentEditable ||
            (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") ||
            role === "textbox" ||
            role === "searchbox" ||
            role === "combobox"
          ) {
            return true;
          }
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
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
          document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]')
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

export async function searchPageWithClick(
  wc: WebContents,
  args: Record<string, unknown>,
  clickElementBySelector: (wc: WebContents, selector: string) => Promise<string>,
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
      shortcut.appliedFilters.length > 0 ? ` (${shortcut.appliedFilters.join(", ")})` : "";
    const destination = shortcut.section ? ` ${shortcut.section}` : "";
    return `Searched "${query}" via ${shortcut.source}${destination} shortcut${applied} → ${afterUrl}${await getPostSearchSummary(wc)}`;
  };

  if (typeof args.selector !== "string") {
    const currentUrl = wc.getURL();
    if (urlAlreadyHasSearchQuery(currentUrl, query)) {
      return `Already showing search results for "${query}" at ${currentUrl}${await getPostSearchSummary(wc)}`;
    }

    const shortcut =
      buildHuggingFaceSearchShortcut(wc.getURL(), query) ??
      buildSearchEngineLandingShortcut(wc.getURL(), query) ??
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
    return 'Error: Could not find a visible search input. Try read_page(mode="visible_only") or provide a selector.';
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

export async function clickElementBySelector(wc: WebContents, selector: string): Promise<string> {
  return clickResolvedSelector(wc, selector);
}

export async function searchPage(wc: WebContents, args: Record<string, unknown>): Promise<string> {
  return searchPageWithClick(wc, args, clickElementBySelector);
}
