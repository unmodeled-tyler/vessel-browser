import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import { extractContent } from "../content/extractor";
import { generateReaderHTML } from "../content/reader-mode";
import { loadSettings, setSetting } from "../config/settings";
import { layoutViews, type WindowState } from "../window";
import { getRuntimeHealth } from "../health/runtime-health";
import type {
  ApprovalMode,
  AgentRuntimeState,
  SessionSnapshot,
} from "../../shared/types";
import type { AgentRuntime } from "../agent/runtime";
import * as bookmarkManager from "../bookmarks/manager";
import * as highlightsManager from "../highlights/manager";
import { highlightOnPage } from "../highlights/inject";
import { startMcpServer, stopMcpServer } from "../mcp/server";

export function registerIpcHandlers(
  windowState: WindowState,
  runtime: AgentRuntime,
): void {
  const { tabManager, chromeView, sidebarView, mainWindow } = windowState;

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
    sendToRendererViews(
      Channels.AI_STREAM_CHUNK,
      [
        "Vessel does not run a locally configured model.",
        "Control it through an external agent harness such as Hermes Agent or OpenClaw.",
        "Use the sidebar here for runtime visibility, approvals, checkpoints, and bookmarks.",
      ].join("\n\n"),
    );
    sendToRendererViews(Channels.AI_STREAM_END);
  });

  ipcMain.handle(Channels.AI_CANCEL, () => undefined);

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

  ipcMain.handle(Channels.SETTINGS_HEALTH_GET, () => getRuntimeHealth());

  ipcMain.handle(Channels.SETTINGS_SET, async (_, key: string, value: any) => {
    const updatedSettings = setSetting(key as any, value);
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
      return bookmarkManager.createFolderWithSummary(name, summary);
    },
  );

  ipcMain.handle(
    Channels.BOOKMARK_SAVE,
    (_, url: string, title: string, folderId?: string, note?: string) =>
      bookmarkManager.saveBookmark(url, title, folderId, note),
  );

  ipcMain.handle(Channels.BOOKMARK_REMOVE, (_, id: string) => {
    return bookmarkManager.removeBookmark(id);
  });

  ipcMain.handle(Channels.FOLDER_REMOVE, (_, id: string) => {
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
      if (wc.isDestroyed()) {
        return { success: false, message: "Tab is not available" };
      }

      const url = wc.getURL();
      if (!url || url === "about:blank") {
        return { success: false, message: "No page loaded" };
      }

      const selectedText: string = await wc.executeJavaScript(`
        (function() {
          var sel = window.getSelection();
          return sel ? sel.toString().trim() : '';
        })()
      `);

      if (!selectedText) {
        return { success: false, message: "No text selected" };
      }

      const capped =
        selectedText.length > 5000 ? selectedText.slice(0, 5000) : selectedText;

      const highlight = highlightsManager.addHighlight(
        url,
        undefined,
        capped,
        undefined,
        "yellow",
        "user",
      );

      await highlightOnPage(wc, null, capped, undefined, undefined, "yellow").catch(
        () => {},
      );

      return { success: true, text: capped, id: highlight.id };
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

      const url = wc.getURL();
      if (!url || url === "about:blank") return;

      const capped = text.length > 5000 ? text.slice(0, 5000) : text;

      const highlight = highlightsManager.addHighlight(
        url,
        undefined,
        capped,
        undefined,
        "yellow",
        "user",
      );

      if (!chromeView.webContents.isDestroyed()) {
        chromeView.webContents.send(Channels.HIGHLIGHT_CAPTURE_RESULT, {
          success: true,
          text: capped,
          id: highlight.id,
        });
      }
    } catch {
      // Silently ignore errors from auto-highlight
    }
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
