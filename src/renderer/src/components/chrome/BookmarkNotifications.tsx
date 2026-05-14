import {
  For,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import type { AgentActionEntry } from "../../../../shared/types";
import { useRuntime } from "../../stores/runtime";
import "./chrome.css";

interface ToastItem {
  id: string;
  title: string;
  message: string;
  leaving: boolean;
}

const TOAST_DURATION_MS = 4200;
const TOAST_EXIT_MS = 300;

function isBookmarkToastCandidate(action: AgentActionEntry): boolean {
  return (
    (action.source === "ai" || action.source === "mcp") &&
    action.status === "completed" &&
    (action.name === "create_bookmark_folder" || action.name === "save_bookmark")
  );
}

const BookmarkNotifications: Component = () => {
  const { runtimeState } = useRuntime();
  const [toasts, setToasts] = createSignal<ToastItem[]>([]);
  const notifiedActionIds = new Set<string>();
  let seeded = false;
  const timeoutIds = new Map<string, number>();

  const dismissToast = (toastId: string) => {
    const timeoutId = timeoutIds.get(toastId);
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      timeoutIds.delete(toastId);
    }

    // Mark as leaving to trigger exit animation
    setToasts((current) =>
      current.map((t) => (t.id === toastId ? { ...t, leaving: true } : t)),
    );

    // Remove after exit animation completes
    window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== toastId));
    }, TOAST_EXIT_MS);
  };

  createEffect(() => {
    const actions = runtimeState().actions;

    if (!seeded) {
      for (const action of actions) {
        notifiedActionIds.add(action.id);
      }
      seeded = true;
      return;
    }

    for (const action of actions) {
      if (notifiedActionIds.has(action.id)) continue;
      if (!isBookmarkToastCandidate(action)) continue;

      notifiedActionIds.add(action.id);
      const title =
        action.name === "create_bookmark_folder"
          ? "Folder created"
          : "Bookmark saved";
      const toast: ToastItem = {
        id: action.id,
        title,
        message: action.resultSummary || action.argsSummary,
        leaving: false,
      };

      setToasts((current) => [...current.slice(-2), toast]);
      const timeoutId = window.setTimeout(
        () => dismissToast(toast.id),
        TOAST_DURATION_MS,
      );
      timeoutIds.set(toast.id, timeoutId);
    }
  });

  onCleanup(() => {
    for (const timeoutId of timeoutIds.values()) {
      window.clearTimeout(timeoutId);
    }
    timeoutIds.clear();
  });

  return (
    <div class="bookmark-toast-stack" aria-live="polite" aria-atomic="true">
      <For each={toasts()}>
        {(toast) => (
          <div
            class="bookmark-toast"
            classList={{ "bookmark-toast-leaving": toast.leaving }}
            role="status"
          >
            <div class="bookmark-toast-header">
              <div class="bookmark-toast-title">{toast.title}</div>
              <button
                type="button"
                class="bookmark-toast-close"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(toast.id)}
              >
                ×
              </button>
            </div>
            <div class="bookmark-toast-message">{toast.message}</div>
          </div>
        )}
      </For>
    </div>
  );
};

export default BookmarkNotifications;
