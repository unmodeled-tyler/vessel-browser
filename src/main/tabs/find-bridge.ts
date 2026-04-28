import type { WebContents } from "electron";
import type { TabManager } from "./tab-manager";
import { Channels } from "../../shared/channels";

/**
 * Creates a find-in-page bridge that wires up the "found-in-page" event
 * from a tab's webContents to the chrome view, handling listener lifecycle.
 *
 * Used by the main window, secondary windows, and private windows —
 * each has its own bridge instance.
 */
export function createFindInPageBridge(
  tabManager: TabManager,
  chromeView: WebContents,
): {
  start(text: string, options?: { forward?: boolean; findNext?: boolean }): number | null;
  next(forward?: boolean): number | null;
  stop(action?: "clearSelection" | "keepSelection" | "activateSelection"): void;
} {
  let wiredWcId: number | null = null;
  let findResultListener:
    | ((event: Electron.Event, result: Electron.Result) => void)
    | null = null;

  function wireFindEvents(wc: WebContents): void {
    if (wiredWcId === wc.id && findResultListener) return;
    if (wiredWcId !== null && findResultListener) {
      const prev = tabManager.findTabByWebContentsId(wiredWcId);
      const prevWc = prev?.view.webContents;
      if (prevWc && !prevWc.isDestroyed()) {
        prevWc.removeListener("found-in-page", findResultListener);
      }
    }
    wiredWcId = wc.id;
    if (wc.isDestroyed()) return;

    const listener = (_event: Electron.Event, result: Electron.Result) => {
      if (!chromeView.webContents.isDestroyed()) {
        chromeView.webContents.send(Channels.FIND_IN_PAGE_RESULT, result);
      }
    };
    findResultListener = listener;
    wc.on("found-in-page", listener);
    const capturedWcId = wc.id;
    wc.once("destroyed", () => {
      if (wiredWcId === capturedWcId) {
        wiredWcId = null;
        findResultListener = null;
      }
    });
  }

  return {
    start(text: string, options?: { forward?: boolean; findNext?: boolean }): number | null {
      const tab = tabManager.getActiveTab();
      if (!tab) return null;
      const wc = tab.view.webContents;
      if (wc.isDestroyed()) return null;
      wireFindEvents(wc);
      return wc.findInPage(text, {
        forward: options?.forward ?? true,
        findNext: options?.findNext ?? false,
      });
    },

    next(forward?: boolean): number | null {
      const tab = tabManager.getActiveTab();
      if (!tab) return null;
      const wc = tab.view.webContents;
      if (wc.isDestroyed()) return null;
      wireFindEvents(wc);
      return wc.findInPage("", { forward: forward ?? true, findNext: true });
    },

    stop(action?: "clearSelection" | "keepSelection" | "activateSelection"): void {
      const tab = tabManager.getActiveTab();
      if (!tab) return;
      const wc = tab.view.webContents;
      if (wc.isDestroyed()) return;
      wc.stopFindInPage(action ?? "clearSelection");
    },
  };
}