import { ipcMain, BrowserWindow } from "electron";
import { Channels } from "../../shared/channels";
import { startCodexOAuth, cancelCodexOAuth } from "../ai/codex-oauth";
import { writeStoredCodexTokens, clearStoredCodexTokens } from "../config/settings";
import type { CodexAuthStatus } from "../../shared/types";
import { createLogger } from "../../shared/logger";

const logger = createLogger("CodexIPC");

export function registerCodexHandlers(): void {
  ipcMain.handle(Channels.CODEX_START_AUTH, async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error("No window found for sender");

      const sendStatus = (status: CodexAuthStatus, error?: string) => {
        win.webContents.send(Channels.CODEX_AUTH_STATUS, { status, error: error || null });
      };

      const tokens = await startCodexOAuth(sendStatus);
      writeStoredCodexTokens(tokens);

      return {
        ok: true as const,
        accountEmail: tokens.accountEmail || tokens.accountId,
        accountId: tokens.accountId,
      };
    } catch (err) {
      logger.error("Codex auth failed:", err);
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  });

  ipcMain.handle(Channels.CODEX_CANCEL_AUTH, () => {
    cancelCodexOAuth();
    return { ok: true };
  });

  ipcMain.handle(Channels.CODEX_DISCONNECT, () => {
    clearStoredCodexTokens();
    return { ok: true };
  });
}
