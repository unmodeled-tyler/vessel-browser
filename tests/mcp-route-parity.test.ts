import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodType } from "zod";
import { parseHTML } from "linkedom";

import type { AgentRuntime } from "../src/main/agent/runtime";
import { registerContentTools } from "../src/main/mcp/tools/content";
import { registerInteractionTools } from "../src/main/mcp/tools/interaction";
import { registerNavigationTools } from "../src/main/mcp/tools/navigation";
import { resolveTextTargetInDocument } from "../src/main/ai/text-target-resolver";
import type { TabManager } from "../src/main/tabs/tab-manager";

type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: Record<string, ZodType<unknown>> | ZodType<unknown>;
};

type ToolRegistration = {
  config: ToolConfig;
  handler: (args: Record<string, unknown>, extra?: unknown) => unknown;
};

function getTool(
  tools: Map<string, ToolRegistration>,
  name: string,
): ToolRegistration {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Tool ${name} was not registered`);
  }
  return tool;
}

function inputShape(config: ToolConfig): Record<string, ZodType<unknown>> {
  const schema = config.inputSchema;
  assert.ok(schema);
  if ("shape" in schema && typeof schema.shape === "object") {
    return schema.shape as Record<string, ZodType<unknown>>;
  }
  return schema as Record<string, ZodType<unknown>>;
}

function createHarness() {
  const tools = new Map<string, ToolRegistration>();
  const server = {
    registerTool: (
      name: string,
      config: ToolConfig,
      handler: ToolRegistration["handler"],
    ) => {
      tools.set(name, { config, handler });
      return undefined;
    },
  } as unknown as McpServer;
  const tabManager = {} as unknown as TabManager;
  const runtime = {} as unknown as AgentRuntime;

  registerInteractionTools(server, tabManager, runtime);
  registerNavigationTools(server, tabManager, runtime);
  registerContentTools(server, tabManager, runtime);

  return { tools };
}

function withDocument(html: string): Document {
  const { document, window } = parseHTML(html);
  const domWindow = window as unknown as {
    Document: typeof Document;
    Element: typeof Element;
    HTMLElement: typeof HTMLElement;
    CSS?: typeof CSS;
    getComputedStyle?: typeof getComputedStyle;
  };
  const getComputedStyleShim =
    domWindow.getComputedStyle?.bind(window) ??
    (() => ({ display: "block", visibility: "visible", opacity: "1" }));
  Object.assign(globalThis, {
    window,
    Document: domWindow.Document,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
    CSS: domWindow.CSS,
    getComputedStyle: getComputedStyleShim,
  });
  return document as unknown as Document;
}

test("MCP route exposes API-parity targeting and discovery tools", () => {
  const { tools } = createHarness();

  assert.ok(getTool(tools, "web_search"));
  assert.ok(getTool(tools, "inspect_element"));

  for (const toolName of ["click", "inspect_element", "scroll_to_element"]) {
    const shape = inputShape(getTool(tools, toolName).config);
    assert.ok(shape.text, `${toolName} should accept visible text targets`);
    assert.equal(shape.text.parse("Visible Label"), "Visible Label");
  }

  const inspectShape = inputShape(getTool(tools, "inspect_element").config);
  assert.equal(inspectShape.limit.parse(4), 4);

  const readPageShape = inputShape(getTool(tools, "read_page").config);
  assert.equal(readPageShape.mode.parse("glance"), "glance");
  assert.equal(readPageShape.mode.parse("debug"), "debug");
  assert.equal(readPageShape.mode.parse("results_only"), "results_only");
});

test("MCP text-target resolver is standalone when stringified into Electron", () => {
  const document = withDocument(`
    <main>
      <button id="set-status">Set Status</button>
    </main>
  `);
  const fn = Function(
    "document",
    `const __name = (fn) => fn; return (${resolveTextTargetInDocument.toString()})(document, "Set Status", "interactive")`,
  );

  const match = fn(document) as ReturnType<typeof resolveTextTargetInDocument>;

  assert.equal(match?.selector, "#set-status");
});

test("MCP context text targets prefer exact interactive labels over broad regions", () => {
  const document = withDocument(`
    <main>
      <p>Fixture without a narrow region containing the button text.</p>
      <button id="set-status">Set Status</button>
    </main>
  `);

  const match = resolveTextTargetInDocument(document, "Set Status", "context");

  assert.equal(match?.selector, "#set-status");
  assert.equal(match?.kind, "button");
});
