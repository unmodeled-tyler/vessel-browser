import {
  createSignal,
  createEffect,
  onCleanup,
  onMount,
  For,
  Show,
  type Component,
} from "solid-js";
import { Check, Copy, ExternalLink, PanelBottomOpen } from "lucide-solid";
import type {
  ConsoleEntry,
  DevToolsActivityEntry as ActivityEntry,
  DevToolsAgentTraceEntry,
  DevToolsPageMapElement,
  DevToolsPageMapRevealStatus,
  DevToolsPageMapSnapshot,
  DevToolsPanelState as PanelState,
  DevToolsPanelTab as PanelTab,
  NetworkEntry,
} from "../../../../shared/devtools-types";
import { formatTime } from "../../lib/format-time";
import { useDevToolsPanelHost } from "./useDevToolsPanelHost";
import "./devtools.css";

type DateMode = "today" | "custom";

function statusClass(status?: number): string {
  if (status == null) return "pending";
  if (status >= 200 && status < 300) return "ok";
  if (status >= 300 && status < 400) return "redirect";
  return "error";
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function shortenSource(url?: string, line?: number): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const file = u.pathname.split("/").pop() || u.pathname;
    return line != null ? `${file}:${line}` : file;
  } catch {
    return url;
  }
}

function todayDateString(): string {
  return new Date().toISOString().split("T")[0];
}

function filterByDate<T extends { timestamp: string }>(
  entries: T[],
  mode: DateMode,
  dateFrom: string,
  dateTo: string,
): T[] {
  if (mode === "today") {
    const today = new Date().toDateString();
    return entries.filter((e) => new Date(e.timestamp).toDateString() === today);
  }
  const from = dateFrom ? new Date(dateFrom).getTime() : 0;
  const to = dateTo ? new Date(dateTo + "T23:59:59.999").getTime() : Infinity;
  return entries.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return t >= from && t <= to;
  });
}

