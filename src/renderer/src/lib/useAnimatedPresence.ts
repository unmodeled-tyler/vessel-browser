import { createSignal, createEffect, onCleanup } from "solid-js";

export function useAnimatedPresence(
  isOpen: () => boolean,
  exitDurationMs: number,
) {
  const [visible, setVisible] = createSignal(false);
  const [closing, setClosing] = createSignal(false);
  let exitTimer: number | undefined;

  createEffect(() => {
    const open = isOpen();
    if (open) {
      if (exitTimer) {
        clearTimeout(exitTimer);
        exitTimer = undefined;
      }
      setClosing(false);
      setVisible(true);
    } else if (visible()) {
      setClosing(true);
      exitTimer = window.setTimeout(() => {
        setVisible(false);
        setClosing(false);
        exitTimer = undefined;
      }, exitDurationMs);
    }
  });

  onCleanup(() => {
    if (exitTimer) clearTimeout(exitTimer);
  });

  return { visible, closing };
}
