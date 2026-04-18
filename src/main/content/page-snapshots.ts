import { app, safeStorage } from "electron";
import path from "path";
import fs from "fs";

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
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveDirty = false;

function getFilePath(): string {
  return path.join(app.getPath("userData"), "vessel-page-snapshots.json");
}

function canUseSafeStorage(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
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
  snapshots = new Map();
  try {
    const raw = fs.readFileSync(getFilePath());
    const decoded =
      canUseSafeStorage() && safeStorage.decryptString
        ? safeStorage.decryptString(raw)
        : raw.toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const snapshot = normalizeStoredSnapshot(entry);
        if (snapshot) snapshots.set(snapshot.url, snapshot);
      }
    }
  } catch {
    // first run
  }
  return snapshots;
}

function persistNow(): Promise<void> {
  saveDirty = false;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!snapshots) return Promise.resolve();
  const arr = Array.from(snapshots.values()).slice(-MAX_SNAPSHOTS);
  const payload = JSON.stringify(arr, null, 2);
  const data =
    canUseSafeStorage() && safeStorage.encryptString
      ? safeStorage.encryptString(payload)
      : payload;
  return fs.promises
    .mkdir(path.dirname(getFilePath()), { recursive: true })
    .then(() =>
      fs.promises.writeFile(getFilePath(), data, typeof data === "string" ? { encoding: "utf-8", mode: 0o600 } : { mode: 0o600 }),
    )
    .catch((err) => console.error("[Vessel] Failed to save page snapshots:", err));
}

function scheduleSave(): void {
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (saveDirty) void persistNow();
  }, SAVE_DEBOUNCE_MS);
}

export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`.toLowerCase();
  } catch {
    return rawUrl.trim().replace(/\/+$/, "").toLowerCase();
  }
}

export function shouldTrackSnapshotUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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
  scheduleSave();
  return snapshot;
}

export function flushPersist(): Promise<void> {
  return saveDirty ? persistNow() : Promise.resolve();
}
