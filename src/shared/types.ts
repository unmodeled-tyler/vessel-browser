export interface TabState {
  id: string;
  title: string;
  url: string;
  favicon: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isReaderMode: boolean;
}

export interface PageContent {
  title: string;
  content: string;
  htmlContent: string;
  byline: string;
  excerpt: string;
  url: string;
}

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

export interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  focusMode: boolean;
  settingsOpen: boolean;
}

// --- Provider types ---

export type ProviderId =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "ollama"
  | "mistral"
  | "xai"
  | "google"
  | "custom";

export interface ProviderConfig {
  id: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  defaultModel: string;
  models: string[];
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  apiKeyPlaceholder: string;
  apiKeyHint: string;
}

export interface ProviderUpdateResult {
  ok: boolean;
  error?: string;
}

export interface ProviderModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export interface VesselSettings {
  provider: ProviderConfig;
  defaultUrl: string;
  theme: "dark";
  sidebarWidth: number;
}
