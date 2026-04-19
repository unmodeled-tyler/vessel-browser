import type { WebContents } from "electron";
import { Channels } from "../../shared/channels";
import type { PageDiff } from "../../shared/page-diff-types";
import { diffSnapshots } from "./page-diff";
import * as pageSnapshots from "./page-snapshots";
import { extractContent } from "./extractor";
import type { SendToRendererViews } from "../ipc/common";

const latestPageDiffs = new Map<string, PageDiff>();
const recentPageDiffBursts = new Map<
  string,
  Array<{ detectedAt: string; summary: string }>
>();
const pendingPageSnapshotTimers = new Map<number, ReturnType<typeof setTimeout>>();
const pendingPageSnapshotDueAt = new Map<number, number>();
const lastMutationSnapshotAt = new Map<number, number>();
const lastMutationActivityAt = new Map<number, number>();

const MIN_MUTATION_CAPTURE_INTERVAL_MS = 5000;
const SETTLE_AFTER_ACTIVITY_MS = 1500;
const MAX_RECENT_DIFF_BURSTS = 5;

export function getLatestPageDiff(rawUrl: string): PageDiff | null {
  if (!pageSnapshots.shouldTrackSnapshotUrl(rawUrl)) return null;
  return latestPageDiffs.get(pageSnapshots.normalizeUrl(rawUrl)) ?? null;
}

function summarizeDiffBurst(diff: PageDiff): string {
  const items = diff.changes
    .slice(0, 2)
    .map((change) => `${change.section}: ${change.summary}`);
  return items.join(" | ");
}

function enrichWithBurstHistory(key: string, diff: PageDiff): PageDiff {
  const detectedAt = new Date().toISOString();
  const nextBurst = {
    detectedAt,
    summary: summarizeDiffBurst(diff),
  };
  const bursts = [...(recentPageDiffBursts.get(key) || []), nextBurst].slice(
    -MAX_RECENT_DIFF_BURSTS,
  );
  recentPageDiffBursts.set(key, bursts);

  return {
    ...diff,
    burstCount: bursts.length,
    firstDetectedAt: bursts[0]?.detectedAt,
    lastDetectedAt: bursts[bursts.length - 1]?.detectedAt,
    recentBursts: bursts,
  };
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
        const enrichedDiff = enrichWithBurstHistory(key, diff);
        latestPageDiffs.set(key, enrichedDiff);
        sendToRendererViews(Channels.PAGE_CHANGED, enrichedDiff);
      } else {
        latestPageDiffs.delete(key);
      }
    } else {
      latestPageDiffs.delete(key);
      recentPageDiffBursts.delete(key);
    }

    pageSnapshots.saveSnapshot(url, title, textContent, headings);
  } catch {
    // Snapshot capture is best-effort.
  }
}

function computeNextSnapshotDueAt(
  wcId: number,
  now: number,
  delayMs: number,
): number {
  const lastCaptureAt = lastMutationSnapshotAt.get(wcId) || 0;
  const lastActivityAt = lastMutationActivityAt.get(wcId) || 0;
  const earliestAllowedAt = lastCaptureAt + MIN_MUTATION_CAPTURE_INTERVAL_MS;
  const stableAfterActivityAt = lastActivityAt
    ? lastActivityAt + SETTLE_AFTER_ACTIVITY_MS
    : 0;
  return Math.max(now + delayMs, earliestAllowedAt, stableAfterActivityAt);
}

function scheduleTimerAt(
  wc: WebContents,
  sendToRendererViews: SendToRendererViews,
  dueAt: number,
): void {
  const wcId = wc.id;
  const existing = pendingPageSnapshotTimers.get(wcId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingPageSnapshotTimers.delete(wcId);
    pendingPageSnapshotDueAt.delete(wcId);
    if (wc.isDestroyed()) return;
    lastMutationSnapshotAt.set(wcId, Date.now());
    void capturePageSnapshot(wc.getURL(), wc, sendToRendererViews);
  }, Math.max(0, dueAt - Date.now()));

  pendingPageSnapshotTimers.set(wcId, timer);
  pendingPageSnapshotDueAt.set(wcId, dueAt);
}

export function notePageMutationActivity(
  wc: WebContents,
  sendToRendererViews: SendToRendererViews,
): void {
  if (wc.isDestroyed()) return;

  const wcId = wc.id;
  const now = Date.now();
  lastMutationActivityAt.set(wcId, now);

  const existingDueAt = pendingPageSnapshotDueAt.get(wcId);
  if (existingDueAt == null) return;

  const nextDueAt = computeNextSnapshotDueAt(wcId, now, 0);
  if (nextDueAt <= existingDueAt) return;
  scheduleTimerAt(wc, sendToRendererViews, nextDueAt);
}

export function schedulePageSnapshotCapture(
  wc: WebContents,
  sendToRendererViews: SendToRendererViews,
  delayMs = 0,
): void {
  if (wc.isDestroyed()) return;

  const wcId = wc.id;
  const now = Date.now();
  const nextDueAt = computeNextSnapshotDueAt(wcId, now, delayMs);
  const existingDueAt = pendingPageSnapshotDueAt.get(wcId);
  if (existingDueAt != null && existingDueAt >= nextDueAt) {
    return;
  }
  scheduleTimerAt(wc, sendToRendererViews, nextDueAt);
}
