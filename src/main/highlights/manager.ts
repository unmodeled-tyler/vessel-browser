import { app } from "electron";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import type { HighlightsState, StoredHighlight } from "../../shared/types";

let state: HighlightsState | null = null;
const listeners = new Set<(state: HighlightsState) => void>();

function getHighlightsPath(): string {
  return path.join(app.getPath("userData"), "vessel-highlights.json");
}

function load(): HighlightsState {
  if (state) return state;
  try {
    const raw = fs.readFileSync(getHighlightsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<HighlightsState>;
    state = {
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
    };
  } catch {
    state = { highlights: [] };
  }
  return state;
}

function save(): void {
  fs.mkdirSync(path.dirname(getHighlightsPath()), { recursive: true });
  fs.writeFileSync(
    getHighlightsPath(),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
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
): StoredHighlight {
  load();
  const highlight: StoredHighlight = {
    id: randomUUID(),
    url: normalizeUrl(url),
    selector: selector || undefined,
    text: text || undefined,
    label: label || undefined,
    createdAt: new Date().toISOString(),
  };
  state!.highlights.push(highlight);
  save();
  emit();
  return highlight;
}

export function removeHighlight(id: string): boolean {
  load();
  const before = state!.highlights.length;
  state!.highlights = state!.highlights.filter((h) => h.id !== id);
  if (state!.highlights.length !== before) {
    save();
    emit();
    return true;
  }
  return false;
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
