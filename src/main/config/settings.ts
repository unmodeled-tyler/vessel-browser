import { app, safeStorage } from "electron";
import path from "path";
import fs from "fs";
import type {
  CodexOAuthTokens,
  ProviderConfig,
  ReasoningEffortLevel,
  RuntimeHealthIssue,
  VesselSettings,
} from "../../shared/types";
import { createLogger } from "../../shared/logger";

const defaults: VesselSettings = {
  defaultUrl: "https://start.duckduckgo.com",
  theme: "dark",
  sidebarWidth: 400,
  mcpPort: 3100,
  autoRestoreSession: true,
  clearBookmarksOnLaunch: false,
  obsidianVaultPath: "",
  approvalMode: "confirm-dangerous",
  agentTranscriptMode: "summary",
  chatProvider: null,
  maxToolIterations: 200,
  domainPolicy: { allowedDomains: [], blockedDomains: [] },
  downloadPath: "",
  telemetryEnabled: true,
  defaultSearchEngine: "duckduckgo",
  premium: {
    status: "free",
    customerId: "",
    verificationToken: "",
    email: "",
    validatedAt: "",
    expiresAt: "",
  },
};

const SAVE_DEBOUNCE_MS = 150;
const CHAT_PROVIDER_SECRET_FILENAME = "vessel-chat-provider-secret";
const CODEX_TOKENS_FILENAME = "vessel-codex-tokens";
const logger = createLogger("Settings");

/** Allowlist of setting keys accepted via IPC. */
export const SETTABLE_KEYS: ReadonlySet<string> = new Set(Object.keys(defaults));

let settings: VesselSettings | null = null;
let settingsIssues: RuntimeHealthIssue[] = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveDirty = false;

function getUserDataPath(): string {
  if (typeof app?.getPath === "function") {
    return app.getPath("userData");
  }
  return path.join(process.cwd(), ".vessel-test-data");
}

export function getSettingsPath(): string {
  return path.join(getUserDataPath(), "vessel-settings.json");
}

function getChatProviderSecretPath(): string {
  return path.join(getUserDataPath(), CHAT_PROVIDER_SECRET_FILENAME);
}

type StoredProviderSecret = {
  providerId: ProviderConfig["id"];
  apiKey: string;
};

function canUseSafeStorage(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function writePrivateFile(filePath: string, data: string | Buffer): void {
  fs.writeFileSync(filePath, data, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms/filesystems without POSIX permissions.
  }
}

function assertSafeStorageAvailable(): void {
  if (!canUseSafeStorage()) {
    throw new Error("OS-backed secret storage is unavailable; refusing to store secrets on disk.");
  }
}

function readStoredProviderSecret(): StoredProviderSecret | null {
  try {
    if (!canUseSafeStorage()) return null;
    const raw = fs.readFileSync(getChatProviderSecretPath());
    const decoded = safeStorage.decryptString(raw);
    const parsed = JSON.parse(decoded) as StoredProviderSecret;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.providerId === "string" &&
      typeof parsed.apiKey === "string"
    ) {
      return parsed;
    }
  } catch {
    // Ignore missing or unreadable secrets.
  }
  return null;
}

function writeStoredProviderSecret(secret: StoredProviderSecret): void {
  assertSafeStorageAvailable();
  const filePath = getChatProviderSecretPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify(secret);
  const encrypted = safeStorage.encryptString(payload);
  writePrivateFile(filePath, encrypted);
}

function clearStoredProviderSecret(): void {
  try {
    fs.unlinkSync(getChatProviderSecretPath());
  } catch {
    // Secret file may not exist.
  }
}

function getCodexTokensPath(): string {
  return path.join(getUserDataPath(), CODEX_TOKENS_FILENAME);
}

export function readStoredCodexTokens(): CodexOAuthTokens | null {
  try {
    if (!canUseSafeStorage()) return null;
    const raw = fs.readFileSync(getCodexTokensPath());
    const decoded = safeStorage.decryptString(raw);
    const parsed = JSON.parse(decoded) as CodexOAuthTokens;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.accessToken === "string" &&
      typeof parsed.refreshToken === "string"
    ) {
      return parsed;
    }
  } catch {
    // Ignore missing or unreadable tokens.
  }
  return null;
}

export function writeStoredCodexTokens(tokens: CodexOAuthTokens): void {
  assertSafeStorageAvailable();
  const filePath = getCodexTokensPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify(tokens);
  const encrypted = safeStorage.encryptString(payload);
  writePrivateFile(filePath, encrypted);
}

export function clearStoredCodexTokens(): void {
  try {
    fs.unlinkSync(getCodexTokensPath());
  } catch {
    // Token file may not exist.
  }
}

function mergeChatProviderSecret(
  provider: ProviderConfig | null | undefined,
): ProviderConfig | null {
  if (!provider) return null;

  const stored = readStoredProviderSecret();
  const legacyApiKey = provider.apiKey?.trim() || "";
  const apiKey =
    stored?.providerId === provider.id
      ? stored.apiKey
      : legacyApiKey;

  if (legacyApiKey && stored?.providerId !== provider.id) {
    writeStoredProviderSecret({ providerId: provider.id, apiKey: legacyApiKey });
  }

  return {
    ...provider,
    apiKey,
    hasApiKey: Boolean(apiKey),
  };
}

