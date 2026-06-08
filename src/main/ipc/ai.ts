import { ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import { loadSettings } from "../config/settings";
import { createProvider, fetchProviderModels } from "../ai/provider";
import type { AIProvider } from "../ai/provider";
import { handleAIQuery } from "../ai/commands";
import { endAIStream, onAIStreamIdle, tryBeginAIStream } from "../ai/stream-lock";
import type { AIMessage, ProviderConfig } from "../../shared/types";
import { compactProviderHistory } from "../../shared/ai-history";
import { errorResult, getErrorMessage } from "../../shared/result";
import {
  assertTrustedIpcSender,
  parseIpc,
  type SendToRendererViews,
} from "./common";
import type { AgentRuntime } from "../agent/runtime";
import type { ResearchOrchestrator } from "../agent/research/orchestrator";
import type { TabManager } from "../tabs/tab-manager";

// --- Zod schemas for IPC validation ---

const AIQuerySchema = z.string().min(1);
const AIMessageSchema: z.ZodType<AIMessage> = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const AIHistorySchema = z.array(AIMessageSchema).optional();

const ReasoningEffortSchema = z.enum(["off", "low", "medium", "high", "max"]);

const ProviderConfigSchema = z.object({
  id: z.enum([
    "anthropic",
    "openai",
    "openai_codex",
    "openrouter",
    "ollama",
    "llama_cpp",
    "mistral",
    "xai",
    "google",
    "custom",
  ]),
  apiKey: z.string(),
  hasApiKey: z.boolean().optional(),
  model: z.string(),
  baseUrl: z.string().optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
}) satisfies z.ZodType<ProviderConfig>;

let activeChatProvider: AIProvider | null = null;

export function registerAIHandlers(
  tabManager: TabManager,
  runtime: AgentRuntime,
  sendToRendererViews: SendToRendererViews,
  getResearchOrchestrator: () => ResearchOrchestrator,
): void {
  onAIStreamIdle(() => {
    sendToRendererViews(Channels.AI_STREAM_IDLE);
  });

  ipcMain.handle(Channels.AI_QUERY, async (event, query: unknown, history?: unknown) => {
    assertTrustedIpcSender(event);
    const validatedQuery = parseIpc(AIQuerySchema, query, "query");
    const validatedHistory = history !== undefined
      ? parseIpc(AIHistorySchema, history, "history")
      : undefined;
    const settings = loadSettings();
    const chatConfig = settings.chatProvider;

    if (!chatConfig) {
      sendToRendererViews(Channels.AI_STREAM_START, validatedQuery);
      sendToRendererViews(
        Channels.AI_STREAM_CHUNK,
        "Chat provider not configured. Open Settings (Ctrl+,) to choose a provider.",
      );
      sendToRendererViews(Channels.AI_STREAM_END, "failed");
      return { accepted: true as const };
    }

    if (!tryBeginAIStream("manual")) {
      return { accepted: false as const, reason: "busy" as const };
    }

    sendToRendererViews(Channels.AI_STREAM_START, validatedQuery);

    (async () => {
      try {
        activeChatProvider = createProvider(chatConfig);
        const activeTab = tabManager.getActiveTab();
        await handleAIQuery(
          validatedQuery,
          activeChatProvider,
          activeTab?.view.webContents,
          (chunk) => sendToRendererViews(Channels.AI_STREAM_CHUNK, chunk),
          () => sendToRendererViews(Channels.AI_STREAM_END, "completed"),
          tabManager,
          runtime,
          compactProviderHistory(validatedHistory),
          getResearchOrchestrator(),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        sendToRendererViews(Channels.AI_STREAM_CHUNK, `\n[Error: ${msg}]`);
        sendToRendererViews(Channels.AI_STREAM_END, "failed");
      } finally {
        activeChatProvider = null;
        endAIStream("manual");
      }
    })();

    return { accepted: true as const };
  });

  ipcMain.handle(Channels.AI_CANCEL, (event) => {
    assertTrustedIpcSender(event);
    activeChatProvider?.cancel();
  });

  ipcMain.handle(Channels.AI_FETCH_MODELS, async (event, config: unknown) => {
    assertTrustedIpcSender(event);
    try {
      const validatedConfig = parseIpc(ProviderConfigSchema, config, "providerConfig");
      return await fetchProviderModels(validatedConfig);
    } catch (err: unknown) {
      return errorResult(getErrorMessage(err), { models: [] });
    }
  });
}
