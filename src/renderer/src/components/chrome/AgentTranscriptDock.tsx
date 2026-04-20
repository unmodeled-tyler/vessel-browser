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

  const hideDock = async () => {
    setMode("off");
    await window.vessel.settings.set("agentTranscriptMode", "off");
  };

  const isSummary = createMemo(() => mode() === "summary");
  const latestEntry = createMemo(() => {
    const entries = visibleEntries();
    return entries.length > 0 ? entries[0] : null;
  });

  return (
    <Show when={mode() !== "off" && visibleEntries().length > 0}>
      <Show when={isSummary()}>
        <div class="agent-summary-hud">
          <Show when={latestEntry()}>
            {(entry) => (
              <>
                <Show when={hasStreamingEntry()}>
                  <span class="agent-summary-live-dot" aria-hidden="true" />
                </Show>
                <span class="agent-summary-text">
                  {entry().title || entry().kind}: {entry().text.length > 80 ? entry().text.slice(0, 77) + "..." : entry().text}
                </span>
              </>
            )}
          </Show>
        </div>
      </Show>
      <Show when={!isSummary()}>
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
    </Show>
  );
};

export default AgentTranscriptDock;
