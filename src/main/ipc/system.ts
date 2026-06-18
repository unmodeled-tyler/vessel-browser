import { ipcMain, session } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import { clearByTimeRange } from "../history/manager";
import {
  clearDownloads,
  listDownloads,
  openDownload,
  setDownloadBroadcaster,
  showDownloadInFolder,
} from "../network/download-manager";
import {
  clearPermissions,
  clearPermissionsForOrigin,
  listPermissions,
  setPermissionBroadcaster,
} from "../security/permissions";
import { checkForUpdates, openUpdateDownload } from "../updates/checker";
import { togglePictureInPicture } from "./picture-in-picture";
import {
  assertTrustedIpcSender,
  parseIpc,
  sendSafe,
  type SendToRendererViews,
} from "./common";
import type { WindowState } from "../window";
import type { ClearDataOptions } from "../../shared/types";
import {
  CHROME_HEIGHT,
  getWindowIconPath,
  layoutViews,
  MIN_DEVTOOLS_PANEL,
  MAX_DEVTOOLS_PANEL,
} from "../window";
import {
  closeDevToolsPanel,
  detachDevToolsPanel,
  dockDevToolsPanel,
  emitDevToolsPanelHostState,
  getDevToolsPanelHostState,
  resizeDockedDevToolsPanel,
  toggleDockedDevToolsPanel,
} from "../devtools/panel";
import {
  disableCaptureForTab,
  enableCaptureForTab,
  refreshDevToolsPageMap,
} from "../devtools/tools";
import { revealPageMapElement } from "../devtools/page-map-reveal";
import { isSidebarAttached } from "../sidebar-panel";
import {
  createKitFromText,
  getInstalledKits,
  installKitFromFile,
  updateKitFromText,
  uninstallKit,
} from "../automation/kit-registry";
import { getScheduledKitIds } from "../automation/scheduler";
import { assertFeatureUnlocked } from "../premium/manager";

const KitIdSchema = z.string().min(1);
const SkillSourceSchema = z.string().min(1).max(100_000);
const OriginSchema = z.string().min(1);
const DevToolsHeightSchema = z.number().finite().min(0).max(2000);
const DevToolsPageMapRevealSchema = z.object({
  selector: z.string().min(1),
});
const DevToolsPanelTabSchema = z.enum([
  "console",
  "network",
  "activity",
  "agentTrace",
  "pageMap",
]);
const RendererViewSchema = z.enum(["chrome", "sidebar", "devtools"]);

