export type TabRole = "primary" | "research" | "auth" | "scratch";
export type TabGroupColor =
  | "blue"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "purple"
  | "gray";

export const TAB_GROUP_COLORS: TabGroupColor[] = [
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
  "gray",
];

export const TAB_GROUP_COLOR_LABELS: Record<TabGroupColor, string> = {
  blue: "Blue",
  green: "Green",
  yellow: "Yellow",
  orange: "Orange",
  red: "Red",
  purple: "Purple",
  gray: "Gray",
};

export interface DownloadRecord {
  id: string;
  filename: string;
  savePath: string;
  url?: string;
  mimeType?: string;
  totalBytes: number;
  receivedBytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  startedAt: string;
  updatedAt: string;
}

export interface PermissionRecord {
  origin: string;
  permission: string;
  decision: "allow" | "deny";
  updatedAt: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string;
  releaseUrl?: string;
  error?: string;
}

export interface TabState {
  id: string;
  title: string;
  url: string;
  favicon: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isReaderMode: boolean;
  adBlockingEnabled: boolean;
  isPinned: boolean;
  isAudible: boolean;
  isMuted: boolean;
  groupId?: string;
  groupName?: string;
  groupColor?: TabGroupColor;
  groupCollapsed?: boolean;
  role?: TabRole;
}

export type SecurityStatus = "secure" | "insecure" | "error" | "none";

export interface SecurityState {
  status: SecurityStatus;
  url: string;
  errorMessage?: string;
  canProceed?: boolean;
}

export interface SelectOption {
  label: string;
  value: string;
}

export interface InteractiveElement {
  type: "button" | "link" | "input" | "select" | "textarea";
  text?: string;
  label?: string;
  labelSource?: "text" | "value" | "aria-label" | "label" | "placeholder";
  href?: string;
  inputType?: string;
  placeholder?: string;
  required?: boolean;
  context?: string;
  parentOverlay?: string;
  selector?: string;
  index?: number;
  role?: string;
  description?: string;
  value?: string;
  options?: SelectOption[];
  visible?: boolean;
  inViewport?: boolean;
  fullyInViewport?: boolean;
  obscured?: boolean;
  blockedByOverlay?: boolean;
  disabled?: boolean;
  name?: string;
  autocomplete?: string;
  ariaExpanded?: boolean;
  ariaPressed?: boolean;
  ariaSelected?: boolean;
  checked?: boolean;
  looksCorrect?: boolean;
  maxLength?: number;
  min?: string;
  max?: string;
  pattern?: string;
}

export interface HeadingStructure {
  level: number;
  text: string;
}

export type StructuredDataPrimitive = string | number | boolean | null;

export interface StructuredDataObject {
  [key: string]: StructuredDataValue;
}

export type StructuredDataValue =
  | StructuredDataPrimitive
  | StructuredDataObject
  | StructuredDataValue[];

export type StructuredDataSource =
  | "json-ld"
  | "microdata"
  | "rdfa"
  | "meta"
  | "page";

export interface StructuredDataEntity {
  source: StructuredDataSource;
  types: string[];
  name?: string;
  url?: string;
  description?: string;
  attributes: StructuredDataObject;
}

export type PageIssueKind =
  | "rate-limit"
  | "bot-check"
  | "access-denied"
  | "not-found";

export type PageIssueSeverity = "warning" | "error";

export interface PageIssue {
  kind: PageIssueKind;
  severity: PageIssueSeverity;
  summary: string;
  detail: string;
  recommendation?: string;
}

export interface OverlayAction {
  label?: string;
  selector?: string;
  kind?: "dismiss" | "accept" | "submit" | "radio" | "action";
  disabled?: boolean;
}

export interface OverlayRadioOption {
  label: string;
  selector?: string;
  checked?: boolean;
  labelSource?: string;
  looksCorrect?: boolean;
}

export interface PageOverlay {
  type: "dialog" | "modal" | "overlay";
  kind?:
    | "cookie_consent"
    | "selection_modal"
    | "alert"
    | "cart_confirmation"
    | "drawer"
    | "overlay";
  role?: string;
  label?: string;
  selector?: string;
  text?: string;
  message?: string;
  blocksInteraction?: boolean;
  dismissSelector?: string;
  acceptSelector?: string;
  submitSelector?: string;
  actions?: OverlayAction[];
  radioOptions?: OverlayRadioOption[];
}

