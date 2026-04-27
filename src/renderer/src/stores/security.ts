import { createSignal } from "solid-js";
import type { SecurityState } from "../../../shared/types";

const [securityStates, setSecurityStates] = createSignal<Map<string, SecurityState>>(new Map());

let unsubscribe: (() => void) | null = null;

export function initSecurityStore(): void {
  if (unsubscribe) return;
  unsubscribe = window.vessel.security.onStateUpdate((tabId, state) => {
    setSecurityStates((prev) => {
      const next = new Map(prev);
      next.set(tabId, state);
      return next;
    });
  });
}

export function useSecurity() {
  return {
    securityStates,
    getSecurityState(tabId: string): SecurityState | undefined {
      return securityStates().get(tabId);
    },
  };
}