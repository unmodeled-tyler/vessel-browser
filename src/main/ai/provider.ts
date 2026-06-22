import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  AIMessage,
  CodexOAuthTokens,
  ProviderConfig,
  ProviderId,
  ProviderModelsResult,
  ReasoningEffortLevel,
} from "../../shared/types";
import { okResult } from "../../shared/result";
import { AnthropicProvider } from "./provider-anthropic";
import { OpenAICompatProvider } from "./provider-openai";
import { PROVIDERS } from "../../shared/providers";
import { CodexProvider, CODEX_CLIENT_VERSION } from "./provider-codex";
import { refreshAccessToken } from "./codex-oauth";
import {
  clearStoredCodexTokens,
  readStoredCodexTokens,
  writeStoredCodexTokens,
} from "../config/settings";
import { isAirGapped, isLocalProvider, isLocalBaseUrl } from "../config/air-gapped";
import type { AgentToolProfile } from "./tool-profile";
import { LLAMA_CPP_MIN_CTX_TOKENS, LLAMA_CPP_RECOMMENDED_CTX_TOKENS } from "./content-limits";

const CODEX_DISCOVERY_REFRESH_WINDOW_MS = 5 * 60 * 1000;

class CodexBackendModelDiscoveryError extends Error {
  constructor(readonly status: number) {
    super(`Codex backend model discovery failed: ${status}`);
  }
}

export interface AIProvider {
  readonly agentToolProfile: AgentToolProfile;

  streamQuery(
    systemPrompt: string,
    userMessage: string,
    onChunk: (text: string) => void,
    onEnd: () => void,
    history?: AIMessage[],
  ): Promise<void>;

  streamAgentQuery?(
    systemPrompt: string,
    userMessage: string,
    tools: Anthropic.Tool[],
    onChunk: (text: string) => void,
    onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>,
    onEnd: () => void,
    history?: AIMessage[],
  ): Promise<void>;

  cancel(): void;
}

function sanitizeProviderConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
    baseUrl: config.baseUrl?.trim() || undefined,
    reasoningEffort: sanitizeReasoningEffortLevel(config.reasoningEffort),
  };
}

function sanitizeReasoningEffortLevel(value: unknown): ReasoningEffortLevel {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max" ||
    value === "off"
    ? value
    : "off";
}

function validateProviderConfig(config: ProviderConfig): string | null {
  return validateProviderConnection(config, { requireModel: true });
}

function validateProviderConnection(
  config: ProviderConfig,
  options: { requireModel: boolean } = { requireModel: true },
): string | null {
  const normalized = sanitizeProviderConfig(config);
  const meta = PROVIDERS[normalized.id];

  if (!meta) {
    return "Selected AI provider is not supported.";
  }

  if (isAirGapped()) {
    if (meta.id === "custom") {
      if (!isLocalBaseUrl(normalized.baseUrl)) {
        return "Air-gapped mode only allows local AI providers. Use a localhost base URL for custom providers.";
      }
    } else if (!isLocalProvider(meta.id)) {
      return `Air-gapped mode only allows local AI providers (Ollama, llama.cpp). ${meta.name} requires internet access.`;
    }
  }

  if (meta.type !== "codex_oauth" && meta.requiresApiKey && !normalized.apiKey) {
    return `${meta.name} requires an API key. Open settings (Ctrl+,) to add one.`;
  }

  if (options.requireModel && !normalized.model) {
    return normalized.id === "custom"
      ? "Custom provider requires a model name."
      : `Select a ${meta.name} model in settings.`;
  }

  if (normalized.id === "custom" && !normalized.baseUrl) {
    return "Custom provider requires a base URL.";
  }

  return null;
}

export function extractLlamaCppCtxSize(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;

  const visited = new Set<unknown>();
  const queue: unknown[] = [payload];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);

    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        /^(n_ctx|ctx_size|context_size)$/i.test(key)
      ) {
        return value;
      }

      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return null;
}

