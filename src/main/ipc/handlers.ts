import { ipcMain, BaseWindow } from 'electron';
import { Channels } from '../../shared/channels';
import { TabManager } from '../tabs/tab-manager';
import { ClaudeClient } from '../ai/claude-client';
import { handleAIQuery } from '../ai/commands';
import { extractContent } from '../content/extractor';
import { generateReaderHTML } from '../content/reader-mode';
import { loadSettings, setSetting } from '../config/settings';
import { layoutViews, type WindowState } from '../window';
import type { WebContentsView } from 'electron';

export function registerIpcHandlers(
  windowState: WindowState,
): void {
  const { tabManager, chromeView, mainWindow } = windowState;
  let claudeClient: ClaudeClient | null = null;

  const settings = loadSettings();
  if (settings.apiKey) {
    claudeClient = new ClaudeClient(settings.apiKey);
  }

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
    if (!claudeClient) {
      chromeView.webContents.send(
        Channels.AI_STREAM_CHUNK,
        'Please set your Claude API key in settings (Ctrl+,)',
      );
      chromeView.webContents.send(Channels.AI_STREAM_END);
      return;
    }

    const activeTab = tabManager.getActiveTab();
    const activeWebContents = activeTab?.view.webContents;

    await handleAIQuery(
      query,
      claudeClient,
      activeWebContents,
      (chunk) => chromeView.webContents.send(Channels.AI_STREAM_CHUNK, chunk),
      () => chromeView.webContents.send(Channels.AI_STREAM_END),
    );
  });

  ipcMain.handle(Channels.AI_CANCEL, () => {
    claudeClient?.cancel();
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
    setSetting('sidebarWidth', clamped);
    layoutViews(windowState);
    return clamped;
  });

  ipcMain.handle(Channels.FOCUS_MODE_TOGGLE, () => {
    windowState.uiState.focusMode = !windowState.uiState.focusMode;
    layoutViews(windowState);
    return windowState.uiState.focusMode;
  });

  // --- Settings handlers ---

  ipcMain.handle(Channels.SETTINGS_GET, () => {
    return loadSettings();
  });

  ipcMain.handle(Channels.SETTINGS_SET, (_, key: string, value: any) => {
    setSetting(key as any, value);
    if (key === 'apiKey') {
      if (value) {
        if (claudeClient) {
          claudeClient.updateApiKey(value);
        } else {
          claudeClient = new ClaudeClient(value);
        }
      }
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
