import { contextBridge, ipcRenderer } from "electron";
import { Channels } from "../shared/channels";
import type {
  AgentCheckpoint,
  AgentRuntimeState,
  AutomationActivityEntry,
  AIMessage,
  ApprovalMode,
  AutomationKit,
  Bookmark,
  BookmarkFolder,
  BookmarksState,
  HistoryState,
  PremiumState,
  ProviderConfig,
  RuntimeHealthState,
  ScheduledJob,
  SessionSnapshot,
  TabState,
  VesselSettings,
} from "../shared/types";
import type { DevToolsPanelState } from "../main/devtools/types";

const api = {
  tabs: {
    create: (url?: string) => ipcRenderer.invoke(Channels.TAB_CREATE, url),
    close: (id: string) => ipcRenderer.invoke(Channels.TAB_CLOSE, id),
    switch: (id: string) => ipcRenderer.invoke(Channels.TAB_SWITCH, id),
    navigate: (id: string, url: string, postBody?: Record<string, string>) =>
      ipcRenderer.invoke(Channels.TAB_NAVIGATE, id, url, postBody),
    back: (id: string) => ipcRenderer.invoke(Channels.TAB_BACK, id),
    forward: (id: string) => ipcRenderer.invoke(Channels.TAB_FORWARD, id),
    reload: (id: string) => ipcRenderer.invoke(Channels.TAB_RELOAD, id),
    onStateUpdate: (
      cb: (tabs: TabState[], activeId: string) => void,
    ): (() => void) => {
      const handler = (_: unknown, tabs: TabState[], activeId: string) =>
        cb(tabs, activeId);
      ipcRenderer.on(Channels.TAB_STATE_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.TAB_STATE_UPDATE, handler);
    },
  },
  ai: {
    query: (prompt: string, history?: AIMessage[]) =>
      ipcRenderer.invoke<
        { accepted: true } | { accepted: false; reason: "busy" }
      >(Channels.AI_QUERY, prompt, history),
    onStreamStart: (cb: (prompt: string) => void): (() => void) => {
      const handler = (_: unknown, prompt: string) => cb(prompt);
      ipcRenderer.on(Channels.AI_STREAM_START, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AI_STREAM_START, handler);
    },
    onStreamChunk: (cb: (chunk: string) => void): (() => void) => {
      const handler = (_: unknown, chunk: string) => cb(chunk);
      ipcRenderer.on(Channels.AI_STREAM_CHUNK, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AI_STREAM_CHUNK, handler);
    },
    onStreamEnd: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on(Channels.AI_STREAM_END, handler);
      return () => ipcRenderer.removeListener(Channels.AI_STREAM_END, handler);
    },
    onStreamIdle: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on(Channels.AI_STREAM_IDLE, handler);
      return () => ipcRenderer.removeListener(Channels.AI_STREAM_IDLE, handler);
    },
    onAutomationActivityStart: (
      cb: (entry: AutomationActivityEntry) => void,
    ): (() => void) => {
      const handler = (_: unknown, entry: AutomationActivityEntry) => cb(entry);
      ipcRenderer.on(Channels.AUTOMATION_ACTIVITY_START, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AUTOMATION_ACTIVITY_START, handler);
    },
    onAutomationActivityChunk: (
      cb: (payload: { id: string; chunk: string }) => void,
    ): (() => void) => {
      const handler = (_: unknown, payload: { id: string; chunk: string }) =>
        cb(payload);
      ipcRenderer.on(Channels.AUTOMATION_ACTIVITY_CHUNK, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AUTOMATION_ACTIVITY_CHUNK, handler);
    },
    onAutomationActivityEnd: (
      cb: (payload: {
        id: string;
        status: "completed" | "failed";
        finishedAt: string;
      }) => void,
    ): (() => void) => {
      const handler = (
        _: unknown,
        payload: {
          id: string;
          status: "completed" | "failed";
          finishedAt: string;
        },
      ) => cb(payload);
      ipcRenderer.on(Channels.AUTOMATION_ACTIVITY_END, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AUTOMATION_ACTIVITY_END, handler);
    },
    cancel: () => ipcRenderer.invoke(Channels.AI_CANCEL),
    fetchModels: (
      config: ProviderConfig,
    ): Promise<{ ok: boolean; models: string[]; error?: string }> =>
      ipcRenderer.invoke(Channels.AI_FETCH_MODELS, config),
    getRuntime: (): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_RUNTIME_GET),
    onRuntimeUpdate: (cb: (state: AgentRuntimeState) => void): (() => void) => {
      const handler = (_: unknown, state: AgentRuntimeState) => cb(state);
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
    capture: (): Promise<{
      success: boolean;
      text?: string;
      message?: string;
    }> => ipcRenderer.invoke(Channels.HIGHLIGHT_CAPTURE),
    onCaptureResult: (
      cb: (result: {
        success: boolean;
        text?: string;
        message?: string;
      }) => void,
    ): (() => void) => {
      const handler = (_: unknown, result: { success: boolean; text?: string; message?: string }) => cb(result);
      ipcRenderer.on(Channels.HIGHLIGHT_CAPTURE_RESULT, handler);
      return () =>
        ipcRenderer.removeListener(Channels.HIGHLIGHT_CAPTURE_RESULT, handler);
    },
    getCount: (): Promise<number> =>
      ipcRenderer.invoke(Channels.HIGHLIGHT_NAV_COUNT),
    onCountUpdate: (cb: (count: number) => void): (() => void) => {
      const handler = (_: unknown, count: number) => cb(count);
      ipcRenderer.on(Channels.HIGHLIGHT_COUNT_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.HIGHLIGHT_COUNT_UPDATE, handler);
    },
    scrollTo: (index: number): Promise<boolean> =>
      ipcRenderer.invoke(Channels.HIGHLIGHT_NAV_SCROLL, index),
    remove: (index: number): Promise<boolean> =>
      ipcRenderer.invoke(Channels.HIGHLIGHT_NAV_REMOVE, index),
    clearAll: (): Promise<boolean> =>
      ipcRenderer.invoke(Channels.HIGHLIGHT_NAV_CLEAR),
    onSidebarAction: (
      cb: (action: "remove-current" | "clear-all") => void,
    ): (() => void) => {
      const handler = (_: unknown, action: "remove-current" | "clear-all") =>
        cb(action);
      ipcRenderer.on(Channels.SIDEBAR_HIGHLIGHT_ACTION, handler);
      return () =>
        ipcRenderer.removeListener(Channels.SIDEBAR_HIGHLIGHT_ACTION, handler);
    },
  },
  ui: {
    toggleSidebar: () => ipcRenderer.invoke(Channels.SIDEBAR_TOGGLE),
    startSidebarResize: () => ipcRenderer.invoke(Channels.SIDEBAR_RESIZE_START),
    resizeSidebar: (width: number) =>
      ipcRenderer.invoke(Channels.SIDEBAR_RESIZE, width),
    commitSidebarResize: () =>
      ipcRenderer.invoke(Channels.SIDEBAR_RESIZE_COMMIT),
    onSidebarContextMenu: (
      cb: (position: { x: number; y: number }) => void,
    ): (() => void) => {
      const handler = (_: unknown, position: { x: number; y: number }) =>
        cb(position);
      ipcRenderer.on(Channels.SIDEBAR_CONTEXT_MENU, handler);
      return () =>
        ipcRenderer.removeListener(Channels.SIDEBAR_CONTEXT_MENU, handler);
    },
    toggleFocusMode: () => ipcRenderer.invoke(Channels.FOCUS_MODE_TOGGLE),
    setSettingsVisibility: (open: boolean) =>
      ipcRenderer.invoke(Channels.SETTINGS_VISIBILITY, open),
  },
  settings: {
    get: () => ipcRenderer.invoke(Channels.SETTINGS_GET),
    getHealth: (): Promise<RuntimeHealthState> =>
      ipcRenderer.invoke(Channels.SETTINGS_HEALTH_GET),
    onHealthUpdate: (
      cb: (health: RuntimeHealthState) => void,
    ): (() => void) => {
      const handler = (_: unknown, health: RuntimeHealthState) => cb(health);
      ipcRenderer.on(Channels.SETTINGS_HEALTH_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.SETTINGS_HEALTH_UPDATE, handler);
    },
    set: (key: string, value: unknown) =>
      ipcRenderer.invoke(Channels.SETTINGS_SET, key, value),
    onUpdate: (cb: (settings: VesselSettings) => void): (() => void) => {
      const handler = (_: unknown, settings: VesselSettings) => cb(settings);
      ipcRenderer.on(Channels.SETTINGS_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.SETTINGS_UPDATE, handler);
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
    removeFolder: (id: string, deleteContents?: boolean): Promise<boolean> =>
      ipcRenderer.invoke(Channels.FOLDER_REMOVE, id, deleteContents),
    renameFolder: (
      id: string,
      newName: string,
      summary?: string,
    ): Promise<BookmarkFolder | null> =>
      ipcRenderer.invoke(Channels.FOLDER_RENAME, id, newName, summary),
    onAddContextToChat: (cb: (bookmarkId: string) => void): (() => void) => {
      const handler = (_: unknown, bookmarkId: string) => cb(bookmarkId);
      ipcRenderer.on(Channels.BOOKMARK_ADD_CONTEXT_TO_CHAT, handler);
      return () =>
        ipcRenderer.removeListener(
          Channels.BOOKMARK_ADD_CONTEXT_TO_CHAT,
          handler,
        );
    },
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
      ipcRenderer.invoke(Channels.DEVTOOLS_PANEL_RESIZE, height),
    onStateUpdate: (cb: (state: DevToolsPanelState) => void): (() => void) => {
      const handler = (_: unknown, state: DevToolsPanelState) => cb(state);
      ipcRenderer.on(Channels.DEVTOOLS_PANEL_STATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.DEVTOOLS_PANEL_STATE, handler);
    },
  },
  find: {
    start: (text: string, options?: { forward?: boolean; findNext?: boolean }) =>
      ipcRenderer.invoke(Channels.FIND_IN_PAGE_START, text, options),
    next: (forward?: boolean) =>
      ipcRenderer.invoke(Channels.FIND_IN_PAGE_NEXT, forward),
    stop: (action?: "clearSelection" | "keepSelection" | "activateSelection") =>
      ipcRenderer.invoke(Channels.FIND_IN_PAGE_STOP, action),
    onResult: (
      cb: (result: { requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void,
    ): (() => void) => {
      const handler = (_: unknown, result: { requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => cb(result);
      ipcRenderer.on(Channels.FIND_IN_PAGE_RESULT, handler);
      return () =>
        ipcRenderer.removeListener(Channels.FIND_IN_PAGE_RESULT, handler);
    },
  },
  history: {
    get: (): Promise<HistoryState> =>
      ipcRenderer.invoke(Channels.HISTORY_GET),
    search: (query: string) =>
      ipcRenderer.invoke(Channels.HISTORY_SEARCH, query),
    clear: () => ipcRenderer.invoke(Channels.HISTORY_CLEAR),
    onUpdate: (cb: (state: HistoryState) => void): (() => void) => {
      const handler = (_: unknown, state: HistoryState) => cb(state);
      ipcRenderer.on(Channels.HISTORY_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.HISTORY_UPDATE, handler);
    },
  },
  premium: {
    getState: (): Promise<PremiumState> =>
      ipcRenderer.invoke(Channels.PREMIUM_GET_STATE),
    activate: (email: string): Promise<{ ok: boolean; state: PremiumState; error?: string }> =>
      ipcRenderer.invoke(Channels.PREMIUM_ACTIVATE, email),
    checkout: (email?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(Channels.PREMIUM_CHECKOUT, email),
    portal: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(Channels.PREMIUM_PORTAL),
    reset: (): Promise<PremiumState> =>
      ipcRenderer.invoke(Channels.PREMIUM_RESET),
    trackContext: (
      step:
        | "chat_banner_viewed"
        | "chat_banner_clicked"
        | "settings_banner_viewed"
        | "settings_banner_clicked"
        | "welcome_banner_clicked"
        | "premium_gate_seen"
        | "premium_gate_clicked"
        | "iteration_limit_seen"
        | "iteration_limit_clicked",
    ): Promise<void> => ipcRenderer.invoke(Channels.PREMIUM_TRACK_CONTEXT, step),
    onUpdate: (cb: (state: PremiumState) => void): (() => void) => {
      const handler = (_: unknown, state: PremiumState) => cb(state);
      ipcRenderer.on(Channels.PREMIUM_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.PREMIUM_UPDATE, handler);
    },
  },
  vault: {
    list: (): Promise<Array<{ id: string; label: string; domainPattern: string; username: string; notes?: string; createdAt: string; lastUsedAt?: string; useCount: number }>> =>
      ipcRenderer.invoke(Channels.VAULT_LIST),
    add: (entry: { label: string; domainPattern: string; username: string; password: string; totpSecret?: string; notes?: string }): Promise<{ id: string; label: string; domainPattern: string; username: string }> =>
      ipcRenderer.invoke(Channels.VAULT_ADD, entry),
    update: (id: string, updates: { label?: string; domainPattern?: string; username?: string; password?: string; totpSecret?: string; notes?: string }): Promise<boolean> =>
      ipcRenderer.invoke(Channels.VAULT_UPDATE, id, updates),
    remove: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.VAULT_REMOVE, id),
    auditLog: (limit?: number): Promise<Array<{ timestamp: string; credentialLabel: string; domain: string; action: string; approved: boolean }>> =>
      ipcRenderer.invoke(Channels.VAULT_AUDIT_LOG, limit),
  },
  automation: {
    getInstalled: (): Promise<AutomationKit[]> =>
      ipcRenderer.invoke(Channels.AUTOMATION_GET_INSTALLED),
    installFromFile: (): Promise<{ ok: boolean; kit?: AutomationKit; error?: string }> =>
      ipcRenderer.invoke(Channels.AUTOMATION_INSTALL_FROM_FILE),
    uninstall: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(Channels.AUTOMATION_UNINSTALL, id),
  },
  schedule: {
    getAll: (): Promise<ScheduledJob[]> =>
      ipcRenderer.invoke(Channels.SCHEDULE_GET_ALL),
    create: (
      job: Omit<ScheduledJob, "id" | "createdAt" | "nextRunAt">,
    ): Promise<ScheduledJob> =>
      ipcRenderer.invoke(Channels.SCHEDULE_CREATE, job),
    update: (
      id: string,
      updates: Partial<Pick<ScheduledJob, "enabled" | "schedule" | "renderedPrompt" | "fieldValues">>,
    ): Promise<ScheduledJob | null> =>
      ipcRenderer.invoke(Channels.SCHEDULE_UPDATE, id, updates),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.SCHEDULE_DELETE, id),
    onJobsUpdate: (cb: (jobs: ScheduledJob[]) => void): (() => void) => {
      const handler = (_: unknown, updatedJobs: ScheduledJob[]) => cb(updatedJobs);
      ipcRenderer.on(Channels.SCHEDULE_JOBS_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.SCHEDULE_JOBS_UPDATE, handler);
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
