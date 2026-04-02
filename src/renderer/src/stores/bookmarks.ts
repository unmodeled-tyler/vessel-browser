import { createSignal } from "solid-js";
import type { BookmarksState } from "../../../shared/types";

const INITIAL: BookmarksState = { folders: [], bookmarks: [] };

const [bookmarksState, setBookmarksState] =
  createSignal<BookmarksState>(INITIAL);

let initialized = false;
let initPromise: Promise<void> | null = null;

async function init() {
  if (initPromise) return initPromise;
  if (initialized) return;
  initialized = true;
  initPromise = (async () => {
    try {
      const state = await window.vessel.bookmarks.get();
      setBookmarksState(state);
      window.vessel.bookmarks.onUpdate((s) => setBookmarksState(s));
    } catch (error) {
      initialized = false;
      console.error("Failed to initialize bookmarks store", error);
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

export function useBookmarks() {
  void init();
  return {
    bookmarksState,
    saveBookmark: (
      url: string,
      title: string,
      folderId?: string,
      note?: string,
    ) => window.vessel.bookmarks.saveBookmark(url, title, folderId, note),
    removeBookmark: (id: string) => window.vessel.bookmarks.removeBookmark(id),
    createFolder: (name: string) => window.vessel.bookmarks.createFolder(name),
    createFolderWithSummary: (name: string, summary?: string) =>
      window.vessel.bookmarks.createFolderWithSummary(name, summary),
    removeFolder: (id: string, deleteContents?: boolean) =>
      window.vessel.bookmarks.removeFolder(id, deleteContents),
    renameFolder: (id: string, newName: string, summary?: string) =>
      window.vessel.bookmarks.renameFolder(id, newName, summary),
  };
}
