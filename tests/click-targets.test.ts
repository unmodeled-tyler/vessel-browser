import assert from "node:assert/strict";
import test from "node:test";
import type { WebContents } from "electron";

import { clickElement } from "../src/main/ai/page-actions/click-targets";

/**
 * `clickElement` resolves its target by running a page script via
 * `wc.executeJavaScript`. The page script (the reveal + retry logic that
 * recovers hidden / lazy-loaded targets) depends on a real browser layout
 * engine, so it is exercised by the real-browser navigation regression harness
 * rather than unit-tested here.
 *
 * What we CAN pin at the unit level is the TypeScript-side contract that the
 * provider click→read_page circuit-breaker depends on: the exact error-string
 * shape `clickElement` emits when a target stays hidden, and that pointer
 * events only fire once a target resolves to coordinates. If this string shape
 * drifts, `isHiddenClickFailure` and the suppression gate stop matching, so
 * this test guards the boundary between the page-action layer and the guardrails.
 */
type ResolveResult =
  | { error: string }
  | { x: number; y: number; obstructed: boolean; hiddenWindow: boolean };

function makeFakeWc(result: ResolveResult): {
  wc: WebContents;
  inputs: Array<{ type: string }>;
} {
  const inputs: Array<{ type: string }> = [];
  const wc = {
    id: 42,
    isDestroyed: () => false,
    executeJavaScript: () => Promise.resolve(result),
    sendInputEvent: (event: { type: string }) => {
      inputs.push(event);
    },
  } as unknown as WebContents;
  return { wc, inputs };
}

const HIDDEN_ERROR =
  "Error[hidden]: Element has no visible area. It may be inside a collapsed, lazy-loaded, or virtual-scroll section. Scroll toward it (scroll or scroll_to_element) then call read_page to refresh visible elements before clicking again.";
const STALE_ERROR =
  "Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh.";

test("clickElement propagates Error[hidden] with the prefix the loop guard matches", async () => {
  const { wc } = makeFakeWc({ error: HIDDEN_ERROR });
  const out = await clickElement(wc, "button.add-to-cart");
  // The page-script error is wrapped as `Error: <page error>`; the
  // `Error[hidden]` marker the circuit-breaker matches on must survive intact.
  assert.equal(out, `Error: ${HIDDEN_ERROR}`);
  assert.ok(/Error\[hidden\]/.test(out));
});

test("clickElement propagates Error[stale-index] and dispatches no pointer events", async () => {
  const { wc, inputs } = makeFakeWc({ error: STALE_ERROR });
  const out = await clickElement(wc, "a.product-link");
  assert.ok(out.startsWith("Error: Error[stale-index]"));
  assert.equal(inputs.length, 0, "no pointer events should fire for a failed resolve");
});

test("clickElement dispatches mouseMove → mouseDown → mouseUp on a successful resolve", async () => {
  const { wc, inputs } = makeFakeWc({
    x: 120,
    y: 80,
    obstructed: false,
    hiddenWindow: false,
  });
  const out = await clickElement(wc, "button.buy");
  assert.equal(out, "Clicked via pointer events");
  assert.deepEqual(
    inputs.map((e) => e.type),
    ["mouseMove", "mouseDown", "mouseUp"],
  );
});

test("clickElement reports a partially obstructed target without failing the resolve", async () => {
  const { wc, inputs } = makeFakeWc({
    x: 120,
    y: 80,
    obstructed: true,
    hiddenWindow: false,
  });
  const out = await clickElement(wc, "button.buy");
  assert.equal(out, "Clicked via pointer events (target may be partially obstructed)");
  assert.equal(inputs.length, 3, "obstructed targets still receive a full click sequence");
});