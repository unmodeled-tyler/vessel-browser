import { createSignal, onMount, type Accessor } from "solid-js";
import type { DevToolsPanelHostState } from "../../../../shared/devtools-types";

type DevToolsPanelHostControls = {
  hostState: Accessor<DevToolsPanelHostState>;
  isResizing: Accessor<boolean>;
  close: () => void;
  togglePlacement: () => void;
  startResize: (event: PointerEvent) => void;
  applyHostState: (state: DevToolsPanelHostState) => void;
};

export function useDevToolsPanelHost(): DevToolsPanelHostControls {
  const [hostState, setHostState] = createSignal<DevToolsPanelHostState>({
    open: true,
    detached: false,
    height: 250,
  });
  const [isResizing, setIsResizing] = createSignal(false);

  const applyHostState = (nextState: DevToolsPanelHostState) => {
    setHostState(nextState);
  };

  onMount(() => {
    void window.vessel.devtoolsPanel
      .getHostState()
      .then(applyHostState)
      .catch(() => {
        /* keep the default docked host state during early bootstrap */
      });
  });

  const close = () => {
    void window.vessel.devtoolsPanel.close().then(applyHostState);
  };

  const togglePlacement = () => {
    const action = hostState().detached
      ? window.vessel.devtoolsPanel.dock()
      : window.vessel.devtoolsPanel.popOut();
    void action.then(applyHostState);
  };

  const startResize = (event: PointerEvent) => {
    if (hostState().detached) return;
    event.preventDefault();

    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    setIsResizing(true);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    void window.vessel.devtoolsPanel.startResize().catch(() => {
      /* ignore IPC failures during drag start */
    });

    const startY = event.screenY;
    const startHeight = window.innerHeight;
    const dragState = { currentY: startY, rafId: null as number | null };

    const resizeToCurrentPointer = () => {
      dragState.rafId = null;
      const nextHeight = startHeight + startY - dragState.currentY;
      void window.vessel.devtoolsPanel
        .resize(nextHeight)
        .then((height) => {
          setHostState((current) => ({ ...current, height }));
        })
        .catch(() => {
          /* ignore transient resize IPC failures during drag */
        });
    };

    const commitResize = () => {
      void window.vessel.devtoolsPanel.commitResize().catch(() => {
        /* ignore commit failures during drag cleanup */
      });
    };

    const clearPointerTracking = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onWindowBlur);
      target.removeEventListener("lostpointercapture", onPointerUp);
      if (target.hasPointerCapture?.(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
      if (dragState.rafId !== null) {
        cancelAnimationFrame(dragState.rafId);
        dragState.rafId = null;
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsResizing(false);
      commitResize();
    };

    const scheduleResize = () => {
      if (dragState.rafId !== null) return;
      dragState.rafId = requestAnimationFrame(resizeToCurrentPointer);
    };

    function onPointerMove(pointerEvent: PointerEvent) {
      dragState.currentY = pointerEvent.screenY;
      scheduleResize();
    }

    function onPointerUp(pointerEvent: PointerEvent) {
      dragState.currentY = pointerEvent.screenY;
      if (dragState.rafId !== null) {
        cancelAnimationFrame(dragState.rafId);
        dragState.rafId = null;
      }
      resizeToCurrentPointer();
      clearPointerTracking();
    }

    function onWindowBlur() {
      if (dragState.rafId !== null) {
        cancelAnimationFrame(dragState.rafId);
        dragState.rafId = null;
      }
      resizeToCurrentPointer();
      clearPointerTracking();
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onWindowBlur);
    target.addEventListener("lostpointercapture", onPointerUp);
  };

  return {
    hostState,
    isResizing,
    close,
    togglePlacement,
    startResize,
    applyHostState,
  };
}
