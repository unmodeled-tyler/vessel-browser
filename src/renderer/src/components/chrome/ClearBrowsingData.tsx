import { createSignal, Show, type Component } from "solid-js";
import { Check, X } from "lucide-solid";
import type { ClearDataTimeRange } from "../../../../shared/types";
import "./chrome.css";

const TIME_RANGES: { value: ClearDataTimeRange; label: string }[] = [
  { value: "hour", label: "Last hour" },
  { value: "day", label: "Last 24 hours" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

const ClearBrowsingData: Component<{
  open: boolean;
  onClose: () => void;
}> = (props) => {
  const [cache, setCache] = createSignal(true);
  const [cookies, setCookies] = createSignal(false);
  const [history, setHistory] = createSignal(true);
  const [localStorage, setLocalStorage] = createSignal(false);
  const [timeRange, setTimeRange] = createSignal<ClearDataTimeRange>("all");
  const [clearing, setClearing] = createSignal(false);
  const [done, setDone] = createSignal(false);
  const [error, setError] = createSignal("");

  const handleClear = async () => {
    setClearing(true);
    setError("");
    try {
      await window.vessel.browsingData.clear({
        cache: cache(),
        cookies: cookies(),
        history: history(),
        localStorage: localStorage(),
        timeRange: timeRange(),
      });
      setDone(true);
      setTimeout(() => {
        props.onClose();
        setDone(false);
      }, 1500);
    } catch {
      setError("Could not clear browsing data.");
    } finally {
      setClearing(false);
    }
  };

  const reset = () => {
    setCache(true);
    setCookies(false);
    setHistory(true);
    setLocalStorage(false);
    setTimeRange("all");
    setDone(false);
    setError("");
  };

  return (
    <Show when={props.open}>
      <div class="clear-data-overlay" onClick={props.onClose}>
        <div class="clear-data-dialog" onClick={(e) => e.stopPropagation()}>
          <Show
            when={!done()}
            fallback={
              <div class="clear-data-done">
                <Check size={20} stroke-width={2.5} />
                <span>Browsing data cleared</span>
              </div>
            }
          >
            <div class="clear-data-header">
              <h3>Clear browsing data</h3>
              <button
                class="clear-data-close"
                onClick={() => {
                  reset();
                  props.onClose();
                }}
              >
                <X size={14} />
              </button>
            </div>

            <div class="clear-data-range">
              <label>Time range</label>
              <select
                value={timeRange()}
                onChange={(e) =>
                  setTimeRange(e.currentTarget.value as ClearDataTimeRange)
                }
                class="clear-data-select"
              >
                {TIME_RANGES.map((r) => (
                  <option value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>

            <div class="clear-data-checks">
              <label class="clear-data-check">
                <input
                  type="checkbox"
                  checked={cache()}
                  onChange={(e) => setCache(e.currentTarget.checked)}
                />
                <span>Cached images and files</span>
              </label>
              <label class="clear-data-check">
                <input
                  type="checkbox"
                  checked={cookies()}
                  onChange={(e) => setCookies(e.currentTarget.checked)}
                />
                <span>Cookies and other site data</span>
              </label>
              <label class="clear-data-check">
                <input
                  type="checkbox"
                  checked={history()}
                  onChange={(e) => setHistory(e.currentTarget.checked)}
                />
                <span>Browsing history</span>
              </label>
              <label class="clear-data-check">
                <input
                  type="checkbox"
                  checked={localStorage()}
                  onChange={(e) => setLocalStorage(e.currentTarget.checked)}
                />
                <span>Local storage</span>
              </label>
            </div>

            <Show when={error()}>
              <div class="clear-data-error">{error()}</div>
            </Show>

            <div class="clear-data-actions">
              <button
                class="clear-data-cancel"
                onClick={() => {
                  reset();
                  props.onClose();
                }}
              >
                Cancel
              </button>
              <button
                class="clear-data-confirm"
                disabled={
                  clearing() ||
                  (!cache() && !cookies() && !history() && !localStorage())
                }
                onClick={handleClear}
              >
                {clearing() ? "Clearing..." : "Clear data"}
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default ClearBrowsingData;
