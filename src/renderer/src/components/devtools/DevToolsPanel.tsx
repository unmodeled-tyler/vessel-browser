import {
  createSignal,
  createEffect,
  onCleanup,
  For,
  Show,
  type Component,
} from "solid-js";
import "./devtools.css";

interface ConsoleEntry {
  id: number;
  timestamp: string;
  level: string;
  text: string;
  url?: string;
  line?: number;
}

interface NetworkEntry {
  id: number;
  requestId: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  timing?: { durationMs?: number };
  error?: string;
}

interface ErrorEntry {
  id: number;
  timestamp: string;
  type: string;
  message: string;
  description?: string;
}

interface ActivityEntry {
  id: number;
  timestamp: string;
  tool: string;
  args: string;
  result: string;
  durationMs: number;
  status: "running" | "completed" | "failed";
}

interface PanelState {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  errors: ErrorEntry[];
  activity: ActivityEntry[];
}

type PanelTab = "console" | "network" | "activity";
type DateMode = "today" | "custom";

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

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
    props.entries.length;
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
          Waiting for console output... Console monitoring activates when an
          agent uses devtools.
        </div>
      }
    >
      <div class="devtools-console" ref={scrollRef} onScroll={onScroll}>
        <For each={props.entries}>
          {(entry) => (
            <div class={`console-entry level-${entry.level}`}>
              <span class={`console-level ${entry.level}`}>{entry.level}</span>
              <span class="console-time">{formatTime(entry.timestamp)}</span>
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
    props.entries.length;
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
          Waiting for network requests... Network monitoring activates when an
          agent uses devtools.
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
  let scrollRef: HTMLDivElement | undefined;
  let autoScroll = true;

  const onScroll = () => {
    if (!scrollRef) return;
    const atBottom =
      scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight < 30;
    autoScroll = atBottom;
  };

  createEffect(() => {
    props.entries.length;
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
          Waiting for agent devtools activity...
        </div>
      }
    >
      <div class="devtools-activity" ref={scrollRef} onScroll={onScroll}>
        <For each={props.entries}>
          {(entry) => (
            <div class="activity-entry">
              <span class="activity-time">
                {formatTime(entry.timestamp)}
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

const DevToolsPanel: Component = () => {
  const [activeTab, setActiveTab] = createSignal<PanelTab>("console");
  const [state, setState] = createSignal<PanelState>({
    console: [],
    network: [],
    errors: [],
    activity: [],
  });

  // Export state
  const [showExport, setShowExport] = createSignal(false);
  const [exportConsole, setExportConsole] = createSignal(true);
  const [exportNetwork, setExportNetwork] = createSignal(true);
  const [exportActivity, setExportActivity] = createSignal(true);
  const [dateMode, setDateMode] = createSignal<DateMode>("today");
  const [dateFrom, setDateFrom] = createSignal(todayDateString());
  const [dateTo, setDateTo] = createSignal(todayDateString());

  let exportBtnRef: HTMLButtonElement | undefined;
  let exportDropdownRef: HTMLDivElement | undefined;

  createEffect(() => {
    const cleanup = window.vessel.devtoolsPanel.onStateUpdate(
      (newState: PanelState) => {
        setState(newState);
      },
    );
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

  const close = () => {
    window.vessel.devtoolsPanel.toggle();
  };

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
    !exportConsole() && !exportNetwork() && !exportActivity();

  return (
    <div class="devtools-panel">
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
        <button class="devtools-close-btn" onClick={close} title="Close DevTools">
          ×
        </button>
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
      </div>
    </div>
  );
};

export default DevToolsPanel;
