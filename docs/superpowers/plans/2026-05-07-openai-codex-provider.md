# OpenAI Codex OAuth Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI Codex as an inference provider authenticating via browser-based OAuth with localhost callback (ChatGPT Plus/Pro subscription).

**Architecture:** New `codex-oauth.ts` module handles PKCE generation, localhost HTTP callback server, and token exchange at `auth.openai.com`. New `CodexProvider` class wraps the OpenAI SDK with Bearer token auth and transparent refresh. Token storage reuses the existing safeStorage pattern. Settings UI replaces the API key input with a "Connect with ChatGPT" OAuth button when the Codex provider is selected.

**Tech Stack:** Node `http` module, Node `crypto` (PKCE), `openai` npm SDK, Electron safeStorage, SolidJS signals.

---

### Task 1: Add types for Codex provider

**Files:**
- Modify: `src/shared/types.ts:430-461`

- [ ] **Step 1: Add `"openai_codex"` to `ProviderId` union**

In `src/shared/types.ts`, change line 430-439:

```typescript
export type ProviderId =
  | "anthropic"
  | "openai"
  | "openai_codex"
  | "openrouter"
  | "ollama"
  | "llama_cpp"
  | "mistral"
  | "xai"
  | "google"
  | "custom";
```

- [ ] **Step 2: Add `CodexOAuthTokens` type after `ProviderMeta` interface (after line 461)**

```typescript
export interface CodexOAuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;       // epoch ms
  accountId: string;       // chatgpt_account_id from JWT
  accountEmail?: string;
}

export type CodexAuthStatus = "idle" | "waiting" | "exchanging" | "connected" | "error";
```

- [ ] **Step 3: Add optional `type` field to `ProviderMeta` interface (line 452)**

Add after `requiresApiKey` on line 457:

```typescript
  requiresApiKey: boolean;
  type?: "direct_sdk" | "compatible" | "codex_oauth";
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add openai_codex provider types and CodexOAuthTokens"
```

---

### Task 2: Add Codex provider definition

**Files:**
- Modify: `src/shared/providers.ts:17-25` (insert after openai entry)

- [ ] **Step 1: Add `openai_codex` entry in `PROVIDERS` record**

Insert after the `openai` entry (after line 25), before `openrouter`:

```typescript
  openai_codex: {
    id: 'openai_codex',
    name: 'OpenAI Codex',
    type: 'codex_oauth' as const,
    defaultModel: 'gpt-5',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o4', 'o4-mini'],
    requiresApiKey: false,
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyPlaceholder: '',
    apiKeyHint: 'Sign in with your ChatGPT Plus or Pro subscription',
  },
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: No errors (the `as const` on `type` should satisfy the new optional `type` field).

- [ ] **Step 3: Commit**

```bash
git add src/shared/providers.ts
git commit -m "feat(providers): add openai_codex provider definition with codex_oauth type"
```

---

### Task 3: Add IPC channel constants

**Files:**
- Modify: `src/shared/channels.ts:222-224` (append before closing `} as const`)

- [ ] **Step 1: Add Codex channel constants**

Insert before line 224 (`} as const;`):

```typescript
  // Codex OAuth
  CODEX_START_AUTH: "codex:start-auth",
  CODEX_CANCEL_AUTH: "codex:cancel-auth",
  CODEX_AUTH_STATUS: "codex:auth-status",
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`

- [ ] **Step 3: Commit**

```bash
git add src/shared/channels.ts
git commit -m "feat(ipc): add Codex OAuth IPC channel constants"
```

---

### Task 4: Implement OAuth flow module

**Files:**
- Create: `src/main/ai/codex-oauth.ts`

- [ ] **Step 1: Create `src/main/ai/codex-oauth.ts`**

```typescript
import http from "http";
import crypto from "crypto";
import type { CodexOAuthTokens, CodexAuthStatus } from "../../shared/types";
import { createLogger } from "../../shared/logger";

