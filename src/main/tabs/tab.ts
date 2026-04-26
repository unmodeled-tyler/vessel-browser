import {
  BaseWindow,
  clipboard,
  Menu,
  MenuItem,
  session,
  WebContentsView,
  type WebContents,
} from "electron";
import path from "path";
import type { HighlightColor, TabRole, TabState } from "../../shared/types";
import { createLogger } from "../../shared/logger";
import { checkDomainPolicy } from "../network/domain-policy";
import { assertSafeURL } from "../network/url-safety";

const MAX_CUSTOM_HISTORY = 50;
const READER_MODE_DATA_URL_PREFIX = "data:text/html;charset=utf-8,";
const logger = createLogger("Tab");

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

  private isReaderModeDataUrl(url: string): boolean {
    return (
      this._state.isReaderMode &&
      url.startsWith(READER_MODE_DATA_URL_PREFIX)
    );
  }

  private getNavigationBlockReason(url: string): string | null {
    if (!url) {
      return "Blocked navigation to empty URL";
    }
    if (url.startsWith("about:") || this.isReaderModeDataUrl(url)) {
      return null;
    }
    try {
      assertSafeURL(url);
    } catch (error) {
      return error instanceof Error ? error.message : "Blocked unsafe navigation";
    }
    return checkDomainPolicy(url);
  }

  private guardedLoadURL(
    url: string,
    options?: Electron.LoadURLOptions,
  ): string | null {
    const blockReason = this.getNavigationBlockReason(url);
    if (blockReason) {
      logger.warn(blockReason);
      return blockReason;
    }
    void this.view.webContents.loadURL(url, options);
    return null;
  }

  constructor(
    id: string,
    url: string,
    onChange: () => void,
    options?: {
      adBlockingEnabled?: boolean;
      role?: TabRole;
      parentWindow?: BaseWindow;
      sessionPartition?: string;
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

    const webPreferences: Electron.WebPreferences = {
      preload: path.join(__dirname, "../preload/content-script.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    };
    if (options?.sessionPartition) {
      webPreferences.session = session.fromPartition(options.sessionPartition);
    }
    this.view = new WebContentsView({ webPreferences });

    const initialUrl = url || "about:blank";

    this._state = {
      id,
      title: "New Tab",
      url: initialUrl,
      favicon: "",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isReaderMode: false,
      adBlockingEnabled: options?.adBlockingEnabled ?? true,
      isPinned: false,
      isAudible: false,
      isMuted: false,
      role: options?.role,
    };

    // Ensure clipboard shortcuts work in tab content
    // Don't preventDefault — let the page handle clipboard natively.
    // Only intercept as fallback when the focused view doesn't route the event.
    this.view.webContents.on("before-input-event", (event, input) => {
      if (!input.control && !input.meta) return;
      if (input.type !== "keyDown") return;
      const key = input.key.toLowerCase();
      const wc = this.view.webContents;

      if (key === "+" || key === "=") {
        this.zoomIn();
        event.preventDefault();
        return;
      }
      if (key === "-") {
        this.zoomOut();
        event.preventDefault();
        return;
      }
      if (key === "0") {
        this.zoomReset();
        event.preventDefault();
        return;
      }

      // Use Electron's clipboard methods but don't block the event —
      // this lets pages with custom clipboard handlers still work.
      if (key === "c") wc.copy();
      else if (key === "v") wc.paste();
      else if (key === "x") wc.cut();
      else if (key === "a") wc.selectAll();
    });

    this.setupListeners();
    if (url) {
      const error = this.guardedLoadURL(url);
      if (error) {
        this._state.url = "about:blank";
      } else {
        this.lastCommittedUrl = url;
      }
    }
  }

  private setupListeners(): void {
    const wc = this.view.webContents;

    wc.setWindowOpenHandler(({ url, disposition }) => {
      const error = this.getNavigationBlockReason(url);
      if (error) {
        logger.warn(error);
        return { action: "deny" };
      }
      this.onOpenUrl?.({
        url,
        background: disposition === "background-tab",
        adBlockingEnabled: this._state.adBlockingEnabled,
      });
      return { action: "deny" };
    });

    const blockNavigation = (
      event: Electron.Event,
      url: string,
      context: string,
    ) => {
      const error = this.getNavigationBlockReason(url);
      if (!error) return;
      event.preventDefault();
      logger.warn(`${context}: ${error}`);
    };

    wc.on("will-navigate", (event, url) => {
      blockNavigation(event, url, "Blocked top-level navigation");
    });

    wc.on("will-redirect", (event, url) => {
      blockNavigation(event, url, "Blocked redirect");
    });

    const syncNavigationState = () => {
      this._state.title = wc.getTitle() || this._state.title || "New Tab";
      this._state.url = wc.getURL() || this._state.url;
      this._state.canGoBack = this.urlHistory.length > 0;
      this._state.canGoForward = this.urlForwardStack.length > 0;
      this.onChange();
    };

    const recordNavigation = (url: string) => {
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
    };

    // Track URL changes for custom history
    wc.on("did-navigate", (_event, url) => {
      recordNavigation(url);
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

    wc.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      recordNavigation(url);
      this.onPageLoad?.(wc.getURL(), wc);
    });

    wc.on("did-finish-load", () => {
      syncNavigationState();
      this.onPageLoad?.(wc.getURL(), wc);
    });

    wc.on("dom-ready", () => {
      syncNavigationState();
      wc.insertCSS(`
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 999px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
        ::-webkit-scrollbar-corner { background: transparent; }
      `).catch((err) => logger.warn("Failed to inject scrollbar CSS:", err));
    });

    wc.on("page-favicon-updated", (_, favicons) => {
      this._state.favicon = favicons[0] || "";
      this.onChange();
    });

    wc.on("media-started-playing", () => {
      this._state.isAudible = true;
      this._state.isMuted = wc.isAudioMuted();
      this.onChange();
    });

    wc.on("media-paused", () => {
      setTimeout(() => {
        if (wc.isDestroyed()) return;
        this._state.isAudible = wc.isCurrentlyAudible();
        this._state.isMuted = wc.isAudioMuted();
        this.onChange();
      }, 250);
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
        .catch((err) => {
          logger.warn("Failed to inspect highlighted text for context menu:", err);
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

  navigate(
    url: string,
    postBody?: Record<string, string>,
  ): string | null {
    // Auto-add protocol if missing
    if (!/^https?:\/\//i.test(url) && !url.startsWith("about:")) {
      if (url.includes(".") && !url.includes(" ")) {
        url = "https://" + url;
      } else {
        url = `https://duckduckgo.com/?q=${encodeURIComponent(url)}`;
      }
    }
    if (postBody) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(postBody)) {
        params.set(key, value);
      }
      return this.guardedLoadURL(url, {
        method: "POST",
        extraHeaders: "Content-Type: application/x-www-form-urlencoded\r\n",
        postData: [
          {
            type: "rawData",
            bytes: Buffer.from(params.toString()),
          },
        ],
      });
    }
    return this.guardedLoadURL(url);
  }

  goBack(): boolean {
    const previousUrl = this.urlHistory.pop();
    if (!previousUrl) return false;
    const currentUrl = this.lastCommittedUrl;
    this.navigatingViaHistory = true;
    this.urlForwardStack.push(currentUrl);
    const error = this.guardedLoadURL(previousUrl);
    if (error) {
      this.navigatingViaHistory = false;
      this.urlForwardStack.pop();
      this.urlHistory.push(previousUrl);
      return false;
    }
    this.lastCommittedUrl = previousUrl;
    return true;
  }

  goForward(): boolean {
    const nextUrl = this.urlForwardStack.pop();
    if (!nextUrl) return false;
    const currentUrl = this.lastCommittedUrl;
    this.navigatingViaHistory = true;
    this.urlHistory.push(currentUrl);
    const error = this.guardedLoadURL(nextUrl);
    if (error) {
      this.navigatingViaHistory = false;
      this.urlHistory.pop();
      this.urlForwardStack.push(nextUrl);
      return false;
    }
    this.lastCommittedUrl = nextUrl;
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

  zoomIn(): void {
    const wc = this.view.webContents;
    const level = wc.getZoomLevel();
    wc.setZoomLevel(level + 0.5);
  }

  zoomOut(): void {
    const wc = this.view.webContents;
    const level = wc.getZoomLevel();
    wc.setZoomLevel(level - 0.5);
  }

  zoomReset(): void {
    this.view.webContents.setZoomLevel(0);
  }

  setAdBlockingEnabled(enabled: boolean): boolean {
    if (this._state.adBlockingEnabled === enabled) return false;
    this._state.adBlockingEnabled = enabled;
    this.onChange();
    return true;
  }

  setPinned(pinned: boolean): void {
    if (this._state.isPinned === pinned) return;
    this._state.isPinned = pinned;
    this.onChange();
  }

  setGroup(groupId: string | undefined): void {
    if (this._state.groupId === groupId) return;
    this._state.groupId = groupId;
    this.onChange();
  }

  setMuted(muted: boolean): void {
    const wc = this.view.webContents;
    wc.setAudioMuted(muted);
    this._state.isMuted = wc.isAudioMuted();
    this._state.isAudible = wc.isCurrentlyAudible();
    this.onChange();
  }

  toggleMuted(): boolean {
    this.setMuted(!this._state.isMuted);
    return this._state.isMuted;
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
      `).catch((err) => logger.warn("Failed to inject highlight listener:", err));
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
      `).catch((err) => logger.warn("Failed to remove highlight listener:", err));
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
