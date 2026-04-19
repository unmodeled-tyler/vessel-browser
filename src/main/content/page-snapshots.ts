import { app } from "electron";
import path from "path";
import {
  buildPageSnapshotKey,
  isTrackablePageUrl,
} from "../../shared/page-url";
import {
  createDebouncedJsonPersistence,
  loadJsonFile,
} from "../persistence/json-file";

export interface PageSnapshot {
  url: string;
  title: string;
  textContent: string;
  headings: string;
  capturedAt: string;
}

const SAVE_DEBOUNCE_MS = 500;
const MAX_SNAPSHOTS = 500;
const MAX_TEXT_LENGTH = 8000;

let snapshots: Map<string, PageSnapshot> | null = null;

function getFilePath(): string {
  return path.join(app.getPath("userData"), "vessel-page-snapshots.json");
}

function normalizeStoredSnapshot(value: unknown): PageSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.url !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.textContent !== "string" ||
    typeof raw.headings !== "string" ||
    typeof raw.capturedAt !== "string"
  ) {
    return null;
  }
  return {
    url: raw.url,
    title: raw.title,
    textContent: raw.textContent,
    headings: raw.headings,
    capturedAt: raw.capturedAt,
  };
}

function load(): Map<string, PageSnapshot> {
  if (snapshots) return snapshots;
  snapshots = loadJsonFile({
    filePath: getFilePath(),
    fallback: new Map<string, PageSnapshot>(),
    secure: true,
    parse: (raw) => {
      const next = new Map<string, PageSnapshot>();
      if (!Array.isArray(raw)) return next;
      for (const entry of raw) {
        const snapshot = normalizeStoredSnapshot(entry);
        if (snapshot) next.set(snapshot.url, snapshot);
      }
      return next;
    },
  });
  return snapshots;
}

const persistence = createDebouncedJsonPersistence({
  debounceMs: SAVE_DEBOUNCE_MS,
  filePath: getFilePath(),
  getValue: () => snapshots,
  logLabel: "page snapshots",
  secure: true,
  serialize: (value) => Array.from(value.values()).slice(-MAX_SNAPSHOTS),
});

export function normalizeUrl(rawUrl: string): string {
  return buildPageSnapshotKey(rawUrl);
}

export function shouldTrackSnapshotUrl(rawUrl: string): boolean {
  return isTrackablePageUrl(rawUrl);
}

export function getSnapshot(normalizedUrl: string): PageSnapshot | undefined {
  return load().get(normalizedUrl);
}

export function saveSnapshot(
  rawUrl: string,
  title: string,
  textContent: string,
  headings: Array<{ level: number; text: string }>,
): PageSnapshot {
  const s = load();
  const key = normalizeUrl(rawUrl);
  const snapshot: PageSnapshot = {
    url: key,
    title,
    textContent: textContent.slice(0, MAX_TEXT_LENGTH),
    headings: headings.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n"),
    capturedAt: new Date().toISOString(),
  };
  s.delete(key);
  s.set(key, snapshot);
  persistence.schedule();
  return snapshot;
}

export function flushPersist(): Promise<void> {
  return persistence.flush();
}
