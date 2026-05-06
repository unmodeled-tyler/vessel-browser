import type { Accessor, Setter } from "solid-js";
import type {
  AgentTranscriptDisplayMode,
  PremiumState,
  ProviderId,
  ReasoningEffortLevel,
  RuntimeHealthState,
  SearchEngineId,
} from "../../../../shared/types";

export type SettingsCategoryId =
  | "general"
  | "agent"
  | "vaults"
  | "privacy"
  | "account";

// --- Data type aliases (extracted from Settings.tsx) ---

export type SessionSummary = {
  name: string;
  createdAt: string;
  updatedAt: string;
  cookieCount: number;
  originCount: number;
  domains: string[];
};

export type VaultListEntry = {
  id: string;
  label: string;
  domainPattern: string;
  username: string;
  notes?: string;
  createdAt: string;
  lastUsedAt?: string;
  useCount: number;
};

export type HumanVaultEntry = {
  id: string;
  title: string;
  url: string;
  domain: string;
  username: string;
  category: string;
  notes?: string;
  tags: string[];
  createdAt: string;
  lastUsedAt?: string;
  useCount: number;
};

export type AutofillListEntry = {
  id: string;
  label: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  organization: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

// --- Domain-grouped prop interfaces ---

export interface WelcomeBannerProps {
  show: Accessor<boolean>;
  dismiss: () => void;
}

export interface ChatProps {
  enabled: Accessor<boolean>;
  setEnabled: Setter<boolean>;
  providerId: Accessor<ProviderId>;
  setProviderId: Setter<ProviderId>;
  apiKey: Accessor<string>;
  setApiKey: Setter<string>;
  hasStoredApiKey: Accessor<boolean>;
  setHasStoredApiKey: Setter<boolean>;
  model: Accessor<string>;
  setModel: Setter<string>;
  baseUrl: Accessor<string>;
  setBaseUrl: Setter<string>;
  reasoningEffort: Accessor<ReasoningEffortLevel>;
  setReasoningEffort: Setter<ReasoningEffortLevel>;
  providerModels: Accessor<string[]>;
  modelFetchState: Accessor<"idle" | "loading" | "error">;
  modelFetchWarning: Accessor<string | null>;
  doFetchModels: () => void;
  resetProviderModels: () => void;
}

export interface VaultProps {
  entries: Accessor<VaultListEntry[]>;
  expanded: Accessor<boolean>;
  setExpanded: Setter<boolean>;
  adding: Accessor<boolean>;
  setAdding: Setter<boolean>;
  newLabel: Accessor<string>;
  setNewLabel: Setter<string>;
  newDomain: Accessor<string>;
  setNewDomain: Setter<string>;
  newUsername: Accessor<string>;
  setNewUsername: Setter<string>;
  newPassword: Accessor<string>;
  setNewPassword: Setter<string>;
  newTotp: Accessor<string>;
  setNewTotp: Setter<string>;
  newNotes: Accessor<string>;
  setNewNotes: Setter<string>;
  message: Accessor<{ kind: "success" | "error"; text: string } | null>;
  setMessage: Setter<{
    kind: "success" | "error";
    text: string;
  } | null>;
  handleAdd: () => Promise<void>;
  handleRemove: (id: string) => Promise<void>;
}

export interface HumanVaultProps {
  entries: Accessor<HumanVaultEntry[]>;
  adding: Accessor<boolean>;
  setAdding: Setter<boolean>;
  newTitle: Accessor<string>;
  setNewTitle: Setter<string>;
  newUrl: Accessor<string>;
  setNewUrl: Setter<string>;
  newUsername: Accessor<string>;
  setNewUsername: Setter<string>;
  newPassword: Accessor<string>;
  setNewPassword: Setter<string>;
  newCategory: Accessor<string>;
  setNewCategory: Setter<string>;
  newNotes: Accessor<string>;
  setNewNotes: Setter<string>;
  message: Accessor<{ kind: "success" | "error"; text: string } | null>;
  handleAdd: () => Promise<void>;
  handleRemove: (id: string) => Promise<void>;
}

export interface AutofillProps {
  profiles: Accessor<AutofillListEntry[]>;
  adding: Accessor<boolean>;
  setAdding: Setter<boolean>;
  label: Accessor<string>;
  setLabel: Setter<string>;
  firstName: Accessor<string>;
  setFirstName: Setter<string>;
  lastName: Accessor<string>;
  setLastName: Setter<string>;
  email: Accessor<string>;
  setEmail: Setter<string>;
  phone: Accessor<string>;
  setPhone: Setter<string>;
  organization: Accessor<string>;
  setOrganization: Setter<string>;
  addressLine1: Accessor<string>;
  setAddressLine1: Setter<string>;
  addressLine2: Accessor<string>;
  setAddressLine2: Setter<string>;
  city: Accessor<string>;
  setCity: Setter<string>;
  state: Accessor<string>;
  setState: Setter<string>;
  postalCode: Accessor<string>;
  setPostalCode: Setter<string>;
  country: Accessor<string>;
  setCountry: Setter<string>;
  message: Accessor<{ kind: "success" | "error"; text: string } | null>;
  handleAdd: () => Promise<void>;
  handleRemove: (id: string) => Promise<void>;
  handleFill: (id: string) => Promise<void>;
}

export interface PremiumProps {
  state: Accessor<PremiumState>;
  setState: Setter<PremiumState>;
  email: Accessor<string>;
  setEmail: Setter<string>;
  code: Accessor<string>;
  setCode: Setter<string>;
  challengeToken: Accessor<string>;
  setChallengeToken: Setter<string>;
  codeSent: Accessor<boolean>;
  setCodeSent: Setter<boolean>;
  loading: Accessor<boolean>;
  setLoading: Setter<boolean>;
  message: Accessor<{ kind: "success" | "error"; text: string } | null>;
  setMessage: Setter<{
    kind: "success" | "error";
    text: string;
  } | null>;
  active: Accessor<boolean>;
  startCheckout: () => void;
  resetFlow: () => void;
}

export interface SessionsProps {
  list: Accessor<SessionSummary[]>;
  saveName: Accessor<string>;
  setSaveName: Setter<string>;
  loadList: () => Promise<void>;
}

// --- Sub-component prop interfaces ---

export interface SettingsGeneralProps {
  welcomeBanner: WelcomeBannerProps;
  defaultUrl: Accessor<string>;
  setDefaultUrl: Setter<string>;
  defaultSearchEngine: Accessor<SearchEngineId>;
  setDefaultSearchEngine: Setter<SearchEngineId>;
  downloadPath: Accessor<string>;
  setDownloadPath: Setter<string>;
  theme: Accessor<"dark" | "light">;
  setTheme: Setter<"dark" | "light">;
  autoRestoreSession: Accessor<boolean>;
  setAutoRestoreSession: Setter<boolean>;
  clearBookmarksOnLaunch: Accessor<boolean>;
  setClearBookmarksOnLaunch: Setter<boolean>;
  premiumActive: Accessor<boolean>;
  startPremiumCheckout: () => void;
}

export interface SettingsAgentProps {
  chat: ChatProps;
  mcpPort: Accessor<string>;
  setMcpPort: Setter<string>;
  maxToolIterations: Accessor<string>;
  setMaxToolIterations: Setter<string>;
  agentTranscriptMode: Accessor<AgentTranscriptDisplayMode>;
  setAgentTranscriptMode: Setter<AgentTranscriptDisplayMode>;
  obsidianVaultPath: Accessor<string>;
  setObsidianVaultPath: Setter<string>;
  health: Accessor<RuntimeHealthState | null>;
  premiumActive: Accessor<boolean>;
}

export interface SettingsVaultsProps {
  premiumActive: Accessor<boolean>;
  vault: VaultProps;
  humanVault: HumanVaultProps;
  autofill: AutofillProps;
}

export interface SettingsPrivacyProps {
  telemetryEnabled: Accessor<boolean>;
  setTelemetryEnabled: Setter<boolean>;
  domainMode: Accessor<"none" | "allowlist" | "blocklist">;
  setDomainMode: Setter<"none" | "allowlist" | "blocklist">;
  domainList: Accessor<string>;
  setDomainList: Setter<string>;
}

export interface SettingsAccountProps {
  premium: PremiumProps;
  sessions: SessionsProps;
  setStatus: Setter<{
    kind: "success" | "error";
    text: string;
  } | null>;
}
