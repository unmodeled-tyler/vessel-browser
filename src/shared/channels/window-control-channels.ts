export const WindowControlChannels = {
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_MAXIMIZE: "window:maximize",
  WINDOW_CLOSE: "window:close",
  OPEN_NEW_WINDOW: "window:open-new",
  OPEN_PRIVATE_WINDOW: "private:open-window",
  IS_PRIVATE_MODE: "private:is-private",
  FIND_IN_PAGE_START: "find:start",
  FIND_IN_PAGE_NEXT: "find:next",
  FIND_IN_PAGE_STOP: "find:stop",
  FIND_IN_PAGE_RESULT: "find:result",
} as const;
