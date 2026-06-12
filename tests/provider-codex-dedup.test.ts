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

const ALL_TOOLS = [WEB_SEARCH_TOOL, READ_PAGE_TOOL];

const FLIGHT_QUERY = "cheapest flight tomorrow from Portland to San Francisco";
const FLIGHT_SEARCH_URL = `https://duckduckgo.com/?q=${encodeURIComponent(FLIGHT_QUERY)}`;

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

test(
  "Codex harness terminates the search loop on the second duplicate strike",
  { timeout: 10_000 },
  async () => {
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchLog: Array<{ url: string; body: string }> = [];

    await withMockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = String(init?.body ?? "{}");
      fetchLog.push({ url, body });
      requestBodies.push(JSON.parse(body) as Record<string, unknown>);
      const requestCount = requestBodies.length;

      // Turn 1: model issues the first web_search.
      if (requestCount === 1) {
        return codexSseResponse([webSearchCall("call_search_1", FLIGHT_QUERY)]);
      }
      // Turn 2: model repeats the same web_search (first strike — harness
      // emits the actionable error and asks the model once more).
      if (requestCount === 2) {
        return codexSseResponse([webSearchCall("call_search_2", FLIGHT_QUERY)]);
      }
      // Turn 3: model repeats AGAIN (second strike — harness should
      // terminate after this turn, NOT make a 4th backend call).
      if (requestCount === 3) {
        return codexSseResponse([webSearchCall("call_search_3", FLIGHT_QUERY)]);
      }
      // If the harness asks for a 4th turn, the model is no longer
      // listening to the dedup error and the test fails.
      return codexSseResponse([
        { type: "response.output_text.delta", delta: "unexpected fourth turn" },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "can you help me find the cheapest flight for tomorrow from portland to san francisco?",
        [...ALL_TOOLS],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          return [
            `Web searched "${FLIGHT_QUERY}" via default search engine → ${FLIGHT_SEARCH_URL}`,
            `[state: url=${FLIGHT_SEARCH_URL}, title="DuckDuckGo Search"]`,
          ].join("\n");
        },
        () => undefined,
      ),
    );

    // The tool was actually executed exactly once.
    assert.deepEqual(calls, [
      { name: "web_search", args: { query: FLIGHT_QUERY } },
    ]);

    // Three backend calls: turn 1 executes web_search; turn 2 is the model's
    // first duplicate which we suppress with an actionable error; turn 3 is
    // the model's second duplicate which triggers termination before the
    // backend would normally be called a 4th time. The model has to be told
    // once it's stuck before we cut the loop — that's the contract.
    assert.equal(
      requestBodies.length,
      3,
      "harness must terminate after the second strike without making a fourth backend call",
    );

    // Both duplicate-suppressed chunk markers were emitted (once per strike).
    const suppressionChunks = chunks.filter((chunk) =>
      chunk.includes("<<tool:web_search:↻ duplicate suppressed>>"),
    );
    assert.equal(
      suppressionChunks.length,
      2,
      "expected one ↻ duplicate suppressed chunk per strike",
    );

    // The harness emits a task_complete marker so the UI can show why it
    // stopped.
    assert.equal(
      chunks.some((chunk) =>
        chunk.includes("<<task_complete: stopped after duplicate search"),
      ),
      true,
      "expected a <<task_complete: stopped after duplicate search>> chunk",
    );
    assert.equal(
      chunks.some((chunk) =>
        chunk.includes(`stopped after duplicate search`) &&
        chunk.includes(` on ${FLIGHT_SEARCH_URL}`),
      ),
      true,
      "expected the termination chunk to include the latest search-result URL",
    );

    // The actionable error message made it into the third backend request
    // (turn 2 was the first strike, the model was told once to recover, the
    // third request contains that actionable error). We assert on the
    // previous-query string + the "already searched" phrasing — both are
    // part of buildCodexRepeatedSearchError.
    assert.match(
      JSON.stringify(requestBodies[2]?.input ?? []),
      /already searched for/,
      "third-turn input should include the new actionable error",
    );
    assert.match(
      JSON.stringify(requestBodies[2]?.input ?? []),
      new RegExp(FLIGHT_QUERY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "third-turn input should name the original query verbatim",
    );
  },
);

