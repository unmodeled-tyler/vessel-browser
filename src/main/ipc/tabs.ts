import { ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import { loadSettings } from "../config/settings";
import { layoutViews, type WindowState } from "../window";
import {
  assertTrustedIpcSender,
  parseIpc,
  type SendToRendererViews,
} from "./common";
import { createFindInPageBridge } from "../tabs/find-bridge";
import { showTabContextMenu, showGroupContextMenu } from "../tabs/tab-context-menu";
import { createPrivateWindow } from "../private/window";
import { createSecondaryWindow } from "../secondary/window";

const TabIdSchema = z.string().min(1);
const GroupIdSchema = z.string().min(1);
const UrlSchema = z.string().min(1);
const ColorSchema = z.string().min(1);
const FindActionSchema = z.enum(["clearSelection", "keepSelection", "activateSelection"]);

export function registerTabHandlers(
  windowState: WindowState,
  sendToRendererViews: SendToRendererViews,
): void {
  const { tabManager, mainWindow } = windowState;

  ipcMain.handle(Channels.OPEN_PRIVATE_WINDOW, (event) => {
    assertTrustedIpcSender(event);
    createPrivateWindow();
  });

  ipcMain.handle(Channels.OPEN_NEW_WINDOW, (event) => {
    assertTrustedIpcSender(event);
    createSecondaryWindow();
  });

  ipcMain.handle(Channels.IS_PRIVATE_MODE, (event) => {
    assertTrustedIpcSender(event);
    return false;
  });

  ipcMain.handle(Channels.TAB_CREATE, (event, url?: string) => {
    assertTrustedIpcSender(event);
    const id = tabManager.createTab(url || loadSettings().defaultUrl);
    layoutViews(windowState);
    return id;
  });

  ipcMain.handle(Channels.TAB_CLOSE, (event, id: string) => {
    assertTrustedIpcSender(event);
    const validated = parseIpc(TabIdSchema, id, "tabId");
    tabManager.closeTab(validated);
    layoutViews(windowState);
  });

  ipcMain.handle(Channels.TAB_SWITCH, (event, id: string) => {
    assertTrustedIpcSender(event);
    const validated = parseIpc(TabIdSchema, id, "tabId");
    tabManager.switchTab(validated);
    layoutViews(windowState);
  });

  ipcMain.handle(
    Channels.TAB_NAVIGATE,
    (event, id: string, url: string, postBody?: Record<string, string>) => {
      assertTrustedIpcSender(event);
      const validatedId = parseIpc(TabIdSchema, id, "tabId");
      const validatedUrl = parseIpc(UrlSchema, url, "url");
      return tabManager.navigateTab(validatedId, validatedUrl, postBody);
    },
  );

  ipcMain.handle(Channels.TAB_BACK, (event, id: string) => {
    assertTrustedIpcSender(event);
    tabManager.goBack(parseIpc(TabIdSchema, id, "tabId"));
  });

  ipcMain.handle(Channels.TAB_FORWARD, (event, id: string) => {
    assertTrustedIpcSender(event);
    tabManager.goForward(parseIpc(TabIdSchema, id, "tabId"));
  });

  ipcMain.handle(Channels.TAB_RELOAD, (event, id: string) => {
    assertTrustedIpcSender(event);
    tabManager.reloadTab(parseIpc(TabIdSchema, id, "tabId"));
  });

  ipcMain.handle(Channels.TAB_TOGGLE_AD_BLOCK, (event, id: string) => {
    assertTrustedIpcSender(event);
    const validated = parseIpc(TabIdSchema, id, "id");
    const tab = tabManager.getTab(validated);
    if (!tab) return null;
    const newState = !tab.state.adBlockingEnabled;
    tab.setAdBlockingEnabled(newState);
    return newState;
  });

  ipcMain.handle(Channels.TAB_ZOOM_IN, (event, id: string) => {
    assertTrustedIpcSender(event);
    tabManager.zoomIn(parseIpc(TabIdSchema, id, "id"));
  });

  ipcMain.handle(Channels.TAB_ZOOM_OUT, (event, id: string) => {
    assertTrustedIpcSender(event);
    tabManager.zoomOut(parseIpc(TabIdSchema, id, "id"));
  });

  ipcMain.handle(Channels.TAB_ZOOM_RESET, (event, id: string) => {
    assertTrustedIpcSender(event);
    tabManager.zoomReset(parseIpc(TabIdSchema, id, "id"));
  });

  ipcMain.handle(Channels.TAB_REOPEN_CLOSED, (event) => {
    assertTrustedIpcSender(event);
    const id = tabManager.reopenClosedTab();
    if (id) layoutViews(windowState);
    return id;
  });

  ipcMain.handle(Channels.TAB_DUPLICATE, (event, id: string) => {
    assertTrustedIpcSender(event);
    const validated = parseIpc(TabIdSchema, id, "id");
    const newId = tabManager.duplicateTab(validated);
    if (newId) layoutViews(windowState);
    return newId;
  });

  ipcMain.handle(Channels.TAB_PIN, (event, id: string) => {
    assertTrustedIpcSender(event);
    tabManager.pinTab(parseIpc(TabIdSchema, id, "id"));
  });

  ipcMain.handle(Channels.TAB_UNPIN, (event, id: string) => {
    assertTrustedIpcSender(event);
    tabManager.unpinTab(parseIpc(TabIdSchema, id, "id"));
  });

  ipcMain.handle(Channels.TAB_GROUP_CREATE, (event, id: string) => {
    assertTrustedIpcSender(event);
    return tabManager.createGroupFromTab(parseIpc(TabIdSchema, id, "id"));
  });

  ipcMain.handle(Channels.TAB_GROUP_ADD_TAB, (event, id: string, groupId: string) => {
    assertTrustedIpcSender(event);
    tabManager.assignTabToGroup(
      parseIpc(TabIdSchema, id, "id"),
      parseIpc(GroupIdSchema, groupId, "groupId"),
    );
  });

  ipcMain.handle(Channels.TAB_GROUP_REMOVE_TAB, (event, id: string) => {
    assertTrustedIpcSender(event);
    tabManager.removeTabFromGroup(parseIpc(TabIdSchema, id, "id"));
  });

  ipcMain.handle(Channels.TAB_GROUP_TOGGLE_COLLAPSED, (event, groupId: string) => {
    assertTrustedIpcSender(event);
    return tabManager.toggleGroupCollapsed(parseIpc(GroupIdSchema, groupId, "groupId"));
  });

  ipcMain.handle(
    Channels.TAB_GROUP_SET_COLOR,
    (event, groupId: string, color: string) => {
      assertTrustedIpcSender(event);
      tabManager.setGroupColor(
        parseIpc(GroupIdSchema, groupId, "groupId"),
        parseIpc(ColorSchema, color, "color"),
      );
    },
  );

  ipcMain.handle(Channels.TAB_TOGGLE_MUTE, (event, id: string) => {
    assertTrustedIpcSender(event);
    return tabManager.toggleMuted(parseIpc(TabIdSchema, id, "id"));
  });

  ipcMain.handle(Channels.TAB_PRINT, (event, id: string) => {
    assertTrustedIpcSender(event);
    tabManager.printTab(parseIpc(TabIdSchema, id, "id"));
  });

  ipcMain.handle(Channels.TAB_PRINT_TO_PDF, (event, id: string) => {
    assertTrustedIpcSender(event);
    return tabManager.saveTabAsPdf(parseIpc(TabIdSchema, id, "id"));
  });

  ipcMain.on(Channels.TAB_CONTEXT_MENU, (event, id: string) => {
    assertTrustedIpcSender(event);
    showTabContextMenu(tabManager, parseIpc(TabIdSchema, id, "id"), mainWindow, () => layoutViews(windowState));
  });

  ipcMain.on(Channels.TAB_GROUP_CONTEXT_MENU, (event, groupId: string) => {
    assertTrustedIpcSender(event);
    showGroupContextMenu(tabManager, parseIpc(GroupIdSchema, groupId, "groupId"), mainWindow);
  });

  ipcMain.handle(Channels.TAB_STATE_GET, (event) => {
    assertTrustedIpcSender(event);
    return {
      tabs: tabManager.getAllStates(),
      activeId: tabManager.getActiveTabId() || "",
    };
  });

  const findBridge = createFindInPageBridge(tabManager, windowState.chromeView);

  ipcMain.handle(Channels.FIND_IN_PAGE_START, (event, text: string, options?: { forward?: boolean; findNext?: boolean }) => {
    assertTrustedIpcSender(event);
    return findBridge.start(text, options);
  });

  ipcMain.handle(Channels.FIND_IN_PAGE_NEXT, (event, forward?: boolean) => {
    assertTrustedIpcSender(event);
    return findBridge.next(forward);
  });

  ipcMain.handle(Channels.FIND_IN_PAGE_STOP, (event, action?: "clearSelection" | "keepSelection" | "activateSelection") => {
    assertTrustedIpcSender(event);
    findBridge.stop(action ? parseIpc(FindActionSchema, action, "action") : undefined);
  });
}
