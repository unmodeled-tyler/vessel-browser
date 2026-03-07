export const Channels = {
  // Tab management
  TAB_CREATE: 'tab:create',
  TAB_CLOSE: 'tab:close',
  TAB_SWITCH: 'tab:switch',
  TAB_NAVIGATE: 'tab:navigate',
  TAB_BACK: 'tab:back',
  TAB_FORWARD: 'tab:forward',
  TAB_RELOAD: 'tab:reload',
  TAB_STATE_UPDATE: 'tab:state-update',

  // AI
  AI_QUERY: 'ai:query',
  AI_STREAM_CHUNK: 'ai:stream-chunk',
  AI_STREAM_END: 'ai:stream-end',
  AI_CANCEL: 'ai:cancel',

  // Content
  CONTENT_EXTRACT: 'content:extract',
  READER_MODE_TOGGLE: 'reader:toggle',

  // UI state
  SIDEBAR_TOGGLE: 'ui:sidebar-toggle',
  FOCUS_MODE_TOGGLE: 'ui:focus-mode-toggle',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Window controls
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
} as const;
