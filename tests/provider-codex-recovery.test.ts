import assert from "node:assert/strict";
import test from "node:test";

import { CodexProvider } from "../src/main/ai/provider-codex";

// --- fetch / SSE helpers (mirrors tests/security-hardening.test.ts) ---

async function withMockFetch<T>(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function codexSseResponse(
  events: Array<Record<string, unknown>>,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        ...headers,
      },
    },
  );
}

function codexTokens() {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    idToken: "",
    expiresAt: Date.now() + 60 * 60 * 1000,
    accountId: "account-123",
  };
}

const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "Search the open web",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
} as const;

const READ_PAGE_TOOL = {
  name: "read_page",
  description: "Read current page",
  input_schema: { type: "object", properties: {} },
} as const;

const CLICK_TOOL = {
  name: "click",
  description: "Click a page element",
  input_schema: {
    type: "object",
    properties: { index: { type: "number" }, text: { type: "string" } },
  },
} as const;

const NAVIGATE_TOOL = {
  name: "navigate",
  description: "Navigate to a URL",
  input_schema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
} as const;

function readPageCall(callId: string) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name: "read_page",
      arguments: "{}",
    },
  };
}

function webSearchCall(callId: string, query: string) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name: "web_search",
      arguments: JSON.stringify({ query }),
    },
  };
}

function clickCall(callId: string, index: number) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name: "click",
      arguments: JSON.stringify({ index }),
    },
  };
}

function navigateCall(callId: string, url: string) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name: "navigate",
      arguments: JSON.stringify({ url }),
    },
  };
}

test(
  "Codex harness does NOT nudge the model when it says 'I've navigated' or 'I'll now click'",
  { timeout: 10_000 },
  async () => {
    // Regression: the previous shouldRetryCodexToolLoop treated
    // "I've navigated", "I'll now", "next I'll", "I will now" as
    // STALL signals and pushed a `[System] The task is still in
    // progress: ...` recovery message with `<<erase_prev>>` to
    // force the model to keep working. That erased the model's
    // natural progress narrative ("I've navigated to the airline
    // site, now I'll click the result") and confused it.
    //
    // The new logic only nudges on real stalls: empty text, an
    // explicit user-question, or a "I cannot proceed" signal.
    // Forward-looking language is now allowed to be a natural
    // completion.
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;

      if (requestCount === 1) {
        // First: model searches
        return codexSseResponse([
          webSearchCall("call_ws", "cheapest flight PDX SFO"),
        ]);
      }
      if (requestCount === 2) {
        // Second: model navigates (real progress, no tool call
        // suppression, just executes)
        return codexSseResponse([
          navigateCall("call_nav", "https://www.alaskaair.com/"),
        ]);
      }
      // Third turn: model emits progress narrative "I've
      // navigated to the airline site, now I'll click the result"
      // — a NATURAL forward-looking phrase. The OLD harness would
      // have nudged here with a recovery message. The NEW
      // harness should let the model finish (no tool call → break).
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta:
            "I've navigated to the airline site. Next, I'll click the cheapest flight result.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "find the cheapest flight from PDX to SFO",
        [WEB_SEARCH_TOOL, READ_PAGE_TOOL, NAVIGATE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (name === "web_search") {
            return `Web searched via default search engine → https://duckduckgo.com/\n[state: url=https://duckduckgo.com/, title="DuckDuckGo"]`;
          }
          if (name === "navigate") {
            return "Navigated to https://www.alaskaair.com/";
          }
          return "page snapshot";
        },
        () => undefined,
      ),
    );

    // The web_search and navigate actually executed.
    const ws = calls.filter((c) => c.name === "web_search");
    const nav = calls.filter((c) => c.name === "navigate");
    assert.equal(ws.length, 1, "first web_search should execute");
    assert.equal(nav.length, 1, "navigate should execute");

    // 3 backend calls — the third turn emitted the forward-looking
    // narrative, the harness did NOT nudge, and the loop broke
    // naturally. (If the harness had nudged, there would be a 4th
    // backend call.)
    assert.equal(
      requestBodies.length,
      3,
      "harness should NOT nudge on 'I've navigated' or 'next, I'll' — let the model finish",
    );

    // No erase_prev chunks (the recovery path emits those to wipe
    // the model's just-typed text).
    const eraseChunks = chunks.filter((chunk) =>
      chunk.includes("<<erase_prev>>"),
    );
    assert.equal(
      eraseChunks.length,
      0,
      "harness should NOT erase the model's natural progress narrative",
    );

    // No recovery [System] nudge in the third-turn input. We can
    // detect this by checking the 3rd backend call's input doesn't
    // contain "task is still in progress".
    const lastInput = JSON.stringify(requestBodies[2]?.input ?? []);
    assert.doesNotMatch(
      lastInput,
      /task is still in progress/i,
      "harness should NOT push a 'task is still in progress' nudge on forward-looking text",
    );
  },
);

