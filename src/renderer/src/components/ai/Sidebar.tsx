import { createSignal, For, Show, createEffect, type Component } from 'solid-js';
import { useAI } from '../../stores/ai';
import { useUI } from '../../stores/ui';
import './ai.css';

const Sidebar: Component = () => {
  const { messages, streamingText, isStreaming, query, cancel, clearHistory } =
    useAI();
  const { sidebarOpen } = useUI();
  const [input, setInput] = createSignal('');
  let messagesEndRef: HTMLDivElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;

  // Auto-scroll to bottom on new messages
  createEffect(() => {
    messages();
    streamingText();
    messagesEndRef?.scrollIntoView({ behavior: 'smooth' });
  });

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const val = input().trim();
    if (!val || isStreaming()) return;
    setInput('');
    await query(val);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <Show when={sidebarOpen()}>
      <div class="sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">Vessel AI</span>
          <button class="sidebar-clear" onClick={clearHistory} title="Clear">
            Clear
          </button>
        </div>

        <div class="sidebar-messages">
          <For each={messages()}>
            {(msg) => (
              <div class={`message message-${msg.role}`}>
                <div class="message-content">{msg.content}</div>
              </div>
            )}
          </For>

          <Show when={isStreaming()}>
            <div class="message message-assistant">
              <div class="message-content">
                {streamingText()}
                <span class="cursor-blink">|</span>
              </div>
            </div>
          </Show>

          <Show when={messages().length === 0 && !isStreaming()}>
            <div class="sidebar-empty">
              <p>Ask me anything about the current page.</p>
              <p class="sidebar-empty-hint">
                Try "summarize", "what is this about?", or any question.
              </p>
            </div>
          </Show>

          <div ref={messagesEndRef} />
        </div>

        <form class="sidebar-input-area" onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            class="sidebar-input"
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask something..."
            rows={2}
            disabled={isStreaming()}
          />
          <Show
            when={isStreaming()}
            fallback={
              <button
                class="sidebar-send"
                type="submit"
                disabled={!input().trim()}
              >
                Send
              </button>
            }
          >
            <button class="sidebar-cancel" type="button" onClick={cancel}>
              Stop
            </button>
          </Show>
        </form>
      </div>
    </Show>
  );
};

export default Sidebar;
