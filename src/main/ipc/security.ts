import { BrowserWindow, ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import type { SecurityState } from "../../shared/types";
import { assertString, assertTrustedIpcSender } from "./common";
import type { TabManager } from "../tabs/tab-manager";

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function buildCertificateDetailsHtml(state: SecurityState): string {
  const url = state.url;
  const domain = (() => {
    try {
      return new URL(url).hostname || url;
    } catch {
      return url;
    }
  })();

  const statusText =
    state.status === "secure"
      ? "This site uses a valid TLS certificate."
      : state.status === "insecure"
        ? "This site does not use HTTPS. Data sent to this site is not encrypted."
        : `Certificate error: ${state.errorMessage || "Unknown error"}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Certificate info for ${esc(domain)}</title>
  <style>
    body { background: #1a1a1e; color: #e0e0e0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.6; padding: 20px; margin: 0; }
    h1 { font-size: 14px; color: #ffffff; margin: 0 0 12px; }
    .row { margin-bottom: 8px; }
    .label { color: #9ca3af; }
  </style>
</head>
<body>
  <h1>Certificate info for ${esc(domain)}</h1>
  <div class="row"><span class="label">URL:</span> ${esc(url)}</div>
  <div class="row"><span class="label">Status:</span> ${esc(state.status)}</div>
  <div class="row"><span class="label">Details:</span> ${esc(statusText)}</div>
</body>
</html>`;
}

export function registerSecurityHandlers(tabManager: TabManager): void {
  ipcMain.handle(Channels.SECURITY_SHOW_DETAILS, async (event, state: SecurityState) => {
    assertTrustedIpcSender(event);
    const domain = (() => {
      try {
        return new URL(state.url).hostname || state.url;
      } catch {
        return state.url;
      }
    })();

    const content = buildCertificateDetailsHtml(state);

    const win = new BrowserWindow({
      width: 600,
      height: 400,
      title: `Certificate info for ${domain}`,
      backgroundColor: "#1a1a1e",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(content)}`);
  });

  ipcMain.handle(Channels.SECURITY_PROCEED_ANYWAY, (event, tabId: string) => {
    assertTrustedIpcSender(event);
    assertString(tabId, "tabId");
    tabManager.proceedAnyway(tabId);
  });

  ipcMain.handle(Channels.SECURITY_GO_BACK_TO_SAFETY, (event, tabId: string) => {
    assertTrustedIpcSender(event);
    assertString(tabId, "tabId");
    tabManager.goBackToSafety(tabId);
  });
}
