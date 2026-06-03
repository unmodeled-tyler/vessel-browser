import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import { loadSettings } from "../config/settings";
import { createProvider, fetchProviderModels } from "../ai/provider";
import type { AIProvider } from "../ai/provider";
import { handleAIQuery } from "../ai/commands";
import { endAIStream, onAIStreamIdle, tryBeginAIStream } from "../ai/stream-lock";
import type { AIMessage } from "../../shared/types";
import { compactProviderHistory } from "../../shared/ai-history";
import { createLogger } from "../../shared/logger";
import { errorResult, getErrorMessage } from "../../shared/result";
import {
  assertTrustedIpcSender,
  type SendToRendererViews,
} from "./common";
import type { AgentRuntime } from "../agent/runtime";
import type { ResearchOrchestrator } from "../agent/research/orchestrator";
import type { TabManager } from "../tabs/tab-manager";

let activeChatProvider: AIProvider | null = null;
const logger = createLogger("AI-IPC");

export function registerAIHandlers(
  tabManager: TabManager,
  runtime: AgentRuntime,
  sendToRendererViews: SendToRendererViews,
  getResearchOrchestrator: () => ResearchOrchestrator,
): void {
  onAIStreamIdle(() => {
    sendToRendererViews(Channels.AI_STREAM_IDLE);
  });

  ipcMain.handle(Channels.AI_QUERY, async (event, query: string, history?: AIMessage[]) => {
    assertTrustedIpcSender(event);
    const settings = loadSettings();
    const chatConfig = settings.chatProvider;

    if (!chatConfig) {
      sendToRendererViews(Channels.AI_STREAM_START, query);
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

    sendToRendererViews(Channels.AI_STREAM_START, query);

    (async () => {
      try {
        activeChatProvider = createProvider(chatConfig);
        const activeTab = tabManager.getActiveTab();
        await handleAIQuery(
          query,
          activeChatProvider,
          activeTab?.view.webContents,
          (chunk) => sendToRendererViews(Channels.AI_STREAM_CHUNK, chunk),
          () => sendToRendererViews(Channels.AI_STREAM_END, "completed"),
          tabManager,
          runtime,
          compactProviderHistory(history),
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
      if (!config || typeof config !== "object" || !("id" in config)) {
        return errorResult("Invalid provider configuration", { models: [] });
      }
      return await fetchProviderModels(
        config as Parameters<typeof fetchProviderModels>[0],
      );
    } catch (err: unknown) {
      return errorResult(getErrorMessage(err), { models: [] });
    }
  });
}
