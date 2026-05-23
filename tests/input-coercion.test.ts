import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  isUndoableAction,
  isUndoableResult,
} from "../src/main/agent/undo-policy";
import {
  clearCartClickState,
  getCartAddedSummary,
  isAddToCartText,
  isDuplicateCartClick,
  isProductAlreadyInCart,
  recordCartClick,
  recordProductAddedToCart,
} from "../src/main/ai/cart-click-state";
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

test("cart click state blocks rapid duplicate add-to-cart clicks", () => {
  clearCartClickState();

  assert.equal(isAddToCartText(" Add   to Cart "), true);
  assert.equal(
    isDuplicateCartClick("https://powells.com/book/1", "Add to cart"),
    false,
  );

  recordCartClick("https://powells.com/book/1");

  assert.equal(
    isDuplicateCartClick("https://powells.com/book/1", "Add to cart"),
    true,
  );
  assert.equal(
    isDuplicateCartClick("https://powells.com/book/2", "Add to cart"),
    false,
  );
  assert.equal(
    isDuplicateCartClick("https://powells.com/book/1", "Read sample"),
    false,
  );
});

test("cart added state is scoped by origin and normalized path", () => {
  clearCartClickState();

  recordProductAddedToCart("https://powells.com/book/1?ref=home", "Book One");
  recordProductAddedToCart("https://example.com/book/2", "Book Two");

  assert.equal(isProductAlreadyInCart("https://powells.com/book/1"), true);
  assert.equal(
    isProductAlreadyInCart("https://powells.com/book/1?other=true"),
    true,
  );
  assert.equal(isProductAlreadyInCart("https://powells.com/book/3"), false);

  assert.match(getCartAddedSummary("https://powells.com/search"), /Book One/);
  assert.doesNotMatch(
    getCartAddedSummary("https://powells.com/search"),
    /Book Two/,
  );
});
