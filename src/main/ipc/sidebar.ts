import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
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
import { parseIpc } from "./common";

const SidebarTabSchema = z.string().min(1);
const SidebarWidthSchema = z.number().int().min(SIDEBAR_MIN_WIDTH).max(SIDEBAR_MAX_WIDTH);
const BooleanSchema = z.boolean();
const ViewNameSchema = z.enum(["chrome", "sidebar", "devtools"]);

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

  ipcMain.handle(Channels.SIDEBAR_NAVIGATE, (event, tab: unknown) => {
    requireTrusted(event);
    const validatedTab = parseIpc(SidebarTabSchema, tab, "tab");
    if (windowState.uiState.sidebarPanelMode === "closed") {
      openDockedSidebar(windowState, relayout);
    }
    if (!windowState.sidebarView.webContents.isDestroyed()) {
      windowState.sidebarView.webContents.send(Channels.SIDEBAR_NAVIGATE, validatedTab);
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

  ipcMain.handle(Channels.SIDEBAR_RESIZE, (event, width: unknown) => {
    requireTrusted(event);
    const validatedWidth = parseIpc(SidebarWidthSchema, width, "width");
    if (isSidebarDetached(windowState)) {
      return windowState.uiState.sidebarWidth;
    }
    const clamped = clampSidebarWidth(validatedWidth);
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
    (event, view: unknown) => {
      requireTrusted(event);
      const validatedView = parseIpc(ViewNameSchema, view, "view");
      if (validatedView !== "sidebar") return;
      emitSidebarPanelState(windowState);
    },
  );

  ipcMain.handle(Channels.SETTINGS_VISIBILITY, (event, open: unknown) => {
    requireTrusted(event);
    const validatedOpen = parseIpc(BooleanSchema, open, "open");
    windowState.uiState.settingsOpen = validatedOpen;
    if (open) {
      closeSidebar(windowState, relayout, "temporary");
    } else {
      relayout();
      emitSidebarPanelState(windowState);
    }
    return windowState.uiState.settingsOpen;
  });
}
