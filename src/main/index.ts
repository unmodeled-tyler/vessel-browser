import { app } from 'electron';
import path from 'path';
import { createMainWindow, layoutViews } from './window';
import { registerIpcHandlers } from './ipc/handlers';
import { Channels } from '../shared/channels';
import { loadSettings } from './config/settings';

function bootstrap(): void {
  const settings = loadSettings();

  const windowState = createMainWindow((tabs, activeId) => {
    windowState.chromeView.webContents.send(
      Channels.TAB_STATE_UPDATE,
      tabs,
      activeId,
    );
  });

  const { chromeView, tabManager } = windowState;

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    chromeView.webContents.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    chromeView.webContents.loadFile(
      path.join(__dirname, '../renderer/index.html'),
    );
  }

  registerIpcHandlers(windowState);

  // Open first tab once chrome is ready
  chromeView.webContents.once('did-finish-load', () => {
    tabManager.createTab(settings.defaultUrl);
    layoutViews(windowState);
  });
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  app.quit();
});
