import assert from "node:assert/strict";
import test from "node:test";

import { shouldBlockUnsupportedFlightPriceAnswer } from "../src/main/ai/flight-price-evidence";
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

const CLEAR_OVERLAYS_TOOL = {
  name: "clear_overlays",
  description: "Clear blocking overlays",
  input_schema: { type: "object", properties: {} },
} as const;

const FLIGHT_QUERY = "cheapest flight tomorrow from Portland to San Francisco";

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

function clearOverlaysCall(callId: string) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name: "clear_overlays",
      arguments: "{}",
    },
  };
}

function searchResultOutput(query: string): string {
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  return [
    `Web searched "${query}" via default search engine → ${url}`,
    `[state: url=${url}, title="DuckDuckGo Search"]`,
  ].join("\n");
}

test("flight price claims require visible price evidence", () => {
  const userMessage =
    "find the cheapest 1 way flight from Portland to sf on June 23rd";
  const assistantText =
    "Here are the cheapest PDX to SFO flights: Alaska Airlines 6:00 AM nonstop $75.";

  assert.equal(
    shouldBlockUnsupportedFlightPriceAnswer(
      userMessage,
      assistantText,
      [
        "**URL:** https://www.google.com/travel/flights",
        "Where to? Search airports or cities",
        "Departure date",
      ].join("\n"),
    ),
    true,
    "price claims should be blocked when the latest page evidence is only the search form",
  );

  assert.equal(
    shouldBlockUnsupportedFlightPriceAnswer(
      userMessage,
      "The cheapest visible option is Alaska Airlines nonstop at $142.",
      [
        "**URL:** https://www.google.com/travel/flights",
        "Best departing flights",
        "Alaska Airlines PDX to SFO nonstop duration 1 hr 42 min $142",
      ].join("\n"),
    ),
    false,
    "price claims should pass when the latest page evidence includes priced flight rows",
  );
});

test(
  "Codex erases unsupported flight price finals and keeps browsing",
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
          webSearchCall("call_ws", "cheapest one-way flight PDX to SFO June 23"),
        ]);
      }
      if (requestCount === 2) {
        return codexSseResponse([
          {
            type: "response.output_text.delta",
            delta:
              "Here are the cheapest PDX to SFO flights: Alaska Airlines 6:00 AM nonstop $75.",
          },
        ]);
      }
      if (requestCount === 3) {
        return codexSseResponse([readPageCall("call_read")]);
      }
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta:
            "I still need visible priced flight results before I can give prices.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "find the cheapest 1 way flight from Portland to sf on June 23rd",
        [WEB_SEARCH_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (name === "web_search") {
            return searchResultOutput(String(args.query || ""));
          }
          return [
            "**URL:** https://www.google.com/travel/flights",
            "Where to? Search airports or cities",
            "Departure date",
          ].join("\n");
        },
        () => undefined,
      ),
    );

    assert.deepEqual(
      calls.map((call) => call.name),
      ["web_search", "read_page"],
      "the guard should send the model back to browser tools after the unsupported price answer",
    );
    assert.ok(
      chunks.includes("<<erase_prev>>"),
      "unsupported price answer should be erased from the visible transcript",
    );
    assert.equal(
      requestBodies.length,
      4,
      "the loop should continue after the unsupported price final instead of stopping",
    );
    assert.ok(
      JSON.stringify(requestBodies[2]).includes(
        "latest browser/tool evidence does not show visible flight-result rows with prices",
      ),
      "the recovery turn should explain why the price answer was unsupported",
    );
  },
);

