import { createSignal } from 'solid-js';
import type { TabState } from '../../../shared/types';
import { createLogger } from '../../../shared/logger';

const logger = createLogger("TabsStore");

const [tabs, setTabs] = createSignal<TabState[]>([]);
const [activeTabId, setActiveTabId] = createSignal('');

let initialized = false;
let initPromise: Promise<void> | null = null;
let unsubscribeStateUpdate: (() => void) | null = null;

async function doInit(): Promise<void> {
  try {
    if (unsubscribeStateUpdate) {
      unsubscribeStateUpdate();
      unsubscribeStateUpdate = null;
    }
    unsubscribeStateUpdate = window.vessel.tabs.onStateUpdate(
      (newTabs: TabState[], newActiveId: string) => {
        setTabs(newTabs);
        setActiveTabId(newActiveId);
      },
    );
    const initialState = await window.vessel.tabs.getState();
    setTabs(initialState.tabs);
    setActiveTabId(initialState.activeId);
  } catch (error) {
    initialized = false;
    logger.error("Failed to initialize tabs store:", error);
    throw error;
  }
}

function init(): Promise<void> | undefined {
  if (initPromise) return initPromise;
  if (initialized) return;
  initialized = true;
  initPromise = doInit().finally(() => {
    initPromise = null;
  });
  return initPromise;
}

const patchTab = (id: string, patch: Partial<TabState>) => {
  setTabs((prev) =>
    prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  );
};

export function useTabs() {
  init();
  return {
    tabs,
    activeTabId,
    activeTab: () => tabs().find((t) => t.id === activeTabId()),
    createTab: (url?: string) => window.vessel.tabs.create(url),
    closeTab: (id: string) => window.vessel.tabs.close(id),
    switchTab: (id: string) => window.vessel.tabs.switch(id),
    navigate: (url: string) => {
      const id = activeTabId();
      if (id) window.vessel.tabs.navigate(id, url);
    },
    goBack: () => {
      const id = activeTabId();
      if (id) window.vessel.tabs.back(id);
    },
    goForward: () => {
      const id = activeTabId();
      if (id) window.vessel.tabs.forward(id);
    },
    reload: () => {
      const id = activeTabId();
      if (id) window.vessel.tabs.reload(id);
    },
    toggleAdBlock: async (id: string): Promise<boolean | null> => {
      const newState = await window.vessel.tabs.toggleAdBlock(id);
      if (newState !== null && newState !== undefined) {
        patchTab(id, { adBlockingEnabled: newState });
      }
      return newState;
    },
    zoomIn: (id: string) => window.vessel.tabs.zoomIn(id),
    zoomOut: (id: string) => window.vessel.tabs.zoomOut(id),
    zoomReset: (id: string) => window.vessel.tabs.zoomReset(id),
    reopenClosed: () => window.vessel.tabs.reopenClosed(),
    duplicate: (id: string) => window.vessel.tabs.duplicate(id),
  };
}