export function buildLlamaCppCtxWarning(ctxSize: number | null): string | undefined {
  if (ctxSize == null) {
    return (
      `Could not detect llama-server context size. ` +
      `Run llama-server with --ctx-size ${LLAMA_CPP_MIN_CTX_TOKENS} minimum ` +
      `(${LLAMA_CPP_RECOMMENDED_CTX_TOKENS} recommended for Vessel agent loops).`
    );
  }

  if (ctxSize < LLAMA_CPP_MIN_CTX_TOKENS) {
    return (
      `Detected llama-server ctx-size ${ctxSize}, which is too small for reliable Vessel agent loops. ` +
      `Run llama-server with --ctx-size ${LLAMA_CPP_MIN_CTX_TOKENS} minimum ` +
      `(${LLAMA_CPP_RECOMMENDED_CTX_TOKENS} recommended).`
    );
  }

  if (ctxSize < LLAMA_CPP_RECOMMENDED_CTX_TOKENS) {
    return (
      `Detected llama-server ctx-size ${ctxSize}. This should work, but ${LLAMA_CPP_RECOMMENDED_CTX_TOKENS} ` +
      `is recommended for longer Vessel agent runs.`
    );
  }

  return undefined;
}

async function fetchCodexBackendModels(tokens: CodexOAuthTokens): Promise<string[]> {
  const url = new URL("https://chatgpt.com/backend-api/codex/models");
  url.searchParams.set("client_version", CODEX_CLIENT_VERSION);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.accessToken}`,
    originator: "codex_cli_rs",
    "User-Agent": `codex_cli_rs/${CODEX_CLIENT_VERSION} Vessel`,
  };
  if (tokens.accountId) {
    headers["ChatGPT-Account-ID"] = tokens.accountId;
  }

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    throw new CodexBackendModelDiscoveryError(response.status);
  }

  const payload = (await response.json()) as { models?: unknown };
  if (!Array.isArray(payload.models)) {
    throw new Error("Codex backend model discovery returned an invalid response");
  }

  return payload.models
    .map((model): string | null => {
      if (!model || typeof model !== "object") return null;
      const record = model as Record<string, unknown>;
      const id = record.slug || record.id || record.model;
      const visibility = record.visibility;
      if (visibility === "hidden") return null;
      return typeof id === "string" && id.trim() ? id.trim() : null;
    })
    .filter((id): id is string => id !== null);
}

async function refreshCodexTokensForDiscovery(tokens: CodexOAuthTokens): Promise<CodexOAuthTokens> {
  try {
    const fresh = await refreshAccessToken(tokens);
    writeStoredCodexTokens(fresh);
    return fresh;
  } catch (err) {
    clearStoredCodexTokens();
    throw err;
  }
}

async function getFreshCodexTokensForDiscovery(
  tokens: CodexOAuthTokens,
): Promise<CodexOAuthTokens> {
  if (Date.now() < tokens.expiresAt - CODEX_DISCOVERY_REFRESH_WINDOW_MS) {
    return tokens;
  }
  return refreshCodexTokensForDiscovery(tokens);
}

async function fetchCodexBackendModelsWithRefresh(tokens: CodexOAuthTokens): Promise<string[]> {
  const freshTokens = await getFreshCodexTokensForDiscovery(tokens);
  try {
    return await fetchCodexBackendModels(freshTokens);
  } catch (err) {
    if (err instanceof CodexBackendModelDiscoveryError && err.status === 401) {
      return fetchCodexBackendModels(await refreshCodexTokensForDiscovery(freshTokens));
    }
    throw err;
  }
}

async function probeLlamaCppCtxWarning(baseURL: string): Promise<string | undefined> {
  try {
    const root = new URL(baseURL);
    root.pathname = "/props";
    root.search = "";
    root.hash = "";

    const response = await fetch(root.toString());
    if (!response.ok) {
      return buildLlamaCppCtxWarning(null);
    }

    const payload = await response.json();
    return buildLlamaCppCtxWarning(extractLlamaCppCtxSize(payload));
  } catch {
    return buildLlamaCppCtxWarning(null);
  }
}

export async function fetchProviderModels(config: ProviderConfig): Promise<ProviderModelsResult> {
  const normalized = sanitizeProviderConfig(config);
  const error = validateProviderConnection(normalized, { requireModel: false });
  if (error) {
    throw new Error(error);
  }

  const handler = PROVIDER_HANDLERS.get(normalized.id) ?? openAICompatHandler;
  return handler.listModels(normalized);
}

export function createProvider(config: ProviderConfig): AIProvider {
  const normalized = sanitizeProviderConfig(config);
  const error = validateProviderConfig(normalized);
  if (error) {
    throw new Error(error);
  }

  const handler = PROVIDER_HANDLERS.get(normalized.id) ?? openAICompatHandler;
  return handler.create(normalized);
}

interface ProviderHandlers {
  create(config: ProviderConfig): AIProvider;
  listModels(config: ProviderConfig): Promise<ProviderModelsResult>;
}

async function listAnthropicModels(config: ProviderConfig): Promise<ProviderModelsResult> {
  const client = new Anthropic({ apiKey: config.apiKey });
  const page = await client.models.list();
  return okResult({ models: page.data.map((model) => model.id) });
}

function createAnthropicProvider(config: ProviderConfig): AIProvider {
  return new AnthropicProvider(config.apiKey, config.model, config.reasoningEffort ?? "off");
}

async function listCodexModels(_config: ProviderConfig): Promise<ProviderModelsResult> {
  const tokens = readStoredCodexTokens();
  if (!tokens) {
    throw new Error(
      "Codex provider requires authentication. Connect your ChatGPT account in settings.",
    );
  }
  try {
    const models = await fetchCodexBackendModelsWithRefresh(tokens);
    if (models.length > 0) {
      return okResult({ models });
    }
    throw new Error("Codex backend model discovery returned no models");
  } catch (err) {
    return okResult({
      models: PROVIDERS.openai_codex.models,
      warning: `Using built-in Codex model list because live discovery failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    });
  }
}

