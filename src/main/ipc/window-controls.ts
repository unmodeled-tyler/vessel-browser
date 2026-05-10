import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import type { BaseWindow } from "electron";
import { assertTrustedIpcSender } from "./common";

export function registerWindowControlHandlers(mainWindow: BaseWindow): void {
  ipcMain.handle(Channels.WINDOW_MINIMIZE, (event) => {
    assertTrustedIpcSender(event);
    mainWindow.minimize();
  });

  ipcMain.handle(Channels.WINDOW_MAXIMIZE, (event) => {
    assertTrustedIpcSender(event);
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle(Channels.WINDOW_CLOSE, (event) => {
    assertTrustedIpcSender(event);
    mainWindow.close();
  });
}
