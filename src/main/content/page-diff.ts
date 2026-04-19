import type { PageSnapshot } from "../content/page-snapshots";
import type { ContentChange, PageDiff } from "../../shared/page-diff-types";

export type { PageDiff, ContentChange };

const MAX_DETAIL_ITEMS = 3;
const MIN_BLOCK_SIMILARITY = 0.82;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, max = 180): string {
  const normalized = normalizeText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function tokenize(text: string): string[] {
  return normalizeText(text).toLowerCase().split(/\s+/).filter(Boolean);
}

function countOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const token of b) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  let overlap = 0;
  for (const token of a) {
    const remaining = counts.get(token) || 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(token, remaining - 1);
    }
  }

  return overlap;
}

function similarityScore(a: string, b: string): number {
  const aTokens = tokenize(a);
  const bTokens = tokenize(b);
  if (aTokens.length === 0 && bTokens.length === 0) return 1;
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  return countOverlap(aTokens, bTokens) / Math.max(aTokens.length, bTokens.length);
}

function extractTextBlocks(text: string): string[] {
  const compact = text.replace(/\r\n/g, "\n").trim();
  if (!compact) return [];

  const paragraphs = compact
    .split(/\n\s*\n+/)
    .map((block) => normalizeText(block))
    .filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;

  return compact
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
}

function buildLcsTable(a: string[], b: string[]): number[][] {
  const table = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  return table;
}

function diffBlocks(
  oldBlocks: string[],
  newBlocks: string[],
): Array<
  | { type: "equal"; value: string }
  | { type: "removed"; value: string }
  | { type: "added"; value: string }
> {
  const table = buildLcsTable(oldBlocks, newBlocks);
  const ops: Array<
    | { type: "equal"; value: string }
    | { type: "removed"; value: string }
    | { type: "added"; value: string }
  > = [];

  let i = 0;
  let j = 0;
  while (i < oldBlocks.length && j < newBlocks.length) {
    if (oldBlocks[i] === newBlocks[j]) {
      ops.push({ type: "equal", value: oldBlocks[i] });
      i += 1;
      j += 1;
      continue;
    }

    if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: "removed", value: oldBlocks[i] });
      i += 1;
    } else {
      ops.push({ type: "added", value: newBlocks[j] });
      j += 1;
    }
  }

  while (i < oldBlocks.length) {
    ops.push({ type: "removed", value: oldBlocks[i] });
    i += 1;
  }
  while (j < newBlocks.length) {
    ops.push({ type: "added", value: newBlocks[j] });
    j += 1;
  }

  return ops;
}

function summarizeContentChange(
  changedCount: number,
  addedCount: number,
  removedCount: number,
): string {
  const parts: string[] = [];
  if (changedCount > 0) {
    parts.push(
      `${changedCount} updated ${changedCount === 1 ? "section" : "sections"}`,
    );
  }
  if (addedCount > 0) {
    parts.push(
      `${addedCount} added ${addedCount === 1 ? "section" : "sections"}`,
    );
  }
  if (removedCount > 0) {
    parts.push(
      `${removedCount} removed ${removedCount === 1 ? "section" : "sections"}`,
    );
  }
  return parts.join(", ");
}

export function diffSnapshots(oldSnap: PageSnapshot, currentContent: string, currentTitle: string, currentHeadings: string): PageDiff {
  const changes: ContentChange[] = [];

  if (oldSnap.title !== currentTitle) {
    changes.push({
      kind: "changed",
      section: "title",
      summary: `"${oldSnap.title}" → "${currentTitle}"`,
      before: oldSnap.title,
      after: currentTitle,
    });
  }

  const oldHeadings = oldSnap.headings.split("\n").filter(Boolean);
  const newHeadings = currentHeadings.split("\n").filter(Boolean);
  if (oldHeadings.join("\n") !== newHeadings.join("\n")) {
    const added = newHeadings.filter((h) => !oldHeadings.includes(h));
    const removed = oldHeadings.filter((h) => !newHeadings.includes(h));
    const parts: string[] = [];
    if (added.length > 0) parts.push(`New: ${added.join(", ")}`);
    if (removed.length > 0) parts.push(`Gone: ${removed.join(", ")}`);
    if (parts.length > 0) {
      changes.push({
        kind:
          added.length > 0 && removed.length > 0
            ? "changed"
            : added.length > 0
              ? "added"
              : "removed",
        section: "headings",
        summary: parts.join(". "),
        addedItems: added.slice(0, MAX_DETAIL_ITEMS),
        removedItems: removed.slice(0, MAX_DETAIL_ITEMS),
      });
    }
  }

  const oldBlocks = extractTextBlocks(oldSnap.textContent);
  const newBlocks = extractTextBlocks(currentContent);
  const overallSimilarity = similarityScore(oldSnap.textContent, currentContent);

  if (overallSimilarity < 0.98) {
    const ops = diffBlocks(oldBlocks, newBlocks);
    const addedBlocks: string[] = [];
    const removedBlocks: string[] = [];
    const changedPairs: Array<{ before: string; after: string }> = [];

    let idx = 0;
    while (idx < ops.length) {
      if (ops[idx]?.type === "equal") {
        idx += 1;
        continue;
      }

      const pendingRemoved: string[] = [];
      const pendingAdded: string[] = [];
      while (idx < ops.length && ops[idx]?.type !== "equal") {
        const op = ops[idx];
        if (op?.type === "removed") pendingRemoved.push(op.value);
        if (op?.type === "added") pendingAdded.push(op.value);
        idx += 1;
      }

      while (pendingRemoved.length > 0 && pendingAdded.length > 0) {
        const before = pendingRemoved[0];
        const after = pendingAdded[0];
        if (similarityScore(before, after) < MIN_BLOCK_SIMILARITY) break;
        changedPairs.push({ before, after });
        pendingRemoved.shift();
        pendingAdded.shift();
      }

      removedBlocks.push(...pendingRemoved);
      addedBlocks.push(...pendingAdded);
    }

    if (
      changedPairs.length > 0 ||
      addedBlocks.length > 0 ||
      removedBlocks.length > 0
    ) {
      changes.push({
        kind: "changed",
        section: "content",
        summary: summarizeContentChange(
          changedPairs.length,
          addedBlocks.length,
          removedBlocks.length,
        ),
        before: changedPairs[0]
          ? truncateText(changedPairs[0].before)
          : removedBlocks[0]
            ? truncateText(removedBlocks[0])
            : undefined,
        after: changedPairs[0]
          ? truncateText(changedPairs[0].after)
          : addedBlocks[0]
            ? truncateText(addedBlocks[0])
            : undefined,
        addedItems: addedBlocks
          .slice(0, MAX_DETAIL_ITEMS)
          .map((item) => truncateText(item)),
        removedItems: removedBlocks
          .slice(0, MAX_DETAIL_ITEMS)
          .map((item) => truncateText(item)),
      });
    }
  }

  return {
    url: oldSnap.url,
    hasChanges: changes.length > 0,
    oldSnapshot: { capturedAt: oldSnap.capturedAt, title: oldSnap.title },
    changes,
  };
}
