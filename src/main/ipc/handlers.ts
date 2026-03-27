import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import { extractContent } from "../content/extractor";
import * as historyManager from "../history/manager";
import { generateReaderHTML } from "../content/reader-mode";
import { loadSettings, setSetting, SETTABLE_KEYS } from "../config/settings";
import { layoutViews, resizeSidebarViews, MIN_DEVTOOLS_PANEL, MAX_DEVTOOLS_PANEL, type WindowState } from "../window";
import { getRuntimeHealth } from "../health/runtime-health";
import {
  getPremiumState,
  activateWithEmail,
  getCheckoutUrl,
  getPortalUrl,
  resetPremium,
} from "../premium/manager";
import * as vaultManager from "../vault/manager";
import { readAuditLog } from "../vault/audit";
import {
  trackProviderConfigured,
  trackSettingChanged,
  trackApprovalModeChanged,
  trackBookmarkAction,
  trackVaultAction,
  trackPremiumFunnel,
} from "../telemetry/posthog";
import { createProvider, fetchProviderModels } from "../ai/provider";
import type { AIProvider } from "../ai/provider";
import { handleAIQuery } from "../ai/commands";
import type {
  AIMessage,
  ApprovalMode,
  AgentRuntimeState,
  SessionSnapshot,
  VesselSettings,
} from "../../shared/types";
import type { AgentRuntime } from "../agent/runtime";
import * as bookmarkManager from "../bookmarks/manager";
import * as highlightsManager from "../highlights/manager";
import {
  highlightOnPage,
  getHighlightCount,
  scrollToHighlight,
  removeHighlightAtIndex,
  clearAllHighlightElements,
} from "../highlights/inject";
import { captureSelectionHighlight, persistAndMarkHighlight } from "../highlights/capture";
import { startMcpServer, stopMcpServer } from "../mcp/server";

let activeChatProvider: AIProvider | null = null;

// --- IPC input validation helpers ---

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
}

function assertOptionalString(value: unknown, name: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") throw new Error(`${name} must be a string`);
}

function assertNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || Number.isNaN(value)) throw new Error(`${name} must be a number`);
}

const VALID_APPROVAL_MODES = new Set(["auto", "confirm-dangerous", "manual"]);

