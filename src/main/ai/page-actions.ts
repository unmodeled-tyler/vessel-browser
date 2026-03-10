import type { WebContents } from "electron";
import type { AgentCheckpoint } from "../../shared/types";
import type { AgentRuntime } from "../agent/runtime";
import { extractContent } from "../content/extractor";
import { findSelectorByIndex } from "../mcp/indexed-selector";
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

const VESSEL_HIGHLIGHT_CSS = `
.__vessel-highlight {
  outline: 3px solid #8b7ec8 !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 12px rgba(139, 126, 200, 0.5) !important;
  transition: outline-color 0.3s, box-shadow 0.3s;
}
.__vessel-highlight-text {
  background: rgba(139, 126, 200, 0.3) !important;
  border-bottom: 2px solid #8b7ec8 !important;
  padding: 1px 2px !important;
  border-radius: 2px !important;
}
.__vessel-highlight-label {
  position: absolute;
  background: #8b7ec8;
  color: #fff;
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
  wc: WebContents,
  resolvedSelector?: string | null,
  text?: string,
  label?: string,
  durationMs?: number,
): Promise<string> {
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
        return 'Highlighted: ' + (el.textContent || el.tagName).trim().slice(0, 80);
      })()
    `);
  }

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

async function clearHighlights(wc: WebContents): Promise<string> {
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
    if (!selector)
      return "Error: No form found on the page";
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
      // POST: submit via JS
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

  // For GET forms, use loadURL for proper history entry
  if (formInfo.found && formInfo.method === "GET") {
    const url = new URL(formInfo.action);
    if (formInfo.params) {
      url.search = formInfo.params;
    }
    wc.loadURL(url.toString());
    return "Submitted form via GET";
  }

  return formInfo.submitted ? "Submitted form via POST" : "Submitted form";
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
    return `\n[state: url=${wc.getURL()}, canGoBack=${tab.canGoBack()}, canGoForward=${tab.canGoForward()}, loading=${wc.isLoading()}]`;
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
          const beforeUrl = wc.getURL();
          const result = await submitForm(wc, args);
          if (result.startsWith("Error") || result.startsWith("Target") || result.startsWith("No parent") || result.startsWith("Submit control")) {
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

        case "highlight": {
          if (!wc) return "Error: No active tab";
          const selector = await resolveSelector(
            wc,
            args.index,
            args.selector,
          );
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

  return result + getPostActionState(ctx, name);
}
