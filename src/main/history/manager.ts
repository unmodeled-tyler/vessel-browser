import type { ClearDataTimeRange, HistoryEntry, HistoryPage, HistoryState, ImportResult } from "../../shared/types";
import {
  HistoryImportStateSchema,
  HistoryEntrySchema,
  parseArrayStateWithFallback,
} from "../../shared/persistence-schemas";
import { PersistentState } from "../persistence/persistent-state";

const MAX_HISTORY_ENTRIES = 5000;

const HISTORY_FALLBACK: HistoryState = { entries: [] };

const store = new PersistentState<HistoryState, HistoryPage>({
  filename: "vessel-history.json",
  fallback: HISTORY_FALLBACK,
  parse: (raw: unknown) =>
    parseArrayStateWithFallback(HistoryEntrySchema, raw, "entries", HISTORY_FALLBACK, "history"),
  logLabel: "history",
  debounceMs: 250,
  snapshot: (s) => {
    const entries = s.entries.slice(0, 200);
    return {
      entries,
      offset: 0,
      limit: entries.length,
      total: s.entries.length,
    };
  },
});

export function listEntries(offset = 0, limit = 200): HistoryPage {
  const s = store.getState();
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  return {
    entries: s.entries.slice(safeOffset, safeOffset + safeLimit),
    offset: safeOffset,
    limit: safeLimit,
    total: s.entries.length,
  };
}

export function getState(): HistoryState {
  const s = store.getState();
  return { entries: [...s.entries] };
}

export function subscribe(
  listener: (state: HistoryPage) => void,
): () => void {
  return store.subscribe(listener);
}

export function addEntry(url: string, title: string): void {
  if (!url || url === "about:blank") return;

  const changed = store.mutate((s) => {
    // Don't record duplicate consecutive visits to the same URL
    const last = s.entries[0];
    if (last && last.url === url) {
      // Update title if it changed
      if (title && title !== last.title) {
        last.title = title;
        return true;
      }
      return false;
    }

    const entry: HistoryEntry = {
      url,
      title: title || url,
      visitedAt: new Date().toISOString(),
    };

    s.entries.unshift(entry);

    // Cap history size
    if (s.entries.length > MAX_HISTORY_ENTRIES) {
      s.entries = s.entries.slice(0, MAX_HISTORY_ENTRIES);
    }
    return true;
  }, { save: false, emit: false });

  if (changed) {
    store.save();
    store.emit();
  }
}

export function search(query: string, limit = 50): HistoryEntry[] {
  const s = store.getState();
  if (!query.trim()) return s.entries.slice(0, limit);

  const normalized = query.toLowerCase();
  return s.entries
    .filter(
      (e) =>
        e.url.toLowerCase().includes(normalized) ||
        e.title.toLowerCase().includes(normalized),
    )
    .slice(0, limit);
}

export function clearAll(): void {
  store.mutate((s) => {
    s.entries = [];
  });
}

export function clearByTimeRange(timeRange: ClearDataTimeRange): void {
  if (timeRange === "all") {
    clearAll();
    return;
  }
  const now = Date.now();
  const cutoff = new Date(now - timeRangeToMs(timeRange));
  store.mutate((s) => {
    s.entries = s.entries.filter((entry) => {
      const visitedAt = new Date(entry.visitedAt).getTime();
      return Number.isNaN(visitedAt) || visitedAt < cutoff.getTime();
    });
  });
}

function timeRangeToMs(range: ClearDataTimeRange): number {
  switch (range) {
    case "hour": return 60 * 60 * 1000;
    case "day": return 24 * 60 * 60 * 1000;
    case "week": return 7 * 24 * 60 * 60 * 1000;
    case "month": return 30 * 24 * 60 * 60 * 1000;
    case "all": return Infinity;
  }
}

export function exportHistoryHtml(): string {
  const current = getState();
  const lines = [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8"><title>Browsing History</title>',
    "<style>",
    "body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }",
    "table { width: 100%; border-collapse: collapse; }",
    "th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }",
    "a { color: #1a0dab; text-decoration: none; }",
    "a:hover { text-decoration: underline; }",
    "th { font-weight: 600; color: #333; }",
    "</style>",
    "</head><body>",
    "<h1>Browsing History</h1>",
    `<p>Exported ${new Date().toISOString()}</p>`,
    "<table><thead><tr><th>Title</th><th>URL</th><th>Visited</th></tr></thead><tbody>",
  ];
  for (const entry of current.entries) {
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    lines.push(
      `<tr><td>${esc(entry.title)}</td><td><a href="${esc(entry.url)}">${esc(entry.url)}</a></td><td>${esc(entry.visitedAt)}</td></tr>`,
    );
  }
  lines.push("</tbody></table></body></html>");
  return lines.join("\n");
}

export function exportHistoryJson(): string {
  return JSON.stringify(getState(), null, 2);
}

export function importHistoryFromJson(content: string): ImportResult {
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  try {
    const parsed = HistoryImportStateSchema.safeParse(JSON.parse(content));
    const entries = parsed.success ? parsed.data.entries : [];
    if (!parsed.success) errors++;
    const s = store.getState();
    const existingUrls = new Set(s.entries.map((e) => e.url));
    for (const entry of entries) {
      if (!entry.url) {
        errors++;
        continue;
      }
      if (existingUrls.has(entry.url)) {
        skipped++;
        continue;
      }
      existingUrls.add(entry.url);
      imported++;
    }
    if (imported > 0) {
      store.mutate((state) => {
        const urlSet = new Set(state.entries.map((e) => e.url));
        for (const entry of entries) {
          if (!entry.url || urlSet.has(entry.url)) continue;
          state.entries.push({
            url: entry.url,
            title: entry.title || entry.url,
            visitedAt: entry.visitedAt || new Date().toISOString(),
          });
          urlSet.add(entry.url);
        }
        state.entries.sort(
          (a, b) => new Date(b.visitedAt).getTime() - new Date(a.visitedAt).getTime(),
        );
        if (state.entries.length > MAX_HISTORY_ENTRIES) {
          state.entries = state.entries.slice(0, MAX_HISTORY_ENTRIES);
        }
      });
    }
  } catch {
    errors++;
  }
  return { imported, skipped, errors };
}

export function importHistoryFromHtml(content: string): ImportResult {
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  const s = store.getState();
  const existingUrls = new Set(s.entries.map((e) => e.url));
  const hrefRegex = /<A\s+[^>]*HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi;
  const newEntries: HistoryEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(content)) !== null) {
    const url = match[1];
    const title = match[2] || url;
    if (!url || existingUrls.has(url)) {
      if (url) skipped++;
      else errors++;
      continue;
    }
    newEntries.push({ url, title, visitedAt: new Date().toISOString() });
    existingUrls.add(url);
    imported++;
  }
  if (newEntries.length > 0) {
    store.mutate((state) => {
      state.entries.push(...newEntries);
      state.entries.sort(
        (a, b) => new Date(b.visitedAt).getTime() - new Date(a.visitedAt).getTime(),
      );
      if (state.entries.length > MAX_HISTORY_ENTRIES) {
        state.entries = state.entries.slice(0, MAX_HISTORY_ENTRIES);
      }
    });
  }
  return { imported, skipped, errors };
}

export function flushPersist(): Promise<void> {
  return store.flushPersist();
}
