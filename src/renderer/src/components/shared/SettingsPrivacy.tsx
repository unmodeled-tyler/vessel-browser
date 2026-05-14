import { createSignal, For, onMount, Show, type Component } from "solid-js";
import type { PermissionRecord } from "../../../../shared/types";
import type { SettingsPrivacyProps } from "./settingsTypes";

const SettingsPrivacy: Component<SettingsPrivacyProps> = (props) => {
  const [permissions, setPermissions] = createSignal<PermissionRecord[]>([]);
  const loadPermissions = async () => setPermissions(await window.vessel.permissions.getAll());
  onMount(() => { void loadPermissions(); });

  return (
    <div class="settings-category-panel">
      <div class="settings-field">
        <label class="settings-label" for="domain-policy-mode">
          Domain Restrictions
        </label>
        <select
          id="domain-policy-mode"
          class="settings-input settings-select"
          value={props.domainMode()}
          onChange={(e) =>
            props.setDomainMode(
              e.currentTarget.value as "none" | "allowlist" | "blocklist",
            )
          }
        >
          <option value="none">No restrictions</option>
          <option value="allowlist">Allowlist (only listed domains)</option>
          <option value="blocklist">Blocklist (block listed domains)</option>
        </select>
        <Show when={props.domainMode() !== "none"}>
          <textarea
            class="settings-input settings-textarea"
            rows={4}
            value={props.domainList()}
            onInput={(e) => props.setDomainList(e.currentTarget.value)}
            placeholder={
              props.domainMode() === "allowlist"
                ? "example.com\napi.example.com"
                : "ads.example.com\ntracker.io"
            }
            spellcheck={false}
          />
          <p class="settings-hint">
            {props.domainMode() === "allowlist"
              ? "One domain per line. Subdomains of listed domains are also allowed."
              : "One domain per line. Subdomains of listed domains are also blocked."}
          </p>
        </Show>
        <Show when={props.domainMode() === "none"}>
          <p class="settings-hint">
            Restrict which domains can be navigated to. Use allowlist mode for
            kiosk or supervised browsing, blocklist to block specific sites.
          </p>
        </Show>
      </div>

      <div class="settings-field">
        <label class="settings-label" for="source-do-not-allow-list">
          Source Do Not Allow List
        </label>
        <textarea
          id="source-do-not-allow-list"
          class="settings-input settings-textarea"
          rows={4}
          value={props.sourceDoNotAllowList()}
          onInput={(e) => props.setSourceDoNotAllowList(e.currentTarget.value)}
          placeholder={"example.com\nlow-quality-source.net"}
          spellcheck={false}
        />
        <p class="settings-hint">
          One domain per line. Research Desk will avoid citing or visiting these
          sources during research, without blocking normal browsing.
        </p>
      </div>

      <div class="settings-field">
        <label class="settings-label">Site Permissions</label>
        <p class="settings-hint">
          Camera, microphone, location, notifications, and other site capability choices remembered by Vessel.
        </p>
        <div class="settings-list">
          <For each={permissions()} fallback={<p class="settings-hint">No saved permission decisions yet.</p>}>
            {(item) => (
              <div class="settings-list-row">
                <span>{item.origin}</span>
                <span>{item.permission}: {item.decision}</span>
              </div>
            )}
          </For>
        </div>
        <button
          type="button"
          class="settings-secondary-btn"
          onClick={async () => { await window.vessel.permissions.clear(); await loadPermissions(); }}
        >
          Clear saved permissions
        </button>
      </div>

      <div class="settings-field">
        <label class="settings-toggle">
          <button
            type="button"
            class="toggle-switch"
            classList={{ on: props.telemetryEnabled() }}
            onClick={() =>
              props.setTelemetryEnabled(!props.telemetryEnabled())
            }
            role="switch"
            aria-checked={props.telemetryEnabled()}
          >
            <span class="toggle-switch-thumb" />
          </button>
          <span>Anonymous Usage Analytics</span>
        </label>
        <p class="settings-hint">
          Help improve Vessel by sending anonymous usage data (tool popularity,
          session duration, provider type). No URLs, page content, queries, or
          personal data is ever collected.
        </p>
      </div>
    </div>
  );
};

export default SettingsPrivacy;
