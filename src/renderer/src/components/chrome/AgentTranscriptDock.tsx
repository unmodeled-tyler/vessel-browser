import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { useRuntime } from "../../stores/runtime";
import { useScrollFade } from "../../lib/useScrollFade";
import { formatTime } from "../../lib/format-time";
import {
  buildAgentTimelineItems,
  formatAgentTimelineDuration,
  isLiveAgentTimelineItem,
} from "../../lib/agentTimeline";
import type { AgentTranscriptDisplayMode } from "../../../../shared/types";
import "./AgentTranscriptDock.css";
import "./chrome.css";

const AgentTranscriptDock: Component = () => {
  const { runtimeState } = useRuntime();
  const [mode, setMode] = createSignal<AgentTranscriptDisplayMode>("off");
  const [collapsed, setCollapsed] = createSignal(false);

  onMount(() => {
    void window.vessel.settings.get().then((settings) => {
      setMode(settings.agentTranscriptMode ?? "off");
    });

    const unsubscribe = window.vessel.settings.onUpdate((settings) => {
      setMode(settings.agentTranscriptMode ?? "off");
    });
    onCleanup(unsubscribe);
  });

  const timelineItems = createMemo(() => buildAgentTimelineItems(runtimeState()));

  const hasStreamingEntry = createMemo(() =>
    timelineItems().some(isLiveAgentTimelineItem),
  );

  const hideDock = async () => {
    setMode("off");
    await window.vessel.settings.set("agentTranscriptMode", "off");
  };

  return (
    <Show when={mode() === "full" && timelineItems().length > 0}>
      <aside
        class="agent-transcript-dock"
        classList={{ collapsed: collapsed() }}
      >
        <div class="agent-transcript-header">
          <div class="agent-transcript-title-row">
            <span class="agent-transcript-title">Agent Timeline</span>
            <Show when={hasStreamingEntry()}>
              <span class="agent-transcript-live">
                <span class="agent-transcript-live-dot" aria-hidden="true" />
                Live
              </span>
            </Show>
          </div>
          <div class="agent-transcript-actions">
            <button
              class="agent-transcript-icon"
              onClick={() => setCollapsed((value) => !value)}
              data-tooltip={collapsed() ? "Expand" : "Collapse"}
            >
              {collapsed() ? "▴" : "▾"}
            </button>
            <button
              class="agent-transcript-icon"
              onClick={() => void hideDock()}
              data-tooltip="Hide"
            >
              ×
            </button>
          </div>
        </div>

        <Show when={!collapsed()}>
          <div class="agent-transcript-list" ref={(el) => useScrollFade(el)}>
            <For each={timelineItems()}>
              {(entry) => {
                const duration = () =>
                  entry.type === "action"
                    ? formatAgentTimelineDuration(entry.durationMs)
                    : null;

                return (
                  <article
                    class={`agent-transcript-entry ${entry.kind}`}
                    classList={{
                      streaming: isLiveAgentTimelineItem(entry),
                      failed: entry.status === "failed",
                      "waiting-approval": entry.status === "waiting-approval",
                    }}
                  >
                    <div class="agent-transcript-meta">
                      <span class="agent-transcript-badge">{entry.label}</span>
                      <span class="agent-transcript-time">
                        {formatTime(entry.timestamp)}
                        <Show when={duration()}>
                          {(value) => <> · {value()}</>}
                        </Show>
                      </span>
                    </div>
                    <div class="agent-transcript-text">{entry.detail}</div>
                  </article>
                );
              }}
            </For>
          </div>
        </Show>
      </aside>
    </Show>
  );
};

export default AgentTranscriptDock;
