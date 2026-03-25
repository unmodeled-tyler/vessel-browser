export type TabRole = "primary" | "research" | "auth" | "scratch";

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
  role?: TabRole;
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

export interface SemanticSection {
  type: string;
  role?: string;
  label?: string;
  elements: InteractiveElement[];
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
}

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
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

export interface AgentRuntimeState {
  session: SessionSnapshot | null;
  supervisor: SupervisorState;
  actions: AgentActionEntry[];
  checkpoints: AgentCheckpoint[];
  transcript: AgentTranscriptEntry[];
  mcpStatus: McpConnectionStatus;
  flowState: FlowState | null;
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
  | "openrouter"
  | "ollama"
  | "mistral"
  | "xai"
  | "google"
  | "custom";

export interface ProviderConfig {
  id: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  defaultModel: string;
  models: string[];
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  apiKeyPlaceholder: string;
  apiKeyHint: string;
}

export interface ProviderUpdateResult {
  ok: boolean;
  error?: string;
}

export interface ProviderModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
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
  email: string;
  validatedAt: string;
  expiresAt: string;
}

export interface VesselSettings {
  defaultUrl: string;
  theme: "dark";
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
  downloadPath: string;
  premium: PremiumState;
  telemetryEnabled: boolean;
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
