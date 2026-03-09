import { For, createMemo, type Component } from "solid-js";
import { useTabs } from "../../stores/tabs";
import { useRuntime } from "../../stores/runtime";
import "./chrome.css";

const TabBar: Component = () => {
  const { tabs, activeTabId, switchTab, closeTab, createTab } = useTabs();
  const { runtimeState } = useRuntime();
  const modelActiveTabIds = createMemo(() => {
    const activeIds = new Set<string>();

    for (const action of runtimeState().actions) {
      if (!action.tabId) continue;
      if (action.source === "user" || action.source === "system") continue;
      if (action.status !== "running" && action.status !== "waiting-approval") {
        continue;
      }
      activeIds.add(action.tabId);
    }

    return activeIds;
  });

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
                  ? `${tab.title || "New Tab"} • Model active`
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
                  title="Model active on this tab"
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
