import { app, ipcMain, session } from "electron";
import { Channels } from "../../shared/channels";
import { extractContent } from "../content/extractor";
import { generateReaderHTML } from "../content/reader-mode";
import {
  getRendererSettings,
  loadSettings,
  setSetting,
  SETTABLE_KEYS,
} from "../config/settings";
import { layoutViews, resizeSidebarViews, MIN_DEVTOOLS_PANEL, MAX_DEVTOOLS_PANEL, CHROME_HEIGHT, type WindowState } from "../window";
import {
  getRuntimeHealth,
  onRuntimeHealthChange,
} from "../health/runtime-health";
import {
  trackProviderConfigured,
  trackSettingChanged,
  trackApprovalModeChanged,
} from "../telemetry/posthog";
import { createProvider, fetchProviderModels } from "../ai/provider";
import type { AIProvider } from "../ai/provider";
import { handleAIQuery } from "../ai/commands";
import { endAIStream, onAIStreamIdle, tryBeginAIStream } from "../ai/stream-lock";
import type {
  AIMessage,
  ApprovalMode,
  AgentRuntimeState,
  SessionSnapshot,
  TabGroupColor,
  VesselSettings,
  type ClearDataOptions,
} from "../../shared/types";
import { createLogger } from "../../shared/logger";
import { errorResult, getErrorMessage } from "../../shared/result";
import type { AgentRuntime } from "../agent/runtime";
import {
  highlightOnPage,
  getHighlightCount,
  scrollToHighlight,
  removeHighlightAtIndex,
  clearAllHighlightElements,
} from "../highlights/inject";
import { captureSelectionHighlight, persistAndMarkHighlight } from "../highlights/capture";
import { startMcpServer, stopMcpServer } from "../mcp/server";
import {
  getInstalledKits,
  installKitFromFile,
  uninstallKit,
} from "../automation/kit-registry";
import { registerScheduleHandlers, getScheduledKitIds } from "../automation/scheduler";
import {
  assertNumber,
  assertString,
  getActiveTabInfo,
  type SendToRendererViews,
} from "./common";
import { registerAutofillHandlers } from "./autofill";
import { registerPageDiffHandlers } from "./page-diff";
import { registerVaultHandlers } from "./vault";
import { registerHumanVaultHandlers } from "./human-vault";
import { registerWindowControlHandlers } from "./window-controls";
import { createPrivateWindow } from "../private/window";
import { createSecondaryWindow } from "../secondary/window";
import { showTabContextMenu, showGroupContextMenu } from "../tabs/tab-context-menu";
import { createFindInPageBridge } from "../tabs/find-bridge";
import { registerBookmarkHandlers } from "./bookmarks";
import { registerHistoryHandlers } from "./history";
import { registerPremiumHandlers } from "./premium";
import { registerSessionHandlers } from "./sessions";
import { registerSecurityHandlers } from "./security";
import { registerCodexHandlers } from "./codex";
import { clearByTimeRange } from "../history/manager";
import { clearDownloads, listDownloads, openDownload, setDownloadBroadcaster, showDownloadInFolder } from "../network/download-manager";
import { clearPermissions, listPermissions, setPermissionBroadcaster } from "../security/permissions";

let activeChatProvider: AIProvider | null = null;
const logger = createLogger("IPC");

const VALID_APPROVAL_MODES = ["auto", "confirm-dangerous", "manual"] as const;
type ValidApprovalMode = typeof VALID_APPROVAL_MODES[number];

export async function togglePictureInPicture(
  tabManager: WindowState["tabManager"],
): Promise<boolean> {
  const info = getActiveTabInfo(tabManager);
  if (!info) return false;
  const { wc } = info;
  try {
    return await wc.executeJavaScript(`
      (async function() {
        const video = document.querySelector('video');
        if (!video) return false;
        if (!document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== 'function') {
          return false;
        }
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
          return false;
        }
        try {
          await video.requestPictureInPicture();
          return true;
        } catch {
          return false;
        }
      })()
    `);
  } catch {
    return false;
  }
}

