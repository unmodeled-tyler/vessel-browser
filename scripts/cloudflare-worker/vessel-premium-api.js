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
 *   PREMIUM_TOKEN_SECRET — random string used to sign premium auth tokens
 *   RESEND_API_KEY       — API key for transactional activation emails
 *   PREMIUM_FROM_EMAIL   — verified sender, e.g. Vessel <premium@example.com>
 */

const STRIPE_API = "https://api.stripe.com/v1";
const RESEND_API = "https://api.resend.com/emails";
const ACTIVATION_CHALLENGE_TTL_MS = 15 * 60 * 1000;
const PREMIUM_AUTH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

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

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getRequiredSecret(env, key) {
  const value = String(env[key] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stringToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlToString(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signHmac(secret, value) {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

async function createSignedToken(env, purpose, payload) {
  const secret = getRequiredSecret(env, "PREMIUM_TOKEN_SECRET");
  const header = stringToBase64Url(
    JSON.stringify({ alg: "HS256", typ: "JWT", purpose }),
  );
  const body = stringToBase64Url(JSON.stringify(payload));
  const signature = await signHmac(secret, `${header}.${body}`);
  return `${header}.${body}.${signature}`;
}

async function verifySignedToken(env, token, expectedPurpose) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerPart, payloadPart, signaturePart] = parts;
  const secret = getRequiredSecret(env, "PREMIUM_TOKEN_SECRET");
  const expectedSignature = await signHmac(secret, `${headerPart}.${payloadPart}`);
  if (expectedSignature !== signaturePart) {
    return null;
  }

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlToString(headerPart));
    payload = JSON.parse(base64UrlToString(payloadPart));
  } catch {
    return null;
  }

  if (header?.purpose !== expectedPurpose) {
    return null;
  }
  if (typeof payload?.exp !== "number" || Date.now() > payload.exp) {
    return null;
  }
  return payload;
}

function generateVerificationCode() {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(random).padStart(6, "0");
}

async function buildActivationCodeDigest(env, email, code, nonce, exp) {
  const secret = getRequiredSecret(env, "PREMIUM_TOKEN_SECRET");
  return signHmac(secret, `premium-code:${email}:${code}:${nonce}:${exp}`);
}

async function createPremiumAuthToken(env, customerId, email) {
  const now = Date.now();
  return createSignedToken(env, "premium-access", {
    customerId,
    email,
    iat: now,
    exp: now + PREMIUM_AUTH_TTL_MS,
  });
}

