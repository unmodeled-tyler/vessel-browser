import type { WebContents } from "electron";
import type { AgentCheckpoint } from "../../shared/types";
import type { AgentRuntime } from "../agent/runtime";
import { resolveBookmarkSourceDraft } from "../bookmarks/page-source";
import * as bookmarkManager from "../bookmarks/manager";
import { highlightOnPage, clearHighlights } from "../highlights/inject";
import { extractContent } from "../content/extractor";
import { getRecoverableAccessIssue } from "../content/page-access-issues";
import { findSelectorByIndex } from "../mcp/indexed-selector";
import {
  formatDeadLinkMessage,
  validateLinkDestination,
} from "../network/link-validation";
import * as namedSessionManager from "../sessions/manager";
import type { TabManager } from "../tabs/tab-manager";
import { buildStructuredContext } from "./context-builder";

export interface ActionContext {
  tabManager: TabManager;
  runtime: AgentRuntime;
}

function waitForLoad(wc: WebContents, timeout = 5000): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;

    const cleanup = () => {
      wc.removeListener("did-finish-load", onLoadEvent);
      wc.removeListener("did-stop-loading", onLoadEvent);
      wc.removeListener("did-fail-load", onLoadEvent);
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      resolve();
    };

    const onLoadEvent = () => {
      if (!wc.isLoading()) {
        finish();
      }
    };

    const timer = setTimeout(finish, timeout);

    if (!wc.isLoading()) {
      finish();
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
  timeout = 4000,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wc.removeListener("did-start-loading", onStart);
      wc.removeListener("did-navigate", onNavigate);
      wc.removeListener("did-navigate-in-page", onNavigateInPage);
      resolve();
    };
    const onStart = () => {
      // Wait for did-navigate (history commit) then load finish, not just load
      wc.removeListener("did-navigate", onNavigate);
      wc.once("did-navigate", () => {
        void waitForLoad(wc, timeout).then(finish);
      });
      // Safety: if did-navigate never fires, still resolve on load finish
      void waitForLoad(wc, timeout).then(finish);
    };
    const onNavigate = () => {
      // Navigation committed to history — wait for load to complete
      void waitForLoad(wc, timeout).then(finish);
    };
    const onNavigateInPage = () => finish();
    const timer = setTimeout(finish, timeout);

    if (wc.getURL() !== beforeUrl || wc.isLoading()) {
      void waitForLoad(wc, timeout).then(finish);
      return;
    }

    wc.once("did-start-loading", onStart);
    wc.once("did-navigate", onNavigate);
    wc.once("did-navigate-in-page", onNavigateInPage);
  });
}

async function scrollPage(
  wc: WebContents,
  deltaY: number,
): Promise<{
  beforeY: number;
  afterY: number;
  movedY: number;
}> {
  const getScrollY = () =>
    wc.executeJavaScript(`
      (function() {
        return Math.max(
          window.scrollY || 0,
          window.pageYOffset || 0,
          document.scrollingElement?.scrollTop || 0,
          document.documentElement?.scrollTop || 0,
          document.body?.scrollTop || 0,
        );
      })()
    `);

  const beforeY = await getScrollY();
  await wc.executeJavaScript(`window.scrollBy(0, ${deltaY})`);
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
  const target = await wc.executeJavaScript(`
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
  `);

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
  const activated = await wc.executeJavaScript(`
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
  `);

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
  const result = await wc.executeJavaScript(`
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
  `);

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
    href: "href" in result && typeof result.href === "string" ? result.href : undefined,
  };
}

async function clickResolvedSelector(
  wc: WebContents,
  selector: string,
): Promise<string> {
  const beforeUrl = wc.getURL();
  const elInfo = await describeElementForClick(wc, selector);
  if ("error" in elInfo) return `Error: ${elInfo.error}`;

  if (elInfo.href) {
    const validation = await validateLinkDestination(elInfo.href);
    if (validation.status === "dead") {
      return formatDeadLinkMessage(elInfo.text, validation);
    }
  }

  const clickText = `Clicked: ${elInfo.text}`;
  const clickResult = await clickElement(wc, selector);
  if (clickResult.startsWith("Error:")) return clickResult;

  await waitForPotentialNavigation(wc, beforeUrl);
  const afterUrl = wc.getURL();
  if (afterUrl !== beforeUrl) {
    return `${clickText} -> ${afterUrl}`;
  }

  const activationResult = await activateElement(wc, selector);
  if (!activationResult.startsWith("Error:")) {
    await waitForPotentialNavigation(wc, beforeUrl);
    const fallbackUrl = wc.getURL();
    if (fallbackUrl !== beforeUrl) {
      return `${clickText} -> ${fallbackUrl} (recovered via DOM activation)`;
    }
  }

  return `${clickText} (${clickResult})`;
}

