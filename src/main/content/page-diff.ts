import type { PageSnapshot } from "../content/page-snapshots";
import type { ContentChange, PageDiff } from "../../shared/page-diff-types";

export type { PageDiff, ContentChange };

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function countOverlap(a: string[], b: string[]): number {
  const setB = new Set(b);
  return a.filter((w) => setB.has(w)).length;
}

function findChangedRegions(oldTokens: string[], newTokens: string[]): { added: string[]; removed: string[] } {
  const oldSet = new Set(oldTokens);
  const newSet = new Set(newTokens);
  const added = newTokens.filter((w) => !oldSet.has(w));
  const removed = oldTokens.filter((w) => !newSet.has(w));
  return { added, removed };
}

function summarizeWordDiff(added: string[], removed: string[]): string {
  const parts: string[] = [];
  if (added.length > 0) {
    const preview = added.slice(0, 8).join(" ");
    parts.push(`+${added.length} words: "${preview}${added.length > 8 ? "..." : ""}"`);
  }
  if (removed.length > 0) {
    const preview = removed.slice(0, 8).join(" ");
    parts.push(`-${removed.length} words: "${preview}${removed.length > 8 ? "..." : ""}"`);
  }
  return parts.join("; ");
}

export function diffSnapshots(oldSnap: PageSnapshot, currentContent: string, currentTitle: string, currentHeadings: string): PageDiff {
  const changes: ContentChange[] = [];

  if (oldSnap.title !== currentTitle) {
    changes.push({
      kind: "changed",
      section: "title",
      summary: `"${oldSnap.title}" → "${currentTitle}"`,
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
      changes.push({ kind: added.length > 0 ? "added" : "removed", section: "headings", summary: parts.join(". ") });
    }
  }

  const oldTokens = tokenize(oldSnap.textContent);
  const newTokens = tokenize(currentContent);
  const overlap = countOverlap(oldTokens, newTokens);
  const similarity = oldTokens.length > 0 ? overlap / Math.max(oldTokens.length, 1) : (newTokens.length > 0 ? 0 : 1);

  if (similarity < 0.98) {
    const diff = findChangedRegions(oldTokens, newTokens);
    if (diff.added.length > 3 || diff.removed.length > 3) {
      changes.push({
        kind: "changed",
        section: "content",
        summary: summarizeWordDiff(diff.added, diff.removed),
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
