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
import { useProviderAuthSetup } from "./useProviderAuthSetup";
import type {
  SettingsCategoryId,
  SessionSummary,
  VaultListEntry,
  HumanVaultEntry,
  AutofillListEntry,
} from "./settingsTypes";

import "./settings.css";

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
  const [sourceDoNotAllowList, setSourceDoNotAllowList] = createSignal("");

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

  const startPremiumCheckout = async () => {
    setPremiumLoading(true);
    setPremiumMessage(null);
    try {
      const result = await window.vessel.premium.checkout(
        premiumEmail().trim() || undefined,
      );
      if (result.ok) {
        setPremiumMessage({
          kind: "success",
          text: "Checkout opened. This screen will update when Premium activates.",
        });
      } else {
        setPremiumMessage({
          kind: "error",
          text: result.error || "Could not open checkout.",
        });
      }
    } catch (err) {
      setPremiumMessage({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : "Could not open checkout.",
      });
    } finally {
      setPremiumLoading(false);
    }
  };

  const resetPremiumActivationFlow = () => {
    setPremiumCode("");
    setPremiumChallengeToken("");
    setPremiumCodeSent(false);
  };

  // Chat provider settings
  const [chatEnabled, setChatEnabled] = createSignal(false);
  const [chatProviderId, setChatProviderId] = createSignal<ProviderId>("openrouter");
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
  const providerAuth = useProviderAuthSetup({
    onCodexConnected: () => {
      setChatHasStoredApiKey(true);
    },
    onCodexDisconnected: () => {
      setChatHasStoredApiKey(false);
    },
    onOpenRouterConnected: async (result) => {
      setChatEnabled(true);
      setChatProviderId("openrouter");
      setChatApiKey("");
      setChatHasStoredApiKey(true);
      setChatModel(result.model || PROVIDERS.openrouter.defaultModel);
      setChatBaseUrl(PROVIDERS.openrouter.defaultBaseUrl ?? "");
      setChatReasoningEffort("off");
      await loadState();
    },
  });

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
    providerAuth.markProviderConnected(cp?.id, cp?.hasApiKey === true);
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
    setSourceDoNotAllowList(
      (settings.sourceDoNotAllowList ?? []).join("\n"),
    );
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
    onCleanup(() => {
      unsubscribe();
      unsubscribePremium();
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
      const sourceExclusions = sourceDoNotAllowList()
        .split("\n")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
      await window.vessel.settings.set(
        "sourceDoNotAllowList",
        Array.from(new Set(sourceExclusions)),
      );
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
                    codexAuthStatus: providerAuth.codexAuthStatus,
                    codexAccountEmail: providerAuth.codexAccountEmail,
                    setCodexAccountEmail: providerAuth.setCodexAccountEmail,
                    codexAuthError: providerAuth.codexAuthError,
                    setCodexAuthError: providerAuth.setCodexAuthError,
                    openRouterAuthStatus: providerAuth.openRouterAuthStatus,
                    openRouterAuthError: providerAuth.openRouterAuthError,
                    providerType,
                    startCodexAuth: providerAuth.startCodexAuth,
                    disconnectCodex: providerAuth.disconnectCodex,
                    startOpenRouterAuth: providerAuth.startOpenRouterAuth,
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
                  sourceDoNotAllowList={sourceDoNotAllowList}
                  setSourceDoNotAllowList={setSourceDoNotAllowList}
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
    </Show>
  );
};

export default Settings;
