import { app } from "electron";
import path from "path";
import { randomUUID } from "crypto";
import type {
  Bookmark,
  BookmarkFolder,
  BookmarksState,
} from "../../shared/types";
import {
  getBookmarkSearchMatch,
  type BookmarkSearchField,
} from "../../shared/bookmark-search";
import {
  createDebouncedJsonPersistence,
  loadJsonFile,
} from "../persistence/json-file";

export const UNSORTED_ID = "unsorted";
export const ARCHIVE_FOLDER_NAME = "Archive";

export interface BookmarkFolderOverview {
  id: string;
  name: string;
  summary?: string;
  count: number;
}

export type DuplicateBookmarkPolicy = "ask" | "update" | "duplicate";

export interface SaveBookmarkOptions {
  onDuplicate?: DuplicateBookmarkPolicy;
  /** Extra fields to set on the bookmark (intent, expectedContent, keyFields, agentHints, pageSchema) */
  extra?: Partial<Bookmark>;
}

export interface SaveBookmarkResult {
  status: "created" | "updated" | "conflict";
  bookmark?: Bookmark;
  existing?: Bookmark;
}

const SAVE_DEBOUNCE_MS = 250;

let state: BookmarksState | null = null;
const listeners = new Set<(state: BookmarksState) => void>();

function cloneState(current: BookmarksState): BookmarksState {
  return {
    folders: current.folders.map((folder) => ({ ...folder })),
    bookmarks: current.bookmarks.map((bookmark) => ({ ...bookmark })),
  };
}

function getBookmarksPath(): string {
  return path.join(app.getPath("userData"), "vessel-bookmarks.json");
}

function load(): BookmarksState {
  if (state) return state;
  state = loadJsonFile({
    filePath: getBookmarksPath(),
    fallback: { folders: [], bookmarks: [] },
    parse: (raw) => {
      const parsed = raw as Partial<BookmarksState>;
      return {
        folders: Array.isArray(parsed.folders) ? parsed.folders : [],
        bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
      };
    },
  });
  return state;
}

const persistence = createDebouncedJsonPersistence({
  debounceMs: SAVE_DEBOUNCE_MS,
  filePath: getBookmarksPath(),
  getValue: () => state,
  logLabel: "bookmarks",
});

function save(): void {
  persistence.schedule();
}

function emit(): void {
  if (!state) return;
  const snapshot = cloneState(state);
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function getState(): BookmarksState {
  return cloneState(load());
}

export function subscribe(
  listener: (state: BookmarksState) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearAll(): void {
  state = { folders: [], bookmarks: [] };
  save();
  emit();
}

export function getBookmark(id: string): Bookmark | null {
  load();
  const bookmark = state!.bookmarks.find((item) => item.id === id);
  return bookmark ? { ...bookmark } : null;
}

export function getBookmarkByUrl(url: string): Bookmark | null {
  load();
  const normalized = url.trim();
  if (!normalized) return null;
  const bookmark = [...state!.bookmarks]
    .reverse()
    .find((item) => item.url === normalized);
  return bookmark ? { ...bookmark } : null;
}

export function getBookmarkByUrlInFolder(
  url: string,
  folderId?: string,
): Bookmark | null {
  load();
  const normalizedUrl = url.trim();
  if (!normalizedUrl) return null;
  const targetFolderId =
    folderId && folderId !== UNSORTED_ID
      ? (state!.folders.find((f) => f.id === folderId)?.id ?? UNSORTED_ID)
      : UNSORTED_ID;

  const bookmark = [...state!.bookmarks]
    .reverse()
    .find(
      (item) => item.url === normalizedUrl && item.folderId === targetFolderId,
    );
  return bookmark ? { ...bookmark } : null;
}

export function getFolder(id: string): BookmarkFolder | null {
  load();
  if (!id || id === UNSORTED_ID) return null;
  const folder = state!.folders.find((item) => item.id === id);
  return folder ? { ...folder } : null;
}

export function findFolderByName(name: string): BookmarkFolder | null {
  load();
  const normalized = name.trim().toLowerCase();
  if (!normalized || normalized === "unsorted") return null;
  const folder = state!.folders.find(
    (item) => item.name.trim().toLowerCase() === normalized,
  );
  return folder ? { ...folder } : null;
}

export function listFolderOverviews(): BookmarkFolderOverview[] {
  load();
  const counts = new Map<string, number>();
  for (const bookmark of state!.bookmarks) {
    counts.set(bookmark.folderId, (counts.get(bookmark.folderId) ?? 0) + 1);
  }

  return [
    {
      id: UNSORTED_ID,
      name: "Unsorted",
      count: counts.get(UNSORTED_ID) ?? 0,
    },
    ...state!.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      summary: folder.summary,
      count: counts.get(folder.id) ?? 0,
    })),
  ];
}

