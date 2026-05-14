import { createSignal } from "solid-js";
import type { ResearchState } from "../../../shared/research-types";
import { isPremiumStatus } from "../lib/premium";

const initialState: ResearchState = {
  phase: "idle",
  supervisionMode: "interactive",
  includeTraces: false,
  objectives: null,
  threads: [],
  threadProgress: [],
  threadFindings: [],
  report: null,
  subAgentTraces: [],
  error: null,
  startedAt: null,
  originalQuery: null,
};

const [researchState, setResearchState] = createSignal<ResearchState>(initialState);
const [isResearchPremium, setIsResearchPremium] = createSignal(false);

let initialized = false;
let cleanup: (() => void) | null = null;
let premiumCleanup: (() => void) | null = null;

function init(): void {
  if (initialized) return;
  initialized = true;

  // Check premium status once, then subscribe to updates
  window.vessel.premium.getState().then((premium) => {
    setIsResearchPremium(isPremiumStatus(premium.status));
  });
  premiumCleanup = window.vessel.premium.onUpdate((premium) => {
    setIsResearchPremium(isPremiumStatus(premium.status));
  });

  // Fetch initial state
  window.vessel.research.getState().then((state) => {
    setResearchState(state);
  });

  // Listen for state updates
  cleanup = window.vessel.research.onStateUpdate((state) => {
    setResearchState(state);
  });
}

export function useResearch() {
  init();

  return {
    state: researchState,
    isPremium: isResearchPremium,

    startBrief(query: string) {
      return window.vessel.research.startBrief(query);
    },

    confirmBrief() {
      return window.vessel.research.confirmBrief();
    },

    approveObjectives(options?: {
      supervisionMode?: "walk-away" | "interactive";
      includeTraces?: boolean;
    }) {
      return window.vessel.research.approveObjectives(options);
    },

    setMode(mode: "walk-away" | "interactive") {
      return window.vessel.research.setMode(mode);
    },

    setTraces(include: boolean) {
      return window.vessel.research.setTraces(include);
    },

    cancel() {
      return window.vessel.research.cancel();
    },

    stopAndSynthesize() {
      return window.vessel.research.stopAndSynthesize();
    },

    exportReport() {
      return window.vessel.research.exportReport();
    },

    destroy() {
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
      if (premiumCleanup) {
        premiumCleanup();
        premiumCleanup = null;
      }
      initialized = false;
    },
  };
}
