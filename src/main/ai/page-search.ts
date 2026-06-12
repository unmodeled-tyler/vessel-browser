import { SEARCH_ENGINE_PRESETS } from "../../shared/types";
import type { SearchEngineId } from "../../shared/types";
import { loadSettings } from "../config/settings";
import {
  buildHuggingFaceSearchShortcut,
  type SearchShortcut,
} from "./search-huggingface";

export function normalizeSearchQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

const COMMON_SEARCH_QUERY_PARAMS = [
  "search",
  "q",
  "query",
  "keyword",
  "keywords",
  "term",
  "text",
] as const;

const COMMON_PAGINATION_PARAMS = [
  "p",
  "page",
  "offset",
  "start",
  "cursor",
  "skip",
] as const;

function looksLikeSearchResultsPath(pathname: string): boolean {
  return /\/(search|results|browse|discover|find)(\/|$)/i.test(pathname);
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function searchEngineHostMatches(currentHost: string, presetHost: string): boolean {
  if (currentHost === presetHost) return true;
  return presetHost === "duckduckgo.com" && currentHost === "start.duckduckgo.com";
}

export function buildCommonSearchUrlShortcut(
  currentUrl: string,
  rawQuery: string,
): SearchShortcut | null {
  let url: URL;
  try {
    url = new URL(currentUrl);
  } catch {
    return null;
  }

  if (!/^https?:$/i.test(url.protocol)) {
    return null;
  }

  const query = normalizeSearchQuery(rawQuery);
  if (!query) return null;

  const existingParam = COMMON_SEARCH_QUERY_PARAMS.find((param) =>
    url.searchParams.has(param),
  );
  if (!existingParam && !looksLikeSearchResultsPath(url.pathname)) {
    return null;
  }

  const target = new URL(url.toString());
  const searchParam = existingParam ?? "q";
  target.searchParams.set(searchParam, query);
  for (const param of COMMON_PAGINATION_PARAMS) {
    target.searchParams.delete(param);
  }

  if (target.toString() === url.toString()) {
    return null;
  }

  return {
    url: target.toString(),
    source: "page URL",
    appliedFilters: existingParam ? [`updated ${existingParam} query`] : [],
  };
}

export function buildDefaultEngineShortcut(rawQuery: string): SearchShortcut | null {
  const settings = loadSettings();
  const engineId: SearchEngineId = settings.defaultSearchEngine ?? "duckduckgo";
  if (engineId === "none") return null;
  const preset = SEARCH_ENGINE_PRESETS[engineId];
  if (!preset) return null;
  const query = normalizeSearchQuery(rawQuery);
  if (!query) return null;
  return {
    url: preset.url + encodeURIComponent(query),
    source: "default search engine",
    appliedFilters: [],
  };
}

export function buildSearchEngineLandingShortcut(
  currentUrl: string,
  rawQuery: string,
): SearchShortcut | null {
  let url: URL;
  try {
    url = new URL(currentUrl);
  } catch {
    return null;
  }

  if (!/^https?:$/i.test(url.protocol)) {
    return null;
  }

  const query = normalizeSearchQuery(rawQuery);
  if (!query) return null;

  const currentHost = normalizeHost(url.hostname);
  const currentPath = url.pathname.replace(/\/+$/g, "") || "/";
  const isLandingPath = currentPath === "/" || currentPath === "/webhp";
  if (!isLandingPath) return null;

  for (const preset of Object.values(SEARCH_ENGINE_PRESETS)) {
    const presetUrl = new URL(preset.url);
    const presetHost = normalizeHost(presetUrl.hostname);
    if (!searchEngineHostMatches(currentHost, presetHost)) continue;
    return {
      url: preset.url + encodeURIComponent(query),
      source: `${preset.label} landing page`,
      appliedFilters: [],
    };
  }

  return null;
}

export function buildSearchShortcut(
  currentUrl: string,
  rawQuery: string,
): SearchShortcut | null {
  return (
    buildHuggingFaceSearchShortcut(currentUrl, rawQuery) ??
    buildSearchEngineLandingShortcut(currentUrl, rawQuery) ??
    buildCommonSearchUrlShortcut(currentUrl, rawQuery) ??
    buildDefaultEngineShortcut(rawQuery)
  );
}