export function searchBookmarks(query: string): Array<{
  bookmark: Bookmark;
  folder: BookmarkFolder | null;
  matchedFields: BookmarkSearchField[];
  score: number;
}> {
  load();
  if (!query.trim()) return [];

  return state!.bookmarks
    .map((bookmark) => {
      const folder = state!.folders.find(
        (item) => item.id === bookmark.folderId,
      );
      const { matchedFields, score } = getBookmarkSearchMatch({
        query,
        title: bookmark.title,
        url: bookmark.url,
        note: bookmark.note,
        folder: folder?.name,
        folderSummary: folder?.summary,
        intent: bookmark.intent,
        expectedContent: bookmark.expectedContent,
      });
      return {
        bookmark,
        folder: folder ?? null,
        matchedFields,
        score,
      };
    })
    .filter((result) => result.matchedFields.length > 0)
    .map((result) => ({
      bookmark: { ...result.bookmark },
      folder: result.folder ? { ...result.folder } : null,
      matchedFields: [...result.matchedFields],
      score: result.score,
    }))
    .sort(
      (a, b) =>
        b.score - a.score || b.bookmark.savedAt.localeCompare(a.bookmark.savedAt),
    );
}

export function createFolderWithSummary(
  name: string,
  summary?: string,
): BookmarkFolder {
  load();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Folder name cannot be empty");
  const folder: BookmarkFolder = {
    id: randomUUID(),
    name: trimmed,
    summary: summary?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  state!.folders.push(folder);
  save();
  emit();
  return folder;
}

export function ensureFolder(
  name: string,
  summary?: string,
): { folder: BookmarkFolder; created: boolean } {
  const existing = findFolderByName(name);
  if (existing) {
    return { folder: existing, created: false };
  }

  return {
    folder: createFolderWithSummary(name, summary),
    created: true,
  };
}

export function saveBookmark(
  url: string,
  title: string,
  folderId?: string,
  note?: string,
): Bookmark {
  const result = saveBookmarkWithPolicy(url, title, folderId, note, {
    onDuplicate: "update",
  });
  if (!result.bookmark) {
    throw new Error("Bookmark save failed");
  }
  return result.bookmark;
}

export function saveBookmarkWithPolicy(
  url: string,
  title: string,
  folderId?: string,
  note?: string,
  options?: SaveBookmarkOptions,
): SaveBookmarkResult {
  load();
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    throw new Error("Bookmark URL cannot be empty");
  }
  const normalizedTitle = title.trim() || normalizedUrl;
  const targetId =
    folderId && folderId !== UNSORTED_ID
      ? (state!.folders.find((f) => f.id === folderId)?.id ?? UNSORTED_ID)
      : UNSORTED_ID;
  const duplicatePolicy = options?.onDuplicate ?? "ask";
  const existing = getBookmarkByUrlInFolder(normalizedUrl, targetId);

  if (existing) {
    if (duplicatePolicy === "ask") {
      return {
        status: "conflict",
        existing,
      };
    }

    if (duplicatePolicy === "update") {
      const bookmark = state!.bookmarks.find((item) => item.id === existing.id);
      if (!bookmark) {
        return {
          status: "conflict",
          existing,
        };
      }

      bookmark.title = normalizedTitle;
      if (note !== undefined) {
        bookmark.note = note.trim() || undefined;
      }
      if (options?.extra) {
        Object.assign(bookmark, options.extra);
      }
      bookmark.savedAt = new Date().toISOString();
      save();
      emit();
      return {
        status: "updated",
        bookmark: { ...bookmark },
      };
    }
  }

  const bookmark: Bookmark = {
    id: randomUUID(),
    url: normalizedUrl,
    title: normalizedTitle,
    note: note?.trim() || undefined,
    folderId: targetId,
    savedAt: new Date().toISOString(),
    ...options?.extra,
  };
  state!.bookmarks.push(bookmark);
  save();
  emit();
  return {
    status: "created",
    bookmark,
  };
}

