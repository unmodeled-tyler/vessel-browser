import {
  createSignal,
  createEffect,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import "./chrome.css";

interface FindResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

const FindBar: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [result, setResult] = createSignal<FindResult | null>(null);

  let inputRef: HTMLInputElement | undefined;

  const startFind = (text: string) => {
    if (!text) {
      window.vessel.find.stop();
      setResult(null);
      return;
    }
    window.vessel.find.start(text, { forward: true });
  };

  const findNext = (forward = true) => {
    const q = query();
    if (!q) return;
    window.vessel.find.next(forward);
  };

  const close = () => {
    setOpen(false);
    setQuery("");
    setResult(null);
    window.vessel.find.stop();
  };

  onMount(() => {
    const cleanupResult = window.vessel.find.onResult((r) => {
      if (r.finalUpdate) {
        setResult(r);
      }
    });

    const listener = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl+F — open find bar
      if (ctrl && e.key === "f") {
        e.preventDefault();
        if (!open()) {
          setOpen(true);
          // Focus input on next tick so it's rendered
          setTimeout(() => inputRef?.focus(), 0);
        } else {
          inputRef?.focus();
          inputRef?.select();
        }
        return;
      }

      if (!open()) return;

      // Escape — close find bar
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }

      // Enter — find next
      if (e.key === "Enter") {
        e.preventDefault();
        findNext(!e.shiftKey);
        return;
      }
    };

    document.addEventListener("keydown", listener);
    onCleanup(() => {
      document.removeEventListener("keydown", listener);
      cleanupResult();
    });
  });

  createEffect(() => {
    if (open() && inputRef) {
      inputRef.focus();
    }
  });

  const handleInput = (value: string) => {
    setQuery(value);
    startFind(value);
  };

  return (
    <Show when={open()}>
      <div class="find-bar">
        <input
          ref={inputRef}
          class="find-bar-input"
          type="text"
          value={query()}
          onInput={(e) => handleInput(e.currentTarget.value)}
          placeholder="Find in page..."
          spellcheck={false}
        />
        <Show when={result()}>
          {(r) => (
            <span class="find-bar-count">
              {r().matches > 0
                ? `${r().activeMatchOrdinal} / ${r().matches}`
                : "No results"}
            </span>
          )}
        </Show>
        <button
          class="find-bar-btn"
          title="Previous (Shift+Enter)"
          onClick={() => findNext(false)}
        >
          &#9650;
        </button>
        <button
          class="find-bar-btn"
          title="Next (Enter)"
          onClick={() => findNext(true)}
        >
          &#9660;
        </button>
        <button
          class="find-bar-btn find-bar-close"
          title="Close (Escape)"
          onClick={close}
        >
          &times;
        </button>
      </div>
    </Show>
  );
};

export default FindBar;
