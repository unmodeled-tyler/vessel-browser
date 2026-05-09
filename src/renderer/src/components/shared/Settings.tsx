import {
  createEffect,
  createSignal,
  Show,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

import { useUI } from "../../stores/ui";
import { useAnimatedPresence } from "../../lib/useAnimatedPresence";
import type {
  AgentTranscriptDisplayMode,
  PremiumState,
  ProviderId,
  ProviderConfig,
  ReasoningEffortLevel,
  RuntimeHealthState,
  SearchEngineId,
} from "../../../../shared/types";

import { createLogger } from "../../../../shared/logger";
import { PROVIDERS } from "../../../../shared/providers";
import { Globe, Cpu, Shield, Lock, User } from "lucide-solid";
import SettingsGeneral from "./SettingsGeneral";
import SettingsAgent from "./SettingsAgent";
import SettingsVaults from "./SettingsVaults";
import SettingsPrivacy from "./SettingsPrivacy";
import SettingsAccount from "./SettingsAccount";
import type {
  SettingsCategoryId,
  SessionSummary,
  VaultListEntry,
  HumanVaultEntry,
  AutofillListEntry,
} from "./settingsTypes";

const CHAT_PROVIDERS = Object.values(PROVIDERS).map((p) => ({
  id: p.id,
  name: p.name,
  type: p.type,
  requiresKey: p.requiresApiKey,
  needsBaseUrl: p.id === "llama_cpp" || p.id === "custom",
  defaultBaseUrl: p.defaultBaseUrl,
  keyPlaceholder: p.apiKeyPlaceholder,
  defaultModel: p.defaultModel,
  models: p.models,
}));

const logger = createLogger("Settings");

const Settings: Component = () => {
  const { settingsOpen, closeSettings } = useUI();
  const { visible: settingsVisible, closing: settingsClosing } = useAnimatedPresence(settingsOpen, 200);
  const [activeCategory, setActiveCategory] = createSignal<SettingsCategoryId>("general");
  let settingsContentEl: HTMLDivElement | undefined;

  const selectCategory = (category: SettingsCategoryId) => {
    setActiveCategory(category);
    queueMicrotask(() => {
      settingsContentEl?.scrollTo({ top: 0 });
    });
  };

  const [autoRestoreSession, setAutoRestoreSession] = createSignal(true);
  const [clearBookmarksOnLaunch, setClearBookmarksOnLaunch] =
    createSignal(false);
  const [obsidianVaultPath, setObsidianVaultPath] = createSignal("");
  const [mcpPort, setMcpPort] = createSignal("3100");
  const [maxToolIterations, setMaxToolIterations] = createSignal("200");
  const [agentTranscriptMode, setAgentTranscriptMode] =
    createSignal<AgentTranscriptDisplayMode>("summary");
  const [health, setHealth] = createSignal<RuntimeHealthState | null>(null);
  const [defaultUrl, setDefaultUrl] = createSignal("https://start.duckduckgo.com");
  const [defaultSearchEngine, setDefaultSearchEngine] = createSignal<SearchEngineId>("duckduckgo");
  const [downloadPath, setDownloadPath] = createSignal("");
  const [status, setStatus] = createSignal<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  // Telemetry
  const [telemetryEnabled, setTelemetryEnabled] = createSignal(true);

  // Theme
  const [theme, setTheme] = createSignal<"dark" | "light">("dark");

  // Domain policy
  const [domainMode, setDomainMode] = createSignal<"none" | "allowlist" | "blocklist">("none");
  const [domainList, setDomainList] = createSignal("");

  // Named sessions
  const [sessionList, setSessionList] = createSignal<SessionSummary[]>([]);
  const [sessionSaveName, setSessionSaveName] = createSignal("");

  const loadSessionList = async () => {
    try {
      const sessions = await window.vessel.sessions.list();
      setSessionList(sessions);
    } catch (err) {
      logger.warn("Failed to load named sessions list:", err);
    }
  };

  // Agent Credential Vault
  const [vaultEntries, setVaultEntries] = createSignal<VaultListEntry[]>([]);
  const [vaultExpanded, setVaultExpanded] = createSignal(false);
  const [vaultAdding, setVaultAdding] = createSignal(false);
  const [vaultNewLabel, setVaultNewLabel] = createSignal("");
  const [vaultNewDomain, setVaultNewDomain] = createSignal("");
  const [vaultNewUsername, setVaultNewUsername] = createSignal("");
  const [vaultNewPassword, setVaultNewPassword] = createSignal("");
  const [vaultNewTotp, setVaultNewTotp] = createSignal("");
  const [vaultNewNotes, setVaultNewNotes] = createSignal("");
  const [vaultMessage, setVaultMessage] = createSignal<{ kind: "success" | "error"; text: string } | null>(null);

  // Human Password Manager
  const [humanEntries, setHumanEntries] = createSignal<HumanVaultEntry[]>([]);
  const [humanAdding, setHumanAdding] = createSignal(false);
  const [humanNewTitle, setHumanNewTitle] = createSignal("");
  const [humanNewUrl, setHumanNewUrl] = createSignal("");
  const [humanNewUsername, setHumanNewUsername] = createSignal("");
  const [humanNewPassword, setHumanNewPassword] = createSignal("");
  const [humanNewNotes, setHumanNewNotes] = createSignal("");
  const [humanNewCategory, setHumanNewCategory] = createSignal("login");
  const [humanMessage, setHumanMessage] = createSignal<{ kind: "success" | "error"; text: string } | null>(null);

  const loadHumanEntries = async () => {
    try {
      const entries = await window.vessel.humanVault.list();
      setHumanEntries(entries);
    } catch (err) {
      logger.warn("Failed to load human vault entries:", err);
    }
  };

  const handleHumanAdd = async () => {
    if (!humanNewTitle().trim() || !humanNewUrl().trim() || !humanNewUsername().trim() || !humanNewPassword().trim()) {
      setHumanMessage({ kind: "error", text: "Title, URL, username, and password are required." });
      return;
    }
    try {
      await window.vessel.humanVault.save({
        title: humanNewTitle().trim(),
        url: humanNewUrl().trim(),
        username: humanNewUsername().trim(),
        password: humanNewPassword(),
        notes: humanNewNotes().trim() || undefined,
        category: humanNewCategory(),
      });
      setHumanMessage({ kind: "success", text: "Password saved." });
      setHumanAdding(false);
      setHumanNewTitle(""); setHumanNewUrl(""); setHumanNewUsername("");
      setHumanNewPassword(""); setHumanNewNotes(""); setHumanNewCategory("login");
      loadHumanEntries();
    } catch (err) {
      setHumanMessage({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to save.",
      });
    }
  };

  const handleHumanRemove = async (id: string) => {
    try {
      await window.vessel.humanVault.remove(id);
      loadHumanEntries();
    } catch (err) {
      logger.warn("Failed to remove human vault entry:", err);
    }
  };

  // Autofill Profiles
  const [autofillProfiles, setAutofillProfiles] = createSignal<AutofillListEntry[]>([]);
  const [autofillAdding, setAutofillAdding] = createSignal(false);
  const [autofillLabel, setAutofillLabel] = createSignal("");
  const [autofillFirstName, setAutofillFirstName] = createSignal("");
  const [autofillLastName, setAutofillLastName] = createSignal("");
  const [autofillEmail, setAutofillEmail] = createSignal("");
  const [autofillPhone, setAutofillPhone] = createSignal("");
  const [autofillOrg, setAutofillOrg] = createSignal("");
  const [autofillAddr1, setAutofillAddr1] = createSignal("");
  const [autofillAddr2, setAutofillAddr2] = createSignal("");
  const [autofillCity, setAutofillCity] = createSignal("");
  const [autofillState, setAutofillState] = createSignal("");
  const [autofillZip, setAutofillZip] = createSignal("");
  const [autofillCountry, setAutofillCountry] = createSignal("");
  const [autofillMessage, setAutofillMessage] = createSignal<{ kind: "success" | "error"; text: string } | null>(null);

  const loadAutofillProfiles = async () => {
    try {
      const profiles = await window.vessel.autofill.list();
      setAutofillProfiles(profiles);
    } catch (err) {
      logger.warn("Failed to load autofill profiles:", err);
    }
  };

  const handleAutofillAdd = async () => {
    if (!autofillLabel().trim()) {
      setAutofillMessage({ kind: "error", text: "Profile name is required." });
      return;
    }
    try {
      await window.vessel.autofill.add({
        label: autofillLabel().trim(),
        firstName: autofillFirstName().trim(),
        lastName: autofillLastName().trim(),
        email: autofillEmail().trim(),
        phone: autofillPhone().trim(),
        organization: autofillOrg().trim(),
        addressLine1: autofillAddr1().trim(),
        addressLine2: autofillAddr2().trim(),
        city: autofillCity().trim(),
        state: autofillState().trim(),
        postalCode: autofillZip().trim(),
        country: autofillCountry().trim(),
      });
      setAutofillLabel(""); setAutofillFirstName(""); setAutofillLastName("");
      setAutofillEmail(""); setAutofillPhone(""); setAutofillOrg("");
      setAutofillAddr1(""); setAutofillAddr2(""); setAutofillCity("");
      setAutofillState(""); setAutofillZip(""); setAutofillCountry("");
      setAutofillAdding(false);
      setAutofillMessage({ kind: "success", text: "Profile saved." });
      setTimeout(() => setAutofillMessage(null), 3000);
      await loadAutofillProfiles();
    } catch (err) {
      setAutofillMessage({ kind: "error", text: String(err) });
    }
  };

  const handleAutofillRemove = async (id: string) => {
    await window.vessel.autofill.delete(id);
    await loadAutofillProfiles();
  };

  const handleAutofillFill = async (id: string) => {
    try {
      const result = await window.vessel.autofill.fill(id);
      if (result.filled > 0) {
        setAutofillMessage({ kind: "success", text: `Filled ${result.filled} field${result.filled > 1 ? "s" : ""}.` });
      } else {
        setAutofillMessage({ kind: "error", text: "No matching fields found on this page." });
      }
      setTimeout(() => setAutofillMessage(null), 3000);
    } catch (err) {
      setAutofillMessage({ kind: "error", text: String(err) });
    }
  };

  // First-run detection
  const FIRST_RUN_KEY = "vessel.onboarding.dismissed";
  const [showWelcome, setShowWelcome] = createSignal(
    !localStorage.getItem(FIRST_RUN_KEY),
  );
  const dismissWelcome = () => {
    localStorage.setItem(FIRST_RUN_KEY, "1");
    setShowWelcome(false);
  };

  const loadVaultEntries = async () => {
    try {
      const entries = await window.vessel.vault.list();
      setVaultEntries(entries);
    } catch (err) {
      logger.warn("Failed to load vault entries:", err);
    }
  };

  const handleVaultAdd = async () => {
    if (!vaultNewLabel().trim() || !vaultNewDomain().trim() || !vaultNewUsername().trim() || !vaultNewPassword().trim()) {
      setVaultMessage({ kind: "error", text: "Label, domain, username, and password are required." });
      return;
    }
    try {
      await window.vessel.vault.add({
        label: vaultNewLabel().trim(),
        domainPattern: vaultNewDomain().trim(),
        username: vaultNewUsername().trim(),
        password: vaultNewPassword().trim(),
        totpSecret: vaultNewTotp().trim() || undefined,
        notes: vaultNewNotes().trim() || undefined,
      });
      setVaultNewLabel(""); setVaultNewDomain(""); setVaultNewUsername("");
      setVaultNewPassword(""); setVaultNewTotp(""); setVaultNewNotes("");
      setVaultAdding(false);
      setVaultMessage({ kind: "success", text: "Credential added." });
      await loadVaultEntries();
    } catch (err) {
      setVaultMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to add credential." });
    }
  };

  const handleVaultRemove = async (id: string) => {
    try {
      await window.vessel.vault.remove(id);
      await loadVaultEntries();
      setVaultMessage({ kind: "success", text: "Credential removed." });
    } catch (err) {
      logger.warn("Failed to remove credential:", err);
      setVaultMessage({ kind: "error", text: "Failed to remove credential." });
    }
  };

  // Premium subscription
  const [premiumState, setPremiumState] = createSignal<PremiumState>({
    status: "free",
    customerId: "",
    verificationToken: "",
    email: "",
    validatedAt: "",
    expiresAt: "",
  });
  const [premiumEmail, setPremiumEmail] = createSignal("");
  const [premiumCode, setPremiumCode] = createSignal("");
  const [premiumChallengeToken, setPremiumChallengeToken] = createSignal("");
  const [premiumCodeSent, setPremiumCodeSent] = createSignal(false);
  const [premiumLoading, setPremiumLoading] = createSignal(false);
  const [premiumMessage, setPremiumMessage] = createSignal<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  let trackedSettingsPremiumBanner = false;

  const premiumActive = () => {
    const s = premiumState().status;
    return s === "active" || s === "trialing";
  };

  const trackPremiumContext = (
    step:
      | "settings_banner_viewed"
      | "settings_banner_clicked"
      | "welcome_banner_clicked",
  ) =>
    window.vessel.premium.trackContext(step).catch((err) => {
      logger.warn("Failed to track premium context:", err);
    });

  const startPremiumCheckout = () => {
    void window.vessel.premium.checkout(premiumEmail().trim() || undefined);
  };

  const resetPremiumActivationFlow = () => {
    setPremiumCode("");
    setPremiumChallengeToken("");
    setPremiumCodeSent(false);
  };

  // Chat provider settings
  const [chatEnabled, setChatEnabled] = createSignal(false);
  const [chatProviderId, setChatProviderId] = createSignal<ProviderId>("anthropic");
  const [chatApiKey, setChatApiKey] = createSignal("");
  const [chatHasStoredApiKey, setChatHasStoredApiKey] = createSignal(false);
  const [chatModel, setChatModel] = createSignal("");
  const [chatBaseUrl, setChatBaseUrl] = createSignal("");
  const [chatReasoningEffort, setChatReasoningEffort] =
    createSignal<ReasoningEffortLevel>("off");

  const chatProviderMeta = () => CHAT_PROVIDERS.find((p) => p.id === chatProviderId()) ?? CHAT_PROVIDERS[0];

  const providerType = () => chatProviderMeta()?.type;

  const [providerModels, setProviderModels] = createSignal<string[]>([]);
  const [modelFetchState, setModelFetchState] = createSignal<"idle" | "loading" | "error">("idle");
  const [modelFetchWarning, setModelFetchWarning] = createSignal<string | null>(null);
  const [codexAuthStatus, setCodexAuthStatus] = createSignal<"idle" | "waiting" | "exchanging" | "connected" | "error">("idle");
  const [codexAccountEmail, setCodexAccountEmail] = createSignal("");
  const [codexAuthError, setCodexAuthError] = createSignal("");

  const resetProviderModels = () => {
    setProviderModels([]);
    setModelFetchState("idle");
    setModelFetchWarning(null);
  };

  const doFetchModels = () => {
    const meta = chatProviderMeta();
    // Need a key for providers that require one
    if (meta.requiresKey && !chatApiKey().trim()) {
      setProviderModels([]);
      setModelFetchState("idle");
      setModelFetchWarning(null);
      return;
    }
    setModelFetchState("loading");
    setModelFetchWarning(null);
    window.vessel.ai.fetchModels({
      id: chatProviderId(),
      apiKey: chatApiKey().trim(),
      model: "",
      baseUrl: chatBaseUrl().trim() || meta.defaultBaseUrl || undefined,
    }).then(({ ok, models, warning }) => {
      if (ok) {
        setProviderModels(models.sort());
        if (models.length > 0 && (!chatModel() || !models.includes(chatModel()))) {
          setChatModel(models[0]);
        }
        setModelFetchWarning(warning ?? null);
        setModelFetchState("idle");
      } else {
        setProviderModels([]);
        setModelFetchWarning(null);
        setModelFetchState("error");
      }
    }).catch((err) => {
      logger.warn("Failed to fetch provider models:", err);
      setProviderModels([]);
      setModelFetchWarning(null);
      setModelFetchState("error");
    });
  };

  const startCodexAuth = async () => {
    setCodexAuthStatus("waiting");
    setCodexAuthError("");
    try {
      const result = await window.vessel.codex.startAuth();
      if (result.ok) {
        setCodexAccountEmail(result.accountEmail);
        setCodexAuthStatus("connected");
        setChatHasStoredApiKey(true);
      } else {
        setCodexAuthStatus("error");
        setCodexAuthError(result.error);
      }
    } catch (err) {
      setCodexAuthStatus("error");
      setCodexAuthError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const disconnectCodex = async () => {
    await window.vessel.codex.disconnect();
    setCodexAuthStatus("idle");
    setCodexAccountEmail("");
    setChatHasStoredApiKey(false);
  };

  // Auto-fetch when provider switches or when api key is filled in
  createEffect(() => {
    if (!chatEnabled()) return;
    const meta = chatProviderMeta();
    chatProviderId(); // track
    if (!meta.requiresKey) {
      doFetchModels();
    }
  });

  // When key is provided for a keyed provider, fetch on provider switch
  createEffect(() => {
    if (!chatEnabled()) return;
    const meta = chatProviderMeta();
    if (meta.requiresKey && chatApiKey().trim()) {
      doFetchModels();
    }
  });

  const loadState = async () => {
    const settings = await window.vessel.settings.get();
    const runtimeHealth = await window.vessel.settings.getHealth();
    setTheme(settings.theme ?? "dark");
    setDefaultUrl(settings.defaultUrl ?? "https://start.duckduckgo.com");
    setDefaultSearchEngine(settings.defaultSearchEngine ?? "duckduckgo");
    setDownloadPath(settings.downloadPath ?? "");
    setAutoRestoreSession(settings.autoRestoreSession ?? true);
    setClearBookmarksOnLaunch(settings.clearBookmarksOnLaunch ?? false);
    setObsidianVaultPath(settings.obsidianVaultPath ?? "");
    setMcpPort(String(settings.mcpPort ?? 3100));
    setMaxToolIterations(String(settings.maxToolIterations ?? 200));
    setAgentTranscriptMode(settings.agentTranscriptMode ?? "summary");
    setHealth(runtimeHealth);
    const cp = settings.chatProvider ?? null;
    setChatEnabled(cp !== null);
    if (cp) {
      setChatProviderId(cp.id);
      setChatApiKey("");
      setChatHasStoredApiKey(cp.hasApiKey === true);
      setChatModel(cp.model);
      setChatBaseUrl(cp.baseUrl ?? "");
      setChatReasoningEffort(cp.reasoningEffort ?? "off");
    } else {
      setChatApiKey("");
      setChatHasStoredApiKey(false);
      setChatReasoningEffort("off");
    }
    if (cp?.id === "openai_codex" && cp.hasApiKey) {
      setCodexAuthStatus("connected");
    }
    setTelemetryEnabled(settings.telemetryEnabled !== false);
    // Load domain policy
    const dp = settings.domainPolicy ?? { allowedDomains: [], blockedDomains: [] };
    if (dp.allowedDomains.length > 0) {
      setDomainMode("allowlist");
      setDomainList(dp.allowedDomains.join("\n"));
    } else if (dp.blockedDomains.length > 0) {
      setDomainMode("blocklist");
      setDomainList(dp.blockedDomains.join("\n"));
    } else {
      setDomainMode("none");
      setDomainList("");
    }
    // Load premium state
    try {
      const ps = await window.vessel.premium.getState();
      setPremiumState(ps);
      if (ps.email) setPremiumEmail(ps.email);
    } catch (err) {
      logger.warn("Failed to load premium state:", err);
    }
    // Load vault entries
    await loadVaultEntries();
    await loadHumanEntries();
    // Load named sessions
    await loadSessionList();
  };

  onMount(() => {
    void loadState();
    void loadAutofillProfiles();
    const unsubscribe = window.vessel.settings.onHealthUpdate((nextHealth) => {
      setHealth(nextHealth);
    });
    const unsubscribePremium = window.vessel.premium.onUpdate((nextState) => {
      setPremiumState(nextState);
      if (nextState.email) {
        setPremiumEmail(nextState.email);
      }
      if (nextState.status === "active" || nextState.status === "trialing") {
        resetPremiumActivationFlow();
        setPremiumMessage({
          kind: "success",
          text:
            nextState.status === "trialing"
              ? "Premium trial active. Enjoy the unlocked toolkit."
              : "Premium activated. Your premium tools are ready.",
        });
      }
    });
    const unsubCodex = window.vessel.codex.onAuthStatus((payload) => {
      if (payload.status === "waiting") {
        setCodexAuthStatus("waiting");
      } else if (payload.status === "exchanging") {
        setCodexAuthStatus("exchanging");
      } else if (payload.status === "error") {
        setCodexAuthStatus("error");
        setCodexAuthError(payload.error || "Unknown error");
      }
    });
    onCleanup(() => {
      unsubscribe();
      unsubscribePremium();
      unsubCodex();
    });
  });

  createEffect(() => {
    if (settingsOpen()) {
      void loadState();
    }
  });

  createEffect(() => {
    if (settingsOpen() && !premiumActive() && !trackedSettingsPremiumBanner) {
      trackedSettingsPremiumBanner = true;
      void window.vessel.premium.trackContext("settings_banner_viewed");
    }
  });

  const handleSave = async () => {
    try {
      const parsedPort = Number(mcpPort().trim());
      if (
        !Number.isInteger(parsedPort) ||
        parsedPort < 1 ||
        parsedPort > 65535
      ) {
        setStatus({
          kind: "error",
          text: "MCP port must be an integer between 1 and 65535.",
        });
        return;
      }

      await window.vessel.settings.set("theme", theme());
      await window.vessel.settings.set("downloadPath", downloadPath().trim());
      await window.vessel.settings.set(
        "defaultUrl",
        defaultUrl().trim() || "https://start.duckduckgo.com",
      );
      await window.vessel.settings.set(
        "autoRestoreSession",
        autoRestoreSession(),
      );
      await window.vessel.settings.set(
        "clearBookmarksOnLaunch",
        clearBookmarksOnLaunch(),
      );
      await window.vessel.settings.set(
        "obsidianVaultPath",
        obsidianVaultPath(),
      );
      await window.vessel.settings.set("mcpPort", parsedPort);
      const parsedIterations = Number(maxToolIterations().trim()) || 200;
      await window.vessel.settings.set(
        "maxToolIterations",
        Math.max(10, Math.min(1000, parsedIterations)),
      );
      await window.vessel.settings.set(
        "agentTranscriptMode",
        agentTranscriptMode(),
      );
      await window.vessel.settings.set("telemetryEnabled", telemetryEnabled());
      await window.vessel.settings.set("defaultSearchEngine", defaultSearchEngine());
      // Save domain policy
      const domains = domainList().split("\n").map(d => d.trim()).filter(d => d.length > 0);
      const domainPolicy = domainMode() === "allowlist"
        ? { allowedDomains: domains, blockedDomains: [] }
        : domainMode() === "blocklist"
          ? { allowedDomains: [], blockedDomains: domains }
          : { allowedDomains: [], blockedDomains: [] };
      await window.vessel.settings.set("domainPolicy", domainPolicy);
      const chatConfig: ProviderConfig | null = chatEnabled()
        ? {
            id: chatProviderId(),
            apiKey: chatApiKey().trim(),
            hasApiKey: chatHasStoredApiKey() && !chatApiKey().trim(),
            model: chatModel().trim() || chatProviderMeta().defaultModel,
            baseUrl: chatBaseUrl().trim() || undefined,
            reasoningEffort: chatReasoningEffort(),
          }
        : null;
      await window.vessel.settings.set("chatProvider", chatConfig);
      await loadState();
      setStatus({
        kind: "success",
        text: "Saved. MCP server settings are applied immediately.",
      });
    } catch (error) {
      setStatus({
        kind: "error",
        text:
          error instanceof Error ? error.message : "Failed to save settings.",
      });
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeSettings();
  };

  return (
    <Show when={settingsVisible()}>
      <div class="command-bar-overlay" classList={{ closing: settingsClosing() }} onClick={closeSettings}>
        <div
          class="settings-panel"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          <h2 class="settings-title">Runtime Settings</h2>

          <Show when={!premiumActive()}>
            <div class="settings-compact-upsell">
              <span class="settings-compact-upsell-text">
                Premium: screenshots, saved sessions, credential vault, and longer autonomous runs.
              </span>
              <div class="settings-compact-upsell-actions">
                <button
                  class="premium-btn premium-btn-upgrade"
                  onClick={() => {
                    void trackPremiumContext("settings_banner_clicked");
                    startPremiumCheckout();
                  }}
                >
                  Try free for 7 days
                </button>
                <button
                  class="premium-btn premium-btn-activate"
                  onClick={() => selectCategory("account")}
                >
                  Activate
                </button>
              </div>
            </div>
          </Show>

          <div class="settings-layout">
            <nav class="settings-sidebar" role="navigation" aria-label="Settings categories">
              <button
                class="settings-nav-item"
                classList={{ active: activeCategory() === "general" }}
                onClick={() => selectCategory("general")}
                aria-current={activeCategory() === "general" ? "page" : undefined}
              >
                <Globe size={16} />
                <span>General</span>
              </button>
              <button
                class="settings-nav-item"
                classList={{ active: activeCategory() === "agent" }}
                onClick={() => selectCategory("agent")}
                aria-current={activeCategory() === "agent" ? "page" : undefined}
              >
                <Cpu size={16} />
                <span>AI & Agent</span>
              </button>
              <button
                class="settings-nav-item"
                classList={{ active: activeCategory() === "vaults" }}
                onClick={() => selectCategory("vaults")}
                aria-current={activeCategory() === "vaults" ? "page" : undefined}
              >
                <Shield size={16} />
                <span>Vaults</span>
              </button>
              <button
                class="settings-nav-item"
                classList={{ active: activeCategory() === "privacy" }}
                onClick={() => selectCategory("privacy")}
                aria-current={activeCategory() === "privacy" ? "page" : undefined}
              >
                <Lock size={16} />
                <span>Privacy</span>
              </button>
              <button
                class="settings-nav-item"
                classList={{ active: activeCategory() === "account" }}
                onClick={() => selectCategory("account")}
                aria-current={activeCategory() === "account" ? "page" : undefined}
              >
                <User size={16} />
                <span>Account</span>
              </button>
            </nav>

            <div class="settings-content" ref={settingsContentEl}>
              <Show when={activeCategory() === "general"}>
                <SettingsGeneral
                  welcomeBanner={{ show: showWelcome, dismiss: dismissWelcome }}
                  defaultUrl={defaultUrl}
                  setDefaultUrl={setDefaultUrl}
                  defaultSearchEngine={defaultSearchEngine}
                  setDefaultSearchEngine={setDefaultSearchEngine}
                  downloadPath={downloadPath}
                  setDownloadPath={setDownloadPath}
                  theme={theme}
                  setTheme={setTheme}
                  autoRestoreSession={autoRestoreSession}
                  setAutoRestoreSession={setAutoRestoreSession}
                  clearBookmarksOnLaunch={clearBookmarksOnLaunch}
                  setClearBookmarksOnLaunch={setClearBookmarksOnLaunch}
                  premiumActive={premiumActive}
                  startPremiumCheckout={startPremiumCheckout}
                />
              </Show>
              <Show when={activeCategory() === "agent"}>
                <SettingsAgent
                  chat={{
                    enabled: chatEnabled,
                    setEnabled: setChatEnabled,
                    providerId: chatProviderId,
                    setProviderId: setChatProviderId,
                    apiKey: chatApiKey,
                    setApiKey: setChatApiKey,
                    hasStoredApiKey: chatHasStoredApiKey,
                    setHasStoredApiKey: setChatHasStoredApiKey,
                    model: chatModel,
                    setModel: setChatModel,
                    baseUrl: chatBaseUrl,
                    setBaseUrl: setChatBaseUrl,
                    reasoningEffort: chatReasoningEffort,
                    setReasoningEffort: setChatReasoningEffort,
                    providerModels,
                    modelFetchState,
                    modelFetchWarning,
                    doFetchModels,
                    resetProviderModels,
                    codexAuthStatus,
                    codexAccountEmail,
                    setCodexAccountEmail,
                    codexAuthError,
                    setCodexAuthError,
                    providerType,
                    startCodexAuth,
                    disconnectCodex,
                  }}
                  mcpPort={mcpPort}
                  setMcpPort={setMcpPort}
                  maxToolIterations={maxToolIterations}
                  setMaxToolIterations={setMaxToolIterations}
                  agentTranscriptMode={agentTranscriptMode}
                  setAgentTranscriptMode={setAgentTranscriptMode}
                  obsidianVaultPath={obsidianVaultPath}
                  setObsidianVaultPath={setObsidianVaultPath}
                  health={health}
                  premiumActive={premiumActive}
                />
              </Show>
              <Show when={activeCategory() === "vaults"}>
                <SettingsVaults
                  premiumActive={premiumActive}
                  vault={{
                    entries: vaultEntries,
                    expanded: vaultExpanded,
                    setExpanded: setVaultExpanded,
                    adding: vaultAdding,
                    setAdding: setVaultAdding,
                    newLabel: vaultNewLabel,
                    setNewLabel: setVaultNewLabel,
                    newDomain: vaultNewDomain,
                    setNewDomain: setVaultNewDomain,
                    newUsername: vaultNewUsername,
                    setNewUsername: setVaultNewUsername,
                    newPassword: vaultNewPassword,
                    setNewPassword: setVaultNewPassword,
                    newTotp: vaultNewTotp,
                    setNewTotp: setVaultNewTotp,
                    newNotes: vaultNewNotes,
                    setNewNotes: setVaultNewNotes,
                    message: vaultMessage,
                    setMessage: setVaultMessage,
                    handleAdd: handleVaultAdd,
                    handleRemove: handleVaultRemove,
                  }}
                  humanVault={{
                    entries: humanEntries,
                    adding: humanAdding,
                    setAdding: setHumanAdding,
                    newTitle: humanNewTitle,
                    setNewTitle: setHumanNewTitle,
                    newUrl: humanNewUrl,
                    setNewUrl: setHumanNewUrl,
                    newUsername: humanNewUsername,
                    setNewUsername: setHumanNewUsername,
                    newPassword: humanNewPassword,
                    setNewPassword: setHumanNewPassword,
                    newCategory: humanNewCategory,
                    setNewCategory: setHumanNewCategory,
                    newNotes: humanNewNotes,
                    setNewNotes: setHumanNewNotes,
                    message: humanMessage,
                    handleAdd: handleHumanAdd,
                    handleRemove: handleHumanRemove,
                  }}
                  autofill={{
                    profiles: autofillProfiles,
                    adding: autofillAdding,
                    setAdding: setAutofillAdding,
                    label: autofillLabel,
                    setLabel: setAutofillLabel,
                    firstName: autofillFirstName,
                    setFirstName: setAutofillFirstName,
                    lastName: autofillLastName,
                    setLastName: setAutofillLastName,
                    email: autofillEmail,
                    setEmail: setAutofillEmail,
                    phone: autofillPhone,
                    setPhone: setAutofillPhone,
                    organization: autofillOrg,
                    setOrganization: setAutofillOrg,
                    addressLine1: autofillAddr1,
                    setAddressLine1: setAutofillAddr1,
                    addressLine2: autofillAddr2,
                    setAddressLine2: setAutofillAddr2,
                    city: autofillCity,
                    setCity: setAutofillCity,
                    state: autofillState,
                    setState: setAutofillState,
                    postalCode: autofillZip,
                    setPostalCode: setAutofillZip,
                    country: autofillCountry,
                    setCountry: setAutofillCountry,
                    message: autofillMessage,
                    handleAdd: handleAutofillAdd,
                    handleRemove: handleAutofillRemove,
                    handleFill: handleAutofillFill,
                  }}
                />
              </Show>
              <Show when={activeCategory() === "privacy"}>
                <SettingsPrivacy
                  telemetryEnabled={telemetryEnabled}
                  setTelemetryEnabled={setTelemetryEnabled}
                  domainMode={domainMode}
                  setDomainMode={setDomainMode}
                  domainList={domainList}
                  setDomainList={setDomainList}
                />
              </Show>
              <Show when={activeCategory() === "account"}>
                <SettingsAccount
                  premium={{
                    state: premiumState,
                    setState: setPremiumState,
                    email: premiumEmail,
                    setEmail: setPremiumEmail,
                    code: premiumCode,
                    setCode: setPremiumCode,
                    challengeToken: premiumChallengeToken,
                    setChallengeToken: setPremiumChallengeToken,
                    codeSent: premiumCodeSent,
                    setCodeSent: setPremiumCodeSent,
                    loading: premiumLoading,
                    setLoading: setPremiumLoading,
                    message: premiumMessage,
                    setMessage: setPremiumMessage,
                    active: premiumActive,
                    startCheckout: startPremiumCheckout,
                    resetFlow: resetPremiumActivationFlow,
                  }}
                  sessions={{
                    list: sessionList,
                    saveName: sessionSaveName,
                    setSaveName: setSessionSaveName,
                    loadList: loadSessionList,
                  }}
                  setStatus={setStatus}
                />
              </Show>
            </div>
          </div>

          <div class="settings-actions">
            <button class="settings-save" onClick={handleSave}>
              Save
            </button>
            <button class="settings-close" onClick={closeSettings}>
              Close
            </button>
          </div>

          <Show when={status()}>
            {(currentStatus) => (
              <p
                class="settings-status"
                classList={{
                  success: currentStatus().kind === "success",
                  error: currentStatus().kind === "error",
                }}
              >
                {currentStatus().text}
              </p>
            )}
          </Show>
        </div>
      </div>

      <style>{`
        .settings-panel {
          width: min(820px, calc(100vw - 32px));
          max-height: calc(100vh - 48px);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: var(--bg-elevated);
          border: 1px solid var(--border-visible);
          border-radius: 14px;
          padding: 28px 24px 24px;
          overscroll-behavior: contain;
          box-shadow:
            0 4px 24px var(--shadow-color),
            0 24px 64px var(--shadow-color-strong),
            inset 0 1px 0 var(--inset-highlight);
          animation: command-bar-enter 350ms var(--ease-out-expo) both;
        }
        .command-bar-overlay.closing .settings-panel {
          animation: command-bar-exit 200ms var(--ease-in-out) both;
        }
        .settings-title {
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 22px;
          letter-spacing: 0.01em;
          flex-shrink: 0;
        }

        /* Compact global upsell */
        .settings-compact-upsell {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 8px 14px;
          margin-bottom: 16px;
          border-radius: var(--radius-md);
          background: color-mix(in srgb, var(--accent-primary) 8%, transparent);
          border: 1px solid color-mix(in srgb, var(--accent-primary) 18%, transparent);
        }
        .settings-compact-upsell-text {
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.4;
        }
        .settings-compact-upsell-actions {
          display: flex;
          gap: 8px;
          flex-shrink: 0;
        }
        .settings-compact-upsell-actions .premium-btn {
          font-size: 11px;
          padding: 4px 12px;
          height: auto;
        }

        /* Sidebar + Content layout */
        .settings-layout {
          flex: 1;
          min-height: 0;
          display: flex;
          gap: 0;
        }
        .settings-sidebar {
          width: 170px;
          flex-shrink: 0;
          border-right: 1px solid var(--border-subtle);
          padding: 8px 8px 8px 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .settings-nav-item {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          padding: 8px 12px;
          border-radius: var(--radius-md);
          font-size: 12px;
          color: var(--text-secondary);
          background: transparent;
          border: none;
          cursor: pointer;
          transition: background var(--duration-fast), color var(--duration-fast);
          text-align: left;
        }
        .settings-nav-item:hover {
          background: var(--surface-hover);
          color: var(--text-primary);
        }
        .settings-nav-item:focus-visible {
          outline: 1px solid var(--accent-primary);
          outline-offset: -1px;
        }
        .settings-nav-item.active {
          background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
          color: var(--accent-primary);
          font-weight: 500;
        }
        .settings-nav-item svg {
          flex-shrink: 0;
        }
        .settings-content {
          flex: 1;
          min-width: 0;
          overflow-y: auto;
          padding: 0 0 0 20px;
          overscroll-behavior: contain;
          scrollbar-gutter: stable;
        }
        .settings-category-panel {
          /* wrapper for each category's content */
        }

        /* Mobile: stack sidebar above content */
        @media (max-width: 700px) {
          .settings-panel {
            width: min(440px, calc(100vw - 32px));
          }
          .settings-layout {
            flex-direction: column;
          }
          .settings-sidebar {
            flex-direction: row;
            width: 100%;
            border-right: none;
            border-bottom: 1px solid var(--border-subtle);
            padding: 0 0 8px 0;
            margin-bottom: 12px;
            overflow-x: auto;
            gap: 2px;
          }
          .settings-nav-item {
            flex-shrink: 0;
            width: auto;
            padding: 6px 10px;
            font-size: 11px;
          }
          .settings-nav-item span {
            display: none;
          }
          .settings-content {
            padding-left: 0;
          }
        }

        .settings-callout {
          margin-bottom: 20px;
          padding: 14px;
          border-radius: var(--radius-md);
          border: 1px solid color-mix(in srgb, var(--accent-primary) 14%, transparent);
          background: color-mix(in srgb, var(--accent-primary) 6%, transparent);
        }
        .settings-callout-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 6px;
          letter-spacing: 0.01em;
        }
        .settings-callout-copy {
          font-size: 12px;
          line-height: 1.55;
          color: var(--text-secondary);
          margin: 0;
        }
        .settings-premium-callout {
          background:
            radial-gradient(circle at top right, color-mix(in srgb, var(--accent-primary) 16%, transparent), transparent 40%),
            color-mix(in srgb, var(--accent-primary) 6%, transparent);
          border-color: color-mix(in srgb, var(--accent-primary) 22%, transparent);
        }
        .settings-premium-callout-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 12px;
        }
        .settings-field {
          margin-bottom: 18px;
        }
        .settings-health {
          margin-bottom: 20px;
          padding: 14px;
          border-radius: var(--radius-md);
          border: 1px solid var(--border-visible);
          background: var(--surface-glass);
        }
        .settings-health-issues {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 10px;
        }
        .settings-health-issue {
          font-size: 12px;
          line-height: 1.5;
          padding: 10px 12px;
          border-radius: var(--radius-md);
          border: 1px solid var(--border-glass);
          color: var(--text-secondary);
        }
        .settings-health-issue.warning {
          border-color: color-mix(in srgb, var(--accent-primary) 28%, transparent);
          background: color-mix(in srgb, var(--accent-primary) 6%, transparent);
        }
        .settings-health-issue.error {
          border-color: color-mix(in srgb, var(--status-error) 32%, transparent);
          background: color-mix(in srgb, var(--status-error) 6%, transparent);
        }
        .settings-inline-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 8px;
        }
        .settings-secondary-btn {
          height: 32px;
          padding: 0 12px;
          border-radius: var(--radius-md);
          border: 1px solid var(--border-visible);
          background: var(--surface-glass);
          color: var(--text-primary);
          font-size: 12px;
          cursor: pointer;
        }
        .settings-secondary-btn:hover:not(:disabled) {
          background: var(--bg-tertiary);
        }
        .settings-secondary-btn:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .settings-label {
          display: block;
          font-size: 12px;
          color: var(--text-secondary);
          margin-bottom: 6px;
          font-weight: 500;
          letter-spacing: 0.01em;
        }
        .settings-label-optional {
          font-size: 11px;
          color: var(--text-muted);
          font-style: italic;
        }
        .settings-input {
          width: 100%;
          height: 34px;
          padding: 0 10px;
          margin: 0;
          border-radius: var(--radius-md);
          border: 1px solid var(--border-visible);
          background: var(--surface-glass);
          color: var(--text-primary);
          font-family: "JetBrains Mono", "SF Mono", "Fira Code", monospace;
          font-size: 12px;
          line-height: 1;
          box-sizing: border-box;
          text-rendering: auto;
        }
        .settings-select {
          appearance: none;
          padding-right: 30px;
          background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 10px center;
        }
        .settings-textarea {
          width: 100%;
          padding: 8px 10px;
          margin: 0;
          border-radius: var(--radius-md);
          border: 1px solid var(--border-visible);
          background: var(--surface-glass);
          color: var(--text-primary);
          font-family: "JetBrains Mono", "SF Mono", "Fira Code", monospace;
          font-size: 12px;
          min-height: 120px;
          resize: vertical;
          box-sizing: border-box;
          line-height: 1.5;
        }
        .settings-input:focus,
        .settings-textarea:focus {
          outline: none;
          border-color: var(--accent-primary);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-primary) 18%, transparent);
        }
        .settings-hint {
          font-size: 11px;
          color: var(--text-muted);
          margin-top: 4px;
          line-height: 1.5;
        }
        .settings-hint code {
          font-size: 11px;
          background: var(--bg-tertiary);
          padding: 1px 5px;
          border-radius: 3px;
        }
        .settings-toggle {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          font-size: 12px;
          color: var(--text-secondary);
          cursor: pointer;
          user-select: none;
        }
        .toggle-switch {
          position: relative;
          display: inline-block;
          width: 36px;
          height: 20px;
          border-radius: 10px;
          background: color-mix(in srgb, var(--text-muted) 40%, transparent);
          border: none;
          cursor: pointer;
          flex-shrink: 0;
          transition: background var(--duration-fast);
        }
        .toggle-switch:hover {
          background: color-mix(in srgb, var(--text-muted) 60%, transparent);
        }
        .toggle-switch.on {
          background: var(--accent-primary);
        }
        .toggle-switch.on:hover {
          background: var(--button-primary-hover-bg);
        }
        .toggle-switch-thumb {
          position: absolute;
          top: 3px;
          left: 3px;
          width: 14px;
          height: 14px;
          border-radius: 7px;
          background: #fff;
          transition: transform var(--duration-fast);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
        }
        .toggle-switch.on .toggle-switch-thumb {
          transform: translateX(16px);
        }
        .settings-status {
          margin-top: 12px;
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.5;
        }
        .settings-status.success {
          color: var(--status-success, #52c41a);
        }
        .settings-status.error {
          color: var(--status-error, #f43f5e);
        }
        .settings-actions {
          display: flex;
          gap: 10px;
          justify-content: flex-end;
          margin-top: 20px;
          flex-shrink: 0;
        }
        .settings-save {
          height: 34px;
          padding: 0 18px;
          border-radius: var(--radius-md);
          border: none;
          font-size: 12px;
          font-weight: 600;
          background: var(--accent-primary);
          color: var(--button-primary-fg);
          cursor: pointer;
          transition: background var(--duration-fast);
        }
        .settings-save:hover {
          background: var(--button-primary-hover-bg);
        }
        .settings-close {
          height: 34px;
          padding: 0 18px;
          border-radius: var(--radius-md);
          border: 1px solid var(--border-visible);
          font-size: 12px;
          background: var(--surface-glass);
          color: var(--text-secondary);
          cursor: pointer;
          transition: background var(--duration-fast);
        }
        .settings-close:hover {
          background: var(--surface-hover);
        }
        .settings-refresh-btn {
          width: 32px;
          height: 32px;
          border: 1px solid var(--border-visible);
          border-radius: var(--radius-md);
          background: var(--surface-glass);
          color: var(--text-secondary);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background var(--duration-fast);
          flex-shrink: 0;
        }
        .settings-refresh-btn:hover {
          background: var(--surface-hover);
        }
        .settings-refresh-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .settings-input-disabled {
          display: flex;
          align-items: center;
          width: 100%;
          height: 34px;
          padding: 0 10px;
          border-radius: var(--radius-md);
          border: 1px solid var(--border-subtle);
          background: var(--bg-tertiary);
          color: var(--text-muted);
          font-size: 12px;
          opacity: 0.7;
          cursor: not-allowed;
        }

        /* --- Premium section --- */
        .premium-section {
          display: flex;
          flex-direction: column;
        }
        .premium-description {
          font-size: 12px;
          line-height: 1.6;
          color: var(--text-secondary);
          margin: 0 0 12px;
        }
        .premium-activate-row {
          display: flex;
          gap: 10px;
          align-items: center;
        }
        .premium-email-input {
          flex: 1;
        }
        .premium-btn {
          height: 34px;
          padding: 0 16px;
          border-radius: var(--radius-md);
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: background var(--duration-fast), transform var(--duration-fast);
          white-space: nowrap;
        }
        .premium-btn:active {
          transform: scale(0.97);
        }
        .premium-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .premium-btn-activate {
          background: var(--surface-glass);
          border: 1px solid var(--border-visible);
          color: var(--text-primary);
        }
        .premium-btn-activate:hover {
          background: var(--surface-hover);
        }
        .premium-btn-upgrade {
          background: var(--accent-primary);
          border: none;
          color: var(--button-primary-fg);
        }
        .premium-btn-upgrade:hover {
          background: var(--button-primary-hover-bg);
        }
        .premium-btn-manage {
          background: var(--surface-glass);
          border: 1px solid var(--border-visible);
          color: var(--text-primary);
          align-self: flex-start;
        }
        .premium-btn-manage:hover {
          background: var(--surface-hover);
        }
        .premium-active-badge {
          display: inline-block;
          font-size: 11px;
          font-weight: 600;
          color: var(--button-primary-fg);
          background: var(--status-success, #52c41a);
          padding: 2px 10px;
          border-radius: 4px;
          margin-bottom: 10px;
        }
        .premium-detail {
          font-size: 11px;
          color: var(--text-muted);
          margin: 6px 0;
        }
        .premium-actions-row {
          display: flex;
          gap: 10px;
          margin-top: 10px;
        }
        .premium-btn-reset {
          height: 30px;
          padding: 0 12px;
          border-radius: var(--radius-md);
          border: 1px solid var(--border-subtle);
          background: transparent;
          color: var(--text-muted);
          font-size: 11px;
          cursor: pointer;
        }
        .premium-btn-reset:hover {
          background: var(--surface-hover);
        }

        /* Welcome banner */
        .welcome-banner {
          margin-bottom: 20px;
          padding: 16px;
          border-radius: var(--radius-md);
          border: 1px solid color-mix(in srgb, var(--accent-primary) 22%, transparent);
          background: color-mix(in srgb, var(--accent-primary) 8%, transparent);
        }
        .welcome-banner-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        .welcome-banner-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--accent-primary);
        }
        .welcome-banner-dismiss {
          width: 24px;
          height: 24px;
          border-radius: 4px;
          background: transparent;
          border: none;
          color: var(--text-muted);
          font-size: 18px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .welcome-banner-dismiss:hover {
          background: var(--surface-hover);
          color: var(--text-primary);
        }
        .welcome-banner-text {
          font-size: 12px;
          color: var(--text-secondary);
          margin: 0 0 8px;
        }
        .welcome-banner-steps {
          margin: 8px 0 0 16px;
          padding: 0;
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.7;
        }
        .welcome-banner-steps li.done {
          color: var(--text-muted);
          text-decoration: line-through;
        }
        .welcome-banner-steps kbd {
          display: inline-block;
          padding: 1px 5px;
          font-size: 11px;
          font-family: "JetBrains Mono", "SF Mono", monospace;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-subtle);
          border-radius: 3px;
          margin: 0 2px;
        }
        .welcome-banner-actions {
          margin-top: 14px;
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          align-items: center;
        }
        .welcome-banner-note {
          font-size: 11px;
          line-height: 1.5;
          color: var(--text-muted);
          max-width: 360px;
        }

        /* Agent Credential Vault */
        .vault-premium-badge {
          display: inline-block;
          font-size: 10px;
          font-weight: 600;
          color: var(--accent-primary);
          background: color-mix(in srgb, var(--accent-primary) 15%, transparent);
          padding: 1px 6px;
          border-radius: 4px;
          margin-left: 8px;
          vertical-align: middle;
        }
        .vault-entries {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-bottom: 10px;
        }
        .vault-entry {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
        }
        .vault-entry-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .vault-entry-label {
          font-size: 12px;
          font-weight: 500;
          color: var(--text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .vault-entry-detail {
          font-size: 11px;
          color: var(--text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .vault-entry-remove {
          flex-shrink: 0;
          width: 24px;
          height: 24px;
          border-radius: 4px;
          background: transparent;
          border: none;
          color: var(--text-muted);
          font-size: 16px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background var(--duration-fast), color var(--duration-fast);
        }
        .vault-entry-remove:hover {
          background: color-mix(in srgb, var(--status-error) 12%, transparent);
          color: var(--status-error);
        }
        .vault-add-btn {
          height: 32px;
          padding: 0 14px;
          border-radius: var(--radius-md);
          font-size: 12px;
          font-weight: 500;
          background: var(--bg-tertiary);
          border: 1px dashed var(--border-subtle);
          color: var(--text-secondary);
          cursor: pointer;
          width: 100%;
          transition: background var(--duration-fast), border-color var(--duration-fast);
        }
        .vault-add-btn:hover {
          background: var(--border-visible);
          border-color: var(--border-visible);
        }
        .vault-add-form {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 12px;
          background: var(--surface-glass);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
        }
        .vault-add-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          margin-top: 4px;
        }
      `}</style>
    </Show>
  );
};

export default Settings;