export function registerIpcHandlers(
  windowState: WindowState,
  runtime: AgentRuntime,
): void {
  const { tabManager, chromeView, sidebarView, devtoolsPanelView, mainWindow } = windowState;

  const sendToRendererViews = (channel: string, ...args: unknown[]) => {
    chromeView.webContents.send(channel, ...args);
    sidebarView.webContents.send(channel, ...args);
    devtoolsPanelView.webContents.send(channel, ...args);
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
    assertString(id, "tabId");
    assertString(url, "url");
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

  ipcMain.handle(Channels.AI_QUERY, async (_, query: string, history?: AIMessage[]) => {
    const settings = loadSettings();
    const chatConfig = settings.chatProvider;

    sendToRendererViews(Channels.AI_STREAM_START, query);

    if (!chatConfig) {
      sendToRendererViews(
        Channels.AI_STREAM_CHUNK,
        "Chat provider not configured. Open Settings (Ctrl+,) to choose a provider.",
      );
      sendToRendererViews(Channels.AI_STREAM_END);
      return;
    }

    try {
      activeChatProvider = createProvider(chatConfig);
      trackProviderConfigured(chatConfig.id);
      const activeTab = tabManager.getActiveTab();
      await handleAIQuery(
        query,
        activeChatProvider,
        activeTab?.view.webContents,
        (chunk) => sendToRendererViews(Channels.AI_STREAM_CHUNK, chunk),
        () => sendToRendererViews(Channels.AI_STREAM_END),
        tabManager,
        runtime,
        history,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      sendToRendererViews(Channels.AI_STREAM_CHUNK, `\n[Error: ${msg}]`);
      sendToRendererViews(Channels.AI_STREAM_END);
    } finally {
      activeChatProvider = null;
    }
  });

  ipcMain.handle(Channels.AI_CANCEL, () => {
    activeChatProvider?.cancel();
  });

  ipcMain.handle(Channels.AI_FETCH_MODELS, async (_, config: unknown) => {
    try {
      if (!config || typeof config !== "object" || !("id" in config)) {
        return { ok: false, models: [], error: "Invalid provider configuration" };
      }
      const models = await fetchProviderModels(config as Parameters<typeof fetchProviderModels>[0]);
      return { ok: true, models };
    } catch (err: unknown) {
      return { ok: false, models: [], error: err instanceof Error ? err.message : "Unknown error" };
    }
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

    if (activeTab.state.isReaderMode) {
      const originalUrl = activeTab.readerOriginalUrl;
      activeTab.setReaderMode(false);
      if (originalUrl) {
        activeTab.view.webContents.loadURL(originalUrl);
      }
    } else {
      const originalUrl = activeTab.state.url;
      const content = await extractContent(activeTab.view.webContents);
      const html = generateReaderHTML(content);
      activeTab.setReaderMode(true, originalUrl);
      activeTab.view.webContents.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
      );
    }
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

  ipcMain.handle(Channels.SIDEBAR_RESIZE_START, () => {
    // Expand sidebar view to full window width so pointer capture works across the drag range
    const [width, height] = windowState.mainWindow.getContentSize();
    windowState.sidebarView.setBounds({ x: 0, y: 0, width, height });
  });

  ipcMain.handle(Channels.SIDEBAR_RESIZE, (_, width: number) => {
    assertNumber(width, "width");
    const clamped = Math.max(240, Math.min(800, Math.round(width)));
    windowState.uiState.sidebarWidth = clamped;
    return clamped;
  });

  ipcMain.handle(Channels.SIDEBAR_RESIZE_COMMIT, () => {
    setSetting("sidebarWidth", windowState.uiState.sidebarWidth);
    layoutViews(windowState);
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

  ipcMain.handle(Channels.SETTINGS_HEALTH_GET, () => getRuntimeHealth());

  ipcMain.handle(Channels.SETTINGS_SET, async (_, key: string, value: unknown) => {
    assertString(key, "key");
    if (!SETTABLE_KEYS.has(key)) {
      throw new Error(`Unknown setting key: ${key}`);
    }
    const settingsKey = key as keyof VesselSettings;
    const updatedSettings = setSetting(settingsKey, value as VesselSettings[typeof settingsKey]);
    trackSettingChanged(key);
    if (key === "approvalMode") {
      runtime.setApprovalMode(value as ApprovalMode);
    }
    if (key === "mcpPort") {
      await stopMcpServer();
      await startMcpServer(tabManager, runtime, updatedSettings.mcpPort);
    }
    sendToRendererViews(Channels.SETTINGS_UPDATE, updatedSettings);
    return updatedSettings;
  });

  // --- Agent runtime handlers ---

  ipcMain.handle(Channels.AGENT_RUNTIME_GET, () => runtime.getState());

  ipcMain.handle(Channels.AGENT_PAUSE, () => runtime.pause());

  ipcMain.handle(Channels.AGENT_RESUME, () => runtime.resume());

  ipcMain.handle(
    Channels.AGENT_SET_APPROVAL_MODE,
    (_, mode: ApprovalMode): AgentRuntimeState => {
      assertString(mode, "mode");
      if (!VALID_APPROVAL_MODES.has(mode)) {
        throw new Error(`Invalid approval mode: ${mode}`);
      }
      trackApprovalModeChanged(mode);
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

  // --- Bookmark handlers ---

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
    (_, url: string, title: string, folderId?: string, note?: string) => {
      trackBookmarkAction("save");
      return bookmarkManager.saveBookmark(url, title, folderId, note);
    },
  );

  ipcMain.handle(Channels.BOOKMARK_REMOVE, (_, id: string) => {
    trackBookmarkAction("remove");
    return bookmarkManager.removeBookmark(id);
  });

  ipcMain.handle(Channels.FOLDER_REMOVE, (_, id: string) => {
    trackBookmarkAction("folder_remove");
    return bookmarkManager.removeFolder(id);
  });

  ipcMain.handle(
    Channels.FOLDER_RENAME,
    (_, id: string, newName: string, summary?: string) => {
      return bookmarkManager.renameFolder(id, newName, summary);
    },
  );

  // --- Highlight capture (user Ctrl+H) ---

  // Handle capture from chrome keybinding (when chrome view has focus)
  ipcMain.handle(Channels.HIGHLIGHT_CAPTURE, async () => {
    try {
      const activeTab = tabManager.getActiveTab();
      if (!activeTab) {
        return { success: false, message: "No active tab" };
      }
      const wc = activeTab.view.webContents;
      const result = await captureSelectionHighlight(wc);
      if (result.success && result.text) {
        await highlightOnPage(wc, null, result.text, undefined, undefined, "yellow").catch(() => {});
      }
      return result;
    } catch {
      return { success: false, message: "Could not capture selection" };
    }
  });

  // Forward context-menu highlight captures to the chrome view for toast
  tabManager.onHighlightCapture((result) => {
    if (!chromeView.webContents.isDestroyed()) {
      chromeView.webContents.send(Channels.HIGHLIGHT_CAPTURE_RESULT, result);
    }
  });

  // Handle auto-highlight selections from highlight mode (sent from page via preload)
  // Visual marking is already done in-page by the mouseup handler — this just persists
  ipcMain.on(Channels.HIGHLIGHT_SELECTION, (event, text: string) => {
    try {
      const wc = event.sender;
      if (wc.isDestroyed()) return;

      const tab = tabManager.findTabByWebContentsId(wc.id);
      if (!tab || !tab.highlightModeActive) return;

      void persistAndMarkHighlight(wc, text).then((result) => {
        if (result.success && !chromeView.webContents.isDestroyed()) {
          chromeView.webContents.send(Channels.HIGHLIGHT_CAPTURE_RESULT, result);
        }
      });
    } catch {
      // Silently ignore errors from auto-highlight
    }
  });

  // --- Highlight navigation ---

  ipcMain.handle(Channels.HIGHLIGHT_NAV_COUNT, () => {
    const tab = tabManager.getActiveTab();
    if (!tab) return 0;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return 0;
    try {
      return getHighlightCount(wc);
    } catch {
      return 0;
    }
  });

  ipcMain.handle(Channels.HIGHLIGHT_NAV_SCROLL, (_, index: number) => {
    const tab = tabManager.getActiveTab();
    if (!tab) return false;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return false;
    try {
      return scrollToHighlight(wc, index);
    } catch {
      return false;
    }
  });

  ipcMain.handle(Channels.HIGHLIGHT_NAV_REMOVE, (_, index: number) => {
    const tab = tabManager.getActiveTab();
    if (!tab) return false;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return false;
    try {
      return removeHighlightAtIndex(wc, index);
    } catch {
      return false;
    }
  });

  ipcMain.handle(Channels.HIGHLIGHT_NAV_CLEAR, () => {
    const tab = tabManager.getActiveTab();
    if (!tab) return false;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return false;
    try {
      return clearAllHighlightElements(wc);
    } catch {
      return false;
    }
  });

  // --- Find in page ---

  let findWiredWcId: number | null = null;

  function wireFindEvents(wc: Electron.WebContents): void {
    if (findWiredWcId === wc.id) return;
    // Clean up previous listener
    if (findWiredWcId !== null) {
      const prev = tabManager.findTabByWebContentsId(findWiredWcId);
      if (prev) prev.view.webContents.removeAllListeners("found-in-page");
    }
    findWiredWcId = wc.id;
    wc.on("found-in-page", (_event, result) => {
      if (!chromeView.webContents.isDestroyed()) {
        chromeView.webContents.send(Channels.FIND_IN_PAGE_RESULT, result);
      }
    });
  }

  ipcMain.handle(Channels.FIND_IN_PAGE_START, (_, text: string, options?: { forward?: boolean; findNext?: boolean }) => {
    const tab = tabManager.getActiveTab();
    if (!tab) return null;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return null;
    wireFindEvents(wc);
    return wc.findInPage(text, {
      forward: options?.forward ?? true,
      findNext: options?.findNext ?? false,
    });
  });

  ipcMain.handle(Channels.FIND_IN_PAGE_NEXT, (_, forward?: boolean) => {
    const tab = tabManager.getActiveTab();
    if (!tab) return null;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return null;
    return wc.findInPage("", { forward: forward ?? true, findNext: true });
  });

  ipcMain.handle(Channels.FIND_IN_PAGE_STOP, (_, action?: "clearSelection" | "keepSelection" | "activateSelection") => {
    const tab = tabManager.getActiveTab();
    if (!tab) return;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    wc.stopFindInPage(action ?? "clearSelection");
  });

  // --- Browsing history ---

  ipcMain.handle(Channels.HISTORY_GET, () => {
    return historyManager.getState();
  });

  ipcMain.handle(Channels.HISTORY_SEARCH, (_, query: string) => {
    return historyManager.search(query);
  });

  ipcMain.handle(Channels.HISTORY_CLEAR, () => {
    historyManager.clearAll();
  });

  // --- DevTools panel ---

  ipcMain.handle(Channels.DEVTOOLS_PANEL_TOGGLE, () => {
    windowState.uiState.devtoolsPanelOpen = !windowState.uiState.devtoolsPanelOpen;
    layoutViews(windowState);
    return { open: windowState.uiState.devtoolsPanelOpen };
  });

  ipcMain.handle(Channels.DEVTOOLS_PANEL_RESIZE, (_, height: number) => {
    const clamped = Math.max(MIN_DEVTOOLS_PANEL, Math.min(MAX_DEVTOOLS_PANEL, Math.round(height)));
    windowState.uiState.devtoolsPanelHeight = clamped;
    layoutViews(windowState);
    return clamped;
  });

  // --- Premium subscription ---

  ipcMain.handle(Channels.PREMIUM_GET_STATE, () => {
    return getPremiumState();
  });

  ipcMain.handle(Channels.PREMIUM_ACTIVATE, async (_, email: string) => {
    assertString(email, "email");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return { ok: false, state: getPremiumState(), error: "Invalid email format" };
    }
    trackPremiumFunnel("activation_attempted");
    const result = await activateWithEmail(email);
    if (result.ok) {
      trackPremiumFunnel("activation_succeeded", { status: result.state.status });
      sendToRendererViews(Channels.PREMIUM_UPDATE, result.state);
    } else {
      trackPremiumFunnel("activation_failed", { status: result.state.status });
    }
    return result;
  });

  ipcMain.handle(Channels.PREMIUM_CHECKOUT, async (_, email?: string) => {
    trackPremiumFunnel("checkout_clicked");
    const result = await getCheckoutUrl(email);
    if (result.ok && result.url) {
      tabManager.createTab(result.url);
    }
    return result;
  });

  ipcMain.handle(Channels.PREMIUM_RESET, () => {
    trackPremiumFunnel("reset");
    const state = resetPremium();
    sendToRendererViews(Channels.PREMIUM_UPDATE, state);
    return state;
  });

  ipcMain.handle(Channels.PREMIUM_PORTAL, async () => {
    trackPremiumFunnel("portal_opened");
    const result = await getPortalUrl();
    if (result.ok && result.url) {
      tabManager.createTab(result.url);
    }
    return result;
  });

  // --- Agent Credential Vault ---

  ipcMain.handle(Channels.VAULT_LIST, () => {
    return vaultManager.listEntries();
  });

  ipcMain.handle(
    Channels.VAULT_ADD,
    (_, entry: { label: string; domainPattern: string; username: string; password: string; totpSecret?: string; notes?: string }) => {
      if (!entry || typeof entry !== "object") throw new Error("Invalid vault entry");
      assertString(entry.label, "label");
      assertString(entry.domainPattern, "domainPattern");
      assertString(entry.username, "username");
      assertString(entry.password, "password");
      if (!entry.label.trim() || !entry.domainPattern.trim() || !entry.username.trim() || !entry.password.trim()) {
        throw new Error("Label, domain, username, and password are required");
      }
      assertOptionalString(entry.totpSecret, "totpSecret");
      assertOptionalString(entry.notes, "notes");
      trackVaultAction("credential_added");
      const created = vaultManager.addEntry(entry);
      return { id: created.id, label: created.label, domainPattern: created.domainPattern, username: created.username };
    },
  );

  ipcMain.handle(
    Channels.VAULT_UPDATE,
    (_, id: string, updates: Partial<{ label: string; domainPattern: string; username: string; password: string; totpSecret: string; notes: string }>) => {
      assertString(id, "id");
      if (!updates || typeof updates !== "object") throw new Error("Invalid updates");
      return vaultManager.updateEntry(id, updates) !== null;
    },
  );

  ipcMain.handle(Channels.VAULT_REMOVE, (_, id: string) => {
    assertString(id, "id");
    trackVaultAction("credential_removed");
    return vaultManager.removeEntry(id);
  });

  ipcMain.handle(Channels.VAULT_AUDIT_LOG, (_, limit?: number) => {
    return readAuditLog(limit);
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
