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
