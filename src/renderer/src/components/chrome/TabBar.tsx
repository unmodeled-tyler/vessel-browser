import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import { useTabs } from "../../stores/tabs";
import { useNow } from "../../stores/clock";
import { useRuntime } from "../../stores/runtime";
import { getAgentActiveTabIds } from "../../lib/agentActivity";
import "./chrome.css";

const TAB_CLOSE_MS = 200;

/** Generate a stable hue from a string (URL or title) for the avatar background. */
function stringToHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ((hash % 360) + 360) % 360;
}

const TabFavicon = (props: { favicon?: string; title: string; url: string }) => {
  const [failed, setFailed] = createSignal(false);
  const letter = () => {
    const t = props.title?.trim();
    if (t && t !== "New Tab") return t[0].toUpperCase();
    try { return new URL(props.url).hostname[0]?.toUpperCase() || "?"; } catch { return "?"; }
  };
  const hue = () => stringToHue(props.url || props.title || "");

  return (
    <Show
      when={props.favicon && !failed()}
      fallback={
        <span
          class="tab-favicon-fallback"
          style={{ "--favicon-hue": `${hue()}` }}
        >
          {letter()}
        </span>
      }
    >
      <img
        class="tab-favicon"
        src={props.favicon}
        alt=""
        onError={() => setFailed(true)}
      />
    </Show>
  );
};

const TabBar: Component = () => {
  const { tabs, activeTabId, switchTab, closeTab, createTab } = useTabs();
  const { runtimeState } = useRuntime();
  const now = useNow();
  const [closingTabIds, setClosingTabIds] = createSignal<Set<string>>(new Set());

  const modelActiveTabIds = createMemo(() =>
    getAgentActiveTabIds(runtimeState(), now()),
  );

  const handleClose = (id: string) => {
    setClosingTabIds((prev) => new Set(prev).add(id));
    setTimeout(() => {
      closeTab(id);
      setClosingTabIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, TAB_CLOSE_MS);
  };

  return (
    <div class="tab-bar">
      <div class="tab-list">
        <For each={tabs()}>
          {(tab) => (
            <div
              class={`tab-item ${tab.id === activeTabId() ? "active" : ""} ${
                modelActiveTabIds().has(tab.id) ? "model-active" : ""
              }`}
              classList={{ closing: closingTabIds().has(tab.id) }}
              onClick={() => switchTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) handleClose(tab.id);
              }}
              title={
                modelActiveTabIds().has(tab.id)
                  ? `${tab.title || "New Tab"} • Agent active`
                  : tab.title
              }
              role="tab"
            >
              <TabFavicon favicon={tab.favicon} title={tab.title || "New Tab"} url={tab.url} />
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
                  handleClose(tab.id);
                }}
              >
                ×
              </button>
            </div>
          )}
        </For>
        <button class="tab-new" onClick={() => createTab()} data-tooltip="New Tab">
          +
        </button>
      </div>
    </div>
  );
};

export default TabBar;
