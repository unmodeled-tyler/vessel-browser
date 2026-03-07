import { For, type Component } from 'solid-js';
import { useTabs } from '../../stores/tabs';
import './chrome.css';

const TabBar: Component = () => {
  const { tabs, activeTabId, switchTab, closeTab, createTab } = useTabs();

  return (
    <div class="tab-bar">
      <div class="tab-list">
        <For each={tabs()}>
          {(tab) => (
            <div
              class={`tab-item ${tab.id === activeTabId() ? 'active' : ''}`}
              onClick={() => switchTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(tab.id);
              }}
              title={tab.title}
              role="tab"
            >
              {tab.favicon && (
                <img class="tab-favicon" src={tab.favicon} alt="" />
              )}
              <span class="tab-title">{tab.title || 'New Tab'}</span>
              {tab.isLoading && <span class="tab-loading" />}
              <button
                class="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                ×
              </button>
            </div>
          )}
        </For>
      </div>
      <button class="tab-new" onClick={() => createTab()} title="New Tab">
        +
      </button>
    </div>
  );
};

export default TabBar;
