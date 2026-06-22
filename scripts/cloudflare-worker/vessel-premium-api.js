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
 *   ACTIVATION_KV        — KV binding for activation attempts, checkout redemption, and feedback spam guard
 *   OPENROUTER_API_KEY   — OpenRouter key used by hosted Vessel AI inference
 *   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON — Play Developer API service account JSON
 *   ANDROID_PACKAGE_NAME — optional package-name allowlist for Play purchase verification
 *   STRIPE_STARTER_PRICE_ID / STRIPE_PLUS_PRICE_ID / STRIPE_PRO_PRICE_ID — optional web plan mapping
 *
 * Google Play subscription product IDs:
 *   vessel_starter_monthly, vessel_plus_monthly, vessel_pro_monthly
 */

const STRIPE_API = "https://api.stripe.com/v1";
const RESEND_API = "https://api.resend.com/emails";
const ACTIVATION_CHALLENGE_TTL_MS = 15 * 60 * 1000;
const ACTIVATION_CHALLENGE_TTL_SECONDS = Math.ceil(ACTIVATION_CHALLENGE_TTL_MS / 1000);
const MAX_ACTIVATION_CODE_ATTEMPTS = 5;
const PREMIUM_AUTH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CHECKOUT_REDEMPTION_TTL_SECONDS = Math.ceil(PREMIUM_AUTH_TTL_MS / 1000);
const MAX_FEEDBACK_MESSAGE_LENGTH = 5000;
const FEEDBACK_SPAM_GUARD_WINDOW_SECONDS = 60 * 60;
const FEEDBACK_SPAM_GUARD_MAX = 5;
const VESSEL_AI_MODEL = "minimax/minimax-m3";
const OPENROUTER_API = "https://openrouter.ai/api/v1";
const USAGE_LEDGER_TTL_SECONDS = 93 * 24 * 60 * 60;
const PLAN_CONFIG = {
  free: {
    label: "Free",
    monthlyAiBudgetUsd: 0,
    maxOutputTokens: 0,
    maxToolSteps: 0,
  },
  premium: {
    label: "Premium",
    monthlyAiBudgetUsd: 5,
    maxOutputTokens: 2000,
    maxToolSteps: 6,
  },
  starter: {
    label: "Starter",
    monthlyAiBudgetUsd: 2,
    maxOutputTokens: 1500,
    maxToolSteps: 4,
  },
  plus: {
    label: "Plus",
    monthlyAiBudgetUsd: 6,
    maxOutputTokens: 2500,
    maxToolSteps: 6,
  },
  pro: {
    label: "Pro",
    monthlyAiBudgetUsd: 18,
    maxOutputTokens: 4000,
    maxToolSteps: 8,
  },
};
const PLAN_PRICE_ENV_KEYS = {
  starter: ["STRIPE_STARTER_PRICE_ID", "VESSEL_STARTER_PRICE_ID"],
  plus: ["STRIPE_PLUS_PRICE_ID", "VESSEL_PLUS_PRICE_ID"],
  pro: ["STRIPE_PRO_PRICE_ID", "VESSEL_PRO_PRICE_ID"],
};
const PLAY_PRODUCT_PLANS = {
  vessel_starter_monthly: "starter",
  vessel_plus_monthly: "plus",
  vessel_pro_monthly: "pro",
};

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

function normalizePlan(plan) {
  const normalized = String(plan || "").trim().toLowerCase();
  return PLAN_CONFIG[normalized] ? normalized : "premium";
}

function planConfig(plan) {
  return PLAN_CONFIG[normalizePlan(plan)];
}

function configuredPriceIdsForPlan(env, plan) {
  return (PLAN_PRICE_ENV_KEYS[plan] || [])
    .map((key) => String(env[key] || "").trim())
    .filter(Boolean);
}

function planFromPriceId(env, priceId) {
  const id = String(priceId || "").trim();
  if (!id) return "premium";
  for (const plan of Object.keys(PLAN_PRICE_ENV_KEYS)) {
    if (configuredPriceIdsForPlan(env, plan).includes(id)) {
      return plan;
    }
  }
  if (id === String(env.STRIPE_PRICE_ID || "").trim()) {
    return "premium";
  }
  return "premium";
}

