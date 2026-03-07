import { createSignal } from 'solid-js';

const DEFAULT_SIDEBAR_WIDTH = 340;
const MIN_SIDEBAR = 240;
const MAX_SIDEBAR = 800;

const [sidebarOpen, setSidebarOpen] = createSignal(false);
const [sidebarWidth, setSidebarWidth] = createSignal(DEFAULT_SIDEBAR_WIDTH);
const [focusMode, setFocusMode] = createSignal(false);
const [commandBarOpen, setCommandBarOpen] = createSignal(false);
const [settingsOpen, setSettingsOpen] = createSignal(false);

// Throttled IPC for resize — fire at most once per animation frame
let resizeRafId: number | null = null;
let pendingWidth: number | null = null;

function flushResize() {
  if (pendingWidth !== null) {
    window.vessel.ui.resizeSidebar(pendingWidth);
    pendingWidth = null;
  }
  resizeRafId = null;
}

export function useUI() {
  return {
    sidebarOpen,
    sidebarWidth,
    focusMode,
    commandBarOpen,
    settingsOpen,
    toggleSidebar: async () => {
      const result = await window.vessel.ui.toggleSidebar();
      setSidebarOpen(result.open);
      setSidebarWidth(result.width);
    },
    resizeSidebar: (width: number) => {
      // Clamp + update CSS immediately (no await)
      const clamped = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, Math.round(width)));
      setSidebarWidth(clamped);
      // Batch IPC to main process via rAF
      pendingWidth = clamped;
      if (resizeRafId === null) {
        resizeRafId = requestAnimationFrame(flushResize);
      }
    },
    commitResize: () => {
      // Force flush on mouseup so final width is persisted
      if (resizeRafId !== null) {
        cancelAnimationFrame(resizeRafId);
        resizeRafId = null;
      }
      if (pendingWidth !== null) {
        window.vessel.ui.resizeSidebar(pendingWidth);
        pendingWidth = null;
      }
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
