import {
  BaseWindow,
  clipboard,
  Menu,
  MenuItem,
  WebContentsView,
  type WebContents,
} from "electron";
import path from "path";
import type { HighlightColor, TabState } from "../../shared/types";

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
  private parentWindow?: BaseWindow;
  private onChange: () => void;
  private onOpenUrl?: (request: OpenUrlRequest) => void;
  private onPageLoad?: (url: string, wc: WebContents) => void;
  private onHighlightSelection?: (wc: WebContents) => void;
  private onHighlightRemove?: (url: string, text: string) => void;
  private onHighlightRecolor?: (
    url: string,
    text: string,
    color: HighlightColor,
  ) => void;
  private _highlightModeActive = false;
  private _readerOriginalUrl: string | null = null;

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
      parentWindow?: BaseWindow;
      onOpenUrl?: (request: OpenUrlRequest) => void;
      onPageLoad?: (url: string, wc: WebContents) => void;
      onHighlightSelection?: (wc: WebContents) => void;
      onHighlightRemove?: (url: string, text: string) => void;
      onHighlightRecolor?: (
        url: string,
        text: string,
        color: HighlightColor,
      ) => void;
    },
  ) {
    this.id = id;
    this.parentWindow = options?.parentWindow;
    this.onChange = onChange;
    this.onOpenUrl = options?.onOpenUrl;
    this.onPageLoad = options?.onPageLoad;
    this.onHighlightSelection = options?.onHighlightSelection;
    this.onHighlightRemove = options?.onHighlightRemove;
    this.onHighlightRecolor = options?.onHighlightRecolor;

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

    // Right-click context menu with highlight mode toggle + highlight management
    wc.on("context-menu", (_event, params) => {
      // Check if right-click is on a highlighted element (async, then show menu)
      const x = params.x;
      const y = params.y;
      void wc
        .executeJavaScript(
          `(function() {
          var el = document.elementFromPoint(${x}, ${y});
          while (el) {
            if (el.hasAttribute && el.hasAttribute('data-vessel-highlight')) {
              return el.textContent || '';
            }
            el = el.parentElement;
          }
          return '';
        })()`,
        )
        .then((highlightedText: string) => {
          this.buildContextMenu(wc, params, highlightedText.trim());
        })
        .catch(() => {
          this.buildContextMenu(wc, params, "");
        });
    });
  }

  private buildContextMenu(
    wc: WebContents,
    params: Electron.ContextMenuParams,
    highlightedText: string,
  ): void {
    const menu = new Menu();
    const colors: HighlightColor[] = [
      "yellow",
      "red",
      "green",
      "blue",
      "purple",
      "orange",
    ];
    const colorLabels: Record<HighlightColor, string> = {
      yellow: "Yellow",
      red: "Red",
      green: "Green",
      blue: "Blue",
      purple: "Purple",
      orange: "Orange",
    };

    // If right-clicked on a highlighted element, offer management options
    if (highlightedText) {
      const url = wc.getURL();
      menu.append(
        new MenuItem({
          label: "Remove Highlight",
          click: () => this.onHighlightRemove?.(url, highlightedText),
        }),
      );
      menu.append(
        new MenuItem({
          label: "Change Color",
          submenu: colors.map(
            (color) =>
              new MenuItem({
                label: colorLabels[color],
                click: () =>
                  this.onHighlightRecolor?.(url, highlightedText, color),
              }),
          ),
        }),
      );
      menu.append(new MenuItem({ type: "separator" }));
    }

    // Highlight mode toggle
    menu.append(
      new MenuItem({
        label: this._highlightModeActive
          ? "Disable Highlighter"
          : "Enable Highlighter",
        click: () => this.setHighlightMode(!this._highlightModeActive),
      }),
    );

    // One-shot highlight when text is selected and highlight mode is off
    if (params.selectionText?.trim() && !this._highlightModeActive) {
      menu.append(
        new MenuItem({
          label: "Highlight Selection",
          click: () => this.onHighlightSelection?.(wc),
        }),
      );
    }

    menu.append(new MenuItem({ type: "separator" }));

    if (params.selectionText) {
      menu.append(new MenuItem({ role: "copy" }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ role: "cut" }));
      menu.append(new MenuItem({ role: "paste" }));
    }
    if (params.linkURL) {
      menu.append(
        new MenuItem({
          label: "Copy Link",
          click: () => clipboard.writeText(params.linkURL),
        }),
      );
    }

    menu.popup({ window: this.parentWindow });
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

  get highlightModeActive(): boolean {
    return this._highlightModeActive;
  }

  get readerOriginalUrl(): string | null {
    return this._readerOriginalUrl;
  }

  setReaderMode(enabled: boolean, originalUrl?: string): void {
    this._state.isReaderMode = enabled;
    if (enabled && originalUrl) {
      this._readerOriginalUrl = originalUrl;
    } else if (!enabled) {
      this._readerOriginalUrl = null;
    }
    this.onChange();
  }

  setHighlightMode(enabled: boolean): void {
    if (this._highlightModeActive === enabled) return;
    this._highlightModeActive = enabled;
    const wc = this.view.webContents;
    if (wc.isDestroyed()) return;

    if (enabled) {
      // Inject highlight styles + mouseup listener that wraps selections inline
      void wc.executeJavaScript(`
        (function() {
          // Ensure highlight CSS is present
          if (!document.getElementById('__vessel-highlight-styles')) {
            var cs = document.createElement('style');
            cs.id = '__vessel-highlight-styles';
            cs.textContent = ${JSON.stringify(
              `.__vessel-highlight { outline: 3px solid #f0c636 !important; outline-offset: 2px !important; box-shadow: 0 0 12px rgba(240, 198, 54, 0.5) !important; }
.__vessel-highlight-text { background: rgba(240, 198, 54, 0.3) !important; border-bottom: 2px solid #f0c636 !important; padding: 1px 2px !important; border-radius: 2px !important; }`,
            )};
            document.head.appendChild(cs);
          }
          // Visual indicator
          if (!document.getElementById('__vessel-highlight-mode-style')) {
            var s = document.createElement('style');
            s.id = '__vessel-highlight-mode-style';
            s.textContent = 'body { cursor: text !important; } body::before { content: "Highlighter ON"; position: fixed; top: 0; left: 50%; transform: translateX(-50%); background: rgba(240, 198, 54, 0.9); color: #1a1a1e; font-size: 11px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 2px 12px; border-radius: 0 0 6px 6px; z-index: 2147483647; pointer-events: none; font-weight: 600; }';
            document.head.appendChild(s);
          }
          // Auto-capture on mouseup — wrap selection range directly
          if (!window.__vesselHighlightHandler) {
            window.__vesselHighlightHandler = function() {
              var sel = window.getSelection();
              if (!sel || sel.isCollapsed) return;
              var text = sel.toString().trim();
              if (!text) return;
              // Wrap each range in mark elements
              try {
                for (var i = 0; i < sel.rangeCount; i++) {
                  var range = sel.getRangeAt(i);
                  // For simple same-node selections, use surroundContents
                  if (range.startContainer === range.endContainer) {
                    var mark = document.createElement('mark');
                    mark.className = '__vessel-highlight-text';
                    mark.style.setProperty('background', 'rgba(240, 198, 54, 0.3)', 'important');
                    mark.style.setProperty('border-bottom-color', '#f0c636', 'important');
                    mark.setAttribute('data-vessel-highlight', 'true');
                    range.surroundContents(mark);
                  } else {
                    // For cross-node selections, extract and wrap in a mark
                    var mark = document.createElement('mark');
                    mark.className = '__vessel-highlight-text';
                    mark.style.setProperty('background', 'rgba(240, 198, 54, 0.3)', 'important');
                    mark.style.setProperty('border-bottom-color', '#f0c636', 'important');
                    mark.setAttribute('data-vessel-highlight', 'true');
                    var contents = range.extractContents();
                    mark.appendChild(contents);
                    range.insertNode(mark);
                  }
                }
              } catch(e) {}
              sel.removeAllRanges();
              // Notify main process for persistence
              window.__vessel.notifyHighlightSelection(text);
            };
            document.addEventListener('mouseup', window.__vesselHighlightHandler);
          }
        })()
      `).catch(() => {});
    } else {
      // Remove listener and visual indicator
      void wc.executeJavaScript(`
        (function() {
          var s = document.getElementById('__vessel-highlight-mode-style');
          if (s) s.remove();
          if (window.__vesselHighlightHandler) {
            document.removeEventListener('mouseup', window.__vesselHighlightHandler);
            delete window.__vesselHighlightHandler;
          }
        })()
      `).catch(() => {});
    }
  }

  get webContentsId(): number {
    return this.view.webContents.id;
  }

  destroy(): void {
    this.setHighlightMode(false);
    this.view.webContents.close();
  }
}
