import { dialog, ipcMain } from "electron";
import { promises as fs } from "fs";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import * as bookmarkManager from "../bookmarks/manager";
import { normalizeBookmarkMetadata } from "../bookmarks/metadata";
import { trackBookmarkAction } from "../telemetry/posthog";
import { assertTrustedIpcSender, parseIpc } from "./common";

// --- Zod schemas for IPC validation ---

const FolderNameSchema = z.string().min(1);
const BookmarkUrlSchema = z.string().min(1);
const BookmarkIdSchema = z.string().min(1);
const OptionalStringSchema = z.string().optional();
const OptionalStringArraySchema = z.array(z.string()).optional();
const OptionalRecordSchema = z.record(z.string(), z.string()).optional();
const OptionalBooleanSchema = z.boolean().optional();

const BookmarkUpdateSchema = z.object({
  title: z.string().optional(),
  note: z.string().optional(),
  folderId: z.string().optional(),
  intent: z.string().optional(),
  expectedContent: z.string().optional(),
  keyFields: z.array(z.string()).optional(),
  agentHints: z.record(z.string(), z.string()).optional(),
});

const ExportOptionsSchema = z.object({
  includeNotes: z.boolean().optional(),
}).optional();

function getSafeBookmarkExportName(name: string): string {
  const safeName = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safeName || "folder";
}

