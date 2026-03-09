import type { WebContents } from "electron";
import type { AgentCheckpoint } from "../../shared/types";
import type { AgentRuntime } from "../agent/runtime";
import { extractContent } from "../content/extractor";
import type { TabManager } from "../tabs/tab-manager";
import { buildStructuredContext } from "./context-builder";

export interface ActionContext {
  tabManager: TabManager;
  runtime: AgentRuntime;
}

function waitForLoad(wc: WebContents, timeout = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (!wc.isLoading()) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeout);
    wc.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });
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

async function resolveSelector(
  wc: WebContents,
  index?: number,
  selector?: string,
): Promise<string | null> {
  if (selector) return selector;
  if (index == null) return null;
  return wc.executeJavaScript(
    `
      (function() {
        // Primary path: use the content-script's authoritative index map
        if (window.__vessel?.getElementSelector) {
          return window.__vessel.getElementSelector(${index});
        }

        // Fallback: replicate the same extraction order as content-script
        // (nav links → buttons → non-nav links → form inputs)
        function selectorFor(el) {
          if (!el) return null;
          if (el.id) return "#" + CSS.escape(el.id);
          var name = el.getAttribute("name");
          if (name) return el.tagName.toLowerCase() + "[name=\\"" + CSS.escape(name) + "\\"]";
          var parts = [];
          var current = el;
          for (var depth = 0; current && current !== document.body && depth < 5; depth++) {
            var tag = current.tagName.toLowerCase();
            var parent = current.parentElement;
            if (!parent) { parts.unshift(tag); break; }
            var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === current.tagName; });
            if (siblings.length > 1) {
              parts.unshift(tag + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")");
            } else {
              parts.unshift(tag);
            }
            current = parent;
          }
          return parts.join(" > ");
        }

        var seen = new Set();
        var ordered = [];

        // 1. Nav links
        document.querySelectorAll("nav a[href], [role='navigation'] a[href]").forEach(function(el) {
          if (!seen.has(el)) { seen.add(el); ordered.push(el); }
        });
        // 2. Buttons
        document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button']").forEach(function(el) {
          if (!seen.has(el)) { seen.add(el); ordered.push(el); }
        });
        // 3. Non-nav links
        document.querySelectorAll("a[href]").forEach(function(el) {
          if (!seen.has(el)) { seen.add(el); ordered.push(el); }
        });
        // 4. Form inputs
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
    "click",
    "type_text",
    "select_option",
    "submit_form",
    "press_key",
    "create_tab",
    "switch_tab",
    "restore_checkpoint",
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

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const matched = await wc.executeJavaScript(`
      (function() {
        const selector = ${JSON.stringify(selector)};
        const text = ${JSON.stringify(text)};
        if (selector && document.querySelector(selector)) return true;
        if (text && document.body?.innerText?.includes(text)) return true;
        return false;
      })()
    `);
    if (matched) {
      return selector
        ? `Matched selector ${selector}`
        : `Matched text "${text.slice(0, 80)}"`;
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
  const selector = await resolveSelector(wc, args.index, args.selector);
  if (!selector) return "Error: No form-related index or selector provided";

  return wc.executeJavaScript(`
    (function() {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return 'Target not found';
      const form =
        target instanceof HTMLFormElement
          ? target
          : target.closest('form');
      if (!form) return 'No parent form found';

      const submitter =
        target instanceof HTMLButtonElement ||
        (target instanceof HTMLInputElement &&
          (target.type === 'submit' || target.type === 'image'))
          ? target
          : form.querySelector('button[type="submit"], input[type="submit"]');

      if (
        submitter instanceof HTMLElement &&
        (submitter.hasAttribute('disabled') ||
          submitter.getAttribute('aria-disabled') === 'true')
      ) {
        return 'Submit control is disabled';
      }

      if (submitter instanceof HTMLElement) {
        submitter.click();
        return 'Submitted form via submit control';
      }

      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.submit();
      }
      return 'Submitted form directly';
    })()
  `);
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

function getPostActionState(
  ctx: ActionContext,
  name: string,
): string {
  const tab = ctx.tabManager.getActiveTab();
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
  const interactActions = ["type_text", "select_option", "press_key"];
  const tabActions = ["create_tab", "switch_tab"];

  if (navActions.includes(name)) {
    const history = wc.navigationHistory;
    return `\n[state: url=${wc.getURL()}, canGoBack=${history.canGoBack()}, canGoForward=${history.canGoForward()}, loading=${wc.isLoading()}]`;
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
    !["list_tabs", "create_tab", "restore_checkpoint"].includes(name)
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
            return `${prefix} [${item.id}] ${item.title} — ${item.url}`;
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
          const beforeUrl = wc.getURL();
          // Get element info — check if it's a link with an href
          const elInfo = await wc.executeJavaScript(`
            (function() {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return { error: 'Element not found with selector: ${selector.replace(/'/g, "\\'")}' };
              const text = (el.textContent || el.tagName).trim().slice(0, 100);
              const href = el.tagName === 'A' ? el.href : null;
              return { text: text, href: href };
            })()
          `);
          if (elInfo.error) return elInfo.error;
          const clickText = `Clicked: ${elInfo.text}`;

          // For anchor links: use loadURL (browser-initiated = guaranteed history)
          if (elInfo.href && elInfo.href !== beforeUrl && !elInfo.href.startsWith("javascript:") && !elInfo.href.startsWith("#")) {
            wc.loadURL(elInfo.href);
            await waitForLoad(wc);
            const afterUrl = wc.getURL();
            return `${clickText} -> ${afterUrl}`;
          }

          // For non-link elements: use el.click() as normal
          await wc.executeJavaScript(`
            (function() {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (el) el.click();
            })()
          `);
          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          return afterUrl !== beforeUrl ? `${clickText} -> ${afterUrl}` : clickText;
        }

        case "type_text": {
          if (!wc) return "Error: No active tab";
          const selector = await resolveSelector(wc, args.index, args.selector);
          if (!selector) return "Error: No element index or selector provided";
          return setElementValue(wc, selector, String(args.text || ""));
        }

        case "select_option": {
          if (!wc) return "Error: No active tab";
          return selectOption(wc, args);
        }

        case "submit_form": {
          if (!wc) return "Error: No active tab";
          const result = await submitForm(wc, args);
          await waitForLoad(wc);
          return result;
        }

        case "press_key": {
          if (!wc) return "Error: No active tab";
          const result = await pressKey(wc, args);
          await new Promise((resolve) => setTimeout(resolve, 100));
          return result;
        }

        case "scroll": {
          if (!wc) return "Error: No active tab";
          const pixels = args.amount || 500;
          const dir = args.direction === "up" ? -pixels : pixels;
          await wc.executeJavaScript(`window.scrollBy(0, ${dir})`);
          return `Scrolled ${args.direction} by ${pixels}px`;
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

        default:
          return `Unknown tool: ${name}`;
      }
    },
  });

  return result + getPostActionState(ctx, name);
}
