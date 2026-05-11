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
import { parseDiffSummaryParts } from "../../lib/pageDiffDisplay";
import { formatRelativeTime, formatShortDateTime } from "../../lib/timeDisplay";
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
        <div class="page-diff-timeline-header">
          <div class="agent-section-title">Change history for this page</div>
          <div class="agent-muted">
            Newest detections are first. Each entry is a saved change burst.
          </div>
        </div>
        <div class="page-diff-history-list">
          <For each={bursts()}>
            {(burst, i) => (
              <div class="page-diff-history-item">
                <div class="page-diff-history-time">
                  <span class="page-diff-history-label">
                    {i() === 0 ? "Latest change" : formatRelativeTime(burst.detectedAt)}
                  </span>
                  <span>{formatShortDateTime(burst.detectedAt)}</span>
                </div>
                <div class="page-diff-history-card">
                  <div class="page-diff-history-summary-list">
                    <For each={parseDiffSummaryParts(burst.summary)}>
                      {(part) => (
                        <div class="page-diff-history-summary-row">
                          <Show when={part.section}>
                            <span class="page-diff-history-summary-section">
                              {part.section}
                            </span>
                          </Show>
                          <span class="page-diff-history-summary">{part.text}</span>
                        </div>
                      )}
                    </For>
                  </div>
                  <div class="page-diff-history-position">
                    Entry {i() + 1} of {bursts().length}
                  </div>
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
