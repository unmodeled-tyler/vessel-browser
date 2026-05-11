import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import {
  getLatestPageDiff,
  getPageDiffBursts,
  notePageMutationActivity,
  schedulePageSnapshotCapture,
} from "../content/page-diff-monitor";
import { getPremiumState, isPremiumActiveState } from "../premium/manager";
import {
  assertTrustedIpcSender,
  isManagedTabIpcSender,
  type SendToRendererViews,
} from "./common";
import type { WindowState } from "../window";

export function registerPageDiffHandlers(
  windowState: WindowState,
  sendToRendererViews: SendToRendererViews,
): void {
  const pageEventBuckets = new Map<number, { count: number; resetAt: number }>();
  const allowPageEvent = (webContentsId: number): boolean => {
    const now = Date.now();
    const bucket = pageEventBuckets.get(webContentsId);
    if (!bucket || bucket.resetAt <= now) {
      pageEventBuckets.set(webContentsId, { count: 1, resetAt: now + 1000 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= 20;
  };

  ipcMain.handle(Channels.PAGE_DIFF_GET, (event) => {
    assertTrustedIpcSender(event);
    const activeTab = windowState.tabManager.getActiveTab();
    const wc = activeTab?.view.webContents;
    if (!wc) return null;
    return getLatestPageDiff(wc.getURL());
  });

  ipcMain.handle(Channels.PAGE_DIFF_HISTORY, (event) => {
    assertTrustedIpcSender(event);
    try {
      if (!isPremiumActiveState(getPremiumState())) {
        return { error: "Premium required" };
      }
      const activeTab = windowState.tabManager.getActiveTab();
      const wc = activeTab?.view.webContents;
      if (!wc) return [];
      return getPageDiffBursts(wc.getURL());
    } catch {
      return [];
    }
  });

  ipcMain.on(Channels.PAGE_DIFF_ACTIVITY, (event) => {
    const wc = event.sender;
    if (!wc || wc.isDestroyed()) return;
    if (!isManagedTabIpcSender(event, windowState.tabManager)) return;
    if (!allowPageEvent(wc.id)) return;
    notePageMutationActivity(wc, sendToRendererViews);
  });

  ipcMain.on(Channels.PAGE_DIFF_DIRTY, (event) => {
    const wc = event.sender;
    if (!wc || wc.isDestroyed()) return;
    if (!isManagedTabIpcSender(event, windowState.tabManager)) return;
    if (!allowPageEvent(wc.id)) return;
    schedulePageSnapshotCapture(wc, sendToRendererViews);
  });
}
