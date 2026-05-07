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
  AGENT_CHECKPOINT_UPDATE_NOTE: "agent:checkpoint-update-note",
  AGENT_UNDO_LAST_ACTION: "agent:undo-last-action",
  AGENT_SESSION_CAPTURE: "agent:session-capture",
  AGENT_SESSION_RESTORE: "agent:session-restore",

  // Content
  CONTENT_EXTRACT: "content:extract",
  READER_MODE_TOGGLE: "reader:toggle",

  // UI state
  SIDEBAR_TOGGLE: "ui:sidebar-toggle",
  SIDEBAR_NAVIGATE: "ui:sidebar-navigate",
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
  BOOKMARK_UPDATE: "bookmarks:update-item",
  BOOKMARK_REMOVE: "bookmarks:remove",
  BOOKMARKS_EXPORT_HTML: "bookmarks:export-html",
  BOOKMARKS_EXPORT_JSON: "bookmarks:export-json",
  BOOKMARKS_IMPORT_HTML: "bookmarks:import-html",
  BOOKMARKS_IMPORT_JSON: "bookmarks:import-json",
  BOOKMARK_ADD_CONTEXT_TO_CHAT: "bookmarks:add-context-to-chat",
  FOLDER_CREATE: "bookmarks:folder-create",
  FOLDER_REMOVE: "bookmarks:folder-remove",
  FOLDER_RENAME: "bookmarks:folder-rename",
  FOLDER_EXPORT_HTML: "bookmarks:folder-export-html",

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

  // Ad blocking
  TAB_TOGGLE_AD_BLOCK: "tab:toggle-ad-block",

  // Zoom
  TAB_ZOOM_IN: "tab:zoom-in",
  TAB_ZOOM_OUT: "tab:zoom-out",
  TAB_ZOOM_RESET: "tab:zoom-reset",

  // Security indicator
  SECURITY_STATE_UPDATE: "security:state-update",
  SECURITY_SHOW_DETAILS: "security:show-details",
  SECURITY_PROCEED_ANYWAY: "security:proceed-anyway",
  SECURITY_GO_BACK_TO_SAFETY: "security:go-back-to-safety",

  // Closed tabs / duplication
  TAB_REOPEN_CLOSED: "tab:reopen-closed",
  TAB_DUPLICATE: "tab:duplicate",
  TAB_CONTEXT_MENU: "tab:context-menu",

  // Pin tabs
  TAB_PIN: "tab:pin",
  TAB_UNPIN: "tab:unpin",

  // Tab groups
  TAB_GROUP_CREATE: "tab-group:create",
  TAB_GROUP_ADD_TAB: "tab-group:add-tab",
  TAB_GROUP_REMOVE_TAB: "tab-group:remove-tab",
  TAB_GROUP_TOGGLE_COLLAPSED: "tab-group:toggle-collapsed",
  TAB_GROUP_SET_COLOR: "tab-group:set-color",
  TAB_GROUP_CONTEXT_MENU: "tab-group:context-menu",

  // Audio / mute
  TAB_TOGGLE_MUTE: "tab:toggle-mute",

  // Print
  TAB_PRINT: "tab:print",
  TAB_PRINT_TO_PDF: "tab:print-to-pdf",

  // Windows
  OPEN_NEW_WINDOW: "window:open-new",

  // Private browsing
  OPEN_PRIVATE_WINDOW: "private:open-window",
  IS_PRIVATE_MODE: "private:is-private",

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
  HISTORY_EXPORT_HTML: "history:export-html",
  HISTORY_EXPORT_JSON: "history:export-json",
  HISTORY_IMPORT: "history:import",

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

  // Named sessions
  SESSION_LIST: "session:list",
  SESSION_SAVE: "session:save",
  SESSION_LOAD: "session:load",
  SESSION_DELETE: "session:delete",

  // Agent Credential Vault
  VAULT_LIST: "vault:list",
  VAULT_ADD: "vault:add",
  VAULT_UPDATE: "vault:update",
  VAULT_REMOVE: "vault:remove",
  VAULT_AUDIT_LOG: "vault:audit-log",

  // Human Password Manager
  HUMAN_VAULT_LIST: "human-vault:list",
  HUMAN_VAULT_GET: "human-vault:get",
  HUMAN_VAULT_SAVE: "human-vault:save",
  HUMAN_VAULT_UPDATE: "human-vault:update",
  HUMAN_VAULT_REMOVE: "human-vault:remove",
  HUMAN_VAULT_AUDIT_LOG: "human-vault:audit-log",

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
  PAGE_DIFF_HISTORY: "page:diff-history",
  PAGE_DIFF_DIRTY: "page:diff-dirty",

  // Clear browsing data
  CLEAR_BROWSING_DATA: "browsing-data:clear",
  CLEAR_BROWSING_DATA_OPEN: "browsing-data:open",

  // Picture-in-Picture
  TAB_TOGGLE_PIP: "tab:toggle-pip",

  // Codex OAuth
  CODEX_START_AUTH: "codex:start-auth",
  CODEX_CANCEL_AUTH: "codex:cancel-auth",
  CODEX_AUTH_STATUS: "codex:auth-status",
} as const;
