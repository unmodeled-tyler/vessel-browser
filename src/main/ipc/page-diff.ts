import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import {
  getLatestPageDiff,
  notePageMutationActivity,
  schedulePageSnapshotCapture,
} from "../content/page-diff-monitor";
import type { SendToRendererViews } from "./common";
import type { WindowState } from "../window";

export function registerPageDiffHandlers(
  windowState: WindowState,
  sendToRendererViews: SendToRendererViews,
): void {
  ipcMain.handle(Channels.PAGE_DIFF_GET, () => {
    const activeTab = windowState.tabManager.getActiveTab();
    const wc = activeTab?.view.webContents;
    if (!wc) return null;
    return getLatestPageDiff(wc.getURL());
  });

  ipcMain.on(Channels.PAGE_DIFF_ACTIVITY, (event) => {
    const wc = event.sender;
    if (!wc || wc.isDestroyed()) return;
    notePageMutationActivity(wc, sendToRendererViews);
  });

  ipcMain.on(Channels.PAGE_DIFF_DIRTY, (event) => {
    const wc = event.sender;
    if (!wc || wc.isDestroyed()) return;
    schedulePageSnapshotCapture(wc, sendToRendererViews);
  });
}
