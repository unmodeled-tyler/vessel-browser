import { For, Show, type Component } from "solid-js";
import type { SettingsAccountProps } from "./settingsTypes";

const SettingsAccount: Component<SettingsAccountProps> = (props) => {
  const p = props.premium;
  const s = props.sessions;

  return (
    <div class="settings-category-panel">
      {/* Vessel Premium */}
      <div class="settings-field">
        <label class="settings-label">Vessel Premium</label>
        <Show
          when={p.active()}
          fallback={
            <div class="premium-section">
              <p class="premium-description">
                Unlock screenshot/vision analysis, session management,
                Obsidian integration, workflow tracking, DevTools tools,
                table extraction, Agent Credential Vault, and unlimited
                tool iterations.
              </p>
              <div class="premium-activate-row">
                <input
                  class="settings-input premium-email-input"
                  type="email"
                  placeholder="Enter your subscription email"
                  value={p.email()}
                  onInput={(e) => {
                    const nextEmail = e.currentTarget.value;
                    if (nextEmail.trim().toLowerCase() !== p.email().trim().toLowerCase()) {
                      p.resetFlow();
                      p.setMessage(null);
                    }
                    p.setEmail(nextEmail);
                  }}
                  spellcheck={false}
                />
                <button
                  class="premium-btn premium-btn-activate"
                  disabled={p.loading() || !p.email().trim()}
                  onClick={async () => {
                    p.setLoading(true);
                    p.setMessage(null);
                    try {
                      const result = await window.vessel.premium.requestCode(
                        p.email().trim(),
                      );
                      if (result.ok) {
                        p.setChallengeToken(result.challengeToken ?? "");
                        p.setCodeSent(true);
                        p.setMessage({
                          kind: "success",
                          text:
                            "If a matching premium subscription exists, we sent a 6-digit code to that email.",
                        });
                      } else {
                        p.resetFlow();
                        p.setMessage({
                          kind: "error",
                          text: result.error || "Could not send code",
                        });
                      }
                    } catch (err) {
                      p.resetFlow();
                      p.setMessage({
                        kind: "error",
                        text:
                          err instanceof Error
                            ? err.message
                            : "Could not send code",
                      });
                    } finally {
                      p.setLoading(false);
                    }
                  }}
                >
                  {p.loading()
                    ? "Sending..."
                    : p.codeSent()
                      ? "Resend Code"
                      : "Send Code"}
                </button>
              </div>
              <Show when={p.codeSent()}>
                <div class="premium-activate-row">
                  <input
                    class="settings-input premium-email-input"
                    inputmode="numeric"
                    maxLength={6}
                    placeholder="Enter 6-digit code"
                    value={p.code()}
                    onInput={(e) => {
                      const nextCode = e.currentTarget.value.replace(/\D+/g, "").slice(0, 6);
                      p.setCode(nextCode);
                      p.setMessage(null);
                    }}
                    spellcheck={false}
                  />
                  <button
                    class="premium-btn premium-btn-activate"
                    disabled={
                      p.loading() ||
                      !p.email().trim() ||
                      p.code().trim().length !== 6 ||
                      !p.challengeToken()
                    }
                    onClick={async () => {
                      p.setLoading(true);
                      p.setMessage(null);
                      try {
                        const result = await window.vessel.premium.verifyCode(
                          p.email().trim(),
                          p.code().trim(),
                          p.challengeToken(),
                        );
                        p.setState(result.state);
                        if (result.ok) {
                          p.resetFlow();
                          p.setMessage({
                            kind: "success",
                            text: "Premium activated!",
                          });
                        } else {
                          p.setMessage({
                            kind: "error",
                            text: result.error || "Verification failed",
                          });
                        }
                      } catch (err) {
                        p.setMessage({
                          kind: "error",
                          text:
                            err instanceof Error
                              ? err.message
                              : "Verification failed",
                        });
                      } finally {
                        p.setLoading(false);
                      }
                    }}
                  >
                    {p.loading() ? "Verifying..." : "Verify Code"}
                  </button>
                </div>
              </Show>
              <button
                class="premium-btn premium-btn-upgrade"
                onClick={() => {
                  p.startCheckout();
                }}
              >
                Subscribe to Premium — $5.99/mo after 7-day free trial
              </button>
              <Show when={p.message()}>
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
              <Show when={p.state().email || p.email()}>
                <button
                  class="premium-btn premium-btn-reset"
                  onClick={async () => {
                    const nextState = await window.vessel.premium.reset();
                    p.setState(nextState);
                    p.setEmail("");
                    p.resetFlow();
                    p.setMessage(null);
                  }}
                >
                  Clear Saved Email
                </button>
              </Show>
            </div>
          }
        >
          <div class="premium-section">
            <div class="premium-active-badge">
              Premium Active
              <Show when={p.state().status === "trialing"}>
                {" "}(Trial)
              </Show>
            </div>
            <p class="premium-detail">
              {p.state().email}
              <Show when={p.state().expiresAt}>
                {" "}&middot; Renews{" "}
                {new Date(p.state().expiresAt).toLocaleDateString()}
              </Show>
            </p>
            <div class="premium-actions-row">
              <button
                class="premium-btn premium-btn-manage"
                onClick={async () => {
                  const result = await window.vessel.premium.portal();
                  if (!result.ok) {
                    p.setMessage({
                      kind: "error",
                      text: result.error || "Could not open billing portal.",
                    });
                    setTimeout(() => p.setMessage(null), 5000);
                  }
                }}
              >
                Manage Subscription
              </button>
              <button
                class="premium-btn premium-btn-reset"
                onClick={async () => {
                  const nextState = await window.vessel.premium.reset();
                  p.setState(nextState);
                  p.setEmail("");
                  p.resetFlow();
                  p.setMessage(null);
                }}
              >
                Sign Out
              </button>
            </div>
            <Show when={p.message()}>
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
        </Show>
      </div>

      {/* Saved Sessions */}
      <div class="settings-field">
        <label class="settings-label">Saved Sessions</label>
        <p class="settings-hint" style="margin-bottom: 10px">
          Save the current browser state (tabs, cookies, storage) as a named
          session. Restore it later from this panel.
        </p>
        <div class="premium-activate-row" style="margin-bottom: 8px">
          <input
            class="settings-input premium-email-input"
            placeholder="Session name"
            value={s.saveName()}
            onInput={(e) => s.setSaveName(e.currentTarget.value)}
            spellcheck={false}
          />
          <button
            class="premium-btn premium-btn-activate"
            disabled={!s.saveName().trim()}
            onClick={async () => {
              try {
                await window.vessel.sessions.save(s.saveName().trim());
                s.setSaveName("");
                await s.loadList();
                props.setStatus({ kind: "success", text: "Session saved." });
                setTimeout(() => props.setStatus(null), 3000);
              } catch (err) {
                props.setStatus({ kind: "error", text: String(err) });
              }
            }}
          >
            Save Current
          </button>
        </div>
        <Show when={s.list().length > 0}>
          <div class="vault-entries">
            <For each={s.list()}>
              {(session) => (
                <div class="vault-entry">
                  <div class="vault-entry-info">
                    <span class="vault-entry-label">{session.name}</span>
                    <span class="vault-entry-detail">
                      {new Date(session.updatedAt).toLocaleDateString()}
                      {" "}&middot; {session.cookieCount} cookies
                      {" "}&middot; {session.domains.length} domains
                    </span>
                  </div>
                  <div style="display: flex; gap: 6px; align-items: center;">
                    <button
                      class="premium-btn premium-btn-activate"
                      style="padding: 2px 10px; font-size: 12px;"
                      onClick={async () => {
                        try {
                          await window.vessel.sessions.load(session.name);
                          props.setStatus({ kind: "success", text: `Session "${session.name}" restored.` });
                          setTimeout(() => props.setStatus(null), 3000);
                        } catch (err) {
                          props.setStatus({ kind: "error", text: String(err) });
                        }
                      }}
                      title="Restore this session (replaces current tabs and cookies)"
                    >
                      Load
                    </button>
                    <button
                      class="vault-entry-remove"
                      onClick={async () => {
                        await window.vessel.sessions.delete(session.name);
                        await s.loadList();
                      }}
                      title="Delete session"
                    >
                      &times;
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default SettingsAccount;
