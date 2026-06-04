import { BaseWindow, Menu, MenuItem, WebContentsView, app } from "electron";
import { existsSync } from "fs";
import path from "path";
import { TabManager, type TabStateChangeMeta } from "./tabs/tab-manager";
import { loadSettings } from "./config/settings";
import { Channels } from "../shared/channels";
import { SIDEBAR_RESIZE_HANDLE_OVERLAP } from "../shared/sidebar";
import type { UIState, TabState } from "../shared/types";
import { capturePageSnapshot } from "./content/page-diff-monitor";
import { sendSafe } from "./ipc/common";
import {
  closeDetachedSidebarWindow,
  detachSidebar,
  isSidebarAttached,
  type SidebarPanelHostState,
} from "./sidebar-panel";

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
      if (key === "c") {
        wc.copy();
        event.preventDefault();
      } else if (key === "v") {
        wc.paste();
        event.preventDefault();
      } else if (key === "x") {
        wc.cut();
        event.preventDefault();
      } else if (key === "a") {
        wc.selectAll();
        event.preventDefault();
      }
    }
  });
}

export const CHROME_HEIGHT = 110; // title(32) + tabs(36+1border) + address(40+1border)

const DEFAULT_DEVTOOLS_PANEL_HEIGHT = 250;
const MIN_DEVTOOLS_PANEL = 120;
const MAX_DEVTOOLS_PANEL = 600;

export interface WindowState extends SidebarPanelHostState {
  chromeView: WebContentsView;
  sidebarView: WebContentsView;
  devtoolsPanelView: WebContentsView;
  tabManager: TabManager;
  uiState: UIState;
}

type SidebarContextTarget = {
  inHighlightNav: boolean;
  canRemoveCurrent: boolean;
  bookmarkId?: string;
};

async function getSidebarContextTarget(
  sidebarView: WebContentsView,
  x: number,
  y: number,
): Promise<SidebarContextTarget> {
  try {
    return await sidebarView.webContents.executeJavaScript(
      `(() => {
        const el = document.elementFromPoint(${x}, ${y});
        const nav = el && typeof el.closest === "function"
          ? el.closest(".highlight-nav")
          : null;
        const label = nav?.querySelector(".highlight-nav-label")?.textContent?.trim() || "";
        return {
          inHighlightNav: !!nav,
          canRemoveCurrent: /\\d+\\s*\\/\\s*\\d+/.test(label),
          bookmarkId:
            el && typeof el.closest === "function"
              ? el.closest("[data-bookmark-id]")?.getAttribute("data-bookmark-id") || undefined
              : undefined,
        };
      })()`,
      true,
    );
  } catch {
    return { inHighlightNav: false, canRemoveCurrent: false };
  }
}

async function showSidebarContextMenu(
  mainWindow: BaseWindow,
  sidebarView: WebContentsView,
  params: Electron.ContextMenuParams,
): Promise<void> {
  const target = await getSidebarContextTarget(sidebarView, params.x, params.y);
  const menu = new Menu();

  if (target.inHighlightNav) {
    if (target.canRemoveCurrent) {
      menu.append(
        new MenuItem({
          label: "Remove Current Highlight",
          click: () =>
            sidebarView.webContents.send(
              Channels.SIDEBAR_HIGHLIGHT_ACTION,
              "remove-current",
            ),
        }),
      );
    }
    menu.append(
      new MenuItem({
        label: "Clear All Highlights",
        click: () =>
          sidebarView.webContents.send(
            Channels.SIDEBAR_HIGHLIGHT_ACTION,
            "clear-all",
          ),
      }),
    );
  }

  if (target.bookmarkId) {
    if (menu.items.length > 0) {
      menu.append(new MenuItem({ type: "separator" }));
    }
    menu.append(
      new MenuItem({
        label: "Add Context to Chat",
        click: () =>
          sidebarView.webContents.send(
            Channels.BOOKMARK_ADD_CONTEXT_TO_CHAT,
            target.bookmarkId,
          ),
      }),
    );
  }

  if (params.isEditable) {
    if (menu.items.length > 0) {
      menu.append(new MenuItem({ type: "separator" }));
    }
    menu.append(
      new MenuItem({
        role: "undo",
        enabled: params.editFlags.canUndo,
      }),
    );
    menu.append(
      new MenuItem({
        role: "redo",
        enabled: params.editFlags.canRedo,
      }),
    );
    menu.append(new MenuItem({ type: "separator" }));
    menu.append(
      new MenuItem({
        role: "cut",
        enabled: params.editFlags.canCut,
      }),
    );
    menu.append(
      new MenuItem({
        role: "copy",
        enabled: params.editFlags.canCopy,
      }),
    );
    menu.append(
      new MenuItem({
        role: "paste",
        enabled: params.editFlags.canPaste,
      }),
    );
    menu.append(
      new MenuItem({
        role: "selectAll",
        enabled: params.editFlags.canSelectAll,
      }),
    );
  } else if (params.selectionText?.trim()) {
    if (menu.items.length > 0) {
      menu.append(new MenuItem({ type: "separator" }));
    }
    menu.append(new MenuItem({ role: "copy" }));
  }

  if (menu.items.length === 0) return;

  sidebarView.webContents.focus();
  menu.popup({ window: mainWindow });
}

