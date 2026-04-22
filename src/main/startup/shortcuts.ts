import { globalShortcut } from "electron";
import { createLogger } from "../../shared/logger";
import type { TabManager } from "../tabs/tab-manager";

const logger = createLogger("Shortcuts");

/**
 * Registers the Ctrl+H global shortcut for highlight capture.
 * Re-registers when the main window gains focus (needed on some platforms).
 */
export function registerHighlightShortcut(
  mainWindow: Electron.BrowserWindow,
  tabManager: TabManager,
): () => void {
  const register = () => {
    globalShortcut.unregister("CommandOrControl+H");
    const success = globalShortcut.register("CommandOrControl+H", () => {
      const activeTab = tabManager.getActiveTab();
      if (!activeTab) return;
      tabManager.captureHighlightFromActiveTab();
    });
    if (!success) {
      logger.warn("Failed to register Ctrl+H shortcut");
    }
  };

  register();
  mainWindow.on("focus", register);

  return () => {
    globalShortcut.unregister("CommandOrControl+H");
    mainWindow.removeListener("focus", register);
  };
}
