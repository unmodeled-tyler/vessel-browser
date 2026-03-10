import { createSignal } from "solid-js";
import type { BookmarksState } from "../../../shared/types";

const INITIAL: BookmarksState = { folders: [], bookmarks: [] };

const [bookmarksState, setBookmarksState] =
  createSignal<BookmarksState>(INITIAL);

let initialized = false;

async function init() {
  if (initialized) return;
  try {
    const state = await window.vessel.bookmarks.get();
    setBookmarksState(state);
    window.vessel.bookmarks.onUpdate((s) => setBookmarksState(s));
    initialized = true;
  } catch (error) {
    console.error("Failed to initialize bookmarks store", error);
  }
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
    removeFolder: (id: string) => window.vessel.bookmarks.removeFolder(id),
    renameFolder: (id: string, newName: string) =>
      window.vessel.bookmarks.renameFolder(id, newName),
  };
}
