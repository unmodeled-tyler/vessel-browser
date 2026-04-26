import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import { LayersPlus, PanelTop, Plus, Volume2, VolumeX } from "lucide-solid";
import { useTabs } from "../../stores/tabs";
import type { TabGroupColor, TabState } from "../../../../shared/types";
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

type TabBarEntry =
  | {
      type: "group";
      groupId: string;
      name: string;
      color: TabGroupColor;
      collapsed: boolean;
      count: number;
    }
  | { type: "tab"; tab: TabState };

const TabBar: Component = () => {
  const {
    tabs,
    activeTabId,
    switchTab,
    closeTab,
    createTab,
    createGroup,
    toggleGroupCollapsed,
    toggleMute,
  } = useTabs();
  const { runtimeState } = useRuntime();
  const now = useNow();
  const [closingTabIds, setClosingTabIds] = createSignal<Set<string>>(new Set());

  const modelActiveTabIds = createMemo(() =>
    getAgentActiveTabIds(runtimeState(), now()),
  );

  const tabEntries = createMemo<TabBarEntry[]>(() => {
    const seenGroups = new Set<string>();
    return tabs().flatMap((tab) => {
      const entries: TabBarEntry[] = [];
      if (tab.groupId && !seenGroups.has(tab.groupId)) {
        seenGroups.add(tab.groupId);
        entries.push({
          type: "group",
          groupId: tab.groupId,
          name: tab.groupName || "Group",
          color: tab.groupColor || "blue",
          collapsed: !!tab.groupCollapsed,
          count: tabs().filter((candidate) => candidate.groupId === tab.groupId)
            .length,
        });
      }
      if (!tab.groupCollapsed || tab.id === activeTabId()) {
        entries.push({ type: "tab", tab });
      }
      return entries;
    });
  });

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
        <For each={tabEntries()}>
          {(entry) => (
            <Show
              when={entry.type === "tab"}
              fallback={
                entry.type === "group" && (
                  <button
                    class={`tab-group-chip group-${entry.color}`}
                    classList={{ collapsed: entry.collapsed }}
                    onClick={() => void toggleGroupCollapsed(entry.groupId)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      window.vessel.tabs.showGroupContextMenu(entry.groupId);
                    }}
                    title={`${entry.name} (${entry.count} tabs)`}
                  >
                    <span class="tab-group-dot" />
                    <span class="tab-group-name">{entry.name}</span>
                    <span class="tab-group-count">{entry.count}</span>
                  </button>
                )
              }
            >
              {entry.type === "tab" && (() => {
                const tab = entry.tab;
                return (
            <div
              class={`tab-item ${tab.isPinned ? "pinned" : ""} ${tab.id === activeTabId() ? "active" : ""} ${
                modelActiveTabIds().has(tab.id) ? "model-active" : ""
              } ${tab.groupId ? `group-${tab.groupColor || "blue"}` : ""}`}
              classList={{ closing: closingTabIds().has(tab.id) }}
              onClick={() => switchTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1 && !tab.isPinned) handleClose(tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                window.vessel.tabs.showContextMenu(tab.id);
              }}
              title={
                tab.isPinned
                  ? tab.title || tab.url
                  : modelActiveTabIds().has(tab.id)
                    ? `${tab.title || "New Tab"} • Agent active`
                    : tab.title
              }
              role="tab"
            >
              <TabFavicon favicon={tab.favicon} title={tab.title || "New Tab"} url={tab.url} />
              <Show when={tab.isPinned && (tab.isAudible || tab.isMuted)}>
                <button
                  class="tab-audio tab-audio-pinned"
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleMute(tab.id);
                  }}
                  title={tab.isMuted ? "Unmute tab" : "Mute tab"}
                >
                  <Show when={tab.isMuted} fallback={<Volume2 size={11} />}>
                    <VolumeX size={11} />
                  </Show>
                </button>
              </Show>
              {!tab.isPinned && (
                <>
                  {modelActiveTabIds().has(tab.id) && (
                    <span
                      class="tab-agent-indicator"
                      aria-hidden="true"
                      title="Agent active on this tab"
                    />
                  )}
                  <span class="tab-title">{tab.title || "New Tab"}</span>
                  <Show when={tab.isAudible || tab.isMuted}>
                    <button
                      class="tab-audio"
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleMute(tab.id);
                      }}
                      title={tab.isMuted ? "Unmute tab" : "Mute tab"}
                    >
                      <Show when={tab.isMuted} fallback={<Volume2 size={12} />}>
                        <VolumeX size={12} />
                      </Show>
                    </button>
                  </Show>
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
                </>
              )}
            </div>
                );
              })()}
            </Show>
          )}
        </For>
      </div>
      <div class="tab-actions">
        <button class="tab-new" onClick={() => window.vessel.tabs.openNewWindow()} data-tooltip="New window" data-tooltip-pos="left">
          <PanelTop size={14} />
        </button>
        <button class="tab-new" onClick={() => {
          const id = activeTabId();
          if (id) void createGroup(id);
        }} data-tooltip="Add active tab to group" data-tooltip-pos="left">
          <LayersPlus size={14} />
        </button>
        <button class="tab-new" onClick={() => createTab()} data-tooltip="New tab" data-tooltip-pos="left">
          <Plus size={15} />
        </button>
        <button class="tab-new tab-new-private" onClick={() => window.vessel.tabs.openPrivateWindow()} data-tooltip="Private window" data-tooltip-pos="left">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11z" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default TabBar;
