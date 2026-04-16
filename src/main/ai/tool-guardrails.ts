function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/www\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalizeUrlForComparison(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hostname = url.hostname.replace(/^www\./, "");
    url.hash = "";
    if (url.pathname.endsWith("/") && url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function isRedundantNavigateTarget(
  currentUrl: string,
  targetUrl: string,
): boolean {
  const current = canonicalizeUrlForComparison(currentUrl);
  const target = canonicalizeUrlForComparison(targetUrl);
  return current !== null && target !== null && current === target;
}

export function looksLikeCurrentSiteNameQuery(
  query: string,
  currentUrl: string,
  currentTitle: string,
): boolean {
  const normalizedQuery = normalizeForComparison(query);
  if (!normalizedQuery) return false;

  let hostnameLabel = "";
  try {
    const url = new URL(currentUrl);
    hostnameLabel = url.hostname.replace(/^www\./, "").split(".")[0] || "";
  } catch {
    // Ignore malformed current URL
  }

  const normalizedTitle = normalizeForComparison(currentTitle);
  const normalizedHost = normalizeForComparison(hostnameLabel);
  const normalizedTitlePrefix = normalizeForComparison(
    currentTitle.split("|")[0]?.split("—")[0]?.split("-")[0] || currentTitle,
  );

  if (normalizedTitle && normalizedQuery === normalizedTitle) return true;
  if (normalizedTitlePrefix && normalizedQuery === normalizedTitlePrefix) {
    return true;
  }
  if (normalizedHost && normalizedQuery === normalizedHost) return true;

  const titleTokens = new Set(normalizedTitle.split(/\s+/).filter(Boolean));
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (
    normalizedHost &&
    queryTokens.includes(normalizedHost) &&
    queryTokens.every((token) => titleTokens.has(token) || token === normalizedHost)
  ) {
    return true;
  }

  return false;
}

function extractExplicitDomains(goal: string): string[] {
  const matches = goal
    .toLowerCase()
    .match(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.(?:com|org|net|io|dev|app|ai|co|edu|gov))\b/g);

  if (!matches) return [];

  const normalized = matches.map((match) =>
    match
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .toLowerCase(),
  );

  return [...new Set(normalized)];
}

function apexDomain(hostname: string): string {
  const parts = hostname.replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

export function shouldBlockOffGoalDomainNavigation(
  goal: string,
  targetUrl: string,
): { requestedDomain: string; targetDomain: string } | null {
  const explicitDomains = extractExplicitDomains(goal);
  if (explicitDomains.length !== 1) return null;

  let targetHost = "";
  try {
    const url = new URL(targetUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    targetHost = url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }

  const requestedDomain = explicitDomains[0];
  if (
    targetHost === requestedDomain ||
    targetHost.endsWith(`.${requestedDomain}`) ||
    apexDomain(targetHost) === apexDomain(requestedDomain)
  ) {
    return null;
  }

  return {
    requestedDomain,
    targetDomain: targetHost,
  };
}

export function hasRecentDuplicateToolCall(
  recentToolSignatures: string[],
  signature: string,
): boolean {
  return recentToolSignatures.includes(signature);
}

export function isClickReadLoop(names: string[]): boolean {
  if (names.length < 6) return false;
  const tail = names.slice(-6);
  let clickReadPairs = 0;
  for (let i = 0; i < tail.length - 1; i++) {
    if (tail[i] === 'click' && tail[i + 1] === 'read_page') {
      clickReadPairs++;
    }
  }
  return clickReadPairs >= 2;
}
