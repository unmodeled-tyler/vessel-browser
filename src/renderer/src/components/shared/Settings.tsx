import { createSignal, Show, onMount, type Component } from 'solid-js';
import { useUI } from '../../stores/ui';

const Settings: Component = () => {
  const { settingsOpen, closeSettings } = useUI();
  const [apiKey, setApiKey] = createSignal('');
  const [saved, setSaved] = createSignal(false);

  onMount(async () => {
    const settings = await window.vessel.settings.get();
    setApiKey(settings.apiKey || '');
  });

  const handleSave = async () => {
    await window.vessel.settings.set('apiKey', apiKey());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeSettings();
  };

  return (
    <Show when={settingsOpen()}>
      <div class="command-bar-overlay" onClick={closeSettings}>
        <div
          class="settings-panel"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          <h2 class="settings-title">Settings</h2>

          <div class="settings-field">
            <label class="settings-label">Claude API Key</label>
            <input
              class="settings-input"
              type="password"
              value={apiKey()}
              onInput={(e) => setApiKey(e.currentTarget.value)}
              placeholder="sk-ant-..."
              spellcheck={false}
            />
            <p class="settings-hint">
              Get your key from console.anthropic.com
            </p>
          </div>

          <div class="settings-actions">
            <button class="settings-save" onClick={handleSave}>
              {saved() ? 'Saved!' : 'Save'}
            </button>
            <button class="settings-close" onClick={closeSettings}>
              Close
            </button>
          </div>
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
