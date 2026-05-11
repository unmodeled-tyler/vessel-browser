import {
  For,
  Show,
  Switch,
  Match,
  createMemo,
  createSignal,
  type Component,
} from "solid-js";
import { useAI } from "../../stores/ai";
import { useResearch } from "../../stores/research";

export const ResearchDesk: Component = () => {
  const research = useResearch();
  const {
    query: sendChatQuery,
    messages,
    streamingText,
    isStreaming,
    pendingQueryCount,
  } = useAI();
  const state = research.state;
  const [topicInput, setTopicInput] = createSignal("");
  const [briefInput, setBriefInput] = createSignal("");
  const [startError, setStartError] = createSignal("");

  const transcriptMessages = createMemo(() => {
    const allMessages = messages();
    const originalQuery = state().originalQuery?.trim();
    if (!originalQuery) return allMessages;

    for (let i = allMessages.length - 1; i >= 0; i -= 1) {
      const message = allMessages[i];
      if (message.role === "user" && message.content.trim() === originalQuery) {
        return allMessages.slice(i);
      }
    }

    return [];
  });

  const hasAssistantBrief = createMemo(() =>
    transcriptMessages().some((message) => message.role === "assistant"),
  );
  const isBriefStarting = createMemo(() =>
    state().phase === "briefing" &&
    transcriptMessages().length === 0 &&
    !streamingText() &&
    pendingQueryCount() === 0,
  );

  const sendBriefMessage = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    await sendChatQuery(trimmed);
  };

  const startBrief = async () => {
    const query = topicInput().trim();
    if (!query) return;
    const result = await research.startBrief(query);
    if (result.accepted) {
      setStartError("");
      setTopicInput("");
      await sendBriefMessage(query);
    } else {
      setStartError(
        result.reason === "busy"
          ? "Research Desk is already working on a brief."
          : "Could not start the briefing. Check your chat provider settings and try again.",
      );
    }
  };

  return (
    <div class="research-desk">
      <Switch>
        <Match when={state().phase === "idle"}>
          <div class="research-idle">
            <h3>Research Desk</h3>
            <p>Start with a topic. Vessel will shape it into a focused brief, draft a research plan, and then send sub-agents after the strongest sources.</p>
            <Show when={!research.isPremium()}>
              <div class="research-premium-notice">
                <span class="premium-badge">Premium</span>
                {" "}Brief is free; full research and export require Vessel Premium.
              </div>
            </Show>
            <form
              class="research-topic-form"
              onSubmit={(event) => {
                event.preventDefault();
                void startBrief();
              }}
            >
              <textarea
                class="research-topic-input"
                rows={3}
                placeholder="What should we research?"
                value={topicInput()}
                onInput={(event) => setTopicInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void startBrief();
                  }
                }}
              />
              <button
                class="research-start-btn"
                type="submit"
                disabled={!topicInput().trim()}
              >
                Start Briefing
              </button>
            </form>
            <Show when={startError()}>
              <div class="research-brief-status">{startError()}</div>
            </Show>
          </div>
        </Match>

        <Match when={state().phase === "briefing"}>
          <div class="research-phase">
            <h3>Briefing</h3>
            <p>Work through the brief here. Once the assistant has enough context, turn it into a research plan.</p>
            <div class="research-brief-thread">
              <Show when={isBriefStarting()}>
                <div class="research-brief-loading" role="status" aria-live="polite">
                  <span class="research-spinner" aria-hidden="true" />
                  <div>
                    <div class="research-loading-title">Brief started</div>
                    <div class="research-loading-copy">
                      Preparing the first briefing question...
                    </div>
                  </div>
                </div>
              </Show>
              <For each={transcriptMessages()}>
                {(message) => (
                  <div class={`research-brief-message ${message.role}`}>
                    {message.content}
                  </div>
                )}
              </For>
              <Show when={isStreaming() && streamingText()}>
                <div class="research-brief-message assistant">
                  {streamingText()}
                </div>
              </Show>
              <Show when={isStreaming() && !streamingText()}>
                <div class="research-brief-status">Thinking...</div>
              </Show>
              <Show when={pendingQueryCount() > 0}>
                <div class="research-brief-status">
                  {pendingQueryCount()} queued
                </div>
              </Show>
            </div>
            <form
              class="research-brief-form"
              onSubmit={(event) => {
                event.preventDefault();
                const message = briefInput();
                setBriefInput("");
                void sendBriefMessage(message);
              }}
            >
              <textarea
                class="research-brief-input"
                rows={2}
                placeholder={isStreaming() ? "Send now to queue a follow-up..." : "Please provide as much information about your research question as possible, e.g. constraints, preferred sources..."}
                value={briefInput()}
                onInput={(event) => setBriefInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    const message = briefInput();
                    setBriefInput("");
                    void sendBriefMessage(message);
                  }
                }}
              />
              <button type="submit" disabled={!briefInput().trim()}>
                {isStreaming() ? "Queue" : "Send"}
              </button>
            </form>
            <div class="phase-controls">
              <button
                disabled={!hasAssistantBrief() || isStreaming()}
                onClick={async () => {
                  const result = await research.confirmBrief();
                  if (result.accepted) {
                    await sendChatQuery(
                      "Build the Research Objectives from this brief now.",
                    );
                  } else if (result.reason === "premium") {
                    void window.vessel.premium.checkout();
                  }
                }}
              >
                Build Research Plan
              </button>
              <button class="secondary" onClick={() => research.cancel()}>
                Cancel
              </button>
            </div>
          </div>
        </Match>

        <Match when={state().phase === "planning"}>
          <div class="research-phase">
            <h3>Planning Research</h3>
            <p>Creating Research Objectives based on your brief...</p>
          </div>
        </Match>

        <Match when={state().phase === "awaiting_approval"}>
          <div class="research-phase">
            <h3>Research Objectives</h3>
            <Show when={state().objectives}>
              {(obj) => (
                <div class="objectives-card">
                  <p><strong>Question:</strong> {obj().researchQuestion}</p>
                  <p><strong>Threads:</strong> {obj().threads.length}</p>
                  <ul>
                    {obj().threads.map((t) => (
                      <li>{t.label} ({t.sourceBudget} sources)</li>
                    ))}
                  </ul>

                  <label class="mode-toggle">
                    <input
                      type="checkbox"
                      checked={state().supervisionMode === "walk-away"}
                      onChange={(e) =>
                        research.setMode(
                          e.currentTarget.checked ? "walk-away" : "interactive",
                        )
                      }
                    />
                    Walk-away mode (notified when done)
                  </label>

                  <label class="traces-toggle">
                    <input
                      type="checkbox"
                      checked={state().includeTraces}
                      onChange={(e) =>
                        research.setTraces(e.currentTarget.checked)
                      }
                    />
                    Include agent traces with report
                  </label>

                  <div class="phase-controls">
                    <button
                      onClick={() =>
                        research.approveObjectives({
                          supervisionMode: state().supervisionMode,
                          includeTraces: state().includeTraces,
                        })
                      }
                    >
                      Start Research
                    </button>
                    <button class="secondary" onClick={() => research.cancel()}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </Match>

        <Match when={state().phase === "executing"}>
          <div class="research-phase">
            <h3>Researching</h3>
            <Show when={state().threadFindings.length > 0}>
              <p>{state().threadFindings.length} of {state().threads.length} threads complete</p>
            </Show>
            <Show when={state().supervisionMode === "interactive"}>
              <button onClick={() => research.setMode("walk-away")}>
                Switch to Walk-Away
              </button>
            </Show>
            <Show when={state().supervisionMode === "walk-away"}>
              <button onClick={() => research.setMode("interactive")}>
                Switch to Interactive
              </button>
            </Show>
          </div>
        </Match>

        <Match when={state().phase === "synthesizing"}>
          <div class="research-phase">
            <h3>Synthesizing Report</h3>
            <p>Compiling findings into the Research Report...</p>
          </div>
        </Match>

        <Match when={state().phase === "delivered"}>
          <div class="research-phase">
            <h3>Report Ready</h3>
            <Show when={state().report}>
              {(report) => (
                <div class="report-card">
                  <h4>{report().title}</h4>
                  <p>{report().executiveSummary.slice(0, 300)}...</p>
                  <p>{report().sourceIndex.length} sources cited</p>
                  <button onClick={() => research.exportReport()}>
                    Export as Markdown
                  </button>
                  <button class="secondary" onClick={() => research.cancel()}>
                    New Research
                  </button>
                </div>
              )}
            </Show>
          </div>
        </Match>
      </Switch>
    </div>
  );
};
