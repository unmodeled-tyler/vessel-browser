import {
  createEffect,
  createSignal,
  For,
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
  RuntimeHealthState,
} from "../../../../shared/types";
import { PROVIDERS } from "../../../../shared/providers";

const CHAT_PROVIDERS = Object.values(PROVIDERS).map((p) => ({
  id: p.id,
  name: p.name,
  requiresKey: p.requiresApiKey,
  needsBaseUrl: p.id === "llama_cpp" || p.id === "custom",
  defaultBaseUrl: p.defaultBaseUrl,
  keyPlaceholder: p.apiKeyPlaceholder,
  defaultModel: p.defaultModel,
  models: p.models,
}));

const Settings: Component = () => {
  const { settingsOpen, closeSettings } = useUI();
  const { visible: settingsVisible, closing: settingsClosing } = useAnimatedPresence(settingsOpen, 200);
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
  const [status, setStatus] = createSignal<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  // Telemetry
  const [telemetryEnabled, setTelemetryEnabled] = createSignal(true);

  // Agent Credential Vault
  type VaultListEntry = { id: string; label: string; domainPattern: string; username: string; notes?: string; createdAt: string; lastUsedAt?: string; useCount: number };
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
    } catch { /* vault not available */ }
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
    } catch {
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
  ) => window.vessel.premium.trackContext(step).catch(() => {});

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

  const chatProviderMeta = () => CHAT_PROVIDERS.find((p) => p.id === chatProviderId()) ?? CHAT_PROVIDERS[0];

  const [providerModels, setProviderModels] = createSignal<string[]>([]);
  const [modelFetchState, setModelFetchState] = createSignal<"idle" | "loading" | "error">("idle");
  const [modelFetchWarning, setModelFetchWarning] = createSignal<string | null>(null);

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
    }).catch(() => {
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
    setDefaultUrl(settings.defaultUrl ?? "https://start.duckduckgo.com");
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
    } else {
      setChatApiKey("");
      setChatHasStoredApiKey(false);
    }
    setTelemetryEnabled(settings.telemetryEnabled !== false);
    // Load premium state
    try {
      const ps = await window.vessel.premium.getState();
      setPremiumState(ps);
      if (ps.email) setPremiumEmail(ps.email);
    } catch { /* premium API not available */ }
    // Load vault entries
    await loadVaultEntries();
  };

  onMount(() => {
    void loadState();
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
      const chatConfig: ProviderConfig | null = chatEnabled()
        ? {
            id: chatProviderId(),
            apiKey: chatApiKey().trim(),
            hasApiKey: chatHasStoredApiKey() && !chatApiKey().trim(),
            model: chatModel().trim() || chatProviderMeta().defaultModel,
            baseUrl: chatBaseUrl().trim() || undefined,
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

          <Show when={showWelcome()}>
            <div class="welcome-banner">
              <div class="welcome-banner-header">
                <span class="welcome-banner-title">Welcome to Vessel</span>
                <button class="welcome-banner-dismiss" onClick={dismissWelcome}>&times;</button>
              </div>
              <p class="welcome-banner-text">Get started in three steps:</p>
              <ol class="welcome-banner-steps">
                <li classList={{ done: chatEnabled() }}>
                  <strong>Configure a chat provider</strong> — scroll to Chat Assistant below and add an API key
                </li>
                <li>
                  <strong>Connect your agent harness</strong> — point it at the MCP endpoint shown below
                </li>
                <li>
                  <strong>Learn the shortcuts</strong> — press <kbd>?</kbd> anytime for a quick reference
                </li>
              </ol>
              <Show when={!premiumActive()}>
                <div class="welcome-banner-actions">
                  <button
                    class="premium-btn premium-btn-upgrade"
                    onClick={() => {
                      void trackPremiumContext("welcome_banner_clicked");
                      startPremiumCheckout();
                    }}
                  >
                    Try Premium free for 7 days — $5.99/mo after
                  </button>
                  <span class="welcome-banner-note">
                    Best for screenshots, saved sessions, credential vault, and longer autonomous runs.
                  </span>
                </div>
              </Show>
            </div>
          </Show>

          <div class="settings-callout">
            <div class="settings-callout-title">External Agent Control</div>
            <p class="settings-callout-copy">
              Vessel is configured to run under an external harness such as
              Hermes Agent or OpenClaw. Provider and model selection are not
              configured inside Vessel.
            </p>
          </div>

          <Show when={!premiumActive()}>
            <div class="settings-callout settings-premium-callout">
              <div class="settings-callout-title">
                Start Vessel Premium with a 7-day free trial
              </div>
              <p class="settings-callout-copy">
                Unlock screenshots, saved sessions, workflow tracking, table
                extraction, the credential vault, and longer autonomous runs
                without leaving the app.
              </p>
              <div class="settings-premium-callout-actions">
                <button
                  class="premium-btn premium-btn-upgrade"
                  onClick={() => {
                    void trackPremiumContext("settings_banner_clicked");
                    startPremiumCheckout();
                  }}
                >
                  Start 7-day free trial — $5.99/mo after
                </button>
                <button
                  class="premium-btn premium-btn-activate"
                  onClick={() => {
                    const premiumSection = document.querySelector(
                      ".premium-section",
                    );
                    premiumSection?.scrollIntoView({
                      behavior: "smooth",
                      block: "start",
                    });
                  }}
                >
                  See activation steps
                </button>
              </div>
            </div>
          </Show>

          <div class="settings-field">
            <label class="settings-label" for="default-homepage">
              Homepage
            </label>
            <input
              id="default-homepage"
              class="settings-input"
              value={defaultUrl()}
              onInput={(e) => setDefaultUrl(e.currentTarget.value)}
              placeholder="https://start.duckduckgo.com"
              spellcheck={false}
            />
            <p class="settings-hint">
              The page that opens when you create a new tab or launch Vessel
              without restoring a previous session.
            </p>
          </div>

          <div class="settings-field">
            <label class="settings-label" for="mcp-port">
              MCP Port
            </label>
            <input
              id="mcp-port"
              class="settings-input"
              value={mcpPort()}
              onInput={(e) => setMcpPort(e.currentTarget.value)}
              placeholder="3100"
              spellcheck={false}
            />
            <p class="settings-hint">
              External harnesses connect to Vessel at
              {" "}
              <code>http://127.0.0.1:&lt;port&gt;/mcp</code>. Changing this
              value restarts the MCP server immediately.
            </p>
          </div>

          <div class="settings-field">
            <label class="settings-label" for="max-tool-iterations">
              Max Tool Iterations
            </label>
            <Show
              when={premiumActive()}
              fallback={
                <div
                  class="settings-input settings-input-disabled"
                  title="Upgrade to Vessel Premium for unlimited tool iterations"
                >
                  50
                </div>
              }
            >
              <input
                id="max-tool-iterations"
                class="settings-input"
                type="number"
                min="10"
                max="1000"
                value={maxToolIterations()}
                onInput={(e) => setMaxToolIterations(e.currentTarget.value)}
                placeholder="200"
              />
            </Show>
            <p class="settings-hint">
              <Show
                when={premiumActive()}
                fallback="Free tier: 50 tool calls per conversation turn. Upgrade to Vessel Premium to customize this limit (up to 1,000)."
              >
                Maximum number of tool calls the AI agent can make per
                conversation turn before pausing. Higher values let the agent
                complete longer multi-step workflows without stopping.
                Range: 10–1000.
              </Show>
            </p>
          </div>

          <Show when={health()}>
            {(currentHealth) => (
              <div class="settings-health">
                <div class="settings-callout-title">Runtime Health</div>
                <p class="settings-hint">
                  MCP status:{" "}
                  <strong>{currentHealth().mcp.status}</strong>
                  {" "}
                  {currentHealth().mcp.message}
                </p>
                <Show when={currentHealth().mcp.endpoint}>
                  {(endpoint) => (
                    <p class="settings-hint">
                      Active endpoint: <code>{endpoint()}</code>
                    </p>
                  )}
                </Show>
                <Show when={currentHealth().startupIssues.length > 0}>
                  <div class="settings-health-issues">
                    {currentHealth().startupIssues.map((issue) => (
                      <div
                        class="settings-health-issue"
                        classList={{
                          warning: issue.severity === "warning",
                          error: issue.severity === "error",
                        }}
                      >
                        <strong>{issue.title}</strong>
                        <div>{issue.detail}</div>
                        <Show when={issue.action}>
                          {(action) => <div>{action()}</div>}
                        </Show>
                      </div>
                    ))}
                  </div>
                </Show>
              </div>
            )}
          </Show>

          <div class="settings-field">
            <label class="settings-label" for="obsidian-vault-path">
              Obsidian Vault Path
            </label>
            <input
              id="obsidian-vault-path"
              class="settings-input"
              value={obsidianVaultPath()}
              onInput={(e) => setObsidianVaultPath(e.currentTarget.value)}
              placeholder="/home/you/Documents/MyVault"
              spellcheck={false}
            />
            <p class="settings-hint">
              Optional. When set, Vessel memory tools can write markdown notes
              into this vault for research breadcrumbs and summaries.
            </p>
          </div>

          <div class="settings-field">
            <label class="settings-label" for="agent-transcript-mode">
              Agent Transcript Monitor
            </label>
            <select
              id="agent-transcript-mode"
              class="settings-input settings-select"
              value={agentTranscriptMode()}
              onChange={(e) =>
                setAgentTranscriptMode(
                  e.currentTarget.value as AgentTranscriptDisplayMode,
                )
              }
            >
              <option value="off">Off</option>
              <option value="summary">Summary HUD</option>
              <option value="full">Full transcript</option>
            </select>
            <p class="settings-hint">
              Controls the in-browser transcript monitor when an external
              harness publishes reasoning or status updates into Vessel via the
              <code>vessel_publish_transcript</code> MCP tool. Summary HUD shows
              a compact 2-line status surface; Full transcript shows the recent
              entry list.
            </p>
          </div>

          <div class="settings-field">
            <label class="settings-toggle">
              <button
                type="button"
                class="toggle-switch"
                classList={{ on: autoRestoreSession() }}
                onClick={() => setAutoRestoreSession(!autoRestoreSession())}
                role="switch"
                aria-checked={autoRestoreSession()}
              >
                <span class="toggle-switch-thumb" />
              </button>
              <span>Restore last browser session on launch</span>
            </label>
          </div>

          <div class="settings-field">
            <label class="settings-toggle">
              <button
                type="button"
                class="toggle-switch"
                classList={{ on: clearBookmarksOnLaunch() }}
                onClick={() => setClearBookmarksOnLaunch(!clearBookmarksOnLaunch())}
                role="switch"
                aria-checked={clearBookmarksOnLaunch()}
              >
                <span class="toggle-switch-thumb" />
              </button>
              <span>Start bookmarks fresh on launch</span>
            </label>
            <p class="settings-hint">
              Off by default. When enabled, bookmark folders and saved pages are
              cleared each time Vessel starts.
            </p>
          </div>

          <div class="settings-section-divider" />

          <div class="settings-field">
            <label class="settings-toggle">
              <button
                type="button"
                class="toggle-switch"
                classList={{ on: chatEnabled() }}
                onClick={() => setChatEnabled(!chatEnabled())}
                role="switch"
                aria-checked={chatEnabled()}
              >
                <span class="toggle-switch-thumb" />
              </button>
              <span>Enable Chat Assistant</span>
            </label>
            <p class="settings-hint">
              Adds a Chat tab to the sidebar for conversing with an AI provider of your choice.
            </p>
          </div>

          <Show when={chatEnabled()}>
            <div class="settings-field">
              <label class="settings-label" for="chat-provider">Provider</label>
              <select
                id="chat-provider"
                class="settings-input settings-select"
                value={chatProviderId()}
                onChange={(e) => {
                  const id = e.currentTarget.value as ProviderId;
                  setChatProviderId(id);
                  setChatModel("");
                  setChatBaseUrl("");
                  setChatApiKey("");
                  setChatHasStoredApiKey(false);
                  setProviderModels([]);
                  setModelFetchState("idle");
                }}
              >
                <For each={CHAT_PROVIDERS}>
                  {(p) => <option value={p.id}>{p.name}</option>}
                </For>
              </select>
            </div>

            <Show when={chatProviderMeta().requiresKey || chatProviderId() === "custom"}>
              <div class="settings-field">
                <label class="settings-label" for="chat-api-key">
                  API Key
                  <Show when={!chatProviderMeta().requiresKey}>
                    <span class="settings-label-optional"> (optional)</span>
                  </Show>
                </label>
                <input
                  id="chat-api-key"
                  class="settings-input"
                  type="password"
                  value={chatApiKey()}
                  onInput={(e) => {
                    setChatApiKey(e.currentTarget.value);
                    if (e.currentTarget.value.trim()) {
                      setChatHasStoredApiKey(true);
                    }
                  }}
                  placeholder={
                    chatHasStoredApiKey() && !chatApiKey().trim()
                      ? "Stored securely. Enter a new key to replace it."
                      : chatProviderMeta().keyPlaceholder || "Bearer token or API key"
                  }
                  spellcheck={false}
                />
                <Show when={chatHasStoredApiKey() && !chatApiKey().trim()}>
                  <p class="settings-hint">
                    An API key is already stored securely for this provider. Leave this blank to keep it, or enter a new key to replace it.
                  </p>
                </Show>
                <Show when={chatProviderId() === "custom"}>
                  <p class="settings-hint">
                    If your endpoint requires authentication, enter the API key or bearer token here.
                  </p>
                </Show>
              </div>
            </Show>

            <div class="settings-field">
              <label class="settings-label" for="chat-model">Model</label>
              <div style="display:flex;gap:6px;align-items:center">
                <Show
                  when={providerModels().length > 0}
                  fallback={
                    <input
                      id="chat-model"
                      class="settings-input"
                      style="flex:1"
                      value={chatModel()}
                      onInput={(e) => setChatModel(e.currentTarget.value)}
                        placeholder={
                          modelFetchState() === "loading"
                            ? "Fetching models…"
                          : chatProviderMeta().requiresKey &&
                              !chatApiKey().trim() &&
                              !chatHasStoredApiKey()
                            ? "Enter API key to load models"
                            : chatProviderMeta().defaultModel || "model name"
                        }
                      spellcheck={false}
                    />
                  }
                >
                  <select
                    id="chat-model"
                    class="settings-input settings-select"
                    style="flex:1"
                    value={chatModel()}
                    onChange={(e) => setChatModel(e.currentTarget.value)}
                  >
                    <For each={providerModels()}>
                      {(m) => <option value={m}>{m}</option>}
                    </For>
                  </select>
                </Show>
                <button
                  type="button"
                  class="settings-refresh-btn"
                  title="Refresh model list"
                  disabled={modelFetchState() === "loading"}
                  onClick={doFetchModels}
                >
                  ↺
                </button>
              </div>
              <Show when={modelFetchState() === "error"}>
                <p class="settings-hint" style="color:var(--error)">
                  Could not fetch models — check your API key and connection.
                </p>
              </Show>
              <Show when={modelFetchWarning()}>
                {(warning) => (
                  <p class="settings-hint" style="color:var(--accent-primary)">
                    {warning()}
                  </p>
                )}
              </Show>
            </div>

            <Show when={chatProviderMeta().needsBaseUrl || chatProviderId() === "custom"}>
              <div class="settings-field">
                <label class="settings-label" for="chat-base-url">Base URL</label>
                <input
                  id="chat-base-url"
                  class="settings-input"
                  value={chatBaseUrl()}
                  onInput={(e) => setChatBaseUrl(e.currentTarget.value)}
                  placeholder={chatProviderMeta().defaultBaseUrl ?? "https://..."}
                  spellcheck={false}
                />
              </div>
            </Show>
            <Show when={chatProviderId() === "llama_cpp"}>
              <p class="settings-hint">
                Vessel auto-detects the active model from your configured `llama-server` base URL.
                For agent loops, run `llama-server` with `--ctx-size 16384` minimum and `32768`
                recommended.
              </p>
            </Show>
          </Show>

          <div class="settings-section-divider" />

          {/* --- Premium Subscription --- */}
          <div class="settings-field">
            <label class="settings-label">Vessel Premium</label>
            <Show
              when={premiumActive()}
              fallback={
                <div class="premium-section">
                  <p class="premium-description">
                    Unlock screenshot/vision analysis, session management,
                    Obsidian integration, workflow tracking, DevTools tools,
                    table extraction, Agent Credential Vault, and unlimited
                    tool iterations.
                  </p>
                  <div class="premium-activate-row">
                    <input
                      class="settings-input premium-email-input"
                      type="email"
                      placeholder="Enter your subscription email"
                      value={premiumEmail()}
                      onInput={(e) => {
                        const nextEmail = e.currentTarget.value;
                        if (nextEmail.trim().toLowerCase() !== premiumEmail().trim().toLowerCase()) {
                          resetPremiumActivationFlow();
                          setPremiumMessage(null);
                        }
                        setPremiumEmail(nextEmail);
                      }}
                      spellcheck={false}
                    />
                    <button
                      class="premium-btn premium-btn-activate"
                      disabled={premiumLoading() || !premiumEmail().trim()}
                      onClick={async () => {
                        setPremiumLoading(true);
                        setPremiumMessage(null);
                        try {
                          const result = await window.vessel.premium.requestCode(
                            premiumEmail().trim(),
                          );
                          if (result.ok) {
                            setPremiumChallengeToken(result.challengeToken ?? "");
                            setPremiumCodeSent(true);
                            setPremiumMessage({
                              kind: "success",
                              text:
                                "If a matching premium subscription exists, we sent a 6-digit code to that email.",
                            });
                          } else {
                            resetPremiumActivationFlow();
                            setPremiumMessage({
                              kind: "error",
                              text: result.error || "Could not send code",
                            });
                          }
                        } catch (err) {
                          resetPremiumActivationFlow();
                          setPremiumMessage({
                            kind: "error",
                            text:
                              err instanceof Error
                                ? err.message
                                : "Could not send code",
                          });
                        } finally {
                          setPremiumLoading(false);
                        }
                      }}
                    >
                      {premiumLoading()
                        ? "Sending..."
                        : premiumCodeSent()
                          ? "Resend Code"
                          : "Send Code"}
                    </button>
                  </div>
                  <Show when={premiumCodeSent()}>
                    <div class="premium-activate-row">
                      <input
                        class="settings-input premium-email-input"
                        inputmode="numeric"
                        maxLength={6}
                        placeholder="Enter 6-digit code"
                        value={premiumCode()}
                        onInput={(e) => {
                          const nextCode = e.currentTarget.value.replace(/\D+/g, "").slice(0, 6);
                          setPremiumCode(nextCode);
                          setPremiumMessage(null);
                        }}
                        spellcheck={false}
                      />
                      <button
                        class="premium-btn premium-btn-activate"
                        disabled={
                          premiumLoading() ||
                          !premiumEmail().trim() ||
                          premiumCode().trim().length !== 6 ||
                          !premiumChallengeToken()
                        }
                        onClick={async () => {
                          setPremiumLoading(true);
                          setPremiumMessage(null);
                          try {
                            const result = await window.vessel.premium.verifyCode(
                              premiumEmail().trim(),
                              premiumCode().trim(),
                              premiumChallengeToken(),
                            );
                            setPremiumState(result.state);
                            if (result.ok) {
                              resetPremiumActivationFlow();
                              setPremiumMessage({
                                kind: "success",
                                text: "Premium activated!",
                              });
                            } else {
                              setPremiumMessage({
                                kind: "error",
                                text: result.error || "Verification failed",
                              });
                            }
                          } catch (err) {
                            setPremiumMessage({
                              kind: "error",
                              text:
                                err instanceof Error
                                  ? err.message
                                  : "Verification failed",
                            });
                          } finally {
                            setPremiumLoading(false);
                          }
                        }}
                      >
                        {premiumLoading() ? "Verifying..." : "Verify Code"}
                      </button>
                    </div>
                  </Show>
                  <button
                    class="premium-btn premium-btn-upgrade"
                    onClick={() => {
                      startPremiumCheckout();
                    }}
                  >
                    Subscribe to Premium — $5.99/mo after 7-day free trial
                  </button>
                  <Show when={premiumMessage()}>
                    {(msg) => (
                      <p
                        class="settings-status"
                        classList={{
                          success: msg().kind === "success",
                          error: msg().kind === "error",
                        }}
                      >
                        {msg().text}
                      </p>
                    )}
                  </Show>
                  <Show when={premiumState().email || premiumEmail()}>
                    <button
                      class="premium-btn premium-btn-reset"
                      onClick={async () => {
                        const state = await window.vessel.premium.reset();
                        setPremiumState(state);
                        setPremiumEmail("");
                        resetPremiumActivationFlow();
                        setPremiumMessage(null);
                      }}
                    >
                      Clear Saved Email
                    </button>
                  </Show>
                </div>
              }
            >
              <div class="premium-section">
                <div class="premium-active-badge">
                  Premium Active
                  <Show when={premiumState().status === "trialing"}>
                    {" "}(Trial)
                  </Show>
                </div>
                <p class="premium-detail">
                  {premiumState().email}
                  <Show when={premiumState().expiresAt}>
                    {" "}&middot; Renews{" "}
                    {new Date(premiumState().expiresAt).toLocaleDateString()}
                  </Show>
                </p>
                <div class="premium-actions-row">
                  <button
                    class="premium-btn premium-btn-manage"
                    onClick={() => {
                      void window.vessel.premium.portal();
                    }}
                  >
                    Manage Subscription
                  </button>
                  <button
                    class="premium-btn premium-btn-reset"
                    onClick={async () => {
                      const state = await window.vessel.premium.reset();
                      setPremiumState(state);
                      setPremiumEmail("");
                      resetPremiumActivationFlow();
                      setPremiumMessage(null);
                    }}
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            </Show>
          </div>

          <div class="settings-section-divider" />

          {/* --- Agent Credential Vault --- */}
          <div class="settings-field">
            <label class="settings-label">
              Agent Credential Vault
              <Show when={!premiumActive()}>
                <span class="vault-premium-badge">Premium</span>
              </Show>
            </label>
            <Show
              when={premiumActive()}
              fallback={
                <p class="settings-hint">
                  Securely store credentials for agent-driven logins. Upgrade to Premium to unlock the Agent Credential Vault.
                </p>
              }
            >
              <p class="settings-hint" style="margin-bottom: 10px">
                Store credentials for agent-driven logins. Credentials are encrypted at rest and never sent to AI providers — they are filled directly into login forms with your consent.
              </p>

              <Show when={vaultEntries().length > 0}>
                <div class="vault-entries">
                  <For each={vaultEntries()}>
                    {(entry) => (
                      <div class="vault-entry">
                        <div class="vault-entry-info">
                          <span class="vault-entry-label">{entry.label}</span>
                          <span class="vault-entry-detail">
                            {entry.username} &middot; {entry.domainPattern}
                            <Show when={entry.useCount > 0}>
                              {" "}&middot; Used {entry.useCount}x
                            </Show>
                          </span>
                        </div>
                        <button
                          class="vault-entry-remove"
                          onClick={() => handleVaultRemove(entry.id)}
                          title="Remove credential"
                        >
                          &times;
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={!vaultAdding()}>
                <button
                  class="vault-add-btn"
                  onClick={() => { setVaultAdding(true); setVaultMessage(null); }}
                >
                  + Add Credential
                </button>
              </Show>

              <Show when={vaultAdding()}>
                <div class="vault-add-form">
                  <input
                    class="settings-input"
                    placeholder="Label (e.g. Work GitHub)"
                    value={vaultNewLabel()}
                    onInput={(e) => setVaultNewLabel(e.currentTarget.value)}
                    spellcheck={false}
                  />
                  <input
                    class="settings-input"
                    placeholder="Domain pattern (e.g. github.com, *.aws.amazon.com)"
                    value={vaultNewDomain()}
                    onInput={(e) => setVaultNewDomain(e.currentTarget.value)}
                    spellcheck={false}
                  />
                  <input
                    class="settings-input"
                    placeholder="Username / email"
                    value={vaultNewUsername()}
                    onInput={(e) => setVaultNewUsername(e.currentTarget.value)}
                    spellcheck={false}
                  />
                  <input
                    class="settings-input"
                    type="password"
                    placeholder="Password"
                    value={vaultNewPassword()}
                    onInput={(e) => setVaultNewPassword(e.currentTarget.value)}
                  />
                  <input
                    class="settings-input"
                    placeholder="TOTP secret (optional, base32)"
                    value={vaultNewTotp()}
                    onInput={(e) => setVaultNewTotp(e.currentTarget.value)}
                    spellcheck={false}
                  />
                  <input
                    class="settings-input"
                    placeholder="Notes (optional)"
                    value={vaultNewNotes()}
                    onInput={(e) => setVaultNewNotes(e.currentTarget.value)}
                    spellcheck={false}
                  />
                  <div class="vault-add-actions">
                    <button class="premium-btn premium-btn-activate" onClick={handleVaultAdd}>
                      Save Credential
                    </button>
                    <button
                      class="premium-btn premium-btn-reset"
                      onClick={() => {
                        setVaultAdding(false);
                        setVaultNewLabel(""); setVaultNewDomain(""); setVaultNewUsername("");
                        setVaultNewPassword(""); setVaultNewTotp(""); setVaultNewNotes("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </Show>

              <Show when={vaultMessage()}>
                {(msg) => (
                  <p
                    class="settings-status"
                    classList={{
                      success: msg().kind === "success",
                      error: msg().kind === "error",
                    }}
                  >
                    {msg().text}
                  </p>
                )}
              </Show>
            </Show>
          </div>

          <div class="settings-section-divider" />

          <div class="settings-field">
            <label class="settings-toggle">
              <button
                type="button"
                class="toggle-switch"
                classList={{ on: telemetryEnabled() }}
                onClick={() => setTelemetryEnabled(!telemetryEnabled())}
                role="switch"
                aria-checked={telemetryEnabled()}
              >
                <span class="toggle-switch-thumb" />
              </button>
              <span>Anonymous Usage Analytics</span>
            </label>
            <p class="settings-hint">
              Help improve Vessel by sending anonymous usage data (tool popularity,
              session duration, provider type). No URLs, page content, queries, or
              personal data is ever collected.
            </p>
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
          width: min(440px, calc(100vw - 32px));
          max-height: calc(100vh - 48px);
          background: var(--bg-elevated);
          border: 1px solid var(--border-visible);
          border-radius: 14px;
          padding: 28px 24px 24px;
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-gutter: stable;
          box-shadow:
            0 4px 24px rgba(0, 0, 0, 0.2),
            0 24px 64px rgba(0, 0, 0, 0.3),
            inset 0 1px 0 rgba(255, 255, 255, 0.04);
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
        }
        .settings-callout {
          margin-bottom: 20px;
          padding: 14px;
          border-radius: var(--radius-md);
          border: 1px solid rgba(224, 200, 120, 0.14);
          background: rgba(224, 200, 120, 0.06);
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
            radial-gradient(circle at top right, rgba(196, 160, 90, 0.16), transparent 40%),
            rgba(224, 200, 120, 0.06);
          border-color: rgba(196, 160, 90, 0.22);
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
          background: rgba(255, 255, 255, 0.015);
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
          border: 1px solid rgba(255, 255, 255, 0.06);
          color: var(--text-secondary);
        }
        .settings-health-issue.warning {
          border-color: rgba(240, 198, 54, 0.28);
          background: rgba(240, 198, 54, 0.06);
        }
        .settings-health-issue.error {
          border-color: rgba(255, 108, 91, 0.32);
          background: rgba(255, 108, 91, 0.06);
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
          font-weight: 400;
          opacity: 0.6;
        }
        .settings-input {
          width: 100%;
          height: 34px;
          padding: 0 12px;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          color: var(--text-primary);
          font-size: 13px;
          font-family: var(--font-mono);
          transition:
            border-color var(--duration-normal) var(--ease-in-out),
            box-shadow var(--duration-normal) var(--ease-in-out);
        }
        .settings-select {
          appearance: none;
        }
        .settings-input:focus {
          border-color: var(--accent-primary);
          box-shadow: 0 0 0 2px rgba(196, 160, 90, 0.1);
          outline: none;
        }
        .settings-hint {
          font-size: 11px;
          color: var(--text-muted);
          margin-top: 5px;
          line-height: 1.5;
        }
        .settings-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          margin-top: 24px;
        }
        .settings-toggle {
          display: flex;
          align-items: center;
          gap: 12px;
          color: var(--text-primary);
          font-size: 13px;
          cursor: pointer;
          padding: 6px 0;
        }
        .toggle-switch {
          position: relative;
          width: 36px;
          height: 20px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.06);
          padding: 0;
          flex-shrink: 0;
          cursor: pointer;
          transition:
            background var(--duration-normal) var(--ease-in-out),
            border-color var(--duration-normal) var(--ease-in-out);
        }
        .toggle-switch:hover {
          background: rgba(255, 255, 255, 0.14);
        }
        .toggle-switch.on {
          background: var(--accent-primary);
          border-color: transparent;
        }
        .toggle-switch.on:hover {
          background: #d4b06a;
        }
        .toggle-switch-thumb {
          position: absolute;
          top: 2px;
          left: 2px;
          width: 14px;
          height: 14px;
          border-radius: 999px;
          background: var(--text-primary);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
          transition: transform var(--duration-normal) var(--ease-out-expo);
          pointer-events: none;
        }
        .toggle-switch.on .toggle-switch-thumb {
          transform: translateX(16px);
        }
        .settings-status {
          margin-top: 14px;
          font-size: 12px;
          line-height: 1.5;
        }
        .settings-status.success {
          color: #84d19a;
        }
        .settings-status.error {
          color: #ff8e8e;
        }
        .settings-save, .settings-close {
          height: 34px;
          padding: 0 18px;
          border-radius: var(--radius-md);
          font-size: 12px;
          font-weight: 500;
          transition:
            background var(--duration-fast) var(--ease-in-out),
            transform var(--duration-fast) var(--ease-out-expo);
        }
        .settings-save:active, .settings-close:active {
          transform: scale(0.97);
        }
        .settings-save {
          background: var(--accent-primary);
          color: white;
        }
        .settings-save:hover { background: #d4b06a; }
        .settings-close {
          background: var(--bg-tertiary);
          color: var(--text-secondary);
        }
        .settings-close:hover { background: var(--border-visible); }
        .settings-section-divider {
          height: 1px;
          background: var(--border-subtle);
          margin: 22px 0 18px;
        }
        .settings-refresh-btn {
          height: 34px;
          width: 34px;
          flex-shrink: 0;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          color: var(--text-secondary);
          font-size: 16px;
          cursor: pointer;
          transition: background var(--duration-fast), color var(--duration-fast);
        }
        .settings-refresh-btn:hover:not(:disabled) {
          background: var(--border-visible);
          color: var(--text-primary);
        }
        .settings-refresh-btn:disabled {
          opacity: 0.4;
          cursor: default;
        }

        .settings-input-disabled {
          opacity: 0.5;
          cursor: not-allowed;
          user-select: none;
          display: flex;
          align-items: center;
        }

        /* Premium section */
        .premium-section {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .premium-description {
          color: var(--text-secondary);
          font-size: 12px;
          line-height: 1.5;
          margin: 0;
        }
        .premium-activate-row {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .premium-email-input {
          flex: 1;
          min-width: 0;
        }
        .premium-btn {
          height: 34px;
          padding: 0 16px;
          border-radius: var(--radius-md);
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          border: none;
          transition:
            background var(--duration-fast) var(--ease-in-out),
            transform var(--duration-fast) var(--ease-out-expo);
          white-space: nowrap;
        }
        .premium-btn:active {
          transform: scale(0.97);
        }
        .premium-btn:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .premium-btn-activate {
          background: var(--bg-tertiary);
          color: var(--text-primary);
          border: 1px solid var(--border-subtle);
        }
        .premium-btn-activate:hover:not(:disabled) {
          background: var(--border-visible);
        }
        .premium-btn-upgrade {
          background: var(--accent-primary);
          color: white;
          width: 100%;
        }
        .premium-btn-upgrade:hover {
          background: #d4b06a;
        }
        .premium-btn-manage {
          background: var(--bg-tertiary);
          color: var(--text-secondary);
          border: 1px solid var(--border-subtle);
          align-self: flex-start;
        }
        .premium-btn-manage:hover {
          background: var(--border-visible);
          color: var(--text-primary);
        }
        .premium-active-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: rgba(240, 198, 54, 0.15);
          color: #f0c636;
          font-size: 12px;
          font-weight: 600;
          padding: 4px 12px;
          border-radius: var(--radius-md);
          align-self: flex-start;
        }
        .premium-detail {
          color: var(--text-secondary);
          font-size: 12px;
          margin: 0;
        }
        .premium-actions-row {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .premium-btn-reset {
          background: transparent;
          color: var(--text-tertiary, #71717a);
          border: 1px solid var(--border-subtle);
          font-size: 11px;
          padding: 0 12px;
          height: 30px;
        }
        .premium-btn-reset:hover {
          color: var(--text-secondary);
          background: var(--bg-tertiary);
        }

        /* Welcome banner */
        .welcome-banner {
          margin-bottom: 20px;
          padding: 16px;
          border-radius: var(--radius-md);
          border: 1px solid rgba(196, 160, 90, 0.25);
          background: rgba(196, 160, 90, 0.08);
        }
        .welcome-banner-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .welcome-banner-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--accent-primary);
        }
        .welcome-banner-dismiss {
          width: 22px;
          height: 22px;
          border-radius: 4px;
          background: transparent;
          border: none;
          color: var(--text-muted);
          font-size: 16px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .welcome-banner-dismiss:hover {
          background: rgba(255, 255, 255, 0.08);
          color: var(--text-primary);
        }
        .welcome-banner-text {
          font-size: 12px;
          color: var(--text-secondary);
          margin: 0 0 8px;
        }
        .welcome-banner-steps {
          margin: 0;
          padding-left: 20px;
          font-size: 12px;
          line-height: 1.7;
          color: var(--text-secondary);
        }
        .welcome-banner-steps li {
          margin-bottom: 2px;
        }
        .welcome-banner-steps li.done {
          color: var(--text-muted);
          text-decoration: line-through;
          opacity: 0.6;
        }
        .welcome-banner-steps kbd {
          display: inline-block;
          padding: 0 5px;
          font-size: 11px;
          font-family: var(--font-mono);
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 3px;
          color: var(--text-primary);
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
          color: #f0c636;
          background: rgba(240, 198, 54, 0.15);
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
          color: var(--text-tertiary, #71717a);
          font-size: 16px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background var(--duration-fast), color var(--duration-fast);
        }
        .vault-entry-remove:hover {
          background: rgba(255, 108, 91, 0.12);
          color: #ff8e8e;
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
          background: rgba(255, 255, 255, 0.02);
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