const ConsoleView: Component<{ entries: ConsoleEntry[] }> = (props) => {
  let scrollRef: HTMLDivElement | undefined;
  let autoScroll = true;

  const onScroll = () => {
    if (!scrollRef) return;
    const atBottom =
      scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight < 30;
    autoScroll = atBottom;
  };

  createEffect(() => {
    // Re-run when entries change
    void props.entries.length;
    if (autoScroll && scrollRef) {
      requestAnimationFrame(() => {
        scrollRef!.scrollTop = scrollRef!.scrollHeight;
      });
    }
  });

  return (
    <Show
      when={props.entries.length > 0}
      fallback={
        <div class="devtools-empty">
          Waiting for console output... Open a page and console output will
          appear here as the page runs.
        </div>
      }
    >
      <div class="devtools-console" ref={scrollRef} onScroll={onScroll}>
        <For each={props.entries}>
          {(entry) => (
            <div class={`console-entry level-${entry.level}`}>
              <span class={`console-level ${entry.level}`}>{entry.level}</span>
              <span class="console-time">{formatTime(entry.timestamp, { includeSeconds: true })}</span>
              <span class="console-text">{entry.text}</span>
              <span class="console-source">
                {shortenSource(entry.url, entry.line)}
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
};

const NetworkView: Component<{ entries: NetworkEntry[] }> = (props) => {
  let scrollRef: HTMLDivElement | undefined;
  let autoScroll = true;

  const onScroll = () => {
    if (!scrollRef) return;
    const atBottom =
      scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight < 30;
    autoScroll = atBottom;
  };

  createEffect(() => {
    void props.entries.length;
    if (autoScroll && scrollRef) {
      requestAnimationFrame(() => {
        scrollRef!.scrollTop = scrollRef!.scrollHeight;
      });
    }
  });

  return (
    <Show
      when={props.entries.length > 0}
      fallback={
        <div class="devtools-empty">
          Waiting for network requests... Open a page and network requests will
          appear here as the page loads.
        </div>
      }
    >
      <div class="devtools-network" ref={scrollRef} onScroll={onScroll}>
        <div class="network-header">
          <span>Method</span>
          <span>URL</span>
          <span>Status</span>
          <span>Type</span>
          <span>Time</span>
        </div>
        <For each={props.entries}>
          {(entry) => (
            <div
              class={`network-entry ${entry.error || (entry.status && entry.status >= 400) ? "error" : ""}`}
            >
              <span class="network-method">{entry.method}</span>
              <span class="network-url" title={entry.url}>
                {shortenUrl(entry.url)}
              </span>
              <span class={`network-status ${statusClass(entry.status)}`}>
                {entry.error
                  ? "ERR"
                  : entry.status != null
                    ? entry.status
                    : "..."}
              </span>
              <span class="network-type">
                {entry.resourceType || "—"}
              </span>
              <span class="network-duration">
                {entry.timing?.durationMs != null
                  ? `${entry.timing.durationMs}ms`
                  : "—"}
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
};

const ActivityView: Component<{ entries: ActivityEntry[] }> = (props) => {
  return (
    <Show
      when={props.entries.length > 0}
      fallback={
        <div class="devtools-empty">
          Waiting for agent devtools activity...
        </div>
      }
    >
      <div class="devtools-activity">
        <For each={[...props.entries].reverse()}>
          {(entry) => (
            <div class="activity-entry">
              <span class="activity-time">
                {formatTime(entry.timestamp, { includeSeconds: true })}
              </span>
              <span class="activity-tool">
                {entry.tool.replace("devtools_", "")}
              </span>
              <span class="activity-args" title={entry.args}>
                {entry.args}
              </span>
              <span class={`activity-status ${entry.status}`}>
                {entry.status === "running"
                  ? "running..."
                  : entry.status}
              </span>
              <span class="activity-duration">
                {entry.durationMs > 0 ? `${entry.durationMs}ms` : "—"}
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
};

const AgentTraceView: Component<{ entries: DevToolsAgentTraceEntry[] }> = (
  props,
) => {
  return (
    <Show
      when={props.entries.length > 0}
      fallback={
        <div class="devtools-empty">
          Waiting for agent trace events...
        </div>
      }
    >
      <div class="devtools-agent-trace">
        <For each={[...props.entries].reverse()}>
          {(entry) => (
            <div class={`trace-entry ${entry.status}`}>
              <span class="trace-time">
                {formatTime(entry.timestamp, { includeSeconds: true })}
              </span>
              <span class={`trace-kind ${entry.kind}`}>
                {entry.kind.replace("tool-", "")}
              </span>
              <span class="trace-title" title={entry.title}>
                {entry.title}
              </span>
              <span class="trace-detail" title={entry.detail}>
                {entry.detail || "—"}
              </span>
              <span class={`trace-status ${entry.status}`}>
                {entry.status}
              </span>
              <span class="trace-duration">
                {entry.durationMs != null ? `${entry.durationMs}ms` : "—"}
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
};

const PageMapView: Component<{ snapshot: DevToolsPageMapSnapshot | null }> = (
  props,
) => {
  const [query, setQuery] = createSignal("");
  const [copiedId, setCopiedId] = createSignal<number | null>(null);
  const [revealMessage, setRevealMessage] = createSignal("");
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let revealTimer: ReturnType<typeof setTimeout> | undefined;

  const pageLabel = () =>
    props.snapshot?.title || props.snapshot?.pageUrl || "Active page";

  // Filter elements by the query across label/selector/role/tag (case-insensitive).
  const filteredElements = () => {
    const snap = props.snapshot;
    if (!snap) return [];
    const q = query().trim().toLowerCase();
    if (!q) return snap.elements;
    return snap.elements.filter((el) => {
      const haystack = [
        el.label,
        el.selector,
        el.role,
        el.tag,
        el.type,
        el.href,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  };

  const flashCopied = (id: number) => {
    setCopiedId(id);
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setCopiedId(null), 1200);
  };

  const copySelector = (element: DevToolsPageMapElement) => {
    navigator.clipboard?.writeText(element.selector).catch(() => {});
    flashCopied(element.id);
  };

  // Maps the main-process reveal status to a human-facing message. Empty string
  // means success (nothing to surface). A stale "not-found" is the common case
  // worth telling the user about — the page may have changed since the snapshot.
  const REVEAL_MESSAGES: Partial<Record<DevToolsPageMapRevealStatus, string>> = {
    "not-found": "Element not found — the page may have changed since the last snapshot.",
    "invalid-selector": "Could not locate this element (invalid selector).",
    "no-active-tab": "No active tab to inspect.",
  };

  const reveal = async (selector: string) => {
    if (!selector) return;
    try {
      const status = await window.vessel.devtoolsPanel.revealElement(selector);
      const message = REVEAL_MESSAGES[status] ?? "";
      setRevealMessage(message);
      if (revealTimer) clearTimeout(revealTimer);
      revealTimer = setTimeout(() => setRevealMessage(""), 3000);
    } catch {
      setRevealMessage("Could not reach the page to reveal this element.");
      if (revealTimer) clearTimeout(revealTimer);
      revealTimer = setTimeout(() => setRevealMessage(""), 3000);
    }
  };

  const onRevealRowKeyDown = (
    event: KeyboardEvent,
    selector: string,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void reveal(selector);
  };

  onCleanup(() => {
    if (copyTimer) clearTimeout(copyTimer);
    if (revealTimer) clearTimeout(revealTimer);
  });

  return (
    <Show
      when={props.snapshot}
      fallback={<div class="devtools-empty">Inspecting active page...</div>}
    >
      {(snapshot) => (
        <div class="devtools-page-map">
          <div class="page-map-overview">
            <div class="page-map-page" title={snapshot().pageUrl}>
              <span class="page-map-title">{pageLabel()}</span>
              <span class="page-map-url">{snapshot().pageUrl || "No URL"}</span>
            </div>
            <div class="page-map-stats">
              <div class="page-map-stat">
                <span class="page-map-stat-value">
                  {snapshot().counts.total}
                </span>
                <span class="page-map-stat-label">total</span>
              </div>
              <div class="page-map-stat">
                <span class="page-map-stat-value">
                  {snapshot().counts.interactable}
                </span>
                <span class="page-map-stat-label">ready</span>
              </div>
              <div class="page-map-stat">
                <span class="page-map-stat-value">
                  {snapshot().counts.blocked}
                </span>
                <span class="page-map-stat-label">blocked</span>
              </div>
              <div class="page-map-stat">
                <span class="page-map-stat-value">
                  {snapshot().counts.disabled}
                </span>
                <span class="page-map-stat-label">disabled</span>
              </div>
            </div>
          </div>

          <Show when={snapshot().accessIssues.length > 0}>
            <div class="page-map-issues">
              <For each={snapshot().accessIssues}>
                {(issue) => <span class="page-map-issue">{issue}</span>}
              </For>
            </div>
          </Show>

          <div class="page-map-filter-row">
            <input
              class="page-map-filter"
              type="search"
              placeholder="Filter by label, selector, role…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <span class="page-map-filter-count">
              {filteredElements().length} / {snapshot().elements.length} shown
            </span>
          </div>

          <Show when={revealMessage()}>
            <div class="page-map-reveal-status">{revealMessage()}</div>
          </Show>

          <Show
            when={snapshot().elements.length > 0}
            fallback={
              <div class="devtools-empty page-map-empty">
                No interactive elements found on this page.
              </div>
            }
          >
            <div class="page-map-elements">
              <div class="page-map-header">
                <span>#</span>
                <span>Element</span>
                <span>Label</span>
                <span>Selector</span>
                <span>Status</span>
                <span>Bounds</span>
              </div>
              <For each={filteredElements()}>
                {(element) => (
                  <div
                    class="page-map-row"
                    classList={{
                      blocked: Boolean(element.issue),
                      ready: element.interactable,
                    }}
                    onClick={() => void reveal(element.selector)}
                    onKeyDown={(event) =>
                      onRevealRowKeyDown(event, element.selector)}
                    role="button"
                    tabIndex={0}
                    title="Reveal element on page"
                  >
                    <span class="page-map-index">{element.id}</span>
                    <span class="page-map-element-tag">
                      {element.tag}
                      {element.role ? ` [${element.role}]` : ""}
                    </span>
                    <span class="page-map-element-label" title={element.label}>
                      {element.label}
                      <Show when={element.type || element.href}>
                        <span class="page-map-element-sub">
                          {element.type ? `type=${element.type}` : ""}
                          {element.href ? ` → ${element.href}` : ""}
                        </span>
                      </Show>
                    </span>
                    <span class="page-map-element-selector">
                      <span class="page-map-selector-text" title={element.selector}>
                        {element.selector}
                      </span>
                      <button
                        class="page-map-copy-btn"
                        classList={{ copied: copiedId() === element.id }}
                        title="Copy selector"
                        aria-label="Copy selector"
                        onClick={(e) => {
                          e.stopPropagation();
                          copySelector(element);
                        }}
                      >
                        <Show
                          when={copiedId() === element.id}
                          fallback={<Copy size={12} aria-hidden="true" />}
                        >
                          <Check size={12} aria-hidden="true" />
                        </Show>
                      </button>
                    </span>
                    <span
                      class={`page-map-element-state ${
                        element.interactable ? "ready" : "blocked"
                      }`}
                      title={element.issue}
                    >
                      {element.interactable
                        ? "ready"
                        : element.issue || (element.disabled ? "disabled" : "not ready")}
                    </span>
                    <span class="page-map-element-bounds">
                      {Math.round(element.bounds.x)},{Math.round(element.bounds.y)}{" "}
                      •{" "}
                      {Math.round(element.bounds.width)}x
                      {Math.round(element.bounds.height)}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
};

const DevToolsPanel: Component = () => {
  const [activeTab, setActiveTab] = createSignal<PanelTab>("console");
  const {
    hostState,
    isResizing,
    close,
    togglePlacement,
    startResize,
    applyHostState,
  } = useDevToolsPanelHost();
  const [state, setState] = createSignal<PanelState>({
    console: [],
    network: [],
    errors: [],
    activity: [],
    agentTrace: [],
    pageMap: null,
  });

  // Export state
  const [showExport, setShowExport] = createSignal(false);
  const [exportConsole, setExportConsole] = createSignal(true);
  const [exportNetwork, setExportNetwork] = createSignal(true);
  const [exportActivity, setExportActivity] = createSignal(true);
  const [exportTrace, setExportTrace] = createSignal(true);
  const [exportPageMap, setExportPageMap] = createSignal(true);
  const [dateMode, setDateMode] = createSignal<DateMode>("today");
  const [dateFrom, setDateFrom] = createSignal(todayDateString());
  const [dateTo, setDateTo] = createSignal(todayDateString());

  let exportBtnRef: HTMLButtonElement | undefined;
  let exportDropdownRef: HTMLDivElement | undefined;

  onMount(() => {
    void window.vessel.devtoolsPanel
      .getState()
      .then(setState)
      .catch(() => undefined);
  });

  createEffect(() => {
    const cleanup = window.vessel.devtoolsPanel.onStateUpdate(
      (newState: PanelState) => {
        setState(newState);
      },
    );
    onCleanup(cleanup);
  });

  createEffect(() => {
    const cleanup =
      window.vessel.devtoolsPanel.onHostStateUpdate(applyHostState);
    onCleanup(cleanup);
  });

  createEffect(() => {
    const cleanup = window.vessel.devtoolsPanel.onSelectTab(setActiveTab);
    onCleanup(cleanup);
  });

  // Close export dropdown on outside click
  createEffect(() => {
    if (!showExport()) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        exportDropdownRef &&
        !exportDropdownRef.contains(target) &&
        exportBtnRef &&
        !exportBtnRef.contains(target)
      ) {
        setShowExport(false);
      }
    };
    document.addEventListener("mousedown", handler);
    onCleanup(() => document.removeEventListener("mousedown", handler));
  });

  const errorCount = () => state().errors.length;
  const networkCount = () => state().network.length;
  const activityRunning = () =>
    state().activity.filter((a) => a.status === "running").length;
  const traceRunning = () =>
    state().agentTrace.filter((entry) => entry.status === "running").length;
  const pageMapCount = () => state().pageMap?.counts.interactable ?? 0;

  const handleExport = () => {
    const mode = dateMode();
    const from = dateFrom();
    const to = dateTo();

    const data: Record<string, unknown> = {
      exportedAt: new Date().toISOString(),
      dateRange:
        mode === "today"
          ? "today"
          : { from, to },
    };

    if (exportConsole()) {
      data.console = filterByDate(state().console, mode, from, to);
    }
    if (exportNetwork()) {
      data.network = filterByDate(state().network, mode, from, to);
    }
    if (exportActivity()) {
      data.activity = filterByDate(state().activity, mode, from, to);
    }
    if (exportTrace()) {
      data.agentTrace = filterByDate(state().agentTrace, mode, from, to);
    }
    if (exportPageMap()) {
      data.pageMap = state().pageMap;
    }

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date().toISOString().split("T")[0];
    anchor.href = url;
    anchor.download = `vessel-devtools-${date}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setShowExport(false);
  };

  const noneSelected = () =>
    !exportConsole() &&
    !exportNetwork() &&
    !exportActivity() &&
    !exportTrace() &&
    !exportPageMap();

  return (
    <div
      class="devtools-panel"
      classList={{ "tracking-resize": isResizing() }}
      style={{ "--devtools-panel-height": `${hostState().height}px` }}
    >
      <Show when={!hostState().detached}>
        <div
          class="devtools-resize-handle"
          classList={{ resizing: isResizing() }}
          onPointerDown={startResize}
          title="Resize DevTools"
        />
      </Show>
      <div class="devtools-tabs">
        <button
          class={`devtools-tab ${activeTab() === "console" ? "active" : ""}`}
          onClick={() => setActiveTab("console")}
        >
          Console
          <Show when={errorCount() > 0}>
            <span class="devtools-tab-badge error">{errorCount()}</span>
          </Show>
        </button>
        <button
          class={`devtools-tab ${activeTab() === "network" ? "active" : ""}`}
          onClick={() => setActiveTab("network")}
        >
          Network
          <Show when={networkCount() > 0}>
            <span class="devtools-tab-badge count">{networkCount()}</span>
          </Show>
        </button>
        <button
          class={`devtools-tab ${activeTab() === "activity" ? "active" : ""}`}
          onClick={() => setActiveTab("activity")}
        >
          Activity
          <Show when={activityRunning() > 0}>
            <span class="devtools-tab-badge count">{activityRunning()}</span>
          </Show>
        </button>
        <button
          class={`devtools-tab ${activeTab() === "agentTrace" ? "active" : ""}`}
          onClick={() => setActiveTab("agentTrace")}
        >
          Agent Trace
          <Show when={traceRunning() > 0}>
            <span class="devtools-tab-badge count">{traceRunning()}</span>
          </Show>
        </button>
        <button
          class={`devtools-tab ${activeTab() === "pageMap" ? "active" : ""}`}
          onClick={() => setActiveTab("pageMap")}
        >
          Page Map
          <Show when={pageMapCount() > 0}>
            <span class="devtools-tab-badge count">{pageMapCount()}</span>
          </Show>
        </button>
        <div class="devtools-tab-spacer" />
        <div class="devtools-export-wrap">
          <button
            ref={exportBtnRef}
            class={`devtools-close-btn ${showExport() ? "active" : ""}`}
            onClick={() => setShowExport((v) => !v)}
            title="Export Logs"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style="vertical-align: middle;">
              <path d="M6.5 1v7M3.5 5l3 3 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M1 9.5v1A1.5 1.5 0 0 0 2.5 12h8A1.5 1.5 0 0 0 12 10.5v-1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
            </svg>
          </button>
          <Show when={showExport()}>
            <div class="devtools-export-dropdown" ref={exportDropdownRef}>
              <div class="export-section">
                <div class="export-section-label">Log Types</div>
                <label class="export-checkbox">
                  <input
                    type="checkbox"
                    checked={exportConsole()}
                    onChange={(e) => setExportConsole(e.currentTarget.checked)}
                  />
                  Console
                </label>
                <label class="export-checkbox">
                  <input
                    type="checkbox"
                    checked={exportNetwork()}
                    onChange={(e) => setExportNetwork(e.currentTarget.checked)}
                  />
                  Network
                </label>
                <label class="export-checkbox">
                  <input
                    type="checkbox"
                    checked={exportActivity()}
                    onChange={(e) => setExportActivity(e.currentTarget.checked)}
                  />
                  Activity
                </label>
                <label class="export-checkbox">
                  <input
                    type="checkbox"
                    checked={exportTrace()}
                    onChange={(e) => setExportTrace(e.currentTarget.checked)}
                  />
                  Trace
                </label>
                <label class="export-checkbox">
                  <input
                    type="checkbox"
                    checked={exportPageMap()}
                    onChange={(e) => setExportPageMap(e.currentTarget.checked)}
                  />
                  Page Map
                </label>
              </div>
              <div class="export-section">
                <div class="export-section-label">Date Range</div>
                <div class="export-date-btns">
                  <button
                    class={`export-date-btn ${dateMode() === "today" ? "active" : ""}`}
                    onClick={() => setDateMode("today")}
                  >
                    Today
                  </button>
                  <button
                    class={`export-date-btn ${dateMode() === "custom" ? "active" : ""}`}
                    onClick={() => setDateMode("custom")}
                  >
                    Custom
                  </button>
                </div>
                <Show when={dateMode() === "custom"}>
                  <div class="export-date-inputs">
                    <div class="export-date-row">
                      <span class="export-date-label">From</span>
                      <input
                        class="export-date-input"
                        type="date"
                        value={dateFrom()}
                        onInput={(e) => setDateFrom(e.currentTarget.value)}
                      />
                    </div>
                    <div class="export-date-row">
                      <span class="export-date-label">To</span>
                      <input
                        class="export-date-input"
                        type="date"
                        value={dateTo()}
                        onInput={(e) => setDateTo(e.currentTarget.value)}
                      />
                    </div>
                  </div>
                </Show>
              </div>
              <button
                class="export-submit"
                onClick={handleExport}
                disabled={noneSelected()}
              >
                Export JSON
              </button>
            </div>
          </Show>
        </div>
        <button
          class="devtools-close-btn"
          onClick={togglePlacement}
          title={hostState().detached ? "Dock DevTools" : "Pop out DevTools"}
          aria-label={hostState().detached ? "Dock DevTools" : "Pop out DevTools"}
        >
          <Show
            when={hostState().detached}
            fallback={<ExternalLink size={14} aria-hidden="true" />}
          >
            <PanelBottomOpen size={14} aria-hidden="true" />
          </Show>
        </button>
        <Show when={!hostState().detached}>
          <button
            class="devtools-close-btn"
            onClick={close}
            title="Close DevTools"
          >
            ×
          </button>
        </Show>
      </div>
      <div class="devtools-content">
        <Show when={activeTab() === "console"}>
          <ConsoleView entries={state().console} />
        </Show>
        <Show when={activeTab() === "network"}>
          <NetworkView entries={state().network} />
        </Show>
        <Show when={activeTab() === "activity"}>
          <ActivityView entries={state().activity} />
        </Show>
        <Show when={activeTab() === "agentTrace"}>
          <AgentTraceView entries={state().agentTrace} />
        </Show>
        <Show when={activeTab() === "pageMap"}>
          <PageMapView snapshot={state().pageMap} />
        </Show>
      </div>
    </div>
  );
};

export default DevToolsPanel;