function planFromSubscription(env, sub) {
  const priceId = sub?.items?.data?.[0]?.price?.id || sub?.plan?.id || "";
  return planFromPriceId(env, priceId);
}

function planFromPlayProduct(productId) {
  return PLAY_PRODUCT_PLANS[String(productId || "").trim()] || "premium";
}

async function findCustomerByEmail(env, email) {
  const data = await stripeRequest(env, "GET", `/customers?email=${encodeURIComponent(email)}&limit=1`);
  return data.data?.[0] || null;
}

async function getSubscription(env, customerId) {
  const data = await stripeRequest(env, "GET", `/subscriptions?customer=${customerId}&status=all&limit=10`);
  const subscriptions = Array.isArray(data.data) ? data.data : [];
  return pickBestSubscription(subscriptions);
}

async function getSubscriptionById(env, subscriptionId) {
  if (!subscriptionId) return null;
  const data = await stripeRequest(env, "GET", `/subscriptions/${subscriptionId}`);
  return data.error ? null : data;
}

function subscriptionAccessEndsAt(sub) {
  if (!sub) return 0;
  if (sub.status === "trialing") {
    return sub.trial_end || sub.current_period_end || 0;
  }
  return sub.current_period_end || sub.trial_end || 0;
}

function isEntitledSubscription(sub, now = Math.floor(Date.now() / 1000)) {
  if (!sub) return false;
  if (sub.status !== "active" && sub.status !== "trialing") return false;
  const accessEndsAt = subscriptionAccessEndsAt(sub);
  return !accessEndsAt || accessEndsAt > now;
}

function pickBestSubscription(subscriptions) {
  const now = Math.floor(Date.now() / 1000);
  const entitled = subscriptions
    .filter((sub) => isEntitledSubscription(sub, now))
    .sort((a, b) => subscriptionAccessEndsAt(b) - subscriptionAccessEndsAt(a));
  if (entitled[0]) return entitled[0];

  return subscriptions
    .slice()
    .sort((a, b) => (b.created || 0) - (a.created || 0))[0] || null;
}

function subscriptionToStatus(sub) {
  if (!sub) return "free";
  if (isEntitledSubscription(sub)) {
    return sub.status;
  }
  switch (sub.status) {
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

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function missingKvResponse(request, env, capability) {
  return corsResponse(
    request,
    env,
    {
      error: `${capability} is temporarily unavailable. Try again later.`,
    },
    503,
  );
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

function pemToArrayBuffer(pem) {
  const base64 = String(pem || "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  return base64UrlToBytes(base64.replace(/\+/g, "-").replace(/\//g, "_")).buffer;
}

async function importGooglePrivateKey(privateKeyPem) {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signGoogleJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = serviceAccount.token_uri || "https://oauth2.googleapis.com/token";
  const header = stringToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = stringToBase64Url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: tokenUri,
      iat: now,
      exp: now + 55 * 60,
    }),
  );
  const key = await importGooglePrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function getGoogleAccessToken(env) {
  const serviceAccount = JSON.parse(getRequiredSecret(env, "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"));
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("Google Play service account JSON is missing client_email or private_key");
  }
  const tokenUri = serviceAccount.token_uri || "https://oauth2.googleapis.com/token";
  const assertion = await signGoogleJwt(serviceAccount);
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Google access token request failed");
  }
  return data.access_token;
}

async function getGooglePlaySubscription(env, packageName, purchaseToken) {
  const accessToken = await getGoogleAccessToken(env);
  const url =
    "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" +
    `${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/` +
    encodeURIComponent(purchaseToken);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Google Play purchase verification failed");
  }
  return data;
}

function isEntitledPlaySubscription(subscription) {
  return [
    "SUBSCRIPTION_STATE_ACTIVE",
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  ].includes(subscription?.subscriptionState);
}

function authTokenTtlMsForExpiry(expiresAt) {
  const expiryMs = Date.parse(expiresAt || "");
  if (!Number.isFinite(expiryMs)) return PREMIUM_AUTH_TTL_MS;
  const remainingMs = expiryMs - Date.now();
  if (remainingMs <= 0) return 0;
  return Math.min(PREMIUM_AUTH_TTL_MS, remainingMs);
}

