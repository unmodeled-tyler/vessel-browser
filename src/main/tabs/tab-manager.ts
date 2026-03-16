import { BaseWindow, type WebContents } from "electron";
import { Tab } from "./tab";
import { randomUUID } from "crypto";
import type { SessionSnapshot, TabState } from "../../shared/types";
import * as highlightsManager from "../highlights/manager";
import { highlightOnPage } from "../highlights/inject";

export class TabManager {
  private tabs: Map<string, Tab> = new Map();
  private order: string[] = [];
  private activeTabId: string | null = null;
  private window: BaseWindow;
  private onStateChange: (tabs: TabState[], activeId: string) => void;

  constructor(
    window: BaseWindow,
    onStateChange: (tabs: TabState[], activeId: string) => void,
  ) {
    this.window = window;
    this.onStateChange = onStateChange;
  }

  createTab(
    url: string = "about:blank",
    options?: { background?: boolean; adBlockingEnabled?: boolean },
  ): string {
    const background = options?.background ?? false;
    const id = randomUUID();
    const tab = new Tab(id, url, () => this.broadcastState(), {
      adBlockingEnabled: options?.adBlockingEnabled,
      onOpenUrl: ({ url: requestedUrl, background, adBlockingEnabled }) => {
        this.createTab(requestedUrl, { background, adBlockingEnabled });
      },
      onPageLoad: (pageUrl, wc) => this.reapplyHighlights(pageUrl, wc),
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

    this.window.contentView.removeChildView(tab.view);
    tab.destroy();
    this.tabs.delete(id);
    this.order = this.order.filter((tid) => tid !== id);

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

  navigateTab(id: string, url: string): void {
    const tab = this.tabs.get(id);
    if (tab) tab.navigate(url);
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
    return this.order.map((id) => this.tabs.get(id)!.state);
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
    const ids = tabs.map((tab, index) =>
      this.createTab(tab.url || "about:blank", {
        background: index !== activeIndex,
        adBlockingEnabled: tab.adBlockingEnabled ?? true,
      }),
    );

    const activeId = ids[activeIndex];
    if (activeId) {
      this.switchTab(activeId);
    } else if (ids[0]) {
      this.switchTab(ids[0]);
    }

    return ids;
  }

  private destroyAllTabs(): void {
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      this.window.contentView.removeChildView(tab.view);
      tab.destroy();
    }

    this.tabs.clear();
    this.order = [];
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
    for (const h of highlights) {
      if (!h.selector && !h.text) continue;
      void highlightOnPage(wc, h.selector ?? null, h.text, h.label).catch(
        () => {},
      );
    }
  }

  private broadcastState(): void {
    const states = this.getAllStates();
    this.onStateChange(states, this.activeTabId || "");
  }
}
