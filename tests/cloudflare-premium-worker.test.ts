import assert from "node:assert/strict";
import test from "node:test";

import worker from "../scripts/cloudflare-worker/vessel-premium-api.js";

const STRIPE_API = "https://api.stripe.com/v1";
const WORKER_URL = "https://premium.example";
const nowSeconds = () => Math.floor(Date.now() / 1000);

type MockFetchHandler = (
  url: string,
  init?: RequestInit,
) => unknown | Promise<unknown>;

const env = {
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_ID: "price_test",
  PREMIUM_TOKEN_SECRET: "test-secret",
  RESEND_API_KEY: "re_test",
  PREMIUM_FROM_EMAIL: "Vessel <premium@example.com>",
  FEEDBACK_TO_EMAIL: "hello@quantaintellect.com",
};

function createMemoryKv(): {
  get: (key: string) => Promise<string | null>;
  put: (
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ) => Promise<void>;
} {
  const store = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withMockFetch<T>(
  handler: MockFetchHandler,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input.toString();
    const result = await handler(rawUrl, init);
    return result instanceof Response ? result : jsonResponse(result);
  }) as typeof fetch;

  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${WORKER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function postJsonWithEnv(
  path: string,
  body: unknown,
  envOverrides: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker.fetch(
    new Request(`${WORKER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { ...env, ...envOverrides },
  );
}

async function createPremiumToken(customerId = "cus_test"): Promise<string> {
  return withMockFetch(
    (url) => {
      if (url === `${STRIPE_API}/checkout/sessions/cs_test`) {
        return { customer: customerId, subscription: "sub_trial" };
      }
      if (url === `${STRIPE_API}/subscriptions/sub_trial`) {
        return {
          id: "sub_trial",
          status: "trialing",
          trial_end: nowSeconds() + 7 * 24 * 60 * 60,
          current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
        };
      }
      if (url === `${STRIPE_API}/customers/${customerId}`) {
        return { id: customerId, email: "premium@example.com" };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const response = await postJson("/verify", { identifier: "cs_test" });
      const data = await response.json() as { verificationToken?: string };
      assert.equal(response.status, 200);
      assert.equal(typeof data.verificationToken, "string");
      return data.verificationToken!;
    },
  );
}

test("premium worker verifies checkout sessions using the exact session subscription", async () => {
  await withMockFetch(
    (url) => {
      if (url === `${STRIPE_API}/checkout/sessions/cs_test`) {
        return { customer: "cus_test", subscription: "sub_trial" };
      }
      if (url === `${STRIPE_API}/subscriptions/sub_trial`) {
        return {
          id: "sub_trial",
          status: "trialing",
          trial_end: nowSeconds() + 7 * 24 * 60 * 60,
          current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
        };
      }
      if (url === `${STRIPE_API}/customers/cus_test`) {
        return { id: "cus_test", email: "premium@example.com" };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const response = await postJson("/verify", { identifier: "cs_test" });
      const data = await response.json() as {
        status?: string;
        customerId?: string;
        verificationToken?: string;
        email?: string;
      };

      assert.equal(response.status, 200);
      assert.equal(data.status, "trialing");
      assert.equal(data.customerId, "cus_test");
      assert.equal(data.email, "premium@example.com");
      assert.match(data.verificationToken || "", /^[^.]+\.[^.]+\.[^.]+$/);
    },
  );
});

test("premium worker prefers an entitled subscription over a newer canceled subscription", async () => {
  const token = await createPremiumToken();

  await withMockFetch(
    (url) => {
      if (url === `${STRIPE_API}/customers/cus_test`) {
        return { id: "cus_test", email: "premium@example.com" };
      }
      if (url === `${STRIPE_API}/subscriptions?customer=cus_test&status=all&limit=10`) {
        return {
          data: [
            {
              id: "sub_canceled",
              status: "canceled",
              created: nowSeconds(),
              current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
            },
            {
              id: "sub_active",
              status: "active",
              created: nowSeconds() - 60,
              current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
            },
          ],
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const response = await postJson("/verify", { identifier: token });
      const data = await response.json() as { status?: string };

      assert.equal(response.status, 200);
      assert.equal(data.status, "active");
    },
  );
});

test("premium worker creates billing portal sessions only for signed premium tokens", async () => {
  const invalidResponse = await postJson("/portal", { identifier: "not-a-token" });
  assert.equal(invalidResponse.status, 403);

  const token = await createPremiumToken("cus_portal");
  let portalRequestBody = "";

  await withMockFetch(
    (_url, init) => {
      assert.equal(_url, `${STRIPE_API}/billing_portal/sessions`);
      portalRequestBody = String(init?.body || "");
      return { url: "https://billing.stripe.test/session" };
    },
    async () => {
      const response = await postJson("/portal", { identifier: token });
      const data = await response.json() as { url?: string };

      assert.equal(response.status, 200);
      assert.equal(data.url, "https://billing.stripe.test/session");
      assert.match(portalRequestBody, /customer=cus_portal/);
      assert.match(
        portalRequestBody,
        /return_url=https%3A%2F%2Fpremium\.example%2Fportal-return/,
      );
    },
  );
});

test("premium worker sends feedback email through Resend", async () => {
  let resendRequestBody = "";

  await withMockFetch(
    (url, init) => {
      assert.equal(url, "https://api.resend.com/emails");
      resendRequestBody = String(init?.body || "");
      return { id: "email_test" };
    },
    async () => {
      const response = await postJson("/feedback", {
        email: "User@Example.com",
        message: "This is useful, but I found a paper cut.",
        source: "settings_account",
      });
      const data = await response.json() as { ok?: boolean };

      assert.equal(response.status, 200);
      assert.equal(data.ok, true);
      assert.match(resendRequestBody, /hello@quantaintellect\.com/);
      assert.match(resendRequestBody, /user@example\.com/);
      assert.match(resendRequestBody, /settings_account/);
      assert.match(resendRequestBody, /paper cut/);
    },
  );
});

test("premium worker validates feedback payloads before sending email", async () => {
  await withMockFetch(
    () => {
      throw new Error("Feedback validation should not call Resend");
    },
    async () => {
      const response = await postJson("/feedback", {
        email: "not-an-email",
        message: "hello",
      });
      const data = await response.json() as { error?: string };

      assert.equal(response.status, 400);
      assert.match(data.error || "", /valid reply email/i);
    },
  );
});

test("premium worker rate limits feedback before sending email", async () => {
  const kv = createMemoryKv();
  let resendCalls = 0;

  await withMockFetch(
    (url) => {
      assert.equal(url, "https://api.resend.com/emails");
      resendCalls += 1;
      return { id: `email_${resendCalls}` };
    },
    async () => {
      for (let i = 0; i < 5; i++) {
        const response = await postJsonWithEnv(
          "/feedback",
          {
            email: "user@example.com",
            message: `Feedback message ${i}`,
          },
          { ACTIVATION_KV: kv },
          { "cf-connecting-ip": "203.0.113.10" },
        );
        assert.equal(response.status, 200);
      }

      const limitedResponse = await postJsonWithEnv(
        "/feedback",
        {
          email: "user@example.com",
          message: "One too many",
        },
        { ACTIVATION_KV: kv },
        { "cf-connecting-ip": "203.0.113.10" },
      );
      const data = await limitedResponse.json() as { error?: string };

      assert.equal(limitedResponse.status, 429);
      assert.match(data.error || "", /too many feedback/i);
      assert.equal(resendCalls, 5);
    },
  );
});

test("premium worker sends feedback when spam guard storage fails", async () => {
  let resendCalls = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  const failingKv = {
    async get(): Promise<string | null> {
      throw new Error("kv unavailable");
    },
    async put(): Promise<void> {
      throw new Error("kv unavailable");
    },
  };

  try {
    await withMockFetch(
      (url) => {
        assert.equal(url, "https://api.resend.com/emails");
        resendCalls += 1;
        return { id: "email_test" };
      },
      async () => {
        const response = await postJsonWithEnv(
          "/feedback",
          {
            email: "user@example.com",
            message: "Please keep the feedback path available.",
          },
          { ACTIVATION_KV: failingKv },
          { "cf-connecting-ip": "203.0.113.10" },
        );
        const data = await response.json() as { ok?: boolean };

        assert.equal(response.status, 200);
        assert.equal(data.ok, true);
        assert.equal(resendCalls, 1);
      },
    );
  } finally {
    console.warn = originalWarn;
  }
});