function createCodexProvider(config: ProviderConfig): AIProvider {
  const tokens = readStoredCodexTokens();
  if (!tokens) {
    throw new Error(
      "OpenAI Codex requires authentication. Open settings to connect your ChatGPT account.",
    );
  }
  return new CodexProvider(tokens, config.model);
}

async function listOpenAICompatModels(config: ProviderConfig): Promise<ProviderModelsResult> {
  const meta = PROVIDERS[config.id];
  const baseURL = config.baseUrl || meta?.defaultBaseUrl || "https://api.openai.com/v1";
  const client = new OpenAI({
    apiKey: config.apiKey || "ollama",
    baseURL,
  });
  const page = await client.models.list();
  const models = page.data.map((model) => model.id);
  const warning = config.id === "llama_cpp" ? await probeLlamaCppCtxWarning(baseURL) : undefined;
  return {
    ...okResult({
      models,
      ...(warning ? { warning } : {}),
    }),
  };
}

function createOpenAICompatProvider(config: ProviderConfig): AIProvider {
  return new OpenAICompatProvider(config);
}

const anthropicHandler: ProviderHandlers = {
  create: createAnthropicProvider,
  listModels: listAnthropicModels,
};

const codexHandler: ProviderHandlers = {
  create: createCodexProvider,
  listModels: listCodexModels,
};

const openAICompatHandler: ProviderHandlers = {
  create: createOpenAICompatProvider,
  listModels: listOpenAICompatModels,
};

/**
 * Per-provider dispatch table. Providers not listed here fall through to
 * the OpenAI-compatible default handler. Add a provider by registering a
 * new entry here instead of editing the factory functions.
 */
const PROVIDER_HANDLERS: ReadonlyMap<ProviderId, ProviderHandlers> = new Map([
  ["anthropic", anthropicHandler],
  ["openai_codex", codexHandler],
]);
