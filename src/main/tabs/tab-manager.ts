import { BaseWindow } from "electron";
import { Tab } from "./tab";
import { randomUUID } from "crypto";
import type { SessionSnapshot, TabState } from "../../shared/types";

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
    options?: { background?: boolean },
  ): string {
    const background = options?.background ?? false;
    const id = randomUUID();
    const tab = new Tab(id, url, () => this.broadcastState());
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

  goBack(id: string): void {
    this.tabs.get(id)?.goBack();
  }

  goForward(id: string): void {
    this.tabs.get(id)?.goForward();
  }

  reloadTab(id: string): void {
    this.tabs.get(id)?.reload();
  }

  getActiveTab(): Tab | undefined {
    return this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  getAllStates(): TabState[] {
    return this.order.map((id) => this.tabs.get(id)!.state);
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
        url: state.url || "about:blank",
        title: state.title,
      })),
      activeIndex: activeIndex >= 0 ? activeIndex : 0,
      capturedAt: new Date().toISOString(),
      note,
    };
  }

  restoreSession(snapshot: SessionSnapshot): string[] {
    const tabs =
      snapshot.tabs.length > 0
        ? snapshot.tabs
        : [{ url: "about:blank", title: "New Tab" }];
    const activeIndex = Math.max(
      0,
      Math.min(snapshot.activeIndex, tabs.length - 1),
    );

    this.destroyAllTabs();
    const ids = tabs.map((tab, index) =>
      this.createTab(tab.url || "about:blank", {
        background: index !== activeIndex,
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

  private broadcastState(): void {
    const states = this.getAllStates();
    this.onStateChange(states, this.activeTabId || "");
  }
}
