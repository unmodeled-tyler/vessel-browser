import { app, ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import { extractContent } from "../content/extractor";
import * as historyManager from "../history/manager";
import { generateReaderHTML } from "../content/reader-mode";
import {
  getRendererSettings,
  loadSettings,
  setSetting,
  SETTABLE_KEYS,
} from "../config/settings";
import { layoutViews, resizeSidebarViews, MIN_DEVTOOLS_PANEL, MAX_DEVTOOLS_PANEL, type WindowState } from "../window";
import {
  getRuntimeHealth,
  onRuntimeHealthChange,
} from "../health/runtime-health";
import {
  getPremiumState,
  getCheckoutUrl,
  getPortalUrl,
  resetPremium,
  requestActivationCode,
  verifyActivationCode,
  verifySubscription,
  isPremiumActiveState,
} from "../premium/manager";
import {
  trackProviderConfigured,
  trackSettingChanged,
  trackApprovalModeChanged,
  trackBookmarkAction,
  trackPremiumFunnel,
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
import {
  getInstalledKits,
  installKitFromFile,
  uninstallKit,
} from "../automation/kit-registry";
import { registerScheduleHandlers, getScheduledKitIds } from "../automation/scheduler";
import {
  assertNumber,
  assertString,
  type SendToRendererViews,
} from "./common";
import { registerAutofillHandlers } from "./autofill";
import { registerPageDiffHandlers } from "./page-diff";
import {
  listNamedSessions,
  saveNamedSession,
  loadNamedSession,
  deleteNamedSession,
} from "../sessions/manager";
import { registerVaultHandlers } from "./vault";
import { registerWindowControlHandlers } from "./window-controls";

let activeChatProvider: AIProvider | null = null;

const VALID_APPROVAL_MODES = ["auto", "confirm-dangerous", "manual"] as const;
type ValidApprovalMode = typeof VALID_APPROVAL_MODES[number];

export function registerIpcHandlers(
  windowState: WindowState,
  runtime: AgentRuntime,
): void {
  const { tabManager, chromeView, sidebarView, devtoolsPanelView, mainWindow } = windowState;
  let sidebarResizeRecoveryTimer: NodeJS.Timeout | null = null;
  let sidebarResizeActive = false;
  let runtimeUpdateTimer: NodeJS.Timeout | null = null;
  let pendingRuntimeState: AgentRuntimeState | null = null;
  const premiumApiOrigin =
    process.env.VESSEL_PREMIUM_API
      ? new URL(process.env.VESSEL_PREMIUM_API).origin
      : "https://vesselpremium.quantaintellect.com";

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

  const watchPremiumCheckoutTab = (tabId: string) => {
    const tab = tabManager.getTab(tabId);
    const wc = tab?.view.webContents;
    if (!wc) return;

    let completed = false;

    const cleanup = () => {
      wc.removeListener("did-navigate", onNavigate);
      wc.removeListener("did-navigate-in-page", onNavigateInPage);
      wc.removeListener("destroyed", cleanup);
    };

    const handleUrl = async (rawUrl: string) => {
      if (completed) return;

      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return;
      }

      if (parsed.origin !== premiumApiOrigin) return;

      if (parsed.pathname === "/canceled") {
        completed = true;
        trackPremiumFunnel("checkout_canceled");
        cleanup();
        return;
      }

      if (parsed.pathname !== "/success") return;

      completed = true;
      trackPremiumFunnel("checkout_success_seen");

      const sessionId = parsed.searchParams.get("session_id")?.trim();
      if (!sessionId) {
        trackPremiumFunnel("auto_activation_failed", {
          reason: "missing_session_id",
        });
        cleanup();
        return;
      }

      trackPremiumFunnel("auto_activation_attempted");
      const state = await verifySubscription(sessionId);
      if (isPremiumActiveState(state)) {
        sendToRendererViews(Channels.PREMIUM_UPDATE, state);
        trackPremiumFunnel("auto_activation_succeeded", {
          status: state.status,
        });
      } else {
        trackPremiumFunnel("auto_activation_failed", {
          status: state.status,
        });
      }
      cleanup();
    };

    const onNavigate = (_event: unknown, url: string) => {
      void handleUrl(url);
    };

    const onNavigateInPage = (
      _event: unknown,
      url: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      void handleUrl(url);
    };

    wc.on("did-navigate", onNavigate);
    wc.on("did-navigate-in-page", onNavigateInPage);
    wc.on("destroyed", cleanup);

    const currentUrl = wc.getURL();
    if (currentUrl) {
      void handleUrl(currentUrl);
    }
  };

  const getActiveHighlightCountSafe = async (): Promise<number> => {
    const tab = tabManager.getActiveTab();
    if (!tab) return 0;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return 0;
    try {
      return (await getHighlightCount(wc)) ?? 0;
    } catch {
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
        return { ok: false, models: [], error: "Invalid provider configuration" };
      }
      return await fetchProviderModels(
        config as Parameters<typeof fetchProviderModels>[0],
      );
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
    sidebarResizeActive = true;
    clearSidebarResizeRecoveryTimer();
    // Position sidebar below chrome bar (like normal layout) but expand width for pointer capture
    const [width, height] = windowState.mainWindow.getContentSize();
    const chromeHeight = windowState.uiState.focusMode ? 0 : 110; // CHROME_HEIGHT
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
    (
      _,
      url: string,
      title: string,
      folderId?: string,
      note?: string,
      intent?: string,
      expectedContent?: string,
      keyFields?: string[],
      agentHints?: Record<string, string>,
    ) => {
      trackBookmarkAction("save");
      return bookmarkManager.saveBookmarkWithPolicy(url, title, folderId, note, {
        extra: {
          intent: intent?.trim() || undefined,
          expectedContent: expectedContent?.trim() || undefined,
          keyFields,
          agentHints,
        },
      });
    },
  );

  ipcMain.handle(Channels.BOOKMARK_REMOVE, (_, id: string) => {
    trackBookmarkAction("remove");
    return bookmarkManager.removeBookmark(id);
  });

  ipcMain.handle(Channels.FOLDER_REMOVE, (_, id: string, deleteContents?: boolean) => {
    trackBookmarkAction("folder_remove");
    return bookmarkManager.removeFolder(id, deleteContents ?? false);
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
        await emitHighlightCount();
      }
      return result;
    } catch {
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
    } catch {
      // Silently ignore errors from auto-highlight
    }
  });

  // --- Highlight navigation ---

  ipcMain.handle(Channels.HIGHLIGHT_NAV_COUNT, () => {
    return getActiveHighlightCountSafe();
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

  ipcMain.handle(Channels.HIGHLIGHT_NAV_REMOVE, async (_, index: number) => {
    const tab = tabManager.getActiveTab();
    if (!tab) return false;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return false;
    try {
      const removed = await removeHighlightAtIndex(wc, index);
      if (removed) {
        await emitHighlightCount();
      }
      return removed;
    } catch {
      return false;
    }
  });

  ipcMain.handle(Channels.HIGHLIGHT_NAV_CLEAR, async () => {
    const tab = tabManager.getActiveTab();
    if (!tab) return false;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return false;
    try {
      const cleared = await clearAllHighlightElements(wc);
      if (cleared) {
        await emitHighlightCount();
      }
      return cleared;
    } catch {
      return false;
    }
  });

  // --- Find in page ---

  let findWiredWcId: number | null = null;
  let findResultListener:
    | ((event: Electron.Event, result: Electron.Result) => void)
    | null = null;

  function wireFindEvents(wc: Electron.WebContents): void {
    if (findWiredWcId === wc.id) return;
    if (findWiredWcId !== null && findResultListener) {
      const prev = tabManager.findTabByWebContentsId(findWiredWcId);
      const prevWc = prev?.view.webContents;
      if (prevWc && !prevWc.isDestroyed()) {
        prevWc.removeListener("found-in-page", findResultListener);
      }
    }
    findWiredWcId = wc.id;
    if (wc.isDestroyed()) return;

    const listener = (_event: Electron.Event, result: Electron.Result) => {
      if (!chromeView.webContents.isDestroyed()) {
        chromeView.webContents.send(Channels.FIND_IN_PAGE_RESULT, result);
      }
    };
    findResultListener = listener;
    wc.on("found-in-page", listener);
    // Capture wcId to avoid accessing destroyed wc.id in the handler
    const capturedWcId = wc.id;
    wc.once("destroyed", () => {
      if (findWiredWcId === capturedWcId) {
        findWiredWcId = null;
        findResultListener = null;
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
    wireFindEvents(wc);
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

  ipcMain.handle(Channels.PREMIUM_ACTIVATION_START, async (_, email: string) => {
    assertString(email, "email");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return { ok: false, error: "Invalid email format" };
    }
    trackPremiumFunnel("activation_attempted");
    const result = await requestActivationCode(email);
    if (!result.ok) {
      trackPremiumFunnel("activation_failed");
    }
    return result;
  });

  ipcMain.handle(
    Channels.PREMIUM_ACTIVATION_VERIFY,
    async (_, email: string, code: string, challengeToken: string) => {
      assertString(email, "email");
      assertString(code, "code");
      assertString(challengeToken, "challengeToken");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return {
          ok: false,
          state: getPremiumState(),
          error: "Invalid email format",
        };
      }
      trackPremiumFunnel("activation_attempted");
      const result = await verifyActivationCode(email, code, challengeToken);
      if (result.ok) {
        trackPremiumFunnel("activation_succeeded", {
          status: result.state.status,
        });
        sendToRendererViews(Channels.PREMIUM_UPDATE, result.state);
      } else {
        trackPremiumFunnel("activation_failed", { status: result.state.status });
      }
      return result;
    },
  );

  ipcMain.handle(Channels.PREMIUM_CHECKOUT, async (_, email?: string) => {
    trackPremiumFunnel("checkout_clicked");
    const result = await getCheckoutUrl(email);
    if (result.ok && result.url) {
      const tabId = tabManager.createTab(result.url);
      watchPremiumCheckoutTab(tabId);
    }
    return result;
  });

  ipcMain.handle(Channels.PREMIUM_RESET, () => {
    trackPremiumFunnel("reset");
    const state = resetPremium();
    sendToRendererViews(Channels.PREMIUM_UPDATE, state);
    return state;
  });

  const PREMIUM_TRACKABLE_STEPS = [
    "chat_banner_viewed",
    "chat_banner_clicked",
    "settings_banner_viewed",
    "settings_banner_clicked",
    "welcome_banner_clicked",
    "premium_gate_seen",
    "premium_gate_clicked",
    "iteration_limit_seen",
    "iteration_limit_clicked",
  ] as const;
  type PremiumTrackableStep = typeof PREMIUM_TRACKABLE_STEPS[number];

  ipcMain.handle(Channels.PREMIUM_TRACK_CONTEXT, (_, step: string) => {
    assertString(step, "step");
    if (PREMIUM_TRACKABLE_STEPS.includes(step as PremiumTrackableStep)) {
      trackPremiumFunnel(step as PremiumTrackableStep);
    }
  });

  ipcMain.handle(Channels.PREMIUM_PORTAL, async () => {
    trackPremiumFunnel("portal_opened");
    const result = await getPortalUrl();
    if (result.ok && result.url) {
      tabManager.createTab(result.url);
    }
    return result;
  });

  // --- Named sessions ---

  ipcMain.handle(Channels.SESSION_LIST, () => {
    return listNamedSessions();
  });

  ipcMain.handle(Channels.SESSION_SAVE, async (_, name: string) => {
    assertString(name, "name");
    return await saveNamedSession(tabManager, name);
  });

  ipcMain.handle(Channels.SESSION_LOAD, async (_, name: string) => {
    assertString(name, "name");
    return await loadNamedSession(tabManager, name);
  });

  ipcMain.handle(Channels.SESSION_DELETE, (_, name: string) => {
    assertString(name, "name");
    return deleteNamedSession(name);
  });

  registerVaultHandlers();

  registerWindowControlHandlers(mainWindow);

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
}
