import {
  createEffect,
  createSignal,
  For,
  Show,
  onMount,
  type Component,
} from "solid-js";

import { useUI } from "../../stores/ui";
import type {
  AgentTranscriptDisplayMode,
  ProviderId,
  ProviderConfig,
  RuntimeHealthState,
} from "../../../shared/types";

const CHAT_PROVIDERS: Array<{ id: ProviderId; name: string; requiresKey: boolean; needsBaseUrl: boolean; defaultBaseUrl?: string; keyPlaceholder: string; defaultModel: string; models: string[] }> = [
  { id: "anthropic", name: "Anthropic", requiresKey: true, needsBaseUrl: false, keyPlaceholder: "sk-ant-...", defaultModel: "claude-sonnet-4-20250514", models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-20250506"] },
  { id: "openai", name: "OpenAI", requiresKey: true, needsBaseUrl: false, keyPlaceholder: "sk-...", defaultModel: "gpt-4o", models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o3-mini"] },
  { id: "openrouter", name: "OpenRouter", requiresKey: true, needsBaseUrl: false, keyPlaceholder: "sk-or-...", defaultModel: "anthropic/claude-sonnet-4", models: ["anthropic/claude-sonnet-4", "openai/gpt-4o", "google/gemini-2.5-pro"] },
  { id: "ollama", name: "Ollama (Local)", requiresKey: false, needsBaseUrl: false, keyPlaceholder: "", defaultModel: "", models: [] },
  { id: "mistral", name: "Mistral AI", requiresKey: true, needsBaseUrl: false, keyPlaceholder: "sk-...", defaultModel: "mistral-large-latest", models: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"] },
  { id: "xai", name: "xAI (Grok)", requiresKey: true, needsBaseUrl: false, keyPlaceholder: "xai-...", defaultModel: "grok-3", models: ["grok-3", "grok-3-mini"] },
  { id: "google", name: "Google Gemini", requiresKey: true, needsBaseUrl: false, keyPlaceholder: "AI...", defaultModel: "gemini-2.5-pro", models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"] },
  { id: "custom", name: "Custom (OAI-Compatible)", requiresKey: false, needsBaseUrl: true, defaultBaseUrl: "http://localhost:8080/v1", keyPlaceholder: "", defaultModel: "", models: [] },
];

const Settings: Component = () => {
  const { settingsOpen, closeSettings } = useUI();
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

  // Chat provider settings
  const [chatEnabled, setChatEnabled] = createSignal(false);
  const [chatProviderId, setChatProviderId] = createSignal<ProviderId>("anthropic");
  const [chatApiKey, setChatApiKey] = createSignal("");
  const [chatModel, setChatModel] = createSignal("");
  const [chatBaseUrl, setChatBaseUrl] = createSignal("");

  const chatProviderMeta = () => CHAT_PROVIDERS.find((p) => p.id === chatProviderId()) ?? CHAT_PROVIDERS[0];

  const [providerModels, setProviderModels] = createSignal<string[]>([]);
  const [modelFetchState, setModelFetchState] = createSignal<"idle" | "loading" | "error">("idle");

  const doFetchModels = () => {
    const meta = chatProviderMeta();
    // Need a key for providers that require one
    if (meta.requiresKey && !chatApiKey().trim()) {
      setProviderModels([]);
      setModelFetchState("idle");
      return;
    }
    setModelFetchState("loading");
    window.vessel.ai.fetchModels({
      id: chatProviderId(),
      apiKey: chatApiKey().trim(),
      model: "",
      baseUrl: chatBaseUrl().trim() || meta.defaultBaseUrl || undefined,
    }).then(({ ok, models }) => {
      if (ok) {
        setProviderModels(models.sort());
        if (models.length > 0 && !chatModel()) setChatModel(models[0]);
        setModelFetchState("idle");
      } else {
        setProviderModels([]);
        setModelFetchState("error");
      }
    }).catch(() => {
      setProviderModels([]);
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
      setChatApiKey(cp.apiKey);
      setChatModel(cp.model);
      setChatBaseUrl(cp.baseUrl ?? "");
    }
  };

  onMount(() => {
    void loadState();
  });

  createEffect(() => {
    if (settingsOpen()) {
      void loadState();
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
      const chatConfig: ProviderConfig | null = chatEnabled()
        ? {
            id: chatProviderId(),
            apiKey: chatApiKey().trim(),
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
    <Show when={settingsOpen()}>
      <div class="command-bar-overlay" onClick={closeSettings}>
        <div
          class="settings-panel"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          <h2 class="settings-title">Runtime Settings</h2>

          <div class="settings-callout">
            <div class="settings-callout-title">External Agent Control</div>
            <p class="settings-callout-copy">
              Vessel is configured to run under an external harness such as
              Hermes Agent or OpenClaw. Provider and model selection are not
              configured inside Vessel.
            </p>
          </div>

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
            <p class="settings-hint">
              Maximum number of tool calls the AI agent can make per
              conversation turn before pausing. Higher values let the agent
              complete longer multi-step workflows without stopping.
              Range: 10–1000.
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
                  setProviderModels([]);
                  setModelFetchState("idle");
                }}
              >
                <For each={CHAT_PROVIDERS}>
                  {(p) => <option value={p.id}>{p.name}</option>}
                </For>
              </select>
            </div>

            <Show when={chatProviderMeta().requiresKey}>
              <div class="settings-field">
                <label class="settings-label" for="chat-api-key">API Key</label>
                <input
                  id="chat-api-key"
                  class="settings-input"
                  type="password"
                  value={chatApiKey()}
                  onInput={(e) => setChatApiKey(e.currentTarget.value)}
                  placeholder={chatProviderMeta().keyPlaceholder}
                  spellcheck={false}
                />
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
                          : chatProviderMeta().requiresKey && !chatApiKey().trim()
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
          </Show>

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
      `}</style>
    </Show>
  );
};

export default Settings;