async function dismissPopup(wc: WebContents): Promise<string> {
  const before = await extractContent(wc);
  const initialBlocking = before.overlays.filter(
    (overlay) => overlay.blocksInteraction,
  ).length;
  const initialDormant = before.dormantOverlays.length;

  const candidates = await wc.executeJavaScript(`
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
        const classText = text(el.className).toLowerCase();
        const idText = text(el.id).toLowerCase();
        let score = rooted ? 30 : 0;
        if (/^x$|^×$/.test(label)) score += 120;
        if (/no thanks|no, thanks|not now|maybe later|dismiss|close|skip|cancel|continue without|no thank you/.test(label)) score += 100;
        if (/close|dismiss|modal-close|overlay-close/.test(classText + " " + idText)) score += 90;
        if (el.getAttribute("aria-label")) score += 20;
        if (/accept|continue|submit|sign up|subscribe|join|start|next/.test(label)) score -= 80;
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
          const label = text(
            el.getAttribute("aria-label") ||
              el.getAttribute("title") ||
              el.textContent ||
              el.getAttribute("value"),
          );
          if (!label) return;
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
  `);

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

async function resolveSelector(
  wc: WebContents,
  index?: number,
  selector?: string,
): Promise<string | null> {
  if (selector) return selector;
  if (index == null) return null;

  const authoritativeSelector = await wc.executeJavaScript(
    `
      (function() {
        return window.__vessel?.getElementSelector
          ? window.__vessel.getElementSelector(${index})
          : null;
      })()
    `,
  );
  if (typeof authoritativeSelector === "string" && authoritativeSelector) {
    return authoritativeSelector;
  }

  const page = await extractContent(wc);
  const extractedSelector = findSelectorByIndex(page, index);
  if (extractedSelector) return extractedSelector;

  return wc.executeJavaScript(
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
  ].includes(name);
}

async function setElementValue(
  wc: WebContents,
  selector: string,
  value: string,
): Promise<string> {
  return wc.executeJavaScript(`
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
  `);
}

async function typeKeystroke(
  wc: WebContents,
  selector: string,
  value: string,
): Promise<string> {
  return wc.executeJavaScript(`
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
  `);
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
  if (x == null || y == null) return "Error: Could not resolve hover coordinates";

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
    const result = await wc.executeJavaScript(`
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
    `);
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

// Highlight functions extracted to src/main/highlights/inject.ts

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

function resolveBookmarkFolderTarget(
  args: Record<string, any>,
): {
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

  return wc.executeJavaScript(`
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
  `);
}

async function submitForm(
  wc: WebContents,
  args: Record<string, any>,
): Promise<string> {
  const beforeUrl = wc.getURL();
  let selector = await resolveSelector(wc, args.index, args.selector);

  // If no index/selector provided, find the first visible form on the page
  if (!selector) {
    selector = await wc.executeJavaScript(`
      (function() {
        var forms = document.querySelectorAll('form');
        for (var i = 0; i < forms.length; i++) {
          var f = forms[i];
          var rect = f.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return 'form';
        }
        return forms.length > 0 ? 'form' : null;
      })()
    `);
    if (!selector) return "Error: No form found on the page";
  }

  // Get form info to determine submission method
  const formInfo = await wc.executeJavaScript(`
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
      if (method === 'GET') {
        return { action, method, params: params.toString(), found: true };
      }
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
        return { submitted: true, method: 'POST' };
      }
      if (submitter instanceof HTMLElement && typeof submitter.click === 'function') {
        submitter.click();
        return { submitted: true, method: 'POST' };
      }
      form.submit();
      return { submitted: true, method: 'POST' };
    })()
  `);

  if (formInfo.error) return formInfo.error;

  // For GET forms, use loadURL for proper history entry
  if (formInfo.found && formInfo.method === "GET") {
    const url = new URL(formInfo.action);
    if (formInfo.params) {
      url.search = formInfo.params;
    }
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
    return afterUrl !== beforeUrl
      ? `Submitted form via POST -> ${afterUrl}`
      : "Submitted form via POST";
  }

  return "Submitted form";
}

export { waitForLoad, setElementValue };

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

  return wc.executeJavaScript(`
    (function() {
      const key = ${JSON.stringify(key)};
      const selector = ${JSON.stringify(selector)};
      const target =
        selector ? document.querySelector(selector) : document.activeElement;
      if (!target || !(target instanceof HTMLElement)) {
        return selector ? 'Target not found' : 'No focused element';
      }
      target.focus();
      const eventInit = { key, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
      const tag = target.tagName;
      const type = target instanceof HTMLInputElement ? target.type : '';
      if (key === 'Enter' &&
          typeof target.click === 'function' &&
          (tag === 'BUTTON' || (tag === 'INPUT' && (type === 'submit' || type === 'button')))) {
        target.click();
      }
      target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
      return 'Pressed key: ' + key;
    })()
  `);
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
  ];
  const interactActions = ["type_text", "select_option", "hover", "focus"];
  const tabActions = [
    "create_tab",
    "switch_tab",
    "set_ad_blocking",
    "load_session",
  ];

  if (navActions.includes(name)) {
    let warning = "";

    try {
      const page = await extractContent(wc);
      const issue = getRecoverableAccessIssue(page);
      if (issue) {
        const blockedUrl = wc.getURL();
        const canRecover =
          [
            "navigate",
            "open_bookmark",
            "click",
            "submit_form",
            "reload",
            "press_key",
          ].includes(name) && tab.canGoBack();

        if (canRecover && tab.goBack()) {
          await waitForLoad(wc);
          warning = `\n[warning: ${issue.summary} ${issue.recommendation ?? ""} Automatically returned to ${wc.getURL()} after landing on ${blockedUrl}.]`;
        } else {
          warning = `\n[warning: ${issue.summary} ${issue.recommendation ?? ""}${tab.canGoBack() ? "" : " No previous page was available for automatic recovery."}]`;
        }
      }
    } catch {
      // Best-effort post-action warning only
    }

    return `${warning}\n[state: url=${wc.getURL()}, canGoBack=${tab.canGoBack()}, canGoForward=${tab.canGoForward()}, loading=${wc.isLoading()}]`;
  }

  if (interactActions.includes(name)) {
    return `\n[state: url=${wc.getURL()}, tabId=${ctx.tabManager.getActiveTabId()}]`;
  }

  if (tabActions.includes(name)) {
    const activeId = ctx.tabManager.getActiveTabId();
    const count = ctx.tabManager.getAllStates().length;
    return `\n[state: activeTab=${activeId}, totalTabs=${count}]`;
  }

  return "";
}