test(
  "Codex harness DOES nudge when the model gives up with 'I cannot proceed'",
  { timeout: 10_000 },
  async () => {
    // Counter-test: the new logic still nudges on real stalls.
    // A model that says "I cannot see the current page" or "I'm
    // unable to click" has genuinely stalled and should get a
    // [System] nudge.
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;

      if (requestCount === 1) {
        return codexSseResponse([readPageCall("call_read")]);
      }
      if (requestCount === 2) {
        // Model says it cannot see the page (real stall).
        return codexSseResponse([
          {
            type: "response.output_text.delta",
            delta:
              "I cannot see the current page state, so I cannot click the right element.",
          },
        ]);
      }
      if (requestCount === 3) {
        // After the nudge, the model should retry with a tool call.
        return codexSseResponse([
          readPageCall("call_read_2"),
        ]);
      }
      // After the second read_page, the model gives a final
      // answer.
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "I have enough context now.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "do something on the current page",
        [READ_PAGE_TOOL, CLICK_TOOL],
        (chunk) => chunks.push(chunk),
        async (name) => {
          calls.push({ name, args: {} });
          return "Page snapshot";
        },
        () => undefined,
      ),
    );

    // Recovery nudge pushed a [System] message on the 3rd backend
    // call. The 3rd turn's input should contain the recovery
    // prompt.
    const nudgeInput = JSON.stringify(requestBodies[2]?.input ?? []);
    assert.match(
      nudgeInput,
      /task is still in progress/i,
      "harness should push the recovery prompt on a real stall ('I cannot')",
    );

    // The model did retry (2 read_page calls executed).
    const readPageCalls = calls.filter((c) => c.name === "read_page");
    assert.equal(
      readPageCalls.length,
      2,
      "model should retry after the recovery nudge",
    );
  },
);

test(
  "Codex harness nudges when the model asks the user to let it inspect existing results",
  { timeout: 10_000 },
  async () => {
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;

      if (requestCount === 1) {
        return codexSseResponse([
          webSearchCall("call_search", "cheap flights Portland to San Francisco June 23"),
        ]);
      }
      if (requestCount === 2) {
        return codexSseResponse([
          clickCall("call_click", 3),
        ]);
      }
      if (requestCount === 3) {
        return codexSseResponse([
          {
            type: "response.output_text.delta",
            delta:
              "I can help find the cheapest flight, but I need to continue from the existing search results already open in the browser. Please let me inspect/click one of the current flight results so I can compare the fares and report the cheapest option.",
          },
        ]);
      }
      return codexSseResponse([
        readPageCall("call_read"),
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "I need to book a flight from portland to SF on June 23rd - can you help me find the cheapest one?",
        [WEB_SEARCH_TOOL, CLICK_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (name === "web_search") {
            return "Web searched via default search engine -> https://www.google.com/search?q=cheap+flights\n[state: url=https://www.google.com/search?q=cheap+flights, title=\"cheap flights\"]";
          }
          if (name === "click") {
            return "Clicked: PDX to San Francisco Flights - One-Way as Low as...\nNote: Page did not change after click. The element may need a different interaction method. Consider read_page or inspect_element.";
          }
          return "[read_page mode=results_only]\n\n### Likely search results\n- [#4] Alaska Airlines PDX to SFO $79\n- [#5] United PDX to SFO $83";
        },
        () => undefined,
      ),
    );

    const nudgeInput = JSON.stringify(requestBodies[3]?.input ?? []);
    assert.match(
      nudgeInput,
      /task is still in progress/i,
      "harness should recover when the model asks the user to let it continue",
    );
    assert.equal(
      calls.some((call) => call.name === "read_page"),
      true,
      "model should get another chance to continue with a browser tool",
    );
    assert.equal(
      chunks.some((chunk) => chunk.includes("<<erase_prev>>")),
      true,
      "stalled handoff text should be erased before the recovery turn",
    );
  },
);

