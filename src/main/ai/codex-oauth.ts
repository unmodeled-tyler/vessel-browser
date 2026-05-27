import type { CodexOAuthTokens, CodexAuthStatus } from "../../shared/types";
import { createLogger } from "../../shared/logger";
import {
  createLocalPkceOAuthFlow,
  type PkceCodes,
} from "./local-pkce-oauth";

const logger = createLogger("CodexOAuth");

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
// Keep in sync with the Codex CLI Hydra redirect URI allow-list.
const PREFERRED_PORT = 1455;
const FALLBACK_PORT = 1457;

function buildAuthorizeUrl(
  redirectUri: string,
  pkce: PkceCodes,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

function parseJwtClaims(idToken: string): {
  accountId: string;
  email?: string;
} | null {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    );
    const authClaims = payload["https://api.openai.com/auth"] || {};
    const accountId =
      authClaims.chatgpt_account_id ||
      payload.chatgpt_account_id ||
      payload.sub ||
      "";
    const email = authClaims.email || payload.email || undefined;
    return { accountId, email };
  } catch {
    return null;
  }
}

function parseTokenExpiry(accessToken: string): number {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return Date.now() + 3600_000; // default 1h
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    );
    if (payload.exp && typeof payload.exp === "number") {
      return payload.exp * 1000; // jwt exp is in seconds
    }
  } catch {
    // fall through
  }
  return Date.now() + 3600_000; // default 1h
}

/**
 * @deprecated The Codex provider now routes inference through the ChatGPT
 * backend with the OAuth access_token. Kept only for a potential future
 * Platform API fallback.
 */
async function exchangeIdTokenForApiKey(idToken: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: CLIENT_ID,
    requested_token: "openai-api-key",
    subject_token: idToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
  });

  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    let errorMsg = `OpenAI API token exchange failed: ${response.status}`;
    try {
      const err = await response.json() as Record<string, unknown>;
      if (typeof err.error_description === "string") {
        errorMsg = err.error_description;
      } else if (typeof err.error === "string") {
        errorMsg = err.error;
      }
    } catch {
      // use default
    }
    throw new Error(errorMsg);
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("OpenAI API token exchange did not return an access token");
  }
  return data.access_token;
}

/** @deprecated See exchangeIdTokenForApiKey. */
export async function ensureCodexApiKey(
  tokens: CodexOAuthTokens,
): Promise<CodexOAuthTokens> {
  if (tokens.apiKey) return tokens;
  if (!tokens.idToken) return tokens;

  try {
    return {
      ...tokens,
      apiKey: await exchangeIdTokenForApiKey(tokens.idToken),
    };
  } catch (err) {
    logger.warn(
      "Codex API-key token exchange failed; continuing with ChatGPT OAuth tokens:",
      err,
    );
    return tokens;
  }
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<CodexOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    let errorMsg = `Token exchange failed: ${response.status}`;
    try {
      const err = await response.json() as Record<string, unknown>;
      if (typeof err.error_description === "string") {
        errorMsg = err.error_description;
      } else if (typeof err.error === "string") {
        errorMsg = err.error;
      }
    } catch {
      // use default
    }
    throw new Error(errorMsg);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    id_token: string;
  };

  const claims = parseJwtClaims(data.id_token);
  const expiresAt = parseTokenExpiry(data.access_token);
  const tokens: CodexOAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    expiresAt,
    accountId: claims?.accountId || "",
    accountEmail: claims?.email,
  };

  return tokens;
}

async function refreshAccessToken(
  tokens: CodexOAuthTokens,
): Promise<CodexOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: CLIENT_ID,
  });

  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    let errorMsg = `Token refresh failed: ${response.status}`;
    try {
      const err = await response.json() as Record<string, unknown>;
      if (typeof err.error_description === "string") errorMsg = err.error_description;
      else if (typeof err.error === "string") errorMsg = err.error;
    } catch { /* use default */ }
    throw new Error(errorMsg);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
  };

  const idToken = data.id_token || tokens.idToken || "";
  const claims = idToken ? parseJwtClaims(idToken) : null;
  const expiresAt = parseTokenExpiry(data.access_token);
  const refreshedTokens: CodexOAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    idToken,
    apiKey: tokens.apiKey,
    expiresAt,
    accountId: claims?.accountId || tokens.accountId || "",
    accountEmail: claims?.email || tokens.accountEmail,
  };

  return refreshedTokens;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const codexOAuth = createLocalPkceOAuthFlow<CodexOAuthTokens>({
  name: "Codex",
  logger,
  preferredPorts: [PREFERRED_PORT, FALLBACK_PORT],
  timeoutMs: AUTH_TIMEOUT_MS,
  callbackPath: () => "/auth/callback",
  readState: (url) => url.searchParams.get("state"),
  authErrorMessage: (url) =>
    url.searchParams.get("error_description") || url.searchParams.get("error"),
  buildAuthorizeUrl: ({ callbackUrl, pkce, state }) =>
    buildAuthorizeUrl(callbackUrl, pkce, state),
  exchangeCode: ({ code, callbackUrl, codeVerifier }) =>
    exchangeCodeForTokens(code, callbackUrl, codeVerifier),
  successHtml: (tokens) => {
    const label = escapeHtml(tokens.accountEmail || tokens.accountId);
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Vessel — Signed In</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee}</style></head>
<body><div style="text-align:center"><h1>Signed In</h1>
<p>Connected as ${label}</p><p>You can close this tab.</p></div></body></html>`;
  },
  openHosts: ["auth.openai.com"],
});

export async function startCodexOAuth(
  onStatus: (status: CodexAuthStatus, error?: string) => void,
): Promise<CodexOAuthTokens> {
  return codexOAuth.start(onStatus);
}

export function cancelCodexOAuth(): void {
  codexOAuth.cancel();
}

export function isCodexAuthInProgress(): boolean {
  return codexOAuth.isInProgress();
}

export { refreshAccessToken };
