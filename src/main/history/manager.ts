import { app } from "electron";
import path from "path";
import fs from "fs";
import type { HistoryEntry, HistoryState } from "../../shared/types";

const MAX_HISTORY_ENTRIES = 5000;
const SAVE_DEBOUNCE_MS = 250;

let state: HistoryState | null = null;
const listeners = new Set<(state: HistoryState) => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveDirty = false;

function getHistoryPath(): string {
  return path.join(app.getPath("userData"), "vessel-history.json");
}

function load(): HistoryState {
  if (state) return state;
  try {
    const raw = fs.readFileSync(getHistoryPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<HistoryState>;
    state = {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    state = { entries: [] };
  }
  return state;
}

function persistNow(): Promise<void> {
  saveDirty = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return fs.promises
    .mkdir(path.dirname(getHistoryPath()), { recursive: true })
    .then(() =>
      fs.promises.writeFile(
        getHistoryPath(),
        JSON.stringify(state, null, 2),
        "utf-8",
      ),
    )
    .catch((err) => console.error("[Vessel] Failed to save history:", err));
}

function save(): void {
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (saveDirty) {
      void persistNow();
    }
  }, SAVE_DEBOUNCE_MS);
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

export function flushPersist(): Promise<void> {
  return saveDirty ? persistNow() : Promise.resolve();
}
