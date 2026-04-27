import { app } from "electron";
import path from "path";
import type { ClearDataTimeRange, HistoryEntry, HistoryState, ImportResult } from "../../shared/types";
import {
  createDebouncedJsonPersistence,
  loadJsonFile,
} from "../persistence/json-file";

const MAX_HISTORY_ENTRIES = 5000;
const SAVE_DEBOUNCE_MS = 250;

let state: HistoryState | null = null;
const listeners = new Set<(state: HistoryState) => void>();

function getHistoryPath(): string {
  return path.join(app.getPath("userData"), "vessel-history.json");
}

function load(): HistoryState {
  if (state) return state;
  state = loadJsonFile({
    filePath: getHistoryPath(),
    fallback: { entries: [] },
    parse: (raw) => {
      const parsed = raw as Partial<HistoryState>;
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    },
  });
  return state;
}

const persistence = createDebouncedJsonPersistence({
  debounceMs: SAVE_DEBOUNCE_MS,
  filePath: getHistoryPath(),
  getValue: () => state,
  logLabel: "history",
});

function save(): void {
  persistence.schedule();
}

function emit(): void {
  if (!state) return;
  const snapshot = { entries: [...state.entries] };
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function getState(): HistoryState {
  load();
  return { entries: [...state!.entries] };
}

export function subscribe(
  listener: (state: HistoryState) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function addEntry(url: string, title: string): void {
  if (!url || url === "about:blank") return;

  load();

  // Don't record duplicate consecutive visits to the same URL
  const last = state!.entries[0];
  if (last && last.url === url) {
    // Update title if it changed
    if (title && title !== last.title) {
      last.title = title;
      save();
      emit();
    }
    return;
  }

  const entry: HistoryEntry = {
    url,
    title: title || url,
    visitedAt: new Date().toISOString(),
  };

  state!.entries.unshift(entry);

  // Cap history size
  if (state!.entries.length > MAX_HISTORY_ENTRIES) {
    state!.entries = state!.entries.slice(0, MAX_HISTORY_ENTRIES);
  }

  save();
  emit();
}

export function search(query: string, limit = 50): HistoryEntry[] {
  load();
  if (!query.trim()) return state!.entries.slice(0, limit);

  const normalized = query.toLowerCase();
  return state!.entries
    .filter(
      (e) =>
        e.url.toLowerCase().includes(normalized) ||
        e.title.toLowerCase().includes(normalized),
    )
    .slice(0, limit);
}

export function clearAll(): void {
  state = { entries: [] };
  save();
  emit();
}

export function clearByTimeRange(timeRange: ClearDataTimeRange): void {
  load();
  if (timeRange === "all") {
    clearAll();
    return;
  }
  const now = Date.now();
  const cutoff = new Date(now - timeRangeToMs(timeRange));
  state!.entries = state!.entries.filter((entry) => {
    const visitedAt = new Date(entry.visitedAt).getTime();
    return Number.isNaN(visitedAt) || visitedAt < cutoff.getTime();
  });
  save();
  emit();
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
    const parsed = JSON.parse(content) as Partial<HistoryState>;
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    load();
    const existingUrls = new Set(state!.entries.map((e) => e.url));
    for (const entry of entries) {
      if (!entry?.url || typeof entry.url !== "string") {
        errors++;
        continue;
      }
      if (existingUrls.has(entry.url)) {
        skipped++;
        continue;
      }
      state!.entries.push({
        url: entry.url,
        title: typeof entry.title === "string" ? entry.title : entry.url,
        visitedAt: typeof entry.visitedAt === "string" ? entry.visitedAt : new Date().toISOString(),
      });
      existingUrls.add(entry.url);
      imported++;
    }
    state!.entries.sort(
      (a, b) => new Date(b.visitedAt).getTime() - new Date(a.visitedAt).getTime(),
    );
    if (state!.entries.length > MAX_HISTORY_ENTRIES) {
      state!.entries = state!.entries.slice(0, MAX_HISTORY_ENTRIES);
    }
    save();
    emit();
  } catch {
    errors++;
  }
  return { imported, skipped, errors };
}

export function importHistoryFromHtml(content: string): ImportResult {
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  load();
  const existingUrls = new Set(state!.entries.map((e) => e.url));
  const hrefRegex = /<A\s+[^>]*HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(content)) !== null) {
    const url = match[1];
    const title = match[2] || url;
    if (!url || existingUrls.has(url)) {
      if (url) skipped++;
      else errors++;
      continue;
    }
    state!.entries.push({
      url,
      title,
      visitedAt: new Date().toISOString(),
    });
    existingUrls.add(url);
    imported++;
  }
  state!.entries.sort(
    (a, b) => new Date(b.visitedAt).getTime() - new Date(a.visitedAt).getTime(),
  );
  if (state!.entries.length > MAX_HISTORY_ENTRIES) {
    state!.entries = state!.entries.slice(0, MAX_HISTORY_ENTRIES);
  }
  save();
  emit();
  return { imported, skipped, errors };
}

export function flushPersist(): Promise<void> {
  return persistence.flush();
}