export interface PageContent {
  title: string;
  content: string;
  htmlContent: string;
  byline: string;
  excerpt: string;
  url: string;
  // New structured context fields
  headings: HeadingStructure[];
  navigation: InteractiveElement[];
  interactiveElements: InteractiveElement[];
  forms: Array<{
    id?: string;
    action?: string;
    method?: string;
    fields: InteractiveElement[];
  }>;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  overlays: PageOverlay[];
  dormantOverlays: PageOverlay[];
  landmarks: Array<{
    role: string;
    label?: string;
    text?: string;
  }>;
  jsonLd?: Record<string, unknown>[];
  microdata?: Record<string, unknown>[];
  rdfa?: Record<string, unknown>[];
  metaTags?: Record<string, string>;
  structuredData?: StructuredDataEntity[];
  pageIssues?: PageIssue[];
  pageSchema?: import("./page-schema").PageSchema;
}

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

export type AutomationActivityStatus = "running" | "completed" | "failed";

export interface AutomationActivityEntry {
  id: string;
  source: "scheduled";
  title: string;
  icon?: string;
  status: AutomationActivityStatus;
  startedAt: string;
  finishedAt?: string;
  output: string;
}

export type ApprovalMode = "auto" | "confirm-dangerous" | "manual";

export type ActionSource = "ai" | "mcp" | "user" | "system";

export type ActionStatus =
  | "running"
  | "completed"
  | "failed"
  | "waiting-approval"
  | "rejected";

export interface SessionTabSnapshot {
  id: string;
  url: string;
  title: string;
  adBlockingEnabled?: boolean;
  isPinned?: boolean;
  groupName?: string;
  groupColor?: TabGroupColor;
}

export interface SessionSnapshot {
  tabs: SessionTabSnapshot[];
  activeIndex: number;
  activeTabId?: string;
  capturedAt: string;
  note?: string;
}

export interface PersistedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  url?: string;
}

export interface PersistedOriginStorage {
  origin: string;
  entries: Record<string, string>;
}

export interface NamedSessionSummary {
  name: string;
  createdAt: string;
  updatedAt: string;
  cookieCount: number;
  originCount: number;
  domains: string[];
}

export interface NamedSessionData extends NamedSessionSummary {
  cookies: PersistedCookie[];
  localStorage: PersistedOriginStorage[];
  snapshot: SessionSnapshot;
}

export interface AgentActionEntry {
  id: string;
  source: ActionSource;
  name: string;
  args: Record<string, unknown>;
  argsSummary: string;
  status: ActionStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  tabId?: string | null;
  resultSummary?: string;
  error?: string;
}

export interface PendingApproval {
  id: string;
  actionId: string;
  source: ActionSource;
  name: string;
  argsSummary: string;
  reason: string;
  requestedAt: string;
}

export interface AgentCheckpoint {
  id: string;
  name: string;
  createdAt: string;
  note?: string;
  snapshot: SessionSnapshot;
}

export interface SupervisorState {
  paused: boolean;
  approvalMode: ApprovalMode;
  pendingApprovals: PendingApproval[];
  lastError?: string;
}

export type AgentTranscriptKind = "message" | "thinking" | "status";

export interface AgentTranscriptEntry {
  id: string;
  source: ActionSource;
  kind: AgentTranscriptKind;
  title?: string;
  text: string;
  startedAt: string;
  updatedAt: string;
  status: "streaming" | "final";
  streamId?: string;
}

export type AgentTranscriptDisplayMode = "off" | "summary" | "full";

export type McpConnectionStatus = "starting" | "ready" | "error" | "stopped";

// --- Speedee Flow State ---

export type FlowStepStatus = "pending" | "done" | "skipped" | "failed";

export interface FlowStep {
  label: string;
  status: FlowStepStatus;
  detail?: string;
}

export interface FlowState {
  id: string;
  goal: string;
  steps: FlowStep[];
  currentStepIndex: number;
  startedAt: string;
  updatedAt: string;
  startUrl?: string;
  metadata?: Record<string, unknown>;
}

export type TaskTrackerStepStatus = "pending" | "active" | "done" | "failed";

export interface TaskTrackerStep {
  label: string;
  status: TaskTrackerStepStatus;
  detail?: string;
}

export interface TaskTrackerState {
  goal: string;
  steps: TaskTrackerStep[];
  currentStepIndex: number;
  startedAt: string;
  updatedAt: string;
  startUrl?: string;
  lastAction?: string;
  nextHint?: string;
  requestedCount?: number | null;
  cartCount?: number;
  cartVisible?: boolean;
}

