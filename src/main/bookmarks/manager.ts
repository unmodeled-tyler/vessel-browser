import { app } from "electron";
import path from "path";
import { randomUUID } from "crypto";
import type {
  Bookmark,
  BookmarkHtmlExportOptions,
  BookmarkFolder,
  BookmarksState,
  ImportResult,
} from "../../shared/types";
import {
  getBookmarkSearchMatch,
  type BookmarkSearchField,
} from "../../shared/bookmark-search";
import {
  createDebouncedJsonPersistence,
  loadJsonFile,
} from "../persistence/json-file";
import { normalizeBookmarkMetadataUpdate } from "./metadata";

export const UNSORTED_ID = "unsorted";
export const ARCHIVE_FOLDER_NAME = "Archive";

const NETSCAPE_BOOKMARKS_DOCTYPE = "<!DOCTYPE NETSCAPE-Bookmark-file-1>";

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

function createPersistence() {
  return createDebouncedJsonPersistence({
    debounceMs: SAVE_DEBOUNCE_MS,
    filePath: getBookmarksPath(),
    getValue: () => state,
    logLabel: "bookmarks",
  });
}

let persistence: ReturnType<typeof createPersistence> | null = null;

function getPersistence(): ReturnType<typeof createPersistence> {
  persistence ??= createPersistence();
  return persistence;
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

function save(): void {
  getPersistence().schedule();
}

function assignDefinedBookmarkFields(
  bookmark: Bookmark,
  fields: Partial<Bookmark> | undefined,
): void {
  if (!fields) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    Object.assign(bookmark, { [key]: value });
  }
}

function emit(): void {
  if (!state) return;
  const snapshot = cloneState(state);
  for (const listener of listeners) {
    listener(snapshot);
  }
}

function escapeBookmarkHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toNetscapeTimestamp(value?: string): number {
  if (!value) return Math.floor(Date.now() / 1000);
  const time = Date.parse(value);
  return Number.isNaN(time) ? Math.floor(Date.now() / 1000) : Math.floor(time / 1000);
}

function getBookmarkDescription(bookmark: Bookmark): string {
  const lines = [
    bookmark.note ? `Note: ${bookmark.note}` : "",
    bookmark.intent ? `Intent: ${bookmark.intent}` : "",
    bookmark.expectedContent
      ? `Expected content: ${bookmark.expectedContent}`
      : "",
    bookmark.keyFields?.length
      ? `Key fields: ${bookmark.keyFields.join(", ")}`
      : "",
    bookmark.agentHints && Object.keys(bookmark.agentHints).length > 0
      ? `Agent hints: ${Object.entries(bookmark.agentHints)
          .map(([key, value]) => `${key}: ${value}`)
          .join("; ")}`
      : "",
  ].filter(Boolean);

  return lines.join("\n");
}

function appendBookmarkHtml(
  lines: string[],
  bookmark: Bookmark,
  options: Required<BookmarkHtmlExportOptions>,
  indent: string,
): void {
  const addDate = toNetscapeTimestamp(bookmark.savedAt);
  lines.push(
    `${indent}<DT><A HREF="${escapeBookmarkHtml(bookmark.url)}" ADD_DATE="${addDate}">${escapeBookmarkHtml(bookmark.title || bookmark.url)}</A>`,
  );

  if (!options.includeNotes) return;
  const description = getBookmarkDescription(bookmark);
  if (description) {
    lines.push(`${indent}<DD>${escapeBookmarkHtml(description)}`);
  }
}

export function getState(): BookmarksState {
  return cloneState(load());
}

export function exportBookmarksHtml(
  options: BookmarkHtmlExportOptions = {},
): string {
  const current = getState();
  const resolvedOptions: Required<BookmarkHtmlExportOptions> = {
    includeNotes: options.includeNotes ?? false,
  };
  const now = Math.floor(Date.now() / 1000);
  const folders = [
    { id: UNSORTED_ID, name: "Vessel Bookmarks", createdAt: "", summary: "" },
    ...current.folders,
  ];

  const lines = [
    NETSCAPE_BOOKMARKS_DOCTYPE,
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];

  for (const folder of folders) {
    const items = current.bookmarks.filter(
      (bookmark) => bookmark.folderId === folder.id,
    );
    if (items.length === 0) continue;

    const addDate = toNetscapeTimestamp(folder.createdAt) || now;
    lines.push(
      `    <DT><H3 ADD_DATE="${addDate}" LAST_MODIFIED="${now}">${escapeBookmarkHtml(folder.name)}</H3>`,
    );
    if (resolvedOptions.includeNotes && folder.summary) {
      lines.push(`    <DD>${escapeBookmarkHtml(folder.summary)}`);
    }
    lines.push("    <DL><p>");
    for (const bookmark of items) {
      appendBookmarkHtml(lines, bookmark, resolvedOptions, "        ");
    }
    lines.push("    </DL><p>");
  }

  lines.push("</DL><p>");
  return `${lines.join("\n")}\n`;
}

