import { BaseWindow, type WebContents } from "electron";
import { Tab } from "./tab";
import { randomUUID } from "crypto";
import type { HighlightColor, SessionSnapshot, TabState } from "../../shared/types";
import * as highlightsManager from "../highlights/manager";
import { highlightOnPage } from "../highlights/inject";

export type HighlightCaptureResult = {
  success: boolean;
  text?: string;
  message?: string;
  id?: string;
};

export class TabManager {
  private tabs: Map<string, Tab> = new Map();
  private order: string[] = [];
  private activeTabId: string | null = null;
  private window: BaseWindow;
  private onStateChange: (tabs: TabState[], activeId: string) => void;
  private highlightCaptureCallback:
    | ((result: HighlightCaptureResult) => void)
    | null = null;

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
      parentWindow: this.window,
      onOpenUrl: ({ url: requestedUrl, background, adBlockingEnabled }) => {
        this.createTab(requestedUrl, { background, adBlockingEnabled });
      },
      onPageLoad: (pageUrl, wc) => this.reapplyHighlights(pageUrl, wc),
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
      void highlightOnPage(
        wc,
        h.selector ?? null,
        h.text,
        h.label,
        undefined,
        h.color,
      ).catch(() => {});
    }
  }

  onHighlightCapture(
    callback: ((result: HighlightCaptureResult) => void) | null,
  ): void {
    this.highlightCaptureCallback = callback;
  }

  captureHighlightFromActiveTab(): HighlightCaptureResult | null {
    console.log("[Vessel] captureHighlightFromActiveTab called");
    const activeTab = this.getActiveTab();
    if (!activeTab) {
      console.log("[Vessel] No active tab in captureHighlightFromActiveTab");
      return { success: false, message: "No active tab" };
    }
    const wc = activeTab.view.webContents;
    console.log("[Vessel] Calling captureHighlightFromPage for:", wc.getURL());
    this.captureHighlightFromPage(wc);
    return null;
  }

  private captureHighlightFromPage(wc: WebContents): void {
    console.log("[Vessel] captureHighlightFromPage called");
    void (async () => {
      try {
        if (wc.isDestroyed()) {
          console.log("[Vessel] WebContents destroyed");
          return;
        }
        const url = wc.getURL();
        console.log("[Vessel] URL:", url);
        if (!url || url === "about:blank") {
          console.log("[Vessel] No URL or about:blank");
          return;
        }

        const selectedText: string = await wc.executeJavaScript(`
          (function() {
            var sel = window.getSelection();
            return sel ? sel.toString().trim() : '';
          })()
        `);
        console.log("[Vessel] Selected text:", selectedText?.slice(0, 50));

        if (!selectedText) return;

        const capped =
          selectedText.length > 5000
            ? selectedText.slice(0, 5000)
            : selectedText;

        const highlight = highlightsManager.addHighlight(
          url,
          undefined,
          capped,
          undefined,
          "yellow",
          "user",
        );

        await highlightOnPage(
          wc,
          null,
          capped,
          undefined,
          undefined,
          "yellow",
        ).catch(() => {});

        this.highlightCaptureCallback?.({
          success: true,
          text: capped,
          id: highlight.id,
        });
      } catch {
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
      } catch {}
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
            ).catch(() => {});
          });
        }
      } catch {}
    }
    this.highlightCaptureCallback?.({
      success: true,
      message: `Color changed to ${color}`,
    });
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
      .catch(() => {});
  }

  private broadcastState(): void {
    const states = this.getAllStates();
    this.onStateChange(states, this.activeTabId || "");
  }
}
