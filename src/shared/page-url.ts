export function normalizePageUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`.toLowerCase();
  } catch {
    return rawUrl.trim().replace(/\/+$/, "").toLowerCase();
  }
}

const SNAPSHOT_QUERY_KEYS = new Set([
  "q",
  "query",
  "search",
  "s",
  "term",
  "keyword",
  "keywords",
  "page",
  "p",
  "offset",
  "cursor",
  "sort",
  "order",
  "filter",
  "filters",
  "category",
  "categories",
  "tag",
  "tags",
  "tab",
  "view",
]);

const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source",
  "si",
]);

function normalizeQueryValue(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function serializeSnapshotParams(
  params: Array<readonly [string, string]>,
): string {
  return params
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}

function normalizeSnapshotParams(
  entries: Iterable<[string, string]>,
  pathname: string,
): Array<readonly [string, string]> {
  return Array.from(entries)
    .filter(([key, value]) =>
      shouldKeepSnapshotQueryParam(pathname, key, value),
    )
    .map(([key, value]) => [
      key.trim().toLowerCase(),
      normalizeQueryValue(value),
    ] as const)
    .sort(([keyA, valueA], [keyB, valueB]) =>
      keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB),
    );
}

function shouldKeepSnapshotQueryParam(
  pathname: string,
  rawKey: string,
  value: string,
): boolean {
  const key = rawKey.trim().toLowerCase();
  if (!key || !value.trim()) return false;
  if (key.startsWith("utm_")) return false;
  if (TRACKING_QUERY_KEYS.has(key)) return false;
  if (SNAPSHOT_QUERY_KEYS.has(key)) return true;

  return /\/(search|results|browse|discover|find|category|tag|topics?|collections?|list)(\/|$)/i.test(
    pathname,
  );
}

function buildSnapshotHashKey(hash: string, pathname: string): string | null {
  let raw = hash.replace(/^#/, "").trim();
  if (!raw) return null;

  let bang = false;
  if (raw.startsWith("!")) {
    bang = true;
    raw = raw.slice(1).trim();
  }

  if (raw.startsWith("/")) {
    const [routePart, queryPart = ""] = raw.split("?");
    const route = routePart.replace(/\/+$/, "") || "/";
    const params = normalizeSnapshotParams(
      new URLSearchParams(queryPart).entries(),
      pathname,
    );
    const query = serializeSnapshotParams(params);
    return `#${bang ? "!" : ""}${route.toLowerCase()}${
      query ? `?${query}` : ""
    }`;
  }

  const queryLike = raw.startsWith("?") ? raw.slice(1) : raw;
  if (queryLike.includes("=")) {
    const params = normalizeSnapshotParams(
      new URLSearchParams(queryLike).entries(),
      pathname,
    );
    if (params.length === 0) return null;
    const query = serializeSnapshotParams(params);
    return `#${bang ? "!" : ""}?${query}`;
  }

  return null;
}

export function buildPageSnapshotKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const params = normalizeSnapshotParams(url.searchParams.entries(), pathname);
    const query = serializeSnapshotParams(params);
    const hash = buildSnapshotHashKey(url.hash, pathname);

    return `${url.origin.toLowerCase()}${pathname.toLowerCase()}${
      query ? `?${query}` : ""
    }${hash || ""}`;
  } catch {
    return normalizePageUrl(rawUrl);
  }
}

export function matchesPageSnapshotUrl(left: string, right: string): boolean {
  return buildPageSnapshotKey(left) === buildPageSnapshotKey(right);
}

export function isTrackablePageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