export function removeBookmark(id: string): boolean {
  load();
  const before = state!.bookmarks.length;
  state!.bookmarks = state!.bookmarks.filter((b) => b.id !== id);
  if (state!.bookmarks.length !== before) {
    save();
    emit();
    return true;
  }
  return false;
}

export function updateBookmark(
  id: string,
  updates: {
    title?: string;
    note?: string;
    folderId?: string;
    intent?: string;
    expectedContent?: string;
    keyFields?: string[];
    pageSchema?: import("../../shared/page-schema").PageSchema;
    agentHints?: Record<string, string>;
  },
): Bookmark | null {
  load();
  const bookmark = state!.bookmarks.find((item) => item.id === id);
  if (!bookmark) return null;

  if (typeof updates.title === "string") {
    const trimmed = updates.title.trim();
    bookmark.title = trimmed || bookmark.url;
  }

  if (typeof updates.note === "string") {
    const trimmed = updates.note.trim();
    bookmark.note = trimmed || undefined;
  }

  if (typeof updates.folderId === "string") {
    bookmark.folderId =
      updates.folderId && updates.folderId !== UNSORTED_ID
        ? (state!.folders.find((item) => item.id === updates.folderId)?.id ??
          UNSORTED_ID)
        : UNSORTED_ID;
  }

  if (typeof updates.intent === "string") {
    bookmark.intent = updates.intent.trim() || undefined;
  }

  if (typeof updates.expectedContent === "string") {
    bookmark.expectedContent = updates.expectedContent.trim() || undefined;
  }

  if (updates.keyFields !== undefined) {
    bookmark.keyFields = updates.keyFields;
  }

  if (updates.pageSchema !== undefined) {
    bookmark.pageSchema = updates.pageSchema;
  }

  if (updates.agentHints !== undefined) {
    bookmark.agentHints = updates.agentHints;
  }

  save();
  emit();
  return { ...bookmark };
}

export function removeFolder(id: string, deleteContents = false): boolean {
  load();
  const exists = state!.folders.some((f) => f.id === id);
  if (!exists) return false;
  if (deleteContents) {
    state!.bookmarks = state!.bookmarks.filter((b) => b.folderId !== id);
  } else {
    // Reassign orphaned bookmarks to unsorted
    state!.bookmarks = state!.bookmarks.map((b) =>
      b.folderId === id ? { ...b, folderId: UNSORTED_ID } : b,
    );
  }
  state!.folders = state!.folders.filter((f) => f.id !== id);
  save();
  emit();
  return true;
}

export function renameFolder(
  id: string,
  newName: string,
  summary?: string,
): BookmarkFolder | null {
  load();
  const folder = state!.folders.find((f) => f.id === id);
  if (!folder) return null;
  const trimmed = newName.trim();
  if (!trimmed) return null;
  folder.name = trimmed;
  folder.summary = summary?.trim() || undefined;
  save();
  emit();
  return { ...folder };
}

export function flushPersist(): Promise<void> {
  return persistence.flush();
}
