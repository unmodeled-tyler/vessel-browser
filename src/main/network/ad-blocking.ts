import { session } from "electron";
import { getAdBlockDecision } from "./ad-blocking-rules";
import type { TabManager } from "../tabs/tab-manager";

let installed = false;
const defaultSessionTabManagers = new Set<TabManager>();

export function installAdBlocking(tabManager: TabManager): void {
  defaultSessionTabManagers.add(tabManager);
  if (installed) return;
  installed = true;

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const webContentsId =
      typeof details.webContentsId === "number" ? details.webContentsId : null;
    if (webContentsId == null) {
      callback({});
      return;
    }

    const manager = [...defaultSessionTabManagers].find((candidate) =>
      candidate.findTabByWebContentsId(webContentsId),
    );
    if (!manager?.isAdBlockingEnabledForWebContents(webContentsId)) {
      callback({});
      return;
    }

    callback(getAdBlockDecision(details));
  });
}

export function unregisterAdBlockingTabManager(tabManager: TabManager): void {
  defaultSessionTabManagers.delete(tabManager);
}

/**
 * Install ad-blocking on a non-default session (e.g. private browsing).
 * Each session gets its own onBeforeRequest handler scoped to the given TabManager.
 */
export function installAdBlockingForSession(
  ses: Electron.Session,
  tabManager: TabManager,
): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    const webContentsId =
      typeof details.webContentsId === "number" ? details.webContentsId : null;
    if (webContentsId == null) {
      callback({});
      return;
    }

    if (!tabManager.isAdBlockingEnabledForWebContents(webContentsId)) {
      callback({});
      return;
    }

    callback(getAdBlockDecision(details));
  });
}
