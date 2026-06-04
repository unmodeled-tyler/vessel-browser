import { BaseWindow, type WebContentsView } from "electron";
import { Channels } from "../shared/channels";
import {
  DETACHED_SIDEBAR_DEFAULT_HEIGHT,
  DETACHED_SIDEBAR_DEFAULT_WIDTH,
  DETACHED_SIDEBAR_MIN_HEIGHT,
  DETACHED_SIDEBAR_MIN_WIDTH,
} from "../shared/sidebar";
import type { SidebarPanelState, UIState } from "../shared/types";
import { setSetting } from "./config/settings";
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
  const sidebarWindow = new BaseWindow({
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
  });

  state.mainWindow.contentView.removeChildView(state.sidebarView);
  sidebarWindow.contentView.addChildView(state.sidebarView);
  state.sidebarWindow = sidebarWindow;
  setSidebarPanelMode(state, "detached");

  sidebarWindow.on("resize", () => {
    layoutDetachedSidebar(state);
    persistDetachedBounds(state);
  });
  sidebarWindow.on("move", () => persistDetachedBounds(state));
  sidebarWindow.on("close", (event) => {
    if (state.sidebarWindowClosing) return;
    event.preventDefault();
    dockSidebar(state, hooks);
  });
  sidebarWindow.on("closed", () => {
    if (state.sidebarWindow !== sidebarWindow) return;
    state.sidebarWindow = null;
    setSidebarPanelMode(state, "docked");
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
