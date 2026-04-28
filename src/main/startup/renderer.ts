import path from "node:path";
import { existsSync } from "node:fs";
import { app, type BrowserView } from "electron";

/**
 * Returns the dev-mode renderer URL for a given view name, or null if
 * ELECTRON_RENDERER_URL is not set (production).
 */
function rendererUrlFor(
  view: "chrome" | "sidebar" | "devtools",
): string | null {
  if (!process.env.ELECTRON_RENDERER_URL) return null;
  const url = new URL(process.env.ELECTRON_RENDERER_URL);
  url.searchParams.set("view", view);
  return url.toString();
}

export function resolveRendererFile(): string {
  const candidates = [
    path.join(__dirname, "../renderer/index.html"),
    path.join(__dirname, "../../out/renderer/index.html"),
    path.join(app.getAppPath(), "out/renderer/index.html"),
    path.join(app.getAppPath(), "renderer/index.html"),
  ];

  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error(
      `Could not locate renderer/index.html. Tried: ${candidates.join(", ")}`,
    );
  }
  return match;
}

/**
 * Loads the SolidJS renderer views (chrome, sidebar, devtools panel).
 * Uses ELECTRON_RENDERER_URL when in dev mode, otherwise loads from the
 * bundled renderer file.
 */
export function loadRenderers(
  chromeView: BrowserView,
  sidebarView: BrowserView,
  devtoolsPanelView: BrowserView,
): void {
  const chromeUrl = rendererUrlFor("chrome");
  const sidebarUrl = rendererUrlFor("sidebar");
  const devtoolsUrl = rendererUrlFor("devtools");

  if (chromeUrl && sidebarUrl && devtoolsUrl) {
    chromeView.webContents.loadURL(chromeUrl);
    sidebarView.webContents.loadURL(sidebarUrl);
    devtoolsPanelView.webContents.loadURL(devtoolsUrl);
  } else {
    const rendererFile = resolveRendererFile();
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
}
