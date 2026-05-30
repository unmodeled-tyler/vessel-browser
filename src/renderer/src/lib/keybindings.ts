import {
  getBrowserCommandIdForKeyboardEvent,
  type BrowserCommandId,
} from "./browserCommands";

interface KeyBindingHandlers {
  openCommandBar?: () => void;
  openBrowserCommandPalette?: () => void;
  toggleSidebar?: () => void;
  toggleFocusMode?: () => void;
  newTab: () => void;
  closeTab: () => void;
  openSettings?: () => void;
  captureHighlight?: () => void;
  zoomIn?: () => void;
  zoomOut?: () => void;
  zoomReset?: () => void;
  reopenClosedTab?: () => void;
  openNewWindow?: () => void;
  openPrivateWindow?: () => void;
  print?: () => void;
  printToPdf?: () => void;
  toggleDevTools?: () => void;
  toggleKeyboardHelp?: () => void;
  togglePip?: () => void;
  clearBrowsingData?: () => void;
}

export function setupKeybindings(handlers: KeyBindingHandlers): () => void {
  const listener = (e: KeyboardEvent) => {
    const commandId = getBrowserCommandIdForKeyboardEvent(e);
    if (!commandId) return;

    const commandHandler = getCommandHandler(commandId, handlers);
    if (commandHandler) {
      e.preventDefault();
      commandHandler();
    }
  };

  document.addEventListener("keydown", listener);
  return () => document.removeEventListener("keydown", listener);
}

function getCommandHandler(
  commandId: BrowserCommandId,
  handlers: KeyBindingHandlers,
): (() => void) | undefined {
  const commandHandlers: Partial<Record<BrowserCommandId, () => void>> = {
    "browser-command-palette": handlers.openBrowserCommandPalette,
    "ask-agent": handlers.openCommandBar,
    "toggle-sidebar": handlers.toggleSidebar,
    "focus-mode": handlers.toggleFocusMode,
    "new-tab": handlers.newTab,
    "close-tab": handlers.closeTab,
    "reopen-tab": handlers.reopenClosedTab,
    "new-window": handlers.openNewWindow,
    "private-window": handlers.openPrivateWindow,
    settings: handlers.openSettings,
    "clear-data": handlers.clearBrowsingData,
    "keyboard-help": handlers.toggleKeyboardHelp,
    devtools: handlers.toggleDevTools,
    "zoom-in": handlers.zoomIn,
    "zoom-out": handlers.zoomOut,
    "zoom-reset": handlers.zoomReset,
    print: handlers.print,
    "save-pdf": handlers.printToPdf,
    "toggle-pip": handlers.togglePip,
    "capture-highlight": handlers.captureHighlight,
  };
  return commandHandlers[commandId];
}
