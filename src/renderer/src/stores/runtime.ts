import { createSignal } from "solid-js";
import type { AgentRuntimeState, ApprovalMode } from "../../../shared/types";
import { createLogger } from "../../../shared/logger";

const logger = createLogger("RuntimeStore");

const DEFAULT_RUNTIME_STATE: AgentRuntimeState = {
  session: null,
  supervisor: {
    paused: false,
    approvalMode: "confirm-dangerous",
    pendingApprovals: [],
  },
  actions: [],
  checkpoints: [],
  transcript: [],
  mcpStatus: "stopped",
  flowState: null,
  taskTracker: null,
};

const [runtimeState, setRuntimeState] = createSignal<AgentRuntimeState>(
  DEFAULT_RUNTIME_STATE,
);

let initialized = false;
let initPromise: Promise<void> | null = null;

async function init() {
  if (initPromise) return initPromise;
  if (initialized) return;
  initialized = true;
  initPromise = (async () => {
    try {
      const initial = await window.vessel.ai.getRuntime();
      setRuntimeState(initial);
      window.vessel.ai.onRuntimeUpdate((state) => {
        setRuntimeState(state);
      });
    } catch (error) {
      initialized = false;
      logger.error("Failed to initialize runtime store:", error);
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

export function useRuntime() {
  void init();
  return {
    runtimeState,
    pause: () => window.vessel.ai.pause(),
    resume: () => window.vessel.ai.resume(),
    setApprovalMode: (mode: ApprovalMode) =>
      window.vessel.ai.setApprovalMode(mode),
    resolveApproval: (approvalId: string, approved: boolean) =>
      window.vessel.ai.resolveApproval(approvalId, approved),
    createCheckpoint: (name?: string, note?: string) =>
      window.vessel.ai.createCheckpoint(name, note),
    restoreCheckpoint: (checkpointId: string) =>
      window.vessel.ai.restoreCheckpoint(checkpointId),
    captureSession: (note?: string) => window.vessel.ai.captureSession(note),
    restoreSession: () => window.vessel.ai.restoreSession(),
  };
}
