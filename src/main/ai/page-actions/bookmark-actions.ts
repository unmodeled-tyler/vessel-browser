import type { WebContents } from "electron";
import type { Bookmark } from "../../../shared/types";
import { resolveBookmarkSourceDraft } from "../../bookmarks/page-source";
import * as bookmarkManager from "../../bookmarks/manager";
import { resolveSelector } from "../../utils/selector-resolver";
import { waitForLoad } from "../../utils/webcontents-utils";
import {
  formatDeadLinkMessage,
  validateLinkDestination,
} from "../../network/link-validation";
import {
  composeDuplicateBookmarkResponse,
  composeFolderAwareResponse,
  describeFolder,
  resolveBookmarkFolderTarget,
} from "../page-bookmarks";
import type { ActionContext } from "./core";

type BookmarkMetadataResolver = (
  args: Record<string, unknown>,
) => Partial<Bookmark>;

export async function handleBookmarkAction(args: {
  name: string;
  actionArgs: Record<string, unknown>;
  ctx: ActionContext;
  wc?: WebContents;
  tabId?: string | null;
  getBookmarkMetadataFromArgs: BookmarkMetadataResolver;
}): Promise<string> {
  const {
    name,
    actionArgs,
    ctx,
    wc,
    tabId,
    getBookmarkMetadataFromArgs,
  } = args;

  switch (name) {
    case "list_bookmarks": {
      const state = bookmarkManager.getState();
      const folderId =
        typeof actionArgs.folderId === "string" ? actionArgs.folderId.trim() : "";
      const folderName =
        typeof actionArgs.folderName === "string" ? actionArgs.folderName.trim() : "";
      const resolvedFolderId =
        folderId ||
        (folderName
          ? (state.folders.find(
              (folder) =>
                folder.name.toLowerCase() === folderName.toLowerCase(),
            )?.id ?? "")
          : "");

      if (folderName && !resolvedFolderId) {
        return `Folder "${folderName}" not found`;
      }

      const folders = [
        { id: "unsorted", name: "Unsorted" },
        ...state.folders,
      ];
      const lines: string[] = [];
      for (const folder of folders) {
        if (resolvedFolderId && folder.id !== resolvedFolderId) continue;
        const items = state.bookmarks.filter(
          (bookmark) => bookmark.folderId === folder.id,
        );
        lines.push(
          `[${folder.name}] (id=${folder.id}, ${items.length} items)`,
        );
        if ("summary" in folder && typeof folder.summary === "string") {
          lines.push(`summary: ${folder.summary}`);
        }
        for (const bookmark of items) {
          lines.push(
            `- ${bookmark.title} | ${bookmark.url} | id=${bookmark.id}${bookmark.note ? ` | note: ${bookmark.note}` : ""}`,
          );
        }
      }
      return lines.length ? lines.join("\n") : "No bookmarks saved yet";
    }

    case "search_bookmarks": {
      const query = typeof actionArgs.query === "string" ? actionArgs.query.trim() : "";
      if (!query) return "Error: query is required";

      const matches = bookmarkManager.searchBookmarks(query);
      if (matches.length === 0) {
        return `No bookmarks matched "${query}"`;
      }

      const lines = matches.map(({ bookmark, folder, matchedFields }) => {
        const folderLabel =
          bookmark.folderId === "unsorted"
            ? "Unsorted"
            : (folder?.name ?? bookmark.folderId);
        return `- ${bookmark.title} | ${bookmark.url} | folder=${folderLabel} | matched=${matchedFields.join(",")} | id=${bookmark.id}${bookmark.note ? ` | note: ${bookmark.note}` : ""}`;
      });
      return [`Matches for "${query}" (${matches.length})`, ...lines].join(
        "\n",
      );
    }

    case "create_bookmark_folder": {
      const folderName = typeof actionArgs.name === "string" ? actionArgs.name.trim() : "";
      const summary =
        typeof actionArgs.summary === "string" && actionArgs.summary.trim()
          ? actionArgs.summary.trim()
          : undefined;
      if (!folderName) return "Error: Folder name is required";
      const existing = bookmarkManager
        .getState()
        .folders.find(
          (folder) => folder.name.toLowerCase() === folderName.toLowerCase(),
        );
      if (existing) {
        return composeFolderAwareResponse(
          `Folder "${existing.name}" already exists (id=${existing.id})`,
        );
      }
      const folder = bookmarkManager.createFolderWithSummary(folderName, summary);
      return composeFolderAwareResponse(
        `Created folder "${folder.name}" (id=${folder.id})`,
      );
    }

    case "save_bookmark": {
      const resolvedSelector =
        wc &&
        (typeof actionArgs.index === "number" ||
          typeof actionArgs.selector === "string")
          ? await resolveSelector(wc, actionArgs.index, actionArgs.selector)
          : null;
      const source = await resolveBookmarkSourceDraft(wc, {
        explicitUrl: actionArgs.url,
        explicitTitle: actionArgs.title,
        resolvedSelector,
      });
      if ("error" in source) return `Error: ${source.error}`;

      const target = resolveBookmarkFolderTarget(actionArgs);
      if (target.error) return target.error;
      const note =
        typeof actionArgs.note === "string" && actionArgs.note.trim()
          ? actionArgs.note.trim()
          : undefined;
      const onDuplicate =
        typeof actionArgs.onDuplicate === "string" &&
        ["ask", "update", "duplicate"].includes(actionArgs.onDuplicate)
          ? (actionArgs.onDuplicate as bookmarkManager.DuplicateBookmarkPolicy)
          : "ask";
      const result = bookmarkManager.saveBookmarkWithPolicy(
        source.url,
        source.title,
        target.folderId,
        note,
        {
          onDuplicate,
          extra: getBookmarkMetadataFromArgs(actionArgs),
        },
      );
      if (result.status === "conflict" && result.existing) {
        return composeFolderAwareResponse(
          composeDuplicateBookmarkResponse({
            url: source.url,
            folderName: describeFolder(target.folderId),
            bookmarkId: result.existing.id,
          }),
          target.createdFolder,
        );
      }
      const bookmark = result.bookmark;
      if (!bookmark) return "Error: Bookmark save failed";
      const verb = result.status === "updated" ? "Updated" : "Saved";
      return composeFolderAwareResponse(
        `${verb} "${bookmark.title}" (${bookmark.url}) in "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
        target.createdFolder,
      );
    }

    case "organize_bookmark": {
      const target = resolveBookmarkFolderTarget(actionArgs);
      if (target.error) return target.error;

      const bookmarkId =
        typeof actionArgs.bookmarkId === "string" ? actionArgs.bookmarkId.trim() : "";
      const note =
        typeof actionArgs.note === "string" && actionArgs.note.trim()
          ? actionArgs.note.trim()
          : undefined;
      const resolvedSelector =
        wc &&
        (typeof actionArgs.index === "number" ||
          typeof actionArgs.selector === "string")
          ? await resolveSelector(wc, actionArgs.index, actionArgs.selector)
          : null;
      const source = await resolveBookmarkSourceDraft(wc, {
        explicitUrl: actionArgs.url,
        explicitTitle: actionArgs.title,
        resolvedSelector,
      });

      const existing = bookmarkId
        ? bookmarkManager.getBookmark(bookmarkId)
        : "error" in source
          ? undefined
          : bookmarkManager.getBookmarkByUrl(source.url);
      if (bookmarkId && !existing) {
        return `Bookmark ${bookmarkId} not found`;
      }

      if (existing) {
        const updated = bookmarkManager.updateBookmark(existing.id, {
          folderId: target.folderId,
          title:
            typeof actionArgs.title === "string" && actionArgs.title.trim()
              ? actionArgs.title.trim()
              : undefined,
          note,
          ...getBookmarkMetadataFromArgs(actionArgs),
        });
        if (!updated) {
          return `Bookmark ${existing.id} not found`;
        }
        return composeFolderAwareResponse(
          `Organized existing bookmark "${updated.title}" into "${describeFolder(updated.folderId)}" (id=${updated.id})`,
          target.createdFolder,
        );
      }

      if ("error" in source) return `Error: ${source.error}`;

      const result = bookmarkManager.saveBookmarkWithPolicy(
        source.url,
        source.title,
        target.folderId,
        note,
        {
          onDuplicate: "update",
          extra: getBookmarkMetadataFromArgs(actionArgs),
        },
      );
      const bookmark = result.bookmark;
      if (!bookmark) return "Error: Bookmark save failed";
      return composeFolderAwareResponse(
        `Saved and organized "${bookmark.title}" (${bookmark.url}) into "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
        target.createdFolder,
      );
    }

    case "archive_bookmark": {
      const target = resolveBookmarkFolderTarget({ archive: true });
      if (target.error) return target.error;

      const bookmarkId =
        typeof actionArgs.bookmarkId === "string" ? actionArgs.bookmarkId.trim() : "";
      const note =
        typeof actionArgs.note === "string" && actionArgs.note.trim()
          ? actionArgs.note.trim()
          : undefined;
      const resolvedSelector =
        wc &&
        (typeof actionArgs.index === "number" ||
          typeof actionArgs.selector === "string")
          ? await resolveSelector(wc, actionArgs.index, actionArgs.selector)
          : null;
      const source = await resolveBookmarkSourceDraft(wc, {
        explicitUrl: actionArgs.url,
        explicitTitle: actionArgs.title,
        resolvedSelector,
      });

      const existing = bookmarkId
        ? bookmarkManager.getBookmark(bookmarkId)
        : "error" in source
          ? undefined
          : bookmarkManager.getBookmarkByUrl(source.url);
      if (bookmarkId && !existing) {
        return `Bookmark ${bookmarkId} not found`;
      }

      if (existing) {
        const updated = bookmarkManager.updateBookmark(existing.id, {
          folderId: target.folderId,
          title:
            typeof actionArgs.title === "string" && actionArgs.title.trim()
              ? actionArgs.title.trim()
              : undefined,
          note,
        });
        if (!updated) {
          return `Bookmark ${existing.id} not found`;
        }
        return composeFolderAwareResponse(
          `Archived bookmark "${updated.title}" into "${describeFolder(updated.folderId)}" (id=${updated.id})`,
          target.createdFolder,
        );
      }

      if ("error" in source) {
        return bookmarkId
          ? `Bookmark ${bookmarkId} not found`
          : `Error: ${source.error}`;
      }

      const bookmark = bookmarkManager.saveBookmark(
        source.url,
        source.title,
        target.folderId,
        note,
      );
      return composeFolderAwareResponse(
        `Saved and archived "${bookmark.title}" (${bookmark.url}) into "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
        target.createdFolder,
      );
    }

    case "open_bookmark": {
      const bookmarkId =
        typeof actionArgs.bookmarkId === "string" ? actionArgs.bookmarkId.trim() : "";
      if (!bookmarkId) return "Error: bookmarkId is required";

      const bookmark = bookmarkManager.getBookmark(bookmarkId);
      if (!bookmark) {
        return `Bookmark ${bookmarkId} not found`;
      }

      const validation = await validateLinkDestination(bookmark.url);
      if (validation.status === "dead") {
        return formatDeadLinkMessage(bookmark.title, validation);
      }

      const openInNewTab = Boolean(actionArgs.newTab);
      if (openInNewTab || !tabId || !wc) {
        const createdId = ctx.tabManager.createTab(bookmark.url);
        const created = ctx.tabManager.getActiveTab();
        if (created) {
          await waitForLoad(created.view.webContents);
        }
        return `Opened bookmark "${bookmark.title}" in new tab ${createdId}`;
      }

      ctx.tabManager.navigateTab(tabId, bookmark.url);
      await waitForLoad(wc);
      return `Opened bookmark "${bookmark.title}" in current tab`;
    }

    default:
      return `Unknown action: ${name}`;
  }
}
