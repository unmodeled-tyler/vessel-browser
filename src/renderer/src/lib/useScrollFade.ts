import { onCleanup } from "solid-js";

/**
 * Adds `scroll-fade`, `fade-top`, and `fade-bottom` classes to a scrollable
 * container based on its scroll position. Pair with the `.scroll-fade` CSS
 * in global.css.
 */
export function useScrollFade(el: HTMLElement): void {
  let frameId: number | undefined;
  let hasTopFade: boolean | undefined;
  let hasBottomFade: boolean | undefined;

  const update = () => {
    frameId = undefined;

    const { scrollTop, scrollHeight, clientHeight } = el;
    const atTop = scrollTop <= 2;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 2;
    const nextTopFade = !atTop;
    const nextBottomFade = !atBottom;

    if (hasTopFade !== nextTopFade) {
      hasTopFade = nextTopFade;
      el.classList.toggle("fade-top", nextTopFade);
    }

    if (hasBottomFade !== nextBottomFade) {
      hasBottomFade = nextBottomFade;
      el.classList.toggle("fade-bottom", nextBottomFade);
    }
  };

  const scheduleUpdate = () => {
    if (frameId !== undefined) return;
    frameId = requestAnimationFrame(update);
  };

  el.classList.add("scroll-fade");
  el.addEventListener("scroll", scheduleUpdate, { passive: true });

  // Initial check after content renders
  queueMicrotask(scheduleUpdate);

  // Re-check when children change
  const observer = new MutationObserver(scheduleUpdate);
  observer.observe(el, { childList: true, subtree: true });

  onCleanup(() => {
    el.removeEventListener("scroll", scheduleUpdate);
    if (frameId !== undefined) {
      cancelAnimationFrame(frameId);
    }
    observer.disconnect();
  });
}
