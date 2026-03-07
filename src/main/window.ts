import { BaseWindow, WebContentsView } from 'electron';
import path from 'path';
import { TabManager } from './tabs/tab-manager';
import type { UIState } from '../shared/types';

const CHROME_HEIGHT = 80;
const SIDEBAR_WIDTH = 340;

export interface WindowState {
  mainWindow: BaseWindow;
  chromeView: WebContentsView;
  tabManager: TabManager;
  uiState: UIState;
}

export function createMainWindow(
  onTabStateChange: (tabs: any[], activeId: string) => void,
): WindowState {
  const mainWindow = new BaseWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: '#1a1a1e',
  });

  const chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.contentView.addChildView(chromeView);

  const uiState: UIState = {
    sidebarOpen: false,
    focusMode: false,
  };

  const tabManager = new TabManager(mainWindow, onTabStateChange);

  const state: WindowState = { mainWindow, chromeView, tabManager, uiState };

  mainWindow.on('resize', () => layoutViews(state));
  layoutViews(state);

  return state;
}

export function layoutViews(state: WindowState): void {
  const { mainWindow, chromeView, tabManager, uiState } = state;
  const bounds = mainWindow.getBounds();
  const chromeHeight = uiState.focusMode ? 0 : CHROME_HEIGHT;
  const sidebarWidth = uiState.sidebarOpen ? SIDEBAR_WIDTH : 0;

  // Chrome view spans full window (uses CSS to position elements)
  chromeView.setBounds({
    x: 0,
    y: 0,
    width: bounds.width,
    height: bounds.height,
  });

  // Active tab content view
  const activeTab = tabManager.getActiveTab();
  if (activeTab) {
    activeTab.view.setBounds({
      x: 0,
      y: chromeHeight,
      width: bounds.width - sidebarWidth,
      height: bounds.height - chromeHeight,
    });
  }
}
