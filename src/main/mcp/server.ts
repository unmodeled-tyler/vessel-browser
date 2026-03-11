import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { PageContent } from "../../shared/types";
import type { AgentRuntime } from "../agent/runtime";
import {
  buildStructuredContext,
  buildScopedContext,
  type ExtractMode,
} from "../ai/context-builder";
import { extractContent } from "../content/extractor";
import { findSelectorByIndex } from "./indexed-selector";
import type { TabManager } from "../tabs/tab-manager";
import * as bookmarkManager from "../bookmarks/manager";
import {
  appendToMemoryNote,
  capturePageToVault,
  linkBookmarkToMemory,
  listMemoryNotes,
  searchMemoryNotes,
  writeMemoryNote,
} from "../memory/obsidian";

let httpServer: http.Server | null = null;

function asTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function asPromptResponse(text: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text,
        },
      },
    ],
  };
}

function waitForPotentialNavigation(
  wc: Electron.WebContents,
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
      wc.removeListener("did-navigate", onNavigate);
      wc.once("did-navigate", () => {
        void waitForLoad(wc, timeout).then(finish);
      });
      void waitForLoad(wc, timeout).then(finish);
    };
    const onNavigate = () => {
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
  wc: Electron.WebContents,
  deltaY: number,
): Promise<{
  beforeY: number;
  afterY: number;
  movedY: number;
}> {
  const getSnapshot = async () =>
    wc.executeJavaScript(`
      (function() {
        const width = window.innerWidth || document.documentElement?.clientWidth || 0;
        const height = window.innerHeight || document.documentElement?.clientHeight || 0;
        const scrollY = Math.max(
          window.scrollY || 0,
          window.pageYOffset || 0,
          window.visualViewport?.pageTop || 0,
          document.scrollingElement?.scrollTop || 0,
          document.documentElement?.scrollTop || 0,
          document.body?.scrollTop || 0,
        );
        return {
          x: Math.max(1, Math.round(width / 2)),
          y: Math.max(1, Math.round(height / 2)),
          scrollY,
        };
      })()
    `);

  const before = await getSnapshot();
  wc.sendInputEvent({ type: "mouseMove", x: before.x, y: before.y });
  await sleep(16);
  wc.sendInputEvent({
    type: "mouseWheel",
    x: before.x,
    y: before.y,
    deltaX: 0,
    deltaY,
  });

  let lastY = before.scrollY;
  let stableSamples = 0;
  let moved = false;
  const startedAt = Date.now();

  while (Date.now() - startedAt < 1500) {
    await sleep(50);
    const current = await getSnapshot();
    if (Math.abs(current.scrollY - lastY) < 1) {
      stableSamples += 1;
    } else {
      stableSamples = 0;
      moved = true;
    }
    lastY = current.scrollY;
    if (moved && stableSamples >= 3) {
      break;
    }
  }

  const after = await getSnapshot();
  return {
    beforeY: before.scrollY,
    afterY: after.scrollY,
    movedY: Math.round(after.scrollY - before.scrollY),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickElement(
  wc: Electron.WebContents,
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
      if (!el) return { error: "Element not found" };

      if (el instanceof HTMLElement) {
        el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      }

      await new Promise((resolve) => setTimeout(resolve, 120));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return { error: "Element is not visible" };
      }

      const points = samplePoints(rect);
      const hit = points.find((point) => matchesTarget(document.elementFromPoint(point.x, point.y), el));
      const chosen = hit || points[0];
      const top = document.elementFromPoint(chosen.x, chosen.y);

      return {
        x: Math.round(chosen.x),
        y: Math.round(chosen.y),
        obstructed: !matchesTarget(top, el),
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
  if (x == null || y == null) {
    return "Error: Could not resolve click coordinates";
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

async function dismissPopup(wc: Electron.WebContents): Promise<string> {
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

function isDangerousAction(name: string): boolean {
  return [
    "navigate",
    "click",
    "type",
    "select_option",
    "submit_form",
    "press_key",
    "create_tab",
    "switch_tab",
    "close_tab",
    "restore_checkpoint",
  ].includes(name);
}

function getTabByMatch(tabManager: TabManager, match: string) {
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

function getPostActionState(tabManager: TabManager, name: string): string {
  // Append state context for navigation/interaction actions
  const tab = tabManager.getActiveTab();
  if (!tab) return "";

  const wc = tab.view.webContents;
  const navActions = [
    "navigate",
    "go_back",
    "go_forward",
    "click",
    "submit_form",
    "reload",
  ];
  const interactActions = ["type", "type_text", "select_option", "press_key"];
  const tabActions = ["create_tab", "switch_tab", "close_tab"];

  if (navActions.includes(name)) {
    return `\n[state: url=${wc.getURL()}, canGoBack=${tab.canGoBack()}, canGoForward=${tab.canGoForward()}, loading=${wc.isLoading()}]`;
  }

  if (interactActions.includes(name)) {
    return `\n[state: url=${wc.getURL()}, tabId=${tabManager.getActiveTabId()}]`;
  }

  if (tabActions.includes(name)) {
    const activeId = tabManager.getActiveTabId();
    const count = tabManager.getAllStates().length;
    return `\n[state: activeTab=${activeId}, totalTabs=${count}]`;
  }

  return "";
}

async function withAction(
  runtime: AgentRuntime,
  tabManager: TabManager,
  name: string,
  args: Record<string, unknown>,
  executor: () => Promise<string>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    const result = await runtime.runControlledAction({
      source: "mcp",
      name,
      args,
      tabId: tabManager.getActiveTabId(),
      dangerous: isDangerousAction(name),
      executor,
    });
    const stateInfo = getPostActionState(tabManager, name);
    return asTextResponse(result + stateInfo);
  } catch (error) {
    return asTextResponse(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

async function setElementValue(
  wc: Electron.WebContents,
  selector: string,
  value: string,
): Promise<string> {
  return wc.executeJavaScript(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'Element not found';
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        return 'Element is not a text input';
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return 'Input is disabled';
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

async function selectOption(
  wc: Electron.WebContents,
  index?: number,
  selector?: string,
  label?: string,
  value?: string,
): Promise<string> {
  const resolvedSelector = await resolveSelector(wc, index, selector);
  if (!resolvedSelector)
    return "Error: No select element index or selector provided";

  return wc.executeJavaScript(`
    (function() {
      const el = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!(el instanceof HTMLSelectElement)) {
        return 'Element is not a select dropdown';
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return 'Select is disabled';
      }
      const requestedLabel = ${JSON.stringify(label || "")}.trim().toLowerCase();
      const requestedValue = ${JSON.stringify(value || "")}.trim();
      const option = Array.from(el.options).find((item) => {
        const optionLabel = (item.textContent || '').trim().toLowerCase();
        return (requestedLabel && optionLabel === requestedLabel) ||
          (requestedValue && item.value === requestedValue);
      });
      if (!option) return 'Option not found';
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'Selected: ' + ((option.textContent || option.value).trim().slice(0, 100));
    })()
  `);
}

async function submitForm(
  wc: Electron.WebContents,
  index?: number,
  selector?: string,
): Promise<string> {
  let resolvedSelector = await resolveSelector(wc, index, selector);

  // If no index/selector provided, find the first visible form on the page
  if (!resolvedSelector) {
    resolvedSelector = await wc.executeJavaScript(`
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
    if (!resolvedSelector) return "Error: No form found on the page";
  }

  // Get form info to determine submission method
  const formInfo = await wc.executeJavaScript(`
    (function() {
      const target = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!target) return { error: 'Target not found' };
      // Find the form: nested, or linked via form="id" attribute
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
      // For POST forms, submit via JS and let navigation happen
      if (submitter instanceof HTMLElement) {
        submitter.click();
        return { submitted: true, method: 'POST' };
      }
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.submit();
      }
      return { submitted: true, method: 'POST' };
    })()
  `);

  if (formInfo.error) return formInfo.error;

  // For GET forms, use loadURL to ensure proper history entry
  if (formInfo.found && formInfo.method === "GET") {
    const url = new URL(formInfo.action);
    if (formInfo.params) {
      url.search = formInfo.params;
    }
    wc.loadURL(url.toString());
    return "Submitted form via GET";
  }

  // POST forms were already submitted via JS above
  return formInfo.submitted ? "Submitted form via POST" : "Submitted form";
}

async function pressKey(
  wc: Electron.WebContents,
  key: string,
  index?: number,
  selector?: string,
): Promise<string> {
  const resolvedSelector = await resolveSelector(wc, index, selector);

  return wc.executeJavaScript(`
    (function() {
      const key = ${JSON.stringify(key)};
      const selector = ${JSON.stringify(resolvedSelector)};
      const target = selector ? document.querySelector(selector) : document.activeElement;
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

async function waitForCondition(
  wc: Electron.WebContents,
  text?: string,
  selector?: string,
  timeoutMs?: number,
): Promise<string> {
  const effectiveTimeout = Math.max(250, timeoutMs || 5000);
  const expectedText = (text || "").trim();
  const expectedSelector = (selector || "").trim();

  if (!expectedText && !expectedSelector) {
    return "Error: wait_for requires text or selector";
  }

  // Wait for any pending load to finish first
  if (wc.isLoading()) {
    await waitForLoad(wc, Math.min(effectiveTimeout, 5000));
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < effectiveTimeout) {
    const result = await wc.executeJavaScript(`
      (function() {
        var selector = ${JSON.stringify(expectedSelector)};
        var text = ${JSON.stringify(expectedText)};
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
      return `Matched selector ${expectedSelector}`;
    }
    if (result === "text") {
      return `Matched text "${expectedText.slice(0, 80)}"`;
    }
    if (typeof result === "string" && result.startsWith("invalid_selector:")) {
      return `Error: Invalid selector "${expectedSelector}" — ${result.slice(17)}`;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  // On timeout, provide diagnostic info
  const diagnostic = expectedSelector
    ? await wc.executeJavaScript(`
        (function() {
          try {
            var count = document.querySelectorAll(${JSON.stringify(expectedSelector)}).length;
            return count > 0 ? 'found ' + count + ' after timeout' : 'not found (page has ' + document.querySelectorAll('*').length + ' elements)';
          } catch (e) { return 'selector error: ' + e.message; }
        })()
      `)
    : "";

  const suffix = diagnostic ? ` (${diagnostic})` : "";
  return expectedSelector
    ? `Timed out waiting for selector ${expectedSelector}${suffix}`
    : `Timed out waiting for text "${expectedText.slice(0, 80)}"`;
}

const VESSEL_HIGHLIGHT_CSS = `
.__vessel-highlight {
  outline: 3px solid #f0c636 !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 12px rgba(240, 198, 54, 0.5) !important;
  transition: outline-color 0.3s, box-shadow 0.3s;
}
.__vessel-highlight-text {
  background: rgba(240, 198, 54, 0.3) !important;
  border-bottom: 2px solid #f0c636 !important;
  padding: 1px 2px !important;
  border-radius: 2px !important;
}
.__vessel-highlight-label {
  position: absolute;
  background: #f0c636;
  color: #1a1a1e;
  font-size: 11px;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  padding: 2px 8px;
  border-radius: 4px;
  z-index: 999999;
  pointer-events: none;
  white-space: nowrap;
  box-shadow: 0 2px 6px rgba(0,0,0,0.3);
}
`;

async function highlightOnPage(
  wc: Electron.WebContents,
  resolvedSelector?: string | null,
  text?: string,
  label?: string,
  durationMs?: number,
): Promise<string> {
  // Inject styles once
  await wc.executeJavaScript(`
    (function() {
      if (!document.getElementById('__vessel-highlight-styles')) {
        var s = document.createElement('style');
        s.id = '__vessel-highlight-styles';
        s.textContent = ${JSON.stringify(VESSEL_HIGHLIGHT_CSS)};
        document.head.appendChild(s);
      }
    })()
  `);

  // Highlight by element selector
  if (resolvedSelector) {
    return wc.executeJavaScript(`
      (function() {
        var el = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!el) return 'Element not found';
        el.classList.add('__vessel-highlight');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });

        var label = ${JSON.stringify(label || "")};
        if (label) {
          var badge = document.createElement('div');
          badge.className = '__vessel-highlight-label';
          badge.textContent = label;
          badge.setAttribute('data-vessel-highlight', 'true');
          document.body.appendChild(badge);
          var rect = el.getBoundingClientRect();
          badge.style.top = (window.scrollY + rect.top - badge.offsetHeight - 4) + 'px';
          badge.style.left = (window.scrollX + rect.left) + 'px';
        }

        var duration = ${durationMs ?? 0};
        if (duration > 0) {
          setTimeout(function() {
            el.classList.remove('__vessel-highlight');
            if (badge) badge.remove();
          }, duration);
        }

        var desc = (el.textContent || el.tagName).trim().slice(0, 80);
        return 'Highlighted: ' + desc;
      })()
    `);
  }

  // Highlight by text search
  if (text) {
    return wc.executeJavaScript(`
      (function() {
        var searchText = ${JSON.stringify(text)};
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        var count = 0;
        var firstMark = null;
        var node;
        while ((node = walker.nextNode())) {
          var idx = node.textContent.indexOf(searchText);
          if (idx === -1) continue;
          var range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + searchText.length);
          var mark = document.createElement('mark');
          mark.className = '__vessel-highlight-text';
          mark.setAttribute('data-vessel-highlight', 'true');
          range.surroundContents(mark);
          if (!firstMark) firstMark = mark;
          count++;
          if (count >= 20) break;
        }
        if (count === 0) return 'Text not found: ' + searchText.slice(0, 80);
        if (firstMark) firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });

        var label = ${JSON.stringify(label || "")};
        if (label && firstMark) {
          var badge = document.createElement('div');
          badge.className = '__vessel-highlight-label';
          badge.textContent = label;
          badge.setAttribute('data-vessel-highlight', 'true');
          document.body.appendChild(badge);
          var rect = firstMark.getBoundingClientRect();
          badge.style.top = (window.scrollY + rect.top - badge.offsetHeight - 4) + 'px';
          badge.style.left = (window.scrollX + rect.left) + 'px';
        }

        var duration = ${durationMs ?? 0};
        if (duration > 0) {
          setTimeout(function() {
            document.querySelectorAll('mark.__vessel-highlight-text[data-vessel-highlight]').forEach(function(m) {
              var parent = m.parentNode;
              while (m.firstChild) parent.insertBefore(m.firstChild, m);
              m.remove();
              parent.normalize();
            });
            document.querySelectorAll('.__vessel-highlight-label[data-vessel-highlight]').forEach(function(b) { b.remove(); });
          }, duration);
        }

        return 'Highlighted ' + count + ' occurrence' + (count > 1 ? 's' : '') + ' of: ' + searchText.slice(0, 80);
      })()
    `);
  }

  return "Error: No element or text to highlight";
}

async function clearHighlights(wc: Electron.WebContents): Promise<string> {
  return wc.executeJavaScript(`
    (function() {
      var count = 0;
      document.querySelectorAll('.__vessel-highlight').forEach(function(el) {
        el.classList.remove('__vessel-highlight');
        count++;
      });
      document.querySelectorAll('mark.__vessel-highlight-text[data-vessel-highlight]').forEach(function(m) {
        var parent = m.parentNode;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        m.remove();
        parent.normalize();
        count++;
      });
      document.querySelectorAll('.__vessel-highlight-label[data-vessel-highlight]').forEach(function(b) { b.remove(); });
      var style = document.getElementById('__vessel-highlight-styles');
      if (style) style.remove();
      return count > 0 ? 'Cleared ' + count + ' highlight' + (count > 1 ? 's' : '') : 'No highlights to clear';
    })()
  `);
}

async function captureScreenshotPayload(
  wc: Electron.WebContents,
): Promise<
  | { ok: true; base64: string; width: number; height: number }
  | { ok: false; error: string }
> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    const image = await wc.capturePage();
    if (!image.isEmpty()) {
      const size = image.getSize();
      const base64 = image.toPNG().toString("base64");
      if (base64) {
        return {
          ok: true,
          base64,
          width: size.width,
          height: size.height,
        };
      }
    }
  }

  return { ok: false, error: "page image was empty after 3 attempts" };
}

function registerTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerPrompt(
    "vessel-supervisor-brief",
    {
      title: "Vessel Supervisor Brief",
      description:
        "A reusable prompt for reviewing the current Vessel runtime state.",
    },
    async () => {
      const state = runtime.getState();
      return asPromptResponse(
        [
          "Review the current Vessel runtime state.",
          `Paused: ${state.supervisor.paused ? "yes" : "no"}`,
          `Approval mode: ${state.supervisor.approvalMode}`,
          `Pending approvals: ${state.supervisor.pendingApprovals.length}`,
          `Open tabs: ${state.session?.tabs.length || 0}`,
          `Recent actions: ${
            state.actions
              .slice(-5)
              .map((action) => action.name)
              .join(", ") || "none"
          }`,
        ].join("\n"),
      );
    },
  );

  server.registerResource(
    "vessel-runtime-state",
    "vessel://runtime/state",
    {
      title: "Vessel Runtime State",
      description:
        "Current supervisor, session, and checkpoint state for the Vessel browser runtime.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "vessel://runtime/state",
          text: JSON.stringify(runtime.getState(), null, 2),
        },
      ],
    }),
  );

  const EXTRACT_MODES: ExtractMode[] = [
    "full",
    "summary",
    "interactives_only",
    "forms_only",
    "text_only",
    "visible_only",
  ];

  function buildExtractResponse(
    pageContent: PageContent,
    mode: ExtractMode,
    adBlockingEnabled: boolean,
  ): string {
    const adBlockLine = `**Ad Blocking:** ${adBlockingEnabled ? "On" : "Off"}`;

    if (mode === "full") {
      const structured = buildStructuredContext(pageContent);
      const truncated =
        pageContent.content.length > 30000
          ? pageContent.content.slice(0, 30000) + "\n[Content truncated...]"
          : pageContent.content;
      return `${adBlockLine}\n\n${structured}\n\n## PAGE CONTENT\n\n${truncated}`;
    }
    if (mode === "text_only") {
      return `${adBlockLine}\n\n${buildScopedContext(pageContent, mode)}`;
    }
    return `${adBlockLine}\n\n${buildScopedContext(pageContent, mode)}`;
  }

  server.registerTool(
    "vessel_extract_content",
    {
      title: "Extract Page Content",
      description:
        "Extract structured content from the current page. Modes: 'full' (default, everything), 'summary' (title+headings+stats), 'interactives_only' (clickable elements with indices), 'forms_only' (form fields only), 'text_only' (page text, no interactives), 'visible_only' (only currently visible, in-viewport, unobstructed elements plus active overlays).",
      inputSchema: {
        mode: z
          .enum(EXTRACT_MODES as [string, ...string[]])
          .optional()
          .describe(
            "Extraction mode: full, summary, interactives_only, forms_only, text_only, visible_only",
          ),
      },
    },
    async ({ mode }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");

      try {
        const pageContent = await extractContent(tab.view.webContents);
        const effectiveMode = (mode || "full") as ExtractMode;
        return asTextResponse(
          buildExtractResponse(
            pageContent,
            effectiveMode,
            tab.state.adBlockingEnabled,
          ),
        );
      } catch (error) {
        return asTextResponse(
          `Error extracting content: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    },
  );

  server.registerTool(
    "vessel_read_page",
    {
      title: "Read Page",
      description:
        "Alias for vessel_extract_content. Supports same modes: full, summary, interactives_only, forms_only, text_only, visible_only.",
      inputSchema: {
        mode: z
          .enum(EXTRACT_MODES as [string, ...string[]])
          .optional()
          .describe(
            "Extraction mode: full, summary, interactives_only, forms_only, text_only, visible_only",
          ),
      },
    },
    async ({ mode }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");

      try {
        const pageContent = await extractContent(tab.view.webContents);
        const effectiveMode = (mode || "full") as ExtractMode;
        return asTextResponse(
          buildExtractResponse(
            pageContent,
            effectiveMode,
            tab.state.adBlockingEnabled,
          ),
        );
      } catch (error) {
        return asTextResponse(
          `Error extracting content: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    },
  );

  server.registerTool(
    "vessel_list_tabs",
    {
      title: "List Tabs",
      description:
        "List all open browser tabs with their IDs, titles, and URLs.",
    },
    async () => {
      const activeId = tabManager.getActiveTabId();
      const lines = tabManager
        .getAllStates()
        .map(
          (tab) =>
            `${tab.id === activeId ? "->" : "  "} [${tab.id}] ${tab.title} — ${tab.url} [adblock:${tab.adBlockingEnabled ? "on" : "off"}]`,
        );
      return asTextResponse(lines.join("\n") || "No tabs open");
    },
  );

  server.registerTool(
    "vessel_navigate",
    {
      title: "Navigate",
      description: "Navigate the active browser tab to a URL.",
      inputSchema: { url: z.string().describe("The URL to navigate to") },
    },
    async ({ url }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(runtime, tabManager, "navigate", { url }, async () => {
        const id = tabManager.getActiveTabId()!;
        tabManager.navigateTab(id, url);
        await waitForLoad(tab.view.webContents);
        return `Navigated to ${tab.view.webContents.getURL()}`;
      });
    },
  );

  server.registerTool(
    "vessel_set_ad_blocking",
    {
      title: "Set Ad Blocking",
      description:
        "Enable or disable ad blocking for the active tab or a matched tab. Reload after changes unless reload is false.",
      inputSchema: {
        enabled: z
          .boolean()
          .describe("Whether ad blocking should be enabled for the target tab"),
        tabId: z
          .string()
          .optional()
          .describe("Exact tab ID to target instead of the active tab"),
        match: z
          .string()
          .optional()
          .describe("Case-insensitive partial match against tab title or URL"),
        reload: z
          .boolean()
          .optional()
          .describe("Reload the tab after changing the setting (default true)"),
      },
    },
    async ({ enabled, tabId, match, reload }) => {
      const activeTab = tabManager.getActiveTab();
      if (!activeTab && !tabId && !match) {
        return asTextResponse("Error: No active tab");
      }

      return withAction(
        runtime,
        tabManager,
        "set_ad_blocking",
        { enabled, tabId, match, reload },
        async () => {
          let targetId = typeof tabId === "string" ? tabId.trim() : "";
          if (!targetId && typeof match === "string" && match.trim()) {
            targetId = getTabByMatch(tabManager, match.trim())?.id || "";
          }
          if (!targetId) {
            targetId = tabManager.getActiveTabId() || "";
          }
          if (!targetId) return "Error: No target tab found";

          const targetTab = tabManager.getTab(targetId);
          if (!targetTab) return "Error: Target tab not found";

          tabManager.setAdBlockingEnabled(targetId, enabled);

          const shouldReload = reload !== false;
          if (shouldReload) {
            targetTab.reload();
            await waitForLoad(targetTab.view.webContents);
          }

          const state = targetTab.state;
          return `${enabled ? "Enabled" : "Disabled"} ad blocking for "${state.title}"${shouldReload ? " and reloaded the tab" : ""}`;
        },
      );
    },
  );

  server.registerTool(
    "vessel_go_back",
    {
      title: "Go Back",
      description: "Go back in browser history.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(runtime, tabManager, "go_back", {}, async () => {
        if (!tab.canGoBack()) {
          return "No previous page in history";
        }
        const beforeUrl = tab.view.webContents.getURL();
        tabManager.goBack(tabManager.getActiveTabId()!);
        await waitForLoad(tab.view.webContents);
        const afterUrl = tab.view.webContents.getURL();
        return afterUrl !== beforeUrl
          ? `Went back to ${afterUrl}`
          : `Back action completed but page stayed on ${afterUrl}`;
      });
    },
  );

  server.registerTool(
    "vessel_go_forward",
    {
      title: "Go Forward",
      description: "Go forward in browser history.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(runtime, tabManager, "go_forward", {}, async () => {
        if (!tab.canGoForward()) {
          return "No forward page in history";
        }
        const beforeUrl = tab.view.webContents.getURL();
        tabManager.goForward(tabManager.getActiveTabId()!);
        await waitForLoad(tab.view.webContents);
        const afterUrl = tab.view.webContents.getURL();
        return afterUrl !== beforeUrl
          ? `Went forward to ${afterUrl}`
          : `Forward action completed but page stayed on ${afterUrl}`;
      });
    },
  );

  server.registerTool(
    "vessel_reload",
    {
      title: "Reload",
      description: "Reload the current page.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(runtime, tabManager, "reload", {}, async () => {
        tabManager.reloadTab(tabManager.getActiveTabId()!);
        await waitForLoad(tab.view.webContents);
        return `Reloaded ${tab.view.webContents.getURL()}`;
      });
    },
  );

  server.registerTool(
    "vessel_click",
    {
      title: "Click Element",
      description:
        "Click an element on the page by its index number or CSS selector.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from the page content listing"),
        selector: z.string().optional().describe("CSS selector as fallback"),
      },
    },
    async ({ index, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "click",
        { index, selector },
        async () => {
          const wc = tab.view.webContents;
          const beforeUrl = wc.getURL();
          const resolvedSelector = await resolveSelector(wc, index, selector);
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          // Get element info — check if it's a link with an href
          const elInfo = await wc.executeJavaScript(`
            (function() {
              const el = document.querySelector(${JSON.stringify(resolvedSelector)});
              if (!el) return { error: 'Element not found' };
              const text = (el.textContent || el.tagName).trim().slice(0, 100);
              const href = el.tagName === 'A' ? el.href : null;
              return { text: text, href: href };
            })()
          `);
          if (elInfo.error) return elInfo.error;
          const clickText = `Clicked: ${elInfo.text}`;

          // For anchor links: use loadURL (browser-initiated = guaranteed history)
          if (
            elInfo.href &&
            elInfo.href !== beforeUrl &&
            !elInfo.href.startsWith("javascript:") &&
            !elInfo.href.startsWith("#")
          ) {
            wc.loadURL(elInfo.href);
            await waitForLoad(wc);
            const afterUrl = wc.getURL();
            return `${clickText} -> ${afterUrl}`;
          }

          const clickResult = await clickElement(wc, resolvedSelector);
          if (clickResult.startsWith("Error:")) return clickResult;
          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          return afterUrl !== beforeUrl
            ? `${clickText} -> ${afterUrl}`
            : `${clickText} (${clickResult})`;
        },
      );
    },
  );

  server.registerTool(
    "vessel_type",
    {
      title: "Type Text",
      description:
        "Type text into an input field or textarea. Clears existing content first.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from the page content listing"),
        selector: z.string().optional().describe("CSS selector as fallback"),
        text: z.string().describe("The text to type"),
      },
    },
    async ({ index, selector, text }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "type",
        { index, selector, text },
        async () => {
          const resolvedSelector = await resolveSelector(
            tab.view.webContents,
            index,
            selector,
          );
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          return setElementValue(tab.view.webContents, resolvedSelector, text);
        },
      );
    },
  );

  server.registerTool(
    "vessel_type_text",
    {
      title: "Type Text",
      description:
        "Alias for vessel_type. Type text into an input field or textarea.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from the page content listing"),
        selector: z.string().optional().describe("CSS selector as fallback"),
        text: z.string().describe("The text to type"),
      },
    },
    async ({ index, selector, text }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "type_text",
        { index, selector, text },
        async () => {
          const resolvedSelector = await resolveSelector(
            tab.view.webContents,
            index,
            selector,
          );
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          return setElementValue(tab.view.webContents, resolvedSelector, text);
        },
      );
    },
  );

  server.registerTool(
    "vessel_select_option",
    {
      title: "Select Option",
      description: "Select an option in a dropdown by label or value.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Select element index from extracted content"),
        selector: z.string().optional().describe("CSS selector as fallback"),
        label: z.string().optional().describe("Visible option label"),
        value: z.string().optional().describe("Option value"),
      },
    },
    async ({ index, selector, label, value }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "select_option",
        { index, selector, label, value },
        async () =>
          selectOption(tab.view.webContents, index, selector, label, value),
      );
    },
  );

  server.registerTool(
    "vessel_submit_form",
    {
      title: "Submit Form",
      description:
        "Submit a form using a field index, submit button index, form selector, or button selector.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Index of a form field or submit button"),
        selector: z
          .string()
          .optional()
          .describe("Form or submit button selector"),
      },
    },
    async ({ index, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "submit_form",
        { index, selector },
        async () => {
          const wc = tab.view.webContents;
          const beforeUrl = wc.getURL();
          const result = await submitForm(wc, index, selector);
          if (
            result.startsWith("Error") ||
            result.startsWith("Target") ||
            result.startsWith("No parent") ||
            result.startsWith("Submit control")
          ) {
            return result;
          }
          // Wait for navigation from form submission
          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          return afterUrl !== beforeUrl ? `${result} -> ${afterUrl}` : result;
        },
      );
    },
  );

  server.registerTool(
    "vessel_press_key",
    {
      title: "Press Key",
      description:
        "Press a keyboard key, optionally after focusing an element.",
      inputSchema: {
        key: z.string().describe("Keyboard key such as Enter or Escape"),
        index: z.number().optional().describe("Element index to focus first"),
        selector: z.string().optional().describe("CSS selector to focus first"),
      },
    },
    async ({ key, index, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "press_key",
        { key, index, selector },
        async () => {
          const wc = tab.view.webContents;
          const beforeUrl = wc.getURL();
          const result = await pressKey(wc, key, index, selector);
          // Enter can trigger form submission or navigation
          if (key === "Enter") {
            await waitForPotentialNavigation(wc, beforeUrl, 3000);
            const afterUrl = wc.getURL();
            if (afterUrl !== beforeUrl) {
              return `${result} -> ${afterUrl}`;
            }
          }
          return result;
        },
      );
    },
  );

  server.registerTool(
    "vessel_scroll",
    {
      title: "Scroll Page",
      description: "Scroll the page up or down.",
      inputSchema: {
        direction: z.enum(["up", "down"]).describe("Scroll direction"),
        amount: z
          .number()
          .optional()
          .describe("Pixels to scroll (default 500)"),
      },
    },
    async ({ direction, amount }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "scroll",
        { direction, amount },
        async () => {
          const pixels = amount || 500;
          const dir = direction === "up" ? -pixels : pixels;
          const result = await scrollPage(tab.view.webContents, dir);
          return `Scrolled ${direction} by ${pixels}px (moved ${Math.abs(result.movedY)}px, now at y=${Math.round(result.afterY)})`;
        },
      );
    },
  );

  server.registerTool(
    "vessel_dismiss_popup",
    {
      title: "Dismiss Popup",
      description:
        "Dismiss a modal, popup, newsletter gate, cookie banner, or blocking overlay using common close and decline actions.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(runtime, tabManager, "dismiss_popup", {}, async () =>
        dismissPopup(tab.view.webContents),
      );
    },
  );

  server.registerTool(
    "vessel_wait_for",
    {
      title: "Wait For",
      description: "Wait for text or a selector to appear on the current page.",
      inputSchema: {
        text: z.string().optional().describe("Text expected in the page body"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector expected on the page"),
        timeoutMs: z
          .number()
          .optional()
          .describe("Maximum wait in milliseconds"),
      },
    },
    async ({ text, selector, timeoutMs }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "wait_for",
        { text, selector, timeoutMs },
        async () =>
          waitForCondition(tab.view.webContents, text, selector, timeoutMs),
      );
    },
  );

  server.registerTool(
    "vessel_create_tab",
    {
      title: "Create Tab",
      description: "Open a new browser tab, optionally navigating to a URL.",
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe("URL to open (defaults to about:blank)"),
      },
    },
    async ({ url }) =>
      withAction(runtime, tabManager, "create_tab", { url }, async () => {
        const id = tabManager.createTab(url || "about:blank");
        const tab = tabManager.getActiveTab();
        if (tab) {
          await waitForLoad(tab.view.webContents);
        }
        return `Created tab ${id}`;
      }),
  );

  server.registerTool(
    "vessel_switch_tab",
    {
      title: "Switch Tab",
      description:
        "Switch to a different browser tab by ID or title/URL match.",
      inputSchema: {
        tabId: z.string().optional().describe("The tab ID to switch to"),
        match: z
          .string()
          .optional()
          .describe("Case-insensitive match against title or URL"),
      },
    },
    async ({ tabId, match }) =>
      withAction(
        runtime,
        tabManager,
        "switch_tab",
        { tabId, match },
        async () => {
          const targetId =
            tabId || (match ? getTabByMatch(tabManager, match)?.id : "");
          if (!targetId) {
            return "Error: No matching tab found";
          }
          tabManager.switchTab(targetId);
          return `Switched to tab ${targetId}`;
        },
      ),
  );

  server.registerTool(
    "vessel_close_tab",
    {
      title: "Close Tab",
      description: "Close a browser tab by its ID.",
      inputSchema: {
        tabId: z.string().describe("The tab ID to close"),
      },
    },
    async ({ tabId }) =>
      withAction(runtime, tabManager, "close_tab", { tabId }, async () => {
        tabManager.closeTab(tabId);
        return `Closed tab ${tabId}`;
      }),
  );

  server.registerTool(
    "vessel_checkpoint_create",
    {
      title: "Create Checkpoint",
      description: "Capture the current session as a named checkpoint.",
      inputSchema: {
        name: z.string().optional().describe("Optional checkpoint name"),
        note: z.string().optional().describe("Optional note"),
      },
    },
    async ({ name, note }) =>
      withAction(
        runtime,
        tabManager,
        "create_checkpoint",
        { name, note },
        async () => {
          const checkpoint = runtime.createCheckpoint(name, note);
          return `Created checkpoint ${checkpoint.name} (${checkpoint.id})`;
        },
      ),
  );

  server.registerTool(
    "vessel_create_checkpoint",
    {
      title: "Create Checkpoint",
      description:
        "Alias for vessel_checkpoint_create. Capture the current session as a checkpoint.",
      inputSchema: {
        name: z.string().optional().describe("Optional checkpoint name"),
        note: z.string().optional().describe("Optional note"),
      },
    },
    async ({ name, note }) =>
      withAction(
        runtime,
        tabManager,
        "create_checkpoint",
        { name, note },
        async () => {
          const checkpoint = runtime.createCheckpoint(name, note);
          return `Created checkpoint ${checkpoint.name} (${checkpoint.id})`;
        },
      ),
  );

  server.registerTool(
    "vessel_checkpoint_restore",
    {
      title: "Restore Checkpoint",
      description: "Restore a saved checkpoint by ID or exact name.",
      inputSchema: {
        checkpointId: z.string().optional().describe("Checkpoint ID"),
        name: z.string().optional().describe("Exact checkpoint name"),
      },
    },
    async ({ checkpointId, name }) =>
      withAction(
        runtime,
        tabManager,
        "restore_checkpoint",
        { checkpointId, name },
        async () => {
          const state = runtime.getState();
          const checkpoint =
            state.checkpoints.find((item) => item.id === checkpointId) ||
            state.checkpoints.find((item) => item.name === name);
          if (!checkpoint) {
            return "Error: No matching checkpoint found";
          }
          runtime.restoreCheckpoint(checkpoint.id);
          return `Restored checkpoint ${checkpoint.name}`;
        },
      ),
  );

  server.registerTool(
    "vessel_restore_checkpoint",
    {
      title: "Restore Checkpoint",
      description:
        "Alias for vessel_checkpoint_restore. Restore a saved checkpoint by ID or exact name.",
      inputSchema: {
        checkpointId: z.string().optional().describe("Checkpoint ID"),
        name: z.string().optional().describe("Exact checkpoint name"),
      },
    },
    async ({ checkpointId, name }) =>
      withAction(
        runtime,
        tabManager,
        "restore_checkpoint",
        { checkpointId, name },
        async () => {
          const state = runtime.getState();
          const checkpoint =
            state.checkpoints.find((item) => item.id === checkpointId) ||
            state.checkpoints.find((item) => item.name === name);
          if (!checkpoint) {
            return "Error: No matching checkpoint found";
          }
          runtime.restoreCheckpoint(checkpoint.id);
          return `Restored checkpoint ${checkpoint.name}`;
        },
      ),
  );

  server.registerTool(
    "vessel_screenshot",
    {
      title: "Screenshot",
      description:
        "Capture a screenshot of the current page. Returns a base64-encoded PNG image.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");

      try {
        const bounds = tab.view.getBounds();
        if (bounds.width <= 0 || bounds.height <= 0) {
          return asTextResponse(
            "Error capturing screenshot: active tab has zero-sized bounds",
          );
        }
        const screenshot = await captureScreenshotPayload(tab.view.webContents);
        if (!screenshot.ok) {
          return asTextResponse(
            `Error capturing screenshot: ${screenshot.error}`,
          );
        }
        return {
          content: [
            {
              type: "image" as const,
              data: screenshot.base64,
              mimeType: "image/png",
            },
            {
              type: "text" as const,
              text: `Screenshot captured: ${screenshot.width}x${screenshot.height}`,
            },
          ],
        };
      } catch (error) {
        return asTextResponse(
          `Error capturing screenshot: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    },
  );

  server.registerTool(
    "vessel_highlight",
    {
      title: "Highlight Element",
      description:
        "Visually highlight an element or text on the page for the user. Use to draw attention to specific parts of the page. Highlights persist until cleared.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from extracted content to highlight"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector of element to highlight"),
        text: z
          .string()
          .optional()
          .describe(
            "Text to find and highlight on the page (highlights all occurrences)",
          ),
        label: z
          .string()
          .optional()
          .describe("Optional annotation label to display near the highlight"),
        durationMs: z
          .number()
          .optional()
          .describe(
            "Auto-clear after this many milliseconds (omit for permanent)",
          ),
      },
    },
    async ({ index, selector, text, label, durationMs }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "highlight",
        { index, selector, text, label, durationMs },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector = await resolveSelector(wc, index, selector);
          return highlightOnPage(wc, resolvedSelector, text, label, durationMs);
        },
      );
    },
  );

  server.registerTool(
    "vessel_clear_highlights",
    {
      title: "Clear Highlights",
      description: "Remove all visual highlights from the current page.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(runtime, tabManager, "clear_highlights", {}, async () =>
        clearHighlights(tab.view.webContents),
      );
    },
  );

  // --- Bookmark tools ---

  server.registerTool(
    "vessel_create_folder",
    {
      title: "Create Bookmark Folder",
      description: "Create a named folder for organizing bookmarks.",
      inputSchema: {
        name: z.string().describe("Name for the new folder"),
        summary: z
          .string()
          .optional()
          .describe("Optional one-sentence summary shown in the UI"),
      },
    },
    async ({ name, summary }) => {
      return withAction(
        runtime,
        tabManager,
        "create_bookmark_folder",
        { name, summary },
        async () => {
          const folder = bookmarkManager.createFolderWithSummary(name, summary);
          return `Created folder "${folder.name}" (id=${folder.id})`;
        },
      );
    },
  );

  server.registerTool(
    "vessel_bookmark_save",
    {
      title: "Save Bookmark",
      description:
        "Save a URL to a bookmark folder. Omit folder_id to save to Unsorted.",
      inputSchema: {
        url: z.string().describe("URL to bookmark"),
        title: z.string().describe("Human-readable title for the bookmark"),
        folder_id: z
          .string()
          .optional()
          .describe("Folder ID to save into (omit for Unsorted)"),
        note: z
          .string()
          .optional()
          .describe("Optional note about why this was bookmarked"),
      },
    },
    async ({ url, title, folder_id, note }) => {
      return withAction(
        runtime,
        tabManager,
        "save_bookmark",
        { url, title, folder_id, note },
        async () => {
          const bookmark = bookmarkManager.saveBookmark(
            url,
            title,
            folder_id,
            note,
          );
          const folderLabel =
            bookmark.folderId === "unsorted"
              ? "Unsorted"
              : (bookmarkManager
                  .getState()
                  .folders.find((f) => f.id === bookmark.folderId)?.name ??
                bookmark.folderId);
          return `Saved "${bookmark.title}" (${bookmark.url}) to "${folderLabel}" (id=${bookmark.id})`;
        },
      );
    },
  );

  server.registerTool(
    "vessel_bookmark_list",
    {
      title: "List Bookmarks",
      description:
        "List all bookmark folders and their contents. Optionally filter by folder.",
      inputSchema: {
        folder_id: z
          .string()
          .optional()
          .describe("Filter to a specific folder ID (omit for all)"),
      },
    },
    async ({ folder_id }) => {
      return withAction(
        runtime,
        tabManager,
        "list_bookmarks",
        { folder_id },
        async () => {
          const state = bookmarkManager.getState();
          const folders = [
            { id: "unsorted", name: "Unsorted" },
            ...state.folders,
          ];
          const lines: string[] = [];
          for (const folder of folders) {
            if (folder_id && folder.id !== folder_id) continue;
            const items = state.bookmarks.filter(
              (b) => b.folderId === folder.id,
            );
            lines.push(
              `\n[${folder.name}] (id=${folder.id}, ${items.length} items)`,
            );
            if ("summary" in folder && typeof folder.summary === "string") {
              lines.push(`  summary: ${folder.summary}`);
            }
            for (const b of items) {
              lines.push(
                `  - ${b.title} | ${b.url} | id=${b.id}${b.note ? ` | note: ${b.note}` : ""}`,
              );
            }
          }
          return lines.length
            ? lines.join("\n").trim()
            : "No bookmarks saved yet.";
        },
      );
    },
  );

  server.registerTool(
    "vessel_bookmark_search",
    {
      title: "Search Bookmarks",
      description:
        "Search bookmarks by title, URL, note, folder name, or folder summary.",
      inputSchema: {
        query: z.string().describe("Search term to match against bookmarks"),
      },
    },
    async ({ query }) => {
      return withAction(
        runtime,
        tabManager,
        "search_bookmarks",
        { query },
        async () => {
          const matches = bookmarkManager.searchBookmarks(query);
          if (matches.length === 0) {
            return `No bookmarks matched "${query}"`;
          }

          const lines = matches.map(({ bookmark, folder }) => {
            const folderLabel =
              bookmark.folderId === "unsorted"
                ? "Unsorted"
                : (folder?.name ?? bookmark.folderId);
            return `- ${bookmark.title} | ${bookmark.url} | folder=${folderLabel} | id=${bookmark.id}${bookmark.note ? ` | note: ${bookmark.note}` : ""}`;
          });
          return [`Matches for "${query}" (${matches.length})`, ...lines].join(
            "\n",
          );
        },
      );
    },
  );

  server.registerTool(
    "vessel_bookmark_remove",
    {
      title: "Remove Bookmark",
      description: "Remove a specific bookmark by its ID.",
      inputSchema: {
        bookmark_id: z.string().describe("ID of the bookmark to remove"),
      },
    },
    async ({ bookmark_id }) => {
      return withAction(
        runtime,
        tabManager,
        "remove_bookmark",
        { bookmark_id },
        async () => {
          const removed = bookmarkManager.removeBookmark(bookmark_id);
          return removed
            ? `Removed bookmark ${bookmark_id}`
            : `Bookmark ${bookmark_id} not found`;
        },
      );
    },
  );

  server.registerTool(
    "vessel_bookmark_open",
    {
      title: "Open Bookmark",
      description:
        "Open a saved bookmark by bookmark ID. Optionally open it in a new tab.",
      inputSchema: {
        bookmark_id: z.string().describe("ID of the bookmark to open"),
        new_tab: z
          .boolean()
          .optional()
          .describe("Open the bookmark in a new tab"),
      },
    },
    async ({ bookmark_id, new_tab }) => {
      return withAction(
        runtime,
        tabManager,
        "open_bookmark",
        { bookmark_id, new_tab },
        async () => {
          const bookmark = bookmarkManager.getBookmark(bookmark_id);
          if (!bookmark) {
            return `Bookmark ${bookmark_id} not found`;
          }

          if (new_tab || !tabManager.getActiveTabId()) {
            const createdId = tabManager.createTab(bookmark.url);
            const created = tabManager.getActiveTab();
            if (created) {
              await waitForLoad(created.view.webContents);
            }
            return `Opened bookmark "${bookmark.title}" in new tab ${createdId}`;
          }

          const activeId = tabManager.getActiveTabId()!;
          const activeTab = tabManager.getActiveTab();
          tabManager.navigateTab(activeId, bookmark.url);
          if (activeTab) {
            await waitForLoad(activeTab.view.webContents);
          }
          return `Opened bookmark "${bookmark.title}" in current tab`;
        },
      );
    },
  );

  server.registerTool(
    "vessel_folder_remove",
    {
      title: "Remove Bookmark Folder",
      description: "Remove a folder. Bookmarks in it are moved to Unsorted.",
      inputSchema: {
        folder_id: z.string().describe("ID of the folder to remove"),
      },
    },
    async ({ folder_id }) => {
      return withAction(
        runtime,
        tabManager,
        "remove_bookmark_folder",
        { folder_id },
        async () => {
          const removed = bookmarkManager.removeFolder(folder_id);
          return removed
            ? `Removed folder ${folder_id}. Bookmarks moved to Unsorted.`
            : `Folder ${folder_id} not found`;
        },
      );
    },
  );

  server.registerTool(
    "vessel_folder_rename",
    {
      title: "Rename Bookmark Folder",
      description: "Rename an existing bookmark folder.",
      inputSchema: {
        folder_id: z.string().describe("ID of the folder to rename"),
        new_name: z.string().describe("New name for the folder"),
        summary: z
          .string()
          .optional()
          .describe("Optional one-sentence summary for the folder"),
      },
    },
    async ({ folder_id, new_name, summary }) => {
      return withAction(
        runtime,
        tabManager,
        "rename_bookmark_folder",
        { folder_id, new_name, summary },
        async () => {
          const folder = bookmarkManager.renameFolder(
            folder_id,
            new_name,
            summary,
          );
          return folder
            ? `Renamed folder to "${folder.name}"`
            : `Folder ${folder_id} not found`;
        },
      );
    },
  );

  // --- Memory tools ---

  server.registerTool(
    "vessel_memory_note_create",
    {
      title: "Create Memory Note",
      description:
        "Write a markdown note into the configured Obsidian vault for research notes, breadcrumbs, or synthesis.",
      inputSchema: {
        title: z.string().describe("Title of the note"),
        body: z.string().describe("Markdown body for the note"),
        folder: z
          .string()
          .optional()
          .describe(
            "Relative folder inside the vault (default: Vessel/Research)",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags to store in frontmatter"),
      },
    },
    async ({ title, body, folder, tags }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_note_create",
        { title, folder, tags },
        async () => {
          const saved = writeMemoryNote({ title, body, folder, tags });
          return `Saved memory note "${saved.title}" to ${saved.relativePath}`;
        },
      );
    },
  );

  server.registerTool(
    "vessel_memory_append",
    {
      title: "Append Memory Note",
      description:
        "Append markdown content to an existing note in the configured Obsidian vault.",
      inputSchema: {
        note_path: z
          .string()
          .describe("Relative path to an existing note inside the vault"),
        content: z.string().describe("Markdown content to append"),
        heading: z
          .string()
          .optional()
          .describe("Optional section heading to add before the content"),
      },
    },
    async ({ note_path, content, heading }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_note_append",
        { note_path, heading },
        async () => {
          const saved = appendToMemoryNote({
            notePath: note_path,
            content,
            heading,
          });
          return `Appended memory note at ${saved.relativePath}`;
        },
      );
    },
  );

  server.registerTool(
    "vessel_memory_list",
    {
      title: "List Memory Notes",
      description:
        "List recent markdown notes in the configured Obsidian vault.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Optional relative folder inside the vault"),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Maximum number of notes to return"),
      },
    },
    async ({ folder, limit }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_note_list",
        { folder, limit },
        async () => {
          const notes = listMemoryNotes({ folder, limit });
          if (notes.length === 0) {
            return "No memory notes found.";
          }
          return notes
            .map(
              (note) =>
                `- ${note.title} | path=${note.relativePath} | modified=${note.modifiedAt}${note.tags.length ? ` | tags=${note.tags.join(",")}` : ""}`,
            )
            .join("\n");
        },
      );
    },
  );

  server.registerTool(
    "vessel_memory_search",
    {
      title: "Search Memory Notes",
      description:
        "Search markdown notes in the configured Obsidian vault by title, path, body, and optional tags.",
      inputSchema: {
        query: z.string().describe("Search query"),
        folder: z
          .string()
          .optional()
          .describe("Optional relative folder inside the vault"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags that matching notes must contain"),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Maximum number of matching notes to return"),
      },
    },
    async ({ query, folder, tags, limit }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_note_search",
        { query, folder, tags, limit },
        async () => {
          const notes = searchMemoryNotes({ query, folder, tags, limit });
          if (notes.length === 0) {
            return `No memory notes matched "${query}".`;
          }
          return notes
            .map(
              (note) =>
                `- ${note.title} | path=${note.relativePath} | modified=${note.modifiedAt}${note.tags.length ? ` | tags=${note.tags.join(",")}` : ""}`,
            )
            .join("\n");
        },
      );
    },
  );

  server.registerTool(
    "vessel_memory_page_capture",
    {
      title: "Capture Page To Memory",
      description:
        "Capture the current page into the configured Obsidian vault as a markdown note with URL, excerpt, and content snapshot.",
      inputSchema: {
        title: z.string().optional().describe("Optional note title override"),
        folder: z
          .string()
          .optional()
          .describe("Relative folder inside the vault (default: Vessel/Pages)"),
        summary: z
          .string()
          .optional()
          .describe("Optional summary written into the note"),
        note: z
          .string()
          .optional()
          .describe("Optional research note or breadcrumb"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags to store in frontmatter"),
      },
    },
    async ({ title, folder, summary, note, tags }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "memory_page_capture",
        { title, folder, tags },
        async () => {
          const page = await extractContent(tab.view.webContents);
          const saved = capturePageToVault({
            page,
            title,
            folder,
            summary,
            note,
            tags,
          });
          return `Captured page "${saved.title}" to ${saved.relativePath}`;
        },
      );
    },
  );

  server.registerTool(
    "vessel_memory_link_bookmark",
    {
      title: "Link Bookmark To Memory",
      description:
        "Create a note for a bookmark or append bookmark details into an existing memory note.",
      inputSchema: {
        bookmark_id: z.string().describe("Bookmark ID to link"),
        note_path: z
          .string()
          .optional()
          .describe("Existing relative note path to append into"),
        title: z
          .string()
          .optional()
          .describe("Optional title when creating a new note"),
        folder: z
          .string()
          .optional()
          .describe("Relative folder when creating a new note"),
        note: z
          .string()
          .optional()
          .describe(
            "Optional rationale or breadcrumb to store with the bookmark",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags when creating a new note"),
      },
    },
    async ({ bookmark_id, note_path, title, folder, note, tags }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_link_bookmark",
        { bookmark_id, note_path, title, folder, tags },
        async () => {
          const bookmark = bookmarkManager.getBookmark(bookmark_id);
          if (!bookmark) {
            return `Bookmark ${bookmark_id} not found`;
          }
          const saved = linkBookmarkToMemory({
            bookmark,
            notePath: note_path,
            title,
            folder,
            note,
            tags,
          });
          return `Linked bookmark "${bookmark.title}" to memory note ${saved.relativePath}`;
        },
      );
    },
  );
}

function waitForLoad(wc: Electron.WebContents, timeout = 10000): Promise<void> {
  return new Promise((resolve) => {
    if (!wc.isLoading()) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeout);
    wc.once("did-stop-loading", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function resolveSelector(
  wc: Electron.WebContents,
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

function createMcpServer(
  tabManager: TabManager,
  runtime: AgentRuntime,
): McpServer {
  const server = new McpServer({
    name: "vessel-browser",
    version: "0.1.0",
  });
  registerTools(server, tabManager, runtime);
  return server;
}

export function startMcpServer(
  tabManager: TabManager,
  runtime: AgentRuntime,
  port: number,
): void {
  httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, mcp-session-id",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const mcpServer = createMcpServer(tabManager, runtime);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("[Vessel MCP] Error handling request:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        );
      }
    }
  });

  httpServer.listen(port, "127.0.0.1", () => {
    console.log(
      `[Vessel MCP] Server listening on http://127.0.0.1:${port}/mcp`,
    );
  });

  httpServer.on("error", (error: any) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `[Vessel MCP] Port ${port} is already in use. MCP server not started.`,
      );
    } else {
      console.error("[Vessel MCP] Server error:", error);
    }
  });
}

export function stopMcpServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
    console.log("[Vessel MCP] Server stopped");
  }
}
