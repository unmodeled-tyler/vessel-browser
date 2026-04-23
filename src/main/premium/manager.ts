import { loadSettings, setSetting } from "../config/settings";
import type { PremiumState, PremiumStatus } from "../../shared/types";
import { createLogger } from "../../shared/logger";
import {
  errorResult,
  getErrorMessage,
  okResult,
  type Result,
} from "../../shared/result";

const logger = createLogger("Premium");

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

type PremiumVerificationResponse = {
  status: PremiumStatus;
  customerId: string;
  verificationToken: string;
  email: string;
  expiresAt: string;
};

type ActivationCodeStartResult = Result<{
  email: string;
  challengeToken: string;
}>;

type ActivationCodeVerifyResult = Result<
  { state: PremiumState },
  { state: PremiumState }
>;

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
  "automation_kits",
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
    verificationToken: "",
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
export async function getCheckoutUrl(
  email?: string,
): Promise<Result<{ url: string }>> {
  try {
    const params = new URLSearchParams();
    if (email) params.set("email", email);

    const res = await fetch(`${VERIFICATION_API}/checkout?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      const body = await res.text();
      return errorResult(body || `HTTP ${res.status}`);
    }

    const { url } = (await res.json()) as { url: string };
    return okResult({ url });
  } catch (err) {
    return errorResult(getErrorMessage(err, "Failed to create checkout"));
  }
}

/**
 * Open the Stripe Customer Portal for subscription management.
 */
export async function getPortalUrl(): Promise<Result<{ url: string }>> {
  return errorResult(
    "Billing portal access is temporarily disabled until authenticated customer access is implemented.",
  );
}

// --- Subscription verification ---

/**
 * Verify subscription status against the verification API.
 * Called on app launch and periodically in the background.
 */
export async function verifySubscription(
  identifier?: string,
): Promise<PremiumState> {
  const current = loadSettings().premium;
  const verificationIdentifier =
    identifier || current.verificationToken || current.customerId;

  if (!verificationIdentifier) {
    return current;
  }

  try {
    const res = await fetch(`${VERIFICATION_API}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: verificationIdentifier }),
    });

    if (!res.ok) {
      // Can't reach API — keep current state (offline grace handles expiry)
      logger.warn("Verification API returned a non-OK status:", res.status);
      return current;
    }

    const data = (await res.json()) as PremiumVerificationResponse;

    const updated: PremiumState = {
      status: data.status,
      customerId: data.customerId || current.customerId,
      verificationToken: data.verificationToken || verificationIdentifier,
      email: data.email || current.email,
      validatedAt: new Date().toISOString(),
      expiresAt: data.expiresAt,
    };

    setSetting("premium", updated);
    return updated;
  } catch (err) {
    logger.warn("Verification failed:", err);
    return current;
  }
}

/**
 * Request a short-lived activation code for the subscription email.
 */
export async function requestActivationCode(
  email: string,
): Promise<ActivationCodeStartResult> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    return errorResult("Email is required");
  }

  try {
    const res = await fetch(`${VERIFICATION_API}/activate/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: normalizedEmail }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      challengeToken?: string;
      error?: string;
    };
    if (!res.ok || !data.challengeToken) {
      return errorResult(data.error || `HTTP ${res.status}`);
    }

    return okResult({
      email: normalizedEmail,
      challengeToken: data.challengeToken,
    });
  } catch (err) {
    return errorResult(getErrorMessage(err, "Failed to send code"));
  }
}

/**
 * Verify an emailed activation code and persist the verified premium token.
 */
export async function verifyActivationCode(
  email: string,
  code: string,
  challengeToken: string,
): Promise<ActivationCodeVerifyResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const trimmedCode = code.trim();
  if (!normalizedEmail) {
    return errorResult("Email is required", { state: getPremiumState() });
  }
  if (!trimmedCode) {
    return errorResult("Code is required", { state: getPremiumState() });
  }
  if (!challengeToken.trim()) {
    return errorResult("Request a new activation code and try again.", {
      state: getPremiumState(),
    });
  }

  try {
    const res = await fetch(`${VERIFICATION_API}/activate/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: normalizedEmail,
        code: trimmedCode,
        challengeToken: challengeToken.trim(),
      }),
    });

    const data = (await res.json().catch(() => ({}))) as Partial<PremiumVerificationResponse> & {
      error?: string;
    };
    if (!res.ok) {
      return errorResult(data.error || `HTTP ${res.status}`, {
        state: getPremiumState(),
      });
    }

    const updated: PremiumState = {
      status: data.status ?? "free",
      customerId: data.customerId || "",
      verificationToken: data.verificationToken || "",
      email: data.email || normalizedEmail,
      validatedAt: new Date().toISOString(),
      expiresAt: data.expiresAt || "",
    };

    setSetting("premium", updated);
    return isPremiumActiveState(updated)
      ? okResult({ state: updated })
      : errorResult("Subscription is not active.", { state: updated });
  } catch (err) {
    return errorResult(getErrorMessage(err, "Failed to verify code"), {
      state: getPremiumState(),
    });
  }
}

// --- Background revalidation ---

let revalidationTimer: ReturnType<typeof setInterval> | null = null;

export function startBackgroundRevalidation(): void {
  if (revalidationTimer) return;

  // Check on startup if we need to revalidate
  const { premium } = loadSettings();
  const identifier = premium.verificationToken || premium.customerId;
  if (identifier) {
    const lastValidated = premium.validatedAt
      ? new Date(premium.validatedAt).getTime()
      : 0;
    if (Date.now() - lastValidated > REVALIDATION_INTERVAL_MS) {
      void verifySubscription(identifier);
    }
  }

  // Then check every 24 hours
  revalidationTimer = setInterval(() => {
    const { premium: p } = loadSettings();
    const currentIdentifier = p.verificationToken || p.customerId;
    if (currentIdentifier) {
      void verifySubscription(currentIdentifier);
    }
  }, REVALIDATION_INTERVAL_MS);
}

export function stopBackgroundRevalidation(): void {
  clearInterval(revalidationTimer);
  revalidationTimer = null;
}

export function isPremiumActiveState(state: PremiumState): boolean {
  return state.status === "active" || state.status === "trialing";
}
