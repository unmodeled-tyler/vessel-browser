import {
  createEffect,
  createSignal,
  Show,
  onMount,
  type Component,
} from "solid-js";
import { useUI } from "../../stores/ui";
import type {
  AgentTranscriptDisplayMode,
  RuntimeHealthState,
} from "../../../shared/types";

const Settings: Component = () => {
  const { settingsOpen, closeSettings } = useUI();
  const [autoRestoreSession, setAutoRestoreSession] = createSignal(true);
  const [clearBookmarksOnLaunch, setClearBookmarksOnLaunch] =
    createSignal(false);
  const [obsidianVaultPath, setObsidianVaultPath] = createSignal("");
  const [mcpPort, setMcpPort] = createSignal("3100");
  const [agentTranscriptMode, setAgentTranscriptMode] =
    createSignal<AgentTranscriptDisplayMode>("summary");
  const [health, setHealth] = createSignal<RuntimeHealthState | null>(null);
  const [status, setStatus] = createSignal<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const loadState = async () => {
    const settings = await window.vessel.settings.get();
    const runtimeHealth = await window.vessel.settings.getHealth();
    setAutoRestoreSession(settings.autoRestoreSession ?? true);
    setClearBookmarksOnLaunch(settings.clearBookmarksOnLaunch ?? false);
    setObsidianVaultPath(settings.obsidianVaultPath ?? "");
    setMcpPort(String(settings.mcpPort ?? 3100));
    setAgentTranscriptMode(settings.agentTranscriptMode ?? "summary");
    setHealth(runtimeHealth);
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
      await window.vessel.settings.set(
        "agentTranscriptMode",
        agentTranscriptMode(),
      );
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
              <input
                type="checkbox"
                checked={autoRestoreSession()}
                onChange={(e) => setAutoRestoreSession(e.currentTarget.checked)}
              />
              <span>Restore last browser session on launch</span>
            </label>
          </div>

          <div class="settings-field">
            <label class="settings-toggle">
              <input
                type="checkbox"
                checked={clearBookmarksOnLaunch()}
                onChange={(e) =>
                  setClearBookmarksOnLaunch(e.currentTarget.checked)
                }
              />
              <span>Start bookmarks fresh on launch</span>
            </label>
            <p class="settings-hint">
              Off by default. When enabled, bookmark folders and saved pages are
              cleared each time Vessel starts.
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
          width: min(420px, calc(100vw - 32px));
          max-height: calc(100vh - 48px);
          background: var(--bg-elevated);
          border: 1px solid var(--border-visible);
          border-radius: var(--radius-lg);
          padding: 24px;
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-gutter: stable;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
        }
        .settings-title {
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 20px;
        }
        .settings-callout {
          margin-bottom: 18px;
          padding: 12px;
          border-radius: var(--radius-md);
          border: 1px solid rgba(159, 184, 255, 0.18);
          background: rgba(159, 184, 255, 0.08);
        }
        .settings-callout-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 6px;
        }
        .settings-callout-copy {
          font-size: 12px;
          line-height: 1.5;
          color: var(--text-secondary);
          margin: 0;
        }
        .settings-field {
          margin-bottom: 16px;
        }
        .settings-health {
          margin-bottom: 18px;
          padding: 12px;
          border-radius: var(--radius-md);
          border: 1px solid var(--border-visible);
          background: rgba(255, 255, 255, 0.02);
        }
        .settings-health-issues {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 8px;
        }
        .settings-health-issue {
          font-size: 12px;
          line-height: 1.5;
          padding: 10px;
          border-radius: var(--radius-sm);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--text-secondary);
        }
        .settings-health-issue.warning {
          border-color: rgba(240, 198, 54, 0.35);
          background: rgba(240, 198, 54, 0.08);
        }
        .settings-health-issue.error {
          border-color: rgba(255, 108, 91, 0.4);
          background: rgba(255, 108, 91, 0.08);
        }
        .settings-label {
          display: block;
          font-size: 12px;
          color: var(--text-secondary);
          margin-bottom: 6px;
          font-weight: 500;
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
        }
        .settings-select {
          appearance: none;
        }
        .settings-input:focus {
          border-color: var(--accent-primary);
          outline: none;
        }
        .settings-hint {
          font-size: 11px;
          color: var(--text-muted);
          margin-top: 4px;
        }
        .settings-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          margin-top: 20px;
        }
        .settings-toggle {
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--text-primary);
          font-size: 13px;
        }
        .settings-toggle input {
          width: 14px;
          height: 14px;
        }
        .settings-status {
          margin-top: 12px;
          font-size: 12px;
        }
        .settings-status.success {
          color: #84d19a;
        }
        .settings-status.error {
          color: #ff8e8e;
        }
        .settings-save, .settings-close {
          height: 32px;
          padding: 0 16px;
          border-radius: var(--radius-md);
          font-size: 12px;
          font-weight: 500;
        }
        .settings-save {
          background: var(--accent-primary);
          color: white;
        }
        .settings-save:hover { background: #7a6db7; }
        .settings-close {
          background: var(--bg-tertiary);
          color: var(--text-secondary);
        }
        .settings-close:hover { background: var(--border-visible); }
      `}</style>
    </Show>
  );
};

export default Settings;
