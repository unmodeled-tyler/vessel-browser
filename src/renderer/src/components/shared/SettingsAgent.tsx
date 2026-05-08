import { For, Show, type Component } from "solid-js";
import type { ProviderId, ReasoningEffortLevel } from "../../../../shared/types";
import type { AgentTranscriptDisplayMode } from "../../../../shared/types";
import { PROVIDERS } from "../../../../shared/providers";
import type { SettingsAgentProps } from "./settingsTypes";

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

const REASONING_EFFORT_OPTIONS: Array<{
  value: ReasoningEffortLevel;
  label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

const SettingsAgent: Component<SettingsAgentProps> = (props) => {
  const chatMeta = () =>
    CHAT_PROVIDERS.find((p) => p.id === props.chat.providerId()) ??
    CHAT_PROVIDERS[0];

  return (
    <div class="settings-category-panel">
      <div class="settings-callout">
        <div class="settings-callout-title">External Agent Control</div>
        <p class="settings-callout-copy">
          Vessel is configured to run under an external harness such as Hermes
          Agent or OpenClaw. Provider and model selection are not configured
          inside Vessel.
        </p>
      </div>

      <div class="settings-field">
        <label class="settings-toggle">
          <button
            type="button"
            class="toggle-switch"
            classList={{ on: props.chat.enabled() }}
            onClick={() => props.chat.setEnabled(!props.chat.enabled())}
            role="switch"
            aria-checked={props.chat.enabled()}
          >
            <span class="toggle-switch-thumb" />
          </button>
          <span>Enable Chat Assistant</span>
        </label>
        <p class="settings-hint">
          Adds a Chat tab to the sidebar for conversing with an AI provider of
          your choice.
        </p>
      </div>

      <Show when={props.chat.enabled()}>
        <div class="settings-field">
          <label class="settings-label" for="chat-provider">
            Provider
          </label>
          <select
            id="chat-provider"
            class="settings-input settings-select"
            value={props.chat.providerId()}
            onChange={(e) => {
              const id = e.currentTarget.value as ProviderId;
              props.chat.setProviderId(id);
              props.chat.setModel("");
              props.chat.setBaseUrl("");
              props.chat.setApiKey("");
              props.chat.setHasStoredApiKey(false);
              props.chat.resetProviderModels();
            }}
          >
            <For each={CHAT_PROVIDERS}>
              {(p) => <option value={p.id}>{p.name}</option>}
            </For>
          </select>
        </div>

        <Show when={props.chat.providerType() === "codex_oauth"}>
          <div class="settings-field">
            <label class="settings-label">Account</label>
            <Show
              when={props.chat.codexAuthStatus() === "connected"}
              fallback={
                <div>
                  <Show
                    when={
                      props.chat.codexAuthStatus() === "waiting" ||
                      props.chat.codexAuthStatus() === "exchanging"
                    }
                    fallback={
                      <div>
                        <button
                          type="button"
                          class="settings-btn"
                          onClick={() => props.chat.startCodexAuth()}
                          disabled={props.chat.codexAuthStatus() === "waiting" || props.chat.codexAuthStatus() === "exchanging"}
                        >
                          Connect with ChatGPT
                        </button>
                        <p class="settings-hint">
                          Sign in with your ChatGPT Plus or Pro subscription. A
                          browser tab will open where you'll authorize Vessel.
                        </p>
                        <Show when={props.chat.codexAuthStatus() === "error"}>
                          <p class="settings-hint" style="color:var(--error)">
                            {props.chat.codexAuthError()}
                          </p>
                          <button
                            type="button"
                            class="settings-btn"
                            onClick={() => props.chat.startCodexAuth()}
                          >
                            Try Again
                          </button>
                        </Show>
                      </div>
                    }
                  >
                    <p class="settings-hint" style="color:var(--accent-primary)">
                      <Show
                        when={props.chat.codexAuthStatus() === "waiting"}
                        fallback="Exchanging authorization..."
                      >
                        Waiting for browser login...
                      </Show>
                      {" "}
                      <button
                        type="button"
                        class="settings-link-btn"
                        onClick={() => window.vessel.codex.cancelAuth()}
                      >
                        Cancel
                      </button>
                    </p>
                  </Show>
                </div>
              }
            >
              <div style="display:flex;align-items:center;gap:8px">
                <span
                  style="width:8px;height:8px;border-radius:50%;background:var(--success);display:inline-block"
                />
                <span>
                  Connected as {props.chat.codexAccountEmail() || "ChatGPT"}
                </span>
              </div>
              <p class="settings-hint">
                <button
                  type="button"
                  class="settings-link-btn"
                  onClick={() => props.chat.disconnectCodex()}
                >
                  Disconnect
                </button>
              </p>
            </Show>
          </div>
        </Show>

        <Show
          when={
            props.chat.providerType() !== "codex_oauth" &&
            (chatMeta().requiresKey ||
            props.chat.providerId() === "custom")
          }
        >
          <div class="settings-field">
            <label class="settings-label" for="chat-api-key">
              API Key
              <Show when={!chatMeta().requiresKey}>
                <span class="settings-label-optional"> (optional)</span>
              </Show>
            </label>
            <input
              id="chat-api-key"
              class="settings-input"
              type="password"
              value={props.chat.apiKey()}
              onInput={(e) => {
                props.chat.setApiKey(e.currentTarget.value);
                if (e.currentTarget.value.trim()) {
                  props.chat.setHasStoredApiKey(true);
                }
              }}
              placeholder={
                props.chat.hasStoredApiKey() && !props.chat.apiKey().trim()
                  ? "Stored securely. Enter a new key to replace it."
                  : chatMeta().keyPlaceholder || "Bearer token or API key"
              }
              spellcheck={false}
            />
            <Show
              when={
                props.chat.hasStoredApiKey() && !props.chat.apiKey().trim()
              }
            >
              <p class="settings-hint">
                An API key is already stored securely for this provider. Leave
                this blank to keep it, or enter a new key to replace it.
              </p>
            </Show>
            <Show when={props.chat.providerId() === "custom"}>
              <p class="settings-hint">
                If your endpoint requires authentication, enter the API key or
                bearer token here.
              </p>
            </Show>
          </div>
        </Show>

        <div class="settings-field">
          <label class="settings-label" for="chat-model">
            Model
          </label>
          <div style="display:flex;gap:6px;align-items:center">
            <Show
              when={props.chat.providerModels().length > 0}
              fallback={
                <input
                  id="chat-model"
                  class="settings-input"
                  style="flex:1"
                  value={props.chat.model()}
                  onInput={(e) => props.chat.setModel(e.currentTarget.value)}
                  placeholder={
                    props.chat.modelFetchState() === "loading"
                      ? "Fetching models…"
                      : chatMeta().requiresKey &&
                          !props.chat.apiKey().trim() &&
                          !props.chat.hasStoredApiKey()
                        ? "Enter API key to load models"
                        : chatMeta().defaultModel || "model name"
                  }
                  spellcheck={false}
                />
              }
            >
              <select
                id="chat-model"
                class="settings-input settings-select"
                style="flex:1"
                value={props.chat.model()}
                onChange={(e) => props.chat.setModel(e.currentTarget.value)}
              >
                <For each={props.chat.providerModels()}>
                  {(m) => <option value={m}>{m}</option>}
                </For>
              </select>
            </Show>
            <button
              type="button"
              class="settings-refresh-btn"
              title="Refresh model list"
              disabled={props.chat.modelFetchState() === "loading"}
              onClick={() => props.chat.doFetchModels()}
            >
              ↺
            </button>
          </div>
          <Show when={props.chat.modelFetchState() === "error"}>
            <p class="settings-hint" style="color:var(--error)">
              Could not fetch models — check your API key and connection.
            </p>
          </Show>
          <Show when={props.chat.modelFetchWarning()}>
            {(warning) => (
              <p class="settings-hint" style="color:var(--accent-primary)">
                {warning()}
              </p>
            )}
          </Show>
        </div>

        <Show
          when={
            chatMeta().needsBaseUrl ||
            props.chat.providerId() === "custom"
          }
        >
          <div class="settings-field">
            <label class="settings-label" for="chat-base-url">
              Base URL
            </label>
            <input
              id="chat-base-url"
              class="settings-input"
              value={props.chat.baseUrl()}
              onInput={(e) => props.chat.setBaseUrl(e.currentTarget.value)}
              placeholder={chatMeta().defaultBaseUrl ?? "https://..."}
              spellcheck={false}
            />
          </div>
        </Show>
        <Show when={props.chat.providerId() === "llama_cpp"}>
          <p class="settings-hint">
            Vessel auto-detects the active model from your configured{" "}
            <code>llama-server</code> base URL. For agent loops, run{" "}
            <code>llama-server</code> with <code>--ctx-size 16384</code> minimum
            and <code>32768</code> recommended.
          </p>
        </Show>

        <div class="settings-field">
          <label class="settings-label" for="chat-reasoning-effort">
            Reasoning Level
          </label>
          <select
            id="chat-reasoning-effort"
            class="settings-input settings-select"
            value={props.chat.reasoningEffort()}
            onChange={(e) =>
              props.chat.setReasoningEffort(
                e.currentTarget.value as ReasoningEffortLevel,
              )
            }
          >
            <For each={REASONING_EFFORT_OPTIONS}>
              {(option) => (
                <option value={option.value}>{option.label}</option>
              )}
            </For>
          </select>
          <p class="settings-hint">
            Applies to providers and models that expose reasoning controls.
            Off requests no reasoning where supported and otherwise leaves the
            model at its normal behavior; Max requests the strongest supported
            reasoning tier.
          </p>
        </div>
      </Show>

      <div class="settings-field">
        <label class="settings-label" for="mcp-port">
          MCP Port
        </label>
        <input
          id="mcp-port"
          class="settings-input"
          value={props.mcpPort()}
          onInput={(e) => props.setMcpPort(e.currentTarget.value)}
          placeholder="3100"
          spellcheck={false}
        />
        <p class="settings-hint">
          External harnesses connect to Vessel at{" "}
          <code>http://127.0.0.1:&lt;port&gt;/mcp</code>. Changing this value
          restarts the MCP server immediately.
        </p>
      </div>

      <div class="settings-field">
        <label class="settings-label" for="max-tool-iterations">
          Max Tool Iterations
        </label>
        <Show
          when={props.premiumActive()}
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
            value={props.maxToolIterations()}
            onInput={(e) => props.setMaxToolIterations(e.currentTarget.value)}
            placeholder="200"
          />
        </Show>
        <p class="settings-hint">
          <Show
            when={props.premiumActive()}
            fallback="Free tier: 50 tool calls per conversation turn. Upgrade to Vessel Premium to customize this limit (up to 1,000)."
          >
            Maximum number of tool calls the AI agent can make per conversation
            turn before pausing. Higher values let the agent complete longer
            multi-step workflows without stopping. Range: 10–1000.
          </Show>
        </p>
      </div>

      <div class="settings-field">
        <label class="settings-label" for="agent-transcript-mode">
          Agent Transcript Monitor
        </label>
        <select
          id="agent-transcript-mode"
          class="settings-input settings-select"
          value={props.agentTranscriptMode()}
          onChange={(e) =>
            props.setAgentTranscriptMode(
              e.currentTarget.value as AgentTranscriptDisplayMode,
            )
          }
        >
          <option value="off">Off</option>
          <option value="summary">Summary HUD</option>
          <option value="full">Full transcript</option>
        </select>
        <p class="settings-hint">
          Controls the in-browser transcript monitor when an external harness
          publishes reasoning or status updates into Vessel via the{" "}
          <code>vessel_publish_transcript</code> MCP tool. Summary HUD shows a
          compact 2-line status surface; Full transcript shows the recent entry
          list.
        </p>
      </div>

      <Show when={props.health()}>
        {(currentHealth) => (
          <div class="settings-health">
            <div class="settings-callout-title">Runtime Health</div>
            <p class="settings-hint">
              MCP status: <strong>{currentHealth().mcp.status}</strong>{" "}
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
          value={props.obsidianVaultPath()}
          onInput={(e) => props.setObsidianVaultPath(e.currentTarget.value)}
          placeholder="/home/you/Documents/MyVault"
          spellcheck={false}
        />
        <p class="settings-hint">
          Optional. When set, Vessel memory tools can write markdown notes into
          this vault for research breadcrumbs and summaries.
        </p>
      </div>
    </div>
  );
};

export default SettingsAgent;
