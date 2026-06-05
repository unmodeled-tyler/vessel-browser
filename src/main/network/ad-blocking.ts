import { session } from "electron";
import { getAdBlockDecision } from "./ad-blocking-rules";
import type { AdBlockDecision, AdBlockRequestDetails } from "./ad-blocking-rules";
import type { TabManager } from "../tabs/tab-manager";
import { getAirGapBlockReason } from "../config/air-gapped";

let installed = false;
const defaultSessionTabManagers = new Set<TabManager>();

export function getRequestFilterDecision(
  details: AdBlockRequestDetails,
  adBlockingEnabled: boolean,
): AdBlockDecision | null {
  if (getAirGapBlockReason(details.url)) {
    return { cancel: true };
  }

  return adBlockingEnabled ? getAdBlockDecision(details) : null;
}

export function installAdBlocking(tabManager: TabManager): void {
  defaultSessionTabManagers.add(tabManager);
  if (installed) return;
  installed = true;

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const webContentsId =
      typeof details.webContentsId === "number" ? details.webContentsId : null;
    if (webContentsId == null) {
      callback(getRequestFilterDecision(details, false) ?? {});
      return;
    }

    // Direct iteration avoids array allocation from Set iterator on every request.
    let enabled = false;
    for (const candidate of defaultSessionTabManagers) {
      if (candidate.findTabByWebContentsId(webContentsId)) {
        enabled = candidate.isAdBlockingEnabledForWebContents(webContentsId);
        break;
      }
    }
    callback(getRequestFilterDecision(details, enabled) ?? {});
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
      callback(getRequestFilterDecision(details, false) ?? {});
      return;
    }

    callback(
      getRequestFilterDecision(
        details,
        tabManager.isAdBlockingEnabledForWebContents(webContentsId),
      ) ?? {},
    );
  });
}