export async function executeAction(
  name: string,
  args: Record<string, any>,
  ctx: ActionContext,
): Promise<string> {
  const tab = ctx.tabManager.getActiveTab();
  const tabId = ctx.tabManager.getActiveTabId();

  if (
    !tab &&
    ![
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
    ].includes(name)
  ) {
    return "Error: No active tab";
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
          const created = ctx.tabManager.getActiveTab();
          if (created) {
            await waitForLoad(created.view.webContents);
          }
          return `Created tab ${createdId}`;
        }

        case "navigate": {
          if (!wc || !tabId) return "Error: No active tab";
          ctx.tabManager.navigateTab(tabId, args.url);
          await waitForLoad(wc);
          return `Navigated to ${wc.getURL()}`;
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
            ? `Went back to ${afterUrl}`
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
            ? `Went forward to ${afterUrl}`
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

        case "type_text": {
          if (!wc) return "Error: No active tab";
          const selector = await resolveSelector(wc, args.index, args.selector);
          if (!selector) return "Error: No element index or selector provided";
          const mode =
            typeof args.mode === "string" ? args.mode : "default";
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
          const pixels = args.amount || 500;
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

        case "read_page": {
          if (!wc) return "Error: No active tab";
          const content = await extractContent(wc);
          const structured = buildStructuredContext(content);
          const truncated =
            content.content.length > 20000
              ? content.content.slice(0, 20000) + "\n[Content truncated...]"
              : content.content;
          return `${structured}\n\n## PAGE CONTENT\n\n${truncated}`;
        }

        case "wait_for": {
          if (!wc) return "Error: No active tab";
          return waitForCondition(wc, args);
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
            wc && (typeof args.index === "number" || typeof args.selector === "string")
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
            wc && (typeof args.index === "number" || typeof args.selector === "string")
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
            wc && (typeof args.index === "number" || typeof args.selector === "string")
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
          return highlightOnPage(
            wc,
            selector,
            args.text,
            args.label,
            args.durationMs,
          );
        }

        case "clear_highlights": {
          if (!wc) return "Error: No active tab";
          return clearHighlights(wc);
        }

        default:
          return `Unknown tool: ${name}`;
      }
    },
  });

  return result + (await getPostActionState(ctx, name));
}