function buildPersistedSettings(source: VesselSettings): VesselSettings {
  return {
    ...source,
    chatProvider: source.chatProvider
      ? {
          ...source.chatProvider,
          apiKey: "",
          hasApiKey: source.chatProvider.hasApiKey || Boolean(source.chatProvider.apiKey),
        }
      : null,
  };
}

export function getRendererSettings(): VesselSettings {
  const current = loadSettings();
  const provider = current.chatProvider;
  const hasCodexTokens = provider?.id === "openai_codex" && readStoredCodexTokens() !== null;
  return {
    ...current,
    chatProvider: provider
      ? {
          ...provider,
          apiKey: "",
          hasApiKey: Boolean(provider.apiKey) || hasCodexTokens,
        }
      : null,
  };
}

export function getSettingsLoadIssues(): RuntimeHealthIssue[] {
  return settingsIssues.map((issue) => ({ ...issue }));
}

function sanitizePort(value: unknown): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  settingsIssues.push({
    code: "settings-invalid-mcp-port",
    severity: "warning",
    title: "Invalid MCP port in settings",
    detail: `Expected an integer between 1 and 65535 but found ${JSON.stringify(value)}.`,
    action: `Using default port ${defaults.mcpPort} instead.`,
  });
  return defaults.mcpPort;
}

function sanitizeReasoningEffortLevel(value: unknown): ReasoningEffortLevel {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max" ||
    value === "off"
    ? value
    : "off";
}

function sanitizeChatProvider(
  provider: ProviderConfig | null,
): ProviderConfig | null {
  return provider
    ? {
        ...provider,
        reasoningEffort: sanitizeReasoningEffortLevel(provider.reasoningEffort),
      }
    : null;
}

export function loadSettings(): VesselSettings {
  if (settings) return settings;
  settingsIssues = [];
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<VesselSettings> & {
      apiKey?: string;
      provider?: unknown;
      showAgentTranscript?: unknown;
      agentTranscriptMode?: unknown;
    };
    delete parsed.apiKey;
    delete parsed.provider;
    settings = {
      ...defaults,
      ...parsed,
      chatProvider: sanitizeChatProvider(
        mergeChatProviderSecret(parsed.chatProvider ?? null),
      ),
      mcpPort: sanitizePort(parsed.mcpPort ?? defaults.mcpPort),
      agentTranscriptMode:
        parsed.agentTranscriptMode === "off" ||
        parsed.agentTranscriptMode === "summary" ||
        parsed.agentTranscriptMode === "full"
          ? parsed.agentTranscriptMode
          : parsed.showAgentTranscript === false
            ? "off"
            : defaults.agentTranscriptMode,
    };
  } catch (error) {
    if (fs.existsSync(getSettingsPath())) {
      settingsIssues.push({
        code: "settings-read-failed",
        severity: "warning",
        title: "Could not read Vessel settings",
        detail:
          error instanceof Error ? error.message : "Unknown settings error.",
        action: "Falling back to built-in defaults for this launch.",
      });
    }
    settings = { ...defaults };
  }
  return settings!;
}

function persistNow(): Promise<void> {
  saveDirty = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return fs.promises
    .mkdir(path.dirname(getSettingsPath()), { recursive: true })
    .then(() =>
      fs.promises.writeFile(
        getSettingsPath(),
        JSON.stringify(buildPersistedSettings(settings!), null, 2),
      ),
    )
    .catch((err) => logger.error("Failed to save settings:", err));
}

function saveSettings(): void {
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (saveDirty) {
      void persistNow();
    }
  }, SAVE_DEBOUNCE_MS);
}

export function setSetting<K extends keyof VesselSettings>(
  key: K,
  value: VesselSettings[K],
): VesselSettings {
  loadSettings();
  if (key === "mcpPort") {
    settings!.mcpPort = sanitizePort(value);
  } else if (key === "chatProvider") {
    const nextProvider = value as VesselSettings["chatProvider"];
    if (!nextProvider) {
      clearStoredProviderSecret();
      settings!.chatProvider = null;
    } else {
      const existingSecret = readStoredProviderSecret();
      const incomingApiKey = nextProvider.apiKey.trim();
      const preserveExisting =
        !incomingApiKey &&
        nextProvider.hasApiKey === true &&
        existingSecret?.providerId === nextProvider.id;
      const resolvedApiKey = preserveExisting
        ? existingSecret?.apiKey || ""
        : incomingApiKey;

      if (resolvedApiKey) {
        writeStoredProviderSecret({
          providerId: nextProvider.id,
          apiKey: resolvedApiKey,
        });
      } else {
        clearStoredProviderSecret();
      }

      settings!.chatProvider = {
        ...nextProvider,
        apiKey: resolvedApiKey,
        hasApiKey: Boolean(resolvedApiKey),
        reasoningEffort: sanitizeReasoningEffortLevel(
          nextProvider.reasoningEffort,
        ),
      };
    }
  } else {
    settings![key] = value;
  }
  saveSettings();
  return { ...settings! };
}

export function flushPersist(): Promise<void> {
  return saveDirty ? persistNow() : Promise.resolve();
}
