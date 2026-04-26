import { app, session, type Session } from "electron";
import fs from "node:fs";
import path from "path";
import type { WebContentsView } from "electron";
import { Channels } from "../../shared/channels";
import { loadSettings } from "../config/settings";

export interface DownloadInfo {
  filename: string;
  savePath: string;
  totalBytes: number;
  receivedBytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
}

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
  installDownloadHandlerForSession(session.defaultSession, chromeView);
}

export function installDownloadHandlerForSession(
  targetSession: Session,
  chromeView: WebContentsView,
): void {
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
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: "progressing",
    };

    if (!chromeView.webContents.isDestroyed()) {
      chromeView.webContents.send(Channels.DOWNLOAD_STARTED, info);
    }

    item.on("updated", (_event, state) => {
      info.receivedBytes = item.getReceivedBytes();
      info.totalBytes = item.getTotalBytes();
      info.state = state === "progressing" ? "progressing" : "interrupted";

      if (!chromeView.webContents.isDestroyed()) {
        chromeView.webContents.send(Channels.DOWNLOAD_PROGRESS, info);
      }
    });

    item.once("done", (_event, state) => {
      info.receivedBytes = item.getReceivedBytes();
      info.state = state === "completed" ? "completed" : "cancelled";

      if (!chromeView.webContents.isDestroyed()) {
        chromeView.webContents.send(Channels.DOWNLOAD_DONE, info);
      }
    });
  });
}