test(
  "Codex harness nudges when the model claims it cannot reuse existing search results",
  { timeout: 10_000 },
  async () => {
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;

      if (requestCount === 1) {
        return codexSseResponse([
          webSearchCall("call_search_1", "cheap flights Portland to San Francisco June 23"),
        ]);
      }
      if (requestCount === 2) {
        return codexSseResponse([
          readPageCall("call_read_1"),
        ]);
      }
      if (requestCount === 3) {
        return codexSseResponse([
          webSearchCall("call_search_2", "cheap flights Portland to San Francisco June 23"),
        ]);
      }
      if (requestCount === 4) {
        return codexSseResponse([
          {
            type: "response.output_text.delta",
            delta:
              "I'm already partway through this task and have search results available from an earlier step, but I can’t access or reuse them from the visible context you gave me here. If you send me the current results page or pricing options you see, I can tell you which is actually cheapest.",
          },
        ]);
      }
      if (requestCount === 5) {
        return codexSseResponse([
          readPageCall("call_read_2"),
        ]);
      }
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "The cheapest visible option is Alaska at $79.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "I need to book a flight from portland to SF on June 23rd - can you help me find the cheapest one?",
        [WEB_SEARCH_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (name === "web_search") {
            return "Web searched via default search engine -> https://www.google.com/search?q=cheap+flights\n[state: url=https://www.google.com/search?q=cheap+flights, title=\"cheap flights\"]";
          }
          return "[read_page mode=results_only]\n\n### Likely search results\n- [#4] Alaska Airlines PDX to SFO $79\n- [#5] United PDX to SFO $83";
        },
        () => undefined,
      ),
    );

    assert.equal(
      calls.filter((call) => call.name === "web_search").length,
      1,
      "duplicate web_search should be suppressed instead of executed again",
    );
    assert.equal(
      chunks.some((chunk) => chunk.includes("<<tool:web_search:↻ duplicate suppressed>>")),
      true,
      "duplicate web_search should be visible as a suppressed tool chip",
    );

    const nudgeInput = JSON.stringify(requestBodies[4]?.input ?? []);
    assert.match(
      nudgeInput,
      /task is still in progress/i,
      "harness should recover when the model claims it cannot access prior results",
    );
    assert.equal(
      calls.filter((call) => call.name === "read_page").length,
      2,
      "model should get another chance to continue from page results",
    );
  },
);

test(
  "Codex harness escalates guidance after repeated failed flight result clicks",
  { timeout: 10_000 },
  async () => {
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;

      if (requestCount === 1) {
        return codexSseResponse([
          webSearchCall("call_search", "cheap flights Portland to San Francisco June 23"),
        ]);
      }
      if (requestCount === 2) {
        return codexSseResponse([
          readPageCall("call_read_1"),
        ]);
      }
      if (requestCount === 3) {
        return codexSseResponse([
          clickCall("call_click_1", 7),
        ]);
      }
      if (requestCount === 4) {
        return codexSseResponse([
          readPageCall("call_read_2"),
        ]);
      }
      if (requestCount === 5) {
        return codexSseResponse([
          clickCall("call_click_2", 8),
        ]);
      }
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "The cheapest visible option is the $74 one-way fare.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "I need to book a flight from portland to SF on June 23rd - can you help me find the cheapest one?",
        [WEB_SEARCH_TOOL, READ_PAGE_TOOL, CLICK_TOOL],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (name === "web_search") {
            return "Web searched via default search engine -> https://www.google.com/search?q=cheap+flights\n[state: url=https://www.google.com/search?q=cheap+flights, title=\"cheap flights\"]";
          }
          if (name === "read_page") {
            return "[read_page mode=results_only]\n\n### Likely search results\n- [#7] PDX to San Francisco - One-Way as Low as $74\n- [#8] PDX to San Francisco - One-Way as Low as $79";
          }
          const index = typeof args.index === "number" ? args.index : 0;
          return `Clicked: PDX to San Francisco - One-Way as Low as $${index === 7 ? "74" : "79"}\nNote: Page did not change after click. The element may need a different interaction method. Consider read_page or inspect_element.`;
        },
        () => undefined,
      ),
    );

    assert.equal(
      calls.filter((call) => call.name === "click").length,
      2,
      "the two failed clicks should execute and return errors",
    );

    const secondRecoveryInput = JSON.stringify(requestBodies[5]?.input ?? []);
    assert.match(
      secondRecoveryInput,
      /multiple failed clicks/i,
      "second failed click should trigger stronger no-progress guidance",
    );
    assert.match(
      secondRecoveryInput,
      /Do not keep clicking similar search result titles/i,
      "second failed click should discourage more result-title clicks",
    );
    assert.match(
      secondRecoveryInput,
      /For flight-price tasks, visible fare snippets are enough/i,
      "flight fare result failures should steer toward comparing visible fares",
    );
    assert.equal(
      chunks.some((chunk) => chunk.includes("<<tool:click:⚠ failed #7>>")),
      true,
      "first failed click should still be visible",
    );
    assert.equal(
      chunks.some((chunk) => chunk.includes("<<tool:click:⚠ failed #8>>")),
      true,
      "second failed click should still be visible",
    );
  },
);

