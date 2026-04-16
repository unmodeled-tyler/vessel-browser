import type { WebContents } from "electron";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitForLoad(
  wc: WebContents,
  timeout = 5000,
): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;

    const cleanup = () => {
      wc.removeListener("did-finish-load", onLoadEvent);
      wc.removeListener("did-stop-loading", onLoadEvent);
      wc.removeListener("did-fail-load", onLoadEvent);
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      resolve();
    };

    const onLoadEvent = () => {
      const loading = wc.isLoading();
      if (!loading) {
        finish();
      }
    };

    const timer = setTimeout(() => finish(), timeout);

    if (!wc.isLoading()) {
      finish();
      return;
    }

    wc.once("did-finish-load", onLoadEvent);
    wc.once("did-stop-loading", onLoadEvent);
    wc.once("did-fail-load", onLoadEvent);
  });
}

export const QUIET_NAVIGATION_WINDOW_MS = 1200;

export function waitForPotentialNavigation(
  wc: WebContents,
  beforeUrl: string,
  timeout = 4000,
  quietWindowMs?: number,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let waitingForLoad = false;
    const beforeTitle = wc.getTitle();
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poller);
      wc.removeListener("did-start-loading", onStart);
      wc.removeListener("did-navigate", onNavigate);
      wc.removeListener("did-navigate-in-page", onNavigateInPage);
      wc.removeListener("did-stop-loading", onNativeChange);
      wc.removeListener("page-title-updated", onNativeChange);
      resolve();
    };
    const finishAfterLoad = () => {
      if (waitingForLoad) return;
      waitingForLoad = true;
      void waitForLoad(wc, timeout).then(finish);
    };
    const onNativeChange = () => {
      if (wc.isLoading()) {
        finishAfterLoad();
        return;
      }
      if (wc.getURL() !== beforeUrl || wc.getTitle() !== beforeTitle) {
        finish();
      }
    };
    const onStart = () => {
      finishAfterLoad();
    };
    const onNavigate = () => {
      finishAfterLoad();
    };
    const onNavigateInPage = () => finish();
    const timer = setTimeout(
      finish,
      quietWindowMs != null ? Math.min(timeout, quietWindowMs) : timeout,
    );
    const poller = setInterval(onNativeChange, 100);

    if (
      wc.getURL() !== beforeUrl ||
      wc.getTitle() !== beforeTitle ||
      wc.isLoading()
    ) {
      onNativeChange();
      return;
    }

    wc.once("did-start-loading", onStart);
    wc.once("did-navigate", onNavigate);
    wc.once("did-navigate-in-page", onNavigateInPage);
    wc.once("did-stop-loading", onNativeChange);
    wc.once("page-title-updated", onNativeChange);
  });
}
