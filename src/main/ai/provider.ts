import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AIMessage, ProviderConfig } from "../../shared/types";
import { AnthropicProvider } from "./provider-anthropic";
import { OpenAICompatProvider } from "./provider-openai";
import { PROVIDERS } from "./providers";

export interface AIProvider {
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
    tools: any[],
    onChunk: (text: string) => void,
    onToolCall: (name: string, args: Record<string, any>) => Promise<string>,
    onEnd: () => void,
  ): Promise<void>;

  cancel(): void;
}

export function sanitizeProviderConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
    baseUrl: config.baseUrl?.trim() || undefined,
  };
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

export async function fetchProviderModels(
  config: ProviderConfig,
): Promise<string[]> {
  const normalized = sanitizeProviderConfig(config);
  const error = validateProviderConnection(normalized, { requireModel: false });
  if (error) {
    throw new Error(error);
  }

  if (normalized.id === "anthropic") {
    const client = new Anthropic({ apiKey: normalized.apiKey });
    const page = await client.models.list();
    return page.data.map((model) => model.id);
  }

  const meta = PROVIDERS[normalized.id];
  const baseURL =
    normalized.baseUrl || meta?.defaultBaseUrl || "https://api.openai.com/v1";
  const client = new OpenAI({
    apiKey: normalized.apiKey || "ollama",
    baseURL,
  });
  const page = await client.models.list();
  return page.data.map((model) => model.id);
}

export function createProvider(config: ProviderConfig): AIProvider {
  const normalized = sanitizeProviderConfig(config);
  const error = validateProviderConfig(normalized);
  if (error) {
    throw new Error(error);
  }

  if (normalized.id === "anthropic") {
    return new AnthropicProvider(normalized.apiKey, normalized.model);
  }

  return new OpenAICompatProvider(normalized);
}
