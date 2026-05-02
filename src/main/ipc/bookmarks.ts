import { dialog, ipcMain } from "electron";
import { promises as fs } from "fs";
import { Channels } from "../../shared/channels";
import * as bookmarkManager from "../bookmarks/manager";
import { normalizeBookmarkMetadata } from "../bookmarks/metadata";
import { trackBookmarkAction } from "../telemetry/posthog";

export function registerBookmarkHandlers(): void {
  ipcMain.handle(Channels.BOOKMARKS_GET, () => {
    return bookmarkManager.getState();
  });

  ipcMain.handle(
    Channels.FOLDER_CREATE,
    (_, name: string, summary?: string) => {
      trackBookmarkAction("folder_create");
      return bookmarkManager.createFolderWithSummary(name, summary);
    },
  );

  ipcMain.handle(
    Channels.BOOKMARK_SAVE,
    (
      _,
      url: string,
      title: string,
      folderId?: string,
      note?: string,
      intent?: string,
      expectedContent?: string,
      keyFields?: string[],
      agentHints?: Record<string, string>,
    ) => {
      trackBookmarkAction("save");
      const result = bookmarkManager.saveBookmarkWithPolicy(url, title, folderId, note, {
        onDuplicate: "update",
        extra: {
          ...normalizeBookmarkMetadata({
            intent,
            expectedContent,
            keyFields,
            agentHints,
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
      _,
      id: string,
      updates: {
        title?: string;
        note?: string;
        folderId?: string;
        intent?: string;
        expectedContent?: string;
        keyFields?: string[];
        agentHints?: Record<string, string>;
      },
    ) => {
      trackBookmarkAction("save");
      return bookmarkManager.updateBookmark(id, updates);
    },
  );

  ipcMain.handle(Channels.BOOKMARK_REMOVE, (_, id: string) => {
    trackBookmarkAction("remove");
    return bookmarkManager.removeBookmark(id);
  });

  ipcMain.handle(
    Channels.BOOKMARKS_EXPORT_HTML,
    async (_, options?: { includeNotes?: boolean }) => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: "Export Bookmarks",
        defaultPath: "vessel-bookmarks.html",
        filters: [{ name: "HTML Bookmarks", extensions: ["html"] }],
      });
      if (canceled || !filePath) return null;

      const content = bookmarkManager.exportBookmarksHtml({
        includeNotes: options?.includeNotes ?? false,
      });
      await fs.writeFile(filePath, content, "utf-8");
      trackBookmarkAction("export");
      return {
        filePath,
        count: bookmarkManager.getState().bookmarks.length,
      };
    },
  );

  ipcMain.handle(Channels.BOOKMARKS_EXPORT_JSON, async () => {
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

  ipcMain.handle(Channels.BOOKMARKS_IMPORT_HTML, async () => {
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

  ipcMain.handle(Channels.BOOKMARKS_IMPORT_JSON, async () => {
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

  ipcMain.handle(Channels.FOLDER_REMOVE, (_, id: string, deleteContents?: boolean) => {
    trackBookmarkAction("folder_remove");
    return bookmarkManager.removeFolder(id, deleteContents ?? false);
  });

  ipcMain.handle(
    Channels.FOLDER_RENAME,
    (_, id: string, newName: string, summary?: string) => {
      return bookmarkManager.renameFolder(id, newName, summary);
    },
  );
}