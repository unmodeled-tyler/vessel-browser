import { createSignal } from "solid-js";

const DEFAULT_SIDEBAR_WIDTH = 340;
const MIN_SIDEBAR = 240;
const MAX_SIDEBAR = 800;

const [sidebarOpen, setSidebarOpen] = createSignal(false);
const [sidebarWidth, setSidebarWidth] = createSignal(DEFAULT_SIDEBAR_WIDTH);

// Sync initial sidebar width from persisted settings so the sidebar view
// (a separate WebContentsView) renders at the correct width on first open
// instead of using the hardcoded default.
window.vessel?.settings?.get().then((settings: { sidebarWidth?: number }) => {
  if (settings?.sidebarWidth && typeof settings.sidebarWidth === "number") {
    setSidebarWidth(
      Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, settings.sidebarWidth)),
    );
  }
}).catch(() => {/* settings unavailable — keep default */});
const [focusMode, setFocusMode] = createSignal(false);
const [commandBarOpen, setCommandBarOpen] = createSignal(false);
const [settingsOpen, setSettingsOpen] = createSignal(false);
const [devtoolsPanelOpen, setDevtoolsPanelOpen] = createSignal(false);

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
    devtoolsPanelOpen,
    toggleSidebar: async () => {
      const result = await window.vessel.ui.toggleSidebar();
      setSidebarOpen(result.open);
      setSidebarWidth(result.width);
    },
    resizeSidebar: (width: number) => {
      // Clamp + update CSS immediately (no await)
      const clamped = Math.max(
        MIN_SIDEBAR,
        Math.min(MAX_SIDEBAR, Math.round(width)),
      );
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
      window.vessel.ui.commitSidebarResize();
    },
    toggleFocusMode: async () => {
      const result = await window.vessel.ui.toggleFocusMode();
      setFocusMode(result);
    },
    toggleDevTools: async () => {
      const result = await window.vessel.devtoolsPanel.toggle();
      setDevtoolsPanelOpen(result.open);
    },
    openCommandBar: () => setCommandBarOpen(true),
    closeCommandBar: () => setCommandBarOpen(false),
    openSettings: async () => {
      setSettingsOpen(true);
      await window.vessel.ui.setSettingsVisibility(true);
    },
    closeSettings: async () => {
      setSettingsOpen(false);
      await window.vessel.ui.setSettingsVisibility(false);
    },
  };
}
