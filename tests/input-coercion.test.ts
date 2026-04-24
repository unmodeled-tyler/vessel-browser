import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  isUndoableAction,
  isUndoableResult,
} from "../src/main/agent/undo-policy";
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

test("marks session-restorable browser actions as undoable", () => {
  for (const action of [
    "navigate",
    "click",
    "type_text",
    "fill_form",
    "go_back",
    "open_bookmark",
    "restore_checkpoint",
    "create_tab",
    "close_tab",
  ]) {
    assert.equal(isUndoableAction(action), true, action);
  }
});

test("does not mark persistent data mutations as undoable", () => {
  for (const action of [
    "save_bookmark",
    "delete_session",
    "create_checkpoint",
    "save_session",
    "clear_highlights",
    "undo_last_action",
  ]) {
    assert.equal(isUndoableAction(action), false, action);
  }
});

test("keeps undo snapshots only for meaningful successful results", () => {
  assert.equal(isUndoableResult("Navigated to https://example.com"), true);
  assert.equal(isUndoableResult("Error: No active tab"), false);
  assert.equal(isUndoableResult("No active tab. Use navigate first."), false);
  assert.equal(isUndoableResult("Nothing to undo."), false);
  assert.equal(isUndoableResult("Action rejected: navigate"), false);
});