export function exportBookmarkFolderHtml(
  folderId: string,
  options: BookmarkHtmlExportOptions = {},
): { content: string; count: number; folderName: string } | null {
  const current = getState();
  const folder = current.folders.find((item) => item.id === folderId);
  if (!folder) return null;

  const resolvedOptions: Required<BookmarkHtmlExportOptions> = {
    includeNotes: options.includeNotes ?? false,
  };
  const now = Math.floor(Date.now() / 1000);
  const items = current.bookmarks.filter(
    (bookmark) => bookmark.folderId === folder.id,
  );
  const addDate = toNetscapeTimestamp(folder.createdAt) || now;
  const lines = [
    NETSCAPE_BOOKMARKS_DOCTYPE,
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${escapeBookmarkHtml(folder.name)}</TITLE>`,
    `<H1>${escapeBookmarkHtml(folder.name)}</H1>`,
    "<DL><p>",
    `    <DT><H3 ADD_DATE="${addDate}" LAST_MODIFIED="${now}">${escapeBookmarkHtml(folder.name)}</H3>`,
  ];

  if (resolvedOptions.includeNotes && folder.summary) {
    lines.push(`    <DD>${escapeBookmarkHtml(folder.summary)}`);
  }
  lines.push("    <DL><p>");
  for (const bookmark of items) {
    appendBookmarkHtml(lines, bookmark, resolvedOptions, "        ");
  }
  lines.push("    </DL><p>", "</DL><p>");

  return {
    content: `${lines.join("\n")}\n`,
    count: items.length,
    folderName: folder.name,
  };
}

export function exportBookmarksJson(): string {
  return `${JSON.stringify(getState(), null, 2)}\n`;
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
      assignDefinedBookmarkFields(bookmark, options?.extra);
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
  const metadataUpdates = normalizeBookmarkMetadataUpdate({
    intent: updates.intent,
    expectedContent: updates.expectedContent,
    keyFields: updates.keyFields,
    agentHints: updates.agentHints,
  });

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

  if ("intent" in metadataUpdates) {
    bookmark.intent = metadataUpdates.intent;
  }

  if ("expectedContent" in metadataUpdates) {
    bookmark.expectedContent = metadataUpdates.expectedContent;
  }

  if ("keyFields" in metadataUpdates) {
    bookmark.keyFields = metadataUpdates.keyFields;
  }

  if (updates.pageSchema !== undefined) {
    bookmark.pageSchema = updates.pageSchema;
  }

  if ("agentHints" in metadataUpdates) {
    bookmark.agentHints = metadataUpdates.agentHints;
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
  return getPersistence().flush();
}

export function importBookmarksFromHtml(content: string): ImportResult {
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  load();

  const existingUrls = new Set(state!.bookmarks.map((b) => b.url));
  let currentFolderId = UNSORTED_ID;
  let currentFolderName = "Imported";

  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const folderMatch = line.match(/<DT><H3[^>]*>([^<]+)<\/H3>/i);
    if (folderMatch) {
      currentFolderName = folderMatch[1].trim();
      const existing = state!.folders.find(
        (f) => f.name.toLowerCase() === currentFolderName.toLowerCase(),
      );
      if (existing) {
        currentFolderId = existing.id;
      } else {
        const folder: BookmarkFolder = {
          id: randomUUID(),
          name: currentFolderName,
          createdAt: new Date().toISOString(),
        };
        state!.folders.push(folder);
        currentFolderId = folder.id;
      }
      continue;
    }

    if (line.match(/<\/DL>/i)) {
      currentFolderId = UNSORTED_ID;
      currentFolderName = "Imported";
      continue;
    }

    const bookmarkMatch = line.match(
      /<DT><A\s+[^>]*HREF="([^"]+)"[^>]*>([^<]*)<\/A>/i,
    );
    if (bookmarkMatch) {
      const url = bookmarkMatch[1].trim();
      const title = bookmarkMatch[2].trim() || url;
      if (!url || existingUrls.has(url)) {
        if (url) skipped++;
        else errors++;
        continue;
      }
      state!.bookmarks.push({
        id: randomUUID(),
        url,
        title,
        folderId: currentFolderId,
        savedAt: new Date().toISOString(),
      });
      existingUrls.add(url);
      imported++;
    }
  }

  if (imported > 0) {
    save();
    emit();
  }
  return { imported, skipped, errors };
}

export function importBookmarksFromJson(content: string): ImportResult {
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  try {
    const parsed = JSON.parse(content) as Partial<BookmarksState>;
    const incomingFolders = Array.isArray(parsed?.folders)
      ? parsed.folders
      : [];
    const incomingBookmarks = Array.isArray(parsed?.bookmarks)
      ? parsed.bookmarks
      : [];

    load();
    const existingUrls = new Set(state!.bookmarks.map((b) => b.url));
    const folderIdMap = new Map<string, string>();

    for (const folder of incomingFolders) {
      if (!folder?.id || !folder?.name) {
        errors++;
        continue;
      }
      const existing = state!.folders.find(
        (f) => f.name.toLowerCase() === folder.name.toLowerCase(),
      );
      if (existing) {
        folderIdMap.set(folder.id, existing.id);
      } else {
        const newFolder: BookmarkFolder = {
          id: randomUUID(),
          name: folder.name.trim(),
          summary: folder.summary?.trim() || undefined,
          createdAt: folder.createdAt || new Date().toISOString(),
        };
        state!.folders.push(newFolder);
        folderIdMap.set(folder.id, newFolder.id);
      }
    }

    for (const bookmark of incomingBookmarks) {
      if (!bookmark?.url || typeof bookmark.url !== "string") {
        errors++;
        continue;
      }
      if (existingUrls.has(bookmark.url)) {
        skipped++;
        continue;
      }
      const mappedFolderId = bookmark.folderId
        ? folderIdMap.get(bookmark.folderId) ?? UNSORTED_ID
        : UNSORTED_ID;
      state!.bookmarks.push({
        id: randomUUID(),
        url: bookmark.url.trim(),
        title: typeof bookmark.title === "string" ? bookmark.title.trim() : bookmark.url,
        note: bookmark.note?.trim() || undefined,
        folderId: mappedFolderId,
        savedAt: bookmark.savedAt || new Date().toISOString(),
      });
      existingUrls.add(bookmark.url);
      imported++;
    }

    if (imported > 0 || errors > 0) {
      save();
      emit();
    }
  } catch {
    errors++;
  }
  return { imported, skipped, errors };
}
