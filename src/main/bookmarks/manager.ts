import { app } from "electron";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import type {
  Bookmark,
  BookmarkFolder,
  BookmarksState,
} from "../../shared/types";

const UNSORTED_ID = "unsorted";

let state: BookmarksState | null = null;

function getBookmarksPath(): string {
  return path.join(app.getPath("userData"), "vessel-bookmarks.json");
}

function load(): BookmarksState {
  if (state) return state;
  try {
    const raw = fs.readFileSync(getBookmarksPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<BookmarksState>;
    state = {
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
    };
  } catch {
    state = { folders: [], bookmarks: [] };
  }
  return state;
}

function save(): void {
  fs.writeFileSync(getBookmarksPath(), JSON.stringify(state, null, 2), "utf-8");
}

export function getState(): BookmarksState {
  return load();
}

export function createFolder(name: string): BookmarkFolder {
  load();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Folder name cannot be empty");
  const folder: BookmarkFolder = {
    id: randomUUID(),
    name: trimmed,
    createdAt: new Date().toISOString(),
  };
  state!.folders.push(folder);
  save();
  return folder;
}

export function saveBookmark(
  url: string,
  title: string,
  folderId?: string,
  note?: string,
): Bookmark {
  load();
  const targetId =
    folderId && folderId !== UNSORTED_ID
      ? (state!.folders.find((f) => f.id === folderId)?.id ?? UNSORTED_ID)
      : UNSORTED_ID;

  const bookmark: Bookmark = {
    id: randomUUID(),
    url,
    title: title.trim(),
    note: note?.trim() || undefined,
    folderId: targetId,
    savedAt: new Date().toISOString(),
  };
  state!.bookmarks.push(bookmark);
  save();
  return bookmark;
}

export function removeBookmark(id: string): boolean {
  load();
  const before = state!.bookmarks.length;
  state!.bookmarks = state!.bookmarks.filter((b) => b.id !== id);
  if (state!.bookmarks.length !== before) {
    save();
    return true;
  }
  return false;
}

export function removeFolder(id: string): boolean {
  load();
  const exists = state!.folders.some((f) => f.id === id);
  if (!exists) return false;
  // Reassign orphaned bookmarks to unsorted
  state!.bookmarks = state!.bookmarks.map((b) =>
    b.folderId === id ? { ...b, folderId: UNSORTED_ID } : b,
  );
  state!.folders = state!.folders.filter((f) => f.id !== id);
  save();
  return true;
}

export function renameFolder(
  id: string,
  newName: string,
): BookmarkFolder | null {
  load();
  const folder = state!.folders.find((f) => f.id === id);
  if (!folder) return null;
  const trimmed = newName.trim();
  if (!trimmed) return null;
  folder.name = trimmed;
  save();
  return { ...folder };
}
