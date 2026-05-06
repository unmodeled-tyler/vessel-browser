import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  AIMessage,
  ProviderConfig,
  ProviderModelsResult,
  ReasoningEffortLevel,
} from "../../shared/types";
import { okResult } from "../../shared/result";
import { AnthropicProvider } from "./provider-anthropic";
import { OpenAICompatProvider } from "./provider-openai";
import { PROVIDERS } from "../../shared/providers";
import type { AgentToolProfile } from "./tool-profile";
import { LLAMA_CPP_MIN_CTX_TOKENS, LLAMA_CPP_RECOMMENDED_CTX_TOKENS } from "./content-limits";

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

export function sanitizeProviderConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
    baseUrl: config.baseUrl?.trim() || undefined,
    reasoningEffort: sanitizeReasoningEffortLevel(config.reasoningEffort),
  };
}

export function sanitizeReasoningEffortLevel(
  value: unknown,
): ReasoningEffortLevel {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max" ||
    value === "off"
    ? value
    : "off";
}

export function validateProviderConfig(config: ProviderConfig): string | null {
  return validateProviderConnection(config, { requireModel: true });
}

export function validateProviderConnection(
  config: ProviderConfig,
  options: { requireModel: boolean } = { requireModel: true },
): string | null {
  const normalized = sanitizeProviderConfig(config);
  const meta = PROVIDERS[normalized.id];

  if (!meta) {
    return "Selected AI provider is not supported.";
  }

  if (meta.requiresApiKey && !normalized.apiKey) {
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

export async function fetchProviderModels(
  config: ProviderConfig,
): Promise<ProviderModelsResult> {
  const normalized = sanitizeProviderConfig(config);
  const error = validateProviderConnection(normalized, { requireModel: false });
  if (error) {
    throw new Error(error);
  }

  if (normalized.id === "anthropic") {
    const client = new Anthropic({ apiKey: normalized.apiKey });
    const page = await client.models.list();
    return okResult({ models: page.data.map((model) => model.id) });
  }

  const meta = PROVIDERS[normalized.id];
  const baseURL =
    normalized.baseUrl || meta?.defaultBaseUrl || "https://api.openai.com/v1";
  const client = new OpenAI({
    apiKey: normalized.apiKey || "ollama",
    baseURL,
  });
  const page = await client.models.list();
  const models = page.data.map((model) => model.id);
  const warning =
    normalized.id === "llama_cpp"
      ? await probeLlamaCppCtxWarning(baseURL)
      : undefined;
  return {
    ...okResult({
      models,
      ...(warning ? { warning } : {}),
    }),
  };
}

export function createProvider(config: ProviderConfig): AIProvider {
  const normalized = sanitizeProviderConfig(config);
  const error = validateProviderConfig(normalized);
  if (error) {
    throw new Error(error);
  }

  if (normalized.id === "anthropic") {
    return new AnthropicProvider(
      normalized.apiKey,
      normalized.model,
      normalized.reasoningEffort,
    );
  }

  return new OpenAICompatProvider(normalized);
}
