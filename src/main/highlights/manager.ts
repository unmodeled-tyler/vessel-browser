import { randomUUID } from "crypto";
import type {
  HighlightColor,
  HighlightSource,
  HighlightsState,
  StoredHighlight,
} from "../../shared/types";
import { StoredHighlightSchema, parseArrayStateWithFallback } from "../../shared/persistence-schemas";
import { PersistentState } from "../persistence/persistent-state";

const HIGHLIGHTS_FALLBACK: HighlightsState = { highlights: [] };

const store = new PersistentState<HighlightsState>({
  filename: "vessel-highlights.json",
  fallback: HIGHLIGHTS_FALLBACK,
  parse: (raw: unknown) =>
    parseArrayStateWithFallback(StoredHighlightSchema, raw, "highlights", HIGHLIGHTS_FALLBACK, "highlights"),
  logLabel: "highlights",
  debounceMs: 250,
  resetOnSchedule: true,
  snapshot: (s) => ({ highlights: [...s.highlights] }),
});

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
  const s = store.getState();
  return { highlights: [...s.highlights] };
}

export function subscribe(
  listener: (state: HighlightsState) => void,
): () => void {
  return store.subscribe(listener);
}

export function getHighlightsForUrl(url: string): StoredHighlight[] {
  const normalized = normalizeUrl(url);
  return store.getState().highlights.filter((h) => h.url === normalized);
}

export function addHighlight(
  url: string,
  selector?: string,
  text?: string,
  label?: string,
  color?: HighlightColor,
  source?: HighlightSource,
): StoredHighlight {
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
  store.mutate((s) => {
    s.highlights.push(highlight);
  });
  return highlight;
}

export function getHighlight(id: string): StoredHighlight | null {
  return store.getState().highlights.find((h) => h.id === id) ?? null;
}

export function removeHighlight(id: string): StoredHighlight | null {
  const removed = store.mutate((s) => {
    const index = s.highlights.findIndex((h) => h.id === id);
    if (index === -1) return null;
    const [removed] = s.highlights.splice(index, 1);
    return removed;
  }, {
    save: false,
    emit: false,
  });
  if (removed) {
    store.save();
    store.emit();
  }
  return removed;
}

export function findHighlightByText(
  url: string,
  text: string,
): StoredHighlight | null {
  const normalized = normalizeUrl(url);
  return (
    store.getState().highlights.find(
      (h) => h.url === normalized && h.text && h.text === text,
    ) ?? null
  );
}

export function updateHighlightColor(
  id: string,
  color: HighlightColor,
): StoredHighlight | null {
  const highlight = store.mutate((s) => {
    const item = s.highlights.find((h) => h.id === id) ?? null;
    if (item) item.color = color;
    return item;
  }, {
    save: false,
    emit: false,
  });
  if (highlight) {
    store.save();
    store.emit();
  }
  return highlight;
}

export function clearHighlightsForUrl(url: string): number {
  const normalized = normalizeUrl(url);
  const removed = store.mutate((s) => {
    const before = s.highlights.length;
    s.highlights = s.highlights.filter((h) => h.url !== normalized);
    return before - s.highlights.length;
  }, {
    save: false,
    emit: false,
  });
  if (removed > 0) {
    store.save();
    store.emit();
  }
  return removed;
}

export function flushPersist(): Promise<void> {
  return store.flushPersist();
}
