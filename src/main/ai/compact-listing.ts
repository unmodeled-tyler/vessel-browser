import type { InteractiveElement, PageContent } from "../../shared/types";
import type { ExtractMode } from "./context-builder";

function normalizeComparable(value: string | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeUrlForMatch(value?: string): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`.toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase() || null;
  }
}

function getUrlPathSegments(value?: string): string[] {
  if (!value) return [];

  try {
    return new URL(value).pathname.split("/").filter(Boolean);
  } catch {
    return value.split("?")[0].split("#")[0].split("/").filter(Boolean);
  }
}

function isVisible(element: InteractiveElement): boolean {
  return (
    element.visible !== false &&
    element.obscured !== true &&
    element.blockedByOverlay !== true
  );
}

function isInViewport(element: InteractiveElement): boolean {
  return element.inViewport !== false;
}

function looksLikeListingPage(page: PageContent): boolean {
  const haystack = normalizeComparable(
    [
      page.url,
      page.title,
      page.excerpt,
      page.content.slice(0, 2000),
      page.headings.map((heading) => heading.text).join(" "),
    ]
      .filter(Boolean)
      .join(" "),
  );

  return /\b(search|results|browse|discover|arrivals|new arrivals|staff picks|picks of the month|monthly picks|featured|bestsellers|best sellers|category|categories|books|book list|fiction|nonfiction|poetry|history|science|children)\b/.test(
    haystack,
  );
}

function isBlockedLabel(label: string): boolean {
  return /\b(home|menu|about|contact|privacy|terms|login|sign in|sign up|subscribe|newsletter|facebook|instagram|pinterest|share|print|next|previous|prev|sort|filter|wishlist|account|cart|checkout|view all|see all)\b/.test(
    label,
  );
}

function resultScore(
  page: PageContent,
  element: InteractiveElement,
  listingLike: boolean,
): number {
  if (element.type !== "link" || !element.href || !element.text?.trim()) return -1;

  const text = element.text.trim();
  const comparableText = normalizeComparable(text);
  const href = normalizeUrlForMatch(element.href);
  const pageUrl = normalizeUrlForMatch(page.url);
  const hrefSegments = getUrlPathSegments(element.href);
  const haystack = normalizeComparable(
    [text, element.description, element.selector, element.href, element.context]
      .filter(Boolean)
      .join(" "),
  );

  if (!comparableText || isBlockedLabel(comparableText)) return -1;

  let score = 0;

  if (element.context === "article") score += 5;
  if (element.context === "main" || element.context === "content") score += 4;
  if (!element.context) score += 1;

  if (isVisible(element)) score += 2;
  if (isInViewport(element)) score += 3;

  if (text.length >= 8 && text.length <= 140) score += 2;
  if (text.split(/\s+/).length >= 2) score += 2;
  if (text.split(/\s+/).length >= 4) score += 1;

  if (hrefSegments.length >= 2) score += 1;
  if (hrefSegments.some((segment) => /book|books|item|product|title|catalog/.test(segment))) {
    score += 3;
  }

  if (href && pageUrl) {
    try {
      if (new URL(href).origin === new URL(pageUrl).origin) score += 2;
    } catch {
      // ignore malformed URLs
    }
  }

  if (listingLike) score += 2;
  if (/\b(book|novel|story|poems|poetry|essays|memoir|history|science|fiction)\b/.test(haystack)) {
    score += 2;
  }

  if (/\b(author|hardcover|paperback|preorder|pre-order|signed edition)\b/.test(haystack)) {
    score += 1;
  }

  if (
    element.context === "nav" ||
    element.context === "header" ||
    element.context === "footer" ||
    element.context === "sidebar" ||
    element.context === "dialog"
  ) {
    score -= 6;
  }

  if (/\b(filter|sort|format|price|signed|staff picks|more results|view all)\b/.test(comparableText)) {
    score -= 3;
  }

  return score;
}

export function getCompactPrimaryResultLinks(
  page: PageContent,
  options?: { visibleOnly?: boolean; max?: number },
): InteractiveElement[] {
  const listingLike = looksLikeListingPage(page);
  const max = options?.max ?? 8;
  const visibleOnly = options?.visibleOnly === true;
  const seen = new Set<string>();

  return page.interactiveElements
    .filter((element) => !visibleOnly || isVisible(element))
    .map((element) => ({
      element,
      score: resultScore(page, element, listingLike),
    }))
    .filter(({ score }) => score >= (listingLike ? 5 : 7))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.element.index ?? Number.MAX_SAFE_INTEGER) -
          (b.element.index ?? Number.MAX_SAFE_INTEGER),
    )
    .map(({ element }) => element)
    .filter((element) => {
      const key = `${normalizeComparable(element.text)}|${normalizeUrlForMatch(element.href) || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
}

export function chooseCompactReadMode(
  page: PageContent,
  fallbackMode: ExtractMode,
): ExtractMode {
  if (fallbackMode === "results_only") return fallbackMode;
  const candidates = getCompactPrimaryResultLinks(page, { max: 6 });
  if (candidates.length >= 4) return "results_only";
  if (candidates.length >= 2 && looksLikeListingPage(page)) return "results_only";
  return fallbackMode;
}
