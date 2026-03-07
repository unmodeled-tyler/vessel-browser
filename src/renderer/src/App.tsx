import { onMount, onCleanup, type Component } from 'solid-js';
import TitleBar from './components/chrome/TitleBar';
import TabBar from './components/chrome/TabBar';
import AddressBar from './components/chrome/AddressBar';
import CommandBar from './components/ai/CommandBar';
import Sidebar from './components/ai/Sidebar';
import Settings from './components/shared/Settings';
import { useUI } from './stores/ui';
import { useTabs } from './stores/tabs';
import { setupKeybindings } from './lib/keybindings';

const App: Component = () => {
  const {
    openCommandBar,
    toggleSidebar,
    toggleFocusMode,
    openSettings,
    focusMode,
  } = useUI();
  const { createTab, closeTab, activeTabId } = useTabs();

  onMount(() => {
    const cleanup = setupKeybindings({
      openCommandBar,
      toggleSidebar,
      toggleFocusMode,
      newTab: () => createTab(),
      closeTab: () => {
        const id = activeTabId();
        if (id) closeTab(id);
      },
      openSettings,
    });
    onCleanup(cleanup);
  });

  return (
    <div class="app" classList={{ 'focus-mode': focusMode() }}>
      <div class="chrome">
        <TitleBar />
        <TabBar />
        <AddressBar />
      </div>
      <CommandBar />
      <Sidebar />
      <Settings />
    </div>
  );
};

export default App;
