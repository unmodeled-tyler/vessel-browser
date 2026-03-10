import { createSignal, Show, onMount, type Component } from "solid-js";
import type { ApprovalMode } from "../../../../shared/types";
import { useUI } from "../../stores/ui";

const Settings: Component = () => {
  const { settingsOpen, closeSettings } = useUI();
  const [autoRestoreSession, setAutoRestoreSession] = createSignal(true);
  const [clearBookmarksOnLaunch, setClearBookmarksOnLaunch] =
    createSignal(false);
  const [approvalMode, setApprovalMode] =
    createSignal<ApprovalMode>("confirm-dangerous");
  const [status, setStatus] = createSignal<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  onMount(async () => {
    const settings = await window.vessel.settings.get();
    setAutoRestoreSession(settings.autoRestoreSession ?? true);
    setClearBookmarksOnLaunch(settings.clearBookmarksOnLaunch ?? false);
    setApprovalMode(settings.approvalMode ?? "confirm-dangerous");
  });

  const handleSave = async () => {
    try {
      await Promise.all([
        window.vessel.settings.set("autoRestoreSession", autoRestoreSession()),
        window.vessel.settings.set(
          "clearBookmarksOnLaunch",
          clearBookmarksOnLaunch(),
        ),
        window.vessel.settings.set("approvalMode", approvalMode()),
      ]);
      setStatus({ kind: "success", text: "Saved." });
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
            <label class="settings-label" for="approval-mode-select">
              Approval Mode
            </label>
            <select
              id="approval-mode-select"
              class="settings-input settings-select"
              value={approvalMode()}
              onChange={(e) =>
                setApprovalMode(e.currentTarget.value as ApprovalMode)
              }
            >
              <option value="auto">Auto approve</option>
              <option value="confirm-dangerous">
                Approve dangerous actions
              </option>
              <option value="manual">Approve every action</option>
            </select>
            <p class="settings-hint">
              Controls when the human supervisor must approve agent actions.
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
          width: 420px;
          background: var(--bg-elevated);
          border: 1px solid var(--border-visible);
          border-radius: var(--radius-lg);
          padding: 24px;
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
