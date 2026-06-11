import { ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import {
  highlightOnPage,
  getHighlightCount,
  scrollToHighlight,
  removeHighlightAtIndex,
  clearAllHighlightElements,
} from "../highlights/inject";
import { captureSelectionHighlight, persistAndMarkHighlight } from "../highlights/capture";
import {
  getActiveTabInfo,
  assertTrustedIpcSender,
  parseIpc,
  sendSafe,
  type SendToRendererViews,
} from "./common";
import { createLogger } from "../../shared/logger";
import type { WindowState } from "../window";

const logger = createLogger("HighlightIPC");

const HighlightIndexSchema = z.number().int().min(0);

export function registerHighlightHandlers(
  windowState: WindowState,
  sendToRendererViews: SendToRendererViews,
): void {
  const { tabManager, chromeView } = windowState;

  const getActiveHighlightCountSafe = async (): Promise<number> => {
    const info = getActiveTabInfo(tabManager);
    if (!info) return 0;
    try {
      return (await getHighlightCount(info.wc)) ?? 0;
    } catch (err) {
      logger.warn("Failed to get active highlight count:", err);
      return 0;
    }
  };

  const emitHighlightCount = async (): Promise<void> => {
    const count = await getActiveHighlightCountSafe();
    sendToRendererViews(Channels.HIGHLIGHT_COUNT_UPDATE, count);
  };

  tabManager.onHighlightCapture((result) => {
    if (result.success) {
      void emitHighlightCount();
    }
    sendSafe(chromeView.webContents, Channels.HIGHLIGHT_CAPTURE_RESULT, result);
  });

  ipcMain.handle(Channels.HIGHLIGHT_CAPTURE, async (event) => {
    assertTrustedIpcSender(event);
    try {
      const activeTab = tabManager.getActiveTab();
      if (!activeTab) {
        return { success: false, message: "No active tab" };
      }
      const wc = activeTab.view.webContents;
      const result = await captureSelectionHighlight(wc);
      if (result.success && result.text) {
        await highlightOnPage(wc, null, result.text, undefined, undefined, "yellow").catch((err) =>
          logger.warn("Failed to highlight captured selection:", err),
        );
        await emitHighlightCount();
      }
      return result;
    } catch (err) {
      logger.warn("Failed to capture highlight from active tab:", err);
      return { success: false, message: "Could not capture selection" };
    }
  });

  ipcMain.on(Channels.HIGHLIGHT_SELECTION, (event, text: unknown) => {
    try {
      const wc = event.sender;
      if (wc.isDestroyed()) return;

      const tab = tabManager.findTabByWebContentsId(wc.id);
      if (!tab || !tab.highlightModeActive) return;

      if (typeof text !== "string" || !text.trim()) return;
      void persistAndMarkHighlight(wc, text).then((result) => {
        if (result.success) {
          void emitHighlightCount();
          sendSafe(chromeView.webContents, Channels.HIGHLIGHT_CAPTURE_RESULT, result);
        }
      });
    } catch (err) {
      logger.warn("Failed to persist auto-highlight selection:", err);
    }
  });

  ipcMain.handle(Channels.HIGHLIGHT_NAV_COUNT, (event) => {
    assertTrustedIpcSender(event);
    return getActiveHighlightCountSafe();
  });

  ipcMain.handle(Channels.HIGHLIGHT_NAV_SCROLL, (event, index: unknown) => {
    assertTrustedIpcSender(event);
    const validatedIndex = parseIpc(HighlightIndexSchema, index, "index");
    const info = getActiveTabInfo(tabManager);
    if (!info) return false;
    try {
      return scrollToHighlight(info.wc, validatedIndex);
    } catch (err) {
      logger.warn("Failed to scroll to highlight:", err);
      return false;
    }
  });

  ipcMain.handle(Channels.HIGHLIGHT_NAV_REMOVE, async (event, index: unknown) => {
    assertTrustedIpcSender(event);
    const validatedIndex = parseIpc(HighlightIndexSchema, index, "index");
    const info = getActiveTabInfo(tabManager);
    if (!info) return false;
    try {
      const removed = await removeHighlightAtIndex(info.wc, validatedIndex);
      if (removed) {
        await emitHighlightCount();
      }
      return removed;
    } catch (err) {
      logger.warn("Failed to remove highlight at index:", err);
      return false;
    }
  });

  ipcMain.handle(Channels.HIGHLIGHT_NAV_CLEAR, async (event) => {
    assertTrustedIpcSender(event);
    const info = getActiveTabInfo(tabManager);
    if (!info) return false;
    try {
      const cleared = await clearAllHighlightElements(info.wc);
      if (cleared) {
        await emitHighlightCount();
      }
      return cleared;
    } catch (err) {
      logger.warn("Failed to clear highlight elements:", err);
      return false;
    }
  });
}
