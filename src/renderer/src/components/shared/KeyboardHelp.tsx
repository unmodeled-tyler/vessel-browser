import { Show, type Component } from "solid-js";
import { useAnimatedPresence } from "../../lib/useAnimatedPresence";

interface KeyboardHelpProps {
  open: boolean;
  onClose: () => void;
  privateMode?: boolean;
}

const SHORTCUTS = [
  { keys: "Ctrl+L", action: "AI Command Bar", privateMode: false },
  { keys: "Ctrl+Shift+L", action: "Toggle AI Sidebar", privateMode: false },
  { keys: "Ctrl+Shift+F", action: "Toggle Focus Mode", privateMode: false },
  { keys: "F12", action: "Toggle Dev Tools Panel", privateMode: false },
  { keys: "Ctrl+N", action: "New Window" },
  { keys: "Ctrl+T", action: "New Tab" },
  { keys: "Ctrl+W", action: "Close Tab" },
  { keys: "Ctrl+Shift+T", action: "Reopen Closed Tab" },
  { keys: "Ctrl+F", action: "Find in Page" },
  { keys: "Ctrl++ / Ctrl+=", action: "Zoom In" },
  { keys: "Ctrl+-", action: "Zoom Out" },
  { keys: "Ctrl+0", action: "Reset Zoom" },
  { keys: "Ctrl+Shift+N", action: "New Private Window" },
  { keys: "Ctrl+P", action: "Print Page" },
  { keys: "Ctrl+Shift+P", action: "Save Page as PDF" },
  { keys: "Ctrl+,", action: "Settings", privateMode: false },
  { keys: "Ctrl+H", action: "Capture Highlight", privateMode: false },
  { keys: "?", action: "This help overlay" },
];

function shortcutParts(keys: string): string[][] {
  return keys.split(" / ").map((combo) =>
    combo
      .replace(/\+\+/g, "+Plus")
      .split("+")
      .filter(Boolean)
      .map((key) => (key === "Plus" ? "+" : key)),
  );
}

const KeyboardHelp: Component<KeyboardHelpProps> = (props) => {
  const { visible, closing } = useAnimatedPresence(() => props.open, 200);
  const shortcuts = () =>
    props.privateMode
      ? SHORTCUTS.filter((shortcut) => shortcut.privateMode !== false)
      : SHORTCUTS;

  return (
    <Show when={visible()}>
      <div class="command-bar-overlay" classList={{ closing: closing() }} onClick={props.onClose}>
        <div class="keyboard-help" onClick={(e) => e.stopPropagation()}>
          <div class="keyboard-help-header">
            <h2 class="keyboard-help-title">Keyboard Shortcuts</h2>
            <button class="keyboard-help-close" onClick={props.onClose}>
              <kbd>Esc</kbd>
            </button>
          </div>
          <div class="keyboard-help-grid">
            {shortcuts().map((s) => (
              <>
                <div class="keyboard-help-keys">
                  {shortcutParts(s.keys).map((combo, comboIndex) => (
                    <>
                      {comboIndex > 0 && (
                        <span class="keyboard-help-plus">/</span>
                      )}
                      {combo.map((key, keyIndex) => (
                        <>
                          {keyIndex > 0 && (
                            <span class="keyboard-help-plus">+</span>
                          )}
                          <kbd>{key}</kbd>
                        </>
                      ))}
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
            0 4px 24px var(--shadow-color),
            0 24px 64px var(--shadow-color-strong),
            inset 0 1px 0 var(--inset-highlight);
          animation: command-bar-enter 350ms var(--ease-out-expo) both;
        }
        .command-bar-overlay.closing .keyboard-help {
          animation: command-bar-exit 200ms var(--ease-in-out) both;
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
          background: var(--kbd-bg);
          border: 1px solid var(--kbd-border);
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 11px;
          color: var(--text-muted);
          font-family: var(--font-ui);
        }
        .keyboard-help-close:hover kbd {
          background: var(--surface-hover);
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
          background: var(--kbd-bg);
          border: 1px solid var(--kbd-border);
          border-radius: 4px;
          color: var(--text-primary);
          box-shadow: 0 1px 2px var(--shadow-color);
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
