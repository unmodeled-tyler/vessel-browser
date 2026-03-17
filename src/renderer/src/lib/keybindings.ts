interface KeyBindingHandlers {
  openCommandBar: () => void;
  toggleSidebar: () => void;
  toggleFocusMode: () => void;
  newTab: () => void;
  closeTab: () => void;
  openSettings: () => void;
  captureHighlight: () => void;
  toggleDevTools?: () => void;
}

export function setupKeybindings(handlers: KeyBindingHandlers): () => void {
  const listener = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;

    // Ctrl+L — open command bar (AI)
    if (ctrl && e.key === 'l' && !e.shiftKey) {
      e.preventDefault();
      handlers.openCommandBar();
      return;
    }

    // Ctrl+Shift+L — toggle sidebar
    if (ctrl && e.key === 'L' && e.shiftKey) {
      e.preventDefault();
      handlers.toggleSidebar();
      return;
    }

    // Ctrl+Shift+F — focus mode
    if (ctrl && e.key === 'F' && e.shiftKey) {
      e.preventDefault();
      handlers.toggleFocusMode();
      return;
    }

    // Ctrl+T — new tab
    if (ctrl && e.key === 't') {
      e.preventDefault();
      handlers.newTab();
      return;
    }

    // Ctrl+W — close tab
    if (ctrl && e.key === 'w') {
      e.preventDefault();
      handlers.closeTab();
      return;
    }

    // Ctrl+, — settings
    if (ctrl && e.key === ',') {
      e.preventDefault();
      handlers.openSettings();
      return;
    }

    // Ctrl+H — capture highlight from selection
    if (ctrl && e.key === 'h' && !e.shiftKey) {
      e.preventDefault();
      handlers.captureHighlight();
      return;
    }

    // F12 — toggle DevTools panel
    if (e.key === 'F12') {
      e.preventDefault();
      handlers.toggleDevTools?.();
      return;
    }
  };

  document.addEventListener('keydown', listener);
  return () => document.removeEventListener('keydown', listener);
}
