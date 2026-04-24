import { app, dialog, globalShortcut, session } from "electron";
import fs from "node:fs";
import path from "path";
import { createMainWindow, layoutViews } from "./window";
import { registerIpcHandlers } from "./ipc/handlers";
import { Channels } from "../shared/channels";
import {
  flushPersist as flushSettingsPersist,
  getSettingsLoadIssues,
  getSettingsPath,
  loadSettings,
} from "./config/settings";
import { startMcpServer, stopMcpServer } from "./mcp/server";
import { AgentRuntime } from "./agent/runtime";
import { setDevToolsPanelListener } from "./devtools/tools";
import { installAdBlocking } from "./network/ad-blocking";
import { installDownloadHandler } from "./network/downloads";
import { startBackgroundRevalidation, stopBackgroundRevalidation } from "./premium/manager";
import { startTelemetry, stopTelemetry } from "./telemetry/posthog";
import * as bookmarkManager from "./bookmarks/manager";
import * as historyManager from "./history/manager";
import {
  getRuntimeHealth,
  initializeRuntimeHealth,
  setStartupIssues,
} from "./health/runtime-health";
import {
  registerHighlightShortcut,
  setupAppMenu,
  loadRenderers,
} from "./startup";
import { createSplashWindow, closeSplash } from "./splash";
import { getHighlightCount } from "./highlights/inject";
import type { RuntimeHealthIssue, VesselSettings } from "../shared/types";
import * as highlightsManager from "./highlights/manager";
import { createLogger } from "../shared/logger";

const logger = createLogger("Bootstrap");
import * as autofillManager from "./autofill/manager";
import * as pageSnapshots from "./content/page-snapshots";

let runtime: AgentRuntime | null = null;

function configureUserAgent(): void {
  const originalUA = session.defaultSession.getUserAgent();
  const maskedUA =
    originalUA.replace(/ Electron\/[^\s]+/, "") + " Vessel/" + app.getVersion();
  session.defaultSession.setUserAgent(maskedUA);
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
  configureUserAgent();
  const splash = createSplashWindow();
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
  const syncActiveHighlightCount = async (
    state: ReturnType<typeof createMainWindow>,
  ): Promise<void> => {
    const activeTab = state.tabManager.getActiveTab();
    const wc = activeTab?.view.webContents;
    let count = 0;
    if (wc && !wc.isDestroyed()) {
      try {
        count = (await getHighlightCount(wc)) ?? 0;
      } catch {
        count = 0;
      }
    }
    if (!state.chromeView.webContents.isDestroyed()) {
      state.chromeView.webContents.send(Channels.HIGHLIGHT_COUNT_UPDATE, count);
    }
    if (!state.sidebarView.webContents.isDestroyed()) {
      state.sidebarView.webContents.send(Channels.HIGHLIGHT_COUNT_UPDATE, count);
    }
    if (!state.devtoolsPanelView.webContents.isDestroyed()) {
      state.devtoolsPanelView.webContents.send(
        Channels.HIGHLIGHT_COUNT_UPDATE,
        count,
      );
    }
  };
  const windowState = createMainWindow((tabs, activeId) => {
    windowState.chromeView.webContents.send(
      Channels.TAB_STATE_UPDATE,
      tabs,
      activeId,
    );
    void syncActiveHighlightCount(windowState);
    layoutViews(windowState);
    runtime?.onTabStateChanged();
  });

  let didRevealMainWindow = false;
  const revealMainWindow = () => {
    if (didRevealMainWindow) return;
    didRevealMainWindow = true;
    windowState.mainWindow.show();
    closeSplash(splash, 0);
  };
  let didInitializeChromeRenderer = false;

  // Safety valve: never leave both the splash and the main window hidden.
  const splashTimeout = setTimeout(() => {
    logger.warn("Renderer did not finish loading before splash timeout");
    revealMainWindow();
  }, 8000);


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

  // Register Ctrl+H highlight capture shortcut
  registerHighlightShortcut(windowState.mainWindow, tabManager);

  // Set up the application menu
  setupAppMenu();

  bookmarkManager.subscribe((state) => {
    chromeView.webContents.send(Channels.BOOKMARKS_UPDATE, state);
    sidebarView.webContents.send(Channels.BOOKMARKS_UPDATE, state);
  });

  historyManager.subscribe((state) => {
    chromeView.webContents.send(Channels.HISTORY_UPDATE, state);
    sidebarView.webContents.send(Channels.HISTORY_UPDATE, state);
  });

  installDownloadHandler(chromeView);
  startBackgroundRevalidation();
  startTelemetry();

  const initializeChromeRenderer = () => {
    if (didInitializeChromeRenderer) return;
    didInitializeChromeRenderer = true;

    const savedSession = runtime.getState().session;
    if (settings.autoRestoreSession && savedSession?.tabs.length) {
      runtime.restoreSession(savedSession);
    } else {
      tabManager.createTab(settings.defaultUrl);
      runtime.captureSession("Initial session");
    }
    layoutViews(windowState);
    setImmediate(() => layoutViews(windowState));

    clearTimeout(splashTimeout);
    revealMainWindow();

    void maybeShowStartupHealthDialog(windowState);
  };

  // Register load/fail listeners before triggering renderer navigation so
  // local file loads cannot finish before startup is listening.
  chromeView.webContents.once("dom-ready", () => {
    initializeChromeRenderer();
  });
  chromeView.webContents.once("did-finish-load", () => {
    initializeChromeRenderer();
  });

  chromeView.webContents.once(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      logger.error(
        "Chrome renderer failed to load:",
        errorCode,
        errorDescription,
        validatedURL,
      );
      clearTimeout(splashTimeout);
      revealMainWindow();
    },
  );

  // Load renderer views only after startup listeners are in place.
  loadRenderers(chromeView, sidebarView, devtoolsPanelView);

  // Start MCP server in parallel — it doesn't need to be ready before the
  // renderer shows, and awaiting it was blocking did-finish-load registration.
  startMcpServer(tabManager, runtime, settings.mcpPort).catch((err: unknown) => {
    logger.error("MCP server failed to start:", err);
  });
}

// --- Top-level error handlers (before app is ready) ---

/** Prevent silent crashes — log and exit gracefully. */
process.on("uncaughtException", (error: Error) => {
  logger.error("Uncaught exception:", error.message, error.stack);
  app.quit();
});

/** Handle rejected Promises that bubble up without a .catch() */
process.on("unhandledRejection", (reason: unknown) => {
  logger.error(
    "Unhandled rejection:",
    reason instanceof Error ? reason.message : reason,
  );
});

app.whenReady().then(bootstrap).catch((error) => {
  logger.error("Failed to bootstrap application:", error);
  app.quit();
});

  app.on("window-all-closed", () => {
  globalShortcut.unregisterAll();
  stopTelemetry();
  stopBackgroundRevalidation();
  void Promise.all([
    runtime?.flushPersist() ?? Promise.resolve(),
    bookmarkManager.flushPersist(),
    historyManager.flushPersist(),
    highlightsManager.flushPersist(),
    autofillManager.flushPersist(),
    pageSnapshots.flushPersist(),
    flushSettingsPersist(),
  ]).finally(() => {
    void stopMcpServer().finally(() => {
      app.quit();
    });
  });
});
