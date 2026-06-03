import { app, ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import { trackApprovalModeChanged } from "../telemetry/posthog";
import { setSetting } from "../config/settings";
import { onRuntimeHealthChange } from "../health/runtime-health";
import {
  assertString,
  assertTrustedIpcSender,
  sendSafe,
  type SendToRendererViews,
} from "./common";
import type { ApprovalMode, AgentRuntimeState, SessionSnapshot } from "../../shared/types";
import type { AgentRuntime } from "../agent/runtime";

const VALID_APPROVAL_MODES = ["auto", "confirm-dangerous", "manual"] as const;
type ValidApprovalMode = typeof VALID_APPROVAL_MODES[number];

export function registerAgentRuntimeHandlers(
  runtime: AgentRuntime,
  chromeView: Electron.WebContents,
  sidebarView: Electron.WebContents,
  sendToRendererViews: SendToRendererViews,
): void {
  let runtimeUpdateTimer: NodeJS.Timeout | null = null;
  let pendingRuntimeState: AgentRuntimeState | null = null;

  const flushRuntimeUpdate = () => {
    runtimeUpdateTimer = null;
    if (!pendingRuntimeState) return;
    sendSafe(chromeView, Channels.AGENT_RUNTIME_UPDATE, pendingRuntimeState);
    sendSafe(sidebarView, Channels.AGENT_RUNTIME_UPDATE, pendingRuntimeState);
    pendingRuntimeState = null;
  };

  const scheduleRuntimeUpdate = (state: AgentRuntimeState) => {
    pendingRuntimeState = state;
    if (runtimeUpdateTimer) return;
    runtimeUpdateTimer = setTimeout(() => {
      flushRuntimeUpdate();
    }, 32);
  };

  app.on("before-quit", () => {
    if (runtimeUpdateTimer) {
      clearTimeout(runtimeUpdateTimer);
      runtimeUpdateTimer = null;
    }
    flushRuntimeUpdate();
  });

  runtime.setUpdateListener((state: AgentRuntimeState) => {
    scheduleRuntimeUpdate(state);
  });

  onRuntimeHealthChange((health) => {
    sendToRendererViews(Channels.SETTINGS_HEALTH_UPDATE, health);
  });

  ipcMain.handle(Channels.AGENT_RUNTIME_GET, (event) => {
    assertTrustedIpcSender(event);
    return runtime.getState();
  });

  ipcMain.handle(Channels.AGENT_PAUSE, (event) => {
    assertTrustedIpcSender(event);
    return runtime.pause();
  });

  ipcMain.handle(Channels.AGENT_RESUME, (event) => {
    assertTrustedIpcSender(event);
    return runtime.resume();
  });

  ipcMain.handle(
    Channels.AGENT_SET_APPROVAL_MODE,
    (event, mode: ApprovalMode): AgentRuntimeState => {
      assertTrustedIpcSender(event);
      assertString(mode, "mode");
      if (!VALID_APPROVAL_MODES.includes(mode as ValidApprovalMode)) {
        throw new Error(`Invalid approval mode: ${mode}`);
      }
      trackApprovalModeChanged(mode);
      setSetting("approvalMode", mode);
      return runtime.setApprovalMode(mode);
    },
  );

  ipcMain.handle(
    Channels.AGENT_APPROVAL_RESOLVE,
    (event, approvalId: string, approved: boolean) => {
      assertTrustedIpcSender(event);
      return runtime.resolveApproval(approvalId, approved);
    },
  );

  ipcMain.handle(
    Channels.AGENT_CHECKPOINT_CREATE,
    (event, name?: string, note?: string) => {
      assertTrustedIpcSender(event);
      return runtime.createCheckpoint(name, note);
    },
  );

  ipcMain.handle(Channels.AGENT_CHECKPOINT_RESTORE, (event, checkpointId: string) => {
    assertTrustedIpcSender(event);
    return runtime.restoreCheckpoint(checkpointId);
  });

  ipcMain.handle(Channels.AGENT_CHECKPOINT_UPDATE_NOTE, (event, checkpointId: string, note?: string) => {
    assertTrustedIpcSender(event);
    return runtime.updateCheckpointNote(checkpointId, note || "");
  });

  ipcMain.handle(Channels.AGENT_UNDO_LAST_ACTION, (event) => {
    assertTrustedIpcSender(event);
    return runtime.undoLastAction();
  });

  ipcMain.handle(Channels.AGENT_SESSION_CAPTURE, (event, note?: string) => {
    assertTrustedIpcSender(event);
    return runtime.captureSession(note);
  });

  ipcMain.handle(
    Channels.AGENT_SESSION_RESTORE,
    (event, snapshot?: SessionSnapshot | null) => {
      assertTrustedIpcSender(event);
      return runtime.restoreSession(snapshot);
    },
  );
}
