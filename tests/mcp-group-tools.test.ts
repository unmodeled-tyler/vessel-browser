import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodType } from "zod";

import { registerGroupTools } from "../src/main/mcp/tools/groups";
import type { AgentRuntime } from "../src/main/agent/runtime";
import type { TabGroup, TabManager } from "../src/main/tabs/tab-manager";
import { TAB_GROUP_COLORS, type TabGroupColor } from "../src/shared/types";

type TextResponse = {
  content: Array<{ type: "text"; text: string }>;
};

type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: Record<string, ZodType<unknown>>;
};

type ToolRegistration = {
  config: ToolConfig;
  handler: (args: Record<string, unknown>, extra?: unknown) => TextResponse | Promise<TextResponse>;
};

function textOf(response: TextResponse): string {
  return response.content.map((part) => part.text).join("");
}

function getTool(tools: Map<string, ToolRegistration>, name: string): ToolRegistration {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Tool ${name} was not registered`);
  }
  return tool;
}

function createHarness() {
  const tools = new Map<string, ToolRegistration>();
  const groups: TabGroup[] = [
    {
      id: "group-1",
      name: "Group 1",
      color: "blue",
      collapsed: false,
    },
  ];
  const tabs: Array<{
    id: string;
    title: string;
    url: string;
    groupId?: string;
  }> = [{ id: "tab-1", title: "Example", url: "https://example.test", groupId: "group-1" }];
  const colorChanges: Array<{ groupId: string; color: TabGroupColor }> = [];
  const assignments: Array<{ tabId: string; groupId: string }> = [];
  const removals: string[] = [];

  const server = {
    registerTool: (name: string, config: ToolConfig, handler: ToolRegistration["handler"]) => {
      tools.set(name, { config, handler });
      return undefined;
    },
  } as unknown as McpServer;

  const tabManager = {
    getActiveTabId: () => "tab-1",
    getActiveTab: () => null,
    getAllStates: () => tabs,
    getGroups: () => groups,
    setGroupColor: (groupId: string, color: TabGroupColor) => {
      colorChanges.push({ groupId, color });
      const group = groups.find((candidate) => candidate.id === groupId);
      if (group) {
        group.color = color;
      }
    },
    createGroupFromTab: () => null,
    assignTabToGroup: (tabId: string, groupId: string) => {
      assignments.push({ tabId, groupId });
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (tab) tab.groupId = groupId;
    },
    removeTabFromGroup: (tabId: string) => {
      removals.push(tabId);
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (tab) tab.groupId = undefined;
    },
    toggleGroupCollapsed: () => null,
  } as unknown as TabManager;

  const runtime = {
    runControlledAction: async ({ executor }: { executor: () => Promise<string> }) => executor(),
    getFlowContext: () => "",
  } as unknown as AgentRuntime;

  registerGroupTools(server, tabManager, runtime);

  return { tools, groups, tabs, colorChanges, assignments, removals };
}

test("MCP group color schemas use the shared tab group palette", () => {
  const { tools } = createHarness();

  for (const toolName of ["create_group", "set_group_color"]) {
    const colorSchema = getTool(tools, toolName).config.inputSchema?.color;
    assert.ok(colorSchema);

    for (const color of TAB_GROUP_COLORS) {
      assert.equal(colorSchema.parse(color), color);
    }

    assert.throws(() => colorSchema.parse("chartreuse"), /Invalid tab group color/);
  }
});

test("MCP group color schemas can be represented in JSON Schema", () => {
  const { tools } = createHarness();

  for (const toolName of ["create_group", "set_group_color"]) {
    const inputSchema = getTool(tools, toolName).config.inputSchema;
    assert.ok(inputSchema);

    const jsonSchema = z.toJSONSchema(z.object(inputSchema));
    const colorSchema = jsonSchema.properties?.color;

    assert.deepEqual(colorSchema, {
      type: "string",
      enum: TAB_GROUP_COLORS,
      description: toolName === "create_group" ? "Optional group color" : "New color",
    });
  }
});

test("set_group_color reports missing groups instead of successful no-ops", async () => {
  const { tools, colorChanges } = createHarness();
  const setColor = getTool(tools, "set_group_color");

  const response = await setColor.handler({
    groupId: "missing-group",
    color: "purple",
  });

  assert.equal(textOf(response), "Error: Group not found");
  assert.deepEqual(colorChanges, []);
});

test("set_group_color applies valid shared palette colors", async () => {
  const { tools, groups, colorChanges } = createHarness();
  const setColor = getTool(tools, "set_group_color");

  const response = await setColor.handler({
    groupId: "group-1",
    color: "purple",
  });

  assert.equal(textOf(response), "Set group group-1 color to purple");
  assert.equal(groups[0]?.color, "purple");
  assert.deepEqual(colorChanges, [{ groupId: "group-1", color: "purple" }]);
});

test("group assignment rejects missing groups and tabs without reporting success", async () => {
  const { tools, assignments } = createHarness();
  const assign = getTool(tools, "assign_to_group");

  assert.equal(
    textOf(await assign.handler({ groupId: "missing-group", tabId: "tab-1" })),
    "Error: Group not found",
  );
  assert.equal(
    textOf(await assign.handler({ groupId: "group-1", tabId: "missing-tab" })),
    "Error: Tab not found",
  );
  assert.deepEqual(assignments, []);
});

test("group removal reports missing and already-ungrouped tabs accurately", async () => {
  const { tools, tabs, removals } = createHarness();
  const remove = getTool(tools, "remove_from_group");

  assert.equal(textOf(await remove.handler({ tabId: "missing-tab" })), "Error: Tab not found");
  assert.equal(textOf(await remove.handler({ tabId: "tab-1" })), "Removed tab tab-1 from group");
  assert.equal(textOf(await remove.handler({ tabId: "tab-1" })), "Tab tab-1 is not in a group");
  assert.equal(tabs[0]?.groupId, undefined);
  assert.deepEqual(removals, ["tab-1"]);
});