test(
  "Codex harness does NOT terminate the loop on a repeated web_search (aligns with Ollama/OpenAI)",
  { timeout: 10_000 },
  async () => {
    // The Codex provider previously had a strike-counter that
    // terminated the loop after 2 repeated web_searches. The
    // OpenAI/Ollama provider (provider-openai.ts) doesn't terminate —
    // it just sends an error back to the model and lets it recover.
    // This test pins the new behavior: the Codex provider no longer
    // terminates on repeated searches.
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
        return codexSseResponse([webSearchCall("call_ws_1", FLIGHT_QUERY)]);
      }
      if (requestCount === 2) {
        // Repeated search — would have been a strike + maybe
        // termination in the old design. Now it's just an
        // informative error to the model.
        return codexSseResponse([webSearchCall("call_ws_2", FLIGHT_QUERY)]);
      }
      if (requestCount === 3) {
        // And again — old design would have terminated here. New
        // design just continues.
        return codexSseResponse([webSearchCall("call_ws_3", FLIGHT_QUERY)]);
      }
      // The model eventually gives up and answers naturally with
      // a normal "I tried" summary — NOT a stall signal. The new
      // recovery logic only nudges on real stalls ("I cannot...",
      // explicit user questions, etc.), so a natural "here is what
      // I found" final answer should pass through without a nudge.
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "I searched three times but could not find a flight in this session. Please try again with a different query.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "find the cheapest flight tomorrow from portland to sfo",
        [WEB_SEARCH_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (name === "web_search") {
            return searchResultOutput(FLIGHT_QUERY);
          }
          return "page snapshot";
        },
        () => undefined,
      ),
    );

    // The first web_search actually executed. The next two were
    // caught by the dedup check before reaching the executor (so
    // calls.length === 1, not 3).
    const webSearchCalls = calls.filter((c) => c.name === "web_search");
    assert.equal(
      webSearchCalls.length,
      1,
      "only the first web_search should actually execute",
    );

    // Two duplicate-suppressed chunk markers (one per suppressed
    // search attempt) — the informative error is still emitted.
    const suppressionChunks = chunks.filter((chunk) =>
      chunk.includes("<<tool:web_search:↻ duplicate suppressed>>"),
    );
    assert.equal(
      suppressionChunks.length,
      2,
      "expected one ↻ duplicate suppressed chunk per suppressed attempt",
    );

    // CRUCIALLY: no task_complete:stopped chunk. The harness no
    // longer terminates the loop on duplicate searches.
    const terminationChunks = chunks.filter((chunk) =>
      chunk.includes("<<task_complete: stopped after"),
    );
    assert.equal(
      terminationChunks.length,
      0,
      "harness must not terminate on duplicate web_searches (align with Ollama/OpenAI)",
    );

    // The loop continued until the model gave a natural final answer.
    // 4 backend calls: 1st search executes, 2nd & 3rd are suppressed
    // errors to the model, 4th is the final answer.
    assert.equal(
      requestBodies.length,
      4,
      "harness should not terminate early on duplicate web_searches",
    );
  },
);

test(
  "Codex harness does NOT terminate the loop on a fabricated clear_overlays (aligns with Ollama/OpenAI)",
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
        return codexSseResponse([clearOverlaysCall("call_co_1")]);
      }
      if (requestCount === 2) {
        return codexSseResponse([clearOverlaysCall("call_co_2")]);
      }
      // Model gives up and answers naturally.
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "Done.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "find a flight",
        [CLEAR_OVERLAYS_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name) => {
          calls.push({ name, args: {} });
          return "No blocking overlays detected";
        },
        () => undefined,
      ),
    );

    // Both clear_overlays calls were suppressed by the dedup check
    // before reaching the executor.
    const clearCalls = calls.filter((c) => c.name === "clear_overlays");
    assert.equal(
      clearCalls.length,
      0,
      "fabricated clear_overlays calls should be suppressed before execution",
    );

    // No termination chunk — the loop continues.
    const terminationChunks = chunks.filter((chunk) =>
      chunk.includes("<<task_complete: stopped after"),
    );
    assert.equal(
      terminationChunks.length,
      0,
      "harness must not terminate on fabricated clear_overlays (align with Ollama/OpenAI)",
    );

    // 3 backend calls: 2 suppressed clear_overlays + 1 final answer.
    assert.equal(requestBodies.length, 3);
  },
);

