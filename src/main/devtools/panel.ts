import { type BaseWindow, type IpcMain, type WebContentsView } from "electron";
import { Channels } from "../../shared/channels";
import type {
  DevToolsPanelHostState,
  DevToolsPanelState,
} from "../../shared/devtools-types";
import type { UIState } from "../../shared/types";
import {
  DETACHED_DEVTOOLS_DEFAULT_HEIGHT,
  DETACHED_DEVTOOLS_DEFAULT_WIDTH,
  DETACHED_DEVTOOLS_MIN_HEIGHT,
  DETACHED_DEVTOOLS_MIN_WIDTH,
} from "../../shared/devtools";
import { setSetting } from "../config/settings";
import {
  closeDetachedViewWindow,
  createDetachedViewWindow,
  moveDetachedViewToMainWindow,
} from "../detached-view-host";
import { sendSafe } from "../ipc/common";

export type DevToolsPanelHostWindowState = {
  mainWindow: BaseWindow;
  devtoolsPanelWindow: BaseWindow | null;
  devtoolsPanelWindowClosing: boolean;
  chromeView: WebContentsView;
  devtoolsPanelView: WebContentsView;
  uiState: UIState;
};

type DevToolsPanelHooks = {
  relayout: () => void;
  getWindowIconPath: () => string | undefined;
};

const devToolsDetachedHost = {
  getWindow: (state: DevToolsPanelHostWindowState) => state.devtoolsPanelWindow,
  setWindow: (
    state: DevToolsPanelHostWindowState,
    window: BaseWindow | null,
  ) => {
    state.devtoolsPanelWindow = window;
  },
  isClosing: (state: DevToolsPanelHostWindowState) =>
    state.devtoolsPanelWindowClosing,
  setClosing: (state: DevToolsPanelHostWindowState, closing: boolean) => {
    state.devtoolsPanelWindowClosing = closing;
  },
  getView: (state: DevToolsPanelHostWindowState) => state.devtoolsPanelView,
};

function setDevToolsPanelMode(
  state: DevToolsPanelHostWindowState,
  mode: UIState["devtoolsPanelMode"],
): void {
  state.uiState.devtoolsPanelMode = mode;
}

function persistDetachedBounds(state: DevToolsPanelHostWindowState): void {
  const devtoolsWindow = state.devtoolsPanelWindow;
  if (!devtoolsWindow || devtoolsWindow.isDestroyed()) return;
  const bounds = devtoolsWindow.getBounds();
  state.uiState.devtoolsPanelDetachedBounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
  setSetting(
    "devtoolsPanelDetachedBounds",
    state.uiState.devtoolsPanelDetachedBounds,
  );
}

function moveDevToolsToMainWindow(state: DevToolsPanelHostWindowState): void {
  moveDetachedViewToMainWindow(state, devToolsDetachedHost);
}

export function isDevToolsPanelDocked(
  state: DevToolsPanelHostWindowState,
): boolean {
  return state.uiState.devtoolsPanelMode === "docked";
}

export function isDevToolsPanelDetached(
  state: DevToolsPanelHostWindowState,
): boolean {
  return state.uiState.devtoolsPanelMode === "detached";
}

export function getDevToolsPanelHostState(
  state: DevToolsPanelHostWindowState,
): DevToolsPanelHostState {
  return {
    open: state.uiState.devtoolsPanelMode !== "closed",
    detached: isDevToolsPanelDetached(state),
    height: state.uiState.devtoolsPanelHeight,
  };
}

export function emitDevToolsPanelHostState(
  state: DevToolsPanelHostWindowState,
): DevToolsPanelHostState {
  const panelState = getDevToolsPanelHostState(state);
  sendSafe(
    state.chromeView.webContents,
    Channels.DEVTOOLS_PANEL_HOST_STATE,
    panelState,
  );
  sendSafe(
    state.devtoolsPanelView.webContents,
    Channels.DEVTOOLS_PANEL_HOST_STATE,
    panelState,
  );
  return panelState;
}

export function closeDetachedDevToolsPanelWindow(
  state: DevToolsPanelHostWindowState,
): boolean {
  return closeDetachedViewWindow(state, devToolsDetachedHost);
}

export function layoutDetachedDevToolsPanel(
  state: DevToolsPanelHostWindowState,
): void {
  if (!state.devtoolsPanelWindow) return;
  const [width, height] = state.devtoolsPanelWindow.getContentSize();
  state.devtoolsPanelView.setBounds({ x: 0, y: 0, width, height });
}

export function toggleDockedDevToolsPanel(
  state: DevToolsPanelHostWindowState,
  hooks: Pick<DevToolsPanelHooks, "relayout">,
): DevToolsPanelHostState {
  if (isDevToolsPanelDetached(state)) {
    state.devtoolsPanelWindow?.focus();
    return getDevToolsPanelHostState(state);
  }

  setDevToolsPanelMode(
    state,
    isDevToolsPanelDocked(state) ? "closed" : "docked",
  );
  hooks.relayout();
  return emitDevToolsPanelHostState(state);
}

