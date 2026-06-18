import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../shared/logger";
import type {
  ActionSource,
  ActionStatus,
  AgentActionEntry,
  AgentCheckpoint,
  AgentTranscriptEntry,
  AgentTranscriptKind,
  AgentRuntimeState,
  ApprovalMode,
  FlowState,
  FlowStepStatus,
  PendingApproval,
  SessionSnapshot,
  TaskMemory,
  TaskTrackerState,
} from "../../shared/types";
import type { TabManager } from "../tabs/tab-manager";
import {
  getMcpStatus,
  onMcpStatusChange,
} from "../health/runtime-health";
import {
  isUndoableAction,
  isUndoableResult,
} from "./undo-policy";
import {
  createTaskTracker,
  formatTaskTracker,
  updateTaskTracker,
} from "../ai/task-tracker";
import {
  createTaskMemory,
  updateTaskMemory as updateTaskMemoryState,
  addTaskNote as addTaskMemoryNote,
  setTaskBlocker as setTaskMemoryBlocker,
  resolveTaskMemory as resolveTaskMemoryState,
  abandonTaskMemory as abandonTaskMemoryState,
  formatTaskMemory,
} from "../ai/task-memory";

const MAX_ACTIONS = 120;
const MAX_CHECKPOINTS = 20;
const MAX_UNDO_SNAPSHOTS = 10;
const MAX_TRANSCRIPT_ENTRIES = 40;
const MAX_TRANSCRIPT_TEXT_LENGTH = 8000;
const PERSIST_DEBOUNCE_MS = 500;
const INTERRUPTED_ACTION_STATUSES = new Set<ActionStatus>([
  "running",
  "waiting-approval",
]);
const logger = createLogger("Runtime");

interface RuntimePersistenceShape {
  session: SessionSnapshot | null;
  supervisor: {
    paused: boolean;
    approvalMode: ApprovalMode;
    lastError?: string;
  };
  actions: AgentActionEntry[];
  checkpoints: AgentCheckpoint[];
  taskMemory: TaskMemory | null;
}

interface UndoSnapshot {
  id: string;
  actionName: string;
  snapshot: SessionSnapshot;
  capturedAt: string;
}

interface ControlledActionOptions {
  source: ActionSource;
  name: string;
  args?: Record<string, unknown>;
  tabId?: string | null;
  dangerous?: boolean;
  requiresApproval?: boolean;
  undoable?: boolean;
  executor: () => Promise<string>;
}

