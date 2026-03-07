import { createSignal } from 'solid-js';

const [sidebarOpen, setSidebarOpen] = createSignal(false);
const [focusMode, setFocusMode] = createSignal(false);
const [commandBarOpen, setCommandBarOpen] = createSignal(false);
const [settingsOpen, setSettingsOpen] = createSignal(false);

export function useUI() {
  return {
    sidebarOpen,
    focusMode,
    commandBarOpen,
    settingsOpen,
    toggleSidebar: async () => {
      const result = await window.vessel.ui.toggleSidebar();
      setSidebarOpen(result);
    },
    toggleFocusMode: async () => {
      const result = await window.vessel.ui.toggleFocusMode();
      setFocusMode(result);
    },
    openCommandBar: () => setCommandBarOpen(true),
    closeCommandBar: () => setCommandBarOpen(false),
    openSettings: () => setSettingsOpen(true),
    closeSettings: () => setSettingsOpen(false),
  };
}
