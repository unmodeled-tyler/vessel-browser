import { WebContentsView, type WebContents } from "electron";
import path from "path";
import type { TabState } from "../../shared/types";

const MAX_CUSTOM_HISTORY = 50;

interface OpenUrlRequest {
  url: string;
  background: boolean;
  adBlockingEnabled: boolean;
}

export class Tab {
  readonly id: string;
  readonly view: WebContentsView;
  private _state: TabState;
  private onChange: () => void;
  private onOpenUrl?: (request: OpenUrlRequest) => void;
  private onPageLoad?: (url: string, wc: WebContents) => void;

  // Fully custom URL history — we never rely on Chromium's native back/forward
  // because loadURL() calls (used for anchor clicks, form GETs, etc.) pollute
  // the native stack and cause direction reversals on repeated back/forward.
  private urlHistory: string[] = [];
  private urlForwardStack: string[] = [];
  private lastCommittedUrl = "";
  private navigatingViaHistory = false;

  constructor(
    id: string,
    url: string,
    onChange: () => void,
    options?: {
      adBlockingEnabled?: boolean;
      onOpenUrl?: (request: OpenUrlRequest) => void;
      onPageLoad?: (url: string, wc: WebContents) => void;
    },
  ) {
    this.id = id;
    this.onChange = onChange;
    this.onOpenUrl = options?.onOpenUrl;
    this.onPageLoad = options?.onPageLoad;

    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "../preload/content-script.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this._state = {
      id,
      title: "New Tab",
      url: url || "about:blank",
      favicon: "",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isReaderMode: false,
      adBlockingEnabled: options?.adBlockingEnabled ?? true,
    };

    this.setupListeners();
    if (url) {
      this.lastCommittedUrl = url;
      this.view.webContents.loadURL(url);
    }
  }

  private setupListeners(): void {
    const wc = this.view.webContents;

    wc.setWindowOpenHandler(({ url, disposition }) => {
      this.onOpenUrl?.({
        url,
        background: disposition === "background-tab",
        adBlockingEnabled: this._state.adBlockingEnabled,
      });
      return { action: "deny" };
    });

    const syncNavigationState = () => {
      this._state.title = wc.getTitle() || this._state.title || "New Tab";
      this._state.url = wc.getURL() || this._state.url;
      this._state.canGoBack = this.urlHistory.length > 0;
      this._state.canGoForward = this.urlForwardStack.length > 0;
      this.onChange();
    };

    // Track URL changes for custom history
    wc.on("did-navigate", (_event, url) => {
      if (this.navigatingViaHistory) {
        // Back/forward already managed the stacks — just update committed URL
        this.navigatingViaHistory = false;
        this.lastCommittedUrl = url;
        syncNavigationState();
        return;
      }
      // Normal forward navigation — push previous URL onto back stack
      if (
        this.lastCommittedUrl &&
        this.lastCommittedUrl !== url &&
        !this.lastCommittedUrl.startsWith("about:")
      ) {
        this.urlHistory.push(this.lastCommittedUrl);
        if (this.urlHistory.length > MAX_CUSTOM_HISTORY) {
          this.urlHistory.shift();
        }
        this.urlForwardStack = [];
      }
      this.lastCommittedUrl = url;
      syncNavigationState();
    });

    wc.on("page-title-updated", (_, title) => {
      this._state.title = title;
      this.onChange();
    });

    wc.on("did-start-loading", () => {
      this._state.isLoading = true;
      this.onChange();
    });

    wc.on("did-stop-loading", () => {
      this._state.isLoading = false;
      syncNavigationState();
    });

    wc.on("did-navigate-in-page", () => {
      syncNavigationState();
      this.onPageLoad?.(wc.getURL(), wc);
    });

    wc.on("did-finish-load", () => {
      syncNavigationState();
      this.onPageLoad?.(wc.getURL(), wc);
    });

    wc.on("dom-ready", () => {
      syncNavigationState();
    });

    wc.on("page-favicon-updated", (_, favicons) => {
      this._state.favicon = favicons[0] || "";
      this.onChange();
    });
  }

  get state(): TabState {
    return { ...this._state };
  }

  navigate(url: string): void {
    // Auto-add protocol if missing
    if (!/^https?:\/\//i.test(url) && !url.startsWith("about:")) {
      if (url.includes(".") && !url.includes(" ")) {
        url = "https://" + url;
      } else {
        url = `https://duckduckgo.com/?q=${encodeURIComponent(url)}`;
      }
    }
    this.view.webContents.loadURL(url);
  }

  goBack(): boolean {
    const previousUrl = this.urlHistory.pop();
    if (!previousUrl) return false;
    this.navigatingViaHistory = true;
    this.urlForwardStack.push(this.lastCommittedUrl);
    this.lastCommittedUrl = previousUrl;
    this.view.webContents.loadURL(previousUrl);
    return true;
  }

  goForward(): boolean {
    const nextUrl = this.urlForwardStack.pop();
    if (!nextUrl) return false;
    this.navigatingViaHistory = true;
    this.urlHistory.push(this.lastCommittedUrl);
    this.lastCommittedUrl = nextUrl;
    this.view.webContents.loadURL(nextUrl);
    return true;
  }

  canGoBack(): boolean {
    return this.urlHistory.length > 0;
  }

  canGoForward(): boolean {
    return this.urlForwardStack.length > 0;
  }

  reload(): void {
    this.view.webContents.reload();
  }

  setAdBlockingEnabled(enabled: boolean): boolean {
    if (this._state.adBlockingEnabled === enabled) return false;
    this._state.adBlockingEnabled = enabled;
    this.onChange();
    return true;
  }

  get webContentsId(): number {
    return this.view.webContents.id;
  }

  destroy(): void {
    this.view.webContents.close();
  }
}
