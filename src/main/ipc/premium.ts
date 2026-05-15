import { ipcMain } from "electron";
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
  assertString,
  assertTrustedIpcSender,
  isValidEmail,
  type SendToRendererViews,
} from "./common";
import type { TabManager } from "../tabs/tab-manager";

const PREMIUM_TRACKABLE_STEPS = [
  "chat_banner_viewed",
  "chat_banner_clicked",
  "settings_banner_viewed",
  "settings_banner_clicked",
  "welcome_banner_clicked",
  "premium_gate_seen",
  "premium_gate_clicked",
  "iteration_limit_seen",
  "iteration_limit_clicked",
] as const;
type PremiumTrackableStep = typeof PREMIUM_TRACKABLE_STEPS[number];

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

  ipcMain.handle(Channels.PREMIUM_ACTIVATION_START, async (event, email: string) => {
    assertTrustedIpcSender(event);
    assertString(email, "email");
    if (!isValidEmail(email)) {
      return errorResult("Invalid email format");
    }
    trackPremiumFunnel("activation_attempted");
    trackPremiumFunnel("activation_code_requested", {
      source: "settings",
    });
    const result = await requestActivationCode(email);
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
    async (event, email: string, code: string, challengeToken: string) => {
      assertTrustedIpcSender(event);
      assertString(email, "email");
      assertString(code, "code");
      assertString(challengeToken, "challengeToken");
      if (!isValidEmail(email)) {
        return errorResult("Invalid email format", {
          state: getPremiumState(),
        });
      }
      trackPremiumFunnel("activation_attempted");
      trackPremiumFunnel("premium_verify_started", {
        source: "settings_code",
      });
      const previousStatus = getPremiumState().status;
      const result = await verifyActivationCode(email, code, challengeToken);
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

  ipcMain.handle(Channels.PREMIUM_CHECKOUT, async (event, email?: string) => {
    assertTrustedIpcSender(event);
    trackPremiumFunnel("checkout_clicked");
    const result = await getCheckoutUrl(email);
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

  ipcMain.handle(Channels.PREMIUM_TRACK_CONTEXT, (event, step: string) => {
    assertTrustedIpcSender(event);
    assertString(step, "step");
    if (PREMIUM_TRACKABLE_STEPS.includes(step as PremiumTrackableStep)) {
      trackPremiumFunnel(step as PremiumTrackableStep);
    }
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
