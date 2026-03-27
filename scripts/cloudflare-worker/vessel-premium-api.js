/**
 * Vessel Premium API — Cloudflare Worker
 *
 * Handles Stripe Checkout, Customer Portal, subscription verification,
 * and webhooks for the Vessel browser premium subscription.
 *
 * Environment variables (set in Cloudflare dashboard as encrypted secrets):
 *   STRIPE_SECRET_KEY    — sk_test_... or sk_live_...
 *   STRIPE_WEBHOOK_SECRET — whsec_...
 *   STRIPE_PRICE_ID      — price_...
 */

const STRIPE_API = "https://api.stripe.com/v1";

// --- Stripe helpers ---

async function stripeRequest(env, method, path, body) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  return res.json();
}

async function findCustomerByEmail(env, email) {
  const data = await stripeRequest(env, "GET", `/customers?email=${encodeURIComponent(email)}&limit=1`);
  return data.data?.[0] || null;
}

async function getSubscription(env, customerId) {
  const data = await stripeRequest(env, "GET", `/subscriptions?customer=${customerId}&status=all&limit=1`);
  return data.data?.[0] || null;
}

function subscriptionToStatus(sub) {
  if (!sub) return "free";
  switch (sub.status) {
    case "active":
    case "trialing":
      return sub.status;
    case "past_due":
      return "past_due";
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
      return "canceled";
    default:
      return "free";
  }
}

// --- CORS ---

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function corsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// --- Webhook signature verification ---

async function verifyWebhookSignature(payload, sigHeader, secret) {
  const parts = {};
  for (const item of sigHeader.split(",")) {
    const [key, value] = item.split("=");
    if (key === "t") parts.t = value;
    if (key === "v1" && !parts.v1) parts.v1 = value;
  }
  if (!parts.t || !parts.v1) return false;

  const signedPayload = `${parts.t}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Timing-safe compare
  if (expected.length !== parts.v1.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  }
  return mismatch === 0;
}

// --- Route handlers ---

async function handleCheckout(request, env) {
  const url = new URL(request.url);
  const email = url.searchParams.get("email") || undefined;

  const params = {
    mode: "subscription",
    "line_items[0][price]": env.STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    success_url: `${url.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/canceled`,
    "subscription_data[trial_period_days]": "5",
  };
  if (email) {
    params.customer_email = email;
  }

  const session = await stripeRequest(env, "POST", "/checkout/sessions", params);

  if (session.error) {
    return corsResponse({ error: session.error.message }, 400);
  }

  // GET requests (e.g. clicking a link on the website) get a redirect;
  // POST requests (e.g. from the Vessel app) get JSON.
  if (request.method === "GET") {
    return new Response(null, {
      status: 302,
      headers: { Location: session.url, ...CORS_HEADERS },
    });
  }

  return corsResponse({ url: session.url });
}

async function handlePortal(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse({ error: "Invalid JSON body" }, 400);
  }

  const customerId = body.customerId;
  if (!customerId) {
    return corsResponse({ error: "customerId is required" }, 400);
  }

  const url = new URL(request.url);
  const session = await stripeRequest(env, "POST", "/billing_portal/sessions", {
    customer: customerId,
    return_url: `${url.origin}/portal-return`,
  });

  if (session.error) {
    return corsResponse({ error: session.error.message }, 400);
  }

  return corsResponse({ url: session.url });
}

async function handleVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse({ error: "Invalid JSON body" }, 400);
  }

  const identifier = body.identifier;
  if (!identifier) {
    return corsResponse({ error: "identifier (email or customerId) is required" }, 400);
  }

  let customer;
  if (identifier.startsWith("cus_")) {
    customer = await stripeRequest(env, "GET", `/customers/${identifier}`);
    if (customer.error) {
      return corsResponse({ status: "free", customerId: "", email: "", expiresAt: "" });
    }
  } else {
    customer = await findCustomerByEmail(env, identifier);
    if (!customer) {
      return corsResponse({ status: "free", customerId: "", email: identifier, expiresAt: "" });
    }
  }

  const subscription = await getSubscription(env, customer.id);
  const status = subscriptionToStatus(subscription);

  return corsResponse({
    status,
    customerId: customer.id,
    email: customer.email || "",
    expiresAt: subscription?.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : "",
  });
}

async function handleWebhook(request, env) {
  const payload = await request.text();
  const sigHeader = request.headers.get("stripe-signature");

  if (!sigHeader) {
    return new Response("Missing signature", { status: 400 });
  }

  const valid = await verifyWebhookSignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return new Response("Invalid signature", { status: 400 });
  }

  // We don't need to do anything with the webhook events right now —
  // Vessel verifies subscription status on-demand via /verify.
  // The webhook is here for future use (e.g., sending welcome emails,
  // revoking access immediately on cancellation, analytics).
  const event = JSON.parse(payload);
  console.log(`[Vessel Webhook] ${event.type}: ${event.data?.object?.id || "unknown"}`);

  return new Response("OK", { status: 200 });
}

function handleSuccess(request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Vessel Premium — Activated!</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0e; color: #e4e4e7; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { text-align: center; max-width: 480px; padding: 48px; }
    h1 { color: #f0c636; font-size: 28px; margin-bottom: 16px; }
    p { color: #a1a1aa; line-height: 1.6; font-size: 16px; }
    .steps { text-align: left; margin-top: 24px; background: #18181b; border-radius: 8px; padding: 24px; }
    .steps li { margin-bottom: 12px; color: #d4d4d8; }
    code { background: #27272a; padding: 2px 6px; border-radius: 4px; color: #f0c636; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Welcome to Vessel Premium!</h1>
    <p>Your subscription is active. Now activate it in the browser:</p>
    <ol class="steps">
      <li>Open <strong>Vessel</strong></li>
      <li>Go to <strong>Settings</strong> (Ctrl+,)</li>
      <li>Scroll to the <strong>Premium</strong> section</li>
      <li>Enter the <strong>email</strong> you just used to subscribe</li>
      <li>Click <strong>Activate</strong></li>
    </ol>
    <p>That's it — all premium features are now unlocked.</p>
  </div>
</body>
</html>`,
    { status: 200, headers: { "Content-Type": "text/html" } },
  );
}

function handleCanceled() {
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Checkout Canceled</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0e; color: #e4e4e7; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { text-align: center; max-width: 400px; padding: 48px; }
    h1 { font-size: 24px; margin-bottom: 16px; }
    p { color: #a1a1aa; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Checkout canceled</h1>
    <p>No worries — you can upgrade to Vessel Premium anytime from Settings in the browser.</p>
  </div>
</body>
</html>`,
    { status: 200, headers: { "Content-Type": "text/html" } },
  );
}

// --- Main router ---

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/checkout" && (request.method === "GET" || request.method === "POST")) {
        return handleCheckout(request, env);
      }
      if (path === "/portal" && request.method === "POST") {
        return handlePortal(request, env);
      }
      if (path === "/verify" && request.method === "POST") {
        return handleVerify(request, env);
      }
      if (path === "/webhook" && request.method === "POST") {
        return handleWebhook(request, env);
      }
      if (path === "/success") {
        return handleSuccess(request);
      }
      if (path === "/canceled") {
        return handleCanceled();
      }
      if (path === "/portal-return") {
        return new Response("You can close this tab and return to Vessel.", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("[Vessel Premium API]", err);
      return corsResponse({ error: "Internal server error" }, 500);
    }
  },
};