test(
  "Codex harness does NOT terminate the loop on a repeated failed click (aligns with Ollama/OpenAI)",
  { timeout: 10_000 },
  async () => {
    // The Codex provider previously tracked per-signature failed-click
    // strikes and terminated the loop on the 2nd failure of the same
    // click signature. The OpenAI/Ollama provider just lets the model
    // retry — and now the Codex provider does too. A failed click
    // returns an error string; the model is told to try a different
    // target; if it retries the same target, that's its call, the
    // harness just lets it.
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
        return codexSseResponse([clickCall("call_click_1", 45)]);
      }
      if (requestCount === 2) {
        return codexSseResponse([clickCall("call_click_2", 46)]);
      }
      if (requestCount === 3) {
        // Retry #45 — the strike-counter would have terminated here
        // in the old design.
        return codexSseResponse([clickCall("call_click_3", 45)]);
      }
      // Model eventually gives a final answer.
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "I was unable to click through.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "click the cheapest flight result",
        [CLICK_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name) => {
          calls.push({ name, args: {} });
          return "Clicked: result link\nNote: Page did not change after click.";
        },
        () => undefined,
      ),
    );

    // All three clicks actually executed (the harness doesn't suppress
    // failed clicks for execution — the tool runs and returns an error,
    // which is sent back to the model).
    const clickCalls = calls.filter((c) => c.name === "click");
    assert.equal(
      clickCalls.length,
      3,
      "all three click attempts should execute and return an error",
    );

    // No termination chunk — the loop continues even on repeated
    // failed clicks of the same target.
    const terminationChunks = chunks.filter((chunk) =>
      chunk.includes("<<task_complete: stopped after"),
    );
    assert.equal(
      terminationChunks.length,
      0,
      "harness must not terminate on repeated failed clicks (align with Ollama/OpenAI)",
    );

    // 4 backend calls: 3 click attempts + 1 final answer.
    assert.equal(
      requestBodies.length,
      4,
      "harness should not terminate early on repeated failed clicks",
    );
  },
);

test(
  "Codex harness does NOT terminate on a drifted web_search with a single strike (aligns with Ollama/OpenAI)",
  { timeout: 10_000 },
  async () => {
    // The previous "drift" check would terminate on the 2nd drifted
    // strike. Now the harness just emits an informative error and
    // continues, matching Ollama/OpenAI behavior.
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;

      if (requestCount === 1) {
        return codexSseResponse([webSearchCall("call_ws_1", FLIGHT_QUERY)]);
      }
      if (requestCount === 2) {
        // Distinct query — drift check would have flagged this in the
        // old design. Now it's an informative error.
        return codexSseResponse([
          webSearchCall("call_ws_2", "different flight query"),
        ]);
      }
      if (requestCount === 3) {
        return codexSseResponse([
          webSearchCall("call_ws_3", "yet another query"),
        ]);
      }
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "Done.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "find a flight",
        [WEB_SEARCH_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name) => {
          if (name === "web_search") {
            return searchResultOutput("query");
          }
          return "page snapshot";
        },
        () => undefined,
      ),
    );

    // No termination chunk.
    const terminationChunks = chunks.filter((chunk) =>
      chunk.includes("<<task_complete: stopped after"),
    );
    assert.equal(
      terminationChunks.length,
      0,
      "harness must not terminate on drifted web_searches (align with Ollama/OpenAI)",
    );

    // 4 backend calls: 1st executes, 2nd & 3rd are drift errors,
    // 4th is the model's natural final answer.
    assert.equal(requestBodies.length, 4);
  },
);

