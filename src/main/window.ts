import { BaseWindow, WebContentsView } from 'electron';
import path from 'path';
import { TabManager } from './tabs/tab-manager';
import { loadSettings } from './config/settings';
import type { UIState } from '../shared/types';

const CHROME_HEIGHT = 110; // title(32) + tabs(36+1border) + address(40+1border)

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

  chromeView.setBackgroundColor('#00000000');
  mainWindow.contentView.addChildView(chromeView);

  const settings = loadSettings();
  const uiState: UIState = {
    sidebarOpen: false,
    sidebarWidth: settings.sidebarWidth,
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
  const [width, height] = mainWindow.getContentSize();
  const chromeHeight = uiState.focusMode ? 0 : CHROME_HEIGHT;
  const sidebarWidth = uiState.sidebarOpen ? uiState.sidebarWidth : 0;

  if (sidebarWidth > 0) {
    chromeView.setBounds({ x: 0, y: 0, width, height });
  } else {
    chromeView.setBounds({ x: 0, y: 0, width, height: chromeHeight });
  }

  // Chrome always on top
  mainWindow.contentView.removeChildView(chromeView);
  mainWindow.contentView.addChildView(chromeView);

  // Active tab content: below chrome, left of sidebar
  const activeTab = tabManager.getActiveTab();
  if (activeTab) {
    activeTab.view.setBounds({
      x: 0,
      y: chromeHeight,
      width: width - sidebarWidth,
      height: height - chromeHeight,
    });
  }
}
