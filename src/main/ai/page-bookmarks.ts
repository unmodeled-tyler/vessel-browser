import * as bookmarkManager from "../bookmarks/manager";

export function resolveBookmarkFolderTarget(args: Record<string, unknown>): {
  folderId?: string;
  folderName: string;
  createdFolder?: string;
  error?: string;
} {
  const folderId =
    typeof args.folderId === "string"
      ? args.folderId.trim()
      : typeof args.folder_id === "string"
        ? args.folder_id.trim()
        : "";
  if (folderId) {
    if (folderId === bookmarkManager.UNSORTED_ID) {
      return {
        folderId: bookmarkManager.UNSORTED_ID,
        folderName: "Unsorted",
      };
    }
    const folder = bookmarkManager.getFolder(folderId);
    if (!folder) {
      return { folderName: "Unsorted", error: `Folder ${folderId} not found` };
    }
    return { folderId: folder.id, folderName: folder.name };
  }

  const folderName =
    typeof args.folderName === "string" && args.folderName.trim()
      ? args.folderName.trim()
      : typeof args.folder_name === "string" && args.folder_name.trim()
        ? args.folder_name.trim()
        : args.archive
          ? bookmarkManager.ARCHIVE_FOLDER_NAME
          : "";
  if (!folderName || folderName.toLowerCase() === "unsorted") {
    return {
      folderId: bookmarkManager.UNSORTED_ID,
      folderName: "Unsorted",
    };
  }

  const existing = bookmarkManager.findFolderByName(folderName);
  if (existing) {
    return { folderId: existing.id, folderName: existing.name };
  }

  const createIfMissing =
    args.createFolderIfMissing ?? args.create_folder_if_missing;
  if (createIfMissing === false) {
    return { folderName, error: `Folder "${folderName}" not found` };
  }

  const folderSummary =
    typeof args.folderSummary === "string" && args.folderSummary.trim()
      ? args.folderSummary.trim()
      : typeof args.folder_summary === "string" && args.folder_summary.trim()
        ? args.folder_summary.trim()
        : undefined;
  const { folder } = bookmarkManager.ensureFolder(folderName, folderSummary);
  return {
    folderId: folder.id,
    folderName: folder.name,
    createdFolder: folder.name,
  };
}

function formatFolderStatus(limit = 6): string {
  const folders = bookmarkManager.listFolderOverviews();
  const summary = folders
    .slice(0, limit)
    .map((folder) => `${folder.name} (${folder.count})`)
    .join(", ");
  return `Folder status: ${summary}${folders.length > limit ? ", ..." : ""}`;
}

export function describeFolder(folderId?: string): string {
  if (!folderId || folderId === bookmarkManager.UNSORTED_ID) {
    return "Unsorted";
  }
  return bookmarkManager.getFolder(folderId)?.name ?? folderId;
}

export function composeDuplicateBookmarkResponse(args: {
  url: string;
  folderName: string;
  bookmarkId: string;
}): string {
  return `Bookmark already exists for ${args.url} in "${args.folderName}" (id=${args.bookmarkId}). Retry with onDuplicate="update" to refresh the existing bookmark or onDuplicate="duplicate" to keep both entries.`;
}

export function composeFolderAwareResponse(
  message: string,
  createdFolder?: string,
): string {
  const prefix = createdFolder ? `Created folder "${createdFolder}".\n` : "";
  return `${prefix}${message}\n${formatFolderStatus()}`;
}
