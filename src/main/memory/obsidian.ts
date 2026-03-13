import fs from "node:fs";
import path from "node:path";
import type { Bookmark, PageContent } from "../../shared/types";
import { loadSettings } from "../config/settings";

const DEFAULT_PAGE_FOLDER = "Vessel/Pages";
const DEFAULT_NOTE_FOLDER = "Vessel/Research";
const DEFAULT_BOOKMARK_FOLDER = "Vessel/Bookmarks";
const PAGE_CONTENT_LIMIT = 6000;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;

export interface SavedMemoryNote {
  title: string;
  absolutePath: string;
  relativePath: string;
}

export interface MemoryNoteSummary extends SavedMemoryNote {
  modifiedAt: string;
  tags: string[];
}

interface WriteMemoryNoteInput {
  title: string;
  body: string;
  folder?: string;
  tags?: string[];
  frontmatter?: Record<string, string | string[] | undefined>;
}

interface CapturePageNoteInput {
  page: PageContent;
  title?: string;
  folder?: string;
  summary?: string;
  note?: string;
  tags?: string[];
}

interface ListMemoryNotesInput {
  folder?: string;
  limit?: number;
}

interface SearchMemoryNotesInput {
  query: string;
  folder?: string;
  tags?: string[];
  limit?: number;
}

interface AppendMemoryNoteInput {
  notePath: string;
  content: string;
  heading?: string;
}

interface LinkBookmarkToMemoryInput {
  bookmark: Bookmark;
  notePath?: string;
  title?: string;
  folder?: string;
  note?: string;
  tags?: string[];
}

function getVaultRoot(): string {
  const configured = loadSettings().obsidianVaultPath.trim();
  if (!configured) {
    throw new Error(
      "Obsidian not configured. Set vault path in Vessel settings to use memory capture.",
    );
  }
  return path.resolve(configured);
}

function assertInsideVault(targetPath: string, vaultRoot: string): string {
  const resolved = path.resolve(targetPath);
  const relative = path.relative(vaultRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Resolved note path is outside the configured vault.");
  }
  return resolved;
}

function normalizeFolder(folder: string | undefined, fallback: string): string {
  const raw = (folder?.trim() || fallback).replace(/\\/g, "/");
  if (!raw) return fallback;
  if (path.isAbsolute(raw)) {
    throw new Error("Vault note folders must be relative to the vault root.");
  }
  const segments = raw.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Vault note folders cannot traverse outside the vault.");
  }
  return segments.join(path.sep);
}

function normalizeNotePath(notePath: string): string {
  const raw = notePath.trim().replace(/\\/g, "/");
  if (!raw) {
    throw new Error("A note path is required.");
  }
  if (path.isAbsolute(raw)) {
    throw new Error("Note paths must be relative to the vault root.");
  }
  const segments = raw.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Note paths cannot traverse outside the vault.");
  }
  const normalized = segments.join(path.sep);
  return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
}

function escapeYaml(value: string): string {
  return JSON.stringify(value);
}

function renderFrontmatter(
  data: Record<string, string | string[] | undefined>,
): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${escapeYaml(item)}`);
      }
      continue;
    }
    lines.push(`${key}: ${escapeYaml(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "note";
}

function buildUniqueNotePath(dir: string, title: string): string {
  const datePrefix = new Date().toISOString().slice(0, 10);
  const slug = slugify(title);
  const base = `${datePrefix}-${slug}`;
  let candidate = `${base}.md`;
  let counter = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${counter}.md`;
    counter += 1;
  }
  return path.join(dir, candidate);
}

function trimContent(content: string, limit = PAGE_CONTENT_LIMIT): string {
  const cleaned = content.trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit)}\n\n[Truncated]`;
}

function parseFrontmatter(content: string): {
  body: string;
  title?: string;
  tags: string[];
} {
  if (!content.startsWith("---\n")) {
    return { body: content, tags: [] };
  }

  const closingIndex = content.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    return { body: content, tags: [] };
  }

  const raw = content.slice(4, closingIndex);
  const body = content.slice(closingIndex + 5);
  const lines = raw.split("\n");
  const result: { title?: string; tags: string[] } = { tags: [] };
  let activeArrayKey = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("- ") && activeArrayKey === "tags") {
      result.tags.push(
        trimmed
          .slice(2)
          .trim()
          .replace(/^["']|["']$/g, ""),
      );
      continue;
    }

    activeArrayKey = "";
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key === "title" && value) {
      result.title = value.replace(/^["']|["']$/g, "");
    } else if (key === "tags") {
      activeArrayKey = "tags";
      if (value.startsWith("[") && value.endsWith("]")) {
        const inline = value
          .slice(1, -1)
          .split(",")
          .map((item) => item.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        result.tags.push(...inline);
        activeArrayKey = "";
      }
    }
  }

  return { body, title: result.title, tags: result.tags };
}

function collectMarkdownFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(absolutePath);
    }
  }

  return files;
}