test(
  "Codex harness terminates the cross-tool search loop (web_search → search → web_search)",
  { timeout: 10_000 },
  async () => {
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    let requestCount = 0;

    const SITE_SEARCH_TOOL = {
      name: "search",
      description: "Search within current site",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    } as const;

    await withMockFetch(async (_input, init) => {
      requestCount += 1;
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      if (requestCount === 1) {
        return codexSseResponse([
          webSearchCall("call_ws_1", FLIGHT_QUERY),
        ]);
      }
      if (requestCount === 2) {
        // Model switches to the *other* search tool with the same query —
        // first strike, harness should name the previous tool.
        return codexSseResponse([
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_site_1",
              name: "search",
              arguments: JSON.stringify({ query: FLIGHT_QUERY }),
            },
          },
        ]);
      }
      if (requestCount === 3) {
        // Model gives up and goes back to web_search — second strike.
        return codexSseResponse([
          webSearchCall("call_ws_2", FLIGHT_QUERY),
        ]);
      }
      // If the harness asks for a fourth turn, the model is no longer
      // listening to the dedup error.
      return codexSseResponse([
        { type: "response.output_text.delta", delta: "unexpected 4th turn" },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "can you help me find the cheapest flight for tomorrow from portland to san francisco?",
        [WEB_SEARCH_TOOL, SITE_SEARCH_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          return [
            `Web searched "${FLIGHT_QUERY}" via default search engine → ${FLIGHT_SEARCH_URL}`,
            `[state: url=${FLIGHT_SEARCH_URL}, title="DuckDuckGo Search"]`,
          ].join("\n");
        },
        () => undefined,
      ),
    );

    // The web_search executed once. The "search" attempt was blocked by the
    // cross-tool dedup, and the third strike (web_search again) caused
    // termination.
    assert.equal(
      calls.length,
      1,
      "only the first web_search should actually execute",
    );
    assert.equal(calls[0]?.name, "web_search");

    // Three backend calls: turn 1 executes web_search; turn 2 is the model's
    // first duplicate (via the "search" tool) which we suppress with an
    // actionable error; turn 3 is the model's second duplicate (back to
    // web_search) which triggers termination. The harness does not ask the
    // backend for a 4th turn.
    assert.equal(requestBodies.length, 3);

    // Both suppression markers appeared.
    const suppressionChunks = chunks.filter((chunk) =>
      chunk.includes("↻ duplicate suppressed"),
    );
    assert.equal(suppressionChunks.length, 2);

    // Termination chunk was emitted.
    assert.equal(
      chunks.some((chunk) =>
        chunk.includes("<<task_complete: stopped after duplicate search"),
      ),
      true,
    );
    assert.equal(
      chunks.some((chunk) =>
        chunk.includes(`stopped after duplicate search`) &&
        chunk.includes(` on ${FLIGHT_SEARCH_URL}`),
      ),
      true,
      "expected the termination chunk to include the latest search-result URL",
    );

    // The actionable error on turn 2 (the search blocked by
    // isRepeatedSearchAcrossTools) should name the previous tool
    // (web_search) and the query verbatim. requestBodies[2] is the body
    // sent to the backend after turn 2 was suppressed; requestBodies[1]
    // is the successful turn-1 result.
    assert.match(
      JSON.stringify(requestBodies[2]?.input ?? []),
      /web_search/,
      "third-turn input should reference the previous web_search",
    );
    assert.match(
      JSON.stringify(requestBodies[2]?.input ?? []),
      /Do not call any search tool again/,
      "third-turn input should be the new actionable version",
    );
    // The actionable error must NOT list read_page as a suggested next
    // step — the model was using read_page as a no-op to "reset" and try
    // another web_search. The error should steer the model toward
    // acting on the existing results instead.
    assert.doesNotMatch(
      JSON.stringify(requestBodies[2]?.input ?? []),
      /read_page, inspect_element, click/,
      "third-turn error should not suggest read_page as a recovery action",
    );
    // The error should explicitly suggest click + highlight + final answer
    // — the model has results, it should act on them.
    assert.match(
      JSON.stringify(requestBodies[2]?.input ?? []),
      /click a result link/,
      "third-turn error should suggest clicking a result",
    );
    assert.match(
      JSON.stringify(requestBodies[2]?.input ?? []),
      /provide the final answer/,
      "third-turn error should remind the model it can answer the user",
    );
  },
);
