import { createSignal } from "solid-js";
import type { SecurityState } from "../../../shared/types";

const [securityStates, setSecurityStates] = createSignal<Record<string, SecurityState>>({});

let unsubscribe: (() => void) | null = null;

export function initSecurityStore(): void {
  if (unsubscribe) return;
  unsubscribe = window.vessel.security.onStateUpdate((tabId, state) => {
    setSecurityStates((prev) => ({ ...prev, [tabId]: state }));
  });
}

/** Remove entries for tab IDs no longer in the given set (e.g. closed tabs). */
export function pruneSecurityStates(activeTabIds: Set<string>): void {
  setSecurityStates((prev) => {
    const keys = Object.keys(prev);
    if (keys.length === 0) return prev;
    let changed = false;
    const next: Record<string, SecurityState> = {};
    for (const key of keys) {
      if (activeTabIds.has(key)) {
        next[key] = prev[key];
      } else {
        changed = true;
      }
    }
    return changed ? next : prev;
  });
}

export function useSecurity() {
  return {
    securityStates,
    getSecurityState(tabId: string): SecurityState | undefined {
      return securityStates()[tabId];
    },
    proceedAnyway(tabId: string): void {
      void window.vessel.security.proceedAnyway(tabId);
    },
    goBackToSafety(tabId: string): void {
      void window.vessel.security.goBackToSafety(tabId);
    },
  };
}