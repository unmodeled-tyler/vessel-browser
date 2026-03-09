import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { AgentRuntime } from "../agent/runtime";
import {
  buildStructuredContext,
  buildScopedContext,
  type ExtractMode,
} from "../ai/context-builder";
import { extractContent } from "../content/extractor";
import type { TabManager } from "../tabs/tab-manager";

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

function getPostActionState(
  tabManager: TabManager,
  name: string,
): string {
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
  const resolvedSelector = await resolveSelector(wc, index, selector);
  if (!resolvedSelector)
    return "Error: No form-related index or selector provided";

  // Get form info to determine submission method
  const formInfo = await wc.executeJavaScript(`
    (function() {
      const target = document.querySelector(${JSON.stringify(resolvedSelector)});
      if (!target) return { error: 'Target not found' };
      const form = target instanceof HTMLFormElement ? target : target.closest('form');
      if (!form) {
        // Also check the form attribute on the element
        const formId = target.getAttribute('form');
        if (formId) {
          const linkedForm = document.getElementById(formId);
          if (linkedForm instanceof HTMLFormElement) {
            const action = linkedForm.action || window.location.href;
            const method = (linkedForm.method || 'GET').toUpperCase();
            return { action, method, found: true };
          }
        }
        return { error: 'No parent form found' };
      }
      const submitter =
        target instanceof HTMLButtonElement ||
        (target instanceof HTMLInputElement &&
          (target.type === 'submit' || target.type === 'image'))
          ? target
          : form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (
        submitter instanceof HTMLElement &&
        (submitter.hasAttribute('disabled') ||
          submitter.getAttribute('aria-disabled') === 'true')
      ) {
        return { error: 'Submit control is disabled' };
      }
      // Collect form data for GET submissions
      const action = form.action || window.location.href;
      const method = (form.method || 'GET').toUpperCase();
      if (method === 'GET') {
        const fd = new FormData(form);
        const params = new URLSearchParams();
        for (const [k, v] of fd.entries()) {
          if (typeof v === 'string') params.append(k, v);
        }
        return { action, method, params: params.toString(), found: true };
      }
      // For POST forms, we'll submit via JS and let navigation happen
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

  const startedAt = Date.now();
  while (Date.now() - startedAt < effectiveTimeout) {
    const matched = await wc.executeJavaScript(`
      (function() {
        const selector = ${JSON.stringify(expectedSelector)};
        const text = ${JSON.stringify(expectedText)};
        if (selector && document.querySelector(selector)) return true;
        if (text && document.body?.innerText?.includes(text)) return true;
        return false;
      })()
    `);

    if (matched) {
      return expectedSelector
        ? `Matched selector ${expectedSelector}`
        : `Matched text "${expectedText.slice(0, 80)}"`;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return expectedSelector
    ? `Timed out waiting for selector ${expectedSelector}`
    : `Timed out waiting for text "${expectedText.slice(0, 80)}"`;
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
  ): string {
    if (mode === "full") {
      const structured = buildStructuredContext(pageContent);
      const truncated =
        pageContent.content.length > 30000
          ? pageContent.content.slice(0, 30000) + "\n[Content truncated...]"
          : pageContent.content;
      return `${structured}\n\n## PAGE CONTENT\n\n${truncated}`;
    }
    if (mode === "text_only") {
      return buildScopedContext(pageContent, mode);
    }
    return buildScopedContext(pageContent, mode);
  }

  server.registerTool(
    "vessel_extract_content",
    {
      title: "Extract Page Content",
      description:
        "Extract structured content from the current page. Modes: 'full' (default, everything), 'summary' (title+headings+stats), 'interactives_only' (clickable elements with indices), 'forms_only' (form fields only), 'text_only' (page text, no interactives), 'visible_only' (only visible elements).",
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
        return asTextResponse(buildExtractResponse(pageContent, effectiveMode));
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
        return asTextResponse(buildExtractResponse(pageContent, effectiveMode));
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
            `${tab.id === activeId ? "->" : "  "} [${tab.id}] ${tab.title} — ${tab.url}`,
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
          if (elInfo.href && elInfo.href !== beforeUrl && !elInfo.href.startsWith("javascript:") && !elInfo.href.startsWith("#")) {
            wc.loadURL(elInfo.href);
            await waitForLoad(wc);
            const afterUrl = wc.getURL();
            return `${clickText} -> ${afterUrl}`;
          }

          // For non-link elements: use el.click()
          await wc.executeJavaScript(`
            (function() {
              const el = document.querySelector(${JSON.stringify(resolvedSelector)});
              if (el) el.click();
            })()
          `);
          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          return afterUrl !== beforeUrl ? `${clickText} -> ${afterUrl}` : clickText;
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
          const result = await submitForm(
            tab.view.webContents,
            index,
            selector,
          );
          await waitForLoad(tab.view.webContents);
          return result;
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
        async () => pressKey(tab.view.webContents, key, index, selector),
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
          await tab.view.webContents.executeJavaScript(
            `window.scrollBy(0, ${dir})`,
          );
          return `Scrolled ${direction} by ${pixels}px`;
        },
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
