import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  composeDuplicateBookmarkResponse,
  composeFolderAwareResponse,
  describeFolder,
  getBookmarkMetadataFromArgs,
  resolveBookmarkFolderTarget,
} from "../../ai/page-actions";
import { resolveBookmarkSourceDraft } from "../../bookmarks/page-source";
import {
  formatDeadLinkMessage,
  validateLinkDestination,
} from "../../network/link-validation";
import { resolveSelector } from "../../utils/selector-resolver";
import { waitForLoad } from "../../utils/webcontents-utils";
import type { AgentRuntime } from "../../agent/runtime";
import type { TabManager } from "../../tabs/tab-manager";
import * as bookmarkManager from "../../bookmarks/manager";
import { linkBookmarkToMemory } from "../../memory/obsidian";
import { withAction } from "../mcp-helpers";

export function registerBookmarkTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "create_folder",
    {
      title: "Create Bookmark Folder",
      description:
        "Create a named folder for organizing bookmarks. If a folder with the same name already exists, return it instead of duplicating it.",
      inputSchema: {
        name: z.string().describe("Name for the new folder"),
        summary: z
          .string()
          .optional()
          .describe("Optional one-sentence summary shown in the UI"),
      },
    },
    async ({ name, summary }) => {
      return withAction(
        runtime,
        tabManager,
        "create_bookmark_folder",
        { name, summary },
        async () => {
          const existing = bookmarkManager.findFolderByName(name);
          if (existing) {
            return composeFolderAwareResponse(
              `Folder "${existing.name}" already exists (id=${existing.id})`,
            );
          }

          const folder = bookmarkManager.createFolderWithSummary(name, summary);
          return composeFolderAwareResponse(
            `Created folder "${folder.name}" (id=${folder.id})`,
          );
        },
      );
    },
  );

  server.registerTool(
    "bookmark_save",
    {
      title: "Save Bookmark",
      description:
        "Save the current page, a specific URL, or a link target from the current page into a bookmark folder. You can provide folder_id or folder_name; missing folder names can be created automatically.",
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            "URL to bookmark. Omit to use the current page or provide index/selector to bookmark a link target from the page",
          ),
        title: z
          .string()
          .optional()
          .describe(
            "Human-readable title for the bookmark. Omit to use the page or link text",
          ),
        index: z
          .number()
          .optional()
          .describe(
            "Element index of a link on the current page to bookmark without opening it",
          ),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector of a link on the current page to bookmark without opening it",
          ),
        folder_id: z
          .string()
          .optional()
          .describe("Folder ID to save into (omit for Unsorted)"),
        folder_name: z
          .string()
          .optional()
          .describe(
            "Folder name to save into. Created automatically if missing",
          ),
        folder_summary: z
          .string()
          .optional()
          .describe("Optional one-sentence summary if a new folder is created"),
        create_folder_if_missing: z
          .boolean()
          .optional()
          .describe("Create folder_name automatically when it does not exist"),
        note: z
          .string()
          .optional()
          .describe("Optional note about why this was bookmarked"),
        on_duplicate: z
          .enum(["ask", "update", "duplicate"])
          .optional()
          .describe(
            'How to handle an existing bookmark with the same URL in the same folder: "ask" (default), "update", or "duplicate"',
          ),
        intent: z
          .string()
          .optional()
          .describe(
            "Human-readable description of what this bookmark is for",
          ),
        expected_content: z
          .string()
          .optional()
          .describe(
            "Brief description of the content the agent should expect to find here",
          ),
        key_fields: z
          .array(z.string())
          .optional()
          .describe("Important form field names for this page"),
        agent_hints: z
          .record(z.string(), z.string())
          .optional()
          .describe("Arbitrary key-value hints for the agent"),
      },
    },
    async ({
      url,
      title,
      index,
      selector,
      folder_id,
      folder_name,
      folder_summary,
      create_folder_if_missing,
      note,
      on_duplicate,
      intent,
      expected_content,
      key_fields,
      agent_hints,
    }) => {
      return withAction(
        runtime,
        tabManager,
        "save_bookmark",
        {
          url,
          title,
          index,
          selector,
          folder_id,
          folder_name,
          folder_summary,
          create_folder_if_missing,
          note,
          intent,
          expected_content,
          key_fields,
          agent_hints,
        },
        async () => {
          const currentTab = tabManager.getActiveTab();
          const resolvedSelector =
            currentTab &&
            (typeof index === "number" || typeof selector === "string")
              ? await resolveSelector(
                  currentTab.view.webContents,
                  index,
                  selector,
                )
              : null;
          const source = await resolveBookmarkSourceDraft(
            currentTab?.view.webContents,
            {
              explicitUrl: url,
              explicitTitle: title,
              resolvedSelector,
            },
          );
          if ("error" in source) return `Error: ${source.error}`;

          const target = resolveBookmarkFolderTarget({
            folder_id,
            folder_name,
            folder_summary,
            create_folder_if_missing,
          });
          if (target.error) return target.error;

          const result = bookmarkManager.saveBookmarkWithPolicy(
            source.url,
            source.title,
            target.folderId,
            note,
            {
              onDuplicate: on_duplicate ?? "ask",
              extra: getBookmarkMetadataFromArgs({
                intent,
                expected_content,
                key_fields,
                agent_hints,
              }),
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
          if (!bookmark) {
            return "Error: Bookmark save failed";
          }

          const verb = result.status === "updated" ? "Updated" : "Saved";
          return composeFolderAwareResponse(
            `${verb} "${bookmark.title}" (${bookmark.url}) in "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
            target.createdFolder,
          );
        },
      );
    },
  );

  server.registerTool(
    "bookmark_list",
    {
      title: "List Bookmarks",
      description:
        "List all bookmark folders and their contents. Optionally filter by folder.",
      inputSchema: {
        folder_id: z
          .string()
          .optional()
          .describe("Filter to a specific folder ID (omit for all)"),
        folder_name: z
          .string()
          .optional()
          .describe("Filter to a specific folder name (omit for all)"),
      },
    },
    async ({ folder_id, folder_name }) => {
      return withAction(
        runtime,
        tabManager,
        "list_bookmarks",
        { folder_id, folder_name },
        async () => {
          const state = bookmarkManager.getState();
          const resolvedFolderId =
            folder_id ||
            (typeof folder_name === "string" && folder_name.trim()
              ? (bookmarkManager.findFolderByName(folder_name)?.id ?? "")
              : "");
          if (folder_name && !resolvedFolderId) {
            return `Folder "${folder_name}" not found`;
          }

          const folders = [
            { id: "unsorted", name: "Unsorted" },
            ...state.folders,
          ];
          const lines: string[] = [];
          for (const folder of folders) {
            if (resolvedFolderId && folder.id !== resolvedFolderId) continue;
            const items = state.bookmarks.filter(
              (b) => b.folderId === folder.id,
            );
            lines.push(
              `\n[${folder.name}] (id=${folder.id}, ${items.length} items)`,
            );
            if ("summary" in folder && typeof folder.summary === "string") {
              lines.push(`  summary: ${folder.summary}`);
            }
            for (const b of items) {
              lines.push(
                `  - ${b.title} | ${b.url} | id=${b.id}${b.note ? ` | note: ${b.note}` : ""}`,
              );
            }
          }
          return lines.length
            ? lines.join("\n").trim()
            : "No bookmarks saved yet.";
        },
      );
    },
  );

  server.registerTool(
    "bookmark_organize",
    {
      title: "Organize Bookmark",
      description:
        "Organize a bookmark by intent: save or move a bookmark into a folder, creating the folder if needed. Works with bookmark_id, url, a link target from the current page, or the current page itself.",
      inputSchema: {
        bookmark_id: z
          .string()
          .optional()
          .describe("Existing bookmark ID to move or update"),
        url: z
          .string()
          .optional()
          .describe(
            "URL to organize. Omit to use the current page or provide index/selector to target a link",
          ),
        title: z
          .string()
          .optional()
          .describe("Optional title when saving a new bookmark"),
        index: z
          .number()
          .optional()
          .describe(
            "Element index of a link on the current page to organize without opening it",
          ),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector of a link on the current page to organize without opening it",
          ),
        folder_id: z.string().optional().describe("Folder ID to organize into"),
        folder_name: z
          .string()
          .optional()
          .describe("Folder name to organize into"),
        folder_summary: z
          .string()
          .optional()
          .describe("Optional summary used if a new folder is created"),
        create_folder_if_missing: z
          .boolean()
          .optional()
          .describe("Create folder_name automatically when it does not exist"),
        note: z
          .string()
          .optional()
          .describe("Optional note to attach or update on the bookmark"),
        archive: z
          .boolean()
          .optional()
          .describe('If true, organize into the default "Archive" folder'),
        intent: z
          .string()
          .optional()
          .describe("Human-readable description of what this bookmark is for"),
        expected_content: z
          .string()
          .optional()
          .describe("Brief description of content the agent should expect"),
        key_fields: z
          .array(z.string())
          .optional()
          .describe("Important form field names for this page"),
        agent_hints: z
          .record(z.string(), z.string())
          .optional()
          .describe("Arbitrary key-value hints for the agent"),
      },
    },
    async (args) => {
      return withAction(
        runtime,
        tabManager,
        "organize_bookmark",
        args,
        async () => {
          const target = resolveBookmarkFolderTarget(args);
          if (target.error) return target.error;

          const bookmarkId =
            typeof args.bookmark_id === "string" ? args.bookmark_id.trim() : "";
          const currentTab = tabManager.getActiveTab();
          const note =
            typeof args.note === "string" && args.note.trim()
              ? args.note.trim()
              : undefined;
          const resolvedSelector =
            currentTab &&
            (typeof args.index === "number" ||
              typeof args.selector === "string")
              ? await resolveSelector(
                  currentTab.view.webContents,
                  args.index,
                  args.selector,
                )
              : null;
          const source = await resolveBookmarkSourceDraft(
            currentTab?.view.webContents,
            {
              explicitUrl: args.url,
              explicitTitle: args.title,
              resolvedSelector,
            },
          );

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
                typeof args.title === "string" && args.title.trim()
                  ? args.title.trim()
                  : undefined,
              note,
              ...getBookmarkMetadataFromArgs(args),
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
              extra: getBookmarkMetadataFromArgs(args),
            },
          );
          const bookmark = result.bookmark;
          if (!bookmark) return "Error: Bookmark save failed";
          return composeFolderAwareResponse(
            `Saved and organized "${bookmark.title}" (${bookmark.url}) into "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
            target.createdFolder,
          );
        },
      );
    },
  );

  server.registerTool(
    "bookmark_search",
    {
      title: "Search Bookmarks",
      description:
        "Search bookmarks by title, URL, note, folder name, or folder summary.",
      inputSchema: {
        query: z.string().describe("Search term to match against bookmarks"),
      },
    },
    async ({ query }) => {
      return withAction(
        runtime,
        tabManager,
        "search_bookmarks",
        { query },
        async () => {
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
        },
      );
    },
  );

  server.registerTool(
    "bookmark_remove",
    {
      title: "Remove Bookmark",
      description: "Remove a specific bookmark by its ID.",
      inputSchema: {
        bookmark_id: z.string().describe("ID of the bookmark to remove"),
      },
    },
    async ({ bookmark_id }) => {
      return withAction(
        runtime,
        tabManager,
        "remove_bookmark",
        { bookmark_id },
        async () => {
          const removed = bookmarkManager.removeBookmark(bookmark_id);
          return removed
            ? `Removed bookmark ${bookmark_id}`
            : `Bookmark ${bookmark_id} not found`;
        },
      );
    },
  );

  server.registerTool(
    "bookmark_archive",
    {
      title: "Archive Bookmark",
      description:
        'Archive the current page, a URL, a link target from the current page, or an existing bookmark into the default "Archive" folder.',
      inputSchema: {
        bookmark_id: z
          .string()
          .optional()
          .describe("Existing bookmark ID to archive"),
        url: z
          .string()
          .optional()
          .describe(
            "URL to archive. Omit to use the current page or provide index/selector to target a link",
          ),
        title: z
          .string()
          .optional()
          .describe("Optional title when saving a new archived bookmark"),
        index: z
          .number()
          .optional()
          .describe(
            "Element index of a link on the current page to archive without opening it",
          ),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector of a link on the current page to archive without opening it",
          ),
        note: z
          .string()
          .optional()
          .describe("Optional note to store with the archived bookmark"),
      },
    },
    async ({ bookmark_id, url, title, index, selector, note }) => {
      return withAction(
        runtime,
        tabManager,
        "archive_bookmark",
        { bookmark_id, url, title, index, selector, note },
        async () => {
          const currentTab = tabManager.getActiveTab();
          const trimmedBookmarkId =
            typeof bookmark_id === "string" ? bookmark_id.trim() : "";
          const trimmedNote =
            typeof note === "string" && note.trim() ? note.trim() : undefined;
          const target = resolveBookmarkFolderTarget({ archive: true });
          if (target.error) return target.error;
          const resolvedSelector =
            currentTab &&
            (typeof index === "number" || typeof selector === "string")
              ? await resolveSelector(
                  currentTab.view.webContents,
                  index,
                  selector,
                )
              : null;
          const source = await resolveBookmarkSourceDraft(
            currentTab?.view.webContents,
            {
              explicitUrl: url,
              explicitTitle: title,
              resolvedSelector,
            },
          );

          const existing = trimmedBookmarkId
            ? bookmarkManager.getBookmark(trimmedBookmarkId)
            : "error" in source
              ? undefined
              : bookmarkManager.getBookmarkByUrl(source.url);
          if (trimmedBookmarkId && !existing) {
            return `Bookmark ${trimmedBookmarkId} not found`;
          }

          if (existing) {
            const updated = bookmarkManager.updateBookmark(existing.id, {
              folderId: target.folderId,
              title:
                typeof title === "string" && title.trim()
                  ? title.trim()
                  : undefined,
              note: trimmedNote,
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
            return `Error: ${source.error}`;
          }

          const bookmark = bookmarkManager.saveBookmark(
            source.url,
            source.title,
            target.folderId,
            trimmedNote,
            undefined,
            undefined,
            undefined,
            undefined,
          );
          return composeFolderAwareResponse(
            `Saved and archived "${bookmark.title}" (${bookmark.url}) into "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
            target.createdFolder,
          );
        },
      );
    },
  );

  server.registerTool(
    "bookmark_open",
    {
      title: "Open Bookmark",
      description:
        "Open a saved bookmark by bookmark ID. Optionally open it in a new tab.",
      inputSchema: {
        bookmark_id: z.string().describe("ID of the bookmark to open"),
        new_tab: z
          .boolean()
          .optional()
          .describe("Open the bookmark in a new tab"),
      },
    },
    async ({ bookmark_id, new_tab }) => {
      return withAction(
        runtime,
        tabManager,
        "open_bookmark",
        { bookmark_id, new_tab },
        async () => {
          const bookmark = bookmarkManager.getBookmark(bookmark_id);
          if (!bookmark) {
            return `Bookmark ${bookmark_id} not found`;
          }

          const validation = await validateLinkDestination(bookmark.url);
          if (validation.status === "dead") {
            return formatDeadLinkMessage(bookmark.title, validation);
          }

          if (new_tab || !tabManager.getActiveTabId()) {
            const createdId = tabManager.createTab(bookmark.url);
            const created = tabManager.getActiveTab();
            if (created) {
              await waitForLoad(created.view.webContents);
            }
            return `Opened bookmark "${bookmark.title}" in new tab ${createdId}`;
          }

          const activeId = tabManager.getActiveTabId()!;
          const activeTab = tabManager.getActiveTab();
          tabManager.navigateTab(activeId, bookmark.url);
          if (activeTab) {
            await waitForLoad(activeTab.view.webContents);
          }
          return `Opened bookmark "${bookmark.title}" in current tab`;
        },
      );
    },
  );

  server.registerTool(
    "folder_remove",
    {
      title: "Remove Bookmark Folder",
      description:
        "Remove a folder. By default bookmarks in it are moved to Unsorted. Set delete_contents to true to delete them with the folder.",
      inputSchema: {
        folder_id: z.string().describe("ID of the folder to remove"),
        delete_contents: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, delete all bookmarks in the folder. If false (default), move them to Unsorted.",
          ),
      },
    },
    async ({ folder_id, delete_contents }) => {
      return withAction(
        runtime,
        tabManager,
        "remove_bookmark_folder",
        { folder_id, delete_contents },
        async () => {
          const removed = bookmarkManager.removeFolder(
            folder_id,
            delete_contents,
          );
          if (!removed) return `Folder ${folder_id} not found`;
          return composeFolderAwareResponse(
            delete_contents
              ? `Removed folder ${folder_id} and deleted its bookmarks.`
              : `Removed folder ${folder_id}. Bookmarks moved to Unsorted.`,
          );
        },
      );
    },
  );

  server.registerTool(
    "folder_rename",
    {
      title: "Rename Bookmark Folder",
      description: "Rename an existing bookmark folder.",
      inputSchema: {
        folder_id: z.string().describe("ID of the folder to rename"),
        new_name: z.string().describe("New name for the folder"),
        summary: z
          .string()
          .optional()
          .describe("Optional one-sentence summary for the folder"),
      },
    },
    async ({ folder_id, new_name, summary }) => {
      return withAction(
        runtime,
        tabManager,
        "rename_bookmark_folder",
        { folder_id, new_name, summary },
        async () => {
          const existing = bookmarkManager.findFolderByName(new_name);
          if (existing && existing.id !== folder_id) {
            return composeFolderAwareResponse(
              `Folder "${existing.name}" already exists (id=${existing.id})`,
            );
          }

          const folder = bookmarkManager.renameFolder(
            folder_id,
            new_name,
            summary,
          );
          return folder
            ? composeFolderAwareResponse(`Renamed folder to "${folder.name}"`)
            : `Folder ${folder_id} not found`;
        },
      );
    },
  );

  server.registerTool(
    "memory_link_bookmark",
    {
      title: "Link Bookmark To Memory",
      description:
        "Create a note for a bookmark or append bookmark details into an existing memory note.",
      inputSchema: {
        bookmark_id: z.string().describe("Bookmark ID to link"),
        note_path: z
          .string()
          .optional()
          .describe("Existing relative note path to append into"),
        title: z
          .string()
          .optional()
          .describe("Optional title when creating a new note"),
        folder: z
          .string()
          .optional()
          .describe("Relative folder when creating a new note"),
        note: z
          .string()
          .optional()
          .describe(
            "Optional rationale or breadcrumb to store with the bookmark",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags when creating a new note"),
      },
    },
    async ({ bookmark_id, note_path, title, folder, note, tags }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_link_bookmark",
        { bookmark_id, note_path, title, folder, tags },
        async () => {
          const bookmark = bookmarkManager.getBookmark(bookmark_id);
          if (!bookmark) {
            return `Bookmark ${bookmark_id} not found`;
          }
          const saved = linkBookmarkToMemory({
            bookmark,
            notePath: note_path,
            title,
            folder,
            note,
            tags,
          });
          return `Linked bookmark "${bookmark.title}" to memory note ${saved.relativePath}`;
        },
      );
    },
  );
}
