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
  BookmarkExportResult,
  BookmarkHtmlExportOptions,
  BookmarksState,
  ClearDataOptions,
  HistoryState,
  ImportResult,
  PremiumState,
  ProviderConfig,
  ProviderModelsResult,
  RuntimeHealthState,
  ScheduledJob,
  SecurityState,
  SessionSnapshot,
  TabGroupColor,
  TabState,
  VesselSettings,
} from "../shared/types";
import type { AutofillProfile, AutofillResult } from "../shared/autofill-types";
import type {
  PageDiff,
  PageDiffHistoryItem,
} from "../shared/page-diff-types";
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
    toggleAdBlock: (id: string): Promise<boolean | null> =>
      ipcRenderer.invoke(Channels.TAB_TOGGLE_AD_BLOCK, id),
    zoomIn: (id: string) => ipcRenderer.invoke(Channels.TAB_ZOOM_IN, id),
    zoomOut: (id: string) => ipcRenderer.invoke(Channels.TAB_ZOOM_OUT, id),
    zoomReset: (id: string) => ipcRenderer.invoke(Channels.TAB_ZOOM_RESET, id),
    reopenClosed: () => ipcRenderer.invoke(Channels.TAB_REOPEN_CLOSED),
    duplicate: (id: string) => ipcRenderer.invoke(Channels.TAB_DUPLICATE, id),
    showContextMenu: (id: string) => ipcRenderer.send(Channels.TAB_CONTEXT_MENU, id),
    openPrivateWindow: () => ipcRenderer.invoke(Channels.OPEN_PRIVATE_WINDOW),
    isPrivateMode: (): Promise<boolean> => ipcRenderer.invoke(Channels.IS_PRIVATE_MODE),
    pin: (id: string) => ipcRenderer.invoke(Channels.TAB_PIN, id),
    unpin: (id: string) => ipcRenderer.invoke(Channels.TAB_UNPIN, id),
    createGroup: (id: string): Promise<string | null> =>
      ipcRenderer.invoke(Channels.TAB_GROUP_CREATE, id),
    addToGroup: (id: string, groupId: string) =>
      ipcRenderer.invoke(Channels.TAB_GROUP_ADD_TAB, id, groupId),
    removeFromGroup: (id: string) =>
      ipcRenderer.invoke(Channels.TAB_GROUP_REMOVE_TAB, id),
    toggleGroupCollapsed: (groupId: string): Promise<boolean | null> =>
      ipcRenderer.invoke(Channels.TAB_GROUP_TOGGLE_COLLAPSED, groupId),
    setGroupColor: (groupId: string, color: TabGroupColor) =>
      ipcRenderer.invoke(Channels.TAB_GROUP_SET_COLOR, groupId, color),
    showGroupContextMenu: (groupId: string) =>
      ipcRenderer.send(Channels.TAB_GROUP_CONTEXT_MENU, groupId),
    toggleMute: (id: string): Promise<boolean | null> =>
      ipcRenderer.invoke(Channels.TAB_TOGGLE_MUTE, id),
    print: (id: string) => ipcRenderer.invoke(Channels.TAB_PRINT, id),
    printToPdf: (id: string): Promise<string | null> =>
      ipcRenderer.invoke(Channels.TAB_PRINT_TO_PDF, id),
    openNewWindow: () => ipcRenderer.invoke(Channels.OPEN_NEW_WINDOW),
    getState: (): Promise<{ tabs: TabState[]; activeId: string }> =>
      ipcRenderer.invoke(Channels.TAB_STATE_GET),
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
    onStreamEnd: (
      cb: (status: "completed" | "failed") => void,
    ): (() => void) => {
      const handler = (
        _: unknown,
        status: "completed" | "failed" = "completed",
      ) => cb(status);
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
    ): Promise<ProviderModelsResult> =>
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
    updateCheckpointNote: (
      checkpointId: string,
      note?: string,
    ): Promise<AgentCheckpoint | null> =>
      ipcRenderer.invoke(Channels.AGENT_CHECKPOINT_UPDATE_NOTE, checkpointId, note),
    undoLastAction: (): Promise<string | null> =>
      ipcRenderer.invoke(Channels.AGENT_UNDO_LAST_ACTION),
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
    openSidebarTab: (tab: string) =>
      ipcRenderer.invoke(Channels.SIDEBAR_NAVIGATE, tab),
    startSidebarResize: () => ipcRenderer.invoke(Channels.SIDEBAR_RESIZE_START),
    resizeSidebar: (width: number) =>
      ipcRenderer.invoke(Channels.SIDEBAR_RESIZE, width),
    commitSidebarResize: () =>
      ipcRenderer.invoke(Channels.SIDEBAR_RESIZE_COMMIT),
    rendererReady: (view: "chrome" | "sidebar" | "devtools") =>
      ipcRenderer.send(Channels.RENDERER_VIEW_READY, view),
    onSidebarContextMenu: (
      cb: (position: { x: number; y: number }) => void,
    ): (() => void) => {
      const handler = (_: unknown, position: { x: number; y: number }) =>
        cb(position);
      ipcRenderer.on(Channels.SIDEBAR_CONTEXT_MENU, handler);
      return () =>
        ipcRenderer.removeListener(Channels.SIDEBAR_CONTEXT_MENU, handler);
    },
    onSidebarNavigate: (cb: (tab: string) => void): (() => void) => {
      const handler = (_: unknown, tab: string) => cb(tab);
      ipcRenderer.on(Channels.SIDEBAR_NAVIGATE, handler);
      return () => ipcRenderer.removeListener(Channels.SIDEBAR_NAVIGATE, handler);
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
      intent?: string,
      expectedContent?: string,
      keyFields?: string[],
      agentHints?: Record<string, string>,
    ): Promise<Bookmark> =>
      ipcRenderer.invoke(
        Channels.BOOKMARK_SAVE,
        url,
        title,
        folderId,
        note,
        intent,
        expectedContent,
        keyFields,
        agentHints,
      ),
    updateBookmark: (
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
    ): Promise<Bookmark | null> =>
      ipcRenderer.invoke(Channels.BOOKMARK_UPDATE, id, updates),
    removeBookmark: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.BOOKMARK_REMOVE, id),
    exportHtml: (
      options?: BookmarkHtmlExportOptions,
    ): Promise<BookmarkExportResult | null> =>
      ipcRenderer.invoke(Channels.BOOKMARKS_EXPORT_HTML, options),
    exportJson: (): Promise<BookmarkExportResult | null> =>
      ipcRenderer.invoke(Channels.BOOKMARKS_EXPORT_JSON),
    exportFolderHtml: (
      folderId: string,
      options?: BookmarkHtmlExportOptions,
    ): Promise<BookmarkExportResult | null> =>
      ipcRenderer.invoke(Channels.FOLDER_EXPORT_HTML, folderId, options),
    importHtml: (): Promise<ImportResult | null> =>
      ipcRenderer.invoke(Channels.BOOKMARKS_IMPORT_HTML),
    importJson: (): Promise<ImportResult | null> =>
      ipcRenderer.invoke(Channels.BOOKMARKS_IMPORT_JSON),
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
    exportHtml: (): Promise<{ filePath: string; count: number } | null> =>
      ipcRenderer.invoke(Channels.HISTORY_EXPORT_HTML),
    exportJson: (): Promise<{ filePath: string; count: number } | null> =>
      ipcRenderer.invoke(Channels.HISTORY_EXPORT_JSON),
    importFile: (): Promise<ImportResult | null> =>
      ipcRenderer.invoke(Channels.HISTORY_IMPORT),
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
    requestCode: (email: string): Promise<{ ok: boolean; email?: string; challengeToken?: string; error?: string }> =>
      ipcRenderer.invoke(Channels.PREMIUM_ACTIVATION_START, email),
    verifyCode: (
      email: string,
      code: string,
      challengeToken: string,
    ): Promise<{ ok: boolean; state: PremiumState; error?: string }> =>
      ipcRenderer.invoke(
        Channels.PREMIUM_ACTIVATION_VERIFY,
        email,
        code,
        challengeToken,
      ),
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
  sessions: {
    list: (): Promise<Array<{ name: string; createdAt: string; updatedAt: string; cookieCount: number; originCount: number; domains: string[] }>> =>
      ipcRenderer.invoke(Channels.SESSION_LIST),
    save: (name: string): Promise<{ name: string; createdAt: string; updatedAt: string; cookieCount: number; originCount: number; domains: string[] }> =>
      ipcRenderer.invoke(Channels.SESSION_SAVE, name),
    load: (name: string): Promise<{ name: string; createdAt: string; updatedAt: string; cookieCount: number; originCount: number; domains: string[] }> =>
      ipcRenderer.invoke(Channels.SESSION_LOAD, name),
    delete: (name: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.SESSION_DELETE, name),
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
  humanVault: {
    list: (domain?: string) =>
      ipcRenderer.invoke(Channels.HUMAN_VAULT_LIST, domain),
    get: (id: string) =>
      ipcRenderer.invoke(Channels.HUMAN_VAULT_GET, id),
    save: (entry: { title: string; url: string; username: string; password: string; notes?: string; category?: string; tags?: string[] }) =>
      ipcRenderer.invoke(Channels.HUMAN_VAULT_SAVE, entry),
    update: (id: string, updates: { title?: string; url?: string; username?: string; password?: string; notes?: string; category?: string; tags?: string[] }) =>
      ipcRenderer.invoke(Channels.HUMAN_VAULT_UPDATE, id, updates),
    remove: (id: string) =>
      ipcRenderer.invoke(Channels.HUMAN_VAULT_REMOVE, id),
    auditLog: (limit?: number) =>
      ipcRenderer.invoke(Channels.HUMAN_VAULT_AUDIT_LOG, limit),
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
  autofill: {
    list: (): Promise<AutofillProfile[]> =>
      ipcRenderer.invoke(Channels.AUTOFILL_LIST),
    add: (profile: Omit<AutofillProfile, "id" | "createdAt" | "updatedAt">): Promise<AutofillProfile> =>
      ipcRenderer.invoke(Channels.AUTOFILL_ADD, profile),
    update: (id: string, updates: Partial<Omit<AutofillProfile, "id" | "createdAt">>): Promise<AutofillProfile | null> =>
      ipcRenderer.invoke(Channels.AUTOFILL_UPDATE, id, updates),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.AUTOFILL_DELETE, id),
    fill: (profileId: string): Promise<AutofillResult> =>
      ipcRenderer.invoke(Channels.AUTOFILL_FILL, profileId),
  },
  downloads: {
    onStarted: (
      cb: (info: { filename: string; savePath: string; totalBytes: number; receivedBytes: number; state: string }) => void,
    ): (() => void) => {
      const handler = (_: unknown, info: { filename: string; savePath: string; totalBytes: number; receivedBytes: number; state: string }) => cb(info);
      ipcRenderer.on(Channels.DOWNLOAD_STARTED, handler);
      return () =>
        ipcRenderer.removeListener(Channels.DOWNLOAD_STARTED, handler);
    },
    onProgress: (
      cb: (info: { filename: string; savePath: string; totalBytes: number; receivedBytes: number; state: string }) => void,
    ): (() => void) => {
      const handler = (_: unknown, info: { filename: string; savePath: string; totalBytes: number; receivedBytes: number; state: string }) => cb(info);
      ipcRenderer.on(Channels.DOWNLOAD_PROGRESS, handler);
      return () =>
        ipcRenderer.removeListener(Channels.DOWNLOAD_PROGRESS, handler);
    },
    onDone: (
      cb: (info: { filename: string; savePath: string; totalBytes: number; receivedBytes: number; state: string }) => void,
    ): (() => void) => {
      const handler = (_: unknown, info: { filename: string; savePath: string; totalBytes: number; receivedBytes: number; state: string }) => cb(info);
      ipcRenderer.on(Channels.DOWNLOAD_DONE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.DOWNLOAD_DONE, handler);
    },
  },
  pageDiff: {
    onChanged: (cb: (diff: PageDiff) => void): (() => void) => {
      const handler = (_: unknown, diff: PageDiff) => cb(diff);
      ipcRenderer.on(Channels.PAGE_CHANGED, handler);
      return () =>
        ipcRenderer.removeListener(Channels.PAGE_CHANGED, handler);
    },
    get: (): Promise<PageDiff | null> =>
      ipcRenderer.invoke(Channels.PAGE_DIFF_GET),
    getHistory: (): Promise<PageDiffHistoryItem[] | { error: string }> =>
      ipcRenderer.invoke(Channels.PAGE_DIFF_HISTORY),
  },
  security: {
    onStateUpdate: (
      cb: (tabId: string, state: SecurityState) => void,
    ): (() => void) => {
      const handler = (_: unknown, data: { tabId: string; state: SecurityState }) =>
        cb(data.tabId, data.state);
      ipcRenderer.on(Channels.SECURITY_STATE_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.SECURITY_STATE_UPDATE, handler);
    },
    showDetails: (state: SecurityState): Promise<void> =>
      ipcRenderer.invoke(Channels.SECURITY_SHOW_DETAILS, state),
    proceedAnyway: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(Channels.SECURITY_PROCEED_ANYWAY, tabId),
    goBackToSafety: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(Channels.SECURITY_GO_BACK_TO_SAFETY, tabId),
  },
  browsingData: {
    clear: (options: ClearDataOptions): Promise<void> =>
      ipcRenderer.invoke(Channels.CLEAR_BROWSING_DATA, options),
    onOpenDialog: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on(Channels.CLEAR_BROWSING_DATA_OPEN, handler);
      return () =>
        ipcRenderer.removeListener(Channels.CLEAR_BROWSING_DATA_OPEN, handler);
    },
  },
  pip: {
    toggle: (): Promise<boolean> =>
      ipcRenderer.invoke(Channels.TAB_TOGGLE_PIP),
  },
  codex: {
    startAuth: (): Promise<
      { ok: true; accountEmail: string; accountId: string } | { ok: false; error: string }
    > => ipcRenderer.invoke(Channels.CODEX_START_AUTH),
    cancelAuth: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(Channels.CODEX_CANCEL_AUTH),
    disconnect: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("codex:disconnect"),
    onAuthStatus: (
      cb: (payload: { status: string; error: string | null }) => void,
    ): (() => void) => {
      const handler = (
        _: unknown,
        payload: { status: string; error: string | null },
      ) => cb(payload);
      ipcRenderer.on(Channels.CODEX_AUTH_STATUS, handler);
      return () =>
        ipcRenderer.removeListener(Channels.CODEX_AUTH_STATUS, handler);
    },
  },
};

contextBridge.exposeInMainWorld("vessel", api);

export type VesselAPI = typeof api;
