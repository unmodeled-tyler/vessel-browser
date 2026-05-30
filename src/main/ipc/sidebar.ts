import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { Channels } from "../../shared/channels";
import {
  SIDEBAR_RESIZE_HANDLE_OVERLAP,
  clampSidebarWidth,
} from "../../shared/sidebar";
import { setSetting } from "../config/settings";
import {
  closeSidebar,
  detachSidebar,
  dockSidebar,
  emitSidebarPanelState,
  isSidebarDetached,
  openDockedSidebar,
  toggleDockedSidebar,
} from "../sidebar-panel";
import {
  CHROME_HEIGHT,
  getWindowIconPath,
  layoutViews,
  resizeSidebarViews,
  type WindowState,
} from "../window";
import { assertNumber, assertString } from "./common";

type RequireTrusted = (event: IpcMainEvent | IpcMainInvokeEvent) => void;

export function registerSidebarHandlers(
  windowState: WindowState,
  requireTrusted: RequireTrusted,
): void {
  let sidebarResizeRecoveryTimer: NodeJS.Timeout | null = null;
  let sidebarResizeActive = false;

  const relayout = () => layoutViews(windowState);
  const clearSidebarResizeRecoveryTimer = () => {
    if (!sidebarResizeRecoveryTimer) return;
    clearTimeout(sidebarResizeRecoveryTimer);
    sidebarResizeRecoveryTimer = null;
  };

  const stopSidebarResize = () => {
    sidebarResizeActive = false;
    clearSidebarResizeRecoveryTimer();
  };

  const restoreSidebarLayoutAfterResize = () => {
    clearSidebarResizeRecoveryTimer();
    if (!sidebarResizeActive) return;
    sidebarResizeActive = false;
    relayout();
  };

  const scheduleSidebarResizeRecovery = () => {
    clearSidebarResizeRecoveryTimer();
    sidebarResizeRecoveryTimer = setTimeout(() => {
      restoreSidebarLayoutAfterResize();
    }, 1200);
  };

  windowState.mainWindow.once("closed", stopSidebarResize);

  ipcMain.handle(Channels.SIDEBAR_TOGGLE, (event) => {
    requireTrusted(event);
    return toggleDockedSidebar(windowState, relayout);
  });

  ipcMain.handle(Channels.SIDEBAR_NAVIGATE, (event, tab: string) => {
    requireTrusted(event);
    assertString(tab, "tab");
    if (windowState.uiState.sidebarPanelMode === "closed") {
      openDockedSidebar(windowState, relayout);
    }
    if (!windowState.sidebarView.webContents.isDestroyed()) {
      windowState.sidebarView.webContents.send(Channels.SIDEBAR_NAVIGATE, tab);
    }
    windowState.sidebarWindow?.focus();
    return emitSidebarPanelState(windowState);
  });

  ipcMain.handle(Channels.SIDEBAR_RESIZE_START, (event) => {
    requireTrusted(event);
    if (isSidebarDetached(windowState)) return;
    sidebarResizeActive = true;
    clearSidebarResizeRecoveryTimer();
    const [width, height] = windowState.mainWindow.getContentSize();
    const chromeHeight = windowState.uiState.focusMode ? 0 : CHROME_HEIGHT;
    const sidebarWidth = windowState.uiState.sidebarWidth;
    windowState.sidebarView.setBounds({
      x: width - sidebarWidth - SIDEBAR_RESIZE_HANDLE_OVERLAP,
      y: chromeHeight,
      width: sidebarWidth + SIDEBAR_RESIZE_HANDLE_OVERLAP,
      height: height - chromeHeight,
    });
    scheduleSidebarResizeRecovery();
  });

  ipcMain.handle(Channels.SIDEBAR_RESIZE, (event, width: number) => {
    requireTrusted(event);
    assertNumber(width, "width");
    if (isSidebarDetached(windowState)) {
      return windowState.uiState.sidebarWidth;
    }
    const clamped = clampSidebarWidth(width);
    windowState.uiState.sidebarWidth = clamped;
    resizeSidebarViews(windowState);
    emitSidebarPanelState(windowState);
    return clamped;
  });

  ipcMain.handle(Channels.SIDEBAR_RESIZE_COMMIT, (event) => {
    requireTrusted(event);
    if (isSidebarDetached(windowState)) return;
    stopSidebarResize();
    setSetting("sidebarWidth", windowState.uiState.sidebarWidth);
    relayout();
  });

  ipcMain.handle(Channels.SIDEBAR_POPOUT, (event) => {
    requireTrusted(event);
    stopSidebarResize();
    return detachSidebar(windowState, {
      relayout,
      getWindowIconPath,
    });
  });

  ipcMain.handle(Channels.SIDEBAR_DOCK, (event) => {
    requireTrusted(event);
    stopSidebarResize();
    return dockSidebar(windowState, { relayout });
  });

  ipcMain.on(
    Channels.RENDERER_VIEW_READY,
    (event, view: "chrome" | "sidebar" | "devtools") => {
      requireTrusted(event);
      if (view !== "sidebar") return;
      emitSidebarPanelState(windowState);
    },
  );

  ipcMain.handle(Channels.SETTINGS_VISIBILITY, (event, open: boolean) => {
    requireTrusted(event);
    windowState.uiState.settingsOpen = open;
    if (open) {
      closeSidebar(windowState, relayout, "temporary");
    } else {
      relayout();
      emitSidebarPanelState(windowState);
    }
    return windowState.uiState.settingsOpen;
  });
}