export interface AgentRuntimeState {
  session: SessionSnapshot | null;
  supervisor: SupervisorState;
  actions: AgentActionEntry[];
  checkpoints: AgentCheckpoint[];
  transcript: AgentTranscriptEntry[];
  mcpStatus: McpConnectionStatus;
  flowState: FlowState | null;
  taskTracker: TaskTrackerState | null;
  canUndo: boolean;
  undoInfo: { actionName: string; capturedAt: string } | null;
}

export interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  focusMode: boolean;
  settingsOpen: boolean;
  devtoolsPanelOpen: boolean;
  devtoolsPanelHeight: number;
}

// --- Provider types ---

export type ProviderId =
  | "anthropic"
  | "openai"
  | "openai_codex"
  | "openrouter"
  | "ollama"
  | "llama_cpp"
  | "mistral"
  | "xai"
  | "google"
  | "custom";

export type ReasoningEffortLevel = "off" | "low" | "medium" | "high" | "max";

export interface ProviderConfig {
  id: ProviderId;
  apiKey: string;
  hasApiKey?: boolean;
  model: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffortLevel;
}

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  defaultModel: string;
  models: string[];
  requiresApiKey: boolean;
  type?: "direct_sdk" | "compatible" | "codex_oauth";
  defaultBaseUrl?: string;
  apiKeyPlaceholder: string;
  apiKeyHint: string;
}

export interface CodexOAuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** API-key-style token obtained by exchanging the ChatGPT id_token for openai-api-key. */
  apiKey?: string;
  expiresAt: number;       // epoch ms
  accountId: string;       // chatgpt_account_id from JWT
  accountEmail?: string;
}

export type CodexAuthStatus = "idle" | "waiting" | "exchanging" | "connected" | "error";

export interface ProviderModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
  warning?: string;
}

export interface DomainPolicy {
  allowedDomains: string[];
  blockedDomains: string[];
}

export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: string;
}

export interface HistoryState {
  entries: HistoryEntry[];
}

export type PremiumStatus = "free" | "active" | "trialing" | "past_due" | "canceled";

export interface PremiumState {
  status: PremiumStatus;
  customerId: string;
  verificationToken: string;
  email: string;
  validatedAt: string;
  expiresAt: string;
}

export type SearchEngineId = "duckduckgo" | "google" | "bing" | "brave" | "ecosia" | "kagi" | "none";

export const SEARCH_ENGINE_PRESETS: Record<Exclude<SearchEngineId, "none">, { label: string; url: string }> = {
  duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  google: { label: "Google", url: "https://www.google.com/search?q=" },
  bing: { label: "Bing", url: "https://www.bing.com/search?q=" },
  brave: { label: "Brave Search", url: "https://search.brave.com/search?q=" },
  ecosia: { label: "Ecosia", url: "https://www.ecosia.org/search?q=" },
  kagi: { label: "Kagi", url: "https://kagi.com/search?q=" },
};

export interface VesselSettings {
  defaultUrl: string;
  theme: "dark" | "light";
  sidebarWidth: number;
  mcpPort: number;
  autoRestoreSession: boolean;
  clearBookmarksOnLaunch: boolean;
  obsidianVaultPath: string;
  approvalMode: ApprovalMode;
  agentTranscriptMode: AgentTranscriptDisplayMode;
  chatProvider: ProviderConfig | null;
  maxToolIterations: number;
  domainPolicy: DomainPolicy;
  sourceDoNotAllowList: string[];
  downloadPath: string;
  premium: PremiumState;
  telemetryEnabled: boolean;
  defaultSearchEngine: SearchEngineId;
}

export type RuntimeHealthSeverity = "warning" | "error";

export interface RuntimeHealthIssue {
  code: string;
  severity: RuntimeHealthSeverity;
  title: string;
  detail: string;
  action?: string;
}

export interface RuntimeHealthState {
  userDataPath: string;
  settingsPath: string;
  startupIssues: RuntimeHealthIssue[];
  mcp: {
    configuredPort: number;
    activePort: number | null;
    endpoint: string | null;
    status: "starting" | "ready" | "error" | "stopped";
    message: string;
  };
}

