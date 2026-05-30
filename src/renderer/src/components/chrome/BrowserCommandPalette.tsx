import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type Component,
} from "solid-js";
import {
  AppWindow,
  Bot,
  Download,
  Eraser,
  FileDown,
  Focus,
  HelpCircle,
  PanelRight,
  Plus,
  Printer,
  RotateCcw,
  Search,
  Settings,
  Shield,
  Sidebar,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-solid";
import { useUI } from "../../stores/ui";
import { useTabs } from "../../stores/tabs";
import { useAnimatedPresence } from "../../lib/useAnimatedPresence";
import {
  createBrowserCommands,
  type BrowserCommand,
} from "../../lib/browserCommands";
import type { BrowserCommandIconId } from "../../lib/browserCommands";
import "./BrowserCommandPalette.css";

const PALETTE_EXIT_MS = 160;
const COMMAND_ICONS: Record<
  BrowserCommandIconId,
  Component<{ size?: number; "aria-hidden"?: string }>
> = {
  "app-window": AppWindow,
  bot: Bot,
  download: Download,
  eraser: Eraser,
  "file-down": FileDown,
  focus: Focus,
  "help-circle": HelpCircle,
  "panel-right": PanelRight,
  plus: Plus,
  printer: Printer,
  rotate: RotateCcw,
  search: Search,
  settings: Settings,
  shield: Shield,
  sidebar: Sidebar,
  undo: Undo2,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
};

const BrowserCommandPalette: Component<{
  onOpenClearData: () => void;
  onToggleKeyboardHelp: () => void;
  onCaptureHighlight: () => void | Promise<void>;
  onOpenDownloads: () => void;
}> = (props) => {
  const {
    browserCommandPaletteOpen,
    closeBrowserCommandPalette,
    openCommandBar,
    toggleSidebar,
    toggleFocusMode,
    toggleDevTools,
    openSettings,
  } = useUI();
  const {
    activeTab,
    activeTabId,
    createTab,
    closeTab,
    reload,
    goBack,
    goForward,
    reopenClosed,
    zoomIn,
    zoomOut,
    zoomReset,
    print,
    printToPdf,
  } = useTabs();
  const { visible, closing } = useAnimatedPresence(
    browserCommandPaletteOpen,
    PALETTE_EXIT_MS,
  );
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  const runForActiveTab = (action: (id: string) => void | Promise<void>) => {
    const id = activeTabId();
    if (id) return action(id);
  };

  const commands = createMemo<BrowserCommand[]>(() =>
    createBrowserCommands({
      activeTabTitle: () => activeTab()?.title,
      createTab: () => createTab(),
      closeActiveTab: () => runForActiveTab((id) => closeTab(id)),
      reopenClosedTab: () => reopenClosed(),
      openNewWindow: () => window.vessel.tabs.openNewWindow(),
      openPrivateWindow: () => window.vessel.tabs.openPrivateWindow(),
      reload: () => reload(),
      goBack: () => goBack(),
      goForward: () => goForward(),
      openBrowserCommandPalette: () => undefined,
      openCommandBar: () => openCommandBar(),
      toggleSidebar: () => toggleSidebar(),
      toggleFocusMode: () => toggleFocusMode(),
      openSettings: () => openSettings(),
      openDownloads: props.onOpenDownloads,
      clearBrowsingData: props.onOpenClearData,
      toggleKeyboardHelp: props.onToggleKeyboardHelp,
      toggleDevTools: () => toggleDevTools(),
      zoomIn: () => runForActiveTab((id) => zoomIn(id)),
      zoomOut: () => runForActiveTab((id) => zoomOut(id)),
      zoomReset: () => runForActiveTab((id) => zoomReset(id)),
      print: () => runForActiveTab((id) => print(id)),
      printToPdf: () => runForActiveTab((id) => printToPdf(id)),
      togglePip: () => window.vessel.pip.toggle(),
      captureHighlight: props.onCaptureHighlight,
    }),
  );

  const filteredCommands = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return commands();
    return commands().filter((command) =>
      `${command.label} ${command.hint} ${command.keywords}`
        .toLowerCase()
        .includes(needle),
    );
  });

  createEffect(() => {
    if (!browserCommandPaletteOpen()) return;
    setQuery("");
    setSelectedIndex(0);
    queueMicrotask(() => inputRef?.focus());
  });

  createEffect(() => {
    const count = filteredCommands().length;
    if (selectedIndex() >= count) {
      setSelectedIndex(Math.max(0, count - 1));
    }
  });

  const close = () => closeBrowserCommandPalette();

  const runCommand = async (command: BrowserCommand) => {
    close();
    await command.run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const count = filteredCommands().length;
      if (count > 0) setSelectedIndex((selectedIndex() + 1) % count);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const count = filteredCommands().length;
      if (count > 0) setSelectedIndex((selectedIndex() - 1 + count) % count);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const command = filteredCommands()[selectedIndex()];
      if (command) void runCommand(command);
    }
  };

  return (
    <Show when={visible()}>
      <div
        class="browser-command-overlay"
        classList={{ closing: closing() }}
        onClick={close}
      >
        <section
          class="browser-command-palette"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="browser-command-search">
            <Search size={17} aria-hidden="true" />
            <input
              ref={inputRef}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder="Search browser commands..."
              spellcheck={false}
            />
            <kbd>Esc</kbd>
          </div>
          <div class="browser-command-list" role="listbox">
            <Show
              when={filteredCommands().length > 0}
              fallback={
                <div class="browser-command-empty">No matching commands</div>
              }
            >
              <For each={filteredCommands()}>
                {(command, index) => {
                  const Icon = COMMAND_ICONS[command.icon];
                  return (
                    <button
                      type="button"
                      class="browser-command-item"
                      classList={{ selected: index() === selectedIndex() }}
                      role="option"
                      aria-selected={index() === selectedIndex()}
                      onMouseEnter={() => setSelectedIndex(index())}
                      onClick={() => void runCommand(command)}
                    >
                      <span class="browser-command-icon">
                        <Icon size={16} aria-hidden="true" />
                      </span>
                      <span class="browser-command-copy">
                        <span class="browser-command-label">{command.label}</span>
                        <span class="browser-command-hint">{command.hint}</span>
                      </span>
                      <Show when={command.shortcut}>
                        {(shortcut) => (
                          <kbd class="browser-command-shortcut">
                            {shortcut()}
                          </kbd>
                        )}
                      </Show>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>
        </section>
      </div>
    </Show>
  );
};

export default BrowserCommandPalette;
