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
import type { AgentTranscriptDisplayMode } from "../../../../shared/types";
import "./chrome.css";

const AgentTranscriptDock: Component = () => {
  const { runtimeState } = useRuntime();
  const [mode, setMode] = createSignal<AgentTranscriptDisplayMode>("summary");
  const [collapsed, setCollapsed] = createSignal(false);

  onMount(() => {
    void window.vessel.settings.get().then((settings) => {
      setMode(settings.agentTranscriptMode ?? "summary");
    });

    const unsubscribe = window.vessel.settings.onUpdate((settings) => {
      setMode(settings.agentTranscriptMode ?? "summary");
    });
    onCleanup(unsubscribe);
  });

  const visibleEntries = createMemo(() =>
    runtimeState().transcript.slice(-6).reverse(),
  );

  const hasStreamingEntry = createMemo(() =>
    visibleEntries().some((entry) => entry.status === "streaming"),
  );

  const formatTime = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const hideDock = async () => {
    setMode("off");
    await window.vessel.settings.set("agentTranscriptMode", "off");
  };

  return (
    <Show when={mode() === "full" && visibleEntries().length > 0}>
      <aside
        class="agent-transcript-dock"
        classList={{ collapsed: collapsed() }}
      >
        <div class="agent-transcript-header">
          <div class="agent-transcript-title-row">
            <span class="agent-transcript-title">Agent Transcript</span>
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
              title={collapsed() ? "Expand transcript" : "Collapse transcript"}
            >
              {collapsed() ? "▴" : "▾"}
            </button>
            <button
              class="agent-transcript-icon"
              onClick={() => void hideDock()}
              title="Hide transcript monitor"
            >
              ×
            </button>
          </div>
        </div>

        <Show when={!collapsed()}>
          <div class="agent-transcript-list">
            <For each={visibleEntries()}>
              {(entry) => (
                <article
                  class={`agent-transcript-entry ${entry.kind}`}
                  classList={{ streaming: entry.status === "streaming" }}
                >
                  <div class="agent-transcript-meta">
                    <span class="agent-transcript-badge">
                      {entry.title || entry.kind}
                    </span>
                    <span class="agent-transcript-time">
                      {formatTime(entry.updatedAt)}
                    </span>
                  </div>
                  <div class="agent-transcript-text">{entry.text}</div>
                </article>
              )}
            </For>
          </div>
        </Show>
      </aside>
    </Show>
  );
};

export default AgentTranscriptDock;
