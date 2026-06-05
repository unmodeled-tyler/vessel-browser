import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { Tab } from "../tabs/tab";
import type { WebContents } from "electron";
import { z } from "zod";

const trustedIpcSenderIds = new Set<number>();

export function registerTrustedIpcSender(wc: WebContents): void {
  trustedIpcSenderIds.add(wc.id);
  wc.once("destroyed", () => trustedIpcSenderIds.delete(wc.id));
}

export function assertTrustedIpcSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
): void {
  if (!trustedIpcSenderIds.has(event.sender.id)) {
    throw new Error("Blocked IPC from untrusted renderer");
  }
}

export function isManagedTabIpcSender(
  event: IpcMainEvent,
  tabManager: { findTabByWebContentsId(webContentsId: number): unknown },
): boolean {
  return Boolean(tabManager.findTabByWebContentsId(event.sender.id));
}

/**
 * Parse an IPC payload with a Zod schema. Throws a clean error on invalid input.
 */
export function parseIpc<T>(
  schema: z.ZodSchema<T>,
  value: unknown,
  label?: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues.map((i) => i.message).join("; ");
    throw new Error(
      label ? `Invalid ${label}: ${message}` : `Invalid input: ${message}`,
    );
  }
  return result.data;
}

export function assertString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
}

export function assertOptionalString(
  value: unknown,
  name: string,
): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
}

export function assertNumber(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${name} must be a number`);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export interface ActiveTabInfo {
  tab: Tab;
  wc: WebContents;
}

/**
 * Returns the active tab and its webContents if both are available and the
 * webContents is not destroyed. Returns null otherwise.
 */
export function getActiveTabInfo(
  tabManager: { getActiveTab(): Tab | undefined },
): ActiveTabInfo | null {
  const tab = tabManager.getActiveTab();
  if (!tab) return null;
  const wc = tab.view.webContents;
  if (wc.isDestroyed()) return null;
  return { tab, wc };
}

export type SendToRendererViews = (
  channel: string,
  ...args: unknown[]
) => void;

/**
 * Factory for the common 3-view broadcast pattern (chrome + sidebar + devtools).
 * Eliminates copy-pasted inline definitions across IPC modules.
 */
export function createWindowStateMessenger(
  chromeView: Electron.WebContentsView,
  sidebarView: Electron.WebContentsView,
  devtoolsPanelView: Electron.WebContentsView,
): SendToRendererViews {
  return (channel, ...args) => {
    sendSafe(chromeView.webContents, channel, ...args);
    sendSafe(sidebarView.webContents, channel, ...args);
    sendSafe(devtoolsPanelView.webContents, channel, ...args);
  };
}

/**
 * Safely send an IPC message to a WebContents if it exists and is not destroyed.
 * Logs a debug warning if the target is destroyed.
 */
export function sendSafe(
  wc: WebContents | undefined,
  channel: string,
  ...args: unknown[]
): void {
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.send(channel, ...args);
  } catch (err) {
    // Swallow — sender may have been destroyed between check and send
    // Keep silent unless VESSEL_DEBUG is on
    if (process.env.VESSEL_DEBUG === "1" || process.env.VESSEL_DEBUG === "true") {
      console.debug("sendSafe failed for channel", channel, err);
    }
  }
}
