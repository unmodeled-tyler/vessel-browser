import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import type { AIProvider } from "../ai/provider";
import {
  createProvider,
  fetchProviderModels,
  sanitizeProviderConfig,
  validateProviderConfig,
} from "../ai/provider";
import { PROVIDERS } from "../ai/providers";
import { handleAIQuery } from "../ai/commands";
import { extractContent } from "../content/extractor";
import { generateReaderHTML } from "../content/reader-mode";
import { loadSettings, setSetting } from "../config/settings";
import { layoutViews, type WindowState } from "../window";
import type {
  ApprovalMode,
  AgentRuntimeState,
  ProviderConfig,
  ProviderModelsResult,
  ProviderUpdateResult,
  SessionSnapshot,
} from "../../shared/types";
import type { AgentRuntime } from "../agent/runtime";
import * as bookmarkManager from "../bookmarks/manager";

export function registerIpcHandlers(
  windowState: WindowState,
  runtime: AgentRuntime,
): void {
  const { tabManager, chromeView, sidebarView, mainWindow } = windowState;

  let provider: AIProvider | null = null;
  let providerError =
    "No AI provider configured. Open settings (Ctrl+,) to set one up.";

  const refreshProvider = (config: ProviderConfig): string | null => {
    const normalized = sanitizeProviderConfig(config);
    const validationError = validateProviderConfig(normalized);
    if (validationError) {
      provider = null;
      providerError = validationError;
      return validationError;
    }

    try {
      provider = createProvider(normalized);
      providerError = "";
      return null;
    } catch (error) {
      provider = null;
      providerError =
        error instanceof Error
          ? error.message
          : "Failed to initialize the selected AI provider.";
      return providerError;
    }
  };

  refreshProvider(loadSettings().provider);

  const sendToRendererViews = (channel: string, ...args: unknown[]) => {
    chromeView.webContents.send(channel, ...args);
    sidebarView.webContents.send(channel, ...args);
  };

  runtime.setUpdateListener((state: AgentRuntimeState) => {
    sendToRendererViews(Channels.AGENT_RUNTIME_UPDATE, state);
  });

  // --- Tab handlers ---

  ipcMain.handle(Channels.TAB_CREATE, (_, url?: string) => {
    const id = tabManager.createTab(url || loadSettings().defaultUrl);
    layoutViews(windowState);
    return id;
  });

  ipcMain.handle(Channels.TAB_CLOSE, (_, id: string) => {
    tabManager.closeTab(id);
    layoutViews(windowState);
  });

  ipcMain.handle(Channels.TAB_SWITCH, (_, id: string) => {
    tabManager.switchTab(id);
    layoutViews(windowState);
  });

  ipcMain.handle(Channels.TAB_NAVIGATE, (_, id: string, url: string) => {
    tabManager.navigateTab(id, url);
  });

  ipcMain.handle(Channels.TAB_BACK, (_, id: string) => {
    tabManager.goBack(id);
  });

  ipcMain.handle(Channels.TAB_FORWARD, (_, id: string) => {
    tabManager.goForward(id);
  });

  ipcMain.handle(Channels.TAB_RELOAD, (_, id: string) => {
    tabManager.reloadTab(id);
  });

  // --- AI handlers ---

  ipcMain.handle(Channels.AI_QUERY, async (_, query: string) => {
    sendToRendererViews(Channels.AI_STREAM_START, query);

    if (!provider) {
      sendToRendererViews(Channels.AI_STREAM_CHUNK, providerError);
      sendToRendererViews(Channels.AI_STREAM_END);
      return;
    }

    const activeTab = tabManager.getActiveTab();
    const activeWebContents = activeTab?.view.webContents;

    await handleAIQuery(
      query,
      provider,
      activeWebContents,
      (chunk) => sendToRendererViews(Channels.AI_STREAM_CHUNK, chunk),
      () => sendToRendererViews(Channels.AI_STREAM_END),
      tabManager,
      runtime,
    );
  });

  ipcMain.handle(Channels.AI_CANCEL, () => {
    provider?.cancel();
  });

  // --- Content handlers ---

  ipcMain.handle(Channels.CONTENT_EXTRACT, async () => {
    const activeTab = tabManager.getActiveTab();
    if (!activeTab) return null;
    return extractContent(activeTab.view.webContents);
  });

  ipcMain.handle(Channels.READER_MODE_TOGGLE, async () => {
    const activeTab = tabManager.getActiveTab();
    if (!activeTab) return;

    const content = await extractContent(activeTab.view.webContents);
    const html = generateReaderHTML(content);
    activeTab.view.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
  });

  // --- UI handlers ---

  ipcMain.handle(Channels.SIDEBAR_TOGGLE, () => {
    windowState.uiState.sidebarOpen = !windowState.uiState.sidebarOpen;
    layoutViews(windowState);
    return {
      open: windowState.uiState.sidebarOpen,
      width: windowState.uiState.sidebarWidth,
    };
  });

  ipcMain.handle(Channels.SIDEBAR_RESIZE, (_, width: number) => {
    const clamped = Math.max(240, Math.min(800, Math.round(width)));
    windowState.uiState.sidebarWidth = clamped;
    setSetting("sidebarWidth", clamped);
    layoutViews(windowState);
    return clamped;
  });

  ipcMain.handle(Channels.FOCUS_MODE_TOGGLE, () => {
    windowState.uiState.focusMode = !windowState.uiState.focusMode;
    layoutViews(windowState);
    return windowState.uiState.focusMode;
  });

  ipcMain.handle(Channels.SETTINGS_VISIBILITY, (_, open: boolean) => {
    windowState.uiState.settingsOpen = open;
    layoutViews(windowState);
    return windowState.uiState.settingsOpen;
  });

  // --- Settings handlers ---

  ipcMain.handle(Channels.SETTINGS_GET, () => {
    return loadSettings();
  });

  ipcMain.handle(Channels.SETTINGS_SET, (_, key: string, value: any) => {
    setSetting(key as any, value);
    if (key === "provider") {
      refreshProvider(value as ProviderConfig);
    }
    if (key === "approvalMode") {
      runtime.setApprovalMode(value as ApprovalMode);
    }
  });

  // --- Agent runtime handlers ---

  ipcMain.handle(Channels.AGENT_RUNTIME_GET, () => runtime.getState());

  ipcMain.handle(Channels.AGENT_PAUSE, () => runtime.pause());

  ipcMain.handle(Channels.AGENT_RESUME, () => runtime.resume());

  ipcMain.handle(
    Channels.AGENT_SET_APPROVAL_MODE,
    (_, mode: ApprovalMode): AgentRuntimeState => {
      setSetting("approvalMode", mode);
      return runtime.setApprovalMode(mode);
    },
  );

  ipcMain.handle(
    Channels.AGENT_APPROVAL_RESOLVE,
    (_, approvalId: string, approved: boolean) =>
      runtime.resolveApproval(approvalId, approved),
  );

  ipcMain.handle(
    Channels.AGENT_CHECKPOINT_CREATE,
    (_, name?: string, note?: string) => runtime.createCheckpoint(name, note),
  );

  ipcMain.handle(Channels.AGENT_CHECKPOINT_RESTORE, (_, checkpointId: string) =>
    runtime.restoreCheckpoint(checkpointId),
  );

  ipcMain.handle(Channels.AGENT_SESSION_CAPTURE, (_, note?: string) =>
    runtime.captureSession(note),
  );

  ipcMain.handle(
    Channels.AGENT_SESSION_RESTORE,
    (_, snapshot?: SessionSnapshot | null) => runtime.restoreSession(snapshot),
  );

  // --- Provider handlers ---

  ipcMain.handle(Channels.PROVIDER_LIST, () => {
    return PROVIDERS;
  });

  ipcMain.handle(
    Channels.PROVIDER_UPDATE,
    (_, config: ProviderConfig): ProviderUpdateResult => {
      const normalized = sanitizeProviderConfig(config);
      setSetting("provider", normalized);
      const error = refreshProvider(normalized);

      if (error) {
        return { ok: false, error };
      }

      return { ok: true };
    },
  );

  ipcMain.handle(
    Channels.PROVIDER_FETCH_MODELS,
    async (_, config: ProviderConfig): Promise<ProviderModelsResult> => {
      const normalized = sanitizeProviderConfig(config);

      try {
        const models = await fetchProviderModels(normalized);
        return {
          ok: true,
          models: Array.from(new Set(models)).sort((a, b) =>
            a.localeCompare(b),
          ),
        };
      } catch (error) {
        return {
          ok: false,
          models: [],
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch models from the provider.",
        };
      }
    },
  );

  // --- Bookmark handlers ---

  ipcMain.handle(Channels.BOOKMARKS_GET, () => {
    return bookmarkManager.getState();
  });

  ipcMain.handle(Channels.FOLDER_CREATE, (_, name: string) => {
    const folder = bookmarkManager.createFolder(name);
    sendToRendererViews(Channels.BOOKMARKS_UPDATE, bookmarkManager.getState());
    return folder;
  });

  ipcMain.handle(
    Channels.BOOKMARK_SAVE,
    (_, url: string, title: string, folderId?: string, note?: string) => {
      const bookmark = bookmarkManager.saveBookmark(url, title, folderId, note);
      sendToRendererViews(
        Channels.BOOKMARKS_UPDATE,
        bookmarkManager.getState(),
      );
      return bookmark;
    },
  );

  ipcMain.handle(Channels.BOOKMARK_REMOVE, (_, id: string) => {
    const removed = bookmarkManager.removeBookmark(id);
    if (removed) {
      sendToRendererViews(
        Channels.BOOKMARKS_UPDATE,
        bookmarkManager.getState(),
      );
    }
    return removed;
  });

  ipcMain.handle(Channels.FOLDER_REMOVE, (_, id: string) => {
    const removed = bookmarkManager.removeFolder(id);
    if (removed) {
      sendToRendererViews(
        Channels.BOOKMARKS_UPDATE,
        bookmarkManager.getState(),
      );
    }
    return removed;
  });

  ipcMain.handle(Channels.FOLDER_RENAME, (_, id: string, newName: string) => {
    const folder = bookmarkManager.renameFolder(id, newName);
    if (folder) {
      sendToRendererViews(
        Channels.BOOKMARKS_UPDATE,
        bookmarkManager.getState(),
      );
    }
    return folder;
  });

  // --- Window controls ---

  ipcMain.handle(Channels.WINDOW_MINIMIZE, () => {
    mainWindow.minimize();
  });

  ipcMain.handle(Channels.WINDOW_MAXIMIZE, () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle(Channels.WINDOW_CLOSE, () => {
    mainWindow.close();
  });
}
