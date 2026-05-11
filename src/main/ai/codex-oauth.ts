import http from "http";
import crypto from "crypto";
import type { CodexOAuthTokens, CodexAuthStatus } from "../../shared/types";
import { createLogger } from "../../shared/logger";
import { openExternalAllowlisted } from "../security/external-open";

const logger = createLogger("CodexOAuth");

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
// Keep in sync with the Codex CLI Hydra redirect URI allow-list.
const PREFERRED_PORT = 1455;
const FALLBACK_PORT = 1457;

interface PkceCodes {
  codeVerifier: string;
  codeChallenge: string;
}

interface AuthFlowState {
  state: string;
  codeVerifier: string;
  port: number;
  server: http.Server;
  timeout: ReturnType<typeof setTimeout>;
  onStatus: (status: CodexAuthStatus, error?: string) => void;
}

let activeFlow: AuthFlowState | null = null;

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePkce(): PkceCodes {
  // Codex CLI uses 64 random bytes (≈86 chars base64url) for the verifier.
  const codeVerifier = base64url(crypto.randomBytes(64));
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = base64url(hash);
  return { codeVerifier, codeChallenge };
}

function generateState(): string {
  return base64url(crypto.randomBytes(32));
}

function buildAuthorizeUrl(port: number, pkce: PkceCodes, state: string): string {
  const redirectUri = `http://localhost:${port}/auth/callback`;
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

function startServer(
  port: number,
  pkce: PkceCodes,
  expectedState: string,
  resolve: (tokens: CodexOAuthTokens) => void,
  reject: (err: Error) => void,
): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/auth/callback") {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain", "Connection": "close" });
        const msg = errorDescription || error;
        res.end(`Authorization failed: ${msg}`);
        reject(new Error(msg));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/plain", "Connection": "close" });
        res.end("State mismatch. Please try again.");
        reject(new Error("State mismatch"));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain", "Connection": "close" });
        res.end("Missing authorization code.");
        reject(new Error("Missing authorization code"));
        return;
      }

      try {
        activeFlow?.onStatus("exchanging");
        const redirectUri = `http://localhost:${activeFlow?.port ?? port}/auth/callback`;
        const tokens = await exchangeCodeForTokens(code, redirectUri, pkce.codeVerifier);

        res.writeHead(302, {
          Location: `/success?email=${encodeURIComponent(tokens.accountEmail || tokens.accountId)}`,
          Connection: "close",
        });
        res.end();
        resolve(tokens);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "text/plain", "Connection": "close" });
        res.end(`Token exchange failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        reject(err instanceof Error ? err : new Error("Token exchange failed"));
      }
      return;
    }

    if (url.pathname === "/success") {
      const email = url.searchParams.get("email") || "";
      res.writeHead(200, { "Content-Type": "text/html", "Connection": "close" });
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Vessel — Signed In</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee}</style></head>
<body><div style="text-align:center"><h1>✓ Signed In</h1>
<p>Connected as ${escapeHtml(email)}</p><p>You can close this tab.</p></div></body></html>`);
      return;
    }

    if (url.pathname === "/cancel") {
      res.writeHead(200, { "Content-Type": "text/plain", "Connection": "close" });
      res.end("Login cancelled");
      reject(new Error("Login cancelled by user"));
      return;
    }

    res.writeHead(404, { "Connection": "close" });
    res.end("Not found");
  });

  return server;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function bindServer(server: http.Server): Promise<number> {
  const allowedPorts = [PREFERRED_PORT, FALLBACK_PORT];

  for (const port of allowedPorts) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return port;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `Could not bind Codex OAuth callback server to registered ports ${allowedPorts.join(", ")}`,
  );
}

export async function startCodexOAuth(
  onStatus: (status: CodexAuthStatus, error?: string) => void,
): Promise<CodexOAuthTokens> {
  if (activeFlow) {
    throw new Error("Auth flow already in progress");
  }

  const pkce = generatePkce();
  const state = generateState();

  return new Promise<CodexOAuthTokens>((resolve, reject) => {
    let settled = false;

    const safeOnStatus = (status: CodexAuthStatus, error?: string) => {
      try {
        onStatus(status, error);
      } catch {
        logger.warn("Codex OAuth status callback failed — window may be closed");
      }
    };

    const wrappedResolve = (tokens: CodexOAuthTokens) => {
      if (settled) return;
      settled = true;
      cleanup();
      safeOnStatus("connected");
      resolve(tokens);
    };

    const wrappedReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      safeOnStatus("error", err.message);
      reject(err);
    };

    const server = startServer(0, pkce, state, wrappedResolve, wrappedReject);

    const timeout = setTimeout(() => {
      wrappedReject(new Error("Auth flow timed out after 5 minutes"));
    }, AUTH_TIMEOUT_MS);

    activeFlow = {
      state,
      codeVerifier: pkce.codeVerifier,
      port: 0,
      server,
      timeout,
      onStatus,
    };

    const cleanup = () => {
      if (activeFlow?.timeout) clearTimeout(activeFlow.timeout);
      activeFlow?.server.close();
      activeFlow = null;
    };

    bindServer(server)
      .then((port) => {
        if (settled) return; // timed out before bind completed
        activeFlow!.port = port;
        const authUrl = buildAuthorizeUrl(port, pkce, state);
        safeOnStatus("waiting");

        // Open in default browser
        openExternalAllowlisted(authUrl, { hosts: ["auth.openai.com"] }).catch((err: Error) => {
          logger.warn("Failed to open browser, user will need the URL:", err);
        });
      })
      .catch(wrappedReject);
  });
}

export function cancelCodexOAuth(): void {
  if (!activeFlow) return;
  activeFlow.server.close();
  if (activeFlow.timeout) clearTimeout(activeFlow.timeout);
  try {
    activeFlow.onStatus("idle");
  } catch {
    logger.warn("Codex OAuth cancel status callback failed — window may be closed");
  }
  activeFlow = null;
}

export function isCodexAuthInProgress(): boolean {
  return activeFlow !== null;
}

export { refreshAccessToken };
