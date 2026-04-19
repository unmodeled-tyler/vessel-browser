export const Channels = {
  // Tab management
  TAB_CREATE: "tab:create",
  TAB_CLOSE: "tab:close",
  TAB_SWITCH: "tab:switch",
  TAB_NAVIGATE: "tab:navigate",
  TAB_BACK: "tab:back",
  TAB_FORWARD: "tab:forward",
  TAB_RELOAD: "tab:reload",
  TAB_STATE_GET: "tab:state-get",
  TAB_STATE_UPDATE: "tab:state-update",
  RENDERER_VIEW_READY: "renderer:view-ready",

  // AI
  AI_QUERY: "ai:query",
  AI_STREAM_START: "ai:stream-start",
  AI_STREAM_CHUNK: "ai:stream-chunk",
  AI_STREAM_END: "ai:stream-end",
  AI_STREAM_IDLE: "ai:stream-idle",
  AUTOMATION_ACTIVITY_START: "automation:activity-start",
  AUTOMATION_ACTIVITY_CHUNK: "automation:activity-chunk",
  AUTOMATION_ACTIVITY_END: "automation:activity-end",
  AI_CANCEL: "ai:cancel",
  AI_FETCH_MODELS: "ai:fetch-models",
  AGENT_RUNTIME_GET: "agent-runtime:get",
  AGENT_RUNTIME_UPDATE: "agent-runtime:update",
  AGENT_PAUSE: "agent:pause",
  AGENT_RESUME: "agent:resume",
  AGENT_SET_APPROVAL_MODE: "agent:set-approval-mode",
  AGENT_APPROVAL_RESOLVE: "agent:approval-resolve",
  AGENT_CHECKPOINT_CREATE: "agent:checkpoint-create",
  AGENT_CHECKPOINT_RESTORE: "agent:checkpoint-restore",
  AGENT_SESSION_CAPTURE: "agent:session-capture",
  AGENT_SESSION_RESTORE: "agent:session-restore",

  // Content
  CONTENT_EXTRACT: "content:extract",
  READER_MODE_TOGGLE: "reader:toggle",

  // UI state
  SIDEBAR_TOGGLE: "ui:sidebar-toggle",
  SIDEBAR_RESIZE: "ui:sidebar-resize",
  SIDEBAR_RESIZE_START: "ui:sidebar-resize-start",
  SIDEBAR_RESIZE_COMMIT: "ui:sidebar-resize-commit",
  SIDEBAR_CONTEXT_MENU: "ui:sidebar-context-menu",
  FOCUS_MODE_TOGGLE: "ui:focus-mode-toggle",
  SETTINGS_VISIBILITY: "ui:settings-visibility",

  // Settings
  SETTINGS_GET: "settings:get",
  SETTINGS_SET: "settings:set",
  SETTINGS_UPDATE: "settings:update",
  SETTINGS_HEALTH_GET: "settings:health:get",
  SETTINGS_HEALTH_UPDATE: "settings:health:update",

  // Bookmarks
  BOOKMARKS_GET: "bookmarks:get",
  BOOKMARKS_UPDATE: "bookmarks:update",
  BOOKMARK_SAVE: "bookmarks:save",
  BOOKMARK_REMOVE: "bookmarks:remove",
  BOOKMARK_ADD_CONTEXT_TO_CHAT: "bookmarks:add-context-to-chat",
  FOLDER_CREATE: "bookmarks:folder-create",
  FOLDER_REMOVE: "bookmarks:folder-remove",
  FOLDER_RENAME: "bookmarks:folder-rename",

  // Highlights
  HIGHLIGHT_CAPTURE: "highlights:capture",
  HIGHLIGHT_CAPTURE_RESULT: "highlights:capture-result",
  HIGHLIGHT_SELECTION: "vessel:highlight-selection",
  HIGHLIGHT_NAV_COUNT: "highlights:nav-count",
  HIGHLIGHT_COUNT_UPDATE: "highlights:count-update",
  HIGHLIGHT_NAV_SCROLL: "highlights:nav-scroll",
  HIGHLIGHT_NAV_REMOVE: "highlights:nav-remove",
  HIGHLIGHT_NAV_CLEAR: "highlights:nav-clear",
  SIDEBAR_HIGHLIGHT_ACTION: "highlights:sidebar-action",

  // DevTools panel
  DEVTOOLS_PANEL_TOGGLE: "devtools-panel:toggle",
  DEVTOOLS_PANEL_STATE: "devtools-panel:state",
  DEVTOOLS_PANEL_RESIZE: "devtools-panel:resize",

  // Find in page
  FIND_IN_PAGE_START: "find:start",
  FIND_IN_PAGE_NEXT: "find:next",
  FIND_IN_PAGE_STOP: "find:stop",
  FIND_IN_PAGE_RESULT: "find:result",

  // Browsing history
  HISTORY_GET: "history:get",
  HISTORY_SEARCH: "history:search",
  HISTORY_CLEAR: "history:clear",
  HISTORY_UPDATE: "history:update",

  // Downloads
  DOWNLOAD_STARTED: "download:started",
  DOWNLOAD_PROGRESS: "download:progress",
  DOWNLOAD_DONE: "download:done",

  // Premium
  PREMIUM_GET_STATE: "premium:get-state",
  PREMIUM_ACTIVATION_START: "premium:activation-start",
  PREMIUM_ACTIVATION_VERIFY: "premium:activation-verify",
  PREMIUM_CHECKOUT: "premium:checkout",
  PREMIUM_PORTAL: "premium:portal",
  PREMIUM_RESET: "premium:reset",
  PREMIUM_TRACK_CONTEXT: "premium:track-context",
  PREMIUM_UPDATE: "premium:update",

  // Agent Credential Vault
  VAULT_LIST: "vault:list",
  VAULT_ADD: "vault:add",
  VAULT_UPDATE: "vault:update",
  VAULT_REMOVE: "vault:remove",
  VAULT_AUDIT_LOG: "vault:audit-log",

  // Automation kits
  AUTOMATION_GET_INSTALLED: "automation:get-installed",
  AUTOMATION_INSTALL_FROM_FILE: "automation:install-from-file",
  AUTOMATION_UNINSTALL: "automation:uninstall",

  // Scheduled jobs
  SCHEDULE_GET_ALL: "schedule:get-all",
  SCHEDULE_CREATE: "schedule:create",
  SCHEDULE_UPDATE: "schedule:update",
  SCHEDULE_DELETE: "schedule:delete",
  SCHEDULE_JOBS_UPDATE: "schedule:jobs-update",

  // Window controls
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_MAXIMIZE: "window:maximize",
  WINDOW_CLOSE: "window:close",

  // Autofill
  AUTOFILL_LIST: "autofill:list",
  AUTOFILL_ADD: "autofill:add",
  AUTOFILL_UPDATE: "autofill:update",
  AUTOFILL_DELETE: "autofill:delete",
  AUTOFILL_FILL: "autofill:fill",

  // Page snapshots / What Changed
  PAGE_DIFF_ACTIVITY: "page:diff-activity",
  PAGE_CHANGED: "page:changed",
  PAGE_DIFF_GET: "page:diff-get",
  PAGE_DIFF_DIRTY: "page:diff-dirty",
} as const;
