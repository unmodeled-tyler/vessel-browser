import { For, createMemo, createSignal, onCleanup, type Component } from "solid-js";
import { useTabs } from "../../stores/tabs";
import { useRuntime } from "../../stores/runtime";
import { getAgentActiveTabIds } from "../../lib/agentActivity";
import "./chrome.css";

const TabBar: Component = () => {
  const { tabs, activeTabId, switchTab, closeTab, createTab } = useTabs();
  const { runtimeState } = useRuntime();

  // Tick every second so "recent" calculations stay fresh
  const [now, setNow] = createSignal(Date.now());
  const ticker = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(ticker));

  const modelActiveTabIds = createMemo(() =>
    getAgentActiveTabIds(runtimeState(), now()),
  );

  return (
    <div class="tab-bar">
      <div class="tab-list">
        <For each={tabs()}>
          {(tab) => (
            <div
              class={`tab-item ${tab.id === activeTabId() ? "active" : ""} ${
                modelActiveTabIds().has(tab.id) ? "model-active" : ""
              }`}
              onClick={() => switchTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(tab.id);
              }}
              title={
                modelActiveTabIds().has(tab.id)
                  ? `${tab.title || "New Tab"} • Agent active`
                  : tab.title
              }
              role="tab"
            >
              {tab.favicon && (
                <img class="tab-favicon" src={tab.favicon} alt="" />
              )}
              {modelActiveTabIds().has(tab.id) && (
                <span
                  class="tab-agent-indicator"
                  aria-hidden="true"
                  title="Agent active on this tab"
                />
              )}
              <span class="tab-title">{tab.title || "New Tab"}</span>
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
