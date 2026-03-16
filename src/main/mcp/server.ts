import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { resolveBookmarkSourceDraft } from "../bookmarks/page-source";
import { extractContent } from "../content/extractor";
import { getRecoverableAccessIssue } from "../content/page-access-issues";
import {
  formatDeadLinkMessage,
  validateLinkDestination,
} from "../network/link-validation";
import { findSelectorByIndex } from "./indexed-selector";
import type { TabManager } from "../tabs/tab-manager";
import * as bookmarkManager from "../bookmarks/manager";
import * as highlightsManager from "../highlights/manager";
import { highlightOnPage, clearHighlights } from "../highlights/inject";
import * as namedSessionManager from "../sessions/manager";
import {
  appendToMemoryNote,
  capturePageToVault,
  linkBookmarkToMemory,
  listMemoryNotes,
  searchMemoryNotes,
  writeMemoryNote,
} from "../memory/obsidian";
import { setMcpHealth } from "../health/runtime-health";

let httpServer: http.Server | null = null;

export interface McpServerStartResult {
  ok: boolean;
  configuredPort: number;
  activePort: number | null;
  endpoint: string | null;
  error?: string;
}

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

function formatFolderStatus(limit = 6): string {
  const folders = bookmarkManager.listFolderOverviews();
  const visible = folders.slice(0, limit);
  const summary = visible
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

function resolveBookmarkFolderTarget(args: {
  folder_id?: unknown;
  folder_name?: unknown;
  folder_summary?: unknown;
  create_folder_if_missing?: unknown;
  archive?: unknown;
}): {
  folderId?: string;
  folderName: string;
  createdFolder?: string;
  error?: string;
} {
  const folderId =
    typeof args.folder_id === "string" ? args.folder_id.trim() : "";
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

  const requestedName =
    typeof args.folder_name === "string" && args.folder_name.trim()
      ? args.folder_name.trim()
      : args.archive
        ? bookmarkManager.ARCHIVE_FOLDER_NAME
        : "";

  if (!requestedName || requestedName.toLowerCase() === "unsorted") {
    return {
      folderId: bookmarkManager.UNSORTED_ID,
      folderName: "Unsorted",
    };
  }

  const existing = bookmarkManager.findFolderByName(requestedName);
  if (existing) {
    return { folderId: existing.id, folderName: existing.name };
  }

  const createIfMissing = args.create_folder_if_missing !== false;
  if (!createIfMissing) {
    return {
      folderName: requestedName,
      error: `Folder "${requestedName}" not found`,
    };
  }

  const folderSummary =
    typeof args.folder_summary === "string" && args.folder_summary.trim()
      ? args.folder_summary.trim()
      : undefined;
  const { folder } = bookmarkManager.ensureFolder(requestedName, folderSummary);
  return {
    folderId: folder.id,
    folderName: folder.name,
    createdFolder: folder.name,
  };
}

function composeFolderAwareResponse(
  message: string,
  createdFolder?: string,
): string {
  const prefix = createdFolder ? `Created folder "${createdFolder}".\n` : "";
  return `${prefix}${message}\n${formatFolderStatus()}`;
}

function composeDuplicateBookmarkResponse(args: {
  url: string;
  folderName: string;
  bookmarkId: string;
}): string {
  return `Bookmark already exists for ${args.url} in "${args.folderName}" (id=${args.bookmarkId}). Retry with on_duplicate="update" to refresh the existing bookmark or on_duplicate="duplicate" to keep both entries.`;
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
  wc: Electron.WebContents,
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
  wc: Electron.WebContents,
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
    href:
      "href" in result && typeof result.href === "string"
        ? result.href
        : undefined,
  };
}

