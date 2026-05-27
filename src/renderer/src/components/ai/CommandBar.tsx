import { createSignal, createResource, For, Show, type Component } from 'solid-js';
import { useUI } from '../../stores/ui';
import { useAI } from '../../stores/ai';
import { useAnimatedPresence } from '../../lib/useAnimatedPresence';
import { useProviderAuthSetup } from '../shared/useProviderAuthSetup';
import './ai.css';

const COMMAND_BAR_EXIT_MS = 200;

const CommandBar: Component = () => {
  const { commandBarOpen, closeCommandBar, toggleSidebar, openSettings } = useUI();
  const { visible, closing } = useAnimatedPresence(commandBarOpen, COMMAND_BAR_EXIT_MS);
  const { query, recentQueries, isStreaming, cancel } = useAI();
  const [input, setInput] = createSignal('');
  let inputRef: HTMLInputElement | undefined;

  const [settings, { refetch: refetchSettings }] = createResource(
    () => commandBarOpen(),
    async (open) => open ? window.vessel.settings.get() : null,
  );
  const providerAuth = useProviderAuthSetup({
    onOpenRouterConnected: async () => {
      await refetchSettings();
      setTimeout(() => inputRef?.focus(), 0);
    },
  });
  const hasProvider = () => settings()?.chatProvider !== null && settings()?.chatProvider !== undefined;
  const openRouterWorking = () =>
    providerAuth.openRouterAuthStatus() === "waiting" ||
    providerAuth.openRouterAuthStatus() === "exchanging";

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const val = input().trim();
    if (!val) return;
    const result = await query(val);
    if (result === 'rejected') return;
    setInput('');
    closeCommandBar();
    await toggleSidebar();
  };

  const handleRecentClick = async (q: string) => {
    setInput('');
    closeCommandBar();
    await toggleSidebar();
    await query(q);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (isStreaming()) {
        cancel();
      }
      closeCommandBar();
    }
  };

  const setRef = (el: HTMLInputElement) => {
    inputRef = el;
    setTimeout(() => el.focus(), 0);
  };

  return (
    <Show when={visible()}>
      <div class="command-bar-overlay" classList={{ closing: closing() }} onClick={closeCommandBar}>
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
              placeholder={hasProvider() ? "Ask about this page, summarize, or search..." : "No chat provider configured"}
              spellcheck={false}
              disabled={!hasProvider()}
            />
          </form>
          <Show when={!hasProvider()}>
            <div class="command-bar-no-provider">
              <p>
                Start with OpenRouter's free model router, or open Settings for more providers.
              </p>
              <button
                class="command-bar-no-provider-btn"
                disabled={openRouterWorking()}
                onClick={() => void providerAuth.startOpenRouterAuth()}
              >
                <Show when={!openRouterWorking()} fallback="Opening OpenRouter...">
                  Start free with OpenRouter
                </Show>
              </button>
              <button
                class="command-bar-no-provider-link"
                onClick={() => { closeCommandBar(); openSettings(); }}
              >
                More options
              </button>
              <Show when={providerAuth.openRouterAuthStatus() === "error"}>
                <p class="command-bar-no-provider-error">{providerAuth.openRouterAuthError()}</p>
              </Show>
            </div>
          </Show>
          <Show when={hasProvider() && recentQueries().length > 0 && !input().trim()}>
            <div class="command-bar-recent">
              <span class="command-bar-recent-label">Recent</span>
              <div class="command-bar-recent-list">
                <For each={recentQueries()}>
                  {(q) => (
                    <button
                      class="command-bar-recent-item"
                      type="button"
                      onClick={() => void handleRecentClick(q)}
                    >
                      {q}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <div class="command-bar-hints">
            <span>
              <kbd>Enter</kbd> to ask
            </span>
            <span>
              <kbd>Esc</kbd> to close
            </span>
            <Show when={hasProvider()} fallback={<span>Set up a provider in Settings first</span>}>
              <span>Try "summarize" or ask a question</span>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default CommandBar;
