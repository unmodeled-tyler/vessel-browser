import { createLogger } from "../../shared/logger";
import {
  createLocalPkceOAuthFlow,
  type LocalOAuthStatus,
} from "./local-pkce-oauth";

const logger = createLogger("OpenRouterOAuth");

const AUTH_BASE_URL = "https://openrouter.ai/auth";
const KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const PREFERRED_PORT = 1460;
const FALLBACK_PORT = 1461;

async function exchangeCodeForApiKey(
  code: string,
  codeVerifier: string,
): Promise<string> {
  const response = await fetch(KEY_EXCHANGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: "S256",
    }),
  });

  if (!response.ok) {
    let errorMsg = `OpenRouter key exchange failed: ${response.status}`;
    try {
      const payload = (await response.json()) as Record<string, unknown>;
      if (typeof payload.error === "string") {
        errorMsg = payload.error;
      } else if (typeof payload.message === "string") {
        errorMsg = payload.message;
      }
    } catch {
      // keep default
    }
    throw new Error(errorMsg);
  }

  const payload = (await response.json()) as { key?: unknown };
  if (typeof payload.key !== "string" || !payload.key.trim()) {
    throw new Error("OpenRouter did not return an API key");
  }

  return payload.key.trim();
}

const openRouterOAuth = createLocalPkceOAuthFlow<string>({
  name: "OpenRouter",
  logger,
  preferredPorts: [PREFERRED_PORT, FALLBACK_PORT],
  timeoutMs: AUTH_TIMEOUT_MS,
  callbackPath: (state) => `/auth/openrouter/callback/${state}`,
  readState: (url) => decodeURIComponent(url.pathname.split("/").pop() || ""),
  buildAuthorizeUrl: ({ callbackUrl, pkce }) => {
    const params = new URLSearchParams({
      callback_url: callbackUrl,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${AUTH_BASE_URL}?${params.toString()}`;
  },
  exchangeCode: ({ code, codeVerifier }) =>
    exchangeCodeForApiKey(code, codeVerifier),
  successHtml: () => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Vessel OpenRouter Setup</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee}</style></head>
<body><div style="text-align:center"><h1>OpenRouter connected</h1><p>Vessel is ready. You can close this tab.</p></div></body></html>`,
  openHosts: ["openrouter.ai"],
});

export function startOpenRouterOAuth(
  onStatus: (status: LocalOAuthStatus, error?: string) => void,
): Promise<string> {
  return openRouterOAuth.start(onStatus);
}

export function cancelOpenRouterOAuth(): void {
  openRouterOAuth.cancel();
}
