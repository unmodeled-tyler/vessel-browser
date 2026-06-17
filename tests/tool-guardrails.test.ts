import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClickReadLoopIntervention,
  classifyClickFailure,
  ClickReadLoopGuard,
  isHiddenClickFailure,
  isRedundantNavigateTarget,
  looksLikeCurrentSiteNameQuery,
  shouldBlockOffGoalDomainNavigation,
} from "../src/main/ai/tool-guardrails";

test("detects redundant navigation to the same normalized URL", () => {
  assert.equal(
    isRedundantNavigateTarget(
      "https://www.powells.com/",
      "https://powells.com",
    ),
    true,
  );
});

test("does not mark different product paths as redundant navigation", () => {
  assert.equal(
    isRedundantNavigateTarget(
      "https://www.powells.com/",
      "https://www.powells.com/book/123",
    ),
    false,
  );
});

test("detects searching for the current site name", () => {
  assert.equal(
    looksLikeCurrentSiteNameQuery(
      "Powell's Books",
      "https://www.powells.com",
      "Powell's Books | The World's Largest Independent Bookstore",
    ),
    true,
  );
});

test("does not block real book search queries on the current site", () => {
  assert.equal(
    looksLikeCurrentSiteNameQuery(
      "octavia butler",
      "https://www.powells.com",
      "Powell's Books | The World's Largest Independent Bookstore",
    ),
    false,
  );
});

test("blocks navigation away from the single requested domain", () => {
  assert.deepEqual(
    shouldBlockOffGoalDomainNavigation(
      "go to powells.com and pick 5 books",
      "https://www.powertools.com",
    ),
    {
      requestedDomain: "powells.com",
      targetDomain: "powertools.com",
    },
  );
});

test("allows navigation within the requested domain family", () => {
  assert.equal(
    shouldBlockOffGoalDomainNavigation(
      "go to powells.com and pick 5 books",
      "https://shop.powells.com/books",
    ),
    null,
  );
});

test("classifies click failures without conflating hidden and stale targets", () => {
  assert.equal(
    classifyClickFailure(
      "Error: Error[hidden]: Element has no visible area. It may be inside a collapsed, lazy-loaded, or virtual-scroll section.",
    ),
    "hidden",
  );
  assert.equal(
    classifyClickFailure(
      "Error: Error[stale-index]: Element not found — the page may have changed.",
    ),
    "stale",
  );
  assert.equal(
    classifyClickFailure("Error: Could not resolve click target"),
    "other",
  );
  assert.equal(
    classifyClickFailure("Clicked: Dune paperback via pointer events"),
    null,
  );
});

test("isHiddenClickFailure only detects hidden click errors", () => {
  assert.equal(
    isHiddenClickFailure(
      "Error: Error[hidden]: Element has no visible area. It may be inside a collapsed, lazy-loaded, or virtual-scroll section.",
    ),
    true,
  );
  assert.equal(
    isHiddenClickFailure(
      "Error: Error[stale-index]: Element not found — the page may have changed.",
    ),
    false,
  );
  assert.equal(
    isHiddenClickFailure("Clicked: Dune paperback via pointer events"),
    false,
  );
  assert.equal(isHiddenClickFailure(""), false);
});

test("clickReadLoop intervention escalates from nudge to suppress", () => {
  assert.equal(
    buildClickReadLoopIntervention(0, null),
    null,
    "no intervention at strike 0",
  );

  const strike1 = buildClickReadLoopIntervention(1, null);
  assert.ok(strike1 && strike1.kind === "nudge", "strike 1 nudges (click still runs)");

  // Strike 2 with a hidden failure should steer the model to scroll — the
  // remedy the tool's own error names — not "try a different target".
  const strike2 = buildClickReadLoopIntervention(2, "hidden");
  assert.ok(strike2 && strike2.kind === "nudge", "strike 2 nudges");
  assert.ok(
    /scroll/i.test(strike2.message),
    "strike 2 nudge should mention scroll when the last click was hidden",
  );

  const staleStrike2 = buildClickReadLoopIntervention(2, "stale");
  assert.ok(staleStrike2 && staleStrike2.kind === "nudge", "stale strike 2 nudges");
  assert.match(
    staleStrike2.message,
    /read_page/i,
    "stale target nudge should refresh indexes instead of steering to scroll",
  );
  assert.doesNotMatch(
    staleStrike2.message,
    /hidden element/i,
    "stale target nudge should not claim the target was hidden",
  );

  // Strike ≥ threshold suppresses: returned AS the click result, so it reads
  // like a tool error and tells the model to stop clicking.
  const strike3 = buildClickReadLoopIntervention(3, "hidden");
  assert.ok(strike3 && strike3.kind === "suppress", "strike 3 suppresses");
  assert.ok(
    /^Error:/.test(strike3.message),
    "suppress message should look like a tool error result",
  );
  assert.ok(
    /scroll|inspect|visible/i.test(strike3.message),
    "suppress message should offer scroll / inspect / answer-from-visible",
  );
  assert.ok(
    /hidden/i.test(strike3.message),
    "suppress message should note the hidden target when lastClickFailedHidden",
  );

  // Further strikes keep suppressing (no termination — the run continues).
  const strike4 = buildClickReadLoopIntervention(4, null);
  assert.ok(strike4 && strike4.kind === "suppress", "strike 4 still suppresses");
  assert.ok(
    !/hidden/i.test(strike4.message),
    "suppress message omits the hidden note when lastClickFailedHidden is false",
  );
});

test("ClickReadLoopGuard owns loop strikes and suppression policy", () => {
  const guard = new ClickReadLoopGuard();

  assert.equal(guard.beforeTool("click"), null);
  assert.equal(
    guard.afterToolResult(
      "click",
      "Error: Error[hidden]: Element has no visible area.",
      false,
    ),
    null,
  );
  assert.equal(guard.afterToolResult("read_page", "Page snapshot", true), null);
  assert.equal(
    guard.afterToolResult(
      "click",
      "Error: Error[hidden]: Element has no visible area.",
      false,
    ),
    null,
  );
  assert.equal(guard.afterToolResult("read_page", "Page snapshot", true), null);
  guard.afterToolResult(
    "click",
    "Error: Error[hidden]: Element has no visible area.",
    false,
  );
  const firstNudge = guard.afterToolResult("read_page", "Page snapshot", true);
  assert.ok(firstNudge && firstNudge.kind === "nudge");

  const secondNudge = guard.afterToolResult(
    "click",
    "Error: Error[hidden]: Element has no visible area.",
    false,
  );
  assert.ok(secondNudge && secondNudge.kind === "nudge");
  const secondReadIntervention = guard.afterToolResult(
    "read_page",
    "Page snapshot",
    true,
  );
  assert.equal(secondReadIntervention, null);

  const thirdPreflight = guard.beforeTool("click");
  assert.ok(thirdPreflight && thirdPreflight.kind === "suppress");

  const preflight = guard.beforeTool("click");
  assert.ok(preflight && preflight.kind === "suppress");

  guard.afterToolResult("scroll", "Scrolled down", true);
  assert.equal(guard.beforeTool("click"), null);
});