const logger = createLogger("CodexOAuth");

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PORT_RETRIES = 5;

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
  const codeVerifier = base64url(crypto.randomBytes(32));
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
    codex_cli_simplified_flow: "true",
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
    // OpenAI id_token has chatgpt_account_id claim
    const accountId =
      payload.chatgpt_account_id ||
      payload.sub ||
      "";
    const email = payload.email || undefined;
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

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    expiresAt,
    accountId: claims?.accountId || "",
    accountEmail: claims?.email,
  };
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<CodexOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
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

  const idToken = data.id_token || "";
  const claims = idToken ? parseJwtClaims(idToken) : null;
  const expiresAt = parseTokenExpiry(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    idToken,
    expiresAt,
    accountId: claims?.accountId || "",
    accountEmail: claims?.email,
  };
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
        const redirectUri = `http://localhost:${port}/auth/callback`;
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

async function bindServer(
  server: http.Server,
  startPort: number,
): Promise<number> {
  for (let attempt = 0; attempt < MAX_PORT_RETRIES; attempt++) {
    const port = startPort + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(port, "127.0.0.1", () => resolve());
        server.once("error", reject);
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
    `Could not find an available port in range ${startPort}–${startPort + MAX_PORT_RETRIES - 1}`,
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

    const wrappedResolve = (tokens: CodexOAuthTokens) => {
      if (settled) return;
      settled = true;
      cleanup();
      onStatus("connected");
      resolve(tokens);
    };

    const wrappedReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      onStatus("error", err.message);
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

    bindServer(server, 1455)
      .then((port) => {
        if (settled) return; // timed out before bind completed
        activeFlow!.port = port;
        const authUrl = buildAuthorizeUrl(port, pkce, state);
        onStatus("waiting");

        // Open in default browser
        const { shell } = require("electron");
        shell.openExternal(authUrl).catch((err: Error) => {
          logger.warn("Failed to open browser, user will need the URL:", err);
          // Still resolve — user can copy the URL from logs
        });
      })
      .catch(wrappedReject);
  });
}

export function cancelCodexOAuth(): void {
  if (!activeFlow) return;
  activeFlow.server.close();
  if (activeFlow.timeout) clearTimeout(activeFlow.timeout);
  activeFlow.onStatus("idle");
  activeFlow = null;
}

export function isCodexAuthInProgress(): boolean {
  return activeFlow !== null;
}

export { refreshAccessToken };
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: No errors. May warn about `require("electron")` — that's fine, it's resolved at runtime in the main process.

- [ ] **Step 3: Commit**

```bash
git add src/main/ai/codex-oauth.ts
git commit -m "feat(codex): implement OAuth flow with PKCE, localhost callback server, and token exchange"
```

---

### Task 5: Add Codex token storage to settings

**Files:**
- Modify: `src/main/config/settings.ts`

- [ ] **Step 1: Add constant and import at top of file**

Add import on line 1 (add `CodexOAuthTokens` to the shared/types import):

```typescript
import type {
  CodexOAuthTokens,
  ProviderConfig,
  ReasoningEffortLevel,
  RuntimeHealthIssue,
  VesselSettings,
} from "../../shared/types";
```

Add constant after `CHAT_PROVIDER_SECRET_FILENAME` (after line 39):

```typescript
const CODEX_TOKENS_FILENAME = "vessel-codex-tokens";
```

- [ ] **Step 2: Add Codex token functions after `clearStoredProviderSecret` (after line 118)**

```typescript
function getCodexTokensPath(): string {
  return path.join(getUserDataPath(), CODEX_TOKENS_FILENAME);
}

export function readStoredCodexTokens(): CodexOAuthTokens | null {
  try {
    const raw = fs.readFileSync(getCodexTokensPath());
    const decoded =
      canUseSafeStorage() && safeStorage.decryptString
        ? safeStorage.decryptString(raw)
        : raw.toString("utf-8");
    const parsed = JSON.parse(decoded) as CodexOAuthTokens;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.accessToken === "string" &&
      typeof parsed.refreshToken === "string"
    ) {
      return parsed;
    }
  } catch {
    // Ignore missing or unreadable tokens.
  }
  return null;
}

export function writeStoredCodexTokens(tokens: CodexOAuthTokens): void {
  const filePath = getCodexTokensPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify(tokens);
  if (canUseSafeStorage()) {
    const encrypted = safeStorage.encryptString(payload);
    fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
    return;
  }
  fs.writeFileSync(filePath, payload, { mode: 0o600 });
}

export function clearStoredCodexTokens(): void {
  try {
    fs.unlinkSync(getCodexTokensPath());
  } catch {
    // Token file may not exist.
  }
}
```