function toSummary(absolutePath: string, vaultRoot: string): MemoryNoteSummary {
  const stats = fs.statSync(absolutePath);
  const relativePath = path
    .relative(vaultRoot, absolutePath)
    .split(path.sep)
    .join("/");
  const raw = fs.readFileSync(absolutePath, "utf-8");
  const parsed = parseFrontmatter(raw);
  const headingMatch = parsed.body.match(/^#\s+(.+)$/m);
  const title =
    parsed.title ||
    headingMatch?.[1]?.trim() ||
    path.basename(absolutePath, ".md");

  return {
    title,
    absolutePath,
    relativePath,
    modifiedAt: stats.mtime.toISOString(),
    tags: parsed.tags,
  };
}

function renderBookmarkLinkBlock(bookmark: Bookmark, note?: string): string {
  const lines = [
    "## Linked Bookmark",
    "",
    `- Bookmark ID: \`${bookmark.id}\``,
    `- Title: ${bookmark.title || bookmark.url}`,
    `- URL: [${bookmark.url}](${bookmark.url})`,
    `- Saved At: ${bookmark.savedAt}`,
  ];

  if (note?.trim()) {
    lines.push("", "### Context", "", note.trim());
  }

  return `${lines.join("\n")}\n`;
}

export function writeMemoryNote({
  title,
  body,
  folder,
  tags = [],
  frontmatter = {},
}: WriteMemoryNoteInput): SavedMemoryNote {
  const vaultRoot = getVaultRoot();
  const relativeFolder = normalizeFolder(folder, DEFAULT_NOTE_FOLDER);
  const targetDir = path.join(vaultRoot, relativeFolder);
  fs.mkdirSync(targetDir, { recursive: true });

  const absolutePath = buildUniqueNotePath(targetDir, title);
  const relativePath = path.relative(vaultRoot, absolutePath);
  const content = [
    renderFrontmatter({
      title,
      created_at: new Date().toISOString(),
      tags,
      ...frontmatter,
    }),
    body.trim(),
    "",
  ].join("\n");

  fs.writeFileSync(absolutePath, content, "utf-8");

  return {
    title,
    absolutePath,
    relativePath: relativePath.split(path.sep).join("/"),
  };
}

export function appendToMemoryNote({
  notePath,
  content,
  heading,
}: AppendMemoryNoteInput): SavedMemoryNote {
  const vaultRoot = getVaultRoot();
  const relativePath = normalizeNotePath(notePath);
  const absolutePath = assertInsideVault(
    path.join(vaultRoot, relativePath),
    vaultRoot,
  );
  if (!fs.existsSync(absolutePath)) {
    throw new Error(
      `Memory note not found: ${relativePath.split(path.sep).join("/")}`,
    );
  }

  const current = fs.readFileSync(absolutePath, "utf-8").trimEnd();
  const nextParts = [current, ""];
  if (heading?.trim()) {
    nextParts.push(`## ${heading.trim()}`, "");
  }
  nextParts.push(content.trim(), "");
  fs.writeFileSync(absolutePath, nextParts.join("\n"), "utf-8");

  return {
    title: path.basename(absolutePath, ".md"),
    absolutePath,
    relativePath: relativePath.split(path.sep).join("/"),
  };
}

export function listMemoryNotes({
  folder,
  limit = DEFAULT_LIST_LIMIT,
}: ListMemoryNotesInput = {}): MemoryNoteSummary[] {
  const vaultRoot = getVaultRoot();
  const relativeFolder = normalizeFolder(folder, "");
  const targetDir = relativeFolder
    ? path.join(vaultRoot, relativeFolder)
    : vaultRoot;

  if (!fs.existsSync(targetDir)) {
    return [];
  }

  return collectMarkdownFiles(targetDir)
    .map((absolutePath) => toSummary(absolutePath, vaultRoot))
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, Math.max(1, limit));
}

