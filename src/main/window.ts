import { BaseWindow, WebContentsView, app } from "electron";
import { existsSync } from "fs";
import path from "path";
import { TabManager } from "./tabs/tab-manager";
import { loadSettings } from "./config/settings";
import type { UIState } from "../shared/types";

/**
 * Ensure clipboard keyboard shortcuts (Ctrl+C/V/X/A) work in a WebContentsView.
 * Electron doesn't always route these to the focused view with multiple views.
 */
function enableClipboardShortcuts(view: WebContentsView): void {
  view.webContents.on("before-input-event", (event, input) => {
    if (!input.control && !input.meta) return;
    const key = input.key.toLowerCase();
    const wc = view.webContents;
    if (input.type === "keyDown") {
      if (key === "c") { wc.copy(); event.preventDefault(); }
      else if (key === "v") { wc.paste(); event.preventDefault(); }
      else if (key === "x") { wc.cut(); event.preventDefault(); }
      else if (key === "a") { wc.selectAll(); event.preventDefault(); }
    }
  });
}

const CHROME_HEIGHT = 110; // title(32) + tabs(36+1border) + address(40+1border)

const DEFAULT_DEVTOOLS_PANEL_HEIGHT = 250;
const MIN_DEVTOOLS_PANEL = 120;
const MAX_DEVTOOLS_PANEL = 600;

export interface WindowState {
  mainWindow: BaseWindow;
  chromeView: WebContentsView;
  sidebarView: WebContentsView;
  devtoolsPanelView: WebContentsView;
  tabManager: TabManager;
  uiState: UIState;
}

function getWindowIconPath(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), "resources", "vessel-icon.png"),
    path.join(process.resourcesPath, "vessel-icon.png"),
    path.join(__dirname, "../../resources/vessel-icon.png"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

export function createMainWindow(
  onTabStateChange: (tabs: any[], activeId: string) => void,
): WindowState {
  const mainWindow = new BaseWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: "#1a1a1e",
    icon: getWindowIconPath(),
  });

  const chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  chromeView.setBackgroundColor("#00000000");
  mainWindow.contentView.addChildView(chromeView);

  const sidebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  sidebarView.setBackgroundColor("#00000000");
  // Suppress Electron's default context menu so custom menus in the sidebar work
  sidebarView.webContents.on("context-menu", (e) => e.preventDefault());
  mainWindow.contentView.addChildView(sidebarView);

  const devtoolsPanelView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  devtoolsPanelView.setBackgroundColor("#00000000");
  mainWindow.contentView.addChildView(devtoolsPanelView);

  // Ensure clipboard shortcuts work in all views
  enableClipboardShortcuts(chromeView);
  enableClipboardShortcuts(sidebarView);
  enableClipboardShortcuts(devtoolsPanelView);

  const settings = loadSettings();
  const uiState: UIState = {
    sidebarOpen: false,
    sidebarWidth: settings.sidebarWidth,
    focusMode: false,
    settingsOpen: false,
    devtoolsPanelOpen: false,
    devtoolsPanelHeight: DEFAULT_DEVTOOLS_PANEL_HEIGHT,
  };

  const tabManager = new TabManager(mainWindow, onTabStateChange);

  const state: WindowState = {
    mainWindow,
    chromeView,
    sidebarView,
    devtoolsPanelView,
    tabManager,
    uiState,
  };

  mainWindow.on("resize", () => layoutViews(state));
  mainWindow.on("show", () => layoutViews(state));
  mainWindow.on("focus", () => layoutViews(state));
  layoutViews(state);

  return state;
}

export function layoutViews(state: WindowState): void {
  const { mainWindow, chromeView, sidebarView, devtoolsPanelView, tabManager, uiState } = state;
  const [width, height] = mainWindow.getContentSize();
  const chromeHeight = uiState.focusMode ? 0 : CHROME_HEIGHT;
  const sidebarWidth = uiState.sidebarOpen ? uiState.sidebarWidth : 0;
  const devtoolsHeight = uiState.devtoolsPanelOpen ? uiState.devtoolsPanelHeight : 0;
  const chromeNeedsFullHeight = uiState.settingsOpen;

  if (chromeNeedsFullHeight) {
    chromeView.setBounds({ x: 0, y: 0, width, height });
  } else {
    chromeView.setBounds({ x: 0, y: 0, width, height: chromeHeight });
  }

  const resizeHandleOverlap = 6;
  if (uiState.sidebarOpen) {
    sidebarView.setBounds({
      x: width - sidebarWidth - resizeHandleOverlap,
      y: 0,
      width: sidebarWidth + resizeHandleOverlap,
      height,
    });
  } else {
    sidebarView.setBounds({ x: width, y: 0, width: 0, height: 0 });
  }

  // DevTools panel: bottom of content area, left of sidebar
  const contentWidth = width - sidebarWidth;
  if (uiState.devtoolsPanelOpen) {
    devtoolsPanelView.setBounds({
      x: 0,
      y: height - devtoolsHeight,
      width: contentWidth,
      height: devtoolsHeight,
    });
  } else {
    devtoolsPanelView.setBounds({ x: 0, y: height, width: 0, height: 0 });
  }

  // Chrome, sidebar, and devtools panel always on top of tab content
  mainWindow.contentView.removeChildView(chromeView);
  mainWindow.contentView.addChildView(chromeView);
  mainWindow.contentView.removeChildView(sidebarView);
  mainWindow.contentView.addChildView(sidebarView);
  mainWindow.contentView.removeChildView(devtoolsPanelView);
  mainWindow.contentView.addChildView(devtoolsPanelView);

  // Active tab content: below chrome, left of sidebar, above devtools panel
  const activeTab = tabManager.getActiveTab();
  if (activeTab) {
    activeTab.view.setBounds({
      x: 0,
      y: chromeHeight,
      width: contentWidth,
      height: height - chromeHeight - devtoolsHeight,
    });
  }
}

/**
 * Lightweight sidebar-only resize — skips view re-stacking to avoid flicker.
 * Only repositions the sidebar, active tab, and devtools panel width.
 */
export function resizeSidebarViews(state: WindowState): void {
  const { mainWindow, sidebarView, devtoolsPanelView, tabManager, uiState } = state;
  const [width, height] = mainWindow.getContentSize();
  const chromeHeight = uiState.focusMode ? 0 : CHROME_HEIGHT;
  const sidebarWidth = uiState.sidebarOpen ? uiState.sidebarWidth : 0;
  const devtoolsHeight = uiState.devtoolsPanelOpen ? uiState.devtoolsPanelHeight : 0;
  const resizeHandleOverlap = 6;
  const contentWidth = width - sidebarWidth;

  sidebarView.setBounds({
    x: width - sidebarWidth - resizeHandleOverlap,
    y: 0,
    width: sidebarWidth + resizeHandleOverlap,
    height,
  });

  if (uiState.devtoolsPanelOpen) {
    devtoolsPanelView.setBounds({
      x: 0,
      y: height - devtoolsHeight,
      width: contentWidth,
      height: devtoolsHeight,
    });
  }

  const activeTab = tabManager.getActiveTab();
  if (activeTab) {
    activeTab.view.setBounds({
      x: 0,
      y: chromeHeight,
      width: contentWidth,
      height: height - chromeHeight - devtoolsHeight,
    });
  }
}

export { MIN_DEVTOOLS_PANEL, MAX_DEVTOOLS_PANEL };
