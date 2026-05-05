import { createSignal, Show, Switch, Match, type Component } from "solid-js";
import { useResearch } from "../../stores/research";

export const ResearchDesk: Component = () => {
  const research = useResearch();
  const state = research.state;
  const [draftQuery, setDraftQuery] = createSignal("");
  const [startError, setStartError] = createSignal<string | null>(null);
  const [isStarting, setIsStarting] = createSignal(false);

  async function handleStartResearch(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const query = draftQuery().trim();

    if (!query) {
      setStartError("Add a research question first.");
      return;
    }

    setStartError(null);
    setIsStarting(true);
    try {
      const result = await research.startBrief(query);
      if (!result.accepted) {
        setStartError(
          result.reason === "busy"
            ? "Research Desk already has a brief in progress — switching views now."
            : "Could not start research. Please try again.",
        );
      }
    } finally {
      setIsStarting(false);
    }
  }

  return (
    <div class="research-desk">
      <Switch>
        <Match when={state().phase === "idle"}>
          <div class="research-idle">
            <div class="research-hero-card">
              <div class="research-kicker">Research Desk</div>
              <h3>Turn a question into a sourced brief.</h3>
              <p class="research-hero-copy">
                Vessel interviews you to sharpen the scope, then sends parallel
                agents to investigate each angle. The final report comes back
                with citations, contradictions, gaps, and an export-ready source
                index.
              </p>

              <div class="research-feature-grid" aria-label="Research Desk workflow">
                <div class="research-feature-pill">
                  <span>01</span>
                  Briefing questions
                </div>
                <div class="research-feature-pill">
                  <span>02</span>
                  Parallel sub-agents
                </div>
                <div class="research-feature-pill">
                  <span>03</span>
                  Source-anchored report
                </div>
              </div>

              <Show when={!research.isPremium()}>
                <div class="research-premium-notice">
                  <span class="premium-badge">Premium</span>
                  <span>Briefing is free. Full research and export require Vessel Premium.</span>
                </div>
              </Show>

              <form class="research-start-form" onSubmit={handleStartResearch}>
                <label class="research-query-label" for="research-query-input">
                  What are we researching?
                </label>
                <textarea
                  id="research-query-input"
                  class="research-query-input"
                  value={draftQuery()}
                  rows={3}
                  placeholder="e.g. Compare local-first browser automation frameworks for agent workflows"
                  onInput={(event) => {
                    setDraftQuery(event.currentTarget.value);
                    if (startError()) setStartError(null);
                  }}
                />
                <Show when={startError()}>
                  {(message) => <p class="research-start-error">{message()}</p>}
                </Show>
                <button
                  class="research-start-btn"
                  type="submit"
                  disabled={isStarting()}
                >
                  <span class="research-start-btn-main">
                    {isStarting() ? "Starting Research…" : "Start Research"}
                  </span>
                  <span class="research-start-btn-sub">
                    {isStarting()
                      ? "Opening the briefing workspace"
                      : "Build a scoped research brief"}
                  </span>
                </button>
              </form>
            </div>
          </div>
        </Match>

        <Match when={state().phase === "briefing"}>
          <div class="research-phase">
            <h3>Briefing</h3>
            <p>Answer the questions in the Chat tab to refine your research question.</p>
            <div class="phase-controls">
              <button
                onClick={async () => {
                  const result = await research.confirmBrief();
                  if (!result.accepted && result.reason === "premium") {
                    void window.vessel.premium.checkout();
                  }
                }}
              >
                Confirm Brief
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
                      class="research-confirm-btn"
                      onClick={() =>
                        research.approveObjectives({
                          supervisionMode: state().supervisionMode,
                          includeTraces: state().includeTraces,
                        })
                      }
                    >
                      Launch Research Agents
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
