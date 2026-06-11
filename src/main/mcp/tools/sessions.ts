import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentRuntime } from "../../agent/runtime";
import type { TabManager } from "../../tabs/tab-manager";
import * as namedSessionManager from "../../sessions/manager";
import { withAction } from "../mcp-helpers";

export function registerSessionTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "checkpoint_create",
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
    "checkpoint_restore",
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
    "save_session",
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
    "load_session",
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
    "list_sessions",
    {
      title: "List Sessions",
      description:
        "List previously saved named browser sessions with cookie and storage counts.",
    },
    async () =>
      withAction(runtime, tabManager, "list_sessions", {}, async () => {
        const sessions = await namedSessionManager.listNamedSessions();
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
    "delete_session",
    {
      title: "Delete Session",
      description: "Delete a previously saved named browser session.",
      inputSchema: {
        name: z.string().describe("Saved session name to delete"),
      },
    },
    async ({ name }) =>
      withAction(runtime, tabManager, "delete_session", { name }, async () =>
        (await namedSessionManager.deleteNamedSession(name))
          ? `Deleted session "${name}"`
          : `Session "${name}" not found`,
      ),
  );
}
