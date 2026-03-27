import { Show, type Component } from "solid-js";

interface KeyboardHelpProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  { keys: "Ctrl+L", action: "AI Command Bar" },
  { keys: "Ctrl+Shift+L", action: "Toggle AI Sidebar" },
  { keys: "Ctrl+Shift+F", action: "Toggle Focus Mode" },
  { keys: "F12", action: "Toggle Dev Tools Panel" },
  { keys: "Ctrl+T", action: "New Tab" },
  { keys: "Ctrl+W", action: "Close Tab" },
  { keys: "Ctrl+,", action: "Settings" },
  { keys: "Ctrl+H", action: "Capture Highlight" },
  { keys: "?", action: "This help overlay" },
];

const KeyboardHelp: Component<KeyboardHelpProps> = (props) => {
  return (
    <Show when={props.open}>
      <div class="command-bar-overlay" onClick={props.onClose}>
        <div class="keyboard-help" onClick={(e) => e.stopPropagation()}>
          <div class="keyboard-help-header">
            <h2 class="keyboard-help-title">Keyboard Shortcuts</h2>
            <button class="keyboard-help-close" onClick={props.onClose}>
              <kbd>Esc</kbd>
            </button>
          </div>
          <div class="keyboard-help-grid">
            {SHORTCUTS.map((s) => (
              <>
                <div class="keyboard-help-keys">
                  {s.keys.split("+").map((k, i) => (
                    <>
                      {i > 0 && <span class="keyboard-help-plus">+</span>}
                      <kbd>{k}</kbd>
                    </>
                  ))}
                </div>
                <div class="keyboard-help-action">{s.action}</div>
              </>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        .keyboard-help {
          width: min(380px, calc(100vw - 32px));
          background: var(--bg-elevated);
          border: 1px solid var(--border-visible);
          border-radius: 14px;
          padding: 24px;
          box-shadow:
            0 4px 24px rgba(0, 0, 0, 0.2),
            0 24px 64px rgba(0, 0, 0, 0.3),
            inset 0 1px 0 rgba(255, 255, 255, 0.04);
          animation: command-bar-enter 350ms var(--ease-out-expo) both;
        }
        .keyboard-help-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }
        .keyboard-help-title {
          font-size: 15px;
          font-weight: 600;
          color: var(--text-primary);
          margin: 0;
        }
        .keyboard-help-close {
          background: transparent;
          border: none;
          cursor: pointer;
          padding: 0;
        }
        .keyboard-help-close kbd {
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.08);
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 11px;
          color: var(--text-muted);
          font-family: var(--font-ui);
        }
        .keyboard-help-close:hover kbd {
          background: rgba(255, 255, 255, 0.1);
          color: var(--text-secondary);
        }
        .keyboard-help-grid {
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 10px 20px;
          align-items: center;
        }
        .keyboard-help-keys {
          display: flex;
          align-items: center;
          gap: 2px;
          justify-self: end;
        }
        .keyboard-help-keys kbd {
          display: inline-block;
          min-width: 24px;
          padding: 3px 7px;
          text-align: center;
          font-size: 11px;
          font-family: var(--font-mono);
          font-weight: 500;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 4px;
          color: var(--text-primary);
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
        }
        .keyboard-help-plus {
          font-size: 10px;
          color: var(--text-muted);
          margin: 0 1px;
        }
        .keyboard-help-action {
          font-size: 13px;
          color: var(--text-secondary);
        }
      `}</style>
    </Show>
  );
};

export default KeyboardHelp;