async function sendActivationCodeEmail(env, email, code) {
  const apiKey = getRequiredSecret(env, "RESEND_API_KEY");
  const from = getRequiredSecret(env, "PREMIUM_FROM_EMAIL");
  const response = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Your Vessel Premium verification code",
      text: [
        "Your Vessel Premium verification code is:",
        "",
        code,
        "",
        "It expires in 15 minutes.",
        "If you did not request this code, you can ignore this email.",
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Email delivery failed with status ${response.status}`);
  }
}

async function buildPremiumStatus(env, customerId, fallbackEmail = "") {
  if (!customerId) {
    return {
      status: "free",
      customerId: "",
      verificationToken: "",
      email: fallbackEmail,
      expiresAt: "",
    };
  }

  const customer = await stripeRequest(env, "GET", `/customers/${customerId}`);
  if (customer.error) {
    return {
      status: "free",
      customerId: "",
      verificationToken: "",
      email: fallbackEmail,
      expiresAt: "",
    };
  }

  const subscription = await getSubscription(env, customer.id);
  const status = subscriptionToStatus(subscription);

  return {
    status,
    customerId: customer.id,
    verificationToken: await createPremiumAuthToken(
      env,
      customer.id,
      normalizeEmail(customer.email || fallbackEmail),
    ),
    email: customer.email || fallbackEmail,
    expiresAt: subscription?.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : "",
  };
}

// --- CORS ---

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildCorsHeaders(request, env) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  const origin = request.headers.get("origin");
  if (origin && allowedOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

function corsResponse(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...buildCorsHeaders(request, env),
    },
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
    return corsResponse(request, env, { error: session.error.message }, 400);
  }

  // GET requests (e.g. clicking a link on the website) get a redirect;
  // POST requests (e.g. from the Vessel app) get JSON.
  if (request.method === "GET") {
    return new Response(null, {
      status: 302,
      headers: {
        Location: session.url,
        ...buildCorsHeaders(request, env),
      },
    });
  }

  return corsResponse(request, env, { url: session.url });
}

async function handlePortal(request, env) {
  return corsResponse(
    request,
    env,
    {
      error:
        "Billing portal access is temporarily disabled until authenticated customer access is implemented.",
    },
    403,
  );
}

async function handleActivationStart(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse(request, env, { error: "Invalid JSON body" }, 400);
  }

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) {
    return corsResponse(request, env, { error: "A valid email is required" }, 400);
  }

  if (!env.RESEND_API_KEY || !env.PREMIUM_FROM_EMAIL || !env.PREMIUM_TOKEN_SECRET) {
    return corsResponse(
      request,
      env,
      {
        error:
          "Premium email verification is not configured yet. Set RESEND_API_KEY, PREMIUM_FROM_EMAIL, and PREMIUM_TOKEN_SECRET in the worker environment.",
      },
      503,
    );
  }

  const now = Date.now();
  const exp = now + ACTIVATION_CHALLENGE_TTL_MS;
  const nonce = crypto.randomUUID();
  const code = generateVerificationCode();
  const codeDigest = await buildActivationCodeDigest(env, email, code, nonce, exp);

  const customer = await findCustomerByEmail(env, email);
  if (customer?.email) {
    await sendActivationCodeEmail(env, email, code);
  }

  return corsResponse(request, env, {
    ok: true,
    challengeToken: await createSignedToken(env, "premium-activation", {
      email,
      nonce,
      codeDigest,
      iat: now,
      exp,
    }),
  });
}

async function handleActivationVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse(request, env, { error: "Invalid JSON body" }, 400);
  }

  const email = normalizeEmail(body.email);
  const code = String(body.code || "").trim();
  const challengeToken = String(body.challengeToken || "").trim();

  if (!isValidEmail(email)) {
    return corsResponse(request, env, { error: "A valid email is required" }, 400);
  }
  if (!/^\d{6}$/.test(code)) {
    return corsResponse(request, env, { error: "Enter the 6-digit code" }, 400);
  }
  if (!challengeToken) {
    return corsResponse(request, env, { error: "challengeToken is required" }, 400);
  }

  const challenge = await verifySignedToken(env, challengeToken, "premium-activation");
  if (!challenge || challenge.email !== email) {
    return corsResponse(
      request,
      env,
      { error: "Code verification expired. Request a new code." },
      403,
    );
  }

  const expectedDigest = await buildActivationCodeDigest(
    env,
    email,
    code,
    challenge.nonce,
    challenge.exp,
  );
  if (expectedDigest !== challenge.codeDigest) {
    return corsResponse(request, env, { error: "Invalid verification code" }, 403);
  }

  const customer = await findCustomerByEmail(env, email);
  if (!customer?.id) {
    return corsResponse(
      request,
      env,
      {
        status: "free",
        customerId: "",
        verificationToken: "",
        email,
        expiresAt: "",
      },
    );
  }

  return corsResponse(request, env, await buildPremiumStatus(env, customer.id, email));
}

async function handleVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse(request, env, { error: "Invalid JSON body" }, 400);
  }

  const identifier = body.identifier;
  if (!identifier) {
    return corsResponse(
      request,
      env,
      { error: "identifier is required" },
      400,
    );
  }

  if (identifier.startsWith("cs_")) {
    const session = await stripeRequest(env, "GET", `/checkout/sessions/${identifier}`);
    if (session.error || !session.customer) {
      return corsResponse(request, env, {
        status: "free",
        customerId: "",
        verificationToken: "",
        email: "",
        expiresAt: "",
      });
    }

    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer.id;
    return corsResponse(request, env, await buildPremiumStatus(env, customerId));
  }

  const token = await verifySignedToken(env, identifier, "premium-access");
  if (!token?.customerId) {
    return corsResponse(
      request,
      env,
      {
        error:
          "Authenticated verification is required. Request a new email code or re-run checkout from this device to restore premium access.",
      },
      403,
    );
  }

  return corsResponse(
    request,
    env,
    await buildPremiumStatus(env, token.customerId, token.email || ""),
  );
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
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Vessel Premium — Activated!</title>
  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=AW-18032196333"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());

    gtag('config', 'AW-18032196333');
  </script>
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
    <p>Your subscription is active.</p>
    <p>If you started checkout from inside Vessel, the app should unlock automatically in a few seconds.</p>
    <ol class="steps">
      <li>Return to <strong>Vessel</strong></li>
      <li>Wait a few seconds for automatic activation</li>
      <li>If Premium is still locked, open <strong>Settings</strong> (Ctrl+,)</li>
      <li>Scroll to the <strong>Premium</strong> section</li>
      <li>Enter the <strong>subscription email</strong> you used at checkout</li>
      <li>Request a short verification code and enter it in Vessel</li>
    </ol>
    <p>The code fallback is only needed when the original checkout session is no longer available on this device.</p>
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
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(request, env),
      });
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
      if (path === "/activate/start" && request.method === "POST") {
        return handleActivationStart(request, env);
      }
      if (path === "/activate/verify" && request.method === "POST") {
        return handleActivationVerify(request, env);
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
      return corsResponse(request, env, { error: "Internal server error" }, 500);
    }
  },
};
