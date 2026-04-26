import { BaseWindow, dialog, type WebContents } from "electron";
import { Tab } from "./tab";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import type {
  HighlightColor,
  SessionSnapshot,
  TabGroupColor,
  TabState,
} from "../../shared/types";
import { TAB_GROUP_COLORS } from "../../shared/types";
import { createLogger } from "../../shared/logger";
import * as highlightsManager from "../highlights/manager";
import { highlightOnPage, highlightBatchOnPage } from "../highlights/inject";
import {
  captureSelectionHighlight,
  type HighlightCaptureResult,
} from "../highlights/capture";
import * as historyManager from "../history/manager";
import { destroySession } from "../devtools/manager";

export type { HighlightCaptureResult };

const logger = createLogger("TabManager");
export interface TabGroup {
  id: string;
  name: string;
  color: TabGroupColor;
  collapsed: boolean;
}

function sanitizePdfFilename(title: string): string {
  const clean = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base = (clean || "Vessel Page").replace(/\.pdf$/i, "");
  return `${base}.pdf`;
}

export class TabManager {
  private tabs: Map<string, Tab> = new Map();
  private order: string[] = [];
  private tabGroups: Map<string, TabGroup> = new Map();
  private activeTabId: string | null = null;
  private window: BaseWindow;
  private onStateChange: (tabs: TabState[], activeId: string) => void;
  private highlightCaptureCallback:
    | ((result: HighlightCaptureResult) => void)
    | null = null;
  private pageLoadCallback: ((url: string, wc: WebContents) => void) | null = null;
  private closedTabs: { url: string; title: string; adBlockingEnabled: boolean }[] = [];
  private readonly MAX_CLOSED_TABS = 20;
  readonly isPrivate: boolean;
  private readonly sessionPartition: string | undefined;

  constructor(
    window: BaseWindow,
    onStateChange: (tabs: TabState[], activeId: string) => void,
    options?: { isPrivate?: boolean; sessionPartition?: string },
  ) {
    this.window = window;
    this.onStateChange = onStateChange;
    this.isPrivate = options?.isPrivate ?? false;
    this.sessionPartition =
      options?.sessionPartition ?? (this.isPrivate ? "private-mode" : undefined);
  }

  onPageLoad(cb: (url: string, wc: WebContents) => void): void {
    this.pageLoadCallback = cb;
  }

  createTab(
    url: string = "about:blank",
    options?: { background?: boolean; adBlockingEnabled?: boolean },
  ): string {
    const background = options?.background ?? false;
    const id = randomUUID();
    const tab = new Tab(id, url, () => this.broadcastState(), {
      adBlockingEnabled: options?.adBlockingEnabled,
      parentWindow: this.window,
      sessionPartition: this.sessionPartition,
      onOpenUrl: ({ url: requestedUrl, background, adBlockingEnabled }) => {
        this.createTab(requestedUrl, { background, adBlockingEnabled });
      },
      onPageLoad: (pageUrl, wc) => {
        this.reapplyHighlights(pageUrl, wc);
        if (!this.isPrivate) {
          historyManager.addEntry(pageUrl, wc.getTitle());
        }
        this.pageLoadCallback?.(pageUrl, wc);
      },
      onHighlightSelection: (wc) => this.captureHighlightFromPage(wc),
      onHighlightRemove: (url, text) => this.removeHighlightByText(url, text),
      onHighlightRecolor: (url, text, color) =>
        this.recolorHighlightByText(url, text, color),
    });
    this.tabs.set(id, tab);
    this.order.push(id);
    this.window.contentView.addChildView(tab.view);
    if (background) {
      tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      this.broadcastState();
    } else {
      this.switchTab(id);
    }
    return id;
  }

  switchTab(id: string): void {
    if (!this.tabs.has(id)) return;

    // Hide current tab
    if (this.activeTabId && this.activeTabId !== id) {
      const current = this.tabs.get(this.activeTabId);
      if (current) {
        current.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
    }

    this.activeTabId = id;
    this.broadcastState();
  }

  closeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (tab.state.isPinned) return; // Pinned tabs cannot be closed
    const groupId = tab.state.groupId;

    // Remember closed tab for reopening
    this.closedTabs.push({
      url: tab.state.url,
      title: tab.state.title,
      adBlockingEnabled: tab.state.adBlockingEnabled,
    });
    if (this.closedTabs.length > this.MAX_CLOSED_TABS) {
      this.closedTabs.shift();
    }

    // Clean up lastReapply entry to prevent memory leak
    const wcId = tab.webContentsId;
    if (wcId !== undefined) {
      this.lastReapply.delete(wcId);
    }

    destroySession(id);
    this.window.contentView.removeChildView(tab.view);
    tab.destroy();
    this.tabs.delete(id);
    this.order = this.order.filter((tid) => tid !== id);
    this.removeGroupIfEmpty(groupId);

    if (this.activeTabId === id) {
      if (this.order.length > 0) {
        this.switchTab(this.order[this.order.length - 1]);
      } else {
        this.createTab();
      }
    } else {
      this.broadcastState();
    }
  }

