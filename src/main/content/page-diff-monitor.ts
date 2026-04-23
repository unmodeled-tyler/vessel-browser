import { app } from "electron";
import type { WebContents } from "electron";
import path from "path";
import { Channels } from "../../shared/channels";
import type {
  PageDiff,
  PageDiffHistoryItem,
} from "../../shared/page-diff-types";
import { diffSnapshots } from "./page-diff";
import * as pageSnapshots from "./page-snapshots";
import { extractContent } from "./extractor";
import type { SendToRendererViews } from "../ipc/common";
import {
  MUTATION_CAPTURE_INTERVAL_MS,
  MUTATION_SETTLE_AFTER_MS,
} from "../config/timing";
import {
  createDebouncedJsonPersistence,
  loadJsonFile,
} from "../persistence/json-file";
import {
  appendPageDiffHistoryItem,
  normalizePageDiffHistoryItem,
  prunePageDiffHistory,
} from "./page-diff-history";

const latestPageDiffs = new Map<string, PageDiff>();
const recentPageDiffBursts = new Map<string, PageDiffHistoryItem[]>();
let historyLoaded = false;
const pendingPageSnapshotTimers = new Map<number, ReturnType<typeof setTimeout>>();
const pendingPageSnapshotDueAt = new Map<number, number>();
const lastMutationSnapshotAt = new Map<number, number>();
const lastMutationActivityAt = new Map<number, number>();
const destroyListenerAttached = new WeakSet<WebContents>();

/**
 * Attaches a one-time cleanup handler to a WebContents that clears all pending
 * snapshot timers when the webContents is destroyed. Uses a WeakSet to avoid
 * duplicate attachments and ensure cleanup handlers don't prevent GC of the
 * webContents object.
 */
function cleanupTimersForWcId(wcId: number): void {
  const timer = pendingPageSnapshotTimers.get(wcId);
  if (timer) clearTimeout(timer);
  pendingPageSnapshotTimers.delete(wcId);
  pendingPageSnapshotDueAt.delete(wcId);
  lastMutationSnapshotAt.delete(wcId);
  lastMutationActivityAt.delete(wcId);
}

function attachDestroyCleanup(wc: WebContents): void {
  if (destroyListenerAttached.has(wc)) return;
  destroyListenerAttached.add(wc);
  wc.once("destroyed", () => {
    cleanupTimersForWcId(wc.id);
  });
}

const MAX_RECENT_DIFF_BURSTS = 5;
const MAX_PERSISTED_DIFF_BURSTS = 50;
const MAX_HISTORY_DAYS = 30;
const SAVE_DEBOUNCE_MS = 500;

function getHistoryFilePath(): string {
  return path.join(app.getPath("userData"), "vessel-page-diff-history.json");
}

function loadHistory(): Map<string, PageDiffHistoryItem[]> {
  if (historyLoaded) return recentPageDiffBursts;
  historyLoaded = true;

  const loaded = loadJsonFile({
    filePath: getHistoryFilePath(),
    fallback: new Map<string, PageDiffHistoryItem[]>(),
    secure: true,
    parse: (raw) => {
      const next = new Map<string, PageDiffHistoryItem[]>();
      if (!Array.isArray(raw)) return next;

      for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        if (
          typeof record.url !== "string" ||
          !Array.isArray(record.bursts)
        ) {
          continue;
        }
        next.set(
          record.url,
          prunePageDiffHistory(
            record.bursts
              .map((item) => normalizePageDiffHistoryItem(item))
              .filter((item): item is PageDiffHistoryItem => item !== null),
            {
              maxAgeDays: MAX_HISTORY_DAYS,
              maxItems: MAX_PERSISTED_DIFF_BURSTS,
            },
          ),
        );
      }

      return next;
    },
  });

  for (const [key, bursts] of loaded.entries()) {
    recentPageDiffBursts.set(key, bursts);
  }

  return recentPageDiffBursts;
}

const persistence = createDebouncedJsonPersistence({
  debounceMs: SAVE_DEBOUNCE_MS,
  filePath: getHistoryFilePath(),
  getValue: () => recentPageDiffBursts,
  logLabel: "page diff history",
  secure: true,
  serialize: (value) =>
    Array.from(value.entries()).map(([url, bursts]) => ({
      url,
      bursts,
    })),
});

export function getLatestPageDiff(rawUrl: string): PageDiff | null {
  if (!pageSnapshots.shouldTrackSnapshotUrl(rawUrl)) return null;
  return latestPageDiffs.get(pageSnapshots.normalizeUrl(rawUrl)) ?? null;
}

export function getPageDiffBursts(rawUrl: string): PageDiffHistoryItem[] {
  if (!pageSnapshots.shouldTrackSnapshotUrl(rawUrl)) return [];
  const key = pageSnapshots.normalizeUrl(rawUrl);
  const history = loadHistory();
  const bursts = prunePageDiffHistory(history.get(key) ?? [], {
    maxAgeDays: MAX_HISTORY_DAYS,
    maxItems: MAX_PERSISTED_DIFF_BURSTS,
  });

  const current = history.get(key) ?? [];
  if (current.length !== bursts.length) {
    if (bursts.length > 0) {
      history.set(key, bursts);
    } else {
      history.delete(key);
    }
    persistence.schedule();
  }

  return bursts.slice().reverse();
}

function summarizeDiffBurst(diff: PageDiff): string {
  const items = diff.changes
    .slice(0, 2)
    .map((change) => `${change.section}: ${change.summary}`);
  return items.join(" | ");
}

function enrichWithBurstHistory(key: string, diff: PageDiff): PageDiff {
  const detectedAt = new Date().toISOString();
  const nextBurst: PageDiffHistoryItem = {
    detectedAt,
    summary: summarizeDiffBurst(diff),
  };
  const history = loadHistory();
  const bursts = appendPageDiffHistoryItem(history.get(key) ?? [], nextBurst, {
    maxAgeDays: MAX_HISTORY_DAYS,
    maxItems: MAX_PERSISTED_DIFF_BURSTS,
    now: Date.parse(detectedAt),
  });
  history.set(key, bursts);
  persistence.schedule();
  const recentBursts = bursts.slice(-MAX_RECENT_DIFF_BURSTS);

  return {
    ...diff,
    burstCount: bursts.length,
    firstDetectedAt: bursts[0]?.detectedAt,
    lastDetectedAt: bursts[bursts.length - 1]?.detectedAt,
    recentBursts: recentBursts.slice().reverse(),
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
  const earliestAllowedAt = lastCaptureAt + MUTATION_CAPTURE_INTERVAL_MS;
  const stableAfterActivityAt = lastActivityAt
    ? lastActivityAt + MUTATION_SETTLE_AFTER_MS
    : 0;
  return Math.max(now + delayMs, earliestAllowedAt, stableAfterActivityAt);
}

function scheduleTimerAt(
  wc: WebContents,
  sendToRendererViews: SendToRendererViews,
  dueAt: number,
): void {
  attachDestroyCleanup(wc);
  const wcId = wc.id;
  const existing = pendingPageSnapshotTimers.get(wcId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    cleanupTimersForWcId(wcId);
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
