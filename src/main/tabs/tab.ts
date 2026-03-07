import { WebContentsView } from 'electron';
import path from 'path';
import type { TabState } from '../../shared/types';

export class Tab {
  readonly id: string;
  readonly view: WebContentsView;
  private _state: TabState;
  private onChange: () => void;

  constructor(id: string, url: string, onChange: () => void) {
    this.id = id;
    this.onChange = onChange;

    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/content-script.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this._state = {
      id,
      title: 'New Tab',
      url: url || 'about:blank',
      favicon: '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isReaderMode: false,
    };

    this.setupListeners();
    if (url) {
      this.view.webContents.loadURL(url);
    }
  }

  private setupListeners(): void {
    const wc = this.view.webContents;

    wc.on('page-title-updated', (_, title) => {
      this._state.title = title;
      this.onChange();
    });

    wc.on('did-start-loading', () => {
      this._state.isLoading = true;
      this.onChange();
    });

    wc.on('did-stop-loading', () => {
      this._state.isLoading = false;
      this._state.url = wc.getURL();
      this._state.canGoBack = wc.canGoBack();
      this._state.canGoForward = wc.canGoForward();
      this.onChange();
    });

    wc.on('did-navigate', () => {
      this._state.url = wc.getURL();
      this._state.canGoBack = wc.canGoBack();
      this._state.canGoForward = wc.canGoForward();
      this.onChange();
    });

    wc.on('page-favicon-updated', (_, favicons) => {
      this._state.favicon = favicons[0] || '';
      this.onChange();
    });
  }

  get state(): TabState {
    return { ...this._state };
  }

  navigate(url: string): void {
    // Auto-add protocol if missing
    if (!/^https?:\/\//i.test(url) && !url.startsWith('about:')) {
      if (url.includes('.') && !url.includes(' ')) {
        url = 'https://' + url;
      } else {
        url = `https://duckduckgo.com/?q=${encodeURIComponent(url)}`;
      }
    }
    this.view.webContents.loadURL(url);
  }

  goBack(): void {
    if (this.view.webContents.canGoBack()) {
      this.view.webContents.goBack();
    }
  }

  goForward(): void {
    if (this.view.webContents.canGoForward()) {
      this.view.webContents.goForward();
    }
  }

  reload(): void {
    this.view.webContents.reload();
  }

  destroy(): void {
    this.view.webContents.close();
  }
}
