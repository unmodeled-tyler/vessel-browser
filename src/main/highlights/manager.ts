import { app } from "electron";
import path from "path";
import { randomUUID } from "crypto";
import type {
  HighlightColor,
  HighlightSource,
  HighlightsState,
  StoredHighlight,
} from "../../shared/types";
import {
  createDebouncedJsonPersistence,
  loadJsonFile,
} from "../persistence/json-file";

let state: HighlightsState | null = null;
const listeners = new Set<(state: HighlightsState) => void>();
const SAVE_DEBOUNCE_MS = 250;

function getHighlightsPath(): string {
  return path.join(app.getPath("userData"), "vessel-highlights.json");
}

function createPersistence() {
  return createDebouncedJsonPersistence({
    debounceMs: SAVE_DEBOUNCE_MS,
    filePath: getHighlightsPath(),
    getValue: () => state,
    logLabel: "highlights",
    resetOnSchedule: true,
  });
}

let persistence: ReturnType<typeof createPersistence> | null = null;

function getPersistence(): ReturnType<typeof createPersistence> {
  persistence ??= createPersistence();
  return persistence;
}

function load(): HighlightsState {
  if (state) return state;
  state = loadJsonFile({
    filePath: getHighlightsPath(),
    fallback: { highlights: [] },
    parse: (raw) => {
      const parsed = raw as Partial<HighlightsState>;
      return {
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
      };
    },
  });
  return state;
}

function save(): void {
  getPersistence().schedule();
}

function emit(): void {
  if (!state) return;
  const snapshot = { highlights: [...state.highlights] };
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return rawUrl;
  }
}

export function getState(): HighlightsState {
  load();
  return { highlights: [...state!.highlights] };
}

export function subscribe(
  listener: (state: HighlightsState) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getHighlightsForUrl(url: string): StoredHighlight[] {
  load();
  const normalized = normalizeUrl(url);
  return state!.highlights.filter((h) => h.url === normalized);
}

export function addHighlight(
  url: string,
  selector?: string,
  text?: string,
  label?: string,
  color?: HighlightColor,
  source?: HighlightSource,
): StoredHighlight {
  load();
  const highlight: StoredHighlight = {
    id: randomUUID(),
    url: normalizeUrl(url),
    selector: selector || undefined,
    text: text || undefined,
    label: label || undefined,
    color: color || undefined,
    source: source || undefined,
    createdAt: new Date().toISOString(),
  };
  state!.highlights.push(highlight);
  save();
  emit();
  return highlight;
}

export function getHighlight(id: string): StoredHighlight | null {
  load();
  return state!.highlights.find((h) => h.id === id) ?? null;
}

export function removeHighlight(id: string): StoredHighlight | null {
  load();
  const index = state!.highlights.findIndex((h) => h.id === id);
  if (index === -1) return null;
  const [removed] = state!.highlights.splice(index, 1);
  save();
  emit();
  return removed;
}

export function findHighlightByText(
  url: string,
  text: string,
): StoredHighlight | null {
  load();
  const normalized = normalizeUrl(url);
  return (
    state!.highlights.find(
      (h) => h.url === normalized && h.text && h.text === text,
    ) ?? null
  );
}

export function updateHighlightColor(
  id: string,
  color: HighlightColor,
): StoredHighlight | null {
  load();
  const highlight = state!.highlights.find((h) => h.id === id);
  if (!highlight) return null;
  highlight.color = color;
  save();
  emit();
  return highlight;
}

export function clearHighlightsForUrl(url: string): number {
  load();
  const normalized = normalizeUrl(url);
  const before = state!.highlights.length;
  state!.highlights = state!.highlights.filter((h) => h.url !== normalized);
  const removed = before - state!.highlights.length;
  if (removed > 0) {
    save();
    emit();
  }
  return removed;
}

export function flushPersist(): Promise<void> {
  return getPersistence().flush();
}
