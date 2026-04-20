import {
  For,
  Show,
  createMemo,
  type Component,
} from "solid-js";
import { useRuntime } from "../../stores/runtime";
import "./chrome.css";
import type { FlowState, FlowStep, TaskTrackerState, TaskTrackerStep } from "../../../../shared/types";

const FlowProgress: Component = () => {
  const { runtimeState } = useRuntime();

  const flow = createMemo(() => runtimeState().flowState);
  const tracker = createMemo(() => runtimeState().taskTracker);

  const stepStatusClass = (status: string) => {
    switch (status) {
      case "done": return "flow-step-done";
      case "active": return "flow-step-active";
      case "failed": return "flow-step-failed";
      case "skipped": return "flow-step-skipped";
      default: return "flow-step-pending";
    }
  };

  const progressPercent = (steps: { status: string }[], currentIndex: number) => {
    if (steps.length === 0) return 0;
    const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    return Math.round((done / steps.length) * 100);
  };

  return (
    <Show when={flow() || tracker()}>
      <div class="flow-progress">
        <Show when={tracker()}>
          {(t) => (
            <div class="flow-progress-section">
              <div class="flow-progress-header">
                <span class="flow-progress-goal">{t().goal}</span>
                <span class="flow-progress-pct">{progressPercent(t().steps, t().currentStepIndex)}%</span>
              </div>
              <div class="flow-progress-bar-track">
                <div
                  class="flow-progress-bar-fill"
                  style={{ width: `${progressPercent(t().steps, t().currentStepIndex)}%` }}
                />
              </div>
              <div class="flow-steps">
                <For each={t().steps}>
                  {(step) => (
                    <div class={`flow-step ${stepStatusClass(step.status)}`}>
                      <span class="flow-step-dot" />
                      <span class="flow-step-label">{step.label}</span>
                    </div>
                  )}
                </For>
              </div>
              <Show when={t().lastAction}>
                <div class="flow-progress-hint">Last: {t().lastAction}</div>
              </Show>
              <Show when={t().nextHint && !t().steps.every(s => s.status === "done")}>
                <div class="flow-progress-hint">Next: {t().nextHint}</div>
              </Show>
            </div>
          )}
        </Show>
        <Show when={flow() && !tracker()}>
          {(f) => (
            <div class="flow-progress-section">
              <div class="flow-progress-header">
                <span class="flow-progress-goal">{f().goal}</span>
                <span class="flow-progress-pct">{progressPercent(f().steps, f().currentStepIndex)}%</span>
              </div>
              <div class="flow-progress-bar-track">
                <div
                  class="flow-progress-bar-fill"
                  style={{ width: `${progressPercent(f().steps, f().currentStepIndex)}%` }}
                />
              </div>
              <div class="flow-steps">
                <For each={f().steps}>
                  {(step) => (
                    <div class={`flow-step ${stepStatusClass(step.status)}`}>
                      <span class="flow-step-dot" />
                      <span class="flow-step-label">{step.label}</span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
};

export default FlowProgress;
