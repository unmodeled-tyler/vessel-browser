import { app } from "electron";
import path from "path";
import { createMainWindow, layoutViews } from "./window";
import { registerIpcHandlers } from "./ipc/handlers";
import { Channels } from "../shared/channels";
import { loadSettings } from "./config/settings";
import { startMcpServer, stopMcpServer } from "./mcp/server";
import { AgentRuntime } from "./agent/runtime";
import * as bookmarkManager from "./bookmarks/manager";

function rendererUrlFor(view: "chrome" | "sidebar"): string | null {
  if (!process.env.ELECTRON_RENDERER_URL) return null;
  const url = new URL(process.env.ELECTRON_RENDERER_URL);
  url.searchParams.set("view", view);
  return url.toString();
}

function bootstrap(): void {
  const settings = loadSettings();
  if (settings.clearBookmarksOnLaunch) {
    bookmarkManager.clearAll();
  }
  let runtime: AgentRuntime | null = null;

  const windowState = createMainWindow((tabs, activeId) => {
    windowState.chromeView.webContents.send(
      Channels.TAB_STATE_UPDATE,
      tabs,
      activeId,
    );
    layoutViews(windowState);
    runtime?.onTabStateChanged();
  });

  const { chromeView, sidebarView, tabManager } = windowState;
  runtime = new AgentRuntime(tabManager);

  registerIpcHandlers(windowState, runtime);
  bookmarkManager.subscribe((state) => {
    chromeView.webContents.send(Channels.BOOKMARKS_UPDATE, state);
    sidebarView.webContents.send(Channels.BOOKMARKS_UPDATE, state);
  });

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

  // Start MCP server for external agent integration
  startMcpServer(tabManager, runtime, settings.mcpPort);

  // Restore previous session, or open the default tab once chrome is ready
  chromeView.webContents.once("did-finish-load", () => {
    const savedSession = runtime.getState().session;
    if (settings.autoRestoreSession && savedSession?.tabs.length) {
      runtime.restoreSession(savedSession);
    } else {
      tabManager.createTab(settings.defaultUrl);
      runtime.captureSession("Initial session");
    }
    layoutViews(windowState);
    setImmediate(() => layoutViews(windowState));
  });
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  stopMcpServer();
  app.quit();
});