export function getWindowIconPath(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), "resources", "vessel-icon.png"),
    path.join(process.resourcesPath, "vessel-icon.png"),
    path.join(__dirname, "../../resources/vessel-icon.png"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

export function createMainWindow(
  onTabStateChange: (
    tabs: TabState[],
    activeId: string,
    meta: TabStateChangeMeta,
  ) => void,
): WindowState {
  const mainWindow = new BaseWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: "#1a1a1e",
    icon: getWindowIconPath(),
  });

  const chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
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
      spellcheck: false,
    },
  });

  sidebarView.setBackgroundColor("#00000000");
  mainWindow.contentView.addChildView(sidebarView);

  const devtoolsPanelView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
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
    sidebarPanelMode:
      settings.sidebarPanelMode === "detached" ? "docked" : settings.sidebarPanelMode,
    sidebarWidth: settings.sidebarWidth,
    sidebarDetachedBounds: settings.sidebarDetachedBounds,
    focusMode: false,
    settingsOpen: false,
    devtoolsPanelOpen: false,
    devtoolsPanelHeight: DEFAULT_DEVTOOLS_PANEL_HEIGHT,
  };

  const tabManager = new TabManager(mainWindow, onTabStateChange);

  const sendToRendererViews = (channel: string, ...args: unknown[]) => {
    sendSafe(chromeView.webContents, channel, ...args);
    sendSafe(sidebarView.webContents, channel, ...args);
  };

  tabManager.onPageLoad((url, wc) => {
    const activeWc = tabManager.getActiveTab()?.view.webContents;
    if (activeWc?.id !== wc.id) return;
    void capturePageSnapshot(url, wc, sendToRendererViews);
  });

  const state: WindowState = {
    mainWindow,
    sidebarWindow: null,
    sidebarWindowClosing: false,
    chromeView,
    sidebarView,
    devtoolsPanelView,
    tabManager,
    uiState,
  };

  mainWindow.on("resize", () => layoutViews(state));
  mainWindow.on("show", () => layoutViews(state));
  mainWindow.on("focus", () => layoutViews(state));
  mainWindow.on("closed", () => {
    closeDetachedSidebarWindow(state);
  });
  sidebarView.webContents.on("context-menu", (event, params) => {
    event.preventDefault();
    void showSidebarContextMenu(
      state.sidebarWindow ?? state.mainWindow,
      sidebarView,
      params,
    );
  });
  layoutViews(state);
  if (settings.sidebarPanelMode === "detached") {
    detachSidebar(state, { relayout: () => layoutViews(state), getWindowIconPath });
  }

  return state;
}

export function layoutViews(state: WindowState): void {
  const {
    mainWindow,
    chromeView,
    sidebarView,
    devtoolsPanelView,
    tabManager,
    uiState,
  } = state;
  const [width, height] = mainWindow.getContentSize();
  const chromeHeight = uiState.focusMode ? 0 : CHROME_HEIGHT;
  const sidebarAttached = isSidebarAttached(state);
  const sidebarWidth = sidebarAttached ? uiState.sidebarWidth : 0;
  const devtoolsHeight = uiState.devtoolsPanelOpen
    ? uiState.devtoolsPanelHeight
    : 0;
  const chromeNeedsFullHeight = uiState.settingsOpen;

  if (chromeNeedsFullHeight) {
    chromeView.setBounds({ x: 0, y: 0, width, height });
  } else {
    chromeView.setBounds({ x: 0, y: 0, width, height: chromeHeight });
  }

  if (sidebarAttached) {
    sidebarView.setBounds({
      x: width - sidebarWidth - SIDEBAR_RESIZE_HANDLE_OVERLAP,
      y: chromeHeight,
      width: sidebarWidth + SIDEBAR_RESIZE_HANDLE_OVERLAP,
      height: height - chromeHeight,
    });
  } else if (uiState.sidebarPanelMode === "closed") {
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

  // Re-stack views so chrome, sidebar, and devtools are always on top of tab content.
  mainWindow.contentView.removeChildView(chromeView);
  mainWindow.contentView.addChildView(chromeView);
  if (uiState.sidebarPanelMode !== "detached") {
    mainWindow.contentView.removeChildView(sidebarView);
    mainWindow.contentView.addChildView(sidebarView);
  }
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
  const { mainWindow, sidebarView, devtoolsPanelView, tabManager, uiState } =
    state;
  const [width, height] = mainWindow.getContentSize();
  const chromeHeight = uiState.focusMode ? 0 : CHROME_HEIGHT;
  const sidebarWidth = isSidebarAttached(state) ? uiState.sidebarWidth : 0;
  const devtoolsHeight = uiState.devtoolsPanelOpen
    ? uiState.devtoolsPanelHeight
    : 0;
  const contentWidth = width - sidebarWidth;

  if (uiState.sidebarPanelMode !== "detached") {
    // Position sidebar below chrome bar (same as layoutViews)
    sidebarView.setBounds({
      x: width - sidebarWidth - SIDEBAR_RESIZE_HANDLE_OVERLAP,
      y: chromeHeight,
      width: sidebarWidth + SIDEBAR_RESIZE_HANDLE_OVERLAP,
      height: height - chromeHeight,
    });
  }

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
