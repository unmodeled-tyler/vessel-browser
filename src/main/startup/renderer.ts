import path from "node:path";
import type { BrowserView } from "electron";

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
    const rendererFile = path.join(__dirname, "../../renderer/index.html");
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
