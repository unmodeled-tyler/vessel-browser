import { ipcMain, session } from "electron";
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
  assertString,
  assertTrustedIpcSender,
  type SendToRendererViews,
} from "./common";
import type { WindowState } from "../window";
import type { ClearDataOptions } from "../../shared/types";
import {
  layoutViews,
  MIN_DEVTOOLS_PANEL,
  MAX_DEVTOOLS_PANEL,
} from "../window";
import {
  getInstalledKits,
  installKitFromFile,
  uninstallKit,
} from "../automation/kit-registry";
import { getScheduledKitIds } from "../automation/scheduler";

export function registerSystemHandlers(
  windowState: WindowState,
  sendToRendererViews: SendToRendererViews,
): void {
  const { tabManager } = windowState;

  ipcMain.handle(Channels.DEVTOOLS_PANEL_TOGGLE, (event) => {
    assertTrustedIpcSender(event);
    windowState.uiState.devtoolsPanelOpen = !windowState.uiState.devtoolsPanelOpen;
    layoutViews(windowState);
    return { open: windowState.uiState.devtoolsPanelOpen };
  });

  ipcMain.handle(Channels.DEVTOOLS_PANEL_RESIZE, (event, height: number) => {
    assertTrustedIpcSender(event);
    const clamped = Math.max(MIN_DEVTOOLS_PANEL, Math.min(MAX_DEVTOOLS_PANEL, Math.round(height)));
    windowState.uiState.devtoolsPanelHeight = clamped;
    layoutViews(windowState);
    return clamped;
  });

  ipcMain.handle(Channels.AUTOMATION_GET_INSTALLED, (event) => {
    assertTrustedIpcSender(event);
    return getInstalledKits();
  });

  ipcMain.handle(Channels.AUTOMATION_INSTALL_FROM_FILE, async (event) => {
    assertTrustedIpcSender(event);
    return await installKitFromFile();
  });

  ipcMain.handle(Channels.AUTOMATION_UNINSTALL, (event, id: unknown) => {
    assertTrustedIpcSender(event);
    assertString(id, "id");
    return uninstallKit(id, getScheduledKitIds());
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
    clearPermissionsForOrigin(origin);
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