export function registerBookmarkHandlers(): void {
  ipcMain.handle(Channels.BOOKMARKS_GET, (event) => {
    assertTrustedIpcSender(event);
    return bookmarkManager.getState();
  });

  ipcMain.handle(
    Channels.FOLDER_CREATE,
    (event, name: unknown, summary?: unknown) => {
      assertTrustedIpcSender(event);
      const validatedName = parseIpc(FolderNameSchema, name, "name");
      const validatedSummary = parseIpc(OptionalStringSchema, summary, "summary");
      trackBookmarkAction("folder_create");
      return bookmarkManager.createFolderWithSummary(validatedName, validatedSummary);
    },
  );

  ipcMain.handle(
    Channels.BOOKMARK_SAVE,
    (
      event,
      url: unknown,
      title: unknown,
      folderId?: unknown,
      note?: unknown,
      intent?: unknown,
      expectedContent?: unknown,
      keyFields?: unknown,
      agentHints?: unknown,
    ) => {
      assertTrustedIpcSender(event);
      const validatedUrl = parseIpc(BookmarkUrlSchema, url, "url");
      const validatedTitle = parseIpc(z.string(), title, "title");
      const validatedFolderId = parseIpc(OptionalStringSchema, folderId, "folderId");
      const validatedNote = parseIpc(OptionalStringSchema, note, "note");
      const validatedIntent = parseIpc(OptionalStringSchema, intent, "intent");
      const validatedExpectedContent = parseIpc(OptionalStringSchema, expectedContent, "expectedContent");
      const validatedKeyFields = parseIpc(OptionalStringArraySchema, keyFields, "keyFields");
      const validatedAgentHints = parseIpc(OptionalRecordSchema, agentHints, "agentHints");

      trackBookmarkAction("save");
      const result = bookmarkManager.saveBookmarkWithPolicy(validatedUrl, validatedTitle, validatedFolderId, validatedNote, {
        onDuplicate: "update",
        extra: {
          ...normalizeBookmarkMetadata({
            intent: validatedIntent,
            expectedContent: validatedExpectedContent,
            keyFields: validatedKeyFields,
            agentHints: validatedAgentHints,
          }),
        },
      });
      if (!result.bookmark) {
        throw new Error("Bookmark save failed");
      }
      return result.bookmark;
    },
  );

  ipcMain.handle(
    Channels.BOOKMARK_UPDATE,
    (
      event,
      id: unknown,
      updates: unknown,
    ) => {
      assertTrustedIpcSender(event);
      const validatedId = parseIpc(BookmarkIdSchema, id, "id");
      const validatedUpdates = parseIpc(BookmarkUpdateSchema, updates, "updates");
      trackBookmarkAction("save");
      return bookmarkManager.updateBookmark(validatedId, validatedUpdates);
    },
  );

  ipcMain.handle(Channels.BOOKMARK_REMOVE, (event, id: unknown) => {
    assertTrustedIpcSender(event);
    const validatedId = parseIpc(BookmarkIdSchema, id, "id");
    trackBookmarkAction("remove");
    return bookmarkManager.removeBookmark(validatedId);
  });

  ipcMain.handle(
    Channels.BOOKMARKS_EXPORT_HTML,
    async (event, options?: unknown) => {
      assertTrustedIpcSender(event);
      const validatedOptions = parseIpc(ExportOptionsSchema, options, "options");
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: "Export Bookmarks",
        defaultPath: "vessel-bookmarks.html",
        filters: [{ name: "HTML Bookmarks", extensions: ["html"] }],
      });
      if (canceled || !filePath) return null;

      const content = bookmarkManager.exportBookmarksHtml({
        includeNotes: validatedOptions?.includeNotes ?? false,
      });
      await fs.writeFile(filePath, content, "utf-8");
      trackBookmarkAction("export");
      return {
        filePath,
        count: bookmarkManager.getState().bookmarks.length,
      };
    },
  );

  ipcMain.handle(Channels.BOOKMARKS_EXPORT_JSON, async (event) => {
    assertTrustedIpcSender(event);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Export Vessel Bookmark Archive",
      defaultPath: "vessel-bookmarks.json",
      filters: [{ name: "Vessel Bookmark Archive", extensions: ["json"] }],
    });
    if (canceled || !filePath) return null;

    const content = bookmarkManager.exportBookmarksJson();
    await fs.writeFile(filePath, content, "utf-8");
    trackBookmarkAction("export");
    return {
      filePath,
      count: bookmarkManager.getState().bookmarks.length,
    };
  });

  ipcMain.handle(
    Channels.FOLDER_EXPORT_HTML,
    async (event, folderId: unknown, options?: unknown) => {
      assertTrustedIpcSender(event);
      const validatedFolderId = parseIpc(BookmarkIdSchema, folderId, "folderId");
      const validatedOptions = parseIpc(ExportOptionsSchema, options, "options");
      const folder = bookmarkManager.getFolder(validatedFolderId);
      if (!folder) return null;

      const { canceled, filePath } = await dialog.showSaveDialog({
        title: `Export ${folder.name}`,
        defaultPath: `vessel-bookmarks-${getSafeBookmarkExportName(folder.name)}.html`,
        filters: [{ name: "HTML Bookmarks", extensions: ["html"] }],
      });
      if (canceled || !filePath) return null;

      const result = bookmarkManager.exportBookmarkFolderHtml(validatedFolderId, {
        includeNotes: validatedOptions?.includeNotes ?? true,
      });
      if (!result) return null;

      await fs.writeFile(filePath, result.content, "utf-8");
      trackBookmarkAction("export");
      return {
        filePath,
        count: result.count,
      };
    },
  );

  ipcMain.handle(Channels.BOOKMARKS_IMPORT_HTML, async (event) => {
    assertTrustedIpcSender(event);
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Import Bookmarks",
      filters: [
        { name: "Bookmark Files", extensions: ["html", "htm"] },
      ],
      properties: ["openFile"],
    });
    if (canceled || filePaths.length === 0) return null;
    const content = await fs.readFile(filePaths[0], "utf-8");
    trackBookmarkAction("import");
    return bookmarkManager.importBookmarksFromHtml(content);
  });

  ipcMain.handle(Channels.BOOKMARKS_IMPORT_JSON, async (event) => {
    assertTrustedIpcSender(event);
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Import Bookmarks",
      filters: [
        { name: "Vessel Bookmark Archive", extensions: ["json"] },
      ],
      properties: ["openFile"],
    });
    if (canceled || filePaths.length === 0) return null;
    const content = await fs.readFile(filePaths[0], "utf-8");
    trackBookmarkAction("import");
    return bookmarkManager.importBookmarksFromJson(content);
  });

  ipcMain.handle(Channels.FOLDER_REMOVE, (event, id: unknown, deleteContents?: unknown) => {
    assertTrustedIpcSender(event);
    const validatedId = parseIpc(BookmarkIdSchema, id, "id");
    const validatedDeleteContents = parseIpc(
      OptionalBooleanSchema,
      deleteContents,
      "deleteContents",
    );
    trackBookmarkAction("folder_remove");
    return bookmarkManager.removeFolder(validatedId, validatedDeleteContents ?? false);
  });

  ipcMain.handle(
    Channels.FOLDER_RENAME,
    (event, id: unknown, newName: unknown, summary?: unknown) => {
      assertTrustedIpcSender(event);
      const validatedId = parseIpc(BookmarkIdSchema, id, "id");
      const validatedName = parseIpc(FolderNameSchema, newName, "newName");
      const validatedSummary = parseIpc(OptionalStringSchema, summary, "summary");
      return bookmarkManager.renameFolder(validatedId, validatedName, validatedSummary);
    },
  );
}
