export type BrowserCommandId =
  | "browser-command-palette"
  | "ask-agent"
  | "toggle-sidebar"
  | "focus-mode"
  | "new-tab"
  | "close-tab"
  | "reopen-tab"
  | "new-window"
  | "private-window"
  | "reload"
  | "go-back"
  | "go-forward"
  | "find-page"
  | "settings"
  | "downloads"
  | "clear-data"
  | "keyboard-help"
  | "devtools"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "print"
  | "save-pdf"
  | "toggle-pip"
  | "capture-highlight";

export type BrowserCommandIconId =
  | "app-window"
  | "bot"
  | "download"
  | "eraser"
  | "file-down"
  | "focus"
  | "help-circle"
  | "panel-right"
  | "plus"
  | "printer"
  | "rotate"
  | "search"
  | "settings"
  | "shield"
  | "sidebar"
  | "undo"
  | "zoom-in"
  | "zoom-out";

type ShortcutSpec = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type BrowserCommandDefinition = {
  id: BrowserCommandId;
  label: string;
  hint: string | ((context: BrowserCommandContext) => string);
  keywords: string;
  shortcuts?: ShortcutSpec[];
  shortcutLabel?: string;
  icon: BrowserCommandIconId;
  privateMode?: boolean;
  showInPalette?: boolean;
  ignoreEditableTarget?: boolean;
};

export type BrowserCommand = {
  id: BrowserCommandId;
  label: string;
  hint: string;
  keywords: string;
  shortcut?: string;
  icon: BrowserCommandIconId;
  run: () => void | Promise<void>;
};

export type BrowserCommandContext = {
  activeTabTitle: () => string | undefined;
  createTab: () => void | Promise<void>;
  closeActiveTab: () => void | Promise<void>;
  reopenClosedTab: () => void | Promise<void>;
  openNewWindow: () => void | Promise<void>;
  openPrivateWindow: () => void | Promise<void>;
  reload: () => void | Promise<void>;
  goBack: () => void | Promise<void>;
  goForward: () => void | Promise<void>;
  openBrowserCommandPalette: () => void | Promise<void>;
  openCommandBar: () => void | Promise<void>;
  toggleSidebar: () => void | Promise<void>;
  toggleFocusMode: () => void | Promise<void>;
  openSettings: () => void | Promise<void>;
  openDownloads: () => void | Promise<void>;
  clearBrowsingData: () => void | Promise<void>;
  toggleKeyboardHelp: () => void | Promise<void>;
  toggleDevTools: () => void | Promise<void>;
  zoomIn: () => void | Promise<void>;
  zoomOut: () => void | Promise<void>;
  zoomReset: () => void | Promise<void>;
  print: () => void | Promise<void>;
  printToPdf: () => void | Promise<void>;
  togglePip: () => void | Promise<void>;
  captureHighlight: () => void | Promise<void>;
};

