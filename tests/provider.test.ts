import assert from "node:assert/strict";
import test from "node:test";

import type { CodexOAuthTokens } from "../src/shared/types";
import {
  buildLlamaCppCtxWarning,
  extractLlamaCppCtxSize,
  fetchProviderModels,
} from "../src/main/ai/provider";
import {
  buildOpenAIRepeatedSearchError,
  buildOpenRouterAttributionHeaders,
  formatOpenAICompatErrorMessage,
  isOpenAIRealProgressToolForSearch,
} from "../src/main/ai/provider-openai";
import { refreshAccessToken } from "../src/main/ai/codex-oauth";
import {
  clearStoredCodexTokens,
  readStoredCodexTokens,
  writeStoredCodexTokens,
} from "../src/main/config/settings";

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

function makeCodexTokens(overrides: Partial<CodexOAuthTokens> = {}): CodexOAuthTokens {
  return {
    accessToken: "old-access-token",
    refreshToken: "refresh-token",
    idToken: "",
    expiresAt: Date.now() + 60 * 60 * 1000,
    accountId: "account-123",
    accountEmail: "codex@example.com",
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("extractLlamaCppCtxSize finds n_ctx in nested llama-server props", () => {
  const ctxSize = extractLlamaCppCtxSize({
    default_generation_settings: {
      n_ctx: 8192,
    },
  });

  assert.equal(ctxSize, 8192);
});

test("extractLlamaCppCtxSize accepts ctx_size aliases", () => {
  const ctxSize = extractLlamaCppCtxSize({
    server: {
      ctx_size: 32768,
    },
  });

  assert.equal(ctxSize, 32768);
});

test("buildLlamaCppCtxWarning warns when ctx size is missing", () => {
  const warning = buildLlamaCppCtxWarning(null);

  assert.match(warning ?? "", /Could not detect llama-server context size/i);
  assert.match(warning ?? "", /--ctx-size 16384 minimum/i);
});

test("buildLlamaCppCtxWarning warns when ctx size is below Vessel minimum", () => {
  const warning = buildLlamaCppCtxWarning(8192);

  assert.match(warning ?? "", /ctx-size 8192/i);
  assert.match(warning ?? "", /too small for reliable Vessel agent loops/i);
  assert.match(warning ?? "", /32768 recommended/i);
});

test("buildLlamaCppCtxWarning recommends more headroom for mid-sized ctx", () => {
  const warning = buildLlamaCppCtxWarning(16384);

  assert.match(warning ?? "", /Detected llama-server ctx-size 16384/i);
  assert.match(warning ?? "", /32768 is recommended/i);
});

test("buildLlamaCppCtxWarning is quiet when ctx size is already healthy", () => {
  assert.equal(buildLlamaCppCtxWarning(32768), undefined);
});

test("buildOpenRouterAttributionHeaders matches OpenRouter app attribution", () => {
  assert.deepEqual(buildOpenRouterAttributionHeaders(), {
    "HTTP-Referer": "https://github.com/unmodeled-tyler/vessel-browser",
    "X-OpenRouter-Title": "Vessel Browser",
    "X-OpenRouter-Categories": "personal-agent,general-chat",
  });
  assert.equal("X-Title" in buildOpenRouterAttributionHeaders(), false);
});

test("formatOpenAICompatErrorMessage explains OpenRouter timeout/no-content failures", () => {
  const message = formatOpenAICompatErrorMessage(
    "openrouter",
    "Agent failed (Function processsingleitem_agent timed out after 90.0 seconds), API failed (API request returned None after all retries)",
  );

  assert.match(
    message,
    /OpenRouter reported an upstream model timeout\/no-content failure/,
  );
  assert.match(message, /pin a specific low-latency tool-calling model/);
});

test("formatOpenAICompatErrorMessage leaves non-OpenRouter timeout text unchanged", () => {
  const raw = "API request returned None after all retries";

  assert.equal(formatOpenAICompatErrorMessage("openai", raw), raw);
});

test("buildOpenAIRepeatedSearchError steers venue lookups toward direct results", () => {
  const message = buildOpenAIRepeatedSearchError(
    "web_search",
    "moreland theater portland oregon movie playing this tuesday",
    'Web searched "Moreland Theater Portland Oregon movie playing this Tuesday" via DuckDuckGo → https://duckduckgo.com/?q=moreland+theater [state: url=https://duckduckgo.com/?q=moreland+theater, title="DuckDuckGo Search"]',
    "drifted",
  );

  assert.match(message, /use the current search results instead/i);
  assert.match(message, /prefer opening the official site or clearly direct result/i);
  assert.match(message, /Do not switch to a site: restricted web_search/i);
  assert.match(message, /Do not call any search tool again as preparation/i);
});

test("OpenAI search-loop guard preserves anchors across overlay cleanup", () => {
  assert.equal(isOpenAIRealProgressToolForSearch("clear_overlays"), false);
  assert.equal(isOpenAIRealProgressToolForSearch("accept_cookies"), false);
  assert.equal(isOpenAIRealProgressToolForSearch("dismiss_popup"), false);
  assert.equal(isOpenAIRealProgressToolForSearch("read_page"), false);
  assert.equal(isOpenAIRealProgressToolForSearch("click"), true);
  assert.equal(isOpenAIRealProgressToolForSearch("navigate"), true);
});

test("fetchProviderModels refreshes expired Codex tokens before model discovery", async () => {
  clearStoredCodexTokens();
  writeStoredCodexTokens(makeCodexTokens({ expiresAt: Date.now() - 1000 }));
  const modelAuthHeaders: string[] = [];

  try {
    const result = await withMockFetch(async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return jsonResponse({
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
          expires_in: 3600,
        });
      }
      if (url.includes("/backend-api/codex/models")) {
        modelAuthHeaders.push(
          String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""),
        );
        return jsonResponse({
          models: [{ slug: "gpt-5" }, { id: "hidden-model", visibility: "hidden" }],
        });
      }
      return jsonResponse({}, 404);
    }, () =>
      fetchProviderModels({
        id: "openai_codex",
        apiKey: "",
        model: "",
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ["gpt-5"]);
    assert.deepEqual(modelAuthHeaders, ["Bearer fresh-access-token"]);
    assert.equal(readStoredCodexTokens()?.accessToken, "fresh-access-token");
  } finally {
    clearStoredCodexTokens();
  }
});

test("fetchProviderModels retries Codex model discovery once after a 401", async () => {
  clearStoredCodexTokens();
  writeStoredCodexTokens(makeCodexTokens());
  const modelAuthHeaders: string[] = [];

  try {
    const result = await withMockFetch(async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return jsonResponse({ access_token: "retry-access-token", expires_in: 3600 });
      }
      if (url.includes("/backend-api/codex/models")) {
        const authorization = String(
          (init?.headers as Record<string, string> | undefined)?.Authorization ?? "",
        );
        modelAuthHeaders.push(authorization);
        if (authorization === "Bearer old-access-token") {
          return jsonResponse({ error: "expired" }, 401);
        }
        return jsonResponse({ models: [{ model: "gpt-5-mini" }] });
      }
      return jsonResponse({}, 404);
    }, () =>
      fetchProviderModels({
        id: "openai_codex",
        apiKey: "",
        model: "",
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ["gpt-5-mini"]);
    assert.deepEqual(modelAuthHeaders, [
      "Bearer old-access-token",
      "Bearer retry-access-token",
    ]);
    assert.equal(readStoredCodexTokens()?.accessToken, "retry-access-token");
  } finally {
    clearStoredCodexTokens();
  }
});

test("refreshAccessToken uses OAuth expires_in for refreshed token expiry", async () => {
  const before = Date.now();

  const refreshed = await withMockFetch((input) => {
    const url = String(input);
    if (url.includes("/oauth/token")) {
      return jsonResponse({
        access_token: "opaque-refreshed-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 7200,
      });
    }
    return jsonResponse({}, 404);
  }, () => refreshAccessToken(makeCodexTokens({ expiresAt: Date.now() - 1000 })));

  assert.equal(refreshed.accessToken, "opaque-refreshed-access-token");
  assert.equal(refreshed.refreshToken, "new-refresh-token");
  assert.ok(refreshed.expiresAt >= before + 7199_000);
  assert.ok(refreshed.expiresAt <= Date.now() + 7201_000);
});
