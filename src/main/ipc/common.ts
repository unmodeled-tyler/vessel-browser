import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { Tab } from "../tabs/tab";
import type { WebContents } from "electron";

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