- [ ] **Step 3: Update `getRendererSettings` to add hasApiKey for codex provider (line 156)**

Replace the `getRendererSettings` function body (lines 156-168). The current function already strips `apiKey` and sets `hasApiKey`. We need to also handle the codex case where tokens exist but apiKey is empty:

```typescript
export function getRendererSettings(): VesselSettings {
  const current = loadSettings();
  const provider = current.chatProvider;
  const hasCodexTokens = provider?.id === "openai_codex" && readStoredCodexTokens() !== null;
  return {
    ...current,
    chatProvider: provider
      ? {
          ...provider,
          apiKey: "",
          hasApiKey: Boolean(provider.apiKey) || hasCodexTokens,
        }
      : null,
  };
}
```

- [ ] **Step 4: Update `setSetting` to handle codex provider disconnect (around line 290)**

In the `setSetting` function, when `key === "chatProvider"` and `nextProvider` is null or switching away from codex, we should NOT clear codex tokens (per spec — tokens survive provider switches). Only clear when explicitly disconnecting. No change needed — the existing logic only touches the API key secret file, not the codex tokens file.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`

- [ ] **Step 6: Commit**

```bash
git add src/main/config/settings.ts
git commit -m "feat(codex): add secure token storage functions for Codex OAuth tokens"
```

---

### Task 6: Implement CodexProvider

**Files:**
- Create: `src/main/ai/provider-codex.ts`

- [ ] **Step 1: Create `src/main/ai/provider-codex.ts`**

```typescript
import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import type { AIMessage, CodexOAuthTokens, ReasoningEffortLevel } from "../../shared/types";
import type { AIProvider } from "./provider";
import type { AgentToolProfile } from "./tool-profile";
import { refreshAccessToken } from "./codex-oauth";
import { readStoredCodexTokens, writeStoredCodexTokens, clearStoredCodexTokens } from "../config/settings";
import { createLogger } from "../../shared/logger";

const logger = createLogger("CodexProvider");

const REFRESH_WINDOW_MS = 5 * 60 * 1000; // refresh if expiring within 5 min

export class CodexProvider implements AIProvider {
  readonly agentToolProfile: AgentToolProfile;
  private tokens: CodexOAuthTokens;
  private model: string;
  private baseUrl: string;
  private abortController: AbortController | null = null;

  constructor(tokens: CodexOAuthTokens, model: string, baseUrl?: string) {
    this.tokens = tokens;
    this.model = model;
    this.baseUrl = baseUrl || "https://api.openai.com/v1";
    this.agentToolProfile = "default";
  }

  private async ensureFreshTokens(): Promise<void> {
    if (Date.now() < this.tokens.expiresAt - REFRESH_WINDOW_MS) return;

    try {
      logger.info("Refreshing Codex access token");
      const fresh = await refreshAccessToken(this.tokens.refreshToken);
      this.tokens = fresh;
      writeStoredCodexTokens(fresh);
    } catch (err) {
      clearStoredCodexTokens();
      throw new Error(
        `Codex token refresh failed — please re-authenticate. ${err instanceof Error ? err.message : ""}`,
      );
    }
  }

  private createClient(): OpenAI {
    return new OpenAI({
      apiKey: this.tokens.accessToken,
      baseURL: this.baseUrl,
    });
  }

  async streamQuery(
    systemPrompt: string,
    userMessage: string,
    onChunk: (text: string) => void,
    onEnd: () => void,
    history?: AIMessage[],
  ): Promise<void> {
    await this.ensureFreshTokens();
    this.abortController = new AbortController();

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (history) {
      for (const msg of history) {
        messages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      }
    }

    messages.push({ role: "user", content: userMessage });

    try {
      const stream = await this.createClient().chat.completions.create(
        {
          model: this.model,
          messages,
          stream: true,
        },
        { signal: this.abortController.signal },
      );

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) onChunk(delta);
      }

