import { loadSettings, setSetting } from "../config/settings";
import type { PremiumState, PremiumStatus } from "../../shared/types";

/**
 * Vessel Premium subscription manager.
 *
 * Architecture:
 * - Stripe Checkout handles payment (hosted by Stripe)
 * - A lightweight verification API (Cloudflare Worker) validates subscriptions
 * - Vessel caches the subscription status locally and re-validates periodically
 * - 7-day offline grace period: if we can't reach the verification API,
 *   an active subscription remains valid for 7 days from last validation
 */

// The verification API URL — points to your Cloudflare Worker
const VERIFICATION_API =
  process.env.VESSEL_PREMIUM_API || "https://vesselpremium.quantaintellect.com";

const FREE_TOOL_ITERATION_LIMIT = 50;
const REVALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const OFFLINE_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- Premium feature definitions ---

/** Tools that require a premium subscription */
export const PREMIUM_TOOLS = new Set([
  "screenshot",
  "save_session",
  "load_session",
  "list_sessions",
  "delete_session",
  "flow_start",
  "flow_advance",
  "flow_status",
  "flow_end",
  "metrics",
  "extract_table",
  "vault_login",
  "vault_status",
  "vault_totp",
]);

/** Features gated behind premium (checked by name in UI/IPC) */
export const PREMIUM_FEATURES = new Set([
  "obsidian",
  "devtools",
  "unlimited_iterations",
  "vault",
]);

// --- Status checks ---

export function isPremium(): boolean {
  const { premium } = loadSettings();
  if (premium.status === "active" || premium.status === "trialing") {
    return true;
  }
  // Offline grace: if status was active and we're within grace period
  if (premium.validatedAt && premium.status !== "free") {
    const lastValidated = new Date(premium.validatedAt).getTime();
    if (Date.now() - lastValidated < OFFLINE_GRACE_PERIOD_MS) {
      return true;
    }
  }
  return false;
}

export function getPremiumState(): PremiumState {
  return { ...loadSettings().premium };
}

export function getEffectiveMaxIterations(): number {
  if (isPremium()) {
    return loadSettings().maxToolIterations || 200;
  }
  return FREE_TOOL_ITERATION_LIMIT;
}

export function resetPremium(): PremiumState {
  const fresh: PremiumState = {
    status: "free",
    customerId: "",
    email: "",
    validatedAt: "",
    expiresAt: "",
  };
  setSetting("premium", fresh);
  return fresh;
}

export function isToolGated(toolName: string): boolean {
  return PREMIUM_TOOLS.has(toolName) && !isPremium();
}

export function isFeatureGated(featureName: string): boolean {
  return PREMIUM_FEATURES.has(featureName) && !isPremium();
}

// --- Stripe Checkout ---

/**
 * Open a Stripe Checkout session in the user's default browser.
 * The verification API creates the checkout session and returns the URL.
 */
export async function getCheckoutUrl(email?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  try {
    const params = new URLSearchParams();
    if (email) params.set("email", email);

    const res = await fetch(`${VERIFICATION_API}/checkout?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: body || `HTTP ${res.status}` };
    }

    const { url } = (await res.json()) as { url: string };
    return { ok: true, url };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create checkout",
    };
  }
}

/**
 * Open the Stripe Customer Portal for subscription management.
 */
export async function getPortalUrl(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const { premium } = loadSettings();
  if (!premium.customerId) {
    return { ok: false, error: "No active subscription" };
  }

  try {
    const res = await fetch(`${VERIFICATION_API}/portal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: premium.customerId }),
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }

    const { url } = (await res.json()) as { url: string };
    return { ok: true, url };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to get portal URL",
    };
  }
}

// --- Subscription verification ---

/**
 * Verify subscription status against the verification API.
 * Called on app launch and periodically in the background.
 */
export async function verifySubscription(
  emailOrCustomerId?: string,
): Promise<PremiumState> {
  const current = loadSettings().premium;
  const identifier = emailOrCustomerId || current.customerId || current.email;

  if (!identifier) {
    return current;
  }

  try {
    const res = await fetch(`${VERIFICATION_API}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier }),
    });

    if (!res.ok) {
      // Can't reach API — keep current state (offline grace handles expiry)
      console.warn("[Vessel Premium] Verification API returned", res.status);
      return current;
    }

    const data = (await res.json()) as {
      status: PremiumStatus;
      customerId: string;
      email: string;
      expiresAt: string;
    };

    const updated: PremiumState = {
      status: data.status,
      customerId: data.customerId,
      email: data.email,
      validatedAt: new Date().toISOString(),
      expiresAt: data.expiresAt,
    };

    setSetting("premium", updated);
    return updated;
  } catch (err) {
    console.warn("[Vessel Premium] Verification failed:", err);
    return current;
  }
}

/**
 * Activate a subscription using an email address.
 * Verifies against the API and persists the result.
 */
export async function activateWithEmail(
  email: string,
): Promise<{ ok: boolean; state: PremiumState; error?: string }> {
  if (!email.trim()) {
    return { ok: false, state: getPremiumState(), error: "Email is required" };
  }

  const state = await verifySubscription(email.trim());

  if (state.status === "active" || state.status === "trialing") {
    return { ok: true, state };
  }

  return {
    ok: false,
    state,
    error:
      state.status === "canceled"
        ? "Subscription is canceled. Resubscribe to continue."
        : state.status === "past_due"
          ? "Subscription payment is past due. Update your payment method."
          : "No active subscription found for this email.",
  };
}

// --- Background revalidation ---

let revalidationTimer: ReturnType<typeof setInterval> | null = null;

export function startBackgroundRevalidation(): void {
  if (revalidationTimer) return;

  // Check on startup if we need to revalidate
  const { premium } = loadSettings();
  if (premium.customerId || premium.email) {
    const lastValidated = premium.validatedAt
      ? new Date(premium.validatedAt).getTime()
      : 0;
    if (Date.now() - lastValidated > REVALIDATION_INTERVAL_MS) {
      void verifySubscription();
    }
  }

  // Then check every 24 hours
  revalidationTimer = setInterval(() => {
    const { premium: p } = loadSettings();
    if (p.customerId || p.email) {
      void verifySubscription();
    }
  }, REVALIDATION_INTERVAL_MS);
}

export function stopBackgroundRevalidation(): void {
  if (revalidationTimer) {
    clearInterval(revalidationTimer);
    revalidationTimer = null;
  }
}
