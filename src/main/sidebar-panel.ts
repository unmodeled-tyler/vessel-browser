import { BaseWindow, type WebContentsView } from "electron";
import { Channels } from "../shared/channels";
import type { SidebarPanelState, UIState } from "../shared/types";

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

const DETACHED_WINDOW_MIN_WIDTH = 360;
const DETACHED_WINDOW_MIN_HEIGHT = 480;
const DETACHED_WINDOW_DEFAULT_WIDTH = 420;
const DETACHED_WINDOW_DEFAULT_HEIGHT = 760;

export function closeDetachedSidebarWindow(
  state: SidebarPanelHostState,
): boolean {
  const sidebarWindow = state.sidebarWindow;
  if (!sidebarWindow) return false;

  state.sidebarWindow = null;
  state.sidebarWindowClosing = true;
  sidebarWindow.once("closed", () => {
    state.sidebarWindowClosing = false;
  });
  sidebarWindow.close();
  return true;
}

function moveSidebarToMainWindow(state: SidebarPanelHostState): void {
  state.sidebarWindow?.contentView.removeChildView(state.sidebarView);
  state.mainWindow.contentView.addChildView(state.sidebarView);
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
  if (!state.chromeView.webContents.isDestroyed()) {
    state.chromeView.webContents.send(Channels.SIDEBAR_STATE_UPDATE, panelState);
  }
  if (!state.sidebarView.webContents.isDestroyed()) {
    state.sidebarView.webContents.send(
      Channels.SIDEBAR_STATE_UPDATE,
      panelState,
    );
  }
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
): SidebarPanelState {
  if (state.sidebarWindow) {
    moveSidebarToMainWindow(state);
    closeDetachedSidebarWindow(state);
  }
  state.uiState.sidebarPanelMode = "closed";
  relayout();
  return emitSidebarPanelState(state);
}

export function openDockedSidebar(
  state: SidebarPanelHostState,
  relayout: () => void,
): SidebarPanelState {
  state.uiState.sidebarPanelMode = "docked";
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
  state.uiState.sidebarPanelMode =
    state.uiState.sidebarPanelMode === "docked" ? "closed" : "docked";
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

  const sidebarWindow = new BaseWindow({
    width: Math.max(DETACHED_WINDOW_DEFAULT_WIDTH, state.uiState.sidebarWidth),
    height: DETACHED_WINDOW_DEFAULT_HEIGHT,
    minWidth: DETACHED_WINDOW_MIN_WIDTH,
    minHeight: DETACHED_WINDOW_MIN_HEIGHT,
    frame: true,
    show: false,
    backgroundColor: "#1a1a1e",
    title: "Vessel Agent",
    icon: hooks.getWindowIconPath(),
  });

  state.mainWindow.contentView.removeChildView(state.sidebarView);
  sidebarWindow.contentView.addChildView(state.sidebarView);
  state.sidebarWindow = sidebarWindow;
  state.uiState.sidebarPanelMode = "detached";

  sidebarWindow.on("resize", () => layoutDetachedSidebar(state));
  sidebarWindow.on("close", (event) => {
    if (state.sidebarWindowClosing) return;
    event.preventDefault();
    dockSidebar(state, hooks);
  });
  sidebarWindow.on("closed", () => {
    if (state.sidebarWindow !== sidebarWindow) return;
    state.sidebarWindow = null;
    state.uiState.sidebarPanelMode = "docked";
    state.mainWindow.contentView.addChildView(state.sidebarView);
    hooks.relayout();
    emitSidebarPanelState(state);
  });

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
    state.uiState.sidebarPanelMode = "docked";
    hooks.relayout();
    return emitSidebarPanelState(state);
  }

  state.uiState.sidebarPanelMode = "docked";
  moveSidebarToMainWindow(state);
  hooks.relayout();
  closeDetachedSidebarWindow(state);
  state.mainWindow.focus();
  return emitSidebarPanelState(state);
}
