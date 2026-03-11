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
}

export interface InteractiveElement {
  type: "button" | "link" | "input" | "select" | "textarea";
  text?: string;
  label?: string;
  href?: string;
  inputType?: string;
  placeholder?: string;
  required?: boolean;
  context?: string;
  selector?: string;
  index?: number;
  role?: string;
  description?: string;
  value?: string;
  options?: string[];
  visible?: boolean;
  inViewport?: boolean;
  fullyInViewport?: boolean;
  obscured?: boolean;
  blockedByOverlay?: boolean;
  disabled?: boolean;
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
  overlays: Array<{
    type: "dialog" | "modal" | "overlay";
    role?: string;
    label?: string;
    selector?: string;
    text?: string;
    blocksInteraction?: boolean;
  }>;
  dormantOverlays: Array<{
    type: "dialog" | "modal" | "overlay";
    role?: string;
    label?: string;
    selector?: string;
    text?: string;
  }>;
  landmarks: Array<{
    role: string;
    label?: string;
    text?: string;
  }>;
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

export interface AgentActionEntry {
  id: string;
  source: ActionSource;
  name: string;
  args: Record<string, unknown>;
  argsSummary: string;
  status: ActionStatus;
  startedAt: string;
  finishedAt?: string;
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

export interface AgentRuntimeState {
  session: SessionSnapshot | null;
  supervisor: SupervisorState;
  actions: AgentActionEntry[];
  checkpoints: AgentCheckpoint[];
}

export interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  focusMode: boolean;
  settingsOpen: boolean;
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

export interface VesselSettings {
  defaultUrl: string;
  theme: "dark";
  sidebarWidth: number;
  mcpPort: number;
  autoRestoreSession: boolean;
  clearBookmarksOnLaunch: boolean;
  obsidianVaultPath: string;
  approvalMode: ApprovalMode;
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