test(
  "Codex harness caps recovery nudges at 1 (no second nudge on persistent stall)",
  { timeout: 10_000 },
  async () => {
    // The previous code had `recoveryCount < 2`, allowing TWO
    // recovery nudges per session. The new code caps at 1. A model
    // that keeps stalling after one nudge should be allowed to
    // give its final answer (or the loop should exit naturally).
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;

      if (requestCount === 1) {
        return codexSseResponse([readPageCall("call_read_1")]);
      }
      if (requestCount === 2) {
        // Real stall — 1st nudge fires.
        return codexSseResponse([
          {
            type: "response.output_text.delta",
            delta: "I cannot proceed without more context.",
          },
        ]);
      }
      if (requestCount === 3) {
        // After the nudge, the model STALLS AGAIN with the same
        // "I cannot" wording. The OLD harness would have nudged
        // a second time (recoveryCount < 2). The NEW harness
        // should NOT nudge again — it's the second time the model
        // has stalled, so the harness accepts the model's
        // self-reported inability and breaks the loop.
        return codexSseResponse([
          {
            type: "response.output_text.delta",
            delta: "I cannot proceed. I cannot see the page.",
          },
        ]);
      }
      // If the harness did nudge a 2nd time, we'd see a 4th turn.
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "unexpected 4th turn",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "do something",
        [READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name) => {
          calls.push({ name, args: {} });
          return "Page snapshot";
        },
        () => undefined,
      ),
    );

    // 3 backend calls: search, 1st nudge fires, 2nd stall exits.
    // (The OLD harness would have produced 4: search, 1st nudge,
    // 2nd nudge fires, then a 4th turn.)
    assert.equal(
      requestBodies.length,
      3,
      "harness should cap recovery nudges at 1 and accept the model's 2nd stall as final",
    );

    // The 3rd backend call's input is the 1st recovery nudge
    // (pushed in response to the 2nd-turn stall). The harness
    // should NOT have produced a 4th backend call (no 2nd nudge).
    const nudgeInput = JSON.stringify(requestBodies[2]?.input ?? []);
    assert.match(
      nudgeInput,
      /task is still in progress/i,
      "1st stall should fire a recovery nudge (seen as input to the 3rd backend call)",
    );
  },
);

