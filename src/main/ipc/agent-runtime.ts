import { app, ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import { trackApprovalModeChanged } from "../telemetry/posthog";
import { setSetting } from "../config/settings";
import { onRuntimeHealthChange } from "../health/runtime-health";
import {
  assertTrustedIpcSender,
  parseIpc,
  sendSafe,
  type SendToRendererViews,
} from "./common";
import type { ApprovalMode, AgentRuntimeState, SessionSnapshot } from "../../shared/types";
import type { AgentRuntime } from "../agent/runtime";

const ApprovalModeSchema = z.enum(["auto", "confirm-dangerous", "manual"]);
const CheckpointIdSchema = z.string().min(1);
const TaskTextSchema = z.string().trim().min(1).max(20_000);
const OptionalTaskTextSchema = z.string().trim().max(20_000).optional();
const OptionalNullableTaskTextSchema = z
  .string()
  .trim()
  .max(20_000)
  .nullable()
  .optional();
const TaskFactsSchema = z.record(
  z.string().trim().min(1).max(200),
  z.string().max(20_000),
);
const TaskMemoryPatchSchema = z.object({
  nextStep: OptionalNullableTaskTextSchema,
  facts: TaskFactsSchema.optional(),
});

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
      const validated = parseIpc(ApprovalModeSchema, mode, "mode");
      trackApprovalModeChanged(validated);
      setSetting("approvalMode", validated);
      return runtime.setApprovalMode(validated);
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
    return runtime.restoreCheckpoint(parseIpc(CheckpointIdSchema, checkpointId, "checkpointId"));
  });

  ipcMain.handle(Channels.AGENT_CHECKPOINT_UPDATE_NOTE, (event, checkpointId: string, note?: string) => {
    assertTrustedIpcSender(event);
    return runtime.updateCheckpointNote(
      parseIpc(CheckpointIdSchema, checkpointId, "checkpointId"),
      note || "",
    );
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

  // --- Task Memory ---

  ipcMain.handle(Channels.AGENT_TASK_START, (event, goal: string) => {
    assertTrustedIpcSender(event);
    return runtime.startTaskMemory(parseIpc(TaskTextSchema, goal, "goal"));
  });

  ipcMain.handle(
    Channels.AGENT_TASK_UPDATE,
    (event, patch: unknown) => {
      assertTrustedIpcSender(event);
      return runtime.updateTaskMemory(
        parseIpc(TaskMemoryPatchSchema, patch ?? {}, "patch"),
      );
    },
  );

  ipcMain.handle(Channels.AGENT_TASK_NOTE, (event, text: string) => {
    assertTrustedIpcSender(event);
    return runtime.addTaskNote(parseIpc(TaskTextSchema, text, "text"));
  });

  ipcMain.handle(Channels.AGENT_TASK_BLOCKER, (event, blocker?: unknown) => {
    assertTrustedIpcSender(event);
    const validated =
      blocker == null
        ? null
        : parseIpc(OptionalNullableTaskTextSchema, blocker, "blocker");
    return runtime.setTaskBlocker(validated ?? null);
  });

  ipcMain.handle(Channels.AGENT_TASK_RESOLVE, (event, summary?: unknown) => {
    assertTrustedIpcSender(event);
    return runtime.resolveTaskMemory(
      summary == null
        ? undefined
        : parseIpc(OptionalTaskTextSchema, summary, "summary"),
    );
  });

  ipcMain.handle(Channels.AGENT_TASK_ABANDON, (event, reason?: unknown) => {
    assertTrustedIpcSender(event);
    return runtime.abandonTaskMemory(
      reason == null
        ? undefined
        : parseIpc(OptionalTaskTextSchema, reason, "reason"),
    );
  });

  ipcMain.handle(Channels.AGENT_TASK_CLEAR, (event) => {
    assertTrustedIpcSender(event);
    runtime.clearTaskMemory();
    return null;
  });
}
