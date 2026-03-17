import { contextBridge, ipcRenderer } from "electron";
import { Channels } from "../shared/channels";
import type {
  AgentCheckpoint,
  AgentRuntimeState,
  AIMessage,
  ApprovalMode,
  Bookmark,
  BookmarkFolder,
  BookmarksState,
  RuntimeHealthState,
  SessionSnapshot,
  VesselSettings,
} from "../shared/types";

const api = {
  tabs: {
    create: (url?: string) => ipcRenderer.invoke(Channels.TAB_CREATE, url),
    close: (id: string) => ipcRenderer.invoke(Channels.TAB_CLOSE, id),
    switch: (id: string) => ipcRenderer.invoke(Channels.TAB_SWITCH, id),
    navigate: (id: string, url: string) =>
      ipcRenderer.invoke(Channels.TAB_NAVIGATE, id, url),
    back: (id: string) => ipcRenderer.invoke(Channels.TAB_BACK, id),
    forward: (id: string) => ipcRenderer.invoke(Channels.TAB_FORWARD, id),
    reload: (id: string) => ipcRenderer.invoke(Channels.TAB_RELOAD, id),
    onStateUpdate: (
      cb: (tabs: any[], activeId: string) => void,
    ): (() => void) => {
      const handler = (_: any, tabs: any[], activeId: string) =>
        cb(tabs, activeId);
      ipcRenderer.on(Channels.TAB_STATE_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.TAB_STATE_UPDATE, handler);
    },
  },
  ai: {
    query: (prompt: string, history?: AIMessage[]) => ipcRenderer.invoke(Channels.AI_QUERY, prompt, history),
    onStreamStart: (cb: (prompt: string) => void): (() => void) => {
      const handler = (_: any, prompt: string) => cb(prompt);
      ipcRenderer.on(Channels.AI_STREAM_START, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AI_STREAM_START, handler);
    },
    onStreamChunk: (cb: (chunk: string) => void): (() => void) => {
      const handler = (_: any, chunk: string) => cb(chunk);
      ipcRenderer.on(Channels.AI_STREAM_CHUNK, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AI_STREAM_CHUNK, handler);
    },
    onStreamEnd: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on(Channels.AI_STREAM_END, handler);
      return () => ipcRenderer.removeListener(Channels.AI_STREAM_END, handler);
    },
    cancel: () => ipcRenderer.invoke(Channels.AI_CANCEL),
    getRuntime: (): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_RUNTIME_GET),
    onRuntimeUpdate: (cb: (state: AgentRuntimeState) => void): (() => void) => {
      const handler = (_: any, state: AgentRuntimeState) => cb(state);
      ipcRenderer.on(Channels.AGENT_RUNTIME_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AGENT_RUNTIME_UPDATE, handler);
    },
    pause: (): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_PAUSE),
    resume: (): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_RESUME),
    setApprovalMode: (mode: ApprovalMode): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_SET_APPROVAL_MODE, mode),
    resolveApproval: (
      approvalId: string,
      approved: boolean,
    ): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_APPROVAL_RESOLVE, approvalId, approved),
    createCheckpoint: (
      name?: string,
      note?: string,
    ): Promise<AgentCheckpoint> =>
      ipcRenderer.invoke(Channels.AGENT_CHECKPOINT_CREATE, name, note),
    restoreCheckpoint: (
      checkpointId: string,
    ): Promise<AgentCheckpoint | null> =>
      ipcRenderer.invoke(Channels.AGENT_CHECKPOINT_RESTORE, checkpointId),
    captureSession: (note?: string): Promise<SessionSnapshot> =>
      ipcRenderer.invoke(Channels.AGENT_SESSION_CAPTURE, note),
    restoreSession: (
      snapshot?: SessionSnapshot | null,
    ): Promise<SessionSnapshot> =>
      ipcRenderer.invoke(Channels.AGENT_SESSION_RESTORE, snapshot),
  },
  content: {
    extract: () => ipcRenderer.invoke(Channels.CONTENT_EXTRACT),
    toggleReader: () => ipcRenderer.invoke(Channels.READER_MODE_TOGGLE),
  },
  highlights: {
    capture: (): Promise<{ success: boolean; text?: string; message?: string }> =>
      ipcRenderer.invoke(Channels.HIGHLIGHT_CAPTURE),
    onCaptureResult: (
      cb: (result: { success: boolean; text?: string; message?: string }) => void,
    ): (() => void) => {
      const handler = (_: any, result: any) => cb(result);
      ipcRenderer.on(Channels.HIGHLIGHT_CAPTURE_RESULT, handler);
      return () =>
        ipcRenderer.removeListener(Channels.HIGHLIGHT_CAPTURE_RESULT, handler);
    },
  },
  ui: {
    toggleSidebar: () => ipcRenderer.invoke(Channels.SIDEBAR_TOGGLE),
    resizeSidebar: (width: number) =>
      ipcRenderer.invoke(Channels.SIDEBAR_RESIZE, width),
    toggleFocusMode: () => ipcRenderer.invoke(Channels.FOCUS_MODE_TOGGLE),
    setSettingsVisibility: (open: boolean) =>
      ipcRenderer.invoke(Channels.SETTINGS_VISIBILITY, open),
  },
  settings: {
    get: () => ipcRenderer.invoke(Channels.SETTINGS_GET),
    getHealth: (): Promise<RuntimeHealthState> =>
      ipcRenderer.invoke(Channels.SETTINGS_HEALTH_GET),
    set: (key: string, value: any) =>
      ipcRenderer.invoke(Channels.SETTINGS_SET, key, value),
    onUpdate: (cb: (settings: VesselSettings) => void): (() => void) => {
      const handler = (_: unknown, settings: VesselSettings) => cb(settings);
      ipcRenderer.on(Channels.SETTINGS_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.SETTINGS_UPDATE, handler);
    },
  },
  bookmarks: {
    get: (): Promise<BookmarksState> =>
      ipcRenderer.invoke(Channels.BOOKMARKS_GET),
    saveBookmark: (
      url: string,
      title: string,
      folderId?: string,
      note?: string,
    ): Promise<Bookmark> =>
      ipcRenderer.invoke(Channels.BOOKMARK_SAVE, url, title, folderId, note),
    removeBookmark: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.BOOKMARK_REMOVE, id),
    createFolder: (name: string): Promise<BookmarkFolder> =>
      ipcRenderer.invoke(Channels.FOLDER_CREATE, name),
    createFolderWithSummary: (
      name: string,
      summary?: string,
    ): Promise<BookmarkFolder> =>
      ipcRenderer.invoke(Channels.FOLDER_CREATE, name, summary),
    removeFolder: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.FOLDER_REMOVE, id),
    renameFolder: (
      id: string,
      newName: string,
      summary?: string,
    ): Promise<BookmarkFolder | null> =>
      ipcRenderer.invoke(Channels.FOLDER_RENAME, id, newName, summary),
    onUpdate: (cb: (state: BookmarksState) => void): (() => void) => {
      const handler = (_: unknown, state: BookmarksState) => cb(state);
      ipcRenderer.on(Channels.BOOKMARKS_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.BOOKMARKS_UPDATE, handler);
    },
  },
  devtoolsPanel: {
    toggle: (): Promise<{ open: boolean }> =>
      ipcRenderer.invoke(Channels.DEVTOOLS_PANEL_TOGGLE),
    resize: (height: number) =>
      ipcRenderer.invoke("devtools-panel:resize", height),
    onStateUpdate: (
      cb: (state: any) => void,
    ): (() => void) => {
      const handler = (_: any, state: any) => cb(state);
      ipcRenderer.on(Channels.DEVTOOLS_PANEL_STATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.DEVTOOLS_PANEL_STATE, handler);
    },
  },
  window: {
    minimize: () => ipcRenderer.invoke(Channels.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.invoke(Channels.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.invoke(Channels.WINDOW_CLOSE),
  },
};

contextBridge.exposeInMainWorld("vessel", api);

export type VesselAPI = typeof api;
