import { For, Show, type Component } from "solid-js";
import { SEARCH_ENGINE_PRESETS } from "../../../../shared/types";
import type { SearchEngineId } from "../../../../shared/types";
import type { SettingsGeneralProps } from "./settingsTypes";

const SettingsGeneral: Component<SettingsGeneralProps> = (props) => {
  return (
    <div class="settings-category-panel">
      <Show when={props.welcomeBanner.show()}>
        <div class="welcome-banner">
          <div class="welcome-banner-header">
            <span class="welcome-banner-title">Welcome to Vessel</span>
            <button
              class="welcome-banner-dismiss"
              onClick={props.welcomeBanner.dismiss}
            >
              &times;
            </button>
          </div>
          <p class="welcome-banner-text">Get started in three steps:</p>
          <ol class="welcome-banner-steps">
            <li>
              <strong>Configure a chat provider</strong> — switch to AI & Agent
              to add an API key
            </li>
            <li>
              <strong>Connect your agent harness</strong> — point it at the MCP
              endpoint shown in AI & Agent
            </li>
            <li>
              <strong>Learn the shortcuts</strong> — press <kbd>?</kbd> anytime
              for a quick reference
            </li>
          </ol>
          <Show when={!props.premiumActive()}>
            <div class="welcome-banner-actions">
              <button
                class="premium-btn premium-btn-upgrade"
                onClick={props.startPremiumCheckout}
              >
                Try Premium free for 7 days — $5.99/mo after
              </button>
              <span class="welcome-banner-note">
                Best for screenshots, saved sessions, credential vault, and
                longer autonomous runs.
              </span>
            </div>
          </Show>
        </div>
      </Show>

      <div class="settings-field">
        <label class="settings-label" for="default-homepage">
          Homepage
        </label>
        <input
          id="default-homepage"
          class="settings-input"
          value={props.defaultUrl()}
          onInput={(e) => props.setDefaultUrl(e.currentTarget.value)}
          placeholder="https://start.duckduckgo.com"
          spellcheck={false}
        />
        <p class="settings-hint">
          The page that opens when you create a new tab or launch Vessel without
          restoring a previous session.
        </p>
      </div>

      <div class="settings-field">
        <label class="settings-label" for="default-search-engine">
          Default Search Engine
        </label>
        <select
          id="default-search-engine"
          class="settings-input"
          value={props.defaultSearchEngine()}
          onChange={(e) =>
            props.setDefaultSearchEngine(
              e.currentTarget.value as SearchEngineId,
            )
          }
        >
          <For each={Object.entries(SEARCH_ENGINE_PRESETS)}>
            {([id, preset]) => <option value={id}>{preset.label}</option>}
          </For>
          <option value="none">None (disabled)</option>
        </select>
        <p class="settings-hint">
          The search engine used by the AI agent when it needs to search the
          web. "None" disables the fallback and forces the agent to use on-page
          search inputs only.
        </p>
      </div>

      <div class="settings-field">
        <label class="settings-label" for="download-path">
          Download Location
        </label>
        <input
          id="download-path"
          class="settings-input"
          value={props.downloadPath()}
          onInput={(e) => props.setDownloadPath(e.currentTarget.value)}
          placeholder="Default: ~/Downloads"
          spellcheck={false}
        />
        <p class="settings-hint">
          Directory for saved files. Leave blank to use the system default
          Downloads folder.
        </p>
      </div>

      <div class="settings-field">
        <label class="settings-label" for="theme-select">
          Theme
        </label>
        <select
          id="theme-select"
          class="settings-input settings-select"
          value={props.theme()}
          onChange={(e) =>
            props.setTheme(e.currentTarget.value as "dark" | "light")
          }
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
        <p class="settings-hint">
          Choose the application color scheme. Takes effect after saving.
        </p>
      </div>

      <div class="settings-field">
        <label class="settings-toggle">
          <button
            type="button"
            class="toggle-switch"
            classList={{ on: props.autoRestoreSession() }}
            onClick={() =>
              props.setAutoRestoreSession(!props.autoRestoreSession())
            }
            role="switch"
            aria-checked={props.autoRestoreSession()}
          >
            <span class="toggle-switch-thumb" />
          </button>
          <span>Restore last browser session on launch</span>
        </label>
      </div>

      <div class="settings-field">
        <label class="settings-toggle">
          <button
            type="button"
            class="toggle-switch"
            classList={{ on: props.clearBookmarksOnLaunch() }}
            onClick={() =>
              props.setClearBookmarksOnLaunch(!props.clearBookmarksOnLaunch())
            }
            role="switch"
            aria-checked={props.clearBookmarksOnLaunch()}
          >
            <span class="toggle-switch-thumb" />
          </button>
          <span>Start bookmarks fresh on launch</span>
        </label>
        <p class="settings-hint">
          Off by default. When enabled, bookmark folders and saved pages are
          cleared each time Vessel starts.
        </p>
      </div>
    </div>
  );
};

export default SettingsGeneral;
