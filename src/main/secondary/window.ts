import { BaseWindow, session, WebContentsView } from "electron";
import path from "path";
import { Channels } from "../../shared/channels";
import type { TabGroupColor } from "../../shared/types";
import { loadSettings } from "../config/settings";
import {
  installAdBlocking,
  unregisterAdBlockingTabManager,
} from "../network/ad-blocking";
import {
  installDownloadHandler,
  unregisterDownloadHandler,
} from "../network/downloads";
import { TabManager } from "../tabs/tab-manager";
import { CHROME_HEIGHT } from "../window";
import { resolveRendererFile } from "../startup/renderer";
import { showTabContextMenu, showGroupContextMenu } from "../tabs/tab-context-menu";
import { createFindInPageBridge } from "../tabs/find-bridge";

interface SecondaryWindowState {
  window: BaseWindow;
  chromeView: WebContentsView;
  tabManager: TabManager;
}

const secondaryWindows = new Set<SecondaryWindowState>();

function layoutSecondaryViews(state: SecondaryWindowState): void {
  const { window: win, chromeView, tabManager } = state;
  const [width, height] = win.getContentSize();
  chromeView.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT });
  win.contentView.removeChildView(chromeView);
  win.contentView.addChildView(chromeView);

  const activeTab = tabManager.getActiveTab();
  if (activeTab) {
    activeTab.view.setBounds({
      x: 0,
      y: CHROME_HEIGHT,
      width,
      height: height - CHROME_HEIGHT,
    });
  }
}

function loadSecondaryRenderer(chromeView: WebContentsView): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    const url = new URL(devUrl);
    url.searchParams.set("view", "chrome");
    url.searchParams.set("secondary", "1");
    chromeView.webContents.loadURL(url.toString());
  } else {
    chromeView.webContents.loadFile(resolveRendererFile(), {
      query: { view: "chrome", secondary: "1" },
    });
  }
}