export const BROWSER_COMMAND_DEFINITIONS: readonly BrowserCommandDefinition[] = [
  {
    id: "browser-command-palette",
    label: "Browser Command Palette",
    hint: "Search browser actions",
    keywords: "command palette actions",
    shortcuts: [{ ctrl: true, key: "k" }],
    shortcutLabel: "Ctrl+K",
    icon: "search",
    privateMode: false,
    showInPalette: false,
  },
  {
    id: "ask-agent",
    label: "Ask Agent",
    hint: "Open the AI command bar",
    keywords: "ai ask chat command bar",
    shortcuts: [{ ctrl: true, key: "l" }],
    shortcutLabel: "Ctrl+L",
    icon: "bot",
    privateMode: false,
  },
  {
    id: "toggle-sidebar",
    label: "Toggle Agent Panel",
    hint: "Show or hide the docked agent sidebar",
    keywords: "agent sidebar panel chat",
    shortcuts: [{ ctrl: true, shift: true, key: "l" }],
    shortcutLabel: "Ctrl+Shift+L",
    icon: "sidebar",
    privateMode: false,
  },
  {
    id: "focus-mode",
    label: "Toggle Focus Mode",
    hint: "Hide or restore browser chrome",
    keywords: "focus fullscreen chrome",
    shortcuts: [{ ctrl: true, shift: true, key: "f" }],
    shortcutLabel: "Ctrl+Shift+F",
    icon: "focus",
    privateMode: false,
  },
  {
    id: "new-tab",
    label: "New Tab",
    hint: "Open a fresh browser tab",
    keywords: "tab create open",
    shortcuts: [{ ctrl: true, key: "t" }],
    shortcutLabel: "Ctrl+T",
    icon: "plus",
  },
  {
    id: "close-tab",
    label: "Close Tab",
    hint: "Close the active browser tab",
    keywords: "tab close remove",
    shortcuts: [{ ctrl: true, key: "w" }],
    shortcutLabel: "Ctrl+W",
    icon: "eraser",
  },
  {
    id: "reopen-tab",
    label: "Reopen Closed Tab",
    hint: "Restore the most recently closed tab",
    keywords: "undo restore closed tab",
    shortcuts: [{ ctrl: true, shift: true, key: "t" }],
    shortcutLabel: "Ctrl+Shift+T",
    icon: "undo",
  },
  {
    id: "new-window",
    label: "New Window",
    hint: "Open another Vessel window",
    keywords: "window browser",
    shortcuts: [{ ctrl: true, key: "n" }],
    shortcutLabel: "Ctrl+N",
    icon: "app-window",
  },
  {
    id: "private-window",
    label: "New Private Window",
    hint: "Browse without saving local session data",
    keywords: "incognito private window",
    shortcuts: [{ ctrl: true, shift: true, key: "n" }],
    shortcutLabel: "Ctrl+Shift+N",
    icon: "shield",
  },
  {
    id: "reload",
    label: "Reload Page",
    hint: (context) => context.activeTabTitle() || "Reload the active tab",
    keywords: "refresh reload page",
    icon: "rotate",
  },
  {
    id: "go-back",
    label: "Go Back",
    hint: "Navigate the active tab backward",
    keywords: "history previous back",
    icon: "undo",
  },
  {
    id: "go-forward",
    label: "Go Forward",
    hint: "Navigate the active tab forward",
    keywords: "history next forward",
    icon: "panel-right",
  },
  {
    id: "find-page",
    label: "Find in Page",
    hint: "Search text in the active page",
    keywords: "find search page text",
    shortcuts: [{ ctrl: true, key: "f" }],
    shortcutLabel: "Ctrl+F",
    icon: "search",
    showInPalette: false,
  },
  {
    id: "settings",
    label: "Settings",
    hint: "Open runtime settings",
    keywords: "preferences configuration provider",
    shortcuts: [{ ctrl: true, key: "," }],
    shortcutLabel: "Ctrl+,",
    icon: "settings",
    privateMode: false,
  },
  {
    id: "downloads",
    label: "Downloads",
    hint: "Show recent downloads",
    keywords: "download files",
    icon: "download",
  },
  {
    id: "clear-data",
    label: "Clear Browsing Data",
    hint: "Open privacy cleanup options",
    keywords: "privacy cache cookies history",
    shortcuts: [{ ctrl: true, shift: true, key: "Delete" }],
    shortcutLabel: "Ctrl+Shift+Delete",
    icon: "eraser",
    privateMode: false,
  },
  {
    id: "keyboard-help",
    label: "Keyboard Shortcuts",
    hint: "Show available browser shortcuts",
    keywords: "help shortcuts keys",
    shortcuts: [{ shift: true, key: "?" }],
    shortcutLabel: "?",
    icon: "help-circle",
    ignoreEditableTarget: true,
  },
  {
    id: "devtools",
    label: "Toggle Agent DevTools",
    hint: "Open or close the agent debugging panel",
    keywords: "debug devtools activity network console",
    shortcuts: [{ key: "F12" }],
    shortcutLabel: "F12",
    icon: "shield",
    privateMode: false,
  },
  {
    id: "zoom-in",
    label: "Zoom In",
    hint: "Increase active page zoom",
    keywords: "page scale larger",
    shortcuts: [
      { ctrl: true, key: "+" },
      { ctrl: true, key: "=" },
    ],
    shortcutLabel: "Ctrl++ / Ctrl+=",
    icon: "zoom-in",
  },
  {
    id: "zoom-out",
    label: "Zoom Out",
    hint: "Decrease active page zoom",
    keywords: "page scale smaller",
    shortcuts: [{ ctrl: true, key: "-" }],
    shortcutLabel: "Ctrl+-",
    icon: "zoom-out",
  },
  {
    id: "zoom-reset",
    label: "Reset Zoom",
    hint: "Return active page zoom to default",
    keywords: "page scale normal",
    shortcuts: [{ ctrl: true, key: "0" }],
    shortcutLabel: "Ctrl+0",
    icon: "search",
  },
  {
    id: "print",
    label: "Print Page",
    hint: "Open print options for the active tab",
    keywords: "printer paper",
    shortcuts: [{ ctrl: true, key: "p" }],
    shortcutLabel: "Ctrl+P",
    icon: "printer",
  },
  {
    id: "save-pdf",
    label: "Save Page as PDF",
    hint: "Export the active tab to a PDF",
    keywords: "print pdf export",
    shortcuts: [{ ctrl: true, shift: true, key: "p" }],
    shortcutLabel: "Ctrl+Shift+P",
    icon: "file-down",
  },
  {
    id: "toggle-pip",
    label: "Toggle Picture-in-Picture",
    hint: "Toggle picture-in-picture for supported media",
    keywords: "video picture in picture pip",
    shortcuts: [{ ctrl: true, shift: true, key: "i" }],
    shortcutLabel: "Ctrl+Shift+I",
    icon: "panel-right",
    privateMode: false,
  },
  {
    id: "capture-highlight",
    label: "Capture Highlight",
    hint: "Save the current page selection",
    keywords: "highlight selection save quote",
    shortcuts: [{ ctrl: true, key: "h" }],
    shortcutLabel: "Ctrl+H",
    icon: "plus",
    privateMode: false,
  },
];

