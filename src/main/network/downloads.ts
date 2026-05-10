import { app, session, WebContentsView, type Session } from "electron";
import fs from "node:fs";
import path from "path";
import { Channels } from "../../shared/channels";
import { loadSettings } from "../config/settings";
import { upsertDownload } from "./download-manager";

export interface DownloadInfo {
  filename: string;
  savePath: string;
  url?: string;
  mimeType?: string;
  totalBytes: number;
  receivedBytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
}

const defaultDownloadViews = new Set<WebContentsView>();
let defaultDownloadHandlerInstalled = false;

function resolveDownloadPath(downloadDir: string, filename: string): string {
  fs.mkdirSync(downloadDir, { recursive: true });

  const parsed = path.parse(filename);
  let attempt = 0;

  while (true) {
    const candidateName =
      attempt === 0
        ? filename
        : `${parsed.name} (${attempt})${parsed.ext}`;
    const candidatePath = path.join(downloadDir, candidateName);
    if (!fs.existsSync(candidatePath)) {
      return candidatePath;
    }
    attempt += 1;
  }
}

/**
 * Install the download handler on the default session.
 * Downloads are saved to the user's configured downloadPath (or ~/Downloads by default).
 * Progress and completion events are forwarded to the chrome renderer view.
 */
export function installDownloadHandler(
  chromeView: WebContentsView,
): void {
  defaultDownloadViews.add(chromeView);
  if (defaultDownloadHandlerInstalled) return;
  defaultDownloadHandlerInstalled = true;
  installDownloadHandlerForSession(session.defaultSession, defaultDownloadViews);
}

export function unregisterDownloadHandler(chromeView: WebContentsView): void {
  defaultDownloadViews.delete(chromeView);
}

export function installDownloadHandlerForSession(
  targetSession: Session,
  chromeView: WebContentsView | ReadonlySet<WebContentsView>,
): void {
  const send = (channel: string, info: DownloadInfo) => {
    const views =
      chromeView instanceof WebContentsView ? [chromeView] : [...chromeView];
    for (const view of views) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.send(channel, info);
      }
    }
  };

  targetSession.on("will-download", (_event, item) => {
    const settings = loadSettings();
    const downloadDir =
      settings.downloadPath.trim() ||
      app.getPath("downloads");

    const filename = item.getFilename();
    const savePath = resolveDownloadPath(downloadDir, filename);
    item.setSavePath(savePath);

    const info: DownloadInfo = {
      filename,
      savePath,
      url: item.getURL(),
      mimeType: typeof item.getMimeType === "function" ? item.getMimeType() : undefined,
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: "progressing",
    };

    const record = upsertDownload(info);
    send(Channels.DOWNLOAD_STARTED, { ...info, id: record.id, startedAt: record.startedAt, updatedAt: record.updatedAt });

    item.on("updated", (_event, state) => {
      info.receivedBytes = item.getReceivedBytes();
      info.totalBytes = item.getTotalBytes();
      info.state = state === "progressing" ? "progressing" : "interrupted";

      const record = upsertDownload(info);
      send(Channels.DOWNLOAD_PROGRESS, { ...info, id: record.id, startedAt: record.startedAt, updatedAt: record.updatedAt });
    });

    item.once("done", (_event, state) => {
      info.receivedBytes = item.getReceivedBytes();
      info.state = state === "completed" ? "completed" : "cancelled";

      const record = upsertDownload(info);
      send(Channels.DOWNLOAD_DONE, { ...info, id: record.id, startedAt: record.startedAt, updatedAt: record.updatedAt });
    });
  });
}
