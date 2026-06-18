import { createSignal } from "solid-js";
import type { DevToolsPanelHostState } from "../../../shared/devtools-types";
import { clampSidebarWidth } from "../../../shared/sidebar";
import type { SidebarPanelState } from "../../../shared/types";

const DEFAULT_SIDEBAR_WIDTH = 400;

const [sidebarOpen, setSidebarOpen] = createSignal(true);
const [sidebarWidth, setSidebarWidth] = createSignal(DEFAULT_SIDEBAR_WIDTH);
const [sidebarDetached, setSidebarDetached] = createSignal(false);

// Sync initial sidebar width from persisted settings so the sidebar view
// (a separate WebContentsView) renders at the correct width on first open
// instead of using the hardcoded default.
window.vessel?.settings?.get().then((settings: { sidebarWidth?: number }) => {
  if (settings?.sidebarWidth && typeof settings.sidebarWidth === "number") {
    setSidebarWidth(clampSidebarWidth(settings.sidebarWidth));
  }
}).catch(() => {/* settings unavailable — keep default */});
const [focusMode, setFocusMode] = createSignal(false);
const [commandBarOpen, setCommandBarOpen] = createSignal(false);
const [browserCommandPaletteOpen, setBrowserCommandPaletteOpen] =
  createSignal(false);
const [settingsOpen, setSettingsOpen] = createSignal(false);
const [devtoolsPanelOpen, setDevtoolsPanelOpen] = createSignal(false);
const [devtoolsPanelDetached, setDevtoolsPanelDetached] = createSignal(false);

// Track last IPC time to throttle IPC calls (not layout updates)
let lastIpcTime = 0;
const IPC_THROTTLE_MS = 8; // ~120fps max for IPC (layout is already 60fps via RAF)
let sidebarStateListenerInitialized = false;
let devtoolsPanelStateListenerInitialized = false;

function applySidebarState(result: SidebarPanelState): void {
  setSidebarOpen(result.open);
  setSidebarWidth(result.width);
  setSidebarDetached(result.detached);
}

function ensureSidebarStateListener(): void {
  if (sidebarStateListenerInitialized) return;
  sidebarStateListenerInitialized = true;
  window.vessel?.ui?.onSidebarStateUpdate?.(applySidebarState);
}

function applyDevToolsPanelState(result: DevToolsPanelHostState): void {
  setDevtoolsPanelOpen(result.open);
  setDevtoolsPanelDetached(result.detached);
}

function ensureDevToolsPanelStateListener(): void {
  if (devtoolsPanelStateListenerInitialized) return;
  devtoolsPanelStateListenerInitialized = true;
  window.vessel?.devtoolsPanel?.onHostStateUpdate?.(applyDevToolsPanelState);
  void window.vessel?.devtoolsPanel?.getHostState?.()
    .then(applyDevToolsPanelState)
    .catch(() => {
      /* devtools host state may be unavailable during early bootstrap */
    });
}

export function useUI() {
  ensureSidebarStateListener();
  ensureDevToolsPanelStateListener();
  return {
    sidebarOpen,
    sidebarWidth,
    sidebarDetached,
    focusMode,
    commandBarOpen,
    browserCommandPaletteOpen,
    settingsOpen,
    devtoolsPanelOpen,
    devtoolsPanelDetached,
    toggleSidebar: async () => {
      const result = await window.vessel.ui.toggleSidebar();
      applySidebarState(result);
    },
    popOutSidebar: async () => {
      const result = await window.vessel.ui.popOutSidebar();
      applySidebarState(result);
    },
    dockSidebar: async () => {
      const result = await window.vessel.ui.dockSidebar();
      applySidebarState(result);
    },
    resizeSidebar: (width: number) => {
      // Clamp + update CSS immediately via Solid signal
      const clamped = clampSidebarWidth(width);
      setSidebarWidth(clamped);

      // Throttle IPC to main process (layout updates independently at 60fps)
      const now = performance.now();
      if (now - lastIpcTime >= IPC_THROTTLE_MS) {
        lastIpcTime = now;
        void window.vessel.ui.resizeSidebar(clamped);
      }
    },
    commitResize: async () => {
      const finalWidth = clampSidebarWidth(sidebarWidth());
      lastIpcTime = performance.now();
      await window.vessel.ui.resizeSidebar(finalWidth);
      await window.vessel.ui.commitSidebarResize();
    },
    toggleFocusMode: async () => {
      const result = await window.vessel.ui.toggleFocusMode();
      setFocusMode(result);
    },
    toggleDevTools: async () => {
      const result = await window.vessel.devtoolsPanel.toggle();
      applyDevToolsPanelState(result);
    },
    openCommandBar: () => setCommandBarOpen(true),
    closeCommandBar: () => setCommandBarOpen(false),
    openBrowserCommandPalette: () => setBrowserCommandPaletteOpen(true),
    closeBrowserCommandPalette: () => setBrowserCommandPaletteOpen(false),
    openSettings: async () => {
      setSidebarOpen(false);
      setSettingsOpen(true);
      await window.vessel.ui.setSettingsVisibility(true);
    },
    closeSettings: async () => {
      setSettingsOpen(false);
      await window.vessel.ui.setSettingsVisibility(false);
    },
  };
}
