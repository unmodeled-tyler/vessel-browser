import { ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import {
  getPremiumState,
  getCheckoutUrl,
  getPortalUrl,
  resetPremium,
  requestActivationCode,
  verifyActivationCode,
  isPremiumActiveState,
} from "../premium/manager";
import { trackPremiumFunnel } from "../telemetry/posthog";
import { errorResult } from "../../shared/result";
import {
  assertTrustedIpcSender,
  isValidEmail,
  parseIpc,
  type SendToRendererViews,
} from "./common";
import type { TabManager } from "../tabs/tab-manager";

const EmailSchema = z.string().email();
const CodeSchema = z.string().min(1);
const ChallengeTokenSchema = z.string().min(1);
const TrackStepSchema = z.enum([
  "chat_banner_viewed",
  "chat_banner_clicked",
  "settings_banner_viewed",
  "settings_banner_clicked",
  "welcome_banner_clicked",
  "premium_gate_seen",
  "premium_gate_clicked",
  "iteration_limit_seen",
  "iteration_limit_clicked",
]);

type PremiumTrackableStep = z.infer<typeof TrackStepSchema>;

const premiumApiOrigin =
  process.env.VESSEL_PREMIUM_API
    ? new URL(process.env.VESSEL_PREMIUM_API).origin
    : "https://vesselpremium.quantaintellect.com";

export function registerPremiumHandlers(
  tabManager: TabManager,
  sendToRendererViews: SendToRendererViews,
): void {
  const trackPremiumStatusChange = (
    previousStatus: string,
    nextStatus: string,
    source: string,
  ) => {
    if (previousStatus === nextStatus) return;
    trackPremiumFunnel("premium_status_changed", {
      previous_status: previousStatus,
      new_status: nextStatus,
      source,
    });
  };

  const watchPremiumCheckoutTab = (tabId: string) => {
    const tab = tabManager.getTab(tabId);
    const wc = tab?.view.webContents;
    if (!wc) return;

    let completed = false;

    const cleanup = () => {
      wc.removeListener("did-navigate", onNavigate);
      wc.removeListener("did-navigate-in-page", onNavigateInPage);
      wc.removeListener("destroyed", cleanup);
    };

    const handleUrl = async (rawUrl: string) => {
      if (completed) return;

      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        // Not a valid URL — skip premium checkout handling.
        return;
      }

      if (parsed.origin !== premiumApiOrigin) return;

      if (parsed.pathname === "/canceled") {
        completed = true;
        trackPremiumFunnel("checkout_canceled");
        cleanup();
        return;
      }

      if (parsed.pathname !== "/success") return;

      completed = true;
      trackPremiumFunnel("checkout_success_seen");

      const sessionId = parsed.searchParams.get("session_id")?.trim();
      if (!sessionId) {
        trackPremiumFunnel("auto_activation_failed", {
          reason: "missing_session_id",
        });
        cleanup();
        return;
      }

      trackPremiumFunnel("auto_activation_attempted");
      trackPremiumFunnel("premium_verify_started", {
        source: "checkout_auto",
      });
      const previousStatus = getPremiumState().status;
      const state = await verifySubscription(sessionId);
      if (isPremiumActiveState(state)) {
        sendToRendererViews(Channels.PREMIUM_UPDATE, state);
        trackPremiumFunnel("premium_verify_succeeded", {
          status: state.status,
          source: "checkout_auto",
        });
        trackPremiumStatusChange(previousStatus, state.status, "checkout_auto");
        trackPremiumFunnel("auto_activation_succeeded", {
          status: state.status,
        });
      } else {
        trackPremiumFunnel("premium_verify_failed", {
          status: state.status,
          source: "checkout_auto",
        });
        trackPremiumFunnel("auto_activation_failed", {
          status: state.status,
        });
      }
      cleanup();
    };

    const onNavigate = (_event: unknown, url: string) => {
      void handleUrl(url);
    };

    const onNavigateInPage = (
      _event: unknown,
      url: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      void handleUrl(url);
    };

    wc.on("did-navigate", onNavigate);
    wc.on("did-navigate-in-page", onNavigateInPage);
    wc.on("destroyed", cleanup);

    const currentUrl = wc.getURL();
    if (currentUrl) {
      void handleUrl(currentUrl);
    }
  };

  ipcMain.handle(Channels.PREMIUM_GET_STATE, (event) => {
    assertTrustedIpcSender(event);
    return getPremiumState();
  });

  ipcMain.handle(Channels.PREMIUM_ACTIVATION_START, async (event, email: unknown) => {
    assertTrustedIpcSender(event);
    const validatedEmail = parseIpc(EmailSchema, email, "email");
    if (!isValidEmail(validatedEmail)) {
      return errorResult("Invalid email format");
    }
    trackPremiumFunnel("activation_attempted");
    trackPremiumFunnel("activation_code_requested", {
      source: "settings",
    });
    const result = await requestActivationCode(validatedEmail);
    if (!result.ok) {
      trackPremiumFunnel("activation_code_failed", {
        source: "settings",
      });
      trackPremiumFunnel("activation_failed");
    } else {
      trackPremiumFunnel("activation_code_sent", {
        source: "settings",
      });
    }
    return result;
  });

  ipcMain.handle(
    Channels.PREMIUM_ACTIVATION_VERIFY,
    async (event, email: unknown, code: unknown, challengeToken: unknown) => {
      assertTrustedIpcSender(event);
      const validatedEmail = parseIpc(EmailSchema, email, "email");
      const validatedCode = parseIpc(CodeSchema, code, "code");
      const validatedChallengeToken = parseIpc(ChallengeTokenSchema, challengeToken, "challengeToken");
      if (!isValidEmail(validatedEmail)) {
        return errorResult("Invalid email format", {
          state: getPremiumState(),
        });
      }
      trackPremiumFunnel("activation_attempted");
      trackPremiumFunnel("premium_verify_started", {
        source: "settings_code",
      });
      const previousStatus = getPremiumState().status;
      const result = await verifyActivationCode(validatedEmail, validatedCode, validatedChallengeToken);
      if (result.ok) {
        trackPremiumFunnel("premium_verify_succeeded", {
          status: result.state.status,
          source: "settings_code",
        });
        trackPremiumFunnel("activation_succeeded", {
          status: result.state.status,
        });
        trackPremiumStatusChange(
          previousStatus,
          result.state.status,
          "settings_code",
        );
        sendToRendererViews(Channels.PREMIUM_UPDATE, result.state);
      } else {
        trackPremiumFunnel("premium_verify_failed", {
          status: result.state.status,
          source: "settings_code",
        });
        trackPremiumFunnel("activation_failed", { status: result.state.status });
      }
      return result;
    },
  );

  ipcMain.handle(Channels.PREMIUM_CHECKOUT, async (event, email?: unknown) => {
    assertTrustedIpcSender(event);
    const validatedEmail = email != null ? parseIpc(EmailSchema, email, "email") : undefined;
    trackPremiumFunnel("checkout_clicked");
    const result = await getCheckoutUrl(validatedEmail);
    if (result.ok && result.url) {
      const tabId = tabManager.createTab(result.url);
      watchPremiumCheckoutTab(tabId);
    } else {
      trackPremiumFunnel("checkout_open_failed");
    }
    return result;
  });

  ipcMain.handle(Channels.PREMIUM_RESET, (event) => {
    assertTrustedIpcSender(event);
    trackPremiumFunnel("reset");
    const state = resetPremium();
    sendToRendererViews(Channels.PREMIUM_UPDATE, state);
    return state;
  });

  ipcMain.handle(Channels.PREMIUM_TRACK_CONTEXT, (event, step: unknown) => {
    assertTrustedIpcSender(event);
    const validatedStep = parseIpc(TrackStepSchema, step, "step");
    trackPremiumFunnel(validatedStep as PremiumTrackableStep);
  });

  ipcMain.handle(Channels.PREMIUM_PORTAL, async (event) => {
    assertTrustedIpcSender(event);
    trackPremiumFunnel("portal_opened");
    const result = await getPortalUrl();
    if (result.ok && result.url) {
      tabManager.createTab(result.url);
    }
    return result;
  });
}
