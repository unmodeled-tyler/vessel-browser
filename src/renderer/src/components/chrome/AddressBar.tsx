import { createSignal, createEffect, type Component } from 'solid-js';
import { useTabs } from '../../stores/tabs';
import { useUI } from '../../stores/ui';
import './chrome.css';

const AddressBar: Component = () => {
  const { activeTab, navigate, goBack, goForward, reload } = useTabs();
  const { openCommandBar, toggleSidebar, openSettings } = useUI();
  const [inputValue, setInputValue] = createSignal('');
  let inputRef: HTMLInputElement | undefined;

  // Sync URL from active tab
  createEffect(() => {
    const tab = activeTab();
    if (tab && !inputRef?.matches(':focus')) {
      setInputValue(tab.url === 'about:blank' ? '' : tab.url);
    }
  });

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const val = inputValue().trim();
    if (val) {
      navigate(val);
      inputRef?.blur();
    }
  };

  return (
    <div class="address-bar">
      <div class="nav-controls">
        <button
          class="nav-btn"
          onClick={goBack}
          disabled={!activeTab()?.canGoBack}
          title="Back"
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path
              d="M9 2L4 7l5 5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          class="nav-btn"
          onClick={goForward}
          disabled={!activeTab()?.canGoForward}
          title="Forward"
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path
              d="M5 2l5 5-5 5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button class="nav-btn" onClick={reload} title="Reload">
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path
              d="M2.5 7a4.5 4.5 0 1 1 1 3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
            <path
              d="M2 4v3.5h3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>

      <form class="url-form" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          class="url-input"
          type="text"
          value={inputValue()}
          onInput={(e) => setInputValue(e.currentTarget.value)}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="Search or enter URL"
          spellcheck={false}
        />
      </form>

      <div class="toolbar-actions">
        <button
          class="nav-btn"
          onClick={() => window.vessel.content.toggleReader()}
          title="Reader Mode"
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <rect
              x="2"
              y="1"
              width="10"
              height="12"
              rx="1"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <line
              x1="4"
              y1="4"
              x2="10"
              y2="4"
              stroke="currentColor"
              stroke-width="1"
            />
            <line
              x1="4"
              y1="6.5"
              x2="10"
              y2="6.5"
              stroke="currentColor"
              stroke-width="1"
            />
            <line
              x1="4"
              y1="9"
              x2="8"
              y2="9"
              stroke="currentColor"
              stroke-width="1"
            />
          </svg>
        </button>
        <button
          class="nav-btn ai-btn"
          onClick={openCommandBar}
          title="AI Command Bar (Ctrl+L)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <circle
              cx="7"
              cy="7"
              r="5.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <circle cx="5" cy="6" r="0.8" fill="currentColor" />
            <circle cx="9" cy="6" r="0.8" fill="currentColor" />
            <path
              d="M5 9c0.5 1 3.5 1 4 0"
              fill="none"
              stroke="currentColor"
              stroke-width="0.8"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <button
          class="nav-btn"
          onClick={toggleSidebar}
          title="AI Sidebar (Ctrl+Shift+L)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <rect
              x="1"
              y="1"
              width="12"
              height="12"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <line
              x1="9"
              y1="1"
              x2="9"
              y2="13"
              stroke="currentColor"
              stroke-width="1.2"
            />
          </svg>
        </button>
        <button class="nav-btn" onClick={openSettings} title="Settings (Ctrl+,)">
          <svg width="14" height="14" viewBox="0 0 14 14">
            <circle
              cx="7"
              cy="7"
              r="2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path
              d="M7 1v2M7 11v2M1 7h2M11 7h2M2.8 2.8l1.4 1.4M9.8 9.8l1.4 1.4M11.2 2.8l-1.4 1.4M4.2 9.8l-1.4 1.4"
              stroke="currentColor"
              stroke-width="1"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default AddressBar;
