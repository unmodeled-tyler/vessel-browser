import { type BaseWindow, type WebContentsView } from "electron";
import { Channels } from "../shared/channels";
import {
  DETACHED_SIDEBAR_DEFAULT_HEIGHT,
  DETACHED_SIDEBAR_DEFAULT_WIDTH,
  DETACHED_SIDEBAR_MIN_HEIGHT,
  DETACHED_SIDEBAR_MIN_WIDTH,
} from "../shared/sidebar";
import type { SidebarPanelState, UIState } from "../shared/types";
import { setSetting } from "./config/settings";
import {
  closeDetachedViewWindow,
  createDetachedViewWindow,
  moveDetachedViewToMainWindow,
} from "./detached-view-host";
import { sendSafe } from "./ipc/common";

export type SidebarPanelHostState = {
  mainWindow: BaseWindow;
  sidebarWindow: BaseWindow | null;
  sidebarWindowClosing: boolean;
  chromeView: WebContentsView;
  sidebarView: WebContentsView;
  uiState: UIState;
};

type SidebarPanelHooks = {
  relayout: () => void;
  getWindowIconPath: () => string | undefined;
};

type SidebarPanelTransitionReason = "user" | "temporary";

const sidebarDetachedHost = {
  getWindow: (state: SidebarPanelHostState) => state.sidebarWindow,
  setWindow: (state: SidebarPanelHostState, window: BaseWindow | null) => {
    state.sidebarWindow = window;
  },
  isClosing: (state: SidebarPanelHostState) => state.sidebarWindowClosing,
  setClosing: (state: SidebarPanelHostState, closing: boolean) => {
    state.sidebarWindowClosing = closing;
  },
  getView: (state: SidebarPanelHostState) => state.sidebarView,
};

function setSidebarPanelMode(
  state: SidebarPanelHostState,
  mode: UIState["sidebarPanelMode"],
  reason: SidebarPanelTransitionReason = "user",
): void {
  state.uiState.sidebarPanelMode = mode;
  if (reason === "user") {
    setSetting("sidebarPanelMode", mode);
  }
}

function persistDetachedBounds(state: SidebarPanelHostState): void {
  const sidebarWindow = state.sidebarWindow;
  if (!sidebarWindow || sidebarWindow.isDestroyed()) return;
  const bounds = sidebarWindow.getBounds();
  state.uiState.sidebarDetachedBounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
  setSetting("sidebarDetachedBounds", state.uiState.sidebarDetachedBounds);
}

export function closeDetachedSidebarWindow(
  state: SidebarPanelHostState,
): boolean {
  return closeDetachedViewWindow(state, sidebarDetachedHost);
}

function moveSidebarToMainWindow(state: SidebarPanelHostState): void {
  moveDetachedViewToMainWindow(state, sidebarDetachedHost);
}

export function getSidebarPanelState(
  state: SidebarPanelHostState,
): SidebarPanelState {
  return {
    open: state.uiState.sidebarPanelMode !== "closed",
    width: state.uiState.sidebarWidth,
    detached: state.uiState.sidebarPanelMode === "detached",
  };
}

export function emitSidebarPanelState(
  state: SidebarPanelHostState,
): SidebarPanelState {
  const panelState = getSidebarPanelState(state);
  sendSafe(state.chromeView.webContents, Channels.SIDEBAR_STATE_UPDATE, panelState);
  sendSafe(state.sidebarView.webContents, Channels.SIDEBAR_STATE_UPDATE, panelState);
  return panelState;
}

export function isSidebarAttached(state: SidebarPanelHostState): boolean {
  return state.uiState.sidebarPanelMode === "docked";
}

export function isSidebarDetached(state: SidebarPanelHostState): boolean {
  return state.uiState.sidebarPanelMode === "detached";
}