test(
  "Codex harness softens the failed-click recovery input (no over-prescriptive target guidance)",
  { timeout: 10_000 },
  async () => {
    // The previous failed-click recovery input said "Avoid filters,
    // sort controls, snippets, timestamps, and non-link text" and
    // "Do not retry the same click target". The new version just
    // says "the click did not complete, take the next step" — no
    // prescriptive list. This test pins the new wording.
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;

      if (requestCount === 1) {
        // First click fails.
        return codexSseResponse([clickCall("call_click_1", 12)]);
      }
      // After the failed click, the model retries with a
      // different target — the loop continues naturally.
      return codexSseResponse([clickCall("call_click_2", 13)]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "click the second result",
        [CLICK_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name) => {
          calls.push({ name, args: {} });
          return "Clicked: result link\nNote: Page did not change after click.";
        },
        () => undefined,
      ),
    );

    // The recovery input is pushed on the 2nd turn (after the
    // failed click). It should mention the failed target but
    // should NOT contain the over-prescriptive target guidance.
    const turn2Input = JSON.stringify(requestBodies[1]?.input ?? []);
    assert.match(
      turn2Input,
      /previous click did not complete/i,
      "recovery input should mention the failed click",
    );
    assert.match(
      turn2Input,
      /#12/,
      "recovery input should name the failing target",
    );
    // The over-prescriptive language should be gone.
    assert.doesNotMatch(
      turn2Input,
      /Avoid filters, sort controls, snippets, timestamps/i,
      "recovery input should not over-prescribe which targets to avoid",
    );
    assert.doesNotMatch(
      turn2Input,
      /Do not retry the same click target/i,
      "recovery input should not forbid retrying the same target (the model may need to)",
    );
  },
);

test(
  "Codex harness steers a hidden click target toward scroll instead of 'try a different target'",
  { timeout: 10_000 },
  async () => {
    // A hidden / not-laid-out click target (lazy-loaded, virtual-scroll, or
    // collapsed) is the case where "try a different target" feeds the loop —
    // the model re-picks a similar hidden neighbor. The recovery input should
    // instead lead with scroll / scroll_to_element to reveal the element,
    // matching the tool's own error guidance and the circuit-breaker's
    // strike-2 nudge.
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;
      if (requestCount === 1) {
        return codexSseResponse([clickCall("call_click_1", 12)]);
      }
      return codexSseResponse([clickCall("call_click_2", 13)]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "click the second result",
        [CLICK_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name) => {
          calls.push({ name, args: {} });
          return "Error: Error[hidden]: Element has no visible area. It may be inside a collapsed, lazy-loaded, or virtual-scroll section. Scroll toward it (scroll or scroll_to_element) then call read_page to refresh visible elements before clicking again.";
        },
        () => undefined,
      ),
    );

    // The recovery input is pushed on the 2nd turn (after the failed hidden
    // click). It should name the failure and steer toward scroll — NOT
    // "try a different target", which is what feeds a hidden-target loop.
    const turn2Input = JSON.stringify(requestBodies[1]?.input ?? []);
    assert.match(
      turn2Input,
      /previous click did not complete/i,
      "recovery input should still mention the failed click",
    );
    assert.match(
      turn2Input,
      /#12/,
      "recovery input should name the failing target",
    );
    assert.match(
      turn2Input,
      /scroll_to_element|\bscroll\b/i,
      "hidden target recovery should steer toward scroll, not a different target",
    );
    assert.match(
      turn2Input,
      /hidden|not laid out/i,
      "recovery should name the hidden-target cause",
    );
    assert.doesNotMatch(
      turn2Input,
      /try a different target/i,
      "hidden target recovery should not suggest 'try a different target' (that feeds the loop)",
    );
  },
);

test(
  "Codex harness steers a stale click target toward read_page refresh, not scroll",
  { timeout: 10_000 },
  async () => {
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;
      if (requestCount === 1) {
        return codexSseResponse([clickCall("call_click_1", 12)]);
      }
      return codexSseResponse([clickCall("call_click_2", 13)]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "click the second result",
        [CLICK_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name) => {
          calls.push({ name, args: {} });
          return "Error: Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh.";
        },
        () => undefined,
      ),
    );

    const turn2Input = JSON.stringify(requestBodies[1]?.input ?? []);
    assert.match(
      turn2Input,
      /previous click did not complete/i,
      "recovery input should still mention the failed click",
    );
    assert.match(
      turn2Input,
      /read_page/i,
      "stale target recovery should refresh page state/indexes",
    );
    assert.match(
      turn2Input,
      /stale|page changed|snapshot/i,
      "stale target recovery should name the stale-index cause",
    );
    assert.doesNotMatch(
      turn2Input,
      /hidden|not laid out|scroll_to_element|\bscroll\b/i,
      "stale target recovery should not misclassify the target as hidden or steer to scroll",
    );
  },
);
