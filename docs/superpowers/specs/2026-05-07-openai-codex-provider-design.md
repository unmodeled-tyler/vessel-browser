# Design: OpenAI Codex Inference Provider

## Summary

Add "OpenAI Codex" as a new inference provider that authenticates via browser-based OAuth (ChatGPT Plus/Pro subscription), matching the Codex CLI login flow. No API key needed — the user clicks "Connect with ChatGPT," authenticates in their browser, and Vessel receives OAuth tokens via a localhost callback server.

## Motivation

All 9 existing providers require API keys. The OpenAI Codex provider lets users leverage their existing ChatGPT subscription for inference without managing platform API keys. This is the same auth model used by Codex CLI and the ChatGPT ecosystem.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Settings UI │────▶│  IPC (main)  │────▶│  codex-oauth.ts │
│  "Connect"   │     │  CODEX_START │     │  localhost HTTP  │
│   button     │     │  _AUTH       │     │  server + PKCE   │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                                            auth.openai.com
                                                   │
┌─────────────┐     ┌──────────────┐     ┌────────▼────────┐
│  Chat / AI  │◀────│  provider-   │◀────│  safeStorage     │
│   queries   │     │  codex.ts    │     │  tokens at rest  │
└─────────────┘     └──────────────┘     └─────────────────┘
```

### OAuth Flow

1. User selects "OpenAI Codex" in Settings → clicks "Connect with ChatGPT"
2. Vessel generates PKCE codes (verifier + S256 challenge) + CSRF state token
3. Starts a localhost HTTP server on `127.0.0.1` with a dynamic port
4. Opens browser to `https://auth.openai.com/oauth/authorize?...` with all params
5. User signs in / authorizes in the browser
6. Browser redirected to `http://localhost:{port}/auth/callback?code=...&state=...`
7. Server validates state, POSTs code to `https://auth.openai.com/oauth/token`
8. Receives `{ access_token, refresh_token, id_token }`
9. Parses JWT from id_token for `chatgpt_account_id` and email
10. Persists tokens to encrypted safeStorage file
11. Returns success → browser shows "You're signed in" page → server shuts down
12. Settings UI updates to "Connected as user@domain.com"

### Token Refresh

- Before each API call, check `expiresAt` (within 5 min ⇒ refresh)
- POST to `/oauth/token` with `grant_type=refresh_token`
- If refresh fails → clear tokens, UI reverts to "Connect" state
- Refresh runs transparently during any provider method

### Inference

- Uses the `openai` npm SDK pointed at `https://api.openai.com/v1`
- Authenticated with `Authorization: Bearer <access_token>`
- Implements `AIProvider` interface: `streamQuery`, `streamAgentQuery`, `cancel`
- Agent tool calling via the standard OpenAI chat completions API

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `src/main/ai/codex-oauth.ts` | PKCE generation, localhost callback server, token exchange, OAuth flow orchestration |
| `src/main/ai/provider-codex.ts` | `CodexProvider` implementing `AIProvider`, token refresh, inference via OpenAI SDK |
| `src/main/ipc/codex.ts` | IPC handlers: `CODEX_START_AUTH`, `CODEX_CANCEL_AUTH` |

### Modified Files

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `"openai_codex"` to `ProviderId`, add `CodexOAuthTokens` type, add `CodexAuthStatus` enum |
| `src/shared/providers.ts` | Add `openai_codex` provider entry with `type: "codex_oauth"` |
| `src/shared/channels.ts` | Add `CODEX_START_AUTH`, `CODEX_CANCEL_AUTH`, `CODEX_AUTH_STATUS` channel constants |
| `src/main/ai/provider.ts` | Factory: branch on `"openai_codex"` → `CodexProvider`; skip API-key validation for oauth type |
| `src/main/config/settings.ts` | Add `readStoredCodexTokens()` / `writeStoredCodexTokens()` / `clearStoredCodexTokens()`; extend `mergeChatProviderSecret` for oauth tokens; strip tokens from renderer settings |
| `src/main/ipc/handlers.ts` | Register codex IPC handlers |
| `src/preload/index.ts` | Expose `vessel.codex.startAuth()`, `vessel.codex.cancelAuth()`, `vessel.codex.onAuthStatus()` |
| `src/renderer/src/components/shared/SettingsAgent.tsx` | Conditional rendering: OAuth button for `codex_oauth` type instead of API key input |
| `src/renderer/src/components/shared/settingsTypes.ts` | Extend `ChatProps` with codex auth state fields |

## Provider Definition

```typescript
// In PROVIDERS record:
openai_codex: {
  id: "openai_codex",
  name: "OpenAI Codex",
  type: "codex_oauth",
  defaultModel: "gpt-5",
  models: ["gpt-5", "gpt-5-mini", "gpt-5-nano", "o4", "o4-mini"],
  requiresApiKey: false,
  apiKeyPlaceholder: "",
  apiKeyHint: "Sign in with your ChatGPT Plus or Pro subscription",
}
```

## Types

```typescript
type ProviderId = /* existing */ | "openai_codex";

type ProviderType = "direct_sdk" | "compatible" | "codex_oauth";

interface CodexOAuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;       // epoch ms
  accountId: string;       // chatgpt_account_id from JWT
  accountEmail?: string;
}

type CodexAuthStatus = "idle" | "waiting" | "exchanging" | "connected" | "error";

// ProviderConfig already supports this — apiKey is "" for oauth,
// hasApiKey is derived from stored token presence
```

## OAuth Endpoints

| Endpoint | URL |
|----------|-----|
| Authorize | `https://auth.openai.com/oauth/authorize` |
| Token | `https://auth.openai.com/oauth/token` |
| Client ID | `app_EMoamEEZ73f0CkXaXp7hrann` |
| API base | `https://api.openai.com/v1` |

## Settings UI States

### Not connected
- "Connect with ChatGPT" button (primary action)
- Subtext: "Sign in with your ChatGPT Plus or Pro subscription"

### Auth in progress
- Spinner + "Waiting for browser login..."
- Cancel link
- 5-minute timeout auto-cancels

### Connected
- Green badge: "Connected"
- "Connected as user@domain.com"
- "Disconnect" link → clears tokens

### Error
- Red error message
- "Try again" button → restarts flow

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Port in use (EADDRINUSE) | Retry up to 5 alternative ports |
| User closes browser without auth | Timeout after 5 min, clean up server |
| State mismatch on callback | 400 response, show error in UI |
| Token exchange fails | Surface error_description from OAuth response |
| Access denied (missing entitlement) | Show "Codex not available for your account" |
| Refresh token expired | Clear stored tokens, prompt re-auth |
| Network error during inference | Standard error propagation (existing pattern) |

## Edge Cases

- **Switching providers**: If user switches from Codex to Anthropic, Codex tokens remain stored (not cleared) so switching back restores the session
- **Concurrent auth attempts**: If a login is already in progress, starting a new one cancels the first
- **App quit during auth**: `app.on('before-quit')` shuts down any active OAuth server
- **Account mismatch**: The id_token's `chatgpt_account_id` is stored; if a different account tries to connect, the old tokens are replaced

## Non-Goals

- Device code fallback (Approach B) — deferred, can be added later
- Multi-account support within Codex provider
- Workspace/org gating (`forced_chatgpt_workspace_id`)
- API key extraction from id_token via token exchange (Codex CLI does this but Vessel uses access_token directly)
