import { session } from "electron";
import type { OnBeforeRequestListenerDetails } from "electron/main";
import type { TabManager } from "../tabs/tab-manager";

const BLOCKED_RESOURCE_TYPES = new Set([
  "script",
  "image",
  "xhr",
  "fetch",
  "subFrame",
  "media",
  "ping",
  "webSocket",
]);

const BLOCKED_HOST_SUFFIXES = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adservice.google.com",
  "adnxs.com",
  "adsrvr.org",
  "taboola.com",
  "outbrain.com",
  "criteo.com",
  "criteo.net",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "casalemedia.com",
  "advertising.com",
  "amazon-adsystem.com",
  "adsymptotic.com",
  "moatads.com",
  "quantserve.com",
  "scorecardresearch.com",
];

const THIRD_PARTY_PATH_PATTERNS = [
  /\/ads?[/?._-]/i,
  /\/adservice/i,
  /\/advert/i,
  /\/prebid/i,
  /\/banner/i,
  /\/sponsor/i,
  /\/promotions?\//i,
  /\/trk\//i,
  /\/track(ing)?\//i,
  /\/beacon/i,
  /\/pixel/i,
];

const EMPTY_BLOCKED_FRAME_URL =
  "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Chtml%3E%3Cbody%3E%3C%2Fbody%3E%3C%2Fhtml%3E";

let installed = false;
const defaultSessionTabManagers = new Set<TabManager>();

type AdBlockDecision = {
  cancel?: boolean;
  redirectURL?: string;
};

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function hostnameMatches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function parseHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function isThirdParty(url: URL, firstPartyHost: string | null): boolean {
  if (!firstPartyHost) return true;
  const target = normalizeHostname(url.hostname);
  return !(
    target === firstPartyHost || target.endsWith(`.${firstPartyHost}`)
  );
}

function shouldBlockRequest(
  details: OnBeforeRequestListenerDetails,
): boolean {
  if (!BLOCKED_RESOURCE_TYPES.has(details.resourceType)) return false;

  let parsed: URL;
  try {
    parsed = new URL(details.url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostnameMatches(hostname, suffix))
  ) {
    return true;
  }

  const firstPartyHost =
    parseHostname(details.referrer) || parseHostname(details.initiator || "");
  if (!isThirdParty(parsed, firstPartyHost)) return false;

  const candidate = `${hostname}${parsed.pathname}${parsed.search}`;
  return THIRD_PARTY_PATH_PATTERNS.some((pattern) => pattern.test(candidate));
}

function getAdBlockDecision(
  details: OnBeforeRequestListenerDetails,
): AdBlockDecision {
  if (!shouldBlockRequest(details)) return { cancel: false };

  if (details.resourceType === "subFrame") {
    return { redirectURL: EMPTY_BLOCKED_FRAME_URL };
  }

  return { cancel: true };
}

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
