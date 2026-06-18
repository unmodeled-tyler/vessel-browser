import {
  BaseWindow,
  type BaseWindowConstructorOptions,
  type Event as ElectronEvent,
  type WebContentsView,
} from "electron";

export type DetachedViewHostState = {
  mainWindow: BaseWindow;
};

type DetachedViewHostAccess<TState extends DetachedViewHostState> = {
  getWindow: (state: TState) => BaseWindow | null;
  setWindow: (state: TState, window: BaseWindow | null) => void;
  isClosing: (state: TState) => boolean;
  setClosing: (state: TState, closing: boolean) => void;
  getView: (state: TState) => WebContentsView;
};

type DetachedViewHostOptions<TState extends DetachedViewHostState> =
  DetachedViewHostAccess<TState> & {
    createWindowOptions: (state: TState) => BaseWindowConstructorOptions;
    layoutView: (state: TState) => void;
    persistBounds: (state: TState) => void;
    onNativeClose: (state: TState) => void;
    onUnexpectedClosed: (state: TState, window: BaseWindow) => void;
  };

export function closeDetachedViewWindow<TState extends DetachedViewHostState>(
  state: TState,
  host: DetachedViewHostAccess<TState>,
): boolean {
  const detachedWindow = host.getWindow(state);
  if (!detachedWindow) return false;

  host.setWindow(state, null);
  host.setClosing(state, true);
  detachedWindow.once("closed", () => {
    host.setClosing(state, false);
  });
  detachedWindow.close();
  return true;
}

export function moveDetachedViewToMainWindow<
  TState extends DetachedViewHostState,
>(state: TState, host: DetachedViewHostAccess<TState>): void {
  const view = host.getView(state);
  host.getWindow(state)?.contentView.removeChildView(view);
  state.mainWindow.contentView.addChildView(view);
}

export function createDetachedViewWindow<
  TState extends DetachedViewHostState,
>(state: TState, host: DetachedViewHostOptions<TState>): BaseWindow {
  const detachedWindow = new BaseWindow(host.createWindowOptions(state));
  const view = host.getView(state);

  state.mainWindow.contentView.removeChildView(view);
  detachedWindow.contentView.addChildView(view);
  host.setWindow(state, detachedWindow);

  detachedWindow.on("resize", () => {
    host.layoutView(state);
    host.persistBounds(state);
  });
  detachedWindow.on("move", () => host.persistBounds(state));
  detachedWindow.on("close", (event: ElectronEvent) => {
    if (host.isClosing(state)) return;
    event.preventDefault();
    host.onNativeClose(state);
  });
  detachedWindow.on("closed", () => {
    if (host.getWindow(state) !== detachedWindow) return;
    host.onUnexpectedClosed(state, detachedWindow);
  });

  return detachedWindow;
}