async function createPremiumAuthToken(
  env,
  customerId,
  email,
  plan = "premium",
  source = "stripe",
  ttlMs = PREMIUM_AUTH_TTL_MS,
) {
  const now = Date.now();
  return createSignedToken(env, "premium-access", {
    customerId,
    email,
    plan: normalizePlan(plan),
    source,
    iat: now,
    exp: now + ttlMs,
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

async function sendFeedbackEmail(env, email, message, source = "") {
  const apiKey = getRequiredSecret(env, "RESEND_API_KEY");
  const from = getRequiredSecret(env, "PREMIUM_FROM_EMAIL");
  const to = String(env.FEEDBACK_TO_EMAIL || "hello@quantaintellect.com").trim();
  const sourceLine = source ? `Source: ${source}` : "Source: Vessel";
  const response = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: email,
      subject: `Vessel feedback from ${email}`,
      text: [
        "New Vessel feedback",
        "",
        `Reply email: ${email}`,
        sourceLine,
        "",
        "Message:",
        message,
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Feedback delivery failed with status ${response.status}`);
  }
}

async function checkFeedbackSpamGuard(request, env) {
  if (!env.ACTIVATION_KV) {
    return missingKvResponse(request, env, "Feedback submission");
  }

  try {
    const rawClientId =
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
    const key = `feedback-rate:${await sha256Hex(rawClientId)}`;
    const current = Number(await env.ACTIVATION_KV.get(key));
    const next = Number.isFinite(current) ? current + 1 : 1;

    if (next > FEEDBACK_SPAM_GUARD_MAX) {
      return corsResponse(
        request,
        env,
        { error: "Too many feedback messages. Try again later." },
        429,
      );
    }

    await env.ACTIVATION_KV.put(key, String(next), {
      expirationTtl: FEEDBACK_SPAM_GUARD_WINDOW_SECONDS,
    });
  } catch (error) {
    console.warn("Feedback spam guard failed closed:", error);
    return missingKvResponse(request, env, "Feedback submission");
  }
  return null;
}

async function consumeActivationAttempt(request, env, challengeToken) {
  if (!env.ACTIVATION_KV) {
    return {
      response: missingKvResponse(request, env, "Premium email verification"),
    };
  }

  try {
    const key = `activation-attempts:${await sha256Hex(challengeToken)}`;
    const current = await env.ACTIVATION_KV.get(key);
    if (current === "redeemed") {
      return {
        response: corsResponse(
          request,
          env,
          { error: "Code verification expired. Request a new code." },
          403,
        ),
      };
    }

    const attempts = Number(current);
    const next = Number.isFinite(attempts) ? attempts + 1 : 1;
    if (next > MAX_ACTIVATION_CODE_ATTEMPTS) {
      return {
        response: corsResponse(
          request,
          env,
          { error: "Too many verification attempts. Request a new code." },
          429,
        ),
      };
    }

    await env.ACTIVATION_KV.put(key, String(next), {
      expirationTtl: ACTIVATION_CHALLENGE_TTL_SECONDS,
    });
    return { key };
  } catch (error) {
    console.warn("Activation attempt guard failed closed:", error);
    return {
      response: missingKvResponse(request, env, "Premium email verification"),
    };
  }
}

async function markActivationChallengeRedeemed(env, key) {
  await env.ACTIVATION_KV.put(key, "redeemed", {
    expirationTtl: ACTIVATION_CHALLENGE_TTL_SECONDS,
  });
}

async function getCheckoutRedemptionKey(sessionId) {
  return `checkout-session-redeemed:${await sha256Hex(sessionId)}`;
}

async function assertCheckoutSessionRedeemable(request, env, sessionId) {
  if (!env.ACTIVATION_KV) {
    return {
      response: missingKvResponse(request, env, "Checkout verification"),
    };
  }

  try {
    const key = await getCheckoutRedemptionKey(sessionId);
    const redeemed = await env.ACTIVATION_KV.get(key);
    if (redeemed) {
      return {
        response: corsResponse(
          request,
          env,
          { error: "Checkout session has already been redeemed. Verify by email or use the stored premium token." },
          409,
        ),
      };
    }
    return { key };
  } catch (error) {
    console.warn("Checkout redemption guard failed closed:", error);
    return {
      response: missingKvResponse(request, env, "Checkout verification"),
    };
  }
}

async function markCheckoutSessionRedeemed(env, key) {
  await env.ACTIVATION_KV.put(key, String(Date.now()), {
    expirationTtl: CHECKOUT_REDEMPTION_TTL_SECONDS,
  });
}

function currentUsagePeriod() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function usageSubjectKey(subject) {
  return sha256Hex(String(subject || "anonymous").trim().toLowerCase());
}

function emptyUsage(period = currentUsagePeriod()) {
  return {
    period,
    requests: 0,
    estimatedCostUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
}

async function getUsage(env, subject) {
  const period = currentUsagePeriod();
  if (!env.ACTIVATION_KV) return emptyUsage(period);
  const key = `ai-usage:${period}:${await usageSubjectKey(subject)}`;
  const raw = await env.ACTIVATION_KV.get(key);
  if (!raw) return emptyUsage(period);
  try {
    const parsed = JSON.parse(raw);
    return {
      ...emptyUsage(period),
      ...parsed,
      period,
    };
  } catch {
    return emptyUsage(period);
  }
}

async function putUsage(env, subject, usage) {
  if (!env.ACTIVATION_KV) return;
  const key = `ai-usage:${usage.period}:${await usageSubjectKey(subject)}`;
  await env.ACTIVATION_KV.put(key, JSON.stringify(usage), {
    expirationTtl: USAGE_LEDGER_TTL_SECONDS,
  });
}

function estimateMinimaxCostUsd(promptTokens = 0, completionTokens = 0) {
  const inputCost = (Number(promptTokens) || 0) * 0.30 / 1_000_000;
  const outputCost = (Number(completionTokens) || 0) * 1.20 / 1_000_000;
  return (inputCost + outputCost) * 1.055;
}

async function recordAiUsage(env, subject, usagePayload) {
  const current = await getUsage(env, subject);
  const promptTokens = Number(usagePayload?.prompt_tokens || usagePayload?.promptTokens || 0);
  const completionTokens = Number(
    usagePayload?.completion_tokens || usagePayload?.completionTokens || 0,
  );
  const next = {
    ...current,
    requests: current.requests + 1,
    promptTokens: current.promptTokens + promptTokens,
    completionTokens: current.completionTokens + completionTokens,
    estimatedCostUsd:
      current.estimatedCostUsd + estimateMinimaxCostUsd(promptTokens, completionTokens),
  };
  await putUsage(env, subject, next);
  return next;
}

function usageSummaryForPlan(usage, plan) {
  const config = planConfig(plan);
  return {
    ...usage,
    monthlyBudgetUsd: config.monthlyAiBudgetUsd,
    remainingBudgetUsd: Math.max(0, config.monthlyAiBudgetUsd - usage.estimatedCostUsd),
  };
}

async function buildEntitlementStatus(env, payload, status = "active", expiresAt = "") {
  const plan = normalizePlan(payload?.plan);
  const customerId = payload?.customerId || "";
  const email = normalizeEmail(payload?.email || "");
  const subject = customerId || email;
  const usage = await getUsage(env, subject);
  return {
    status,
    customerId,
    verificationToken: await createPremiumAuthToken(
      env,
      customerId,
      email,
      plan,
      payload?.source || "entitlement",
      authTokenTtlMsForExpiry(expiresAt),
    ),
    email,
    expiresAt,
    plan,
    planLabel: planConfig(plan).label,
    source: payload?.source || "entitlement",
    usage: usageSummaryForPlan(usage, plan),
  };
}

async function buildPremiumStatus(env, customerId, fallbackEmail = "", preferredSubscription = null) {
  if (!customerId) {
    return {
      status: "free",
      customerId: "",
      verificationToken: "",
      email: fallbackEmail,
      expiresAt: "",
      plan: "free",
      planLabel: PLAN_CONFIG.free.label,
      source: "stripe",
      usage: usageSummaryForPlan(emptyUsage(), "free"),
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
      plan: "free",
      planLabel: PLAN_CONFIG.free.label,
      source: "stripe",
      usage: usageSummaryForPlan(emptyUsage(), "free"),
    };
  }

  const subscription = preferredSubscription || await getSubscription(env, customer.id);
  const status = subscriptionToStatus(subscription);
  const plan = status === "active" || status === "trialing"
    ? planFromSubscription(env, subscription)
    : "free";
  const usage = await getUsage(env, customer.id);

  return {
    status,
    customerId: customer.id,
    verificationToken: await createPremiumAuthToken(
      env,
      customer.id,
      normalizeEmail(customer.email || fallbackEmail),
      plan,
      "stripe",
    ),
    email: customer.email || fallbackEmail,
    expiresAt: subscription?.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : "",
    plan,
    planLabel: planConfig(plan).label,
    source: "stripe",
    usage: usageSummaryForPlan(usage, plan),
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

  // Payment methods for subscription checkout.
  // Stripe automatically filters out methods unavailable for the
  // customer's region or incompatible with subscription mode.
  // Note: apple_pay/google_pay are automatic via card — not listed here.
  // Note: bank-redirect methods (bancontact, eps, blik) require SEPA debit
  // activation for subscriptions. Add them after enabling SEPA in Stripe.
  // Note: crypto/pix are one-time only — no subscription support.
  const paymentMethods = [
    "card",
    "link",
    "amazon_pay",
    "cashapp",
    "klarna",
  ];

  const params = {
    mode: "subscription",
    "line_items[0][price]": env.STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    success_url: `${url.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/canceled`,
    "subscription_data[trial_period_days]": "7",
  };

  // Attach all enabled payment method types
  for (let i = 0; i < paymentMethods.length; i++) {
    params[`payment_method_types[${i}]`] = paymentMethods[i];
  }
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
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse(request, env, { error: "Invalid JSON body" }, 400);
  }

  const identifier = String(body.identifier || "").trim();
  if (!identifier) {
    return corsResponse(request, env, { error: "identifier is required" }, 400);
  }

  const token = await verifySignedToken(env, identifier, "premium-access");
  if (!token?.customerId) {
    return corsResponse(
      request,
      env,
      {
        error:
          "Authenticated billing access is required. Verify your Premium subscription again before managing billing.",
      },
      403,
    );
  }

  const url = new URL(request.url);
  const session = await stripeRequest(env, "POST", "/billing_portal/sessions", {
    customer: token.customerId,
    return_url: `${url.origin}/portal-return`,
  });

  if (session.error || !session.url) {
    return corsResponse(
      request,
      env,
      { error: session.error?.message || "Could not create billing portal session" },
      400,
    );
  }

  return corsResponse(request, env, { url: session.url });
}

async function handleFeedback(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse(request, env, { error: "Invalid JSON body" }, 400);
  }

  const email = normalizeEmail(body.email);
  const message = String(body.message || "").trim();
  const source = String(body.source || "").trim().slice(0, 100);

  if (!isValidEmail(email)) {
    return corsResponse(request, env, { error: "A valid reply email is required" }, 400);
  }
  if (!message) {
    return corsResponse(request, env, { error: "Feedback message is required" }, 400);
  }
  if (message.length > MAX_FEEDBACK_MESSAGE_LENGTH) {
    return corsResponse(
      request,
      env,
      { error: `Feedback must be ${MAX_FEEDBACK_MESSAGE_LENGTH} characters or less` },
      400,
    );
  }
  if (!env.RESEND_API_KEY || !env.PREMIUM_FROM_EMAIL) {
    return corsResponse(
      request,
      env,
      { error: "Feedback email delivery is not configured yet." },
      503,
    );
  }

  const spamGuardResponse = await checkFeedbackSpamGuard(request, env);
  if (spamGuardResponse) return spamGuardResponse;

  await sendFeedbackEmail(env, email, message, source);
  return corsResponse(request, env, { ok: true });
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

  if (!env.RESEND_API_KEY || !env.PREMIUM_FROM_EMAIL || !env.PREMIUM_TOKEN_SECRET || !env.ACTIVATION_KV) {
    return corsResponse(
      request,
      env,
      {
        error:
          "Premium email verification is not configured yet. Set RESEND_API_KEY, PREMIUM_FROM_EMAIL, PREMIUM_TOKEN_SECRET, and ACTIVATION_KV in the worker environment.",
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

  const attempt = await consumeActivationAttempt(request, env, challengeToken);
  if (attempt.response) return attempt.response;

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

  const status = await buildPremiumStatus(env, customer.id, email);
  await markActivationChallengeRedeemed(env, attempt.key);
  return corsResponse(request, env, status);
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
    const redemption = await assertCheckoutSessionRedeemable(request, env, identifier);
    if (redemption.response) return redemption.response;

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
    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id;
    const subscription = await getSubscriptionById(env, subscriptionId);
    const status = await buildPremiumStatus(env, customerId, "", subscription);
    if (status.status === "active" || status.status === "trialing") {
      await markCheckoutSessionRedeemed(env, redemption.key);
    }
    return corsResponse(request, env, status);
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

async function handleEntitlement(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse(request, env, { error: "Invalid JSON body" }, 400);
  }

  const identifier = String(body.identifier || "").trim();
  if (!identifier) {
    return corsResponse(request, env, { error: "identifier is required" }, 400);
  }

  const token = await verifySignedToken(env, identifier, "premium-access");
  if (!token?.customerId) {
    return corsResponse(
      request,
      env,
      { error: "Authenticated entitlement token is required." },
      403,
    );
  }

  if (token.source === "stripe" || token.customerId.startsWith("cus_")) {
    return corsResponse(
      request,
      env,
      await buildPremiumStatus(env, token.customerId, token.email || ""),
    );
  }

  return corsResponse(request, env, await buildEntitlementStatus(env, token));
}

async function handlePlayVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse(request, env, { error: "Invalid JSON body" }, 400);
  }

  const email = normalizeEmail(body.email);
  const packageName = String(body.packageName || "").trim();
  const productId = String(body.productId || "").trim();
  const purchaseToken = String(body.purchaseToken || "").trim();

  if (!isValidEmail(email)) {
    return corsResponse(request, env, { error: "A valid email is required" }, 400);
  }
  if (!packageName || !productId || !purchaseToken) {
    return corsResponse(
      request,
      env,
      { error: "packageName, productId, and purchaseToken are required" },
      400,
    );
  }

  if (!env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
    return corsResponse(
      request,
      env,
      {
        error:
          "Google Play verification is not configured yet. Set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON in the worker environment.",
      },
      503,
    );
  }

  if (env.ANDROID_PACKAGE_NAME && packageName !== env.ANDROID_PACKAGE_NAME) {
    return corsResponse(request, env, { error: "Unexpected Android package name" }, 403);
  }

  let subscription;
  try {
    subscription = await getGooglePlaySubscription(env, packageName, purchaseToken);
  } catch (error) {
    console.warn("Google Play verification failed:", error);
    return corsResponse(request, env, { error: "Google Play purchase verification failed" }, 403);
  }

  const lineItem = Array.isArray(subscription.lineItems) ? subscription.lineItems[0] : null;
  const verifiedProductId = lineItem?.productId || productId;
  if (verifiedProductId !== productId) {
    return corsResponse(request, env, { error: "Purchase product does not match request" }, 403);
  }

  if (!isEntitledPlaySubscription(subscription)) {
    return corsResponse(request, env, {
      status: "free",
      customerId: "",
      verificationToken: "",
      email,
      expiresAt: lineItem?.expiryTime || "",
      plan: "free",
      planLabel: PLAN_CONFIG.free.label,
      source: "google_play",
      usage: usageSummaryForPlan(emptyUsage(), "free"),
    });
  }

  return corsResponse(
    request,
    env,
    await buildEntitlementStatus(
      env,
      {
        customerId: `play:${await sha256Hex(`${packageName}:${purchaseToken}`)}`,
        email,
        plan: planFromPlayProduct(productId),
        source: "google_play",
      },
      "active",
      lineItem?.expiryTime || "",
    ),
  );
}

async function handleAiChatCompletions(request, env) {
  const auth = request.headers.get("authorization") || "";
  const tokenValue = auth.replace(/^Bearer\s+/i, "").trim();
  const token = await verifySignedToken(env, tokenValue, "premium-access");
  if (!token?.customerId) {
    return corsResponse(request, env, { error: "Vessel AI subscription is required." }, 401);
  }

  const plan = normalizePlan(token.plan);
  const config = planConfig(plan);
  if (config.monthlyAiBudgetUsd <= 0) {
    return corsResponse(request, env, { error: "Vessel AI subscription is required." }, 403);
  }

  const subject = token.customerId || token.email;
  const usage = await getUsage(env, subject);
  if (usage.estimatedCostUsd >= config.monthlyAiBudgetUsd) {
    return corsResponse(
      request,
      env,
      {
        error: "Monthly Vessel AI usage limit reached.",
        usage: usageSummaryForPlan(usage, plan),
      },
      402,
    );
  }

  if (!env.OPENROUTER_API_KEY) {
    return corsResponse(
      request,
      env,
      { error: "Vessel AI is not configured yet. Set OPENROUTER_API_KEY." },
      503,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse(request, env, { error: "Invalid JSON body" }, 400);
  }

  const upstreamBody = {
    ...body,
    model: VESSEL_AI_MODEL,
    stream: false,
    max_tokens: Math.min(
      Number(body.max_tokens || body.max_completion_tokens || config.maxOutputTokens),
      config.maxOutputTokens,
    ),
  };

  const upstream = await fetch(`${OPENROUTER_API}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": String(env.VESSEL_APP_URL || "https://quantaintellect.com"),
      "X-Title": "Vessel Browser",
    },
    body: JSON.stringify(upstreamBody),
  });

  const text = await upstream.text();
  let responseBody = text;
  let responseUsage = null;
  try {
    const parsed = JSON.parse(text);
    responseUsage = parsed.usage || null;
    parsed.model = VESSEL_AI_MODEL;
    parsed.vessel = {
      plan,
      model: VESSEL_AI_MODEL,
    };
    responseBody = JSON.stringify(parsed);
  } catch {
    // Keep the upstream body as-is.
  }

  if (upstream.ok && responseUsage) {
    await recordAiUsage(env, subject, responseUsage);
  }

  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      ...buildCorsHeaders(request, env),
    },
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
    gtag('event', 'conversion', {'send_to': 'AW-18032196333/_rztCLq41KEcEO31tZZD'});
  </script>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0e; color: #e4e4e7; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { text-align: center; max-width: 480px; padding: 48px; }
    h1 { color: #c8956c; font-size: 28px; margin-bottom: 16px; }
    .subtitle { color: #e4e4e7; font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    p { color: #a1a1aa; line-height: 1.6; font-size: 16px; }
    .primary-path { text-align: left; margin-top: 24px; background: #18181b; border-radius: 8px; padding: 20px 24px; border-left: 3px solid #c8956c; }
    .primary-path h3 { color: #e4e4e7; font-size: 14px; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.05em; }
    .primary-path ol { margin: 0; padding-left: 20px; }
    .primary-path li { margin-bottom: 8px; color: #d4d4d8; font-size: 15px; }
    .primary-path li:last-child { margin-bottom: 0; }
    code { background: #27272a; padding: 2px 6px; border-radius: 4px; color: #c8956c; font-size: 14px; }
    .fallback { margin-top: 20px; padding: 16px 20px; background: #111114; border-radius: 8px; border: 1px solid #27272a; }
    .fallback p { font-size: 14px; color: #71717a; margin: 0; }
    .fallback strong { color: #a1a1aa; }
    .success-icon { font-size: 48px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="success-icon">&#10003;</div>
    <h1>Welcome to Vessel Premium!</h1>
    <p class="subtitle">Your 7-day free trial is now active.</p>
    <p>You won't be charged until the trial ends.</p>

    <div class="primary-path">
      <h3>Next Step — Activate in Vessel</h3>
      <ol>
        <li>Return to <strong>Vessel</strong> and keep this checkout tab open for a moment</li>
        <li>Vessel should unlock Premium automatically once it sees this success page</li>
        <li>If it does not, open <strong>Settings</strong> (<code>Ctrl+,</code>) and verify the <strong>email</strong> you used at checkout</li>
      </ol>
    </div>

    <div class="fallback">
      <p><strong>Didn't get a code?</strong> Check your spam folder, or reach out to <strong>hello@quantaintellect.com</strong> and we'll get you sorted.</p>
    </div>
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
      if (path === "/feedback" && request.method === "POST") {
        return handleFeedback(request, env);
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
      if (path === "/entitlement" && request.method === "POST") {
        return handleEntitlement(request, env);
      }
      if (path === "/play/verify" && request.method === "POST") {
        return handlePlayVerify(request, env);
      }
      if (path === "/ai/chat/completions" && request.method === "POST") {
        return handleAiChatCompletions(request, env);
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
