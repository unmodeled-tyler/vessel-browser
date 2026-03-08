import {
  createSignal,
  For,
  Show,
  createEffect,
  createMemo,
  onCleanup,
  type Component,
} from "solid-js";
import { useAI } from "../../stores/ai";
import { useRuntime } from "../../stores/runtime";
import { useUI } from "../../stores/ui";
import { renderMarkdown } from "../../lib/markdown";
import "./ai.css";

const MarkdownMessage = (props: { content: string }) => {
  const html = createMemo(() => renderMarkdown(props.content));

  return <div class="message-content markdown-content" innerHTML={html()} />;
};

const Sidebar: Component<{ forceOpen?: boolean }> = (props) => {
  const {
    messages,
    streamingText,
    isStreaming,
    hasFirstChunk,
    streamStartedAt,
    query,
    cancel,
    clearHistory,
  } = useAI();
  const {
    runtimeState,
    pause,
    resume,
    setApprovalMode,
    resolveApproval,
    createCheckpoint,
    restoreCheckpoint,
    restoreSession,
  } = useRuntime();
  const {
    sidebarOpen,
    sidebarWidth,
    resizeSidebar,
    commitResize,
    toggleSidebar,
  } = useUI();
  const [input, setInput] = createSignal("");
  const [checkpointName, setCheckpointName] = createSignal("");
  const [isDragging, setIsDragging] = createSignal(false);
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);
  let messagesEndRef: HTMLDivElement | undefined;
  const recentActions = createMemo(() =>
    runtimeState().actions.slice(-8).reverse(),
  );
  const recentCheckpoints = createMemo(() =>
    runtimeState().checkpoints.slice(-5).reverse(),
  );

  // Auto-scroll to bottom on new messages
  createEffect(() => {
    messages();
    streamingText();
    messagesEndRef?.scrollIntoView({ behavior: "smooth" });
  });

  createEffect(() => {
    if (!isStreaming() || !streamStartedAt()) {
      setElapsedSeconds(0);
      return;
    }

    const tick = () => {
      const startedAt = streamStartedAt();
      if (!startedAt) return;
      setElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      );
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    onCleanup(() => window.clearInterval(intervalId));
  });

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const val = input().trim();
    if (!val || isStreaming()) return;
    setInput("");
    await query(val);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      void toggleSidebar();
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const startResize = (e: MouseEvent) => {
    if (props.forceOpen) return;

    e.preventDefault();
    setIsDragging(true);

    const onMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      resizeSidebar(newWidth);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      commitResize();
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  return (
    <Show when={props.forceOpen || sidebarOpen()}>
      <div
        class="sidebar"
        style={{ width: props.forceOpen ? "100%" : `${sidebarWidth()}px` }}
      >
        <Show when={!props.forceOpen}>
          <div
            class="sidebar-resize-handle"
            classList={{ dragging: isDragging() }}
            onMouseDown={startResize}
          />
        </Show>
        <div class="sidebar-header">
          <span class="sidebar-title">Vessel AI</span>
          <div class="sidebar-header-actions">
            <button
              class="sidebar-clear"
              onClick={clearHistory}
              title="Clear chat"
            >
              Clear
            </button>
            <button
              class="sidebar-close"
              onClick={() => void toggleSidebar()}
              title="Close AI chat (Esc)"
              aria-label="Close AI chat"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                aria-hidden="true"
              >
                <path
                  d="M3.5 3.5l7 7M10.5 3.5l-7 7"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
        </div>

        <div class="sidebar-messages">
          <section class="agent-panel">
            <div class="agent-panel-header">
              <div>
                <div class="agent-panel-title">Supervisor</div>
                <div class="agent-panel-subtitle">
                  {runtimeState().supervisor.paused
                    ? "Agent is paused"
                    : "Agent is live"}
                </div>
              </div>
              <span
                class="agent-status-pill"
                classList={{ paused: runtimeState().supervisor.paused }}
              >
                {runtimeState().supervisor.paused ? "Paused" : "Running"}
              </span>
            </div>

            <div class="agent-panel-controls">
              <select
                class="agent-select"
                value={runtimeState().supervisor.approvalMode}
                onChange={(e) =>
                  void setApprovalMode(
                    e.currentTarget.value as
                      | "auto"
                      | "confirm-dangerous"
                      | "manual",
                  )
                }
              >
                <option value="auto">Auto approve</option>
                <option value="confirm-dangerous">Approve dangerous</option>
                <option value="manual">Approve everything</option>
              </select>
              <button
                class="agent-control-button"
                type="button"
                onClick={() =>
                  void (runtimeState().supervisor.paused ? resume() : pause())
                }
              >
                {runtimeState().supervisor.paused ? "Resume" : "Pause"}
              </button>
              <button
                class="agent-control-button"
                type="button"
                onClick={() => void restoreSession()}
              >
                Restore session
              </button>
            </div>

            <div class="agent-checkpoint-row">
              <input
                class="agent-input"
                value={checkpointName()}
                onInput={(e) => setCheckpointName(e.currentTarget.value)}
                placeholder="Checkpoint name"
              />
              <button
                class="agent-primary-button"
                type="button"
                onClick={async () => {
                  const name = checkpointName().trim();
                  await createCheckpoint(name || undefined);
                  setCheckpointName("");
                }}
              >
                Save checkpoint
              </button>
            </div>

            <Show
              when={runtimeState().supervisor.pendingApprovals.length > 0}
              fallback={<div class="agent-muted">No pending approvals.</div>}
            >
              <div class="agent-section-title">Pending approvals</div>
              <For each={runtimeState().supervisor.pendingApprovals}>
                {(approval) => (
                  <div class="agent-card">
                    <div class="agent-card-title">{approval.name}</div>
                    <div class="agent-card-copy">{approval.argsSummary}</div>
                    <div class="agent-card-copy">{approval.reason}</div>
                    <div class="agent-card-actions">
                      <button
                        class="agent-primary-button"
                        type="button"
                        onClick={() => void resolveApproval(approval.id, true)}
                      >
                        Approve
                      </button>
                      <button
                        class="agent-control-button"
                        type="button"
                        onClick={() => void resolveApproval(approval.id, false)}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>

            <div class="agent-section-title">Recent checkpoints</div>
            <Show
              when={recentCheckpoints().length > 0}
              fallback={<div class="agent-muted">No checkpoints yet.</div>}
            >
              <For each={recentCheckpoints()}>
                {(checkpoint) => (
                  <div class="agent-card compact">
                    <div>
                      <div class="agent-card-title">{checkpoint.name}</div>
                      <div class="agent-card-copy">
                        {new Date(checkpoint.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <button
                      class="agent-control-button"
                      type="button"
                      onClick={() => void restoreCheckpoint(checkpoint.id)}
                    >
                      Restore
                    </button>
                  </div>
                )}
              </For>
            </Show>

            <div class="agent-section-title">Recent actions</div>
            <Show
              when={recentActions().length > 0}
              fallback={<div class="agent-muted">No actions yet.</div>}
            >
              <For each={recentActions()}>
                {(action) => (
                  <div class="agent-card">
                    <div class="agent-action-row">
                      <span class="agent-card-title">{action.name}</span>
                      <span class={`agent-action-status ${action.status}`}>
                        {action.status}
                      </span>
                    </div>
                    <div class="agent-card-copy">{action.argsSummary}</div>
                    <Show when={action.resultSummary}>
                      <div class="agent-card-copy success">
                        {action.resultSummary}
                      </div>
                    </Show>
                    <Show when={action.error}>
                      <div class="agent-card-copy error">{action.error}</div>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </section>

          <For each={messages()}>
            {(msg) => (
              <div class={`message message-${msg.role}`}>
                <MarkdownMessage content={msg.content} />
              </div>
            )}
          </For>

          <Show when={isStreaming()}>
            <div class="message message-assistant">
              <div class="message-content">
                <Show
                  when={hasFirstChunk()}
                  fallback={
                    <div class="thinking-state">
                      <div class="thinking-orb" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </div>
                      <div class="thinking-copy">
                        <div class="thinking-title">Thinking</div>
                      </div>
                    </div>
                  }
                >
                  <div>
                    <MarkdownMessage content={streamingText()} />
                    <div class="streaming-status">
                      <span class="streaming-pulse" aria-hidden="true" />
                      <span>Generating</span>
                      <Show when={elapsedSeconds() > 0}>
                        <span>{` • ${elapsedSeconds()}s`}</span>
                      </Show>
                    </div>
                  </div>
                </Show>
              </div>
            </div>
          </Show>

          <Show when={messages().length === 0 && !isStreaming()}>
            <div class="sidebar-empty">
              <p>Ask me anything about the current page.</p>
              <p class="sidebar-empty-hint">
                Try "summarize", "what is this about?", or any question.
              </p>
            </div>
          </Show>

          <div ref={messagesEndRef} />
        </div>

        <form class="sidebar-input-area" onSubmit={handleSubmit}>
          <textarea
            class="sidebar-input"
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask something..."
            rows={2}
            disabled={isStreaming()}
          />
          <Show
            when={isStreaming()}
            fallback={
              <button
                class="sidebar-send"
                type="submit"
                disabled={!input().trim()}
              >
                Send
              </button>
            }
          >
            <button class="sidebar-cancel" type="button" onClick={cancel}>
              Stop
            </button>
          </Show>
        </form>
      </div>
    </Show>
  );
};

export default Sidebar;
