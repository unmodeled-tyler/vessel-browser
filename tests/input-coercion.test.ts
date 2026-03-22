import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { TOOL_DEFINITIONS } from "../src/main/tools/definitions";

function getToolSchema(name: string) {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  assert.ok(definition?.inputSchema, `missing input schema for ${name}`);
  return z.object(definition.inputSchema);
}

test("scroll tool accepts numeric strings for amount", () => {
  const schema = getToolSchema("scroll");
  const parsed = schema.parse({ direction: "down", amount: "1000" });

  assert.equal(parsed.amount, 1000);
});

test("highlight tool strips wrapping quotes from text", () => {
  const schema = getToolSchema("highlight");
  const parsed = schema.parse({ text: '"Example Domain"' });

  assert.equal(parsed.text, "Example Domain");
});

test("flow_start tool accepts stringified JSON arrays", () => {
  const schema = getToolSchema("flow_start");
  const parsed = schema.parse({
    goal: "Checkout flow",
    steps: '["Log in","Search","Checkout"]',
  });

  assert.deepEqual(parsed.steps, ["Log in", "Search", "Checkout"]);
});