async function clickResolvedSelector(
  wc: Electron.WebContents,
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

async function getPostActionState(
  tabManager: TabManager,
  name: string,
): Promise<string> {
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
    "press_key",
  ];
  const interactActions = ["type", "type_text", "select_option", "hover", "focus"];
  const tabActions = ["create_tab", "switch_tab", "close_tab"];

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
    const stateInfo = await getPostActionState(tabManager, name);
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
  wc: Electron.WebContents,
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
  wc: Electron.WebContents,
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
  wc: Electron.WebContents,
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
  const beforeUrl = wc.getURL();
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
  `);

  if (formInfo.error) return formInfo.error;

  // Fallback for GET when requestSubmit was unavailable
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
      ? `Submitted form via ${formInfo.method} -> ${afterUrl}`
      : `Submitted form via ${formInfo.method}`;
  }

  return "Submitted form";
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
      if (key === 'Enter') {
        if (tag === 'BUTTON' || (tag === 'INPUT' && (type === 'submit' || type === 'button'))) {
          target.click();
        } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const form = target.closest('form');
          if (form) {
            if (typeof form.requestSubmit === 'function') {
              form.requestSubmit();
            } else {
              const submitBtn = form.querySelector('[type="submit"]');
              if (submitBtn) submitBtn.click();
              else form.submit();
            }
          }
        }
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
    return JSON.stringify({ matched: false, error: "wait_for requires text or selector" });
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

    const elapsedMs = Date.now() - startedAt;

    if (result === "selector") {
      return JSON.stringify({ matched: true, type: "selector", value: expectedSelector, elapsed_ms: elapsedMs });
    }
    if (result === "text") {
      return JSON.stringify({ matched: true, type: "text", value: expectedText.slice(0, 80), elapsed_ms: elapsedMs });
    }
    if (typeof result === "string" && result.startsWith("invalid_selector:")) {
      return JSON.stringify({ matched: false, error: `Invalid selector "${expectedSelector}" — ${result.slice(17)}` });
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const elapsedMs = Date.now() - startedAt;

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
    : null;

  return JSON.stringify({
    matched: false,
    type: expectedSelector ? "selector" : "text",
    value: expectedSelector ? expectedSelector : expectedText.slice(0, 80),
    elapsed_ms: elapsedMs,
    timeout_ms: effectiveTimeout,
    ...(diagnostic ? { diagnostic } : {}),
  });
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

  server.registerTool(
    "vessel_publish_transcript",
    {
      title: "Publish Agent Transcript",
      description:
        "Publish or stream agent reasoning/status text into Vessel's in-browser transcript monitor. Intended for external harnesses that want to mirror live thinking into the browser UI.",
      inputSchema: {
        text: z.string().describe("Transcript text chunk to publish"),
        stream_id: z
          .string()
          .optional()
          .describe("Stable stream ID for incremental updates to the same entry"),
        mode: z
          .enum(["append", "replace", "final"])
          .optional()
          .describe("append (default), replace current stream text, or mark the stream final"),
        kind: z
          .enum(["thinking", "message", "status"])
          .optional()
          .describe("Visual style for the transcript entry"),
        title: z
          .string()
          .optional()
          .describe("Optional short label such as Plan, Search, or Summary"),
      },
    },
    async ({ text, stream_id, mode, kind, title }) => {
      const entry = runtime.publishTranscript({
        source: "mcp",
        text,
        streamId: stream_id,
        mode,
        kind,
        title,
      });
      return asTextResponse(
        JSON.stringify(
          {
            ok: true,
            entry_id: entry.id,
            stream_id: entry.streamId ?? entry.id,
            status: entry.status,
            updated_at: entry.updatedAt,
          },
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    "vessel_clear_transcript",
    {
      title: "Clear Agent Transcript",
      description: "Clear the in-browser transcript monitor state.",
    },
    async () => {
      runtime.clearTranscript();
      return asTextResponse("Cleared browser transcript monitor.");
    },
  );

  const EXTRACT_MODES: ExtractMode[] = [
    "full",
    "summary",
    "interactives_only",
    "forms_only",
    "text_only",
    "visible_only",
    "results_only",
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
        "Extract structured content from the current page. Modes: 'full' (default, everything), 'summary' (title+headings+stats), 'interactives_only' (clickable elements with indices), 'forms_only' (form fields only), 'text_only' (page text, no interactives), 'visible_only' (only currently visible, in-viewport, unobstructed elements plus active overlays), 'results_only' (likely primary search/result links only).",
      inputSchema: {
        mode: z
          .enum(EXTRACT_MODES as [string, ...string[]])
          .optional()
          .describe(
            "Extraction mode: full, summary, interactives_only, forms_only, text_only, visible_only, results_only",
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
        "Alias for vessel_extract_content. Supports same modes: full, summary, interactives_only, forms_only, text_only, visible_only, results_only.",
      inputSchema: {
        mode: z
          .enum(EXTRACT_MODES as [string, ...string[]])
          .optional()
          .describe(
            "Extraction mode: full, summary, interactives_only, forms_only, text_only, visible_only, results_only",
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
        const { httpStatus } = await waitForLoadWithStatus(tab.view.webContents);
        const finalUrl = tab.view.webContents.getURL();
        const statusNote =
          httpStatus !== null && httpStatus >= 400
            ? ` [HTTP ${httpStatus} — page may be missing or unavailable, consider navigating back and trying a different link]`
            : "";
        return `Navigated to ${finalUrl}${statusNote}`;
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
    "vessel_extract_structured_data",
    {
      title: "Extract Structured Data",
      description:
        "Return normalized structured data derived from page JSON-LD, microdata, RDFa, and high-signal meta tags. Useful for recipes, products, articles, events, FAQs, and other schema-rich pages.",
      inputSchema: {
        type: z
          .string()
          .optional()
          .describe(
            "Optional schema type filter, for example Recipe, Product, Article, Event, or FAQPage",
          ),
      },
    },
    async ({ type }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");

      try {
        const pageContent = await extractContent(tab.view.webContents);
        const requestedType =
          typeof type === "string" && type.trim() ? type.trim().toLowerCase() : "";
        const entities = (pageContent.structuredData ?? []).filter((entity) =>
          requestedType
            ? entity.types.some((entry) => entry.toLowerCase() === requestedType)
            : true,
        );
        const sourceCounts = {
          json_ld: pageContent.jsonLd?.length ?? 0,
          microdata: pageContent.microdata?.length ?? 0,
          rdfa: pageContent.rdfa?.length ?? 0,
          meta_tags: Object.keys(pageContent.metaTags ?? {}).length,
        };
        const usedPageFallback =
          entities.length > 0 && entities.every((entity) => entity.source === "page");
        const hasRawSources =
          sourceCounts.json_ld > 0 || sourceCounts.microdata > 0 || sourceCounts.rdfa > 0;
        const message =
          entities.length > 0
            ? usedPageFallback
              ? hasRawSources
                ? `Raw structured data sources were found (${sourceCounts.json_ld} JSON-LD, ${sourceCounts.microdata} microdata, ${sourceCounts.rdfa} RDFa) but could not be normalized into typed entities. Returning generic page metadata. The raw sources may contain parseable data — check sources_checked counts.`
                : "No richer machine-readable schema was detected. Returning a generic page metadata entity synthesized from the current page."
              : undefined
            : requestedType
              ? `No structured data entities matched type "${type}".`
              : "No structured data entities detected. This page may not expose usable JSON-LD, microdata, RDFa, or high-signal metadata.";

        return asTextResponse(
          JSON.stringify(
            {
              url: pageContent.url,
              title: pageContent.title,
              count: entities.length,
              sources_checked: sourceCounts,
              used_page_fallback: usedPageFallback,
              message,
              entities,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        return asTextResponse(
          `Error extracting structured data: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
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
          const resolvedSelector = await resolveSelector(wc, index, selector);
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          return clickResolvedSelector(wc, resolvedSelector);
        },
      );
    },
  );

  server.registerTool(
    "vessel_hover",
    {
      title: "Hover Element",
      description:
        "Move the mouse pointer over an element to trigger hover states, tooltips, or dropdown menus.",
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
        "hover",
        { index, selector },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector = await resolveSelector(wc, index, selector);
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          return hoverElement(wc, resolvedSelector);
        },
      );
    },
  );

  server.registerTool(
    "vessel_focus",
    {
      title: "Focus Element",
      description:
        "Focus an input, button, or interactive element. Useful before pressing keys or to trigger focus-dependent UI.",
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
        "focus",
        { index, selector },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector = await resolveSelector(wc, index, selector);
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          return focusElement(wc, resolvedSelector);
        },
      );
    },
  );

  server.registerTool(
    "vessel_extract_text",
    {
      title: "Extract Element Text",
      description:
        "Extract the text content of a specific element by its index number or CSS selector.",
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
      const wc = tab.view.webContents;
      const resolvedSelector = await resolveSelector(wc, index, selector);
      if (!resolvedSelector) {
        return asTextResponse("Error: No index or selector provided");
      }
      const result = await wc.executeJavaScript(`
        (function() {
          try {
            const el = document.querySelector(${JSON.stringify(resolvedSelector)});
            if (!el) return { error: 'Element not found' };

            const tag =
              typeof el.tagName === 'string' ? el.tagName.toLowerCase() : 'unknown';
            const text =
              el instanceof HTMLElement
                ? (el.innerText || el.textContent || '')
                : (el.textContent || '');
            const value =
              el instanceof HTMLInputElement ||
              el instanceof HTMLTextAreaElement ||
              el instanceof HTMLSelectElement
                ? el.value
                : null;
            const attr =
              el.getAttribute('aria-label') ||
              el.getAttribute('title') ||
              el.getAttribute('alt') ||
              null;
            const role = el.getAttribute('role') || null;

            return {
              tag,
              role,
              text: String(text || '').trim(),
              value: value == null ? null : String(value),
              attr: attr == null ? null : String(attr),
            };
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : 'Element text extraction failed',
            };
          }
        })()
      `);
      if (!result || typeof result !== "object") {
        return asTextResponse("Error: Element text extraction returned no result");
      }
      if ("error" in result && typeof result.error === "string") {
        return asTextResponse(`Error: ${result.error}`);
      }
      const parts: string[] = [`<${result.tag}>`];
      if (
        "role" in result &&
        typeof result.role === "string" &&
        result.role.trim()
      ) {
        parts.push(`role: ${result.role}`);
      }
      if (result.value !== null) parts.push(`value: ${result.value}`);
      if (result.text) parts.push(`text: ${result.text}`);
      if (result.attr) parts.push(`label: ${result.attr}`);
      if (parts.length === 1) {
        parts.push("No readable text, value, or label found on this element.");
      }
      return asTextResponse(parts.join('\n'));
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
        mode: z
          .enum(["default", "keystroke"])
          .optional()
          .describe(
            '"default" sets value directly and fires input+change events. "keystroke" simulates character-by-character key events for apps that validate on keypress.',
          ),
      },
    },
    async ({ index, selector, text, mode }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "type",
        { index, selector, text, mode },
        async () => {
          const resolvedSelector = await resolveSelector(
            tab.view.webContents,
            index,
            selector,
          );
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          if (mode === "keystroke") {
            return typeKeystroke(
              tab.view.webContents,
              resolvedSelector,
              text,
            );
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
        mode: z
          .enum(["default", "keystroke"])
          .optional()
          .describe(
            '"default" sets value directly and fires input+change events. "keystroke" simulates character-by-character key events for apps that validate on keypress.',
          ),
      },
    },
    async ({ index, selector, text, mode }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "type_text",
        { index, selector, text, mode },
        async () => {
          const resolvedSelector = await resolveSelector(
            tab.view.webContents,
            index,
            selector,
          );
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          if (mode === "keystroke") {
            return typeKeystroke(
              tab.view.webContents,
              resolvedSelector,
              text,
            );
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
    "vessel_save_session",
    {
      title: "Save Session",
      description:
        "Persist the current cookies, localStorage, and tab layout under a reusable session name.",
      inputSchema: {
        name: z.string().describe("Session name such as github-logged-in"),
      },
    },
    async ({ name }) =>
      withAction(runtime, tabManager, "save_session", { name }, async () => {
        const saved = await namedSessionManager.saveNamedSession(
          tabManager,
          name,
        );
        return `Saved session "${saved.name}" (${saved.cookieCount} cookies, ${saved.originCount} localStorage origins)`;
      }),
  );

  server.registerTool(
    "vessel_load_session",
    {
      title: "Load Session",
      description:
        "Load a previously saved named session, restoring cookies, localStorage, and saved tabs.",
      inputSchema: {
        name: z.string().describe("Previously saved session name"),
      },
    },
    async ({ name }) =>
      withAction(runtime, tabManager, "load_session", { name }, async () => {
        const loaded = await namedSessionManager.loadNamedSession(
          tabManager,
          name,
        );
        return `Loaded session "${loaded.name}" (${loaded.cookieCount} cookies, ${loaded.originCount} localStorage origins)`;
      }),
  );

  server.registerTool(
    "vessel_list_sessions",
    {
      title: "List Sessions",
      description:
        "List previously saved named browser sessions with cookie and storage counts.",
    },
    async () =>
      withAction(runtime, tabManager, "list_sessions", {}, async () => {
        const sessions = namedSessionManager.listNamedSessions();
        if (sessions.length === 0) return "No saved sessions";
        return sessions
          .map(
            (item) =>
              `- ${item.name} | updated=${item.updatedAt} | cookies=${item.cookieCount} | origins=${item.originCount}${item.domains.length ? ` | domains=${item.domains.slice(0, 6).join(", ")}${item.domains.length > 6 ? ", ..." : ""}` : ""}`,
          )
          .join("\n");
      }),
  );

  server.registerTool(
    "vessel_delete_session",
    {
      title: "Delete Session",
      description: "Delete a previously saved named browser session.",
      inputSchema: {
        name: z.string().describe("Saved session name to delete"),
      },
    },
    async ({ name }) =>
      withAction(runtime, tabManager, "delete_session", { name }, async () =>
        namedSessionManager.deleteNamedSession(name)
          ? `Deleted session "${name}"`
          : `Session "${name}" not found`,
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
        const screenshotPath = path.join(os.tmpdir(), `vessel_screenshot_${Date.now()}.png`);
        fs.writeFileSync(screenshotPath, Buffer.from(screenshot.base64, "base64"));
        return {
          content: [
            {
              type: "image" as const,
              data: screenshot.base64,
              mimeType: "image/png",
            },
            {
              type: "text" as const,
              text: `Screenshot captured: ${screenshot.width}x${screenshot.height}\nSaved to: ${screenshotPath}\nTo analyze visually, call vision_analyze with image_url="${screenshotPath}"`,
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
        "Visually highlight an element or text on the page for the user. Use to draw attention to specific parts of the page. Highlights persist until cleared. Set persist=true to save the highlight so it re-appears when the user revisits this page.",
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
        persist: z
          .boolean()
          .optional()
          .describe(
            "If true, save this highlight so it re-appears automatically when the user revisits the page. Ignored when durationMs is set.",
          ),
        color: z
          .enum(["yellow", "red", "green", "blue", "purple", "orange"])
          .optional()
          .describe(
            "Highlight color. Use red for problems/errors, green for targets/success, blue for informational, purple for important, orange for warnings. Defaults to yellow.",
          ),
      },
    },
    async ({ index, selector, text, label, durationMs, persist, color }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(
        runtime,
        tabManager,
        "highlight",
        { index, selector, text, label, durationMs, persist, color },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector = await resolveSelector(wc, index, selector);
          const result = await highlightOnPage(
            wc,
            resolvedSelector,
            text,
            label,
            durationMs,
            color,
          );

          if (
            persist &&
            !durationMs &&
            !result.startsWith("Error") &&
            !result.includes("not found")
          ) {
            const url = highlightsManager.normalizeUrl(wc.getURL());
            highlightsManager.addHighlight(
              url,
              resolvedSelector ?? undefined,
              text,
              label,
              color,
              "agent",
            );
          }

          return result;
        },
      );
    },
  );

  server.registerTool(
    "vessel_clear_highlights",
    {
      title: "Clear Highlights",
      description:
        "Remove all visual highlights from the current page, including any saved persistent highlights for this URL.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");
      return withAction(runtime, tabManager, "clear_highlights", {}, async () => {
        const wc = tab.view.webContents;
        const url = highlightsManager.normalizeUrl(wc.getURL());
        highlightsManager.clearHighlightsForUrl(url);
        return clearHighlights(wc);
      });
    },
  );

  server.registerTool(
    "vessel_list_highlights",
    {
      title: "List Persistent Highlights",
      description:
        "List all persistent highlights (both user-created and agent-created). Each highlight has a 'source' field ('user' or 'agent'). User highlights are created by the user selecting text and pressing Ctrl+H. Optionally filter by URL.",
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            "URL to list highlights for. Omit to list all saved highlights.",
          ),
      },
    },
    async ({ url }) => {
      const state = highlightsManager.getState();
      const filtered = url
        ? state.highlights.filter(
            (h) => h.url === highlightsManager.normalizeUrl(url),
          )
        : state.highlights;
      if (filtered.length === 0) {
        return asTextResponse(
          url ? `No saved highlights for ${url}` : "No saved highlights",
        );
      }
      return asTextResponse(JSON.stringify(filtered, null, 2));
    },
  );

  server.registerTool(
    "vessel_remove_highlight",
    {
      title: "Remove Persistent Highlight",
      description:
        "Remove a persistent highlight by ID and clear it from any open tab. Use vessel_list_highlights to find IDs.",
      inputSchema: {
        id: z.string().describe("ID of the highlight to remove"),
      },
    },
    async ({ id }) => {
      const removed = highlightsManager.removeHighlight(id);
      if (!removed) {
        return asTextResponse(`No highlight found with id ${id}`);
      }

      // Clear visual highlights and re-apply remaining ones on matching tabs
      const remaining = highlightsManager.getHighlightsForUrl(removed.url);
      for (const tabState of tabManager.getAllStates()) {
        if (highlightsManager.normalizeUrl(tabState.url) !== removed.url) {
          continue;
        }
        const tab = tabManager.getTab(tabState.id);
        if (!tab) continue;
        const wc = tab.view.webContents;
        await clearHighlights(wc);
        for (const h of remaining) {
          if (!h.selector && !h.text) continue;
          void highlightOnPage(
            wc,
            h.selector ?? null,
            h.text,
            h.label,
            undefined,
            h.color,
          ).catch(() => {});
        }
      }

      return asTextResponse(`Removed highlight ${id}`);
    },
  );

  // --- Bookmark tools ---

  server.registerTool(
    "vessel_create_folder",
    {
      title: "Create Bookmark Folder",
      description:
        "Create a named folder for organizing bookmarks. If a folder with the same name already exists, return it instead of duplicating it.",
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
          const existing = bookmarkManager.findFolderByName(name);
          if (existing) {
            return composeFolderAwareResponse(
              `Folder "${existing.name}" already exists (id=${existing.id})`,
            );
          }

          const folder = bookmarkManager.createFolderWithSummary(name, summary);
          return composeFolderAwareResponse(
            `Created folder "${folder.name}" (id=${folder.id})`,
          );
        },
      );
    },
  );

  server.registerTool(
    "vessel_bookmark_save",
    {
      title: "Save Bookmark",
      description:
        "Save the current page, a specific URL, or a link target from the current page into a bookmark folder. You can provide folder_id or folder_name; missing folder names can be created automatically.",
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe("URL to bookmark. Omit to use the current page or provide index/selector to bookmark a link target from the page"),
        title: z
          .string()
          .optional()
          .describe("Human-readable title for the bookmark. Omit to use the page or link text"),
        index: z
          .number()
          .optional()
          .describe("Element index of a link on the current page to bookmark without opening it"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector of a link on the current page to bookmark without opening it"),
        folder_id: z
          .string()
          .optional()
          .describe("Folder ID to save into (omit for Unsorted)"),
        folder_name: z
          .string()
          .optional()
          .describe("Folder name to save into. Created automatically if missing"),
        folder_summary: z
          .string()
          .optional()
          .describe("Optional one-sentence summary if a new folder is created"),
        create_folder_if_missing: z
          .boolean()
          .optional()
          .describe("Create folder_name automatically when it does not exist"),
        note: z
          .string()
          .optional()
          .describe("Optional note about why this was bookmarked"),
        on_duplicate: z
          .enum(["ask", "update", "duplicate"])
          .optional()
          .describe(
            'How to handle an existing bookmark with the same URL in the same folder: "ask" (default), "update", or "duplicate"',
          ),
      },
    },
    async ({
      url,
      title,
      index,
      selector,
      folder_id,
      folder_name,
      folder_summary,
      create_folder_if_missing,
      note,
      on_duplicate,
    }) => {
      return withAction(
        runtime,
        tabManager,
        "save_bookmark",
        {
          url,
          title,
          index,
          selector,
          folder_id,
          folder_name,
          folder_summary,
          create_folder_if_missing,
          note,
        },
        async () => {
          const currentTab = tabManager.getActiveTab();
          const resolvedSelector =
            currentTab &&
            (typeof index === "number" || typeof selector === "string")
              ? await resolveSelector(
                  currentTab.view.webContents,
                  index,
                  selector,
                )
              : null;
          const source = await resolveBookmarkSourceDraft(
            currentTab?.view.webContents,
            {
              explicitUrl: url,
              explicitTitle: title,
              resolvedSelector,
            },
          );
          if ("error" in source) return `Error: ${source.error}`;

          const target = resolveBookmarkFolderTarget({
            folder_id,
            folder_name,
            folder_summary,
            create_folder_if_missing,
          });
          if (target.error) return target.error;

          const result = bookmarkManager.saveBookmarkWithPolicy(
            source.url,
            source.title,
            target.folderId,
            note,
            { onDuplicate: on_duplicate ?? "ask" },
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
          if (!bookmark) {
            return "Error: Bookmark save failed";
          }

          const verb = result.status === "updated" ? "Updated" : "Saved";
          return composeFolderAwareResponse(
            `${verb} "${bookmark.title}" (${bookmark.url}) in "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
            target.createdFolder,
          );
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
        folder_name: z
          .string()
          .optional()
          .describe("Filter to a specific folder name (omit for all)"),
      },
    },
    async ({ folder_id, folder_name }) => {
      return withAction(
        runtime,
        tabManager,
        "list_bookmarks",
        { folder_id, folder_name },
        async () => {
          const state = bookmarkManager.getState();
          const resolvedFolderId =
            folder_id ||
            (typeof folder_name === "string" && folder_name.trim()
              ? (bookmarkManager.findFolderByName(folder_name)?.id ?? "")
              : "");
          if (folder_name && !resolvedFolderId) {
            return `Folder "${folder_name}" not found`;
          }

          const folders = [
            { id: "unsorted", name: "Unsorted" },
            ...state.folders,
          ];
          const lines: string[] = [];
          for (const folder of folders) {
            if (resolvedFolderId && folder.id !== resolvedFolderId) continue;
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
    "vessel_bookmark_organize",
    {
      title: "Organize Bookmark",
      description:
        "Organize a bookmark by intent: save or move a bookmark into a folder, creating the folder if needed. Works with bookmark_id, url, a link target from the current page, or the current page itself.",
      inputSchema: {
        bookmark_id: z
          .string()
          .optional()
          .describe("Existing bookmark ID to move or update"),
        url: z
          .string()
          .optional()
          .describe("URL to organize. Omit to use the current page or provide index/selector to target a link"),
        title: z
          .string()
          .optional()
          .describe("Optional title when saving a new bookmark"),
        index: z
          .number()
          .optional()
          .describe("Element index of a link on the current page to organize without opening it"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector of a link on the current page to organize without opening it"),
        folder_id: z
          .string()
          .optional()
          .describe("Folder ID to organize into"),
        folder_name: z
          .string()
          .optional()
          .describe("Folder name to organize into"),
        folder_summary: z
          .string()
          .optional()
          .describe("Optional summary used if a new folder is created"),
        create_folder_if_missing: z
          .boolean()
          .optional()
          .describe("Create folder_name automatically when it does not exist"),
        note: z
          .string()
          .optional()
          .describe("Optional note to attach or update on the bookmark"),
        archive: z
          .boolean()
          .optional()
          .describe('If true, organize into the default "Archive" folder'),
      },
    },
    async (args) => {
      return withAction(
        runtime,
        tabManager,
        "organize_bookmark",
        args,
        async () => {
          const target = resolveBookmarkFolderTarget(args);
          if (target.error) return target.error;

          const bookmarkId =
            typeof args.bookmark_id === "string" ? args.bookmark_id.trim() : "";
          const currentTab = tabManager.getActiveTab();
          const note =
            typeof args.note === "string" && args.note.trim()
              ? args.note.trim()
              : undefined;
          const resolvedSelector =
            currentTab &&
            (typeof args.index === "number" ||
              typeof args.selector === "string")
              ? await resolveSelector(
                  currentTab.view.webContents,
                  args.index,
                  args.selector,
                )
              : null;
          const source = await resolveBookmarkSourceDraft(
            currentTab?.view.webContents,
            {
              explicitUrl: args.url,
              explicitTitle: args.title,
              resolvedSelector,
            },
          );

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
    "vessel_bookmark_archive",
    {
      title: "Archive Bookmark",
      description:
        'Archive the current page, a URL, a link target from the current page, or an existing bookmark into the default "Archive" folder.',
      inputSchema: {
        bookmark_id: z
          .string()
          .optional()
          .describe("Existing bookmark ID to archive"),
        url: z
          .string()
          .optional()
          .describe("URL to archive. Omit to use the current page or provide index/selector to target a link"),
        title: z
          .string()
          .optional()
          .describe("Optional title when saving a new archived bookmark"),
        index: z
          .number()
          .optional()
          .describe("Element index of a link on the current page to archive without opening it"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector of a link on the current page to archive without opening it"),
        note: z
          .string()
          .optional()
          .describe("Optional note to store with the archived bookmark"),
      },
    },
    async ({ bookmark_id, url, title, index, selector, note }) => {
      return withAction(
        runtime,
        tabManager,
        "archive_bookmark",
        { bookmark_id, url, title, index, selector, note },
        async () => {
          const currentTab = tabManager.getActiveTab();
          const trimmedBookmarkId =
            typeof bookmark_id === "string" ? bookmark_id.trim() : "";
          const trimmedNote =
            typeof note === "string" && note.trim() ? note.trim() : undefined;
          const target = resolveBookmarkFolderTarget({ archive: true });
          if (target.error) return target.error;
          const resolvedSelector =
            currentTab &&
            (typeof index === "number" || typeof selector === "string")
              ? await resolveSelector(
                  currentTab.view.webContents,
                  index,
                  selector,
                )
              : null;
          const source = await resolveBookmarkSourceDraft(
            currentTab?.view.webContents,
            {
              explicitUrl: url,
              explicitTitle: title,
              resolvedSelector,
            },
          );

          const existing = trimmedBookmarkId
            ? bookmarkManager.getBookmark(trimmedBookmarkId)
            : "error" in source
              ? undefined
              : bookmarkManager.getBookmarkByUrl(source.url);
          if (trimmedBookmarkId && !existing) {
            return `Bookmark ${trimmedBookmarkId} not found`;
          }

          if (existing) {
            const updated = bookmarkManager.updateBookmark(existing.id, {
              folderId: target.folderId,
              title:
                typeof title === "string" && title.trim()
                  ? title.trim()
                  : undefined,
              note: trimmedNote,
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
            return `Error: ${source.error}`;
          }

          const bookmark = bookmarkManager.saveBookmark(
            source.url,
            source.title,
            target.folderId,
            trimmedNote,
          );
          return composeFolderAwareResponse(
            `Saved and archived "${bookmark.title}" (${bookmark.url}) into "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
            target.createdFolder,
          );
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

          const validation = await validateLinkDestination(bookmark.url);
          if (validation.status === "dead") {
            return formatDeadLinkMessage(bookmark.title, validation);
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
            ? composeFolderAwareResponse(
                `Removed folder ${folder_id}. Bookmarks moved to Unsorted.`,
              )
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
          const existing = bookmarkManager.findFolderByName(new_name);
          if (existing && existing.id !== folder_id) {
            return composeFolderAwareResponse(
              `Folder "${existing.name}" already exists (id=${existing.id})`,
            );
          }

          const folder = bookmarkManager.renameFolder(folder_id, new_name, summary);
          return folder
            ? composeFolderAwareResponse(`Renamed folder to "${folder.name}"`)
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

function waitForLoadWithStatus(
  wc: Electron.WebContents,
  timeout = 10000,
): Promise<{ httpStatus: number | null }> {
  return new Promise((resolve) => {
    let httpStatus: number | null = null;
    const onNavigate = (_: Electron.Event, _url: string, code: number) => {
      if (code > 0) httpStatus = code;
    };
    wc.on("did-navigate", onNavigate);
    const finish = () => {
      wc.removeListener("did-navigate", onNavigate);
      resolve({ httpStatus });
    };
    if (!wc.isLoading()) {
      finish();
      return;
    }
    const timer = setTimeout(finish, timeout);
    wc.once("did-stop-loading", () => {
      clearTimeout(timer);
      finish();
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
): Promise<McpServerStartResult> {
  setMcpHealth({
    configuredPort: port,
    activePort: null,
    endpoint: null,
    status: "starting",
    message: `Starting MCP server on port ${port}.`,
  });

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname !== "/mcp") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "POST, GET, DELETE, OPTIONS",
      );
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

    let settled = false;
    const finish = (result: McpServerStartResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    server.once("error", (error: NodeJS.ErrnoException) => {
      const message =
        error.code === "EADDRINUSE"
          ? `Port ${port} is already in use. MCP server not started.`
          : error.message;
      console.error("[Vessel MCP] Server error:", error);
      setMcpHealth({
        configuredPort: port,
        activePort: null,
        endpoint: null,
        status: "error",
        message,
      });
      if (httpServer === server) {
        httpServer = null;
      }
      finish({
        ok: false,
        configuredPort: port,
        activePort: null,
        endpoint: null,
        error: message,
      });
    });

    server.listen(port, "127.0.0.1", () => {
      httpServer = server;
      const address = server.address();
      const actualPort =
        address && typeof address === "object" ? address.port : port;
      const endpoint = `http://127.0.0.1:${actualPort}/mcp`;
      setMcpHealth({
        configuredPort: port,
        activePort: actualPort,
        endpoint,
        status: "ready",
        message: `MCP server listening on ${endpoint}.`,
      });
      console.log(`[Vessel MCP] Server listening on ${endpoint}`);
      finish({
        ok: true,
        configuredPort: port,
        activePort: actualPort,
        endpoint,
      });
    });
  });
}

export function stopMcpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!httpServer) {
      setMcpHealth({
        activePort: null,
        endpoint: null,
        status: "stopped",
        message: "MCP server is stopped.",
      });
      resolve();
      return;
    }

    const server = httpServer;
    httpServer = null;
    server.close(() => {
      setMcpHealth({
        activePort: null,
        endpoint: null,
        status: "stopped",
        message: "MCP server is stopped.",
      });
      console.log("[Vessel MCP] Server stopped");
      resolve();
    });
  });
}