export function closeSidebar(
  state: SidebarPanelHostState,
  relayout: () => void,
  reason: SidebarPanelTransitionReason = "user",
): SidebarPanelState {
  if (state.sidebarWindow) {
    moveSidebarToMainWindow(state);
    closeDetachedSidebarWindow(state);
  }
  setSidebarPanelMode(state, "closed", reason);
  relayout();
  return emitSidebarPanelState(state);
}

export function openDockedSidebar(
  state: SidebarPanelHostState,
  relayout: () => void,
): SidebarPanelState {
  setSidebarPanelMode(state, "docked");
  relayout();
  return emitSidebarPanelState(state);
}

export function toggleDockedSidebar(
  state: SidebarPanelHostState,
  relayout: () => void,
): SidebarPanelState {
  if (isSidebarDetached(state)) {
    state.sidebarWindow?.focus();
    return getSidebarPanelState(state);
  }
  setSidebarPanelMode(
    state,
    state.uiState.sidebarPanelMode === "docked" ? "closed" : "docked",
  );
  relayout();
  return emitSidebarPanelState(state);
}

export function layoutDetachedSidebar(state: SidebarPanelHostState): void {
  if (!state.sidebarWindow) return;
  const [width, height] = state.sidebarWindow.getContentSize();
  state.sidebarView.setBounds({ x: 0, y: 0, width, height });
}

export function detachSidebar(
  state: SidebarPanelHostState,
  hooks: SidebarPanelHooks,
): SidebarPanelState {
  if (state.sidebarWindow) {
    state.sidebarWindow.focus();
    return getSidebarPanelState(state);
  }

  const detachedBounds = state.uiState.sidebarDetachedBounds;
  const detachedWidth =
    detachedBounds?.width ??
    Math.max(DETACHED_SIDEBAR_DEFAULT_WIDTH, state.uiState.sidebarWidth);
  const detachedHeight =
    detachedBounds?.height ?? DETACHED_SIDEBAR_DEFAULT_HEIGHT;
  const sidebarWindow = createDetachedViewWindow(state, {
    ...sidebarDetachedHost,
    createWindowOptions: () => ({
      ...(typeof detachedBounds?.x === "number" ? { x: detachedBounds.x } : {}),
      ...(typeof detachedBounds?.y === "number" ? { y: detachedBounds.y } : {}),
      width: Math.max(DETACHED_SIDEBAR_MIN_WIDTH, Math.round(detachedWidth)),
      height: Math.max(DETACHED_SIDEBAR_MIN_HEIGHT, Math.round(detachedHeight)),
      minWidth: DETACHED_SIDEBAR_MIN_WIDTH,
      minHeight: DETACHED_SIDEBAR_MIN_HEIGHT,
      frame: true,
      show: false,
      backgroundColor: "#1a1a1e",
      title: "Vessel Agent",
      icon: hooks.getWindowIconPath(),
    }),
    layoutView: layoutDetachedSidebar,
    persistBounds: persistDetachedBounds,
    onNativeClose: () => dockSidebar(state, hooks),
    onUnexpectedClosed: () => {
      state.sidebarWindow = null;
      setSidebarPanelMode(state, "docked");
      state.mainWindow.contentView.addChildView(state.sidebarView);
      hooks.relayout();
      emitSidebarPanelState(state);
    },
  });

  setSidebarPanelMode(state, "detached");

  hooks.relayout();
  layoutDetachedSidebar(state);
  sidebarWindow.show();
  sidebarWindow.focus();
  return emitSidebarPanelState(state);
}

export function dockSidebar(
  state: SidebarPanelHostState,
  hooks: Pick<SidebarPanelHooks, "relayout">,
): SidebarPanelState {
  const sidebarWindow = state.sidebarWindow;
  if (!sidebarWindow) {
    setSidebarPanelMode(state, "docked");
    hooks.relayout();
    return emitSidebarPanelState(state);
  }

  setSidebarPanelMode(state, "docked");
  moveSidebarToMainWindow(state);
  hooks.relayout();
  closeDetachedSidebarWindow(state);
  state.mainWindow.focus();
  return emitSidebarPanelState(state);
}