function registerSecondaryIpcHandlers(state: SecondaryWindowState): void {
  const { chromeView, tabManager } = state;
  const ipc = chromeView.webContents.ipc;
  const findBridge = createFindInPageBridge(tabManager, chromeView);

  ipc.handle(Channels.TAB_CREATE, (_e, url?: string) => {
    return tabManager.createTab(url || loadSettings().defaultUrl);
  });
  ipc.handle(Channels.TAB_CLOSE, (_e, id: string) => {
    tabManager.closeTab(id);
    layoutSecondaryViews(state);
  });
  ipc.handle(Channels.TAB_SWITCH, (_e, id: string) => {
    tabManager.switchTab(id);
    layoutSecondaryViews(state);
  });
  ipc.handle(Channels.TAB_NAVIGATE, (_e, id: string, url: string) => {
    return tabManager.navigateTab(id, url);
  });
  ipc.handle(Channels.TAB_BACK, (_e, id: string) => tabManager.goBack(id));
  ipc.handle(Channels.TAB_FORWARD, (_e, id: string) => tabManager.goForward(id));
  ipc.handle(Channels.TAB_RELOAD, (_e, id: string) => tabManager.reloadTab(id));
  ipc.handle(Channels.TAB_TOGGLE_AD_BLOCK, (_e, id: string) => {
    const tab = tabManager.getTab(id);
    if (!tab) return null;
    const enabled = !tab.state.adBlockingEnabled;
    tab.setAdBlockingEnabled(enabled);
    return enabled;
  });
  ipc.handle(Channels.TAB_ZOOM_IN, (_e, id: string) => tabManager.zoomIn(id));
  ipc.handle(Channels.TAB_ZOOM_OUT, (_e, id: string) => tabManager.zoomOut(id));
  ipc.handle(Channels.TAB_ZOOM_RESET, (_e, id: string) => tabManager.zoomReset(id));
  ipc.handle(Channels.TAB_REOPEN_CLOSED, () => {
    const id = tabManager.reopenClosedTab();
    if (id) layoutSecondaryViews(state);
    return id;
  });
  ipc.handle(Channels.TAB_DUPLICATE, (_e, id: string) => {
    const newId = tabManager.duplicateTab(id);
    if (newId) layoutSecondaryViews(state);
    return newId;
  });
  ipc.handle(Channels.TAB_PIN, (_e, id: string) => tabManager.pinTab(id));
  ipc.handle(Channels.TAB_UNPIN, (_e, id: string) => tabManager.unpinTab(id));
  ipc.handle(Channels.TAB_GROUP_CREATE, (_e, id: string) =>
    tabManager.createGroupFromTab(id),
  );
  ipc.handle(Channels.TAB_GROUP_ADD_TAB, (_e, id: string, groupId: string) =>
    tabManager.assignTabToGroup(id, groupId),
  );
  ipc.handle(Channels.TAB_GROUP_REMOVE_TAB, (_e, id: string) =>
    tabManager.removeTabFromGroup(id),
  );
  ipc.handle(Channels.TAB_GROUP_TOGGLE_COLLAPSED, (_e, groupId: string) =>
    tabManager.toggleGroupCollapsed(groupId),
  );
  ipc.handle(
    Channels.TAB_GROUP_SET_COLOR,
    (_e, groupId: string, color: TabGroupColor) =>
      tabManager.setGroupColor(groupId, color),
  );
  ipc.handle(Channels.TAB_TOGGLE_MUTE, (_e, id: string) =>
    tabManager.toggleMuted(id),
  );
  ipc.handle(Channels.TAB_PRINT, (_e, id: string) => tabManager.printTab(id));
  ipc.handle(Channels.TAB_PRINT_TO_PDF, (_e, id: string) =>
    tabManager.saveTabAsPdf(id),
  );
  ipc.handle(Channels.TAB_STATE_GET, () => ({
    tabs: tabManager.getAllStates(),
    activeId: tabManager.getActiveTabId() || "",
  }));
  ipc.on(Channels.TAB_CONTEXT_MENU, (_e, id: string) =>
    showTabContextMenu(state.tabManager, id, state.window, () => layoutSecondaryViews(state)),
  );
  ipc.on(Channels.TAB_GROUP_CONTEXT_MENU, (_e, groupId: string) =>
    showGroupContextMenu(state.tabManager, groupId, state.window),
  );

  ipc.handle(Channels.OPEN_NEW_WINDOW, () => createSecondaryWindow());
  ipc.handle(Channels.OPEN_PRIVATE_WINDOW, () => {
    const { createPrivateWindow } =
      require("../private/window") as typeof import("../private/window");
    createPrivateWindow();
  });
  ipc.handle(Channels.IS_PRIVATE_MODE, () => false);
  ipc.handle(Channels.WINDOW_MINIMIZE, () => state.window.minimize());
  ipc.handle(Channels.WINDOW_MAXIMIZE, () => {
    if (state.window.isMaximized()) state.window.unmaximize();
    else state.window.maximize();
  });
  ipc.handle(Channels.WINDOW_CLOSE, () => state.window.close());
  ipc.handle(Channels.SETTINGS_VISIBILITY, () => false);
  ipc.handle(Channels.FOCUS_MODE_TOGGLE, () => false);
  ipc.handle(Channels.SIDEBAR_TOGGLE, () => ({ open: false, width: 0 }));
  ipc.handle(Channels.DEVTOOLS_PANEL_TOGGLE, () => ({ open: false }));

  ipc.handle(
    Channels.FIND_IN_PAGE_START,
    (_e, text: string, options?: { forward?: boolean; findNext?: boolean }) => {
      return findBridge.start(text, options);
    },
  );
  ipc.handle(Channels.FIND_IN_PAGE_NEXT, (_e, forward?: boolean) => {
    return findBridge.next(forward);
  });
  ipc.handle(
    Channels.FIND_IN_PAGE_STOP,
    (_e, action?: "clearSelection" | "keepSelection" | "activateSelection") => {
      findBridge.stop(action);
    },
  );
}

export function createSecondaryWindow(): SecondaryWindowState {
  const win = new BaseWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: "#1a1a1e",
    title: "Vessel",
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
  win.contentView.addChildView(chromeView);

  const tabManager = new TabManager(win, (tabs, activeId) => {
    if (!chromeView.webContents.isDestroyed()) {
      chromeView.webContents.send(Channels.TAB_STATE_UPDATE, tabs, activeId);
    }
    layoutSecondaryViews(state);
  });

  const state: SecondaryWindowState = { window: win, chromeView, tabManager };
  installAdBlocking(tabManager);
  installDownloadHandler(chromeView);
  registerSecondaryIpcHandlers(state);

  win.on("resize", () => layoutSecondaryViews(state));
  win.on("show", () => layoutSecondaryViews(state));
  win.on("closed", () => {
    secondaryWindows.delete(state);
    unregisterAdBlockingTabManager(tabManager);
    unregisterDownloadHandler(chromeView);
    tabManager.destroyAllTabs();
  });

  secondaryWindows.add(state);
  chromeView.webContents.once("dom-ready", () => {
    tabManager.createTab(loadSettings().defaultUrl);
    layoutSecondaryViews(state);
  });
  loadSecondaryRenderer(chromeView);
  win.show();
  return state;
}

export function getSecondaryWindows(): ReadonlySet<SecondaryWindowState> {
  return secondaryWindows;
}
