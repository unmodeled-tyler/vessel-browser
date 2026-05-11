import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import {
  listNamedSessions,
  saveNamedSession,
  loadNamedSession,
  deleteNamedSession,
} from "../sessions/manager";
import { assertString, assertTrustedIpcSender } from "./common";
import type { TabManager } from "../tabs/tab-manager";

export function registerSessionHandlers(tabManager: TabManager): void {
  ipcMain.handle(Channels.SESSION_LIST, (event) => {
    assertTrustedIpcSender(event);
    return listNamedSessions();
  });

  ipcMain.handle(Channels.SESSION_SAVE, async (event, name: string) => {
    assertTrustedIpcSender(event);
    assertString(name, "name");
    return await saveNamedSession(tabManager, name);
  });

  ipcMain.handle(Channels.SESSION_LOAD, async (event, name: string) => {
    assertTrustedIpcSender(event);
    assertString(name, "name");
    return await loadNamedSession(tabManager, name);
  });

  ipcMain.handle(Channels.SESSION_DELETE, (event, name: string) => {
    assertTrustedIpcSender(event);
    assertString(name, "name");
    return deleteNamedSession(name);
  });
}