// --- Bookmarks ---

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  note?: string;
  folderId: string; // "unsorted" for default
  savedAt: string; // ISO timestamp
  /** Human-readable description of what this bookmark is for (e.g. "expense reporting") */
  intent?: string;
  /** Brief description of content the agent should expect to find here */
  expectedContent?: string;
  /** Important field names for form pages (e.g. ["receipt_id", "date", "amount"]) */
  keyFields?: string[];
  /** Inferred page schema for this bookmark */
  pageSchema?: import("./page-schema").PageSchema;
  /** Arbitrary key-value hints for the agent */
  agentHints?: Record<string, string>;
}

export interface BookmarkFolder {
  id: string;
  name: string;
  summary?: string;
  createdAt: string;
}

export interface BookmarksState {
  folders: BookmarkFolder[];
  bookmarks: Bookmark[];
}

export interface BookmarkHtmlExportOptions {
  includeNotes?: boolean;
}

export interface BookmarkExportResult {
  filePath: string;
  count: number;
}

// --- Automation Kits ---

export type KitInputType = "text" | "url" | "number" | "textarea";

export type KitCategory = "research" | "shopping" | "productivity" | "forms";

export interface KitInput {
  key: string;
  label: string;
  type: KitInputType;
  placeholder?: string;
  /** Short helper text shown below the field */
  hint?: string;
  required?: boolean;
  defaultValue?: string;
}

export interface AutomationKit {
  id: string;
  name: string;
  description: string;
  category: KitCategory;
  /** Lucide icon name shown in the kit card (e.g. "BookOpen") */
  icon: string;
  inputs: KitInput[];
  /** Prompt template using {{key}} placeholders matching input keys */
  promptTemplate: string;
  /** Rough time estimate shown in the UI (minutes) */
  estimatedMinutes?: number;
}

// --- Scheduled Jobs ---

export type ScheduleType = "once" | "hourly" | "daily" | "weekly";

export interface ScheduleConfig {
  type: ScheduleType;
  /** ISO datetime string — only for "once" */
  runAt?: string;
  /** Hour of day (0–23) — used for "daily" and "weekly" */
  hour?: number;
  /** Minute (0–59) — used for "daily" and "weekly" */
  minute?: number;
  /** Day of week (0 = Sunday … 6 = Saturday) — only for "weekly" */
  dayOfWeek?: number;
}

export interface ScheduledJob {
  id: string;
  kitId: string;
  kitName: string;
  kitIcon: string;
  /** Pre-rendered prompt ready to pass directly to the agent */
  renderedPrompt: string;
  /** Original kit field values — stored so the user can re-edit the task later */
  fieldValues?: Record<string, string>;
  schedule: ScheduleConfig;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  /** ISO datetime of the next scheduled execution */
  nextRunAt: string;
}

// --- Highlights ---

export type HighlightColor =
  | "yellow"
  | "red"
  | "green"
  | "blue"
  | "purple"
  | "orange";

export type HighlightSource = "agent" | "user";

export interface StoredHighlight {
  id: string;
  url: string; // hash-stripped canonical URL
  selector?: string;
  text?: string;
  label?: string;
  color?: HighlightColor;
  source?: HighlightSource;
  createdAt: string; // ISO timestamp
}

export interface HighlightsState {
  highlights: StoredHighlight[];
}

// --- Agent Credential Vault ---

export interface VaultEntry {
  id: string;
  label: string;
  domainPattern: string;
  username: string;
  password: string;
  totpSecret?: string;
  notes?: string;
  createdAt: string;
  lastUsedAt?: string;
  useCount: number;
}

export interface VaultAuditEntry {
  timestamp: string;
  credentialId: string;
  credentialLabel: string;
  domain: string;
  action: "login_fill" | "totp_generate" | "status_check";
  sessionId?: string;
  approved: boolean;
}

// --- Human Password Manager ---

export interface HumanCredentialEntry {
  id: string;
  title: string;
  url: string;
  domain: string;
  username: string;
  password: string;
  totpSecret?: string;
  category?: "login" | "credit_card" | "identity" | "secure_note";
  tags?: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
}

export interface HumanVaultAuditEntry {
  timestamp: string;
  credentialId: string;
  credentialTitle: string;
  domain: string;
  action: "human_list" | "human_autofill" | "human_copy" | "human_view" | "human_create" | "human_update" | "human_delete";
  approved: boolean;
  source: "settings_ui" | "mcp_tool";
}

// --- Clear Browsing Data ---

export type ClearDataTimeRange = "hour" | "day" | "week" | "month" | "all";

export interface ClearDataOptions {
  cache: boolean;
  cookies: boolean;
  history: boolean;
  localStorage: boolean;
  timeRange: ClearDataTimeRange;
}

// --- Import result ---

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: number;
}