export function searchMemoryNotes({
  query,
  folder,
  tags = [],
  limit = DEFAULT_SEARCH_LIMIT,
}: SearchMemoryNotesInput): MemoryNoteSummary[] {
  const loweredQuery = query.trim().toLowerCase();
  if (!loweredQuery) {
    throw new Error("A non-empty memory search query is required.");
  }

  const vaultRoot = getVaultRoot();
  const relativeFolder = normalizeFolder(folder, "");
  const targetDir = relativeFolder
    ? path.join(vaultRoot, relativeFolder)
    : vaultRoot;

  if (!fs.existsSync(targetDir)) {
    return [];
  }

  const loweredTags = tags
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  return collectMarkdownFiles(targetDir)
    .map((absolutePath) => {
      const raw = fs.readFileSync(absolutePath, "utf-8");
      const parsed = parseFrontmatter(raw);
      const summary = toSummary(absolutePath, vaultRoot);
      const haystack =
        `${summary.title}\n${summary.relativePath}\n${parsed.body}`.toLowerCase();
      const hasQuery = haystack.includes(loweredQuery);
      const hasTags =
        loweredTags.length === 0 ||
        loweredTags.every((tag) =>
          summary.tags.some((noteTag) => noteTag.toLowerCase() === tag),
        );

      return hasQuery && hasTags ? summary : null;
    })
    .filter((item): item is MemoryNoteSummary => item !== null)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, Math.max(1, limit));
}

export function capturePageToVault({
  page,
  title,
  folder,
  summary,
  note,
  tags = [],
}: CapturePageNoteInput): SavedMemoryNote {
  const noteTitle = title?.trim() || page.title.trim() || page.url;
  const bodyLines = [
    `# ${noteTitle}`,
    "",
    `Source: [${page.title || page.url}](${page.url})`,
    `Captured: ${new Date().toISOString()}`,
  ];

  if (page.byline) {
    bodyLines.push(`Byline: ${page.byline}`);
  }

  bodyLines.push("");

  if (summary?.trim()) {
    bodyLines.push("## Summary", "", summary.trim(), "");
  }

  if (note?.trim()) {
    bodyLines.push("## Research Note", "", note.trim(), "");
  }

  if (page.excerpt.trim()) {
    bodyLines.push("## Excerpt", "", page.excerpt.trim(), "");
  }

  const snapshot = trimContent(page.content);
  if (snapshot) {
    bodyLines.push("## Page Snapshot", "", snapshot, "");
  }

  return writeMemoryNote({
    title: noteTitle,
    body: bodyLines.join("\n"),
    folder: folder || DEFAULT_PAGE_FOLDER,
    tags,
    frontmatter: {
      source_url: page.url,
      source_title: page.title || page.url,
    },
  });
}

export function linkBookmarkToMemory({
  bookmark,
  notePath,
  title,
  folder,
  note,
  tags = [],
}: LinkBookmarkToMemoryInput): SavedMemoryNote {
  if (notePath?.trim()) {
    return appendToMemoryNote({
      notePath,
      heading: "Linked Bookmark",
      content: [
        `- Bookmark ID: \`${bookmark.id}\``,
        `- Title: ${bookmark.title || bookmark.url}`,
        `- URL: [${bookmark.url}](${bookmark.url})`,
        `- Saved At: ${bookmark.savedAt}`,
        note?.trim() ? `- Note: ${note.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  const noteTitle = title?.trim() || bookmark.title || bookmark.url;
  return writeMemoryNote({
    title: noteTitle,
    body: renderBookmarkLinkBlock(bookmark, note),
    folder: folder || DEFAULT_BOOKMARK_FOLDER,
    tags,
    frontmatter: {
      bookmark_id: bookmark.id,
      source_url: bookmark.url,
      source_title: bookmark.title || bookmark.url,
    },
  });
}
