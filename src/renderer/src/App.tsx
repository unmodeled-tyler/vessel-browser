import { onMount, onCleanup, Show, createSignal, createEffect, type Component } from "solid-js";
import TitleBar from "./components/chrome/TitleBar";
import TabBar from "./components/chrome/TabBar";
import AddressBar from "./components/chrome/AddressBar";
import BookmarkNotifications from "./components/chrome/BookmarkNotifications";
import HighlightNotifications from "./components/chrome/HighlightNotifications";
import DownloadToast from "./components/chrome/DownloadToast";
import FindBar from "./components/chrome/FindBar";
import FlowProgress from "./components/chrome/FlowProgress";
import AgentTranscriptDock from "./components/chrome/AgentTranscriptDock";
import CommandBar from "./components/ai/CommandBar";
import Sidebar from "./components/ai/Sidebar";
import DevToolsPanel from "./components/devtools/DevToolsPanel";
import Settings from "./components/shared/Settings";
import KeyboardHelp from "./components/shared/KeyboardHelp";
import { useUI } from "./stores/ui";
import { useTabs } from "./stores/tabs";
import { setupKeybindings } from "./lib/keybindings";
import { useAnimatedPresence } from "./lib/useAnimatedPresence";

try {
  const cached = localStorage.getItem("vessel:theme");
  if (cached) document.documentElement.setAttribute("data-theme", cached);
  else document.documentElement.setAttribute("data-theme", "dark");
} catch {
  document.documentElement.setAttribute("data-theme", "dark");
}

const App: Component = () => {
  const view =
    new URLSearchParams(window.location.search).get("view") || "chrome";
  const isPrivateWindow =
    new URLSearchParams(window.location.search).get("private") === "1";
  const {
    openCommandBar,
    toggleSidebar,
    toggleFocusMode,
    openSettings,
    focusMode,
  } = useUI();
  const {
    createTab,
    closeTab,
    activeTabId,
    activeTab,
    zoomIn,
    zoomOut,
    zoomReset,
    reopenClosed,
  } = useTabs();
  const [highlightToast, setHighlightToast] = createSignal<{
    title: string;
    message: string;
  } | null>(null);
  const [keyboardHelpOpen, setKeyboardHelpOpen] = createSignal(false);
  const loadingPresence = useAnimatedPresence(() => !!activeTab()?.isLoading, 300);

  const showHighlightResult = (result: {
    success: boolean;
    text?: string;
    message?: string;
  }) => {
    if (result.success && result.text) {
      const preview =
        result.text.length > 60 ? result.text.slice(0, 57) + "..." : result.text;
      setHighlightToast({ title: "Highlight saved", message: preview });
    } else {
      setHighlightToast({
        title: "No selection",
        message:
          result.message || "Select text on the page first, then press Ctrl+H",
      });
    }
  };

  const captureHighlight = async () => {
    try {
      const result = await window.vessel.highlights.capture();
      showHighlightResult(result);
    } catch {
      setHighlightToast({
        title: "Highlight failed",
        message: "Could not capture selection",
      });
    }
  };

  const applyTheme = (theme: string) => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("vessel:theme", theme);
    } catch {}
  };

  const loadAndApplyTheme = async () => {
    const s = await window.vessel.settings.get();
    applyTheme(s.theme ?? "dark");
  };

  onMount(() => {
    void loadAndApplyTheme();

    window.vessel.ui.rendererReady(view as "chrome" | "sidebar" | "devtools");

    const cleanupSettings = window.vessel.settings.onUpdate((settings) => {
      applyTheme(settings.theme ?? "dark");
    });

    onCleanup(() => {
      cleanupSettings();
    });

    if (view !== "chrome") return;

    const cleanupKeys = setupKeybindings({
      openCommandBar: isPrivateWindow ? undefined : openCommandBar,
      toggleSidebar: isPrivateWindow ? undefined : toggleSidebar,
      toggleFocusMode: isPrivateWindow ? undefined : toggleFocusMode,
      newTab: () => createTab(),
      closeTab: () => {
        const id = activeTabId();
        if (id) closeTab(id);
      },
      openSettings: isPrivateWindow ? undefined : openSettings,
      captureHighlight: isPrivateWindow ? undefined : captureHighlight,
      zoomIn: () => {
        const id = activeTabId();
        if (id) zoomIn(id);
      },
      zoomOut: () => {
        const id = activeTabId();
        if (id) zoomOut(id);
      },
      zoomReset: () => {
        const id = activeTabId();
        if (id) zoomReset(id);
      },
      reopenClosedTab: () => reopenClosed(),
      openPrivateWindow: () => window.vessel.tabs.openPrivateWindow(),
      print: () => {
        const id = activeTabId();
        if (id) window.vessel.tabs.print(id);
      },
      printToPdf: () => {
        const id = activeTabId();
        if (id) void window.vessel.tabs.printToPdf(id);
      },
      toggleDevTools: isPrivateWindow
        ? undefined
        : () => {
            window.vessel.devtoolsPanel.toggle();
          },
      toggleKeyboardHelp: () => setKeyboardHelpOpen((v) => !v),
    });

    // Listen for Ctrl+H captures triggered from the page view
    const cleanupCapture = window.vessel.highlights.onCaptureResult(
      showHighlightResult,
    );

    onCleanup(() => {
      cleanupKeys();
      cleanupCapture();
    });
  });

  if (view === "sidebar") {
    return <Sidebar forceOpen />;
  }

  if (view === "devtools") {
    return <DevToolsPanel />;
  }

  return (
    <div class="app" classList={{ "focus-mode": focusMode() }}>
      <Show when={!isPrivateWindow}>
        <BookmarkNotifications />
        <HighlightNotifications toast={highlightToast()} onDismiss={() => setHighlightToast(null)} />
      </Show>
      <DownloadToast />
      <FindBar />
      <Show when={!isPrivateWindow}>
        <FlowProgress />
        <AgentTranscriptDock />
      </Show>
      <div class="chrome">
        <TitleBar />
        <TabBar />
        <AddressBar />
        <Show when={loadingPresence.visible()}>
          <div class="loading-bar" classList={{ closing: loadingPresence.closing() }} />
        </Show>
      </div>
      <Show when={!isPrivateWindow}>
        <CommandBar />
        <Settings />
      </Show>
      <KeyboardHelp
        open={keyboardHelpOpen()}
        onClose={() => setKeyboardHelpOpen(false)}
        privateMode={isPrivateWindow}
      />
    </div>
  );
};

export default App;
