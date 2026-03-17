import type { TabManager } from "../tabs/tab-manager";
import { DevToolsSession } from "./session";

const sessions = new Map<string, DevToolsSession>();

export function getOrCreateSession(tabManager: TabManager): DevToolsSession {
  const tabId = tabManager.getActiveTabId();
  const tab = tabManager.getActiveTab();
  if (!tabId || !tab) {
    throw new Error("No active tab");
  }

  const existing = sessions.get(tabId);
  if (existing) return existing;

  const session = new DevToolsSession(tabId, tab.view.webContents);
  sessions.set(tabId, session);
  return session;
}

export function getSession(tabId: string): DevToolsSession | undefined {
  return sessions.get(tabId);
}

export function destroySession(tabId: string): void {
  const session = sessions.get(tabId);
  if (session) {
    session.destroy();
    sessions.delete(tabId);
  }
}

export function destroyAllSessions(): void {
  for (const session of sessions.values()) {
    session.destroy();
  }
  sessions.clear();
}
