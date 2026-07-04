import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentRuntime } from "../../agent/runtime";
import type { TabManager } from "../../tabs/tab-manager";
import { getTabByMatch } from "../../ai/page-actions/navigation";
import { handleWebSearch } from "../../ai/page-actions/handlers/navigation";
import { validateLinkDestination } from "../../network/link-validation";
import { assertSafeURL } from "../../network/url-safety";
import { waitForLoad } from "../../utils/webcontents-utils";
import {
  asNoActiveTabResponse,
  asTextResponse,
  getActiveTabSummary,
  waitForConditionMcp,
  withAction,
} from "../mcp-helpers";

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

export function registerNavigationTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "current_tab",
    {
      title: "Get Active Tab",
      description:
        "Return the browser tab the human is actively looking at right now. Use this instead of list_tabs when you only need the focused tab.",
    },
    async () => {
      const activeTab = getActiveTabSummary(tabManager);
      if (!activeTab) return asNoActiveTabResponse();
      return asTextResponse(JSON.stringify(activeTab, null, 2));
    },
  );

  server.registerTool(
    "navigate",
    {
      title: "Navigate",
      description:
        "Navigate the active browser tab to a URL. Use postBody to submit data via POST request (e.g. form submissions).",
      inputSchema: {
        url: z.string().describe("The URL to navigate to"),
        postBody: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Optional form fields to submit via POST (application/x-www-form-urlencoded). Only supported on http/https URLs.",
          ),
      },
    },
    async ({ url, postBody }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      const preCheck = await validateLinkDestination(url);
      if (preCheck.status === "dead") {
        return asTextResponse(
          `Navigation blocked: ${url} returned ${preCheck.detail || "dead link"}. Try a different URL or go back and choose another link.`,
        );
      }
      // Block unsafe URL schemes (javascript:, file:, data:, etc.)
      try {
        assertSafeURL(url);
      } catch (err) {
        return asTextResponse(
          `Navigation blocked: ${err instanceof Error ? err.message : "Unsafe URL scheme"}`,
        );
      }
      return withAction(runtime, tabManager, "navigate", { url }, async () => {
        const id = tabManager.getActiveTabId();
        if (!id) return asNoActiveTabResponse();
        const navError = tabManager.navigateTab(id, url, postBody);
        if (navError) return navError;
        const { httpStatus } = await waitForLoadWithStatus(
          tab.view.webContents,
        );
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
    "web_search",
    {
      title: "Web Search",
      description:
        "Search the open web using the configured default search engine.",
      inputSchema: {
        query: z.string().describe("Web search query text"),
      },
    },
    async ({ query }) => {
      const tab = tabManager.getActiveTab();
      const tabId = tabManager.getActiveTabId();
      if (!tab || !tabId) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "web_search",
        { query },
        async () =>
          handleWebSearch({ tabManager, runtime }, tabId, { query }),
      );
    },
  );

  server.registerTool(
    "go_back",
    {
      title: "Go Back",
      description: "Go back in browser history.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(runtime, tabManager, "go_back", {}, async () => {
        if (!tab.canGoBack()) {
          return "No previous page in history";
        }
        const beforeUrl = tab.view.webContents.getURL();
        const backId = tabManager.getActiveTabId();
        if (!backId) return asNoActiveTabResponse();
        tabManager.goBack(backId);
        await waitForLoad(tab.view.webContents);
        const afterUrl = tab.view.webContents.getURL();
        return afterUrl !== beforeUrl
          ? `Went back to ${afterUrl}`
          : `Back action completed but page stayed on ${afterUrl}`;
      });
    },
  );

  server.registerTool(
    "go_forward",
    {
      title: "Go Forward",
      description: "Go forward in browser history.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(runtime, tabManager, "go_forward", {}, async () => {
        if (!tab.canGoForward()) {
          return "No forward page in history";
        }
        const beforeUrl = tab.view.webContents.getURL();
        const forwardId = tabManager.getActiveTabId();
        if (!forwardId) return asNoActiveTabResponse();
        tabManager.goForward(forwardId);
        await waitForLoad(tab.view.webContents);
        const afterUrl = tab.view.webContents.getURL();
        return afterUrl !== beforeUrl
          ? `Went forward to ${afterUrl}`
          : `Forward action completed but page stayed on ${afterUrl}`;
      });
    },
  );

  server.registerTool(
    "reload",
    {
      title: "Reload",
      description: "Reload the current page.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(runtime, tabManager, "reload", {}, async () => {
        const reloadId = tabManager.getActiveTabId();
        if (!reloadId) return asNoActiveTabResponse();
        tabManager.reloadTab(reloadId);
        await waitForLoad(tab.view.webContents);
        return `Reloaded ${tab.view.webContents.getURL()}`;
      });
    },
  );

  server.registerTool(
    "create_tab",
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
    "switch_tab",
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
    "close_tab",
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
    "wait_for",
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
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "wait_for",
        { text, selector, timeoutMs },
        async () =>
          waitForConditionMcp(tab.view.webContents, text, selector, timeoutMs),
      );
    },
  );

  server.registerTool(
    "wait_for_navigation",
    {
      title: "Wait For Navigation",
      description:
        "Wait for the current page to finish loading after a click or form submission.",
      inputSchema: z.object({
        timeoutMs: z
          .number()
          .optional()
          .describe("Max wait in milliseconds (default 10000)"),
      }),
    },
    async ({ timeoutMs }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "wait_for_navigation",
        { timeoutMs },
        async () => {
          const wc = tab.view.webContents;
          const timeout = timeoutMs || 10000;
          const beforeUrl = wc.getURL();
          if (wc.isLoading()) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, timeout);
              wc.once("did-stop-loading", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          } else {
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
          return afterUrl !== beforeUrl
            ? `Navigation complete: ${title} (${afterUrl})`
            : `Page loaded: ${title} (${afterUrl})`;
        },
      );
    },
  );
}
