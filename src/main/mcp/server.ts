import crypto from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLogger } from "../../shared/logger";
import { errorResult } from "../../shared/result";
import type { AgentRuntime } from "../agent/runtime";
import type { TabManager } from "../tabs/tab-manager";
import { setMcpHealth } from "../health/runtime-health";
import { registerDevTools } from "../devtools/tools";
import { registerBookmarkTools } from "./tools/bookmarks";
import { registerMemoryTools } from "./tools/memory";
import { registerSessionTools } from "./tools/sessions";
import { registerContentTools } from "./tools/content";
import { registerInteractionTools } from "./tools/interaction";
import { registerNavigationTools } from "./tools/navigation";
import { registerPromptTools } from "./tools/prompts";
import { registerGroupTools } from "./tools/groups";
import { registerHighlightTools } from "./tools/highlights";
import { registerFlowTools } from "./tools/flow";
import { registerTaskMemoryTools } from "./tools/task-memory";
import { registerMacroTools } from "./tools/macros";
import { registerVaultTools } from "./tools/vault";
import { registerMetricsTools } from "./tools/metrics";
import {
  getPersistentMcpAuthToken,
  writeMcpAuthFile,
  clearMcpAuthFile,
} from "./mcp-auth";
import type { McpServerStartResult } from "./mcp-auth";
import { mcpRuntimeState } from "./mcp-state";

const logger = createLogger("MCP");
export { getMcpAuthToken, regenerateMcpAuthToken } from "./mcp-auth";
export type { McpServerStartResult } from "./mcp-auth";
export { requiresExplicitMcpApproval } from "./mcp-helpers";
function registerTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  registerPromptTools(server, tabManager, runtime);
  registerGroupTools(server, tabManager, runtime);
  registerHighlightTools(server, tabManager, runtime);

  registerBookmarkTools(server, tabManager, runtime);
  registerContentTools(server, tabManager, runtime);
  registerNavigationTools(server, tabManager, runtime);
  registerInteractionTools(server, tabManager, runtime);
  registerSessionTools(server, tabManager, runtime);
  registerMemoryTools(server, tabManager, runtime);

  registerFlowTools(server, tabManager, runtime);
  registerTaskMemoryTools(server, tabManager, runtime);
  registerMacroTools(server, tabManager, runtime);
  registerVaultTools(server, tabManager, runtime);
  registerMetricsTools(server, tabManager, runtime);
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
  registerDevTools(server, tabManager, runtime);
  return server;
}

export async function startMcpServer(
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

  mcpRuntimeState.authToken = await getPersistentMcpAuthToken();

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname !== "/mcp") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      // Only allow CORS from localhost origins (defense-in-depth alongside auth token)
      const origin = req.headers.origin;
      if (
        origin &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader(
          "Access-Control-Allow-Methods",
          "POST, GET, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, mcp-session-id, Authorization",
        );
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Validate bearer token on all non-OPTIONS requests (constant-time
      // comparison to prevent timing side-channel attacks on persistent tokens).
      const authHeader = req.headers.authorization;
      const expected = `Bearer ${mcpRuntimeState.authToken}`;
      const headerBuf = Buffer.from(authHeader ?? "");
      const expectedBuf = Buffer.from(expected);
      const tokenValid =
        headerBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(headerBuf, expectedBuf);
      if (!authHeader || !tokenValid) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized — missing or invalid bearer token" }));
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
        logger.error("Error handling request:", error);
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

    server.once("error", async (error: NodeJS.ErrnoException) => {
      const message =
        error.code === "EADDRINUSE"
          ? `Port ${port} is already in use. MCP server not started.`
          : error.message;
      logger.error("Server error:", error);
      await clearMcpAuthFile();
      setMcpHealth({
        configuredPort: port,
        activePort: null,
        endpoint: null,
        status: "error",
        message,
      });
      if (mcpRuntimeState.httpServer === server) {
        mcpRuntimeState.httpServer = null;
      }
      finish(errorResult(message, {
        configuredPort: port,
        activePort: null,
        endpoint: null,
        authToken: null,
      }));
    });

    server.listen(port, "127.0.0.1", async () => {
      mcpRuntimeState.httpServer = server;
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
      if (process.env.VESSEL_DEBUG_MCP === '1' || process.env.VESSEL_DEBUG_MCP === 'true') {
        logger.info(`Server listening on ${endpoint} (auth enabled)`);
      }
      if (mcpRuntimeState.authToken) {
        await writeMcpAuthFile(endpoint, mcpRuntimeState.authToken);
      }
      finish({
        ok: true,
        configuredPort: port,
        activePort: actualPort,
        endpoint,
        authToken: mcpRuntimeState.authToken,
      });
    });
  });
}

export async function stopMcpServer(): Promise<void> {
  const server = mcpRuntimeState.httpServer;
  if (!server) {
    await clearMcpAuthFile();
    setMcpHealth({
      activePort: null,
      endpoint: null,
      status: "stopped",
      message: "MCP server is stopped.",
    });
    return;
  }

  mcpRuntimeState.httpServer = null;
  mcpRuntimeState.authToken = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await clearMcpAuthFile();
  setMcpHealth({
    activePort: null,
    endpoint: null,
    status: "stopped",
    message: "MCP server is stopped.",
  });
  if (process.env.VESSEL_DEBUG_MCP === '1' || process.env.VESSEL_DEBUG_MCP === 'true') {
    logger.info("Server stopped");
  }
}
