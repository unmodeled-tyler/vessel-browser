import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { AgentRuntime } from "../agent/runtime";
import { buildStructuredContext } from "../ai/context-builder";
import { extractContent } from "../content/extractor";
import type { TabManager } from "../tabs/tab-manager";

let httpServer: http.Server | null = null;

function asTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function isDangerousAction(name: string): boolean {
  return [
    "navigate",
    "click",
    "type",
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
    return asTextResponse(result);
  } catch (error) {
    return asTextResponse(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

function registerTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "vessel_extract_content",
    {
      title: "Extract Page Content",
      description:
        "Extract the full structured content of the current page including text, headings, interactive elements with indices, forms, and navigation.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");

      try {
        const pageContent = await extractContent(tab.view.webContents);
        const structured = buildStructuredContext(pageContent);
        const truncated =
          pageContent.content.length > 30000
            ? pageContent.content.slice(0, 30000) + "\n[Content truncated...]"
            : pageContent.content;
        return asTextResponse(`${structured}\n\n## PAGE CONTENT\n\n${truncated}`);
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
      description: "List all open browser tabs with their IDs, titles, and URLs.",
    },
    async () => {
      const activeId = tabManager.getActiveTabId();
      const lines = tabManager.getAllStates().map(
        (tab) => `${tab.id === activeId ? "->" : "  "} [${tab.id}] ${tab.title} — ${tab.url}`,
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
        tabManager.goBack(tabManager.getActiveTabId()!);
        await waitForLoad(tab.view.webContents);
        return `Went back to ${tab.view.webContents.getURL()}`;
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
        tabManager.goForward(tabManager.getActiveTabId()!);
        await waitForLoad(tab.view.webContents);
        return `Went forward to ${tab.view.webContents.getURL()}`;
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
        index: z.number().optional().describe("Element index from the page content listing"),
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
          const resolvedSelector = await resolveSelector(
            tab.view.webContents,
            index,
            selector,
          );
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          const result = await tab.view.webContents.executeJavaScript(`
            (function() {
              const el = document.querySelector(${JSON.stringify(resolvedSelector)});
              if (!el) return 'Element not found';
              el.click();
              return 'Clicked: ' + (el.textContent || el.tagName).trim().slice(0, 100);
            })()
          `);
          await new Promise((resolve) => setTimeout(resolve, 250));
          return result;
        },
      );
    },
  );

  server.registerTool(
    "vessel_type",
    {
      title: "Type Text",
      description: "Type text into an input field or textarea. Clears existing content first.",
      inputSchema: {
        index: z.number().optional().describe("Element index from the page content listing"),
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
          return tab.view.webContents.executeJavaScript(`
            (function() {
              const el = document.querySelector(${JSON.stringify(resolvedSelector)});
              if (!el) return 'Element not found';
              el.focus();
              el.value = ${JSON.stringify(text)};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'Typed into: ' + (el.getAttribute('aria-label') || el.placeholder || el.name || 'input');
            })()
          `);
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
        amount: z.number().optional().describe("Pixels to scroll (default 500)"),
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
          await tab.view.webContents.executeJavaScript(`window.scrollBy(0, ${dir})`);
          return `Scrolled ${direction} by ${pixels}px`;
        },
      );
    },
  );

  server.registerTool(
    "vessel_create_tab",
    {
      title: "Create Tab",
      description: "Open a new browser tab, optionally navigating to a URL.",
      inputSchema: {
        url: z.string().optional().describe("URL to open (defaults to about:blank)"),
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
      description: "Switch to a different browser tab by ID or title/URL match.",
      inputSchema: {
        tabId: z.string().optional().describe("The tab ID to switch to"),
        match: z.string().optional().describe("Case-insensitive match against title or URL"),
      },
    },
    async ({ tabId, match }) =>
      withAction(runtime, tabManager, "switch_tab", { tabId, match }, async () => {
        const targetId = tabId || (match ? getTabByMatch(tabManager, match)?.id : "");
        if (!targetId) {
          return "Error: No matching tab found";
        }
        tabManager.switchTab(targetId);
        return `Switched to tab ${targetId}`;
      }),
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
      withAction(runtime, tabManager, "create_checkpoint", { name, note }, async () => {
        const checkpoint = runtime.createCheckpoint(name, note);
        return `Created checkpoint ${checkpoint.name} (${checkpoint.id})`;
      }),
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
    "vessel_screenshot",
    {
      title: "Screenshot",
      description: "Capture a screenshot of the current page. Returns a base64-encoded PNG image.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asTextResponse("Error: No active tab");

      try {
        const image = await tab.view.webContents.capturePage();
        const png = image.toPNG();
        const base64 = png.toString("base64");
        return {
          content: [
            {
              type: "image" as const,
              data: base64,
              mimeType: "image/png",
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

function waitForLoad(
  wc: Electron.WebContents,
  timeout = 10000,
): Promise<void> {
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
    `window.__vessel?.getElementSelector?.(${index}) || null`,
  );
}

function createMcpServer(tabManager: TabManager, runtime: AgentRuntime): McpServer {
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");

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
    console.log(`[Vessel MCP] Server listening on http://127.0.0.1:${port}/mcp`);
  });

  httpServer.on("error", (error: any) => {
    if (error.code === "EADDRINUSE") {
      console.error(`[Vessel MCP] Port ${port} is already in use. MCP server not started.`);
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
