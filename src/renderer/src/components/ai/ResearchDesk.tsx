import { Show, Switch, Match, type Component } from "solid-js";
import { useResearch } from "../../stores/research";

export const ResearchDesk: Component = () => {
  const research = useResearch();
  const state = research.state;

  return (
    <div class="research-desk">
      <Switch>
        <Match when={state().phase === "idle"}>
          <div class="research-idle">
            <h3>Research Desk</h3>
            <p>Deep research with parallel sub-agents. I'll interview you to refine your question, then spawn agents to investigate multiple angles simultaneously. Every claim in the final report is source-anchored.</p>
            <Show when={!research.isPremium()}>
              <div class="research-premium-notice">
                <span class="premium-badge">Premium</span>
                {" "}Brief is free; full research and export require Vessel Premium.
              </div>
            </Show>
            <button
              class="research-start-btn"
              onClick={async () => {
                await research.startBrief(
                  prompt("What would you like to research?") ?? "",
                );
              }}
            >
              Start Research
            </button>
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
