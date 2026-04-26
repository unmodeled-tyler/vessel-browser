import { BaseWindow, Menu, MenuItem, session, WebContentsView } from "electron";
import { accessSync } from "fs";
import path from "path";
import { Channels } from "../../shared/channels";
import type { TabGroupColor } from "../../shared/types";
import { TAB_GROUP_COLOR_LABELS, TAB_GROUP_COLORS } from "../../shared/types";
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

const CHROME_HEIGHT = 110;

interface SecondaryWindowState {
  window: BaseWindow;
  chromeView: WebContentsView;
  tabManager: TabManager;
}

const secondaryWindows = new Set<SecondaryWindowState>();

function resolveRendererFile(): string {
  const candidates = [
    path.join(__dirname, "../../out/renderer/index.html"),
    path.join(__dirname, "../../../out/renderer/index.html"),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  return path.join(__dirname, "../../out/renderer/index.html");
}

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

function showTabContextMenu(state: SecondaryWindowState, id: string): void {
  const { tabManager } = state;
  const tab = tabManager.getTab(id);
  const isPinned = tab?.state.isPinned ?? false;
  const groupId = tab?.state.groupId;
  const isMuted = tab?.state.isMuted ?? false;
  const groups = tabManager
    .getAllStates()
    .filter((state) => state.groupId && state.groupId !== groupId)
    .reduce(
      (map, state) =>
        map.set(state.groupId!, {
          id: state.groupId!,
          name: state.groupName || "Group",
        }),
      new Map<string, { id: string; name: string }>(),
    );
  const menu = new Menu();

  menu.append(
    new MenuItem({
      label: isPinned ? "Unpin Tab" : "Pin Tab",
      click: () => (isPinned ? tabManager.unpinTab(id) : tabManager.pinTab(id)),
    }),
  );
  menu.append(
    new MenuItem({
      label: "Duplicate Tab",
      click: () => {
        const newId = tabManager.duplicateTab(id);
        if (newId) layoutSecondaryViews(state);
      },
    }),
  );
  menu.append(
    new MenuItem({
      label: "Add to New Group",
      click: () => {
        tabManager.createGroupFromTab(id);
      },
    }),
  );
  if (groups.size > 0) {
    menu.append(
      new MenuItem({
        label: "Add to Group",
        submenu: [...groups.values()].map(
          (group) =>
            new MenuItem({
              label: group.name,
              click: () => tabManager.assignTabToGroup(id, group.id),
            }),
        ),
      }),
    );
  }
  if (groupId) {
    menu.append(
      new MenuItem({
        label: "Remove from Group",
        click: () => tabManager.removeTabFromGroup(id),
      }),
    );
  }
  menu.append(
    new MenuItem({
      label: isMuted ? "Unmute Tab" : "Mute Tab",
      click: () => tabManager.toggleMuted(id),
    }),
  );
  menu.append(new MenuItem({ type: "separator" }));
  menu.append(
    new MenuItem({ label: "Print Page", click: () => tabManager.printTab(id) }),
  );
  menu.append(
    new MenuItem({
      label: "Save Page as PDF",
      click: () => void tabManager.saveTabAsPdf(id),
    }),
  );
  if (!isPinned) {
    menu.append(new MenuItem({ type: "separator" }));
    menu.append(
      new MenuItem({
        label: "Close Tab",
        click: () => {
          tabManager.closeTab(id);
          layoutSecondaryViews(state);
        },
      }),
    );
  }
  menu.popup({ window: state.window });
}

function showGroupContextMenu(
  state: SecondaryWindowState,
  groupId: string,
): void {
  const { tabManager } = state;
  const firstTab = tabManager.getAllStates().find((tab) => tab.groupId === groupId);
  if (!firstTab) return;
  const menu = new Menu();
  menu.append(
    new MenuItem({
      label: firstTab.groupCollapsed ? "Expand Group" : "Collapse Group",
      click: () => tabManager.toggleGroupCollapsed(groupId),
    }),
  );
  menu.append(
    new MenuItem({
      label: "Group Color",
      submenu: TAB_GROUP_COLORS.map(
        (color) =>
          new MenuItem({
            label: TAB_GROUP_COLOR_LABELS[color],
            type: "radio",
            checked: firstTab.groupColor === color,
            click: () => tabManager.setGroupColor(groupId, color),
          }),
      ),
    }),
  );
  menu.popup({ window: state.window });
}

function registerSecondaryIpcHandlers(state: SecondaryWindowState): void {
  const { chromeView, tabManager } = state;
  const ipc = chromeView.webContents.ipc;
  let findResultListener:
    | ((event: Electron.Event, result: Electron.Result) => void)
    | null = null;
  let findWiredWcId: number | null = null;

  const wireFindEvents = (wc: Electron.WebContents) => {
    if (findWiredWcId === wc.id && findResultListener) return;
    if (findWiredWcId && findResultListener) {
      const previous = tabManager.findTabByWebContentsId(findWiredWcId);
      previous?.view.webContents.removeListener(
        "found-in-page",
        findResultListener,
      );
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
    const capturedWcId = wc.id;
    wc.once("destroyed", () => {
      if (findWiredWcId === capturedWcId) {
        findWiredWcId = null;
        findResultListener = null;
      }
    });
  };

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
    showTabContextMenu(state, id),
  );
  ipc.on(Channels.TAB_GROUP_CONTEXT_MENU, (_e, groupId: string) =>
    showGroupContextMenu(state, groupId),
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
    (
      _e,
      text: string,
      options?: { forward?: boolean; findNext?: boolean },
    ) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return null;
      const wc = tab.view.webContents;
      if (wc.isDestroyed()) return null;
      wireFindEvents(wc);
      return wc.findInPage(text, {
        forward: options?.forward ?? true,
        findNext: options?.findNext ?? false,
      });
    },
  );
  ipc.handle(Channels.FIND_IN_PAGE_NEXT, (_e, forward?: boolean) => {
    const tab = tabManager.getActiveTab();
    if (!tab) return null;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return null;
    wireFindEvents(wc);
    return wc.findInPage("", { forward: forward ?? true, findNext: true });
  });
  ipc.handle(
    Channels.FIND_IN_PAGE_STOP,
    (_e, action?: "clearSelection" | "keepSelection" | "activateSelection") => {
      const tab = tabManager.getActiveTab();
      if (!tab) return;
      const wc = tab.view.webContents;
      if (wc.isDestroyed()) return;
      wc.stopFindInPage(action ?? "clearSelection");
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
