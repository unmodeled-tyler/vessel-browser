import type { PageDiffHistoryItem } from "../../shared/page-diff-types";

export function normalizePageDiffHistoryItem(
  value: unknown,
): PageDiffHistoryItem | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.detectedAt !== "string" ||
    typeof raw.summary !== "string"
  ) {
    return null;
  }
  return {
    detectedAt: raw.detectedAt,
    summary: raw.summary,
  };
}

export function prunePageDiffHistory(
  items: PageDiffHistoryItem[],
  options: {
    maxAgeDays: number;
    maxItems: number;
    now?: number;
  },
): PageDiffHistoryItem[] {
  const cutoff =
    (options.now ?? Date.now()) - options.maxAgeDays * 24 * 60 * 60 * 1000;

  return items
    .filter((item) => {
      const detectedAt = Date.parse(item.detectedAt);
      return Number.isFinite(detectedAt) && detectedAt >= cutoff;
    })
    .sort(
      (left, right) =>
        Date.parse(left.detectedAt) - Date.parse(right.detectedAt),
    )
    .slice(-options.maxItems);
}

export function appendPageDiffHistoryItem(
  items: PageDiffHistoryItem[],
  next: PageDiffHistoryItem,
  options: {
    maxAgeDays: number;
    maxItems: number;
    now?: number;
  },
): PageDiffHistoryItem[] {
  return prunePageDiffHistory([...items, next], options);
}
