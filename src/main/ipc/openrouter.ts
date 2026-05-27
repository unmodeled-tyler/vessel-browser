import { ipcMain, type WebContents } from "electron";
import { Channels } from "../../shared/channels";
import type { ProviderConfig, VesselSettings } from "../../shared/types";
import { PROVIDERS } from "../../shared/providers";
import { createLogger } from "../../shared/logger";
import { startOpenRouterOAuth, cancelOpenRouterOAuth } from "../ai/openrouter-oauth";
import { assertTrustedIpcSender } from "./common";

const logger = createLogger("OpenRouterIPC");

type OpenRouterAuthStatus = "idle" | "waiting" | "exchanging" | "connected" | "error";

export function registerOpenRouterHandlers(
  applySettingChange: <K extends keyof VesselSettings>(
    key: K,
    value: VesselSettings[K],
  ) => Promise<VesselSettings>,
): void {
  ipcMain.handle(Channels.OPENROUTER_START_AUTH, async (event) => {
    assertTrustedIpcSender(event);
    const wc: WebContents | undefined = event.sender;
    if (!wc || wc.isDestroyed()) {
      return {
        ok: false as const,
        error: "No active window found for sender",
      };
    }

    const sendStatus = (status: OpenRouterAuthStatus, error?: string) => {
      try {
        wc.send(Channels.OPENROUTER_AUTH_STATUS, { status, error: error || null });
      } catch {
        logger.warn("OpenRouter auth status send failed - window may be closed");
      }
    };

    try {
      const apiKey = await startOpenRouterOAuth(sendStatus);
      const openRouterConfig: ProviderConfig = {
        id: "openrouter",
        apiKey,
        hasApiKey: true,
        model: PROVIDERS.openrouter.defaultModel,
        baseUrl: PROVIDERS.openrouter.defaultBaseUrl,
        reasoningEffort: "off",
      };

      await applySettingChange("chatProvider", openRouterConfig);

      return {
        ok: true as const,
        providerId: "openrouter" as const,
        model: openRouterConfig.model,
      };
    } catch (err) {
      logger.error("OpenRouter auth failed:", err);
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  });

  ipcMain.handle(Channels.OPENROUTER_CANCEL_AUTH, (event) => {
    assertTrustedIpcSender(event);
    cancelOpenRouterOAuth();
    return { ok: true };
  });
}
