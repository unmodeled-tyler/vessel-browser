interface KeyBindingHandlers {
  openCommandBar?: () => void;
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
}

export function setupKeybindings(handlers: KeyBindingHandlers): () => void {
  const listener = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    // Ctrl+L — open command bar (AI)
    if (ctrl && key === 'l' && !e.shiftKey) {
      e.preventDefault();
      handlers.openCommandBar?.();
      return;
    }

    // Ctrl+Shift+L — toggle sidebar
    if (ctrl && key === 'l' && e.shiftKey) {
      e.preventDefault();
      handlers.toggleSidebar?.();
      return;
    }

    // Ctrl+Shift+F — focus mode
    if (ctrl && key === 'f' && e.shiftKey) {
      e.preventDefault();
      handlers.toggleFocusMode?.();
      return;
    }

    // Ctrl+Shift+T — reopen closed tab
    if (ctrl && key === 't' && e.shiftKey) {
      e.preventDefault();
      handlers.reopenClosedTab?.();
      return;
    }

    // Ctrl+Shift+N — new private window
    if (ctrl && key === 'n' && e.shiftKey) {
      e.preventDefault();
      handlers.openPrivateWindow?.();
      return;
    }

    // Ctrl+N — new window
    if (ctrl && key === 'n' && !e.shiftKey) {
      e.preventDefault();
      handlers.openNewWindow?.();
      return;
    }

    // Ctrl+T — new tab
    if (ctrl && key === 't' && !e.shiftKey) {
      e.preventDefault();
      handlers.newTab();
      return;
    }

    // Ctrl+W — close tab
    if (ctrl && key === 'w') {
      e.preventDefault();
      handlers.closeTab();
      return;
    }

    // Ctrl+Shift+P — save as PDF
    if (ctrl && key === 'p' && e.shiftKey) {
      e.preventDefault();
      handlers.printToPdf?.();
      return;
    }

    // Ctrl+P — print
    if (ctrl && key === 'p' && !e.shiftKey) {
      e.preventDefault();
      handlers.print?.();
      return;
    }

    // Ctrl+, — settings
    if (ctrl && e.key === ',') {
      e.preventDefault();
      handlers.openSettings?.();
      return;
    }

    // Ctrl+H — capture highlight from selection
    if (ctrl && key === 'h' && !e.shiftKey) {
      e.preventDefault();
      handlers.captureHighlight?.();
      return;
    }

    // F12 — toggle DevTools panel
    if (e.key === 'F12') {
      e.preventDefault();
      handlers.toggleDevTools?.();
      return;
    }

    // Ctrl++ / Ctrl+= — zoom in
    if (ctrl && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      handlers.zoomIn?.();
      return;
    }

    // Ctrl+- — zoom out
    if (ctrl && e.key === '-') {
      e.preventDefault();
      handlers.zoomOut?.();
      return;
    }

    // Ctrl+0 — reset zoom
    if (ctrl && e.key === '0') {
      e.preventDefault();
      handlers.zoomReset?.();
      return;
    }

    // ? — keyboard shortcut help (only when not in an input/textarea)
    if (e.key === '?' && !ctrl && !e.altKey) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !(e.target as HTMLElement)?.isContentEditable) {
        e.preventDefault();
        handlers.toggleKeyboardHelp?.();
        return;
      }
    }
  };

  document.addEventListener('keydown', listener);
  return () => document.removeEventListener('keydown', listener);
}
