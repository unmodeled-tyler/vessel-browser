import { app } from "electron";
import path from "path";
import { createMainWindow, layoutViews } from "./window";
import { registerIpcHandlers } from "./ipc/handlers";
import { Channels } from "../shared/channels";
import { loadSettings } from "./config/settings";

function rendererUrlFor(view: "chrome" | "sidebar"): string | null {
  if (!process.env.ELECTRON_RENDERER_URL) return null;
  const url = new URL(process.env.ELECTRON_RENDERER_URL);
  url.searchParams.set("view", view);
  return url.toString();
}

function bootstrap(): void {
  const settings = loadSettings();

  const windowState = createMainWindow((tabs, activeId) => {
    windowState.chromeView.webContents.send(
      Channels.TAB_STATE_UPDATE,
      tabs,
      activeId,
    );
  });

  const { chromeView, sidebarView, tabManager } = windowState;

  // Load renderer
  const chromeUrl = rendererUrlFor("chrome");
  const sidebarUrl = rendererUrlFor("sidebar");

  if (chromeUrl && sidebarUrl) {
    chromeView.webContents.loadURL(chromeUrl);
    sidebarView.webContents.loadURL(sidebarUrl);
  } else {
    const rendererFile = path.join(__dirname, "../renderer/index.html");
    chromeView.webContents.loadFile(rendererFile, {
      query: { view: "chrome" },
    });
    sidebarView.webContents.loadFile(rendererFile, {
      query: { view: "sidebar" },
    });
  }

  registerIpcHandlers(windowState);

  // Open first tab once chrome is ready
  chromeView.webContents.once("did-finish-load", () => {
    tabManager.createTab(settings.defaultUrl);
    layoutViews(windowState);
  });
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  app.quit();
});
