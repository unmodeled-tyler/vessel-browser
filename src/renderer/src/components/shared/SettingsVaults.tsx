import { For, Show, type Component } from "solid-js";
import type { SettingsVaultsProps } from "./settingsTypes";

const SettingsVaults: Component<SettingsVaultsProps> = (props) => {
  const v = props.vault;
  const h = props.humanVault;
  const a = props.autofill;

  return (
    <div class="settings-category-panel">
      {/* Agent Credential Vault */}
      <div class="settings-field">
        <label class="settings-label">
          Agent Credential Vault
          <Show when={!props.premiumActive()}>
            <span class="vault-premium-badge">Premium</span>
          </Show>
        </label>
        <Show
          when={props.premiumActive()}
          fallback={
            <p class="settings-hint">
              Securely store credentials for agent-driven logins. Upgrade to
              Premium to unlock the Agent Credential Vault.
            </p>
          }
        >
          <p class="settings-hint" style="margin-bottom: 10px">
            Store credentials for agent-driven logins. Credentials are encrypted
            at rest and never sent to AI providers — they are filled directly
            into login forms with your consent.
          </p>

          <Show when={v.entries().length > 0}>
            <div class="vault-entries">
              <For each={v.entries()}>
                {(entry) => (
                  <div class="vault-entry">
                    <div class="vault-entry-info">
                      <span class="vault-entry-label">{entry.label}</span>
                      <span class="vault-entry-detail">
                        {entry.username} &middot; {entry.domainPattern}
                        <Show when={entry.useCount > 0}>
                          {" "}&middot; Used {entry.useCount}x
                        </Show>
                      </span>
                    </div>
                    <button
                      class="vault-entry-remove"
                      onClick={() => v.handleRemove(entry.id)}
                      title="Remove credential"
                    >
                      &times;
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={!v.adding()}>
            <button
              class="vault-add-btn"
              onClick={() => {
                v.setAdding(true);
                v.setMessage(null);
              }}
            >
              + Add Credential
            </button>
          </Show>

          <Show when={v.adding()}>
            <div class="vault-add-form">
              <input
                class="settings-input"
                placeholder="Label (e.g. Work GitHub)"
                value={v.newLabel()}
                onInput={(e) => v.setNewLabel(e.currentTarget.value)}
                spellcheck={false}
              />
              <input
                class="settings-input"
                placeholder="Domain pattern (e.g. github.com, *.aws.amazon.com)"
                value={v.newDomain()}
                onInput={(e) => v.setNewDomain(e.currentTarget.value)}
                spellcheck={false}
              />
              <input
                class="settings-input"
                placeholder="Username / email"
                value={v.newUsername()}
                onInput={(e) => v.setNewUsername(e.currentTarget.value)}
                spellcheck={false}
              />
              <input
                class="settings-input"
                type="password"
                placeholder="Password"
                value={v.newPassword()}
                onInput={(e) => v.setNewPassword(e.currentTarget.value)}
              />
              <input
                class="settings-input"
                placeholder="TOTP secret (optional, base32)"
                value={v.newTotp()}
                onInput={(e) => v.setNewTotp(e.currentTarget.value)}
                spellcheck={false}
              />
              <input
                class="settings-input"
                placeholder="Notes (optional)"
                value={v.newNotes()}
                onInput={(e) => v.setNewNotes(e.currentTarget.value)}
                spellcheck={false}
              />
              <div class="vault-add-actions">
                <button
                  class="premium-btn premium-btn-activate"
                  onClick={() => v.handleAdd()}
                >
                  Save Credential
                </button>
                <button
                  class="premium-btn premium-btn-reset"
                  onClick={() => {
                    v.setAdding(false);
                    v.setNewLabel("");
                    v.setNewDomain("");
                    v.setNewUsername("");
                    v.setNewPassword("");
                    v.setNewTotp("");
                    v.setNewNotes("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </Show>

          <Show when={v.message()}>
            {(msg) => (
              <p
                class="settings-status"
                classList={{
                  success: msg().kind === "success",
                  error: msg().kind === "error",
                }}
              >
                {msg().text}
              </p>
            )}
          </Show>
        </Show>
      </div>

      {/* Human Password Manager */}
      <div class="settings-field">
        <label class="settings-label">
          Passwords
          <Show when={!props.premiumActive()}>
            <span class="vault-premium-badge">Premium</span>
          </Show>
        </label>
        <Show
          when={props.premiumActive()}
          fallback={
            <p class="settings-hint">
              Your personal password manager. Save, organize, and autofill login
              credentials. Upgrade to Premium to unlock Passwords.
            </p>
          }
        >
          <p class="settings-hint" style="margin-bottom: 10px">
            Save login credentials for any website. Passwords are encrypted
            locally and filled directly into login forms. The agent can list and
            fill them with your consent, but passwords are never sent to AI
            providers.
          </p>

          <Show when={h.entries().length > 0}>
            <div class="vault-entries">
              <For each={h.entries()}>
                {(entry) => (
                  <div class="vault-entry">
                    <div class="vault-entry-info">
                      <span class="vault-entry-label">{entry.title}</span>
                      <span class="vault-entry-detail">
                        {entry.username} &middot; {entry.domain}
                        <Show
                          when={
                            entry.category && entry.category !== "login"
                          }
                        >
                          {" "}&middot; {entry.category}
                        </Show>
                        <Show when={entry.useCount > 0}>
                          {" "}&middot; Used {entry.useCount}x
                        </Show>
                      </span>
                    </div>
                    <button
                      class="vault-entry-remove"
                      onClick={() => h.handleRemove(entry.id)}
                      title="Remove password"
                    >
                      &times;
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={!h.adding()}>
            <button
              class="vault-add-btn"
              onClick={() => {
                h.setAdding(true);
              }}
            >
              + Add Password
            </button>
          </Show>

          <Show when={h.adding()}>
            <div class="vault-add-form">
              <input
                class="settings-input"
                placeholder="Title (e.g. GitHub Personal)"
                value={h.newTitle()}
                onInput={(e) => h.setNewTitle(e.currentTarget.value)}
                spellcheck={false}
              />
              <input
                class="settings-input"
                placeholder="URL (e.g. https://github.com)"
                value={h.newUrl()}
                onInput={(e) => h.setNewUrl(e.currentTarget.value)}
                spellcheck={false}
              />
              <input
                class="settings-input"
                placeholder="Username / email"
                value={h.newUsername()}
                onInput={(e) => h.setNewUsername(e.currentTarget.value)}
                spellcheck={false}
              />
              <input
                class="settings-input"
                type="password"
                placeholder="Password"
                value={h.newPassword()}
                onInput={(e) => h.setNewPassword(e.currentTarget.value)}
              />
              <select
                class="settings-input"
                value={h.newCategory()}
                onChange={(e) =>
                  h.setNewCategory(e.currentTarget.value)
                }
              >
                <option value="login">Login</option>
                <option value="credit_card">Credit Card</option>
                <option value="identity">Identity</option>
                <option value="secure_note">Secure Note</option>
              </select>
              <input
                class="settings-input"
                placeholder="Notes (optional)"
                value={h.newNotes()}
                onInput={(e) => h.setNewNotes(e.currentTarget.value)}
                spellcheck={false}
              />
              <div class="vault-add-actions">
                <button
                  class="premium-btn premium-btn-activate"
                  onClick={() => h.handleAdd()}
                >
                  Save Password
                </button>
                <button
                  class="premium-btn premium-btn-reset"
                  onClick={() => {
                    h.setAdding(false);
                    h.setNewTitle("");
                    h.setNewUrl("");
                    h.setNewUsername("");
                    h.setNewPassword("");
                    h.setNewNotes("");
                    h.setNewCategory("login");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </Show>

          <Show when={h.message()}>
            {(msg) => (
              <p
                class="settings-status"
                classList={{
                  success: msg().kind === "success",
                  error: msg().kind === "error",
                }}
              >
                {msg().text}
              </p>
            )}
          </Show>
        </Show>
      </div>

      {/* Form Autofill */}
      <div class="settings-field">
        <label class="settings-label">Form Autofill</label>
        <p class="settings-hint" style="margin-bottom: 10px">
          Store your info once. Vessel matches it to form fields on any site
          using labels, field names, and autocomplete hints.
        </p>

        <Show when={a.profiles().length > 0}>
          <div class="vault-entries">
            <For each={a.profiles()}>
              {(profile) => (
                <div class="vault-entry">
                  <div class="vault-entry-info">
                    <span class="vault-entry-label">{profile.label}</span>
                    <span class="vault-entry-detail">
                      {profile.firstName}
                      {profile.lastName ? ` ${profile.lastName}` : ""}
                      {profile.email ? ` · ${profile.email}` : ""}
                    </span>
                  </div>
                  <div style="display: flex; gap: 6px; align-items: center;">
                    <button
                      class="premium-btn premium-btn-activate"
                      style="padding: 2px 10px; font-size: 12px;"
                      onClick={() => a.handleFill(profile.id)}
                      title="Fill forms on current page with this profile"
                    >
                      Fill
                    </button>
                    <button
                      class="vault-entry-remove"
                      onClick={() => a.handleRemove(profile.id)}
                      title="Remove profile"
                    >
                      &times;
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={!a.adding()}>
          <button
            class="vault-add-btn"
            onClick={() => {
              a.setAdding(true);
            }}
          >
            + Add Profile
          </button>
        </Show>

        <Show when={a.adding()}>
          <div class="vault-add-form">
            <input
              class="settings-input"
              placeholder="Profile name (e.g. Personal, Work)"
              value={a.label()}
              onInput={(e) => a.setLabel(e.currentTarget.value)}
              spellcheck={false}
            />
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <input
                class="settings-input"
                placeholder="First name"
                value={a.firstName()}
                onInput={(e) => a.setFirstName(e.currentTarget.value)}
              />
              <input
                class="settings-input"
                placeholder="Last name"
                value={a.lastName()}
                onInput={(e) => a.setLastName(e.currentTarget.value)}
              />
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <input
                class="settings-input"
                placeholder="Email"
                value={a.email()}
                onInput={(e) => a.setEmail(e.currentTarget.value)}
                spellcheck={false}
              />
              <input
                class="settings-input"
                placeholder="Phone"
                value={a.phone()}
                onInput={(e) => a.setPhone(e.currentTarget.value)}
              />
            </div>
            <input
              class="settings-input"
              placeholder="Organization (optional)"
              value={a.organization()}
              onInput={(e) => a.setOrganization(e.currentTarget.value)}
            />
            <input
              class="settings-input"
              placeholder="Address line 1"
              value={a.addressLine1()}
              onInput={(e) => a.setAddressLine1(e.currentTarget.value)}
            />
            <input
              class="settings-input"
              placeholder="Address line 2 (optional)"
              value={a.addressLine2()}
              onInput={(e) => a.setAddressLine2(e.currentTarget.value)}
            />
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
              <input
                class="settings-input"
                placeholder="City"
                value={a.city()}
                onInput={(e) => a.setCity(e.currentTarget.value)}
              />
              <input
                class="settings-input"
                placeholder="State"
                value={a.state()}
                onInput={(e) => a.setState(e.currentTarget.value)}
              />
              <input
                class="settings-input"
                placeholder="ZIP / Postal"
                value={a.postalCode()}
                onInput={(e) => a.setPostalCode(e.currentTarget.value)}
              />
            </div>
            <input
              class="settings-input"
              placeholder="Country"
              value={a.country()}
              onInput={(e) => a.setCountry(e.currentTarget.value)}
            />
            <div class="vault-add-actions">
              <button
                class="premium-btn premium-btn-activate"
                onClick={() => a.handleAdd()}
              >
                Save Profile
              </button>
              <button
                class="premium-btn premium-btn-reset"
                onClick={() => {
                  a.setAdding(false);
                  a.setLabel("");
                  a.setFirstName("");
                  a.setLastName("");
                  a.setEmail("");
                  a.setPhone("");
                  a.setOrganization("");
                  a.setAddressLine1("");
                  a.setAddressLine2("");
                  a.setCity("");
                  a.setState("");
                  a.setPostalCode("");
                  a.setCountry("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Show>

        <Show when={a.message()}>
          {(msg) => (
            <p
              class="settings-status"
              classList={{
                success: msg().kind === "success",
                error: msg().kind === "error",
              }}
            >
              {msg().text}
            </p>
          )}
        </Show>
      </div>
    </div>
  );
};

export default SettingsVaults;