export function createBrowserCommands(
  context: BrowserCommandContext,
): BrowserCommand[] {
  const actions: Record<BrowserCommandId, () => void | Promise<void>> = {
    "browser-command-palette": context.openBrowserCommandPalette,
    "ask-agent": context.openCommandBar,
    "toggle-sidebar": context.toggleSidebar,
    "focus-mode": context.toggleFocusMode,
    "new-tab": context.createTab,
    "close-tab": context.closeActiveTab,
    "reopen-tab": context.reopenClosedTab,
    "new-window": context.openNewWindow,
    "private-window": context.openPrivateWindow,
    reload: context.reload,
    "go-back": context.goBack,
    "go-forward": context.goForward,
    "find-page": () => undefined,
    settings: context.openSettings,
    downloads: context.openDownloads,
    "clear-data": context.clearBrowsingData,
    "keyboard-help": context.toggleKeyboardHelp,
    devtools: context.toggleDevTools,
    "zoom-in": context.zoomIn,
    "zoom-out": context.zoomOut,
    "zoom-reset": context.zoomReset,
    print: context.print,
    "save-pdf": context.printToPdf,
    "toggle-pip": context.togglePip,
    "capture-highlight": context.captureHighlight,
  };

  return BROWSER_COMMAND_DEFINITIONS.filter(
    (definition) => definition.showInPalette !== false,
  ).map((definition) => ({
    id: definition.id,
    label: definition.label,
    hint:
      typeof definition.hint === "function"
        ? definition.hint(context)
        : definition.hint,
    keywords: definition.keywords,
    shortcut: definition.shortcutLabel,
    icon: definition.icon,
    run: actions[definition.id],
  }));
}

export function getBrowserCommandShortcutHelp(
  privateMode = false,
): { keys: string; action: string }[] {
  return BROWSER_COMMAND_DEFINITIONS.filter(
    (definition) =>
      definition.shortcutLabel &&
      (!privateMode || definition.privateMode !== false),
  ).map((definition) => ({
    keys: definition.shortcutLabel!,
    action: definition.label,
  }));
}

export function getBrowserCommandIdForKeyboardEvent(
  event: KeyboardEvent,
): BrowserCommandId | null {
  for (const definition of BROWSER_COMMAND_DEFINITIONS) {
    if (!definition.shortcuts) continue;
    if (definition.ignoreEditableTarget && isEditableTarget(event.target)) {
      continue;
    }
    if (definition.shortcuts.some((shortcut) => matchesShortcut(event, shortcut))) {
      return definition.id;
    }
  }
  return null;
}

function matchesShortcut(event: KeyboardEvent, shortcut: ShortcutSpec): boolean {
  const ctrl = event.ctrlKey || event.metaKey;
  return (
    ctrl === Boolean(shortcut.ctrl) &&
    event.shiftKey === Boolean(shortcut.shift) &&
    event.altKey === Boolean(shortcut.alt) &&
    event.key.toLowerCase() === shortcut.key.toLowerCase()
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}
