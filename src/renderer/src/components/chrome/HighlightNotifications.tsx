import { createEffect, createSignal, onCleanup, Show, type Component } from "solid-js";
import "./chrome.css";

interface Props {
  toast: { title: string; message: string } | null;
  onDismiss: () => void;
}

const TOAST_DURATION_MS = 3000;
const TOAST_EXIT_MS = 300;

const HighlightNotifications: Component<Props> = (props) => {
  const [visible, setVisible] = createSignal(false);
  const [leaving, setLeaving] = createSignal(false);
  const [current, setCurrent] = createSignal<{ title: string; message: string } | null>(null);
  let dismissTimer: number | undefined;
  let exitTimer: number | undefined;

  const dismiss = () => {
    if (dismissTimer) window.clearTimeout(dismissTimer);
    setLeaving(true);
    exitTimer = window.setTimeout(() => {
      setVisible(false);
      setLeaving(false);
      setCurrent(null);
      props.onDismiss();
    }, TOAST_EXIT_MS);
  };

  createEffect(() => {
    const toast = props.toast;
    if (toast) {
      if (dismissTimer) window.clearTimeout(dismissTimer);
      if (exitTimer) window.clearTimeout(exitTimer);
      setCurrent(toast);
      setLeaving(false);
      setVisible(true);
      dismissTimer = window.setTimeout(dismiss, TOAST_DURATION_MS);
    }
  });

  onCleanup(() => {
    if (dismissTimer) window.clearTimeout(dismissTimer);
    if (exitTimer) window.clearTimeout(exitTimer);
  });

  return (
    <Show when={visible() && current()}>
      <div class="bookmark-toast-stack" aria-live="polite">
        <div
          class="bookmark-toast highlight-toast"
          classList={{ "bookmark-toast-leaving": leaving() }}
          role="status"
        >
          <div class="bookmark-toast-title">{current()!.title}</div>
          <div class="bookmark-toast-message">{current()!.message}</div>
        </div>
      </div>
    </Show>
  );
};

export default HighlightNotifications;
