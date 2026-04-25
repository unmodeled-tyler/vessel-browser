import {
  createSignal,
  createEffect,
  createMemo,
  Show,
  For,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { useTabs } from "../../stores/tabs";
import { useNow } from "../../stores/clock";
import { useRuntime } from "../../stores/runtime";
import { useUI } from "../../stores/ui";
import { useHistory } from "../../stores/history";
import { useBookmarks } from "../../stores/bookmarks";
import type { PageDiff } from "../../../../shared/page-diff-types";
import { matchesPageSnapshotUrl } from "../../../../shared/page-url";
import {
  SEARCH_ENGINE_PRESETS,
  type SearchEngineId,
} from "../../../../shared/types";
import {
  getAgentPresence,
  getLatestAgentStatusMessage,
} from "../../lib/agentActivity";
import "./chrome.css";

interface AutocompleteItem {
  url: string;
  title: string;
  subtitle?: string;
  source: "history" | "bookmark" | "search";
}

const AddressBar: Component = () => {
  const { activeTab, activeTabId, navigate, goBack, goForward, reload, toggleAdBlock } = useTabs();
  const { runtimeState } = useRuntime();
  const { toggleSidebar, openSettings, toggleDevTools, devtoolsPanelOpen } = useUI();
  const { historyState } = useHistory();
  const { bookmarksState } = useBookmarks();
  const [inputValue, setInputValue] = createSignal("");
  const [showSuggestions, setShowSuggestions] = createSignal(false);
  const [selectedIndex, setSelectedIndex] = createSignal(-1);
  const [searchEngine, setSearchEngine] = createSignal<SearchEngineId>("duckduckgo");
  const now = useNow();
  let inputRef: HTMLInputElement | undefined;

  const agentPresence = createMemo(() =>
    getAgentPresence(runtimeState(), now()),
  );
  const agentStatusMessage = createMemo(() =>
    getLatestAgentStatusMessage(runtimeState(), now()),
  );

  const pendingApprovalCount = createMemo(
    () => runtimeState().supervisor.pendingApprovals.length,
  );

  const searchEnginePreset = createMemo(() => {
    const engine = searchEngine();
    return engine === "none"
      ? SEARCH_ENGINE_PRESETS.duckduckgo
      : SEARCH_ENGINE_PRESETS[engine];
  });

  const buildSearchUrl = (query: string): string =>
    searchEnginePreset().url + encodeURIComponent(query);

  const [pageDiff, setPageDiff] = createSignal<PageDiff | null>(null);
  const [diffExpanded, setDiffExpanded] = createSignal(false);
  let diffCollapseTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    let disposed = false;
    void window.vessel.settings.get()
      .then((settings) => {
        if (!disposed) {
          setSearchEngine(settings.defaultSearchEngine ?? "duckduckgo");
        }
      })
      .catch(() => {});
    const unsubscribe = window.vessel.settings.onUpdate((settings) => {
      setSearchEngine(settings.defaultSearchEngine ?? "duckduckgo");
    });
    onCleanup(() => {
      disposed = true;
      unsubscribe();
    });
  });

  const showIncomingDiff = (diff: PageDiff) => {
    setPageDiff(diff);
    setDiffExpanded(true);
    if (diffCollapseTimer) clearTimeout(diffCollapseTimer);
    diffCollapseTimer = setTimeout(() => {
      setDiffExpanded(false);
      diffCollapseTimer = null;
    }, 8000);
  };

  const openDiffTimeline = async () => {
    setDiffExpanded(false);
    if (diffCollapseTimer) {
      clearTimeout(diffCollapseTimer);
      diffCollapseTimer = null;
    }
    await window.vessel.ui.openSidebarTab("diff");
  };

  const formatRelativeTime = (isoDate: string): string => {
    const diff = Date.now() - new Date(isoDate).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(isoDate).toLocaleDateString();
  };

  const formatElapsed = (startIso: string, endIso: string): string => {
    const elapsedMs = Math.max(
      0,
      new Date(endIso).getTime() - new Date(startIso).getTime(),
    );
    const secs = Math.round(elapsedMs / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.round(mins / 60);
    return `${hours}h`;
  };

  createEffect(() => {
    const unsubscribe = window.vessel.pageDiff.onChanged((diff) => {
      const tab = activeTab();
      if (!tab) return;
      if (!matchesPageSnapshotUrl(tab.url, diff.url)) return;
      showIncomingDiff(diff);
    });
    onCleanup(() => {
      unsubscribe();
      if (diffCollapseTimer) {
        clearTimeout(diffCollapseTimer);
        diffCollapseTimer = null;
      }
    });
  });

  // Sync URL from active tab
  createEffect(() => {
    const tab = activeTab();
    if (tab && !inputRef?.matches(":focus")) {
      setInputValue(tab.url === "about:blank" ? "" : tab.url);
      setShowSuggestions(false);
      setSelectedIndex(-1);
    }
  });

  // Autocomplete suggestions
  const MAX_SUGGESTIONS = 8;

  const suggestions = createMemo<AutocompleteItem[]>(() => {
    const rawQuery = inputValue().trim();
    const query = rawQuery.toLowerCase();
    if (!query || query.length < 2) return [];

    const results: AutocompleteItem[] = [];
    const seen = new Set<string>();
    const matchLimit = MAX_SUGGESTIONS - 1;

    // Bookmarks first
    for (const b of bookmarksState().bookmarks) {
      if (seen.has(b.url)) continue;
      const urlMatch = b.url.toLowerCase().includes(query);
      const titleMatch = b.title.toLowerCase().includes(query);
      if (urlMatch || titleMatch) {
        seen.add(b.url);
        results.push({ url: b.url, title: b.title, source: "bookmark" });
      }
      if (results.length >= matchLimit) break;
    }

    // History
    if (results.length < matchLimit) {
      for (const h of historyState().entries) {
        if (seen.has(h.url)) continue;
        const urlMatch = h.url.toLowerCase().includes(query);
        const titleMatch = h.title.toLowerCase().includes(query);
        if (urlMatch || titleMatch) {
          seen.add(h.url);
          results.push({ url: h.url, title: h.title, source: "history" });
        }
        if (results.length >= matchLimit) break;
      }
    }

    if (results.length < MAX_SUGGESTIONS) {
      results.push({
        url: buildSearchUrl(rawQuery),
        title: `Search for "${rawQuery}"`,
        subtitle: searchEnginePreset().label,
        source: "search",
      });
    }

    return results;
  });

  createEffect(() => {
    const tab = activeTab();
    if (!tab) {
      setPageDiff(null);
      setDiffExpanded(false);
      return;
    }

    let cancelled = false;
    void window.vessel.pageDiff.get().then((diff) => {
      if (cancelled) return;
      if (!diff || !matchesPageSnapshotUrl(tab.url, diff.url)) {
        setPageDiff(null);
        setDiffExpanded(false);
        return;
      }
      setPageDiff(diff);
    }).catch(() => {
      if (cancelled) return;
      setPageDiff(null);
      setDiffExpanded(false);
    });

    onCleanup(() => {
      cancelled = true;
    });
  });

  const selectSuggestion = (url: string) => {
    setInputValue(url);
    setShowSuggestions(false);
    setSelectedIndex(-1);
    navigate(url);
    inputRef?.blur();
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const idx = selectedIndex();
    const items = suggestions();
    if (idx >= 0 && idx < items.length) {
      selectSuggestion(items[idx].url);
    } else {
      const val = inputValue().trim();
      if (val) {
        navigate(val);
        inputRef?.blur();
        setShowSuggestions(false);
      }
    }
  };

  const handleInputKeyDown = (e: KeyboardEvent) => {
    const items = suggestions();
    const idx = selectedIndex();

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) {
        setShowSuggestions(true);
        setSelectedIndex(idx < items.length - 1 ? idx + 1 : 0);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) {
        setShowSuggestions(true);
        setSelectedIndex(idx > 0 ? idx - 1 : items.length - 1);
      }
    } else if (e.key === "Escape") {
      if (showSuggestions()) {
        setShowSuggestions(false);
        setSelectedIndex(-1);
      } else {
        inputRef?.blur();
      }
    }
  };

  const formatSectionLabel = (section: PageDiff["changes"][number]["section"]) =>
    section === "title"
      ? "Title"
      : section === "headings"
        ? "Headings"
        : "Content";

  return (
    <div class="address-bar">
      <div class="nav-controls">
        <button
          class="nav-btn"
          onClick={goBack}
          disabled={!activeTab()?.canGoBack}
          data-tooltip="Back"
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path
              d="M9 2L4 7l5 5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          class="nav-btn"
          onClick={goForward}
          disabled={!activeTab()?.canGoForward}
          data-tooltip="Forward"
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path
              d="M5 2l5 5-5 5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button class="nav-btn" onClick={reload} data-tooltip="Reload">
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path
              d="M2.5 7a4.5 4.5 0 1 1 1 3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
            <path
              d="M2 4v3.5h3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>

      <div class="url-shell">
        <form class="url-form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            class="url-input"
            type="text"
            value={inputValue()}
            onInput={(e) => {
              setInputValue(e.currentTarget.value);
              setShowSuggestions(true);
              setSelectedIndex(-1);
            }}
            onFocus={(e) => {
              e.currentTarget.select();
              const query = inputValue().trim();
              if (query.length >= 2) setShowSuggestions(true);
            }}
            onKeyDown={handleInputKeyDown}
            onBlur={() => {
              // Delay to allow click on suggestion
              setTimeout(() => {
                setShowSuggestions(false);
                setSelectedIndex(-1);
              }, 150);
            }}
            placeholder="Search or enter URL"
            spellcheck={false}
            autocomplete="off"
            aria-autocomplete="list"
            aria-expanded={showSuggestions() && suggestions().length > 0}
            aria-controls="address-autocomplete"
            aria-activedescendant={
              selectedIndex() >= 0
                ? `address-autocomplete-${selectedIndex()}`
                : undefined
            }
          />
        </form>

        <Show when={showSuggestions() && suggestions().length > 0}>
          <div
            id="address-autocomplete"
            class="autocomplete-dropdown"
            role="listbox"
          >
            <For each={suggestions()}>
              {(item, i) => (
                <div
                  id={`address-autocomplete-${i()}`}
                  class={`autocomplete-item ${
                    selectedIndex() === i() ? "selected" : ""
                  }`}
                  role="option"
                  aria-selected={selectedIndex() === i()}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectSuggestion(item.url);
                  }}
                  onMouseEnter={() => setSelectedIndex(i())}
                >
                  <span class="autocomplete-icon">
                    {item.source === "bookmark"
                      ? "\u2605"
                      : item.source === "search"
                        ? "\u2315"
                        : "\u25CC"}
                  </span>
                  <span class="autocomplete-text">
                    <span class="autocomplete-title">{item.title || item.url}</span>
                    <span class="autocomplete-url">{item.subtitle || item.url}</span>
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div
          class={`agent-status-badge ${agentPresence()}`}
          title={
            agentStatusMessage() ||
            (agentPresence() === "active"
              ? "Agent is actively using the browser"
              : agentPresence() === "recent"
                ? "Agent is connected"
                : "No agent connection detected")
          }
        >
          <span class="agent-status-dot" aria-hidden="true" />
          <span class="agent-status-text">
            {agentStatusMessage() ||
              (agentPresence() === "active"
                ? "Agent Active"
                : agentPresence() === "recent"
                  ? "Agent Connected"
                  : "Agent Offline")}
          </span>
        </div>

        <Show when={pageDiff()}>
          <button
            class="agent-status-badge recent"
            style="cursor: pointer; font-size: 11px;"
            onClick={() => void openDiffTimeline()}
            title="Open the What Changed timeline"
          >
            <span class="agent-status-dot" style="background: #f59e0b;" aria-hidden="true" />
            <span class="agent-status-text">What Changed?</span>
          </button>
        </Show>
      </div>

      <Show when={pageDiff() && diffExpanded()}>
        <div class="page-diff-popup">
          <div class="page-diff-popup-header">
            <div class="page-diff-popup-header-copy">
              <span>
                What changed since {formatRelativeTime(pageDiff()!.oldSnapshot.capturedAt)}
              </span>
              <Show
                when={
                  (pageDiff()!.burstCount || 0) > 1 &&
                  pageDiff()!.firstDetectedAt &&
                  pageDiff()!.lastDetectedAt
                }
              >
                <span class="page-diff-burst-meta">
                  Updated {pageDiff()!.burstCount} times over{" "}
                  {formatElapsed(
                    pageDiff()!.firstDetectedAt!,
                    pageDiff()!.lastDetectedAt!,
                  )}
                </span>
              </Show>
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <button
                class="nav-btn"
                style="height: 24px; min-width: auto; padding: 0 8px;"
                onClick={() => void openDiffTimeline()}
                title="Open the full What Changed timeline"
              >
                Timeline
              </button>
              <button class="page-diff-popup-close" onClick={() => setDiffExpanded(false)}>&times;</button>
            </div>
          </div>
          <Show when={pageDiff()!.recentBursts?.length && (pageDiff()!.recentBursts?.length || 0) > 1}>
            <div class="page-diff-burst-history">
              <div class="page-diff-burst-history-label">Changed recently</div>
              <For each={pageDiff()!.recentBursts}>
                {(burst) => (
                  <div class="page-diff-burst-row">
                    <span class="page-diff-burst-time">
                      {formatRelativeTime(burst.detectedAt)}
                    </span>
                    <span class="page-diff-burst-summary">{burst.summary}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <For each={pageDiff()!.changes}>
            {(change) => (
              <div class={`page-diff-item page-diff-${change.kind}`}>
                <div class="page-diff-item-header">
                  <span class="page-diff-section">
                    {formatSectionLabel(change.section)}
                  </span>
                  <span class="page-diff-summary">{change.summary}</span>
                </div>
                <Show when={change.before || change.after}>
                  <div class="page-diff-snippets">
                    <Show when={change.before}>
                      <div class="page-diff-snippet">
                        <span class="page-diff-snippet-label">Before</span>
                        <span class="page-diff-snippet-text">{change.before}</span>
                      </div>
                    </Show>
                    <Show when={change.after}>
                      <div class="page-diff-snippet">
                        <span class="page-diff-snippet-label">After</span>
                        <span class="page-diff-snippet-text">{change.after}</span>
                      </div>
                    </Show>
                  </div>
                </Show>
                <Show when={change.addedItems?.length}>
                  <div class="page-diff-list-group">
                    <span class="page-diff-list-label">Added</span>
                    <ul class="page-diff-list">
                      <For each={change.addedItems}>
                        {(item) => <li>{item}</li>}
                      </For>
                    </ul>
                  </div>
                </Show>
                <Show when={change.removedItems?.length}>
                  <div class="page-diff-list-group">
                    <span class="page-diff-list-label">Removed</span>
                    <ul class="page-diff-list">
                      <For each={change.removedItems}>
                        {(item) => <li>{item}</li>}
                      </For>
                    </ul>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div class="toolbar-actions">
        <button
          class="nav-btn"
          classList={{
            active: !!activeTab()?.adBlockingEnabled,
            "nav-btn-muted": !activeTab()?.adBlockingEnabled,
          }}
          onClick={async () => {
            const id = activeTabId();
            if (!id) return;
            await toggleAdBlock(id);
          }}
          title={activeTab()?.adBlockingEnabled ? "Ad Block: On (click to disable)" : "Ad Block: Off (click to enable)"}
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <Show when={activeTab()?.adBlockingEnabled}>
              <path
                d="M3 3 L11 3 L11 9 Q7 13 3 9 Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linejoin="round"
              />
            </Show>
            <Show when={!activeTab()?.adBlockingEnabled}>
              <path
                d="M3 3 L11 3 L11 9 Q7 13 3 9 Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linejoin="round"
              />
              <line x1="2" y1="12" x2="12" y2="2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </Show>
          </svg>
        </button>
        <button
          class="nav-btn"
          classList={{ active: !!activeTab()?.isReaderMode }}
          onClick={() => window.vessel.content.toggleReader()}
          data-tooltip="Reader Mode"
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <rect
              x="2"
              y="1"
              width="10"
              height="12"
              rx="1"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <line
              x1="4"
              y1="4"
              x2="10"
              y2="4"
              stroke="currentColor"
              stroke-width="1"
            />
            <line
              x1="4"
              y1="6.5"
              x2="10"
              y2="6.5"
              stroke="currentColor"
              stroke-width="1"
            />
            <line
              x1="4"
              y1="9"
              x2="8"
              y2="9"
              stroke="currentColor"
              stroke-width="1"
            />
          </svg>
        </button>
        <button
          class="nav-btn"
          classList={{ active: devtoolsPanelOpen() }}
          onClick={toggleDevTools}
          data-tooltip="Dev Tools"
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <polyline
              points="3,5 1,7 3,9"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <polyline
              points="11,5 13,7 11,9"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <line
              x1="8.5"
              y1="2"
              x2="5.5"
              y2="12"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <button
          class="nav-btn nav-btn-sidebar"
          classList={{ "has-approvals": pendingApprovalCount() > 0 }}
          onClick={toggleSidebar}
          title={
            pendingApprovalCount() > 0
              ? `AI Sidebar — ${pendingApprovalCount()} pending approval${pendingApprovalCount() > 1 ? "s" : ""}`
              : "AI Sidebar (Ctrl+Shift+L)"
          }
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <rect
              x="1"
              y="1"
              width="12"
              height="12"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <line
              x1="9"
              y1="1"
              x2="9"
              y2="13"
              stroke="currentColor"
              stroke-width="1.2"
            />
          </svg>
          <Show when={pendingApprovalCount() > 0}>
            <span class="nav-btn-badge" aria-label={`${pendingApprovalCount()} pending`}>
              {pendingApprovalCount()}
            </span>
          </Show>
        </button>
        <button
          class="nav-btn"
          onClick={openSettings}
          data-tooltip="Settings"
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <circle
              cx="7"
              cy="7"
              r="2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path
              d="M7 1v2M7 11v2M1 7h2M11 7h2M2.8 2.8l1.4 1.4M9.8 9.8l1.4 1.4M11.2 2.8l-1.4 1.4M4.2 9.8l-1.4 1.4"
              stroke="currentColor"
              stroke-width="1"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default AddressBar;