  navigateTab(
    id: string,
    url: string,
    postBody?: Record<string, string>,
  ): string | null {
    const tab = this.tabs.get(id);
    if (!tab) return `No tab with id ${id}`;
    return tab.navigate(url, postBody);
  }

  goBack(id: string): boolean {
    return this.tabs.get(id)?.goBack() ?? false;
  }

  goForward(id: string): boolean {
    return this.tabs.get(id)?.goForward() ?? false;
  }

  reloadTab(id: string): void {
    this.tabs.get(id)?.reload();
  }

  zoomIn(id: string): void {
    this.tabs.get(id)?.zoomIn();
  }

  zoomOut(id: string): void {
    this.tabs.get(id)?.zoomOut();
  }

  zoomReset(id: string): void {
    this.tabs.get(id)?.zoomReset();
  }

  reopenClosedTab(): string | null {
    const last = this.closedTabs.pop();
    if (!last) return null;
    return this.createTab(last.url, { adBlockingEnabled: last.adBlockingEnabled });
  }

  duplicateTab(id: string): string | null {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    return this.createTab(tab.state.url, { adBlockingEnabled: tab.state.adBlockingEnabled });
  }

  pinTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.setPinned(true);
    // Move pinned tab to the front of the order
    this.order = this.order.filter((tid) => tid !== id);
    const firstNonPinned = this.order.findIndex((tid) => !this.tabs.get(tid)?.state.isPinned);
    if (firstNonPinned === -1) {
      this.order.push(id);
    } else {
      this.order.splice(firstNonPinned, 0, id);
    }
    this.broadcastState();
  }

  unpinTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.setPinned(false);
    // Move after all pinned tabs
    this.order = this.order.filter((tid) => tid !== id);
    const firstNonPinned = this.order.findIndex((tid) => !this.tabs.get(tid)?.state.isPinned);
    if (firstNonPinned === -1) {
      this.order.push(id);
    } else {
      this.order.splice(firstNonPinned, 0, id);
    }
    this.broadcastState();
  }

  createGroupFromTab(
    id: string,
    options?: { name?: string; color?: TabGroupColor },
  ): string | null {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    const previousGroupId = tab.state.groupId;
    const groupId = randomUUID();
    const color =
      options?.color && TAB_GROUP_COLORS.includes(options.color)
        ? options.color
        : TAB_GROUP_COLORS[this.tabGroups.size % TAB_GROUP_COLORS.length];
    this.tabGroups.set(groupId, {
      id: groupId,
      name:
        options?.name?.trim() || `Group ${this.tabGroups.size + 1}`,
      color,
      collapsed: false,
    });
    this.assignTabToGroup(id, groupId);
    this.removeGroupIfEmpty(previousGroupId);
    return groupId;
  }

  assignTabToGroup(id: string, groupId: string): void {
    const tab = this.tabs.get(id);
    if (!tab || !this.tabGroups.has(groupId)) return;
    const previousGroupId = tab.state.groupId;
    tab.setGroup(groupId);
    this.removeGroupIfEmpty(previousGroupId);
    this.broadcastState();
  }

  removeTabFromGroup(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const groupId = tab.state.groupId;
    tab.setGroup(undefined);
    this.removeGroupIfEmpty(groupId);
    this.broadcastState();
  }

  toggleGroupCollapsed(groupId: string): boolean | null {
    const group = this.tabGroups.get(groupId);
    if (!group) return null;
    group.collapsed = !group.collapsed;
    this.broadcastState();
    return group.collapsed;
  }

  setGroupColor(groupId: string, color: TabGroupColor): void {
    const group = this.tabGroups.get(groupId);
    if (!group || !TAB_GROUP_COLORS.includes(color)) return;
    group.color = color;
    this.broadcastState();
  }

  toggleMuted(id: string): boolean | null {
    return this.tabs.get(id)?.toggleMuted() ?? null;
  }

  printTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.view.webContents.print();
  }

  async saveTabAsPdf(id: string): Promise<string | null> {
    const tab = this.tabs.get(id);
    if (!tab) return null;

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Save Page as PDF",
      defaultPath: sanitizePdfFilename(tab.state.title || "Vessel Page"),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return null;

    const data = await tab.view.webContents.printToPDF({
      printBackground: true,
    });
    await fs.writeFile(filePath, data);
    return filePath;
  }

  getActiveTab(): Tab | undefined {
    return this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
  }

  getTab(id: string): Tab | undefined {
    return this.tabs.get(id);
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  getAllStates(): TabState[] {
    return this.order.map((id) => this.withGroupState(this.tabs.get(id)!.state));
  }

  getGroups(): TabGroup[] {
    return Array.from(this.tabGroups.values());
  }

  findTabByWebContentsId(webContentsId: number): Tab | undefined {
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (tab?.webContentsId === webContentsId) return tab;
    }
    return undefined;
  }

  isAdBlockingEnabledForWebContents(webContentsId: number): boolean {
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (tab?.webContentsId === webContentsId) {
        return tab.state.adBlockingEnabled;
      }
    }
    return false;
  }

  setAdBlockingEnabled(id: string, enabled: boolean): boolean {
    return this.tabs.get(id)?.setAdBlockingEnabled(enabled) ?? false;
  }

  snapshotSession(note?: string): SessionSnapshot {
    const states = this.getAllStates();
    const activeId = this.getActiveTabId();
    const activeIndex = Math.max(
      0,
      activeId ? this.order.indexOf(activeId) : 0,
    );

    return {
      tabs: states.map((state) => ({
        id: state.id,
        url: state.url || "about:blank",
        title: state.title,
        adBlockingEnabled: state.adBlockingEnabled,
        isPinned: state.isPinned,
        groupName: state.groupName,
        groupColor: state.groupColor,
      })),
      activeIndex: activeIndex >= 0 ? activeIndex : 0,
      activeTabId: activeId || undefined,
      capturedAt: new Date().toISOString(),
      note,
    };
  }

  restoreSession(snapshot: SessionSnapshot): string[] {
    const tabs =
      snapshot.tabs.length > 0
        ? snapshot.tabs
        : [{ id: "", url: "about:blank", title: "New Tab" }];
    const activeIndex = Math.max(
      0,
      Math.min(snapshot.activeIndex, tabs.length - 1),
    );

    this.destroyAllTabs();
    const restoredGroups = new Map<string, string>();
    const ids = tabs.map((tab, index) =>
      this.createTab(tab.url || "about:blank", {
        background: index !== activeIndex,
        adBlockingEnabled: tab.adBlockingEnabled ?? true,
      }),
    );

    tabs.forEach((tab, index) => {
      if (tab.isPinned && ids[index]) {
        this.pinTab(ids[index]);
      }
      if (tab.groupName && ids[index]) {
        const key = `${tab.groupName}|${tab.groupColor ?? "blue"}`;
        let groupId = restoredGroups.get(key);
        if (!groupId) {
          groupId = randomUUID();
          restoredGroups.set(key, groupId);
          this.tabGroups.set(groupId, {
            id: groupId,
            name: tab.groupName,
            color: tab.groupColor ?? "blue",
            collapsed: false,
          });
        }
        this.assignTabToGroup(ids[index], groupId);
      }
    });

    const activeId = ids[activeIndex];
    if (activeId) {
      this.switchTab(activeId);
    } else if (ids[0]) {
      this.switchTab(ids[0]);
    }

    return ids;
  }

  destroyAllTabs(): void {
    for (const id of [...this.order]) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      destroySession(id);
      this.window.contentView.removeChildView(tab.view);
      tab.destroy();
    }

    this.tabs.clear();
    this.order = [];
    this.tabGroups.clear();
    this.activeTabId = null;
    this.broadcastState();
  }

  private lastReapply = new Map<number, { url: string; at: number }>();

  private reapplyHighlights(url: string, wc: WebContents): void {
    const wcId = wc.id;
    const now = Date.now();
    const last = this.lastReapply.get(wcId);
    const normalized = highlightsManager.normalizeUrl(url);
    if (last && last.url === normalized && now - last.at < 500) return;
    this.lastReapply.set(wcId, { url: normalized, at: now });

    const highlights = highlightsManager.getHighlightsForUrl(url);
    const entries = highlights
      .filter((h) => h.selector || h.text)
      .map((h) => ({
        selector: h.selector ?? null,
        text: h.text,
        label: h.label,
        color: h.color,
      }));
    if (entries.length > 0) {
      void highlightBatchOnPage(wc, entries).catch((err) =>
        logger.warn("Failed to batch highlight:", err),
      );
    }
  }

  onHighlightCapture(
    callback: ((result: HighlightCaptureResult) => void) | null,
  ): void {
    this.highlightCaptureCallback = callback;
  }

  captureHighlightFromActiveTab(): HighlightCaptureResult | null {
    const activeTab = this.getActiveTab();
    if (!activeTab) {
      return { success: false, message: "No active tab" };
    }
    const wc = activeTab.view.webContents;
    this.captureHighlightFromPage(wc);
    return null;
  }

  private captureHighlightFromPage(wc: WebContents): void {
    void (async () => {
      try {
        const result = await captureSelectionHighlight(wc);
        if (result.success && result.text) {
          await highlightOnPage(wc, null, result.text, undefined, undefined, "yellow").catch((err) =>
            logger.warn("Failed to capture highlight:", err),
          );
        }
        this.highlightCaptureCallback?.(result);
      } catch (err) {
        logger.warn("Failed to capture highlight from page:", err);
        this.highlightCaptureCallback?.({
          success: false,
          message: "Could not capture selection",
        });
      }
    })();
  }

  private removeHighlightByText(url: string, text: string): void {
    const highlight = highlightsManager.findHighlightByText(url, text);
    if (highlight) {
      highlightsManager.removeHighlight(highlight.id);
    }
    // Remove visual highlights from all tabs showing this URL
    const normalized = highlightsManager.normalizeUrl(url);
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      const wc = tab.view.webContents;
      if (wc.isDestroyed()) continue;
      try {
        const tabUrl = highlightsManager.normalizeUrl(wc.getURL());
        if (tabUrl === normalized) {
          void this.removeHighlightMarksForText(wc, text);
        }
      } catch (err) {
        logger.warn("Failed to remove highlight from matching tab:", err);
      }
    }
    this.highlightCaptureCallback?.({
      success: true,
      message: "Highlight removed",
    });
  }

  private recolorHighlightByText(
    url: string,
    text: string,
    color: HighlightColor,
  ): void {
    const highlight = highlightsManager.findHighlightByText(url, text);
    if (highlight) {
      highlightsManager.updateHighlightColor(highlight.id, color);
    }
    // Re-apply highlights on all tabs showing this URL to pick up new color
    const normalized = highlightsManager.normalizeUrl(url);
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      const wc = tab.view.webContents;
      if (wc.isDestroyed()) continue;
      try {
        const tabUrl = highlightsManager.normalizeUrl(wc.getURL());
        if (tabUrl === normalized) {
          // Remove old marks for this text, then re-apply with new color
          void this.removeHighlightMarksForText(wc, text).then(() => {
            void highlightOnPage(
              wc,
              null,
              text,
              undefined,
              undefined,
              color,
            ).catch((err) =>
              logger.warn("Failed to update highlight color:", err),
            );
          });
        }
      } catch (err) {
        logger.warn("Failed to iterate highlights for color change:", err);
      }
    }
    this.highlightCaptureCallback?.({
      success: true,
      message: `Color changed to ${color}`,
    });
  }

  private withGroupState(state: TabState): TabState {
    if (!state.groupId) return state;
    const group = this.tabGroups.get(state.groupId);
    if (!group) return { ...state, groupId: undefined };
    return {
      ...state,
      groupName: group.name,
      groupColor: group.color,
      groupCollapsed: group.collapsed,
    };
  }

  private removeGroupIfEmpty(groupId?: string): void {
    if (!groupId) return;
    for (const tab of this.tabs.values()) {
      if (tab.state.groupId === groupId) return;
    }
    this.tabGroups.delete(groupId);
  }

  private async removeHighlightMarksForText(
    wc: WebContents,
    text: string,
  ): Promise<void> {
    await wc
      .executeJavaScript(
        `(function() {
        var marks = document.querySelectorAll('mark.__vessel-highlight-text[data-vessel-highlight]');
        marks.forEach(function(m) {
          if (m.textContent === ${JSON.stringify(text)}) {
            var parent = m.parentNode;
            while (m.firstChild) parent.insertBefore(m.firstChild, m);
            m.remove();
            if (parent) parent.normalize();
          }
        });
      })()`,
      )
      .catch((err) =>
        logger.warn("Failed to remove highlight marks:", err),
      );
  }

  private broadcastState(): void {
    const states = this.getAllStates();
    this.onStateChange(states, this.activeTabId || "");
  }
}
