import { ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import {
  listNamedSessions,
  saveNamedSession,
  loadNamedSession,
  deleteNamedSession,
} from "../sessions/manager";
import { assertTrustedIpcSender, parseIpc } from "./common";
import type { TabManager } from "../tabs/tab-manager";

const SessionNameSchema = z.string().min(1);

export function registerSessionHandlers(tabManager: TabManager): void {
  ipcMain.handle(Channels.SESSION_LIST, async (event) => {
    assertTrustedIpcSender(event);
    return await listNamedSessions();
  });

  ipcMain.handle(Channels.SESSION_SAVE, async (event, name: unknown) => {
    assertTrustedIpcSender(event);
    const validatedName = parseIpc(SessionNameSchema, name, "name");
    return await saveNamedSession(tabManager, validatedName);
  });

  ipcMain.handle(Channels.SESSION_LOAD, async (event, name: unknown) => {
    assertTrustedIpcSender(event);
    const validatedName = parseIpc(SessionNameSchema, name, "name");
    return await loadNamedSession(tabManager, validatedName);
  });

  ipcMain.handle(Channels.SESSION_DELETE, async (event, name: unknown) => {
    assertTrustedIpcSender(event);
    const validatedName = parseIpc(SessionNameSchema, name, "name");
    return await deleteNamedSession(validatedName);
  });
}