      onEnd();
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "AbortError") {
        onEnd();
        return;
      }
      logger.error("Codex streamQuery error:", err);
      onEnd();
    }
  }

  async streamAgentQuery(
    systemPrompt: string,
    userMessage: string,
    tools: Anthropic.Tool[],
    onChunk: (text: string) => void,
    onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>,
    onEnd: () => void,
    history?: AIMessage[],
  ): Promise<void> {
    await this.ensureFreshTokens();
    this.abortController = new AbortController();

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (history) {
      for (const msg of history) {
        if (msg.role === "tool") {
          messages.push({
            role: "tool",
            tool_call_id: msg.toolCallId || "",
            content: msg.content,
          });
        } else {
          messages.push({
            role: msg.role as "user" | "assistant",
            content: msg.content,
          });
        }
      }
    }

    messages.push({ role: "user", content: userMessage });

    // Convert Anthropic tools to OpenAI format
    const openaiTools: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map(
      (tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.input_schema as Record<string, unknown>,
        },
      }),
    );

    try {
      let continueLoop = true;
      let currentMessages = [...messages];

      while (continueLoop) {
        const stream = await this.createClient().chat.completions.create(
          {
            model: this.model,
            messages: currentMessages,
            tools: openaiTools,
            stream: true,
          },
          { signal: this.abortController.signal },
        );

        let contentBuffer = "";
        const toolCalls: Map<
          number,
          { id: string; name: string; args: string }
        > = new Map();

        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            contentBuffer += delta.content;
            onChunk(delta.content);
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, {
                  id: tc.id || "",
                  name: tc.function?.name || "",
                  args: tc.function?.arguments || "",
                });
              } else {
                const existing = toolCalls.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
              }
            }
          }
        }

        if (toolCalls.size === 0) {
          continueLoop = false;
        } else {
          // Execute tool calls
          const assistantMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
            role: "assistant",
            content: contentBuffer || null,
            tool_calls: Array.from(toolCalls.entries()).map(([idx, tc]) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.args },
            })),
          };
          currentMessages.push(assistantMsg);

          for (const [, tc] of toolCalls) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.args);
            } catch {
              // pass empty args
            }
            const result = await onToolCall(tc.name, args);
            currentMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result,
            });
          }
        }
      }

      onEnd();
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "AbortError") {
        onEnd();
        return;
      }
      logger.error("Codex streamAgentQuery error:", err);
      onEnd();
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/ai/provider-codex.ts
git commit -m "feat(codex): implement CodexProvider with token refresh and agent tool calling"
```

---

### Task 7: Update provider factory

**Files:**
- Modify: `src/main/ai/provider.ts`

- [ ] **Step 1: Add import for CodexProvider and settings functions**

At the top of the file (after line 12):

```typescript
import { CodexProvider } from "./provider-codex";
import { readStoredCodexTokens } from "../config/settings";
```

- [ ] **Step 2: Update `validateProviderConnection` to skip API key check for codex_oauth type**

In `validateProviderConnection` (line 66), change the `requiresApiKey` check at line 77 from:

```typescript
  if (meta.requiresApiKey && !normalized.apiKey) {
```

to:

```typescript
  if (meta.type !== "codex_oauth" && meta.requiresApiKey && !normalized.apiKey) {
```

- [ ] **Step 3: Add codex branch in `createProvider` (after line 218, before the OpenAICompatProvider fallback)**

```typescript
  if (normalized.id === "openai_codex") {
    const tokens = readStoredCodexTokens();
    if (!tokens) {
      throw new Error(
        "OpenAI Codex requires authentication. Open settings to connect your ChatGPT account.",
      );
    }
    return new CodexProvider(tokens, normalized.model, normalized.baseUrl);
  }
```

- [ ] **Step 4: Update `fetchProviderModels` to handle codex provider (after line 184)**

After the Anthropic branch check (line 178-181) and before the general `meta` lookup, add:

```typescript
  if (normalized.id === "openai_codex") {
    const tokens = readStoredCodexTokens();
    if (!tokens) {
      throw new Error("Codex provider requires authentication. Connect your ChatGPT account in settings.");
    }
    const client = new OpenAI({
      apiKey: tokens.accessToken,
      baseURL: normalized.baseUrl || "https://api.openai.com/v1",
    });
    const page = await client.models.list();
    return okResult({ models: page.data.map((model) => model.id) });
  }
```

Insert this right after line 181 (`}` closing the Anthropic fetch block) and before line 184 (`const meta = PROVIDERS[normalized.id];`).

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/provider.ts
git commit -m "feat(codex): wire CodexProvider into createProvider factory and model fetch"
```

---

### Task 8: Implement Codex IPC handlers

**Files:**
- Create: `src/main/ipc/codex.ts`

- [ ] **Step 1: Create `src/main/ipc/codex.ts`**

```typescript
import { ipcMain, BrowserWindow } from "electron";
import { Channels } from "../../shared/channels";
import { startCodexOAuth, cancelCodexOAuth } from "../ai/codex-oauth";
import { writeStoredCodexTokens, clearStoredCodexTokens } from "../config/settings";
import type { CodexAuthStatus } from "../../shared/types";
import { createLogger } from "../../shared/logger";

const logger = createLogger("CodexIPC");

export function registerCodexHandlers(): void {
  ipcMain.handle(Channels.CODEX_START_AUTH, async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error("No window found for sender");

      const sendStatus = (status: CodexAuthStatus, error?: string) => {
        win.webContents.send(Channels.CODEX_AUTH_STATUS, { status, error: error || null });
      };

      const tokens = await startCodexOAuth(sendStatus);
      writeStoredCodexTokens(tokens);

      return {
        ok: true as const,
        accountEmail: tokens.accountEmail || tokens.accountId,
        accountId: tokens.accountId,
      };
    } catch (err) {
      logger.error("Codex auth failed:", err);
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  });

  ipcMain.handle(Channels.CODEX_CANCEL_AUTH, () => {
    cancelCodexOAuth();
    return { ok: true };
  });

  ipcMain.handle("codex:disconnect", () => {
    clearStoredCodexTokens();
    return { ok: true };
  });
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/codex.ts
git commit -m "feat(codex): add IPC handlers for Codex OAuth start/cancel/disconnect"
```

---

### Task 9: Register Codex handlers in handlers.ts

**Files:**
- Modify: `src/main/ipc/handlers.ts`

- [ ] **Step 1: Add import at top (after line 50 around kit-registry import)**

```typescript
import { registerCodexHandlers } from "./codex";
```

- [ ] **Step 2: Find the handler registration section and add codex registration**

Look for where other register functions are called (e.g., `registerSecurityHandlers`, `registerPremiumHandlers`). Add after one of those calls:

```typescript
  registerCodexHandlers();
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/handlers.ts
git commit -m "feat(codex): register Codex IPC handlers"
```

---

### Task 10: Expose Codex API in preload bridge

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add `codex` API after the `pip` section (after line 622, before the closing `};`)**

```typescript
  codex: {
    startAuth: (): Promise<
      { ok: true; accountEmail: string; accountId: string } |
      { ok: false; error: string }
    > => ipcRenderer.invoke(Channels.CODEX_START_AUTH),
    cancelAuth: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(Channels.CODEX_CANCEL_AUTH),
    disconnect: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("codex:disconnect"),
    onAuthStatus: (
      cb: (payload: { status: string; error: string | null }) => void,
    ): (() => void) => {
      const handler = (
        _: unknown,
        payload: { status: string; error: string | null },
      ) => cb(payload);
      ipcRenderer.on(Channels.CODEX_AUTH_STATUS, handler);
      return () =>
        ipcRenderer.removeListener(Channels.CODEX_AUTH_STATUS, handler);
    },
  },
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(codex): expose codex OAuth API in preload bridge"
```

---

### Task 11: Extend ChatProps with Codex auth state

**Files:**
- Modify: `src/renderer/src/components/shared/settingsTypes.ts`

- [ ] **Step 1: Add to `ChatProps` interface (after line 97)**

Add these fields to `ChatProps` (after `resetProviderModels` on line 96):

```typescript
  codexAuthStatus: Accessor<"idle" | "waiting" | "exchanging" | "connected" | "error">;
  codexAccountEmail: Accessor<string>;
  setCodexAccountEmail: Setter<string>;
  codexAuthError: Accessor<string>;
  setCodexAuthError: Setter<string>;
  providerType: Accessor<"direct_sdk" | "compatible" | "codex_oauth" | undefined>;
  startCodexAuth: () => Promise<void>;
  disconnectCodex: () => Promise<void>;
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/shared/settingsTypes.ts
git commit -m "feat(codex): extend ChatProps with Codex OAuth state fields"
```

---

### Task 12: Add Codex auth signals in Settings.tsx

**Files:**
- Modify: `src/renderer/src/components/shared/Settings.tsx`

- [ ] **Step 1: Add Codex auth state signals after existing chat signals (after line 363)**

Add after `const [modelFetchWarning, setModelFetchWarning] = createSignal<string | null>(null);` on line 363:

```typescript
  const [codexAuthStatus, setCodexAuthStatus] = createSignal<"idle" | "waiting" | "exchanging" | "connected" | "error">("idle");
  const [codexAccountEmail, setCodexAccountEmail] = createSignal("");
  const [codexAuthError, setCodexAuthError] = createSignal("");
```

- [ ] **Step 2: Derive `providerType` from the selected provider's meta**

Add after `const chatProviderMeta = () => ...` on line 359:

```typescript
  const providerType = () => chatProviderMeta()?.type;
```

- [ ] **Step 3: Add `startCodexAuth` function after `doFetchModels` (after line 406)**

```typescript
  const startCodexAuth = async () => {
    setCodexAuthStatus("waiting");
    setCodexAuthError("");
    try {
      const result = await window.vessel.codex.startAuth();
      if (result.ok) {
        setCodexAccountEmail(result.accountEmail);
        setCodexAuthStatus("connected");
        setChatHasStoredApiKey(true);
      } else {
        setCodexAuthStatus("error");
        setCodexAuthError(result.error);
      }
    } catch (err) {
      setCodexAuthStatus("error");
      setCodexAuthError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const disconnectCodex = async () => {
    await window.vessel.codex.disconnect();
    setCodexAuthStatus("idle");
    setCodexAccountEmail("");
    setChatHasStoredApiKey(false);
  };
```

- [ ] **Step 4: Listen for auth status events on mount**

Look for where `onMount` is used for settings initialization (around the settings load effect). Add inside the settings load effect or in a new `onMount`:

In the existing settings load effect (where `window.vessel.settings.get()` is called), after loading settings, add:

```typescript
    // Listen for codex auth status events
    const unsubCodex = window.vessel.codex.onAuthStatus((payload) => {
      if (payload.status === "waiting") {
        setCodexAuthStatus("waiting");
      } else if (payload.status === "exchanging") {
        setCodexAuthStatus("exchanging");
      } else if (payload.status === "connected") {
        // handled by the startAuth promise
      } else if (payload.status === "error") {
        setCodexAuthStatus("error");
        setCodexAuthError(payload.error || "Unknown error");
      }
    });
```

And add the cleanup in the same effect's return. If the effect already returns a cleanup, merge with it.

- [ ] **Step 5: Check if `hasStoredApiKey` should initialize codex state**

In the settings load effect where provider is restored, check if the stored provider is `openai_codex` with `hasApiKey: true`. If so, we can't know the email until the user interacts, so default to showing "Connected" state. Add after the provider state restoration:

```typescript
    if (loaded.chatProvider?.id === "openai_codex" && loaded.chatProvider.hasApiKey) {
      setCodexAuthStatus("connected");
    }
```

- [ ] **Step 6: Pass new codex props to `SettingsAgent` at line 711**

Add the new codex fields to the `chat` object literal at lines 712-732 (inside `<SettingsAgent chat={{...}}`). Add after `resetProviderModels` on line 731:

```tsx
                    codexAuthStatus,
                    codexAccountEmail,
                    setCodexAccountEmail,
                    codexAuthError,
                    setCodexAuthError,
                    providerType,
                    startCodexAuth,
                    disconnectCodex,
```

The chat object will look like:

```tsx
                  chat={{
                    enabled: chatEnabled,
                    setEnabled: setChatEnabled,
                    providerId: chatProviderId,
                    setProviderId: setChatProviderId,
                    apiKey: chatApiKey,
                    setApiKey: setChatApiKey,
                    hasStoredApiKey: chatHasStoredApiKey,
                    setHasStoredApiKey: setChatHasStoredApiKey,
                    model: chatModel,
                    setModel: setChatModel,
                    baseUrl: chatBaseUrl,
                    setBaseUrl: setChatBaseUrl,
                    reasoningEffort: chatReasoningEffort,
                    setReasoningEffort: setChatReasoningEffort,
                    providerModels,
                    modelFetchState,
                    modelFetchWarning,
                    doFetchModels,
                    resetProviderModels,
                    codexAuthStatus,
                    codexAccountEmail,
                    setCodexAccountEmail,
                    codexAuthError,
                    setCodexAuthError,
                    providerType,
                    startCodexAuth,
                    disconnectCodex,
                  }}
```

- [ ] **Step 7: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/shared/Settings.tsx
git commit -m "feat(codex): add Codex auth signals and handlers in Settings"
```

---

### Task 13: Update SettingsAgent.tsx for Codex OAuth UI

**Files:**
- Modify: `src/renderer/src/components/shared/SettingsAgent.tsx`

- [ ] **Step 1: Replace the API key section for Codex (lines 90-138)**

The current code shows API key input when `chatMeta().requiresKey || props.chat.providerId() === "custom"`. For Codex, we need to show the OAuth button instead.

Wrap the existing API key `<Show>` (line 90) with a condition — show API key for non-codex providers, show OAuth UI for codex:

Change the `<Show when={...}>` on line 91-95 to include a codex exclusion:

```tsx
        <Show when={chatMeta().requiresKey || props.chat.providerId() === "custom"}>
```

becomes:

```tsx
        <Show when={props.chat.providerType() === "codex_oauth"}>
          <div class="settings-field">
            <label class="settings-label">Account</label>
            <Show
              when={props.chat.codexAuthStatus() === "connected"}
              fallback={
                <div>
                  <Show
                    when={
                      props.chat.codexAuthStatus() === "waiting" ||
                      props.chat.codexAuthStatus() === "exchanging"
                    }
                    fallback={
                      <div>
                        <button
                          type="button"
                          class="settings-btn"
                          onClick={() => props.chat.startCodexAuth()}
                          disabled={props.chat.codexAuthStatus() === "waiting" || props.chat.codexAuthStatus() === "exchanging"}
                        >
                          Connect with ChatGPT
                        </button>
                        <p class="settings-hint">
                          Sign in with your ChatGPT Plus or Pro subscription. A
                          browser tab will open where you'll authorize Vessel.
                        </p>
                        <Show when={props.chat.codexAuthStatus() === "error"}>
                          <p class="settings-hint" style="color:var(--error)">
                            {props.chat.codexAuthError()}
                          </p>
                          <button
                            type="button"
                            class="settings-btn"
                            onClick={() => props.chat.startCodexAuth()}
                          >
                            Try Again
                          </button>
                        </Show>
                      </div>
                    }
                  >
                    <p class="settings-hint" style="color:var(--accent-primary)">
                      <Show
                        when={props.chat.codexAuthStatus() === "waiting"}
                        fallback="Exchanging authorization..."
                      >
                        Waiting for browser login...
                      </Show>
                      {" "}
                      <button
                        type="button"
                        class="settings-link-btn"
                        onClick={() => window.vessel.codex.cancelAuth()}
                      >
                        Cancel
                      </button>
                    </p>
                  </Show>
                </div>
              }
            >
              <div style="display:flex;align-items:center;gap:8px">
                <span
                  style="width:8px;height:8px;border-radius:50%;background:var(--success);display:inline-block"
                />
                <span>
                  Connected as {props.chat.codexAccountEmail() || "ChatGPT"}
                </span>
              </div>
              <p class="settings-hint">
                <button
                  type="button"
                  class="settings-link-btn"
                  onClick={() => props.chat.disconnectCodex()}
                >
                  Disconnect
                </button>
              </p>
            </Show>
          </div>
        </Show>
        <Show when={props.chat.providerType() !== "codex_oauth" && (chatMeta().requiresKey || props.chat.providerId() === "custom")}>
          {/* existing API key input block (lines 96-137) stays here */}
```

This keeps the existing API key input for all non-codex providers and adds the OAuth UI for Codex.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/shared/SettingsAgent.tsx
git commit -m "feat(codex): add OAuth connect/disconnect UI in SettingsAgent"
```

---

### Task 14: Final integration test

**Files:**
- All of the above

- [ ] **Step 1: Run full typecheck across both tsconfigs**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.json`
Expected: No errors.

- [ ] **Step 2: Run existing tests**

Run: `npm test`
Expected: All existing tests pass.

- [ ] **Step 3: Verify `gitnexus_detect_changes`**

Run the GitNexus MCP tool `detect_changes` to verify only expected symbols are affected.

- [ ] **Step 4: Final commit (if any minor fixes needed)**

```bash
git add -A
git commit -m "chore(codex): final typecheck and test pass"
```
