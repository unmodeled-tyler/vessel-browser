import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import { extractContent } from "../content/extractor";
import { generateReaderHTML } from "../content/reader-mode";
import { loadInternalDataURL, loadPermittedNavigationURL } from "../network/url-safety";
import { assertTrustedIpcSender } from "./common";
import { layoutViews, type WindowState } from "../window";

export function registerContentHandlers(windowState: WindowState): void {
  const { tabManager } = windowState;

  ipcMain.handle(Channels.CONTENT_EXTRACT, async (event) => {
    assertTrustedIpcSender(event);
    const activeTab = tabManager.getActiveTab();
    if (!activeTab) return null;
    return extractContent(activeTab.view.webContents);
  });

  ipcMain.handle(Channels.READER_MODE_TOGGLE, async (event) => {
    assertTrustedIpcSender(event);
    const activeTab = tabManager.getActiveTab();
    if (!activeTab) return;

    if (activeTab.state.isReaderMode) {
      const originalUrl = activeTab.readerOriginalUrl;
      activeTab.setReaderMode(false);
      if (originalUrl) {
        void loadPermittedNavigationURL(activeTab.view.webContents, originalUrl);
      }
    } else {
      const originalUrl = activeTab.state.url;
      const content = await extractContent(activeTab.view.webContents);
      const html = generateReaderHTML(content);
      activeTab.setReaderMode(true, originalUrl);
      void loadInternalDataURL(
        activeTab.view.webContents,
        `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
      );
    }
  });

  ipcMain.handle(Channels.FOCUS_MODE_TOGGLE, (event) => {
    assertTrustedIpcSender(event);
    windowState.uiState.focusMode = !windowState.uiState.focusMode;
    layoutViews(windowState);
    return windowState.uiState.focusMode;
  });
}
