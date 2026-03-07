import { createSignal, Show, type Component } from 'solid-js';
import { useUI } from '../../stores/ui';
import { useAI } from '../../stores/ai';
import './ai.css';

const CommandBar: Component = () => {
  const { commandBarOpen, closeCommandBar, toggleSidebar } = useUI();
  const { query, streamingText, isStreaming, cancel } = useAI();
  const [input, setInput] = createSignal('');
  let inputRef: HTMLInputElement | undefined;

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const val = input().trim();
    if (!val || isStreaming()) return;
    setInput('');
    closeCommandBar();
    // Open sidebar to show response
    await toggleSidebar();
    await query(val);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (isStreaming()) {
        cancel();
      }
      closeCommandBar();
    }
  };

  // Auto-focus when opened
  const setRef = (el: HTMLInputElement) => {
    inputRef = el;
    setTimeout(() => el.focus(), 0);
  };

  return (
    <Show when={commandBarOpen()}>
      <div class="command-bar-overlay" onClick={closeCommandBar}>
        <div class="command-bar" onClick={(e) => e.stopPropagation()}>
          <form onSubmit={handleSubmit}>
            <div class="command-bar-icon">
              <svg width="16" height="16" viewBox="0 0 16 16">
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  fill="none"
                  stroke="var(--accent-primary)"
                  stroke-width="1.5"
                />
                <circle cx="6" cy="7" r="0.8" fill="var(--accent-primary)" />
                <circle cx="10" cy="7" r="0.8" fill="var(--accent-primary)" />
                <path
                  d="M6 10c0.5 0.8 3.5 0.8 4 0"
                  fill="none"
                  stroke="var(--accent-primary)"
                  stroke-width="0.8"
                  stroke-linecap="round"
                />
              </svg>
            </div>
            <input
              ref={setRef}
              class="command-bar-input"
              type="text"
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about this page, summarize, or search..."
              spellcheck={false}
            />
          </form>
          <div class="command-bar-hints">
            <span>
              <kbd>Enter</kbd> to ask
            </span>
            <span>
              <kbd>Esc</kbd> to close
            </span>
            <span>Try "summarize" or ask a question</span>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default CommandBar;
