import { onMount, onCleanup, Show, createSignal, type Component } from "solid-js";
import TitleBar from "./components/chrome/TitleBar";
import TabBar from "./components/chrome/TabBar";
import AddressBar from "./components/chrome/AddressBar";
import BookmarkNotifications from "./components/chrome/BookmarkNotifications";
import HighlightNotifications from "./components/chrome/HighlightNotifications";
import AgentTranscriptDock from "./components/chrome/AgentTranscriptDock";
import CommandBar from "./components/ai/CommandBar";
import Sidebar from "./components/ai/Sidebar";
import DevToolsPanel from "./components/devtools/DevToolsPanel";
import Settings from "./components/shared/Settings";
import { useUI } from "./stores/ui";
import { useTabs } from "./stores/tabs";
import { setupKeybindings } from "./lib/keybindings";

const App: Component = () => {
  const view =
    new URLSearchParams(window.location.search).get("view") || "chrome";
  const {
    openCommandBar,
    toggleSidebar,
    toggleFocusMode,
    openSettings,
    focusMode,
  } = useUI();
  const { createTab, closeTab, activeTabId, activeTab } = useTabs();
  const [highlightToast, setHighlightToast] = createSignal<{
    title: string;
    message: string;
  } | null>(null);

  const captureHighlight = async () => {
    try {
      const result = await window.vessel.highlights.capture();
      if (result.success && result.text) {
        const preview =
          result.text.length > 60
            ? result.text.slice(0, 57) + "..."
            : result.text;
        setHighlightToast({ title: "Highlight saved", message: preview });
      } else {
        setHighlightToast({
          title: "No selection",
          message: result.message || "Select text on the page first, then press Ctrl+H",
        });
      }
    } catch {
      setHighlightToast({
        title: "Highlight failed",
        message: "Could not capture selection",
      });
    }
  };

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

  onMount(() => {
    if (view !== "chrome") return;

    const cleanupKeys = setupKeybindings({
      openCommandBar,
      toggleSidebar,
      toggleFocusMode,
      newTab: () => createTab(),
      closeTab: () => {
        const id = activeTabId();
        if (id) closeTab(id);
      },
      openSettings,
      captureHighlight,
      toggleDevTools: () => {
        window.vessel.devtoolsPanel.toggle();
      },
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
      <BookmarkNotifications />
      <HighlightNotifications toast={highlightToast()} onDismiss={() => setHighlightToast(null)} />
      <AgentTranscriptDock />
      <div class="chrome">
        <TitleBar />
        <TabBar />
        <AddressBar />
        <Show when={activeTab()?.isLoading}>
          <div class="loading-bar" />
        </Show>
      </div>
      <CommandBar />
      <Settings />
    </div>
  );
};

export default App;
