import { app } from "electron";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { loadSettings } from "../config/settings";
import { isPremium } from "../premium/manager";

/**
 * Vessel Telemetry — anonymous usage analytics via PostHog.
 *
 * What we track:
 *   - App launches (DAU/WAU/MAU)
 *   - Tool calls by name (popularity, no arguments or results)
 *   - AI provider type (anthropic/openai/ollama/etc, never keys)
 *   - Premium status (free/active/trialing)
 *   - Page types agents interact with
 *   - Session duration (approximate)
 *
 * What we NEVER track:
 *   - URLs, page content, queries, bookmarks, highlights
 *   - API keys, emails, or any PII
 *   - Tool arguments or results
 *   - Specific page content or user data
 *
 * Users can opt out at any time in Settings.
 */

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || "phc_OMeM3P5cxJwl14lOKxYad0Yre52xvjNfkLEFnPtXyM";
const POSTHOG_HOST =
  process.env.POSTHOG_HOST || "https://us.i.posthog.com";

const BATCH_INTERVAL_MS = 60_000; // Flush every 60 seconds
const MAX_BATCH_SIZE = 50;
const SENSITIVE_PROPERTY_RE = /url|uri|query|prompt|content|text|token|secret|key|password|credential|email|domain/i;
const SENSITIVE_STRING_VALUE_RE =
  /https?:\/\/|www\.|[^\s@]+@[^\s@]+\.[^\s@]+|bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|(?:sk|pk|rk|gh[pousr]|xox[baprs])-[-_A-Za-z0-9]{12,}/i;

// --- Anonymous device ID (persistent, no PII) ---

function getDeviceIdPath(): string {
  return path.join(app.getPath("userData"), ".vessel-device-id");
}

let deviceId: string | null = null;

function getDeviceId(): string {
  if (deviceId) return deviceId;
  const idPath = getDeviceIdPath();
  try {
    deviceId = fs.readFileSync(idPath, "utf-8").trim();
    if (deviceId) return deviceId;
  } catch {
    // File doesn't exist yet
  }
  deviceId = randomUUID();
  try {
    fs.mkdirSync(path.dirname(idPath), { recursive: true });
    fs.writeFileSync(idPath, deviceId, "utf-8");
  } catch {
    // Non-critical — we'll generate a new one next launch
  }
  return deviceId;
}

// --- Event queue ---

interface TelemetryEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

let eventQueue: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let sessionStartedAt: number | null = null;

function isEnabled(): boolean {
  if (POSTHOG_API_KEY === "YOUR_POSTHOG_KEY_HERE") return false;
  if (process.env.VESSEL_DEV === "1") return false;
  return loadSettings().telemetryEnabled !== false;
}

export function sanitizeTelemetryProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (SENSITIVE_PROPERTY_RE.test(key)) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      if (typeof value === "string" && SENSITIVE_STRING_VALUE_RE.test(value)) {
        continue;
      }
      safe[key] = typeof value === "string" ? value.slice(0, 120) : value;
    }
  }
  return safe;
}

// --- Public API ---

export function trackEvent(
  event: string,
  properties: Record<string, unknown> = {},
): void {
  if (!isEnabled()) return;

  eventQueue.push({
    event,
    properties: {
      ...sanitizeTelemetryProperties(properties),
      premium_status: isPremium() ? "premium" : "free",
      app_version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    },
    timestamp: new Date().toISOString(),
  });

  if (eventQueue.length >= MAX_BATCH_SIZE) {
    void flush();
  }
}

export function trackToolCall(toolName: string, pageType?: string): void {
  trackEvent("tool_called", {
    tool_name: toolName,
    page_type: pageType || "unknown",
  });
}

export function trackProviderConfigured(providerId: string): void {
  trackEvent("provider_configured", {
    provider_id: providerId,
  });
}

export function trackPageTypeDetected(pageType: string): void {
  trackEvent("page_type_detected", {
    page_type: pageType,
  });
}

// --- Feature usage tracking ---

export function trackSettingChanged(key: string): void {
  trackEvent("setting_changed", { setting_key: key });
}

export function trackApprovalModeChanged(mode: string): void {
  trackEvent("approval_mode_changed", { mode });
}

export function trackBookmarkAction(
  action: "save" | "remove" | "folder_create" | "folder_remove" | "export",
): void {
  trackEvent("bookmark_action", { action });
}

export function trackVaultAction(action: "credential_added" | "credential_removed" | "login_fill" | "totp_fill"): void {
  trackEvent("vault_action", { action });
}

export function trackExtractionFailed(_domain: string, reason: string): void {
  trackEvent("extraction_failed", { reason });
}

export function trackPremiumFunnel(
  step:
    | "activation_attempted"
    | "activation_succeeded"
    | "activation_failed"
    | "checkout_clicked"
    | "portal_opened"
    | "reset"
    | "chat_banner_viewed"
    | "chat_banner_clicked"
    | "settings_banner_viewed"
    | "settings_banner_clicked"
    | "welcome_banner_clicked"
    | "premium_gate_seen"
    | "premium_gate_clicked"
    | "iteration_limit_seen"
    | "iteration_limit_clicked"
    | "checkout_success_seen"
    | "checkout_canceled"
    | "auto_activation_attempted"
    | "auto_activation_succeeded"
    | "auto_activation_failed",
  context?: Record<string, unknown>,
): void {
  trackEvent("premium_funnel", { step, ...context });
}

// --- Lifecycle ---

export function startTelemetry(): void {
  if (!isEnabled()) return;

  sessionStartedAt = Date.now();

  trackEvent("app_launched", {
    electron_version: process.versions.electron,
    chrome_version: process.versions.chrome,
  });

  // Periodic flush
  flushTimer = setInterval(() => {
    void flush();
  }, BATCH_INTERVAL_MS);
}

export function stopTelemetry(): void {
  if (sessionStartedAt) {
    const durationMinutes = Math.round(
      (Date.now() - sessionStartedAt) / 60_000,
    );
    trackEvent("app_session_ended", {
      duration_minutes: durationMinutes,
    });
    sessionStartedAt = null;
  }

  if (flushTimer) {
    clearInterval(flushTimer);
  }
  flushTimer = null;

  // Final synchronous flush on shutdown
  void flush();
}

// --- PostHog batch API ---

async function flush(): Promise<void> {
  if (eventQueue.length === 0) return;
  if (!isEnabled()) {
    eventQueue = [];
    return;
  }

  const batch = eventQueue.splice(0);
  const distinctId = getDeviceId();

  const payload = {
    api_key: POSTHOG_API_KEY,
    batch: batch.map((e) => ({
      event: e.event,
      properties: {
        distinct_id: distinctId,
        ...e.properties,
      },
      timestamp: e.timestamp,
    })),
  };

  try {
    await fetch(`${POSTHOG_HOST}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Silently fail — telemetry should never block the app.
    // Re-queue events for next flush attempt (drop if too many).
    if (eventQueue.length < MAX_BATCH_SIZE * 2) {
      eventQueue.unshift(...batch);
    }
  }
}