export interface AgentRuntimeActionLifecycleEvent {
  actionId: string;
  source: ActionSource;
  name: string;
  args: Record<string, unknown>;
  tabId: string | null;
  phase: "started" | "waiting-approval" | "rejected" | "completed" | "failed";
  detail?: string;
  durationMs?: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([, value]) => value != null);
  if (entries.length === 0) return "No arguments";
  return entries
    .map(([key, value]) => {
      const rendered =
        typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${String(rendered).slice(0, 120)}`;
    })
    .join(", ");
}

function summarizeText(value: string): string {
  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}

function humanizeActionName(name: string): string {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getRuntimeStatePath(): string {
  return path.join(app.getPath("userData"), "vessel-agent-runtime.json");
}

function sanitizePersistence(
  persisted: Partial<RuntimePersistenceShape> | null | undefined,
): AgentRuntimeState {
  const recoveredAt = new Date().toISOString();
  const persistedTaskMemory = persisted?.taskMemory?.completedAt
    ? null
    : (persisted?.taskMemory ?? null);
  const actions = Array.isArray(persisted?.actions)
    ? persisted!.actions.slice(-MAX_ACTIONS).map((action) =>
        INTERRUPTED_ACTION_STATUSES.has(action.status)
          ? {
              ...action,
              status: "failed" as ActionStatus,
              finishedAt: action.finishedAt ?? recoveredAt,
              error:
                action.error ??
                "Action was interrupted before the previous Vessel session ended.",
            }
          : action,
      )
    : [];

  return {
    session: persisted?.session ?? null,
    supervisor: {
      paused: persisted?.supervisor?.paused ?? false,
      approvalMode: persisted?.supervisor?.approvalMode ?? "confirm-dangerous",
      pendingApprovals: [],
      lastError: persisted?.supervisor?.lastError,
    },
    actions,
    checkpoints: Array.isArray(persisted?.checkpoints)
      ? persisted!.checkpoints.slice(-MAX_CHECKPOINTS)
      : [],
    transcript: [],
    mcpStatus: "stopped",
    flowState: null,
    taskTracker: null,
    taskMemory: persistedTaskMemory,
  };
}

export class AgentRuntime {
  private state: AgentRuntimeState;
  private updateListener: ((state: AgentRuntimeState) => void) | null = null;
  private actionLifecycleListener:
    | ((event: AgentRuntimeActionLifecycleEvent) => void)
    | null = null;
  private pendingResolvers = new Map<string, (approved: boolean) => void>();
  private undoSnapshots: UndoSnapshot[] = [];
  private mcpUnsubscribe: (() => void) | null = null;

  constructor(private readonly tabManager: TabManager) {
    this.state = this.loadPersistedState();
    this.mcpUnsubscribe = onMcpStatusChange(() => this.emit());
  }

  setUpdateListener(
    listener: ((state: AgentRuntimeState) => void) | null,
  ): void {
    this.updateListener = listener;
    if (listener) {
      listener(this.getState());
    }
  }

  setActionLifecycleListener(
    listener: ((event: AgentRuntimeActionLifecycleEvent) => void) | null,
  ): void {
    this.actionLifecycleListener = listener;
  }

  /**
   * Release all resources, listeners, and pending promises.
   * Call when the window is closing to prevent memory leaks.
   */
  dispose(): void {
    this.mcpUnsubscribe?.();
    this.mcpUnsubscribe = null;

    // Resolve any pending approvals to unblock waiting code
    for (const [id, resolve] of this.pendingResolvers) {
      resolve(false);
      this.pendingResolvers.delete(id);
    }

    // Clear all transient state to release memory
    this.undoSnapshots = [];
    this.state.actions = [];
    this.state.transcript = [];
    this.state.supervisor.pendingApprovals = [];
    this.state.flowState = null;
    this.state.taskTracker = null;
    this.updateListener = null;
    this.actionLifecycleListener = null;
  }

  getState(): AgentRuntimeState {
    const snapshot = clone(this.state);
    snapshot.mcpStatus = getMcpStatus();
    snapshot.canUndo = this.canUndo();
    snapshot.undoInfo = this.getUndoInfo();
    return snapshot;
  }

  onTabStateChanged(): void {
    this.captureSession();
  }

  setApprovalMode(mode: ApprovalMode): AgentRuntimeState {
    this.state.supervisor.approvalMode = mode;
    if (mode === "auto" && !this.state.supervisor.paused) {
      const approvals = this.state.supervisor.pendingApprovals;
      if (approvals.length > 0) {
        const actionIds = new Set(approvals.map((approval) => approval.actionId));
        this.state.supervisor.pendingApprovals = [];
        this.state.actions = this.state.actions.map((action) =>
          actionIds.has(action.id)
            ? { ...action, status: "running", error: undefined }
            : action,
        );
        for (const approval of approvals) {
          const resolve = this.pendingResolvers.get(approval.id);
          this.pendingResolvers.delete(approval.id);
          resolve?.(true);
        }
      }
    }
    this.emit();
    return this.getState();
  }

  pause(): AgentRuntimeState {
    this.state.supervisor.paused = true;
    this.emit();
    return this.getState();
  }

  resume(): AgentRuntimeState {
    this.state.supervisor.paused = false;
    this.emit();
    return this.getState();
  }

  createCheckpoint(name?: string, note?: string): AgentCheckpoint {
    const snapshot = this.captureSession(note);
    const checkpoint: AgentCheckpoint = {
      id: randomUUID(),
      name: name?.trim() || `Checkpoint ${this.state.checkpoints.length + 1}`,
      createdAt: new Date().toISOString(),
      note: note?.trim() || undefined,
      snapshot,
      taskMemory: this.state.taskMemory ? clone(this.state.taskMemory) : null,
    };
    this.state.checkpoints = [...this.state.checkpoints, checkpoint].slice(
      -MAX_CHECKPOINTS,
    );
    this.emit();
    void this.flushPersist();
    return clone(checkpoint);
  }

  restoreCheckpoint(checkpointId: string): AgentCheckpoint | null {
    const checkpoint =
      this.state.checkpoints.find((item) => item.id === checkpointId) || null;
    if (!checkpoint) return null;
    this.tabManager.restoreSession(checkpoint.snapshot);
    this.state.taskMemory = checkpoint.taskMemory
      ? clone(checkpoint.taskMemory)
      : null;
    this.captureSession(`Restored ${checkpoint.name}`);
    return clone(checkpoint);
  }

  updateCheckpointNote(checkpointId: string, note: string): AgentCheckpoint | null {
    const index = this.state.checkpoints.findIndex((item) => item.id === checkpointId);
    if (index === -1) return null;
    this.state.checkpoints[index] = {
      ...this.state.checkpoints[index],
      note: note.trim() || undefined,
    };
    this.emit();
    return clone(this.state.checkpoints[index]);
  }

  canUndo(): boolean {
    return this.undoSnapshots.length > 0;
  }

  getUndoInfo(): { actionName: string; capturedAt: string } | null {
    const latest = this.undoSnapshots[this.undoSnapshots.length - 1];
    if (!latest) return null;
    return { actionName: latest.actionName, capturedAt: latest.capturedAt };
  }

  undoLastAction(): string | null {
    const snapshot = this.undoSnapshots.at(-1);
    if (!snapshot) return null;
    try {
      this.tabManager.restoreSession(snapshot.snapshot);
      this.undoSnapshots.pop(); // only consume on success
    } catch (error) {
      logger.error("Failed to restore undo snapshot", error);
      return null;
    }
    this.captureSession(`Undid ${snapshot.actionName}`);
    return snapshot.actionName;
  }

  captureSession(note?: string): SessionSnapshot {
    const snapshot = this.tabManager.snapshotSession(note);
    this.state.session = snapshot;
    this.emit();
    return clone(snapshot);
  }

  restoreSession(snapshot?: SessionSnapshot | null): SessionSnapshot {
    const target = snapshot || this.state.session;
    if (!target) {
      return this.captureSession("No saved session to restore");
    }
    this.tabManager.restoreSession(target);
    return this.captureSession(target.note || "Restored saved session");
  }

  publishTranscript(input: {
    source: ActionSource;
    kind?: AgentTranscriptKind;
    title?: string;
    text: string;
    streamId?: string;
    mode?: "append" | "replace" | "final";
  }): AgentTranscriptEntry {
    const now = new Date().toISOString();
    const kind = input.kind ?? "thinking";
    const mode = input.mode ?? "append";
    const incomingText = input.text.slice(0, MAX_TRANSCRIPT_TEXT_LENGTH);

    if (input.streamId) {
      const existing = this.state.transcript.find(
        (entry) => entry.streamId === input.streamId,
      );
      if (existing) {
        existing.source = input.source;
        existing.kind = kind;
        existing.title = input.title?.trim() || existing.title;
        existing.text =
          mode === "replace"
            ? incomingText
            : `${existing.text}${incomingText}`.slice(0, MAX_TRANSCRIPT_TEXT_LENGTH);
        existing.updatedAt = now;
        existing.status = mode === "final" ? "final" : "streaming";
        this.emit();
        return clone(existing);
      }
    }

    const entry: AgentTranscriptEntry = {
      id: randomUUID(),
      source: input.source,
      kind,
      title: input.title?.trim() || undefined,
      text: incomingText,
      startedAt: now,
      updatedAt: now,
      status: mode === "final" ? "final" : "streaming",
      streamId: input.streamId?.trim() || undefined,
    };
    this.state.transcript = [...this.state.transcript, entry].slice(
      -MAX_TRANSCRIPT_ENTRIES,
    );
    this.emit();
    return clone(entry);
  }

  clearTranscript(): AgentRuntimeState {
    this.state.transcript = [];
    this.emit();
    return this.getState();
  }

  ensureTaskTracker(goal: string, startUrl?: string): TaskTrackerState {
    const trimmedGoal = goal.trim();
    if (
      this.state.taskTracker &&
      this.state.taskTracker.goal.trim() === trimmedGoal
    ) {
      return clone(this.state.taskTracker);
    }

    this.state.taskTracker = createTaskTracker(trimmedGoal, startUrl);
    this.emit();
    return clone(this.state.taskTracker);
  }

  updateTaskTracker(actionName: string, result: string): TaskTrackerState | null {
    if (!this.state.taskTracker) return null;
    this.state.taskTracker = updateTaskTracker(
      this.state.taskTracker,
      actionName,
      result,
    );
    this.emit();
    return clone(this.state.taskTracker);
  }

  clearTaskTracker(): void {
    this.state.taskTracker = null;
    this.emit();
  }

  getTaskTrackerContext(): string {
    return formatTaskTracker(this.state.taskTracker);
  }

  // --- Task Memory ---

  startTaskMemory(
    goal: string,
    options?: { nextStep?: string | null; facts?: Record<string, string> },
  ): TaskMemory {
    this.state.taskMemory = createTaskMemory(goal, options);
    this.emit();
    return clone(this.state.taskMemory);
  }

  updateTaskMemory(patch: {
    nextStep?: string | null;
    facts?: Record<string, string>;
  }): TaskMemory | null {
    if (!this.state.taskMemory || this.state.taskMemory.completedAt) return null;
    this.state.taskMemory = updateTaskMemoryState(this.state.taskMemory, patch);
    this.emit();
    return clone(this.state.taskMemory);
  }

  addTaskNote(text: string): TaskMemory | null {
    if (!this.state.taskMemory || this.state.taskMemory.completedAt) return null;
    this.state.taskMemory = addTaskMemoryNote(this.state.taskMemory, text);
    this.emit();
    return clone(this.state.taskMemory);
  }

  setTaskBlocker(blocker: string | null): TaskMemory | null {
    if (!this.state.taskMemory || this.state.taskMemory.completedAt) return null;
    this.state.taskMemory = setTaskMemoryBlocker(
      this.state.taskMemory,
      blocker,
    );
    this.emit();
    return clone(this.state.taskMemory);
  }

  resolveTaskMemory(summary?: string): TaskMemory | null {
    if (!this.state.taskMemory || this.state.taskMemory.completedAt) return null;
    const resolved = resolveTaskMemoryState(this.state.taskMemory, summary);
    this.state.taskMemory = null;
    this.emit();
    return clone(resolved);
  }

  abandonTaskMemory(reason?: string): TaskMemory | null {
    if (!this.state.taskMemory || this.state.taskMemory.completedAt) return null;
    const abandoned = abandonTaskMemoryState(this.state.taskMemory, reason);
    this.state.taskMemory = null;
    this.emit();
    return clone(abandoned);
  }

  clearTaskMemory(): void {
    this.state.taskMemory = null;
    this.emit();
  }

  getTaskMemoryContext(): string {
    return formatTaskMemory(this.state.taskMemory);
  }

  // --- Speedee Flow State ---

  startFlow(goal: string, steps: string[], startUrl?: string): FlowState {
    const flow: FlowState = {
      id: randomUUID(),
      goal,
      steps: steps.map((label) => ({ label, status: "pending" as FlowStepStatus })),
      currentStepIndex: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startUrl,
    };
    this.state.flowState = flow;
    this.emit();
    return clone(flow);
  }

  advanceFlow(detail?: string): FlowState | null {
    const flow = this.state.flowState;
    if (!flow) return null;
    const step = flow.steps[flow.currentStepIndex];
    if (step) {
      step.status = "done";
      step.detail = detail;
    }
    flow.currentStepIndex = Math.min(flow.currentStepIndex + 1, flow.steps.length);
    flow.updatedAt = new Date().toISOString();
    this.emit();
    return clone(flow);
  }

  failFlowStep(detail?: string): FlowState | null {
    const flow = this.state.flowState;
    if (!flow) return null;
    const step = flow.steps[flow.currentStepIndex];
    if (step) {
      step.status = "failed";
      step.detail = detail;
    }
    flow.updatedAt = new Date().toISOString();
    this.emit();
    return clone(flow);
  }

  getFlowState(): FlowState | null {
    return this.state.flowState ? clone(this.state.flowState) : null;
  }

  clearFlow(): void {
    this.state.flowState = null;
    this.emit();
  }

  getFlowContext(): string {
    const flow = this.state.flowState;
    if (!flow) return "";
    const progress = flow.steps
      .map((s, i) => {
        const marker =
          s.status === "done" ? "\u2713" :
          s.status === "failed" ? "\u2717" :
          s.status === "skipped" ? "-" :
          i === flow.currentStepIndex ? "\u2192" : " ";
        const detail = s.detail ? ` (${s.detail})` : "";
        return `[${marker}] ${s.label}${detail}`;
      })
      .join("\n");
    return `\n--- Active Flow ---\nGoal: ${flow.goal}\n${progress}\n---`;
  }

  async runControlledAction({
    source,
    name,
    args = {},
    tabId = null,
    dangerous = false,
    requiresApproval = false,
    undoable,
    executor,
  }: ControlledActionOptions): Promise<string> {
    const action = this.startAction({
      source,
      name,
      args,
      tabId,
    });
    const actionStartedAt = Date.now();
    const transcriptStreamId = `action:${action.id}`;
    const transcriptTitle = humanizeActionName(name);

    this.emitActionLifecycle({
      actionId: action.id,
      source,
      name,
      args,
      tabId,
      phase: "started",
      detail: summarizeArgs(args),
    });

    this.publishTranscript({
      source,
      kind: "status",
      title: transcriptTitle,
      text: `Starting ${transcriptTitle.toLowerCase()}.`,
      streamId: transcriptStreamId,
      mode: "replace",
    });

    const approvalReason = this.getApprovalReason(dangerous, requiresApproval);
    if (approvalReason) {
      this.emitActionLifecycle({
        actionId: action.id,
        source,
        name,
        args,
        tabId,
        phase: "waiting-approval",
        detail: approvalReason,
        durationMs: Date.now() - actionStartedAt,
      });
      this.publishTranscript({
        source,
        kind: "status",
        title: transcriptTitle,
        text: `Waiting for approval: ${approvalReason}.`,
        streamId: transcriptStreamId,
        mode: "replace",
      });
      const approved = await this.awaitApproval(action, approvalReason);
      if (!approved) {
        this.emitActionLifecycle({
          actionId: action.id,
          source,
          name,
          args,
          tabId,
          phase: "rejected",
          detail: approvalReason,
          durationMs: Date.now() - actionStartedAt,
        });
        this.publishTranscript({
          source,
          kind: "status",
          title: transcriptTitle,
          text: `Rejected: ${approvalReason}.`,
          streamId: transcriptStreamId,
          mode: "final",
        });
        return `Action rejected: ${name}`;
      }
    }

    this.updateAction(action.id, {
      status: "running",
      error: undefined,
    });
    this.publishTranscript({
      source,
      kind: "status",
      title: transcriptTitle,
      text: `Running ${transcriptTitle.toLowerCase()}.`,
      streamId: transcriptStreamId,
      mode: "replace",
    });

    const shouldCaptureUndo = undoable ?? isUndoableAction(name);
    const undoSnapshot = shouldCaptureUndo
      ? this.createUndoSnapshot(name)
      : null;

    try {
      const result = await executor();
      if (undoSnapshot && isUndoableResult(result)) {
        this.pushUndoSnapshot(undoSnapshot);
      }
      this.finishAction(action.id, "completed", summarizeText(result));
      this.emitActionLifecycle({
        actionId: action.id,
        source,
        name,
        args,
        tabId,
        phase: "completed",
        detail: summarizeText(result),
        durationMs: Date.now() - actionStartedAt,
      });
      this.publishTranscript({
        source,
        kind: "status",
        title: transcriptTitle,
        text: summarizeText(result),
        streamId: transcriptStreamId,
        mode: "final",
      });
      this.captureSession();
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown action failure";
      this.state.supervisor.lastError = message;
      this.finishAction(action.id, "failed", undefined, message);
      this.emitActionLifecycle({
        actionId: action.id,
        source,
        name,
        args,
        tabId,
        phase: "failed",
        detail: summarizeText(message),
        durationMs: Date.now() - actionStartedAt,
      });
      this.publishTranscript({
        source,
        kind: "status",
        title: transcriptTitle,
        text: `Failed: ${summarizeText(message)}`,
        streamId: transcriptStreamId,
        mode: "final",
      });
      throw error;
    }
  }

  private emitActionLifecycle(event: AgentRuntimeActionLifecycleEvent): void {
    try {
      this.actionLifecycleListener?.(event);
    } catch (error) {
      logger.warn("Action lifecycle listener failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private createUndoSnapshot(name: string): UndoSnapshot {
    return {
      id: randomUUID(),
      actionName: name,
      snapshot: this.tabManager.snapshotSession(
        `Auto-checkpoint before ${name}`,
      ),
      capturedAt: new Date().toISOString(),
    };
  }

  private pushUndoSnapshot(snapshot: UndoSnapshot): void {
    this.undoSnapshots = [...this.undoSnapshots, snapshot].slice(
      -MAX_UNDO_SNAPSHOTS,
    );
  }

  resolveApproval(approvalId: string, approved: boolean): AgentRuntimeState {
    const approval = this.state.supervisor.pendingApprovals.find(
      (item) => item.id === approvalId,
    );
    if (!approval) return this.getState();

    this.state.supervisor.pendingApprovals =
      this.state.supervisor.pendingApprovals.filter(
        (item) => item.id !== approvalId,
      );

    const resolve = this.pendingResolvers.get(approvalId);
    this.pendingResolvers.delete(approvalId);
    if (resolve) {
      resolve(approved);
    }

    if (!approved) {
      this.finishAction(
        approval.actionId,
        "rejected",
        undefined,
        approval.reason,
      );
      return this.getState();
    }

    this.updateAction(approval.actionId, {
      status: "running",
      error: undefined,
    });
    this.emit();
    return this.getState();
  }

  private loadPersistedState(): AgentRuntimeState {
    try {
      // Constructor-time load stays sync so AgentRuntime is usable immediately;
      // hot-path writes are debounced and async in persistNow().
      const raw = fs.readFileSync(getRuntimeStatePath(), "utf-8");
      const parsed = JSON.parse(raw) as RuntimePersistenceShape;
      return sanitizePersistence(parsed);
    } catch (err) {
      logger.warn("Failed to load persisted runtime state, starting fresh:", err);
      return sanitizePersistence(null);
    }
  }

  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistDirty = false;

  private persistNow(): Promise<void> {
    this.persistDirty = false;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const persisted: RuntimePersistenceShape = {
      session: this.state.session,
      supervisor: {
        paused: this.state.supervisor.paused,
        approvalMode: this.state.supervisor.approvalMode,
        lastError: this.state.supervisor.lastError,
      },
      actions: this.state.actions.slice(-MAX_ACTIONS),
      checkpoints: this.state.checkpoints.slice(-MAX_CHECKPOINTS),
      taskMemory: this.state.taskMemory,
    };

    return fs.promises
      .mkdir(path.dirname(getRuntimeStatePath()), { recursive: true })
      .then(() =>
        fs.promises.writeFile(
          getRuntimeStatePath(),
          JSON.stringify(persisted, null, 2),
          "utf-8",
        ),
      )
      .catch((err) => logger.error("Failed to persist runtime state:", err));
  }

  private schedulePersist(): void {
    this.persistDirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.persistDirty) this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Flush any pending debounced persist to disk immediately. Call on shutdown. */
  flushPersist(): Promise<void> {
    return this.persistDirty ? this.persistNow() : Promise.resolve();
  }

  private emit(): void {
    this.schedulePersist();
    this.updateListener?.(this.getState());
  }

  private startAction(input: {
    source: ActionSource;
    name: string;
    args: Record<string, unknown>;
    tabId?: string | null;
  }): AgentActionEntry {
    const action: AgentActionEntry = {
      id: randomUUID(),
      source: input.source,
      name: input.name,
      args: clone(input.args),
      argsSummary: summarizeArgs(input.args),
      status: "running",
      startedAt: new Date().toISOString(),
      tabId: input.tabId,
    };
    this.state.actions = [...this.state.actions, action].slice(-MAX_ACTIONS);
    this.emit();
    return action;
  }

  private updateAction(
    actionId: string,
    patch: Partial<AgentActionEntry>,
  ): void {
    this.state.actions = this.state.actions.map((action) =>
      action.id === actionId ? { ...action, ...patch } : action,
    );
    this.emit();
  }

  private finishAction(
    actionId: string,
    status: AgentActionEntry["status"],
    resultSummary?: string,
    error?: string,
  ): void {
    const finishedAt = new Date().toISOString();
    const action = this.state.actions.find((a) => a.id === actionId);
    const durationMs = action
      ? new Date(finishedAt).getTime() - new Date(action.startedAt).getTime()
      : undefined;
    this.updateAction(actionId, {
      status,
      finishedAt,
      durationMs,
      resultSummary,
      error,
    });
  }

  /** Aggregate metrics for all completed actions in this session. */
  getMetrics(): {
    totalActions: number;
    completedActions: number;
    failedActions: number;
    averageDurationMs: number;
    toolBreakdown: Record<string, { count: number; avgMs: number; errors: number }>;
  } {
    const completed = this.state.actions.filter((a) => a.status === "completed");
    const failed = this.state.actions.filter((a) => a.status === "failed");
    const durations = completed.filter((a) => a.durationMs != null).map((a) => a.durationMs!);
    const avgDuration = durations.length > 0 ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;

    const toolBreakdown: Record<string, { count: number; totalMs: number; avgMs: number; errors: number }> = {};
    for (const action of this.state.actions) {
      const name = action.name;
      if (!toolBreakdown[name]) toolBreakdown[name] = { count: 0, totalMs: 0, avgMs: 0, errors: 0 };
      toolBreakdown[name].count++;
      if (action.durationMs != null) toolBreakdown[name].totalMs += action.durationMs;
      if (action.status === "failed") toolBreakdown[name].errors++;
    }
    for (const entry of Object.values(toolBreakdown)) {
      entry.avgMs = entry.count > 0 ? Math.round(entry.totalMs / entry.count) : 0;
    }

    return {
      totalActions: this.state.actions.length,
      completedActions: completed.length,
      failedActions: failed.length,
      averageDurationMs: Math.round(avgDuration),
      toolBreakdown: Object.fromEntries(
        Object.entries(toolBreakdown).map(([k, v]) => [k, { count: v.count, avgMs: v.avgMs, errors: v.errors }]),
      ),
    };
  }

  private getApprovalReason(dangerous: boolean, requiresApproval: boolean): string | null {
    if (this.state.supervisor.paused) {
      return "Agent execution is paused";
    }
    if (this.state.supervisor.approvalMode === "auto") {
      return null;
    }
    if (requiresApproval) {
      return "Approval required: high-risk action";
    }
    if (this.state.supervisor.approvalMode === "manual") {
      return "Approval required: ask every time mode";
    }
    if (
      this.state.supervisor.approvalMode === "confirm-dangerous" &&
      dangerous
    ) {
      return "Approval required: risky action";
    }
    return null;
  }

  private awaitApproval(
    action: AgentActionEntry,
    reason: string,
  ): Promise<boolean> {
    const approval: PendingApproval = {
      id: randomUUID(),
      actionId: action.id,
      source: action.source,
      name: action.name,
      argsSummary: action.argsSummary,
      reason,
      requestedAt: new Date().toISOString(),
    };

    this.state.supervisor.pendingApprovals = [
      ...this.state.supervisor.pendingApprovals,
      approval,
    ];
    this.updateAction(action.id, {
      status: "waiting-approval",
      error: reason,
    });

    return new Promise<boolean>((resolve) => {
      this.pendingResolvers.set(approval.id, resolve);
      this.emit();
    });
  }
}
