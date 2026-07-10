import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TAB_GROUP_COLORS } from "../../../shared/types";
import type { AgentRuntime } from "../../agent/runtime";
import {
  handleAssignToGroup,
  handleCreateGroup,
  handleListGroups,
  handleRemoveFromGroup,
  handleSetGroupColor,
  handleToggleGroup,
} from "../../ai/page-actions/handlers/tabs";
import type { TabManager } from "../../tabs/tab-manager";
import { asTextResponse, withAction } from "../mcp-helpers";

const TabGroupColorSchema = z.enum(TAB_GROUP_COLORS, { error: "Invalid tab group color" });

export function registerGroupTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "list_groups",
    {
      title: "List Tab Groups",
      description:
        "List browser tab groups with names, colors, collapsed state, and member tab count.",
    },
    async () => asTextResponse(handleListGroups({ tabManager, runtime })),
  );

  server.registerTool(
    "create_group",
    {
      title: "Create Tab Group",
      description:
        "Create a new tab group from the active tab or a specified tab. Optionally provide a name and color.",
      inputSchema: {
        tabId: z.string().optional().describe("Tab ID to group (defaults to active tab)"),
        name: z.string().optional().describe("Optional group name"),
        color: TabGroupColorSchema.optional().describe("Optional group color"),
      },
    },
    async ({ tabId, name, color }) =>
      withAction(runtime, tabManager, "create_group", { tabId, name, color }, async () =>
        handleCreateGroup({ tabManager, runtime }, { tabId, name, color }),
      ),
  );

  server.registerTool(
    "assign_to_group",
    {
      title: "Assign Tab to Group",
      description: "Move a tab into an existing group by ID. Defaults to the active tab.",
      inputSchema: {
        groupId: z.string().describe("Group ID to assign the tab to"),
        tabId: z.string().optional().describe("Tab ID to move (defaults to active tab)"),
      },
    },
    async ({ groupId, tabId }) =>
      withAction(runtime, tabManager, "assign_to_group", { groupId, tabId }, async () =>
        handleAssignToGroup({ tabManager, runtime }, { groupId, tabId }),
      ),
  );

  server.registerTool(
    "remove_from_group",
    {
      title: "Remove Tab from Group",
      description: "Ungroup a tab. Defaults to the active tab.",
      inputSchema: {
        tabId: z.string().optional().describe("Tab ID to ungroup (defaults to active tab)"),
      },
    },
    async ({ tabId }) =>
      withAction(runtime, tabManager, "remove_from_group", { tabId }, async () =>
        handleRemoveFromGroup({ tabManager, runtime }, { tabId }),
      ),
  );

  server.registerTool(
    "toggle_group",
    {
      title: "Toggle Group Collapsed",
      description: "Collapse or expand a tab group.",
      inputSchema: {
        groupId: z.string().describe("Group ID to toggle"),
      },
    },
    async ({ groupId }) =>
      withAction(runtime, tabManager, "toggle_group", { groupId }, async () =>
        handleToggleGroup({ tabManager, runtime }, { groupId }),
      ),
  );

  server.registerTool(
    "set_group_color",
    {
      title: "Set Group Color",
      description: "Change the color of a tab group.",
      inputSchema: {
        groupId: z.string().describe("Group ID"),
        color: TabGroupColorSchema.describe("New color"),
      },
    },
    async ({ groupId, color }) =>
      withAction(runtime, tabManager, "set_group_color", { groupId, color }, async () =>
        handleSetGroupColor({ tabManager, runtime }, { groupId, color }),
      ),
  );
}
