import { app, dialog, globalShortcut, Menu } from "electron";
import fs from "node:fs";
import path from "path";
import { createMainWindow, layoutViews } from "./window";
import { registerIpcHandlers } from "./ipc/handlers";
import { Channels } from "../shared/channels";
import {
  getSettingsLoadIssues,
  getSettingsPath,
  loadSettings,
} from "./config/settings";
import { startMcpServer, stopMcpServer } from "./mcp/server";
import { AgentRuntime } from "./agent/runtime";
import { setDevToolsPanelListener } from "./devtools/tools";
import { installAdBlocking } from "./network/ad-blocking";
import * as bookmarkManager from "./bookmarks/manager";
import {
  getRuntimeHealth,
  initializeRuntimeHealth,
  setStartupIssues,
} from "./health/runtime-health";
import type { RuntimeHealthIssue, VesselSettings } from "../shared/types";

let runtime: AgentRuntime | null = null;

function rendererUrlFor(view: "chrome" | "sidebar" | "devtools"): string | null {
  if (!process.env.ELECTRON_RENDERER_URL) return null;
  const url = new URL(process.env.ELECTRON_RENDERER_URL);
  url.searchParams.set("view", view);
  return url.toString();
}

function checkWritableUserData(userDataPath: string): RuntimeHealthIssue[] {
  const issues: RuntimeHealthIssue[] = [];
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    const probePath = path.join(
      userDataPath,
      `.vessel-write-test-${process.pid}-${Date.now()}.tmp`,
    );
    fs.writeFileSync(probePath, "ok");
    fs.unlinkSync(probePath);
  } catch (error) {
    issues.push({
      code: "user-data-not-writable",
      severity: "error",
      title: "Vessel cannot write to its data directory",
      detail:
        error instanceof Error ? error.message : "Unknown filesystem error.",
      action: `Check permissions for ${userDataPath}.`,
    });
  }
  return issues;
}

function collectStartupIssues(
  settings: VesselSettings,
  userDataPath: string,
): RuntimeHealthIssue[] {
  const issues = [
    ...getSettingsLoadIssues(),
    ...checkWritableUserData(userDataPath),
  ];

  if (
    settings.obsidianVaultPath.trim() &&
    !fs.existsSync(settings.obsidianVaultPath)
  ) {
    issues.push({
      code: "obsidian-vault-missing",
      severity: "warning",
      title: "Configured Obsidian vault path was not found",
      detail: settings.obsidianVaultPath,
      action: "Update the vault path in Settings or create the directory.",
    });
  }

  return issues;
}

function formatIssue(issue: RuntimeHealthIssue): string {
  const action = issue.action ? `\nAction: ${issue.action}` : "";
  return `${issue.title}\n${issue.detail}${action}`;
}

async function maybeShowStartupHealthDialog(
  windowState: ReturnType<typeof createMainWindow>,
): Promise<void> {
  const health = getRuntimeHealth();
  const hasIssues =
    health.startupIssues.length > 0 || health.mcp.status === "error";
  if (!hasIssues) return;

  const lines = health.startupIssues.map(formatIssue);
  if (health.mcp.status === "error") {
    lines.push(
      `MCP server issue\n${health.mcp.message}\nAction: Open Settings (Ctrl+,) to choose a different port, then save to restart the MCP server.`,
    );
  }

  await dialog.showMessageBox(windowState.mainWindow, {
    type:
      health.startupIssues.some((issue) => issue.severity === "error") ||
      health.mcp.status === "error"
        ? "warning"
        : "info",
    title: "Vessel Startup Checks",
    message: "Vessel launched with runtime warnings.",
    detail: lines.join("\n\n"),
  });
}

async function bootstrap(): Promise<void> {
  const settings = loadSettings();
  const userDataPath = app.getPath("userData");
  initializeRuntimeHealth({
    userDataPath,
    settingsPath: getSettingsPath(),
    configuredPort: settings.mcpPort,
  });
  setStartupIssues(collectStartupIssues(settings, userDataPath));
  if (settings.clearBookmarksOnLaunch) {
    bookmarkManager.clearAll();
  }
  const windowState = createMainWindow((tabs, activeId) => {
    windowState.chromeView.webContents.send(
      Channels.TAB_STATE_UPDATE,
      tabs,
      activeId,
    );
    layoutViews(windowState);
    runtime?.onTabStateChanged();
  });

  const { chromeView, sidebarView, devtoolsPanelView, tabManager } = windowState;
  runtime = new AgentRuntime(tabManager);
  installAdBlocking(tabManager);

  // Wire devtools panel state updates to the devtools panel renderer view
  setDevToolsPanelListener((state) => {
    if (!devtoolsPanelView.webContents.isDestroyed()) {
      devtoolsPanelView.webContents.send(Channels.DEVTOOLS_PANEL_STATE, state);
    }
  });

  registerIpcHandlers(windowState, runtime);

  // Register global shortcut for Ctrl+H highlight capture
  const registerHighlightShortcut = () => {
    globalShortcut.unregister("CommandOrControl+H");
    const success = globalShortcut.register("CommandOrControl+H", () => {
      const activeTab = tabManager.getActiveTab();
      if (!activeTab) return;
      tabManager.captureHighlightFromActiveTab();
    });
    if (!success) {
      console.warn("[Vessel] Failed to register Ctrl+H shortcut");
    }
  };
  registerHighlightShortcut();

  // Re-register shortcut when window gains focus (needed on some platforms)
  windowState.mainWindow.on("focus", registerHighlightShortcut);

  // Application menu with standard edit operations
  const appMenu = Menu.buildFromTemplate([
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);

  bookmarkManager.subscribe((state) => {
    chromeView.webContents.send(Channels.BOOKMARKS_UPDATE, state);
    sidebarView.webContents.send(Channels.BOOKMARKS_UPDATE, state);
  });

  // Load renderer
  const chromeUrl = rendererUrlFor("chrome");
  const sidebarUrl = rendererUrlFor("sidebar");
  const devtoolsUrl = rendererUrlFor("devtools");

  if (chromeUrl && sidebarUrl && devtoolsUrl) {
    chromeView.webContents.loadURL(chromeUrl);
    sidebarView.webContents.loadURL(sidebarUrl);
    devtoolsPanelView.webContents.loadURL(devtoolsUrl);
  } else {
    const rendererFile = path.join(__dirname, "../renderer/index.html");
    chromeView.webContents.loadFile(rendererFile, {
      query: { view: "chrome" },
    });
    sidebarView.webContents.loadFile(rendererFile, {
      query: { view: "sidebar" },
    });
    devtoolsPanelView.webContents.loadFile(rendererFile, {
      query: { view: "devtools" },
    });
  }

  // Start MCP server for external agent integration
  await startMcpServer(tabManager, runtime, settings.mcpPort);

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
    void maybeShowStartupHealthDialog(windowState);
  });
}

app.whenReady().then(bootstrap).catch((error) => {
  console.error("[Vessel] Failed to bootstrap application:", error);
  app.quit();
});

app.on("window-all-closed", () => {
  globalShortcut.unregisterAll();
  runtime?.flushPersist();
  void stopMcpServer().finally(() => {
    app.quit();
  });
});
