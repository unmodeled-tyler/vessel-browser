import { createSignal } from "solid-js";
import type { HistoryState, HistoryEntry } from "../../../shared/types";
import { createLogger } from "../../../shared/logger";

const logger = createLogger("HistoryStore");

const INITIAL: HistoryState = { entries: [] };

const [historyState, setHistoryState] = createSignal<HistoryState>(INITIAL);

let initialized = false;
let initPromise: Promise<void> | null = null;

async function init() {
  if (initPromise) return initPromise;
  if (initialized) return;
  initialized = true;
  initPromise = (async () => {
    try {
      const state = await window.vessel.history.get();
      setHistoryState(state);
      window.vessel.history.onUpdate((s) => setHistoryState(s));
    } catch (error) {
      initialized = false;
      logger.error("Failed to initialize history store:", error);
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

export function useHistory() {
  void init();
  return {
    historyState,
    search: (query: string): Promise<HistoryEntry[]> =>
      window.vessel.history.search(query),
    clear: () => window.vessel.history.clear(),
  };
}
