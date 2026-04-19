import type { WebContents } from "electron";
import { Channels } from "../../shared/channels";
import type { PageDiff } from "../../shared/page-diff-types";
import { diffSnapshots } from "./page-diff";
import * as pageSnapshots from "./page-snapshots";
import { extractContent } from "./extractor";
import type { SendToRendererViews } from "../ipc/common";

const latestPageDiffs = new Map<string, PageDiff>();
const pendingPageSnapshotTimers = new Map<number, ReturnType<typeof setTimeout>>();
const pendingPageSnapshotDueAt = new Map<number, number>();
const lastMutationSnapshotAt = new Map<number, number>();

const MIN_MUTATION_CAPTURE_INTERVAL_MS = 5000;

export function getLatestPageDiff(rawUrl: string): PageDiff | null {
  if (!pageSnapshots.shouldTrackSnapshotUrl(rawUrl)) return null;
  return latestPageDiffs.get(pageSnapshots.normalizeUrl(rawUrl)) ?? null;
}

export async function capturePageSnapshot(
  url: string,
  wc: WebContents,
  sendToRendererViews: SendToRendererViews,
): Promise<void> {
  try {
    if (!pageSnapshots.shouldTrackSnapshotUrl(url)) return;
    const key = pageSnapshots.normalizeUrl(url);
    const oldSnap = pageSnapshots.getSnapshot(key);
    const content = await extractContent(wc);
    const textContent = content.content || "";
    const title = content.title || "";
    const headings = content.headings || [];
    const currentHeadings = headings
      .map((h) => `${"#".repeat(h.level)} ${h.text}`)
      .join("\n");

    if (oldSnap) {
      const diff = diffSnapshots(oldSnap, textContent, title, currentHeadings);
      if (diff.hasChanges) {
        latestPageDiffs.set(key, diff);
        sendToRendererViews(Channels.PAGE_CHANGED, diff);
      } else {
        latestPageDiffs.delete(key);
      }
    } else {
      latestPageDiffs.delete(key);
    }

    pageSnapshots.saveSnapshot(url, title, textContent, headings);
  } catch {
    // Snapshot capture is best-effort.
  }
}

export function schedulePageSnapshotCapture(
  wc: WebContents,
  sendToRendererViews: SendToRendererViews,
  delayMs = 1200,
): void {
  if (wc.isDestroyed()) return;

  const wcId = wc.id;
  const now = Date.now();
  const lastCaptureAt = lastMutationSnapshotAt.get(wcId) || 0;
  const earliestAllowedAt = lastCaptureAt + MIN_MUTATION_CAPTURE_INTERVAL_MS;
  const nextDueAt = Math.max(now + delayMs, earliestAllowedAt);
  const existing = pendingPageSnapshotTimers.get(wcId);
  const existingDueAt = pendingPageSnapshotDueAt.get(wcId);
  if (existing && existingDueAt != null && existingDueAt <= nextDueAt) {
    return;
  }
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingPageSnapshotTimers.delete(wcId);
    pendingPageSnapshotDueAt.delete(wcId);
    if (wc.isDestroyed()) return;
    lastMutationSnapshotAt.set(wcId, Date.now());
    void capturePageSnapshot(wc.getURL(), wc, sendToRendererViews);
  }, Math.max(0, nextDueAt - now));

  pendingPageSnapshotTimers.set(wcId, timer);
  pendingPageSnapshotDueAt.set(wcId, nextDueAt);
}
