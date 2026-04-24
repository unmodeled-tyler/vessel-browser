import {
  type Component,
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import { matchesPageSnapshotUrl } from "../../../../shared/page-url";
import type { PageDiffHistoryItem } from "../../../../shared/page-diff-types";
import { useTabs } from "../../stores/tabs";

const PageDiffTimeline: Component = () => {
  const { activeTab } = useTabs();
  const [bursts, setBursts] = createSignal<PageDiffHistoryItem[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  let latestRequestId = 0;

  const loadHistory = async () => {
    const requestId = ++latestRequestId;
    const tab = activeTab();
    if (!tab?.url) {
      setBursts([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const result = await window.vessel.pageDiff.getHistory();
      if (requestId !== latestRequestId) return; // stale request
      if (result && typeof result === "object" && "error" in result) {
        setError(result.error);
        setBursts([]);
      } else {
        setBursts((result as PageDiffHistoryItem[]) ?? []);
        setError(null);
      }
    } catch {
      if (requestId !== latestRequestId) return;
      setError("Failed to load diff history");
      setBursts([]);
    } finally {
      if (requestId === latestRequestId) {
        setLoading(false);
      }
    }
  };

  createEffect(() => {
    void activeTab()?.url;
    void loadHistory();
  });

  const unsubscribe = window.vessel.pageDiff.onChanged((diff) => {
    const tab = activeTab();
    if (!tab || !matchesPageSnapshotUrl(tab.url, diff.url)) return;
    void loadHistory();
  });

  onCleanup(() => {
    unsubscribe();
  });

  return (
    <div class="page-diff-timeline">
      <Show when={loading()}>
        <div class="agent-muted">Loading...</div>
      </Show>
      <Show when={!loading() && error()}>
        <div class="agent-muted">{error()}</div>
      </Show>
      <Show when={!loading() && !error() && bursts().length === 0}>
        <div class="agent-muted">No changes detected yet.</div>
      </Show>
      <Show when={!loading() && !error() && bursts().length > 0}>
        <div class="agent-section-title">Recent page changes</div>
        <div class="page-diff-list">
          <For each={bursts()}>
            {(burst, i) => (
              <div class="page-diff-item">
                <div class="checkpoint-timeline-rail">
                  <span
                    class="checkpoint-timeline-dot"
                    classList={{ latest: i() === 0 }}
                  />
                  <Show when={i() < bursts().length - 1}>
                    <span class="checkpoint-timeline-line" />
                  </Show>
                </div>
                <div class="page-diff-content">
                  <div class="page-diff-time">
                    {new Date(burst.detectedAt).toLocaleString()}
                  </div>
                  <div class="page-diff-summary">{burst.summary}</div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default PageDiffTimeline;
