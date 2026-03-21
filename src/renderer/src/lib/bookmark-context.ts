import type {
  AIMessage,
  Bookmark,
  BookmarkFolder,
} from "../../../shared/types";

const MEMORY_STORAGE_KEY = "vessel.bookmark-context.memories";
const MAX_MEMORY_LINES = 4;
const MAX_MEMORY_CHARS = 420;

export interface BookmarkMemoryEntry {
  summary: string;
  title: string;
  url: string;
  updatedAt: string;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanSnippet(value: string, maxLength = 140): string {
  const cleaned = collapseWhitespace(
    value.replace(/`+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"),
  );
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}...`;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value.trim());
  }
  return result;
}

export function bookmarkMemoryKey(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function tokenize(value: string): string[] {
  return dedupe(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 4)
      .slice(0, 8),
  );
}

export function collectBookmarkConversationCues(
  bookmark: Bookmark,
  messages: AIMessage[],
): string[] {
  const host = bookmarkMemoryKey(bookmark.url);
  const hostTokens = dedupe(
    host.split(".").filter((token) => token.length >= 4),
  );
  const titleTokens = tokenize(bookmark.title);
  const noteTokens = tokenize(bookmark.note || "").slice(0, 4);
  const urlLower = bookmark.url.toLowerCase();
  const cues: string[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const content = collapseWhitespace(message.content);
    if (!content) continue;
    const lowered = content.toLowerCase();
    const matchedTokens = [...titleTokens, ...noteTokens].filter((token) =>
      lowered.includes(token),
    );
    const matchesBookmark =
      lowered.includes(host) ||
      hostTokens.some((token) => lowered.includes(token)) ||
      lowered.includes(urlLower) ||
      matchedTokens.length >= 2 ||
      (matchedTokens.length >= 1 && titleTokens.length <= 1);

    if (!matchesBookmark) continue;

    const prefix = message.role === "user" ? "You" : "Assistant";
    cues.push(`${prefix}: ${cleanSnippet(content)}`);
    if (cues.length >= MAX_MEMORY_LINES) break;
  }

  return dedupe(cues);
}

export function mergeBookmarkMemorySummary(
  existingSummary: string | undefined,
  cues: string[],
): string | undefined {
  const merged = dedupe([
    ...(existingSummary
      ? existingSummary.split(" • ").map((item) => cleanSnippet(item, 160))
      : []),
    ...cues,
  ]).slice(0, MAX_MEMORY_LINES);

  if (merged.length === 0) return undefined;

  let summary = merged.join(" • ");
  if (summary.length > MAX_MEMORY_CHARS) {
    summary = `${summary.slice(0, MAX_MEMORY_CHARS - 3).trimEnd()}...`;
  }
  return summary;
}

function getStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

function readMemoryMap(
  storage?: StorageLike | null,
): Record<string, BookmarkMemoryEntry> {
  const target = getStorage(storage);
  if (!target) return {};

  try {
    const raw = target.getItem(MEMORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, BookmarkMemoryEntry>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeMemoryMap(
  map: Record<string, BookmarkMemoryEntry>,
  storage?: StorageLike | null,
): void {
  const target = getStorage(storage);
  if (!target) return;

  try {
    target.setItem(MEMORY_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort persistence only.
  }
}

export function getBookmarkMemory(
  url: string,
  storage?: StorageLike | null,
): BookmarkMemoryEntry | null {
  const map = readMemoryMap(storage);
  return map[bookmarkMemoryKey(url)] ?? null;
}

export function rememberBookmarkContext(args: {
  bookmark: Bookmark;
  messages: AIMessage[];
  storage?: StorageLike | null;
}): BookmarkMemoryEntry | null {
  const key = bookmarkMemoryKey(args.bookmark.url);
  const map = readMemoryMap(args.storage);
  const existing = map[key];
  const cues = collectBookmarkConversationCues(args.bookmark, args.messages);
  const summary = mergeBookmarkMemorySummary(existing?.summary, cues);

  if (!summary) {
    return existing ?? null;
  }

  const entry: BookmarkMemoryEntry = {
    summary,
    title: args.bookmark.title || args.bookmark.url,
    url: args.bookmark.url,
    updatedAt: new Date().toISOString(),
  };
  map[key] = entry;
  writeMemoryMap(map, args.storage);
  return entry;
}

export function buildBookmarkContextDraft(args: {
  bookmark: Bookmark;
  folder?: Pick<BookmarkFolder, "name" | "summary"> | null;
  rememberedSummary?: string | null;
}): string {
  const lines = [
    "Saved bookmark context for the next step:",
    `- Title: ${args.bookmark.title || args.bookmark.url}`,
    `- URL: ${args.bookmark.url}`,
  ];

  if (args.folder?.name) {
    lines.push(`- Folder: ${args.folder.name}`);
  }
  if (args.folder?.summary) {
    lines.push(`- Folder summary: ${cleanSnippet(args.folder.summary, 180)}`);
  }
  if (args.bookmark.note) {
    lines.push(`- Saved note: ${cleanSnippet(args.bookmark.note, 180)}`);
  }
  if (args.rememberedSummary) {
    lines.push(`- Remembered site context: ${args.rememberedSummary}`);
  }

  return lines.join("\n");
}

export function buildAndRememberBookmarkContext(args: {
  bookmark: Bookmark;
  folder?: Pick<BookmarkFolder, "name" | "summary"> | null;
  messages: AIMessage[];
  storage?: StorageLike | null;
}): string {
  const remembered = rememberBookmarkContext({
    bookmark: args.bookmark,
    messages: args.messages,
    storage: args.storage,
  });

  return buildBookmarkContextDraft({
    bookmark: args.bookmark,
    folder: args.folder,
    rememberedSummary: remembered?.summary ?? null,
  });
}