test(
  "Codex harness does NOT suppress consecutive read_page calls (aligns with Ollama/OpenAI)",
  { timeout: 10_000 },
  async () => {
    // The previous Codex provider suppressed read_page when called with
    // the same signature 2+ times in a row. The user's transcript
    // showed the model flailing through read_page → read_page →
    // read_page (suppressed!) → web_search (suppressed!) → navigate
    // (suppressed!) → ... because the dedup messages were pushing
    // the model away from its natural tool choices. The OpenAI/Ollama
    // provider never suppresses read_page this way — a model can read
    // the page as many times as it needs to. This test pins that
    // behavior.
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
        return codexSseResponse([readPageCall("call_read_2")]);
      }
      if (requestCount === 3) {
        return codexSseResponse([readPageCall("call_read_3")]);
      }
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "I have enough context now.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "look at the current page",
        [WEB_SEARCH_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name) => {
          calls.push({ name, args: {} });
          return "Page snapshot with 10 results.";
        },
        () => undefined,
      ),
    );

    // All 3 read_page calls actually executed. None were suppressed
    // by the harness.
    const readPageCalls = calls.filter((c) => c.name === "read_page");
    assert.equal(
      readPageCalls.length,
      3,
      "all 3 read_page calls should execute (Ollama-style, no signature dedup)",
    );

    // No read_page suppression chunks.
    const readPageSuppressionChunks = chunks.filter((chunk) =>
      chunk.includes("<<tool:read_page:↻ duplicate suppressed>>"),
    );
    assert.equal(
      readPageSuppressionChunks.length,
      0,
      "harness must not suppress read_page as a consecutive duplicate (align with Ollama)",
    );

    // No termination chunk.
    const terminationChunks = chunks.filter((chunk) =>
      chunk.includes("<<task_complete: stopped after"),
    );
    assert.equal(
      terminationChunks.length,
      0,
      "no dedup-strike termination should fire on read_page loops",
    );
  },
);

test(
  "Codex harness does not force-call highlight when the user asks for highlighting (aligns with Ollama/OpenAI)",
  { timeout: 10_000 },
  async () => {
    // The previous Codex provider detected "highlight" in the user
    // prompt and tried to FORCE the model to call highlight by
    // suppressing other tools after 2 read_pages. The OpenAI/Ollama
    // provider doesn't do this — the model decides when to call
    // highlight. If the model doesn't, that's a model problem, not a
    // harness problem. This test pins the new behavior: the harness
    // doesn't force highlight, but it doesn't suppress highlight
    // either — the model is free to call or not call highlight.
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
        return codexSseResponse([readPageCall("call_read_2")]);
      }
      if (requestCount === 3) {
        return codexSseResponse([readPageCall("call_read_3")]);
      }
      // Model gives a natural final answer without calling highlight.
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "Done.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "highlight the news.ycombinator.com top stories",
        [
          {
            name: "read_page",
            description: "Read current page",
            input_schema: { type: "object", properties: {} },
          },
          {
            name: "highlight",
            description: "Highlight page content",
            input_schema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
        ],
        (chunk) => chunks.push(chunk),
        async (name) => {
          calls.push({ name, args: {} });
          return "Page snapshot";
        },
        () => undefined,
      ),
    );

    // All 3 read_page calls executed. NONE were suppressed by the
    // highlight-budget check. The harness didn't force a highlight
    // call on the model's behalf either (calls.filter('highlight')
    // would be empty because the model didn't call it).
    const readPageCalls = calls.filter((c) => c.name === "read_page");
    assert.equal(
      readPageCalls.length,
      3,
      "all 3 read_page calls should execute; the highlight-budget check must not fire",
    );

    // No highlight-budget suppression chunks.
    const highlightSuppressionChunks = chunks.filter((chunk) =>
      chunk.includes("highlight task"),
    );
    assert.equal(
      highlightSuppressionChunks.length,
      0,
      "harness must not push the highlight-budget error message (align with Ollama)",
    );

    // The model wasn't forced to call highlight — it was free to
    // decide. (calls.length === 3 means 3 read_page tool calls
    // executed, and highlight is not in the list because the model
    // didn't call it in this scripted scenario. That's expected.)
  },
);
