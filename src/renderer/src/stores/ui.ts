import { createSignal } from "solid-js";

const DEFAULT_SIDEBAR_WIDTH = 400;
const MIN_SIDEBAR = 240;
const MAX_SIDEBAR = 800;

const [sidebarOpen, setSidebarOpen] = createSignal(true);
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

let pendingWidth: number | null = null;
let resizeInFlight: Promise<void> | null = null;

async function flushResize(): Promise<void> {
  if (resizeInFlight) {
    await resizeInFlight;
    if (pendingWidth !== null) {
      return flushResize();
    }
    return;
  }

  resizeInFlight = (async () => {
    while (pendingWidth !== null) {
      const nextWidth = pendingWidth;
      pendingWidth = null;
      await window.vessel.ui.resizeSidebar(nextWidth);
    }
  })();

  try {
    await resizeInFlight;
  } finally {
    resizeInFlight = null;
  }
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
      // Clamp + update CSS immediately.
      const clamped = Math.max(
        MIN_SIDEBAR,
        Math.min(MAX_SIDEBAR, Math.round(width)),
      );
      setSidebarWidth(clamped);
      pendingWidth = clamped;
      void flushResize();
    },
    commitResize: async () => {
      pendingWidth = sidebarWidth();
      await flushResize();
      await window.vessel.ui.commitSidebarResize();
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
