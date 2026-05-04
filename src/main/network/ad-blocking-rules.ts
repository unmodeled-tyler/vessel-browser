import type { OnBeforeRequestListenerDetails } from "electron/main";

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

export const EMPTY_BLOCKED_FRAME_URL =
  "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Chtml%3E%3Cbody%3E%3C!--%20blocked%20by%20Vessel%20ad%20blocker%20--%3E%3C%2Fbody%3E%3C%2Fhtml%3E";

export type AdBlockDecision = {
  cancel?: boolean;
  redirectURL?: string;
};

export type AdBlockRequestDetails = Pick<
  OnBeforeRequestListenerDetails,
  "initiator" | "referrer" | "resourceType" | "url"
>;

export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function hostnameMatches(hostname: string, suffix: string): boolean {
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
  return !(target === firstPartyHost || target.endsWith(`.${firstPartyHost}`));
}

export function shouldBlockRequest(details: AdBlockRequestDetails): boolean {
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
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostnameMatches(hostname, suffix))) {
    return true;
  }

  const firstPartyHost =
    parseHostname(details.referrer) || parseHostname(details.initiator || "");
  if (!isThirdParty(parsed, firstPartyHost)) return false;

  const candidate = `${hostname}${parsed.pathname}${parsed.search}`;
  return THIRD_PARTY_PATH_PATTERNS.some((pattern) => pattern.test(candidate));
}

export function getAdBlockDecision(
  details: AdBlockRequestDetails,
): AdBlockDecision {
  if (!shouldBlockRequest(details)) return { cancel: false };

  if (details.resourceType === "subFrame") {
    return { redirectURL: EMPTY_BLOCKED_FRAME_URL };
  }

  return { cancel: true };
}
