import { createSignal } from "solid-js";
import type { HistoryState, HistoryEntry, HistoryPage } from "../../../shared/types";
import { createLogger } from "../../../shared/logger";

const logger = createLogger("HistoryStore");
const HISTORY_PAGE_SIZE = 200;

const INITIAL: HistoryState = { entries: [] };

const [historyState, setHistoryState] = createSignal<HistoryState>(INITIAL);
const [historyTotal, setHistoryTotal] = createSignal(0);

let initialized = false;
let initPromise: Promise<void> | null = null;

async function init() {
  if (initPromise) return initPromise;
  if (initialized) return;
  initialized = true;
  initPromise = (async () => {
    try {
      const page = await window.vessel.history.list(0, HISTORY_PAGE_SIZE);
      setHistoryState({ entries: page.entries });
      setHistoryTotal(page.total);
      window.vessel.history.onUpdate((page) => {
        setHistoryState({ entries: page.entries });
        setHistoryTotal(page.total);
      });
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
  const loadMore = async (limit = HISTORY_PAGE_SIZE): Promise<HistoryPage> => {
    const current = historyState().entries;
    try {
      const page = await window.vessel.history.list(current.length, limit);
      setHistoryState({ entries: [...current, ...page.entries] });
      setHistoryTotal(page.total);
      return page;
    } catch (err) {
      logger.error("Failed to load more history entries:", err);
      return { entries: [], total: historyTotal() };
    }
  };

  return {
    historyState,
    historyTotal,
    hasMore: () => historyState().entries.length < historyTotal(),
    loadMore,
    list: (offset?: number, limit?: number): Promise<HistoryPage> =>
      window.vessel.history.list(offset, limit),
    search: (query: string): Promise<HistoryEntry[]> =>
      window.vessel.history.search(query),
    clear: () => window.vessel.history.clear(),
  };
}