export function registerSystemHandlers(
  windowState: WindowState,
  sendToRendererViews: SendToRendererViews,
): void {
  const { tabManager } = windowState;
  let devToolsResizeRecoveryTimer: NodeJS.Timeout | null = null;
  let devToolsResizeActive = false;
  const relayout = () => layoutViews(windowState);
  const clearDevToolsResizeRecoveryTimer = () => {
    if (!devToolsResizeRecoveryTimer) return;
    clearTimeout(devToolsResizeRecoveryTimer);
    devToolsResizeRecoveryTimer = null;
  };
  const stopDevToolsResize = () => {
    devToolsResizeActive = false;
    clearDevToolsResizeRecoveryTimer();
  };
  const restoreDevToolsLayoutAfterResize = () => {
    clearDevToolsResizeRecoveryTimer();
    if (!devToolsResizeActive) return;
    devToolsResizeActive = false;
    relayout();
  };
  const scheduleDevToolsResizeRecovery = () => {
    clearDevToolsResizeRecoveryTimer();
    devToolsResizeRecoveryTimer = setTimeout(() => {
      restoreDevToolsLayoutAfterResize();
    }, 1200);
  };
  const maxDockedDevToolsHeight = () => {
    const [, windowHeight] = windowState.mainWindow.getContentSize();
    const chromeHeight = windowState.uiState.focusMode ? 0 : CHROME_HEIGHT;
    return Math.max(
      MIN_DEVTOOLS_PANEL,
      Math.min(MAX_DEVTOOLS_PANEL, windowHeight - chromeHeight - 80),
    );
  };

  windowState.mainWindow.once("closed", stopDevToolsResize);

  ipcMain.handle(Channels.DEVTOOLS_PANEL_TOGGLE, (event) => {
    assertTrustedIpcSender(event);
    stopDevToolsResize();
    const hostState = toggleDockedDevToolsPanel(windowState, { relayout });
    if (hostState.open) {
      void enableCaptureForTab(tabManager);
    } else {
      disableCaptureForTab();
    }
    return hostState;
  });

  ipcMain.handle(Channels.DEVTOOLS_PANEL_CLOSE, (event) => {
    assertTrustedIpcSender(event);
    stopDevToolsResize();
    const hostState = closeDevToolsPanel(windowState, { relayout });
    disableCaptureForTab();
    return hostState;
  });

  ipcMain.handle(Channels.DEVTOOLS_PANEL_OPEN_TAB, (event, tab: unknown) => {
    assertTrustedIpcSender(event);
    const selectedTab = parseIpc(DevToolsPanelTabSchema, tab, "tab");
    stopDevToolsResize();
    const wasOpen = getDevToolsPanelHostState(windowState).open;
    if (!wasOpen) {
      toggleDockedDevToolsPanel(windowState, { relayout });
      void enableCaptureForTab(tabManager);
    } else if (getDevToolsPanelHostState(windowState).detached) {
      windowState.devtoolsPanelWindow?.focus();
    }
    emitDevToolsPanelHostState(windowState);
    sendSafe(
      windowState.devtoolsPanelView.webContents,
      Channels.DEVTOOLS_PANEL_SELECT_TAB,
      selectedTab,
    );
    if (selectedTab === "pageMap") {
      void refreshDevToolsPageMap(tabManager);
    }
    return getDevToolsPanelHostState(windowState);
  });

  ipcMain.handle(Channels.DEVTOOLS_PANEL_RESIZE_START, (event) => {
    assertTrustedIpcSender(event);
    if (!getDevToolsPanelHostState(windowState).open) return;
    if (getDevToolsPanelHostState(windowState).detached) return;
    devToolsResizeActive = true;
    clearDevToolsResizeRecoveryTimer();
    const [windowWidth, windowHeight] = windowState.mainWindow.getContentSize();
    const chromeHeight = windowState.uiState.focusMode ? 0 : CHROME_HEIGHT;
    const sidebarWidth = isSidebarAttached(windowState)
      ? windowState.uiState.sidebarWidth
      : 0;
    windowState.devtoolsPanelView.setBounds({
      x: 0,
      y: chromeHeight,
      width: windowWidth - sidebarWidth,
      height: windowHeight - chromeHeight,
    });
    scheduleDevToolsResizeRecovery();
  });

  ipcMain.handle(Channels.DEVTOOLS_PANEL_RESIZE, (event, height: unknown) => {
    assertTrustedIpcSender(event);
    const validatedHeight = parseIpc(DevToolsHeightSchema, height, "height");
    const clamped = Math.max(
      MIN_DEVTOOLS_PANEL,
      Math.min(maxDockedDevToolsHeight(), Math.round(validatedHeight)),
    );
    if (devToolsResizeActive) {
      windowState.uiState.devtoolsPanelHeight = clamped;
      scheduleDevToolsResizeRecovery();
      emitDevToolsPanelHostState(windowState);
      return clamped;
    }
    resizeDockedDevToolsPanel(windowState, clamped, relayout);
    return clamped;
  });

  ipcMain.handle(Channels.DEVTOOLS_PANEL_RESIZE_COMMIT, (event) => {
    assertTrustedIpcSender(event);
    stopDevToolsResize();
    relayout();
  });

  ipcMain.handle(Channels.DEVTOOLS_PANEL_POPOUT, (event) => {
    assertTrustedIpcSender(event);
    stopDevToolsResize();
    return detachDevToolsPanel(windowState, {
      relayout,
      getWindowIconPath,
    });
  });

  ipcMain.handle(Channels.DEVTOOLS_PANEL_DOCK, (event) => {
    assertTrustedIpcSender(event);
    stopDevToolsResize();
    return dockDevToolsPanel(windowState, { relayout });
  });

  ipcMain.handle(Channels.DEVTOOLS_PANEL_STATE_GET, async (event) => {
    assertTrustedIpcSender(event);
    if (getDevToolsPanelHostState(windowState).open) {
      void enableCaptureForTab(tabManager);
    }
    return await refreshDevToolsPageMap(tabManager);
  });

  ipcMain.handle(
    Channels.DEVTOOLS_PAGE_MAP_REVEAL,
    async (event, payload: unknown) => {
      assertTrustedIpcSender(event);
      const { selector } = parseIpc(
        DevToolsPageMapRevealSchema,
        payload,
        "payload",
      );
      return await revealPageMapElement(tabManager, selector);
    },
  );

  ipcMain.handle(Channels.DEVTOOLS_PANEL_HOST_STATE_GET, (event) => {
    assertTrustedIpcSender(event);
    return getDevToolsPanelHostState(windowState);
  });

  ipcMain.on(Channels.RENDERER_VIEW_READY, (event, view: unknown) => {
    assertTrustedIpcSender(event);
    const readyView = parseIpc(RendererViewSchema, view, "view");
    if (readyView !== "devtools") return;
    emitDevToolsPanelHostState(windowState);
    void refreshDevToolsPageMap(tabManager);
    // If the panel is open, ensure capture is active for the active tab.
    if (getDevToolsPanelHostState(windowState).open) {
      void enableCaptureForTab(tabManager);
    }
  });

  ipcMain.handle(Channels.AUTOMATION_GET_INSTALLED, async (event) => {
    assertTrustedIpcSender(event);
    assertFeatureUnlocked("automation_kits", "Skills");
    return await getInstalledKits();
  });

  ipcMain.handle(Channels.AUTOMATION_INSTALL_FROM_FILE, async (event) => {
    assertTrustedIpcSender(event);
    assertFeatureUnlocked("automation_kits", "Skills");
    return await installKitFromFile();
  });

  ipcMain.handle(Channels.AUTOMATION_CREATE_FROM_TEXT, async (event, source: unknown) => {
    assertTrustedIpcSender(event);
    assertFeatureUnlocked("automation_kits", "Skills");
    return await createKitFromText(
      parseIpc(SkillSourceSchema, source, "source"),
    );
  });

  ipcMain.handle(Channels.AUTOMATION_UPDATE_FROM_TEXT, async (event, id: unknown, source: unknown) => {
    assertTrustedIpcSender(event);
    assertFeatureUnlocked("automation_kits", "Skills");
    return await updateKitFromText(
      parseIpc(KitIdSchema, id, "id"),
      parseIpc(SkillSourceSchema, source, "source"),
    );
  });

  ipcMain.handle(Channels.AUTOMATION_UNINSTALL, async (event, id: unknown) => {
    assertTrustedIpcSender(event);
    assertFeatureUnlocked("automation_kits", "Skills");
    return await uninstallKit(
      parseIpc(KitIdSchema, id, "id"),
      getScheduledKitIds(),
    );
  });

  ipcMain.handle(Channels.CLEAR_BROWSING_DATA, async (event, options: ClearDataOptions) => {
    assertTrustedIpcSender(event);
    const { cache, cookies, history, localStorage: clearLs, timeRange } = options;

    if (cache) {
      await session.defaultSession.clearCache();
    }

    const storages: Array<"cookies" | "localstorage"> = [];
    if (cookies) storages.push("cookies");
    if (clearLs) storages.push("localstorage");

    if (storages.length > 0) {
      await session.defaultSession.clearStorageData({ storages });
    }

    if (history) {
      clearByTimeRange(timeRange);
    }
  });

  setDownloadBroadcaster(sendToRendererViews);
  setPermissionBroadcaster(sendToRendererViews);

  ipcMain.handle(Channels.DOWNLOADS_GET, (event) => {
    assertTrustedIpcSender(event);
    return listDownloads();
  });
  ipcMain.handle(Channels.DOWNLOADS_CLEAR, (event) => {
    assertTrustedIpcSender(event);
    clearDownloads();
    return true;
  });
  ipcMain.handle(Channels.DOWNLOADS_OPEN, (event, id: string) => {
    assertTrustedIpcSender(event);
    return openDownload(id);
  });
  ipcMain.handle(Channels.DOWNLOADS_SHOW_IN_FOLDER, (event, id: string) => {
    assertTrustedIpcSender(event);
    return showDownloadInFolder(id);
  });

  ipcMain.handle(Channels.PERMISSIONS_GET, (event) => {
    assertTrustedIpcSender(event);
    return listPermissions();
  });
  ipcMain.handle(Channels.PERMISSIONS_CLEAR, (event) => {
    assertTrustedIpcSender(event);
    clearPermissions();
    return true;
  });
  ipcMain.handle(Channels.PERMISSIONS_CLEAR_ORIGIN, (event, origin: string) => {
    assertTrustedIpcSender(event);
    clearPermissionsForOrigin(parseIpc(OriginSchema, origin, "origin"));
    return true;
  });

  ipcMain.handle(Channels.UPDATES_CHECK, (event) => {
    assertTrustedIpcSender(event);
    return checkForUpdates();
  });
  ipcMain.handle(Channels.UPDATES_OPEN_DOWNLOAD, (event) => {
    assertTrustedIpcSender(event);
    return openUpdateDownload();
  });

  ipcMain.handle(Channels.TAB_TOGGLE_PIP, async (event) => {
    assertTrustedIpcSender(event);
    return togglePictureInPicture(tabManager);
  });
}
