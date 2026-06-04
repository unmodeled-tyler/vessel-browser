import { ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import {
  getRendererSettings,
  setSetting,
  SETTABLE_KEYS,
} from "../config/settings";
import { getRuntimeHealth } from "../health/runtime-health";
import { trackSettingChanged } from "../telemetry/posthog";
import { createProvider } from "../ai/provider";
import { regenerateMcpAuthToken, startMcpServer, stopMcpServer } from "../mcp/server";
import { submitFeedback } from "../support/feedback";
import {
  assertTrustedIpcSender,
  parseIpc,
  type SendToRendererViews,
} from "./common";
import type { VesselSettings, ApprovalMode } from "../../shared/types";
import type { AgentRuntime } from "../agent/runtime";
import type { TabManager } from "../tabs/tab-manager";
import type { ResearchOrchestrator } from "../agent/research/orchestrator";

const SettingsKeySchema = z.string().refine((k) => SETTABLE_KEYS.has(k), {
  message: "Unknown setting key",
});

export function registerSettingsHandlers(
  tabManager: TabManager,
  runtime: AgentRuntime,
  sendToRendererViews: SendToRendererViews,
  getResearchOrchestrator: () => ResearchOrchestrator | null,
): <K extends keyof VesselSettings>(key: K, value: VesselSettings[K]) => Promise<VesselSettings> {
  const applySettingChange = async <K extends keyof VesselSettings>(
    key: K,
    value: VesselSettings[K],
  ): Promise<VesselSettings> => {
    const updatedSettings = setSetting(key, value);
    trackSettingChanged(key);
    if (key === "approvalMode") {
      runtime.setApprovalMode(value as ApprovalMode);
    }
    if (key === "mcpPort") {
      await stopMcpServer();
      await startMcpServer(tabManager, runtime, updatedSettings.mcpPort);
    }
    const researchOrchestrator = getResearchOrchestrator();
    if (key === "chatProvider" && researchOrchestrator) {
      try {
        researchOrchestrator.setProvider(createProvider(value as Parameters<typeof createProvider>[0]));
      } catch {
        // Provider config is invalid — keep the current provider so
        // an in-progress research session can finish.
      }
    }
    const rendererSettings = getRendererSettings();
    sendToRendererViews(Channels.SETTINGS_UPDATE, rendererSettings);
    return rendererSettings;
  };

  ipcMain.handle(Channels.SETTINGS_GET, (event) => {
    assertTrustedIpcSender(event);
    return getRendererSettings();
  });

  ipcMain.handle(Channels.SETTINGS_HEALTH_GET, (event) => {
    assertTrustedIpcSender(event);
    return getRuntimeHealth();
  });

  ipcMain.handle(Channels.MCP_REGENERATE_TOKEN, (event) => {
    assertTrustedIpcSender(event);
    return regenerateMcpAuthToken();
  });

  ipcMain.handle(Channels.SUPPORT_SUBMIT_FEEDBACK, async (event, email: string, message: string) => {
    assertTrustedIpcSender(event);
    return submitFeedback({ email, message, source: "settings_account" });
  });

  ipcMain.handle(Channels.SETTINGS_SET, async (event, key: string, value: unknown) => {
    assertTrustedIpcSender(event);
    const validatedKey = parseIpc(SettingsKeySchema, key, "key");
    const settingsKey = validatedKey as keyof VesselSettings;
    return applySettingChange(settingsKey, value as VesselSettings[typeof settingsKey]);
  });

  return applySettingChange;
}
