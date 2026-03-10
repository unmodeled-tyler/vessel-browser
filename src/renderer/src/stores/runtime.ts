import { createSignal } from "solid-js";
import type { AgentRuntimeState, ApprovalMode } from "../../../shared/types";

const DEFAULT_RUNTIME_STATE: AgentRuntimeState = {
  session: null,
  supervisor: {
    paused: false,
    approvalMode: "confirm-dangerous",
    pendingApprovals: [],
  },
  actions: [],
  checkpoints: [],
};

const [runtimeState, setRuntimeState] = createSignal<AgentRuntimeState>(
  DEFAULT_RUNTIME_STATE,
);

let initialized = false;

async function init() {
  if (initialized) return;
  try {
    const initial = await window.vessel.ai.getRuntime();
    setRuntimeState(initial);
    window.vessel.ai.onRuntimeUpdate((state) => {
      setRuntimeState(state);
    });
    initialized = true;
  } catch (error) {
    console.error("Failed to initialize runtime store", error);
  }
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