export function resizeDockedDevToolsPanel(
  state: DevToolsPanelHostWindowState,
  height: number,
  relayout: () => void,
): DevToolsPanelHostState {
  state.uiState.devtoolsPanelHeight = Math.round(height);
  if (isDevToolsPanelDocked(state)) {
    relayout();
  }
  return emitDevToolsPanelHostState(state);
}

export function detachDevToolsPanel(
  state: DevToolsPanelHostWindowState,
  hooks: DevToolsPanelHooks,
): DevToolsPanelHostState {
  if (state.devtoolsPanelWindow) {
    state.devtoolsPanelWindow.focus();
    return getDevToolsPanelHostState(state);
  }

  const detachedBounds = state.uiState.devtoolsPanelDetachedBounds;
  const devtoolsWindow = createDetachedViewWindow(state, {
    ...devToolsDetachedHost,
    createWindowOptions: () => ({
      ...(typeof detachedBounds?.x === "number" ? { x: detachedBounds.x } : {}),
      ...(typeof detachedBounds?.y === "number" ? { y: detachedBounds.y } : {}),
      width: Math.max(
        DETACHED_DEVTOOLS_MIN_WIDTH,
        Math.round(detachedBounds?.width ?? DETACHED_DEVTOOLS_DEFAULT_WIDTH),
      ),
      height: Math.max(
        DETACHED_DEVTOOLS_MIN_HEIGHT,
        Math.round(detachedBounds?.height ?? DETACHED_DEVTOOLS_DEFAULT_HEIGHT),
      ),
      minWidth: DETACHED_DEVTOOLS_MIN_WIDTH,
      minHeight: DETACHED_DEVTOOLS_MIN_HEIGHT,
      frame: true,
      show: false,
      backgroundColor: "#1a1a1e",
      title: "Vessel DevTools",
      icon: hooks.getWindowIconPath(),
    }),
    layoutView: layoutDetachedDevToolsPanel,
    persistBounds: persistDetachedBounds,
    onNativeClose: () => dockDevToolsPanel(state, hooks),
    onUnexpectedClosed: () => {
      state.devtoolsPanelWindow = null;
      setDevToolsPanelMode(state, "docked");
      state.mainWindow.contentView.addChildView(state.devtoolsPanelView);
      hooks.relayout();
      emitDevToolsPanelHostState(state);
    },
  });

  setDevToolsPanelMode(state, "detached");

  hooks.relayout();
  layoutDetachedDevToolsPanel(state);
  devtoolsWindow.show();
  devtoolsWindow.focus();
  return emitDevToolsPanelHostState(state);
}

export function dockDevToolsPanel(
  state: DevToolsPanelHostWindowState,
  hooks: Pick<DevToolsPanelHooks, "relayout">,
): DevToolsPanelHostState {
  const devtoolsWindow = state.devtoolsPanelWindow;
  setDevToolsPanelMode(state, "docked");

  if (devtoolsWindow) {
    moveDevToolsToMainWindow(state);
    hooks.relayout();
    closeDetachedDevToolsPanelWindow(state);
    state.mainWindow.focus();
  } else {
    hooks.relayout();
  }

  return emitDevToolsPanelHostState(state);
}

export function closeDevToolsPanel(
  state: DevToolsPanelHostWindowState,
  hooks: Pick<DevToolsPanelHooks, "relayout">,
): DevToolsPanelHostState {
  if (state.devtoolsPanelWindow) {
    moveDevToolsToMainWindow(state);
    closeDetachedDevToolsPanelWindow(state);
  }

  setDevToolsPanelMode(state, "closed");
  hooks.relayout();
  return emitDevToolsPanelHostState(state);
}

export function registerDisabledDevToolsPanelHandlers(
  ipc: Pick<IpcMain, "handle">,
): void {
  const disabledDevToolsState: DevToolsPanelHostState = {
    open: false,
    detached: false,
    height: 0,
  };
  const disabledPanelState: DevToolsPanelState = {
    console: [],
    network: [],
    errors: [],
    activity: [],
    agentTrace: [],
    pageMap: null,
  };
  ipc.handle(Channels.DEVTOOLS_PANEL_TOGGLE, () => disabledDevToolsState);
  ipc.handle(Channels.DEVTOOLS_PANEL_CLOSE, () => disabledDevToolsState);
  ipc.handle(Channels.DEVTOOLS_PANEL_OPEN_TAB, () => disabledDevToolsState);
  ipc.handle(Channels.DEVTOOLS_PANEL_STATE_GET, () => disabledPanelState);
  ipc.handle(Channels.DEVTOOLS_PANEL_RESIZE_START, () => undefined);
  ipc.handle(Channels.DEVTOOLS_PANEL_RESIZE, () => 0);
  ipc.handle(Channels.DEVTOOLS_PANEL_RESIZE_COMMIT, () => undefined);
  ipc.handle(Channels.DEVTOOLS_PANEL_POPOUT, () => disabledDevToolsState);
  ipc.handle(Channels.DEVTOOLS_PANEL_DOCK, () => disabledDevToolsState);
  ipc.handle(
    Channels.DEVTOOLS_PANEL_HOST_STATE_GET,
    () => disabledDevToolsState,
  );
}
