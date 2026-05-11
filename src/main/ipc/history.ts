import { dialog, ipcMain } from "electron";
import { promises as fs } from "fs";
import { Channels } from "../../shared/channels";
import * as historyManager from "../history/manager";
import { assertTrustedIpcSender } from "./common";

export function registerHistoryHandlers(): void {
  ipcMain.handle(Channels.HISTORY_GET, (event) => {
    assertTrustedIpcSender(event);
    return historyManager.getState();
  });

  ipcMain.handle(Channels.HISTORY_SEARCH, (event, query: string) => {
    assertTrustedIpcSender(event);
    return historyManager.search(query);
  });

  ipcMain.handle(Channels.HISTORY_CLEAR, (event) => {
    assertTrustedIpcSender(event);
    historyManager.clearAll();
  });

  ipcMain.handle(Channels.HISTORY_EXPORT_HTML, async (event) => {
    assertTrustedIpcSender(event);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Export History",
      defaultPath: "vessel-history.html",
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (canceled || !filePath) return null;
    const content = historyManager.exportHistoryHtml();
    await fs.writeFile(filePath, content, "utf-8");
    return { filePath, count: historyManager.getState().entries.length };
  });

  ipcMain.handle(Channels.HISTORY_EXPORT_JSON, async (event) => {
    assertTrustedIpcSender(event);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Export History",
      defaultPath: "vessel-history.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePath) return null;
    const content = historyManager.exportHistoryJson();
    await fs.writeFile(filePath, content, "utf-8");
    return { filePath, count: historyManager.getState().entries.length };
  });

  ipcMain.handle(Channels.HISTORY_IMPORT, async (event) => {
    assertTrustedIpcSender(event);
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Import History",
      filters: [
        { name: "History Files", extensions: ["html", "json"] },
      ],
      properties: ["openFile"],
    });
    if (canceled || filePaths.length === 0) return null;
    const filePath = filePaths[0];
    const content = await fs.readFile(filePath, "utf-8");
    const result = filePath.endsWith(".json")
      ? historyManager.importHistoryFromJson(content)
      : historyManager.importHistoryFromHtml(content);
    return result;
  });
}
