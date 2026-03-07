import { createSignal } from 'solid-js';
import type { TabState } from '../../../shared/types';

const [tabs, setTabs] = createSignal<TabState[]>([]);
const [activeTabId, setActiveTabId] = createSignal('');

let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;
  window.vessel.tabs.onStateUpdate(
    (newTabs: TabState[], newActiveId: string) => {
      setTabs(newTabs);
      setActiveTabId(newActiveId);
    },
  );
}

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
  };
}