export function registerIpcHandlers(
  windowState: WindowState,
  runtime: AgentRuntime,
): void {
  const { tabManager, chromeView, sidebarView, devtoolsPanelView, mainWindow } = windowState;

  // Private browsing
  ipcMain.handle(Channels.OPEN_PRIVATE_WINDOW, () => {
    createPrivateWindow();
  });

  ipcMain.handle(Channels.OPEN_NEW_WINDOW, () => {
    createSecondaryWindow();
  });

  ipcMain.handle(Channels.IS_PRIVATE_MODE, () => false);

  let sidebarResizeRecoveryTimer: NodeJS.Timeout | null = null;
  let sidebarResizeActive = false;
  let runtimeUpdateTimer: NodeJS.Timeout | null = null;
  let pendingRuntimeState: AgentRuntimeState | null = null;

  const clearSidebarResizeRecoveryTimer = () => {
    if (!sidebarResizeRecoveryTimer) return;
    clearTimeout(sidebarResizeRecoveryTimer);
    sidebarResizeRecoveryTimer = null;
  };

  const restoreSidebarLayoutAfterResize = () => {
    clearSidebarResizeRecoveryTimer();
    if (!sidebarResizeActive) return;
    sidebarResizeActive = false;
    layoutViews(windowState);
  };

  const scheduleSidebarResizeRecovery = () => {
    clearSidebarResizeRecoveryTimer();
    sidebarResizeRecoveryTimer = setTimeout(() => {
      restoreSidebarLayoutAfterResize();
    }, 1200);
  };

  const flushRuntimeUpdate = () => {
    runtimeUpdateTimer = null;
    if (!pendingRuntimeState) return;
    if (!chromeView.webContents.isDestroyed()) {
      chromeView.webContents.send(
        Channels.AGENT_RUNTIME_UPDATE,
        pendingRuntimeState,
      );
    }
    if (!sidebarView.webContents.isDestroyed()) {
      sidebarView.webContents.send(
        Channels.AGENT_RUNTIME_UPDATE,
        pendingRuntimeState,
      );
    }
    pendingRuntimeState = null;
  };

  const scheduleRuntimeUpdate = (state: AgentRuntimeState) => {
    pendingRuntimeState = state;
    if (runtimeUpdateTimer) return;
    runtimeUpdateTimer = setTimeout(() => {
      flushRuntimeUpdate();
    }, 32);
  };

  app.on("before-quit", () => {
    if (runtimeUpdateTimer) {
      clearTimeout(runtimeUpdateTimer);
      runtimeUpdateTimer = null;
    }
    flushRuntimeUpdate();
  });

  const sendToRendererViews: SendToRendererViews = (channel, ...args) => {
    chromeView.webContents.send(channel, ...args);
    sidebarView.webContents.send(channel, ...args);
    devtoolsPanelView.webContents.send(channel, ...args);
  };

  const getActiveHighlightCountSafe = async (): Promise<number> => {
    const info = getActiveTabInfo(tabManager);
    if (!info) return 0;
    try {
      return (await getHighlightCount(info.wc)) ?? 0;
    } catch (err) {
      logger.warn("Failed to get active highlight count:", err);
      return 0;
    }
  };

  const emitHighlightCount = async (): Promise<void> => {
    const count = await getActiveHighlightCountSafe();
    sendToRendererViews(Channels.HIGHLIGHT_COUNT_UPDATE, count);
  };

  runtime.setUpdateListener((state: AgentRuntimeState) => {
    scheduleRuntimeUpdate(state);
  });

  onRuntimeHealthChange((health) => {
    sendToRendererViews(Channels.SETTINGS_HEALTH_UPDATE, health);
  });

  onAIStreamIdle(() => {
    sendToRendererViews(Channels.AI_STREAM_IDLE);
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

  ipcMain.handle(
    Channels.TAB_NAVIGATE,
    (_, id: string, url: string, postBody?: Record<string, string>) => {
      assertString(id, "tabId");
      assertString(url, "url");
      return tabManager.navigateTab(id, url, postBody);
    },
  );

  ipcMain.handle(Channels.TAB_BACK, (_, id: string) => {
    tabManager.goBack(id);
  });

  ipcMain.handle(Channels.TAB_FORWARD, (_, id: string) => {
    tabManager.goForward(id);
  });

  ipcMain.handle(Channels.TAB_RELOAD, (_, id: string) => {
    tabManager.reloadTab(id);
  });

  ipcMain.handle(Channels.TAB_TOGGLE_AD_BLOCK, (_, id: string) => {
    assertString(id, "id");
    const tab = tabManager.getTab(id);
    if (!tab) return null;
    const newState = !tab.state.adBlockingEnabled;
    tab.setAdBlockingEnabled(newState);
    return newState;
  });

  ipcMain.handle(Channels.TAB_ZOOM_IN, (_, id: string) => {
    assertString(id, "id");
    tabManager.zoomIn(id);
  });

  ipcMain.handle(Channels.TAB_ZOOM_OUT, (_, id: string) => {
    assertString(id, "id");
    tabManager.zoomOut(id);
  });

  ipcMain.handle(Channels.TAB_ZOOM_RESET, (_, id: string) => {
    assertString(id, "id");
    tabManager.zoomReset(id);
  });

  ipcMain.handle(Channels.TAB_REOPEN_CLOSED, () => {
    const id = tabManager.reopenClosedTab();
    if (id) layoutViews(windowState);
    return id;
  });

  ipcMain.handle(Channels.TAB_DUPLICATE, (_, id: string) => {
    assertString(id, "id");
    const newId = tabManager.duplicateTab(id);
    if (newId) layoutViews(windowState);
    return newId;
  });

  ipcMain.handle(Channels.TAB_PIN, (_, id: string) => {
    assertString(id, "id");
    tabManager.pinTab(id);
  });

  ipcMain.handle(Channels.TAB_UNPIN, (_, id: string) => {
    assertString(id, "id");
    tabManager.unpinTab(id);
  });

  ipcMain.handle(Channels.TAB_GROUP_CREATE, (_, id: string) => {
    assertString(id, "id");
    return tabManager.createGroupFromTab(id);
  });

  ipcMain.handle(Channels.TAB_GROUP_ADD_TAB, (_, id: string, groupId: string) => {
    assertString(id, "id");
    assertString(groupId, "groupId");
    tabManager.assignTabToGroup(id, groupId);
  });

  ipcMain.handle(Channels.TAB_GROUP_REMOVE_TAB, (_, id: string) => {
    assertString(id, "id");
    tabManager.removeTabFromGroup(id);
  });

  ipcMain.handle(Channels.TAB_GROUP_TOGGLE_COLLAPSED, (_, groupId: string) => {
    assertString(groupId, "groupId");
    return tabManager.toggleGroupCollapsed(groupId);
  });

  ipcMain.handle(
    Channels.TAB_GROUP_SET_COLOR,
    (_, groupId: string, color: TabGroupColor) => {
      assertString(groupId, "groupId");
      assertString(color, "color");
      tabManager.setGroupColor(groupId, color);
    },
  );

  ipcMain.handle(Channels.TAB_TOGGLE_MUTE, (_, id: string) => {
    assertString(id, "id");
    return tabManager.toggleMuted(id);
  });

  ipcMain.handle(Channels.TAB_PRINT, (_, id: string) => {
    assertString(id, "id");
    tabManager.printTab(id);
  });

  ipcMain.handle(Channels.TAB_PRINT_TO_PDF, (_, id: string) => {
    assertString(id, "id");
    return tabManager.saveTabAsPdf(id);
  });

  ipcMain.on(Channels.TAB_CONTEXT_MENU, (_event, id: string) => {
    assertString(id, "id");
    showTabContextMenu(tabManager, id, mainWindow, () => layoutViews(windowState));
  });

  ipcMain.on(Channels.TAB_GROUP_CONTEXT_MENU, (_event, groupId: string) => {
    assertString(groupId, "groupId");
    showGroupContextMenu(tabManager, groupId, mainWindow);
  });

  ipcMain.handle(Channels.TAB_STATE_GET, () => ({
    tabs: tabManager.getAllStates(),
    activeId: tabManager.getActiveTabId() || "",
  }));

  // --- AI handlers ---

  ipcMain.handle(Channels.AI_QUERY, async (_, query: string, history?: AIMessage[]) => {
    const settings = loadSettings();
    const chatConfig = settings.chatProvider;

    if (!chatConfig) {
      sendToRendererViews(Channels.AI_STREAM_START, query);
      sendToRendererViews(
        Channels.AI_STREAM_CHUNK,
        "Chat provider not configured. Open Settings (Ctrl+,) to choose a provider.",
      );
      sendToRendererViews(Channels.AI_STREAM_END, "failed");
      return { accepted: true as const };
    }

    if (!tryBeginAIStream("manual")) {
      return { accepted: false as const, reason: "busy" as const };
    }

    sendToRendererViews(Channels.AI_STREAM_START, query);

    // Fire-and-forget: run the stream in the background so the IPC call
    // resolves immediately and the renderer can clear the input field.
    (async () => {
      try {
        activeChatProvider = createProvider(chatConfig);
        trackProviderConfigured(chatConfig.id);
        const activeTab = tabManager.getActiveTab();
        await handleAIQuery(
          query,
          activeChatProvider,
          activeTab?.view.webContents,
          (chunk) => sendToRendererViews(Channels.AI_STREAM_CHUNK, chunk),
          () => sendToRendererViews(Channels.AI_STREAM_END, "completed"),
          tabManager,
          runtime,
          history,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        sendToRendererViews(Channels.AI_STREAM_CHUNK, `\n[Error: ${msg}]`);
        sendToRendererViews(Channels.AI_STREAM_END, "failed");
      } finally {
        activeChatProvider = null;
        endAIStream("manual");
      }
    })();

    return { accepted: true as const };
  });

  ipcMain.handle(Channels.AI_CANCEL, () => {
    activeChatProvider?.cancel();
  });

  ipcMain.handle(Channels.AI_FETCH_MODELS, async (_, config: unknown) => {
    try {
      if (!config || typeof config !== "object" || !("id" in config)) {
        return errorResult("Invalid provider configuration", { models: [] });
      }
      return await fetchProviderModels(
        config as Parameters<typeof fetchProviderModels>[0],
      );
    } catch (err: unknown) {
      return errorResult(getErrorMessage(err), { models: [] });
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

  ipcMain.handle(Channels.SIDEBAR_NAVIGATE, (_, tab: string) => {
    assertString(tab, "tab");
    if (!windowState.uiState.sidebarOpen) {
      windowState.uiState.sidebarOpen = true;
      layoutViews(windowState);
    }
    if (!sidebarView.webContents.isDestroyed()) {
      sidebarView.webContents.send(Channels.SIDEBAR_NAVIGATE, tab);
    }
    return {
      open: windowState.uiState.sidebarOpen,
      width: windowState.uiState.sidebarWidth,
    };
  });

  ipcMain.handle(Channels.SIDEBAR_RESIZE_START, () => {
    sidebarResizeActive = true;
    clearSidebarResizeRecoveryTimer();
    // Position sidebar below chrome bar (like normal layout) but expand width for pointer capture
    const [width, height] = windowState.mainWindow.getContentSize();
    const chromeHeight = windowState.uiState.focusMode ? 0 : CHROME_HEIGHT;
    const sidebarWidth = windowState.uiState.sidebarWidth;
    const resizeHandleOverlap = 6;
    windowState.sidebarView.setBounds({
      x: width - sidebarWidth - resizeHandleOverlap,
      y: chromeHeight,
      width: sidebarWidth + resizeHandleOverlap,
      height: height - chromeHeight,
    });
    scheduleSidebarResizeRecovery();
  });

  ipcMain.handle(Channels.SIDEBAR_RESIZE, (_, width: number) => {
    assertNumber(width, "width");
    const clamped = Math.max(240, Math.min(800, Math.round(width)));
    windowState.uiState.sidebarWidth = clamped;
    resizeSidebarViews(windowState);
    // Note: recovery timer is NOT rescheduled here - only on RESIZE_START
    // This prevents lag during rapid resize movements
    return clamped;
  });

  ipcMain.handle(Channels.SIDEBAR_RESIZE_COMMIT, () => {
    sidebarResizeActive = false;
    clearSidebarResizeRecoveryTimer();
    setSetting("sidebarWidth", windowState.uiState.sidebarWidth);
    layoutViews(windowState);
  });

  ipcMain.on(
    Channels.RENDERER_VIEW_READY,
    (_event, view: "chrome" | "sidebar" | "devtools") => {
      if (view !== "sidebar") return;
      if (!windowState.uiState.sidebarOpen) {
        windowState.uiState.sidebarOpen = true;
        layoutViews(windowState);
      }
    },
  );

  ipcMain.handle(Channels.FOCUS_MODE_TOGGLE, () => {
    windowState.uiState.focusMode = !windowState.uiState.focusMode;
    layoutViews(windowState);
    return windowState.uiState.focusMode;
  });

  ipcMain.handle(Channels.SETTINGS_VISIBILITY, (_, open: boolean) => {
    windowState.uiState.settingsOpen = open;
    if (open) {
      windowState.uiState.sidebarOpen = false;
    }
    layoutViews(windowState);
    return windowState.uiState.settingsOpen;
  });

  // --- Settings handlers ---

  ipcMain.handle(Channels.SETTINGS_GET, () => {
    return getRendererSettings();
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
    const rendererSettings = getRendererSettings();
    sendToRendererViews(Channels.SETTINGS_UPDATE, rendererSettings);
    return rendererSettings;
  });

  // --- Agent runtime handlers ---

  ipcMain.handle(Channels.AGENT_RUNTIME_GET, () => runtime.getState());

  ipcMain.handle(Channels.AGENT_PAUSE, () => runtime.pause());

  ipcMain.handle(Channels.AGENT_RESUME, () => runtime.resume());

  ipcMain.handle(
    Channels.AGENT_SET_APPROVAL_MODE,
    (_, mode: ApprovalMode): AgentRuntimeState => {
      assertString(mode, "mode");
      if (!VALID_APPROVAL_MODES.includes(mode as ValidApprovalMode)) {
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

  ipcMain.handle(Channels.AGENT_CHECKPOINT_UPDATE_NOTE, (_, checkpointId: string, note?: string) =>
    runtime.updateCheckpointNote(checkpointId, note || ""),
  );

  ipcMain.handle(Channels.AGENT_UNDO_LAST_ACTION, () =>
    runtime.undoLastAction(),
  );

  ipcMain.handle(Channels.AGENT_SESSION_CAPTURE, (_, note?: string) =>
    runtime.captureSession(note),
  );

  ipcMain.handle(
    Channels.AGENT_SESSION_RESTORE,
    (_, snapshot?: SessionSnapshot | null) => runtime.restoreSession(snapshot),
  );

  registerBookmarkHandlers();

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
        await highlightOnPage(wc, null, result.text, undefined, undefined, "yellow").catch((err) =>
          logger.warn("Failed to highlight captured selection:", err),
        );
        await emitHighlightCount();
      }
      return result;
    } catch (err) {
      logger.warn("Failed to capture highlight from active tab:", err);
      return { success: false, message: "Could not capture selection" };
    }
  });

  // Forward context-menu highlight captures to the chrome view for toast
  tabManager.onHighlightCapture((result) => {
    if (result.success) {
      void emitHighlightCount();
    }
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
          void emitHighlightCount();
          chromeView.webContents.send(Channels.HIGHLIGHT_CAPTURE_RESULT, result);
        }
      });
    } catch (err) {
      logger.warn("Failed to persist auto-highlight selection:", err);
    }
  });

  // --- Highlight navigation ---

  ipcMain.handle(Channels.HIGHLIGHT_NAV_COUNT, () => {
    return getActiveHighlightCountSafe();
  });

  ipcMain.handle(Channels.HIGHLIGHT_NAV_SCROLL, (_, index: number) => {
    const info = getActiveTabInfo(tabManager);
    if (!info) return false;
    try {
      return scrollToHighlight(info.wc, index);
    } catch (err) {
      logger.warn("Failed to scroll to highlight:", err);
      return false;
    }
  });

  ipcMain.handle(Channels.HIGHLIGHT_NAV_REMOVE, async (_, index: number) => {
    const info = getActiveTabInfo(tabManager);
    if (!info) return false;
    try {
      const removed = await removeHighlightAtIndex(info.wc, index);
      if (removed) {
        await emitHighlightCount();
      }
      return removed;
    } catch (err) {
      logger.warn("Failed to remove highlight at index:", err);
      return false;
    }
  });

  ipcMain.handle(Channels.HIGHLIGHT_NAV_CLEAR, async () => {
    const info = getActiveTabInfo(tabManager);
    if (!info) return false;
    try {
      const cleared = await clearAllHighlightElements(info.wc);
      if (cleared) {
        await emitHighlightCount();
      }
      return cleared;
    } catch (err) {
      logger.warn("Failed to clear highlight elements:", err);
      return false;
    }
  });

  // --- Find in page ---

  const findBridge = createFindInPageBridge(tabManager, chromeView);

  ipcMain.handle(Channels.FIND_IN_PAGE_START, (_, text: string, options?: { forward?: boolean; findNext?: boolean }) => {
    return findBridge.start(text, options);
  });

  ipcMain.handle(Channels.FIND_IN_PAGE_NEXT, (_, forward?: boolean) => {
    return findBridge.next(forward);
  });

  ipcMain.handle(Channels.FIND_IN_PAGE_STOP, (_, action?: "clearSelection" | "keepSelection" | "activateSelection") => {
    findBridge.stop(action);
  });

  registerHistoryHandlers();

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

  // --- Security indicator ---

  registerSecurityHandlers(tabManager);

  // --- Premium subscription ---

  registerPremiumHandlers(tabManager, sendToRendererViews);

  // --- Named sessions ---

  registerSessionHandlers(tabManager);

  registerVaultHandlers();

  registerHumanVaultHandlers();

  registerWindowControlHandlers(mainWindow);

  registerCodexHandlers();

  // --- Automation kits ---

  ipcMain.handle(Channels.AUTOMATION_GET_INSTALLED, () => {
    return getInstalledKits();
  });

  ipcMain.handle(Channels.AUTOMATION_INSTALL_FROM_FILE, async () => {
    return await installKitFromFile();
  });

  ipcMain.handle(Channels.AUTOMATION_UNINSTALL, (_event, id: unknown) => {
    assertString(id, "id");
    return uninstallKit(id, getScheduledKitIds());
  });

  // --- Scheduled jobs ---

  registerScheduleHandlers(windowState, runtime, sendToRendererViews);

  registerAutofillHandlers(windowState);
  registerPageDiffHandlers(windowState, sendToRendererViews);

  // --- Clear browsing data ---

  ipcMain.handle(Channels.CLEAR_BROWSING_DATA, async (_, options: ClearDataOptions) => {
    const { cache, cookies, history, localStorage: clearLs, timeRange } = options;

    // Note: cache and cookies/storage clearing ignore timeRange — Electron's
    // APIs don't support time-range filtering for these. Only history respects it.
    if (cache) {
      await session.defaultSession.clearCache();
    }

    const storages: Array<"cookies" | "localstorage"> = [];
    if (cookies) storages.push("cookies");
    if (clearLs) storages.push("localstorage");

    if (storages.length > 0) {
      await session.defaultSession.clearStorageData({ storages });
    }

    if (history) {
      clearByTimeRange(timeRange);
    }
  });

  // --- Picture-in-Picture ---

  setDownloadBroadcaster(sendToRendererViews);
  setPermissionBroadcaster(sendToRendererViews);
  ipcMain.handle(Channels.DOWNLOADS_GET, () => listDownloads());
  ipcMain.handle(Channels.DOWNLOADS_CLEAR, () => {
    clearDownloads();
    return true;
  });
  ipcMain.handle(Channels.DOWNLOADS_OPEN, (_event, id: string) => openDownload(id));
  ipcMain.handle(Channels.DOWNLOADS_SHOW_IN_FOLDER, (_event, id: string) => showDownloadInFolder(id));
  ipcMain.handle(Channels.PERMISSIONS_GET, () => listPermissions());
  ipcMain.handle(Channels.PERMISSIONS_CLEAR, () => {
    clearPermissions();
    return true;
  });

  ipcMain.handle(Channels.TAB_TOGGLE_PIP, async () => {
    return togglePictureInPicture(tabManager);
  });
}
