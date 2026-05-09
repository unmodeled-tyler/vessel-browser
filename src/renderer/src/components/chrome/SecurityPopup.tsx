import { createMemo, createSignal, For, Show, type Component, onMount, onCleanup } from "solid-js";
import type { PermissionRecord, SecurityState } from "../../../../shared/types";

interface SecurityPopupProps {
  state: SecurityState;
  tabId: string;
  onClose: () => void;
}

const SecurityPopup: Component<SecurityPopupProps> = (props) => {
  const statusText = () => {
    switch (props.state.status) {
      case "secure":
        return "Connection is secure. This site uses HTTPS.";
      case "insecure":
        return "Connection is not secure. Information sent to this site could be read by others.";
      case "error":
        return `Certificate error: ${props.state.errorMessage || "Unknown error"}. Proceed with caution.`;
      default:
        return "No security information available.";
    }
  };

  const [permissions, setPermissions] = createSignal<PermissionRecord[]>([]);
  const origin = createMemo(() => {
    try { return new URL(props.state.url).origin; } catch { return ""; }
  });
  const sitePermissions = createMemo(() =>
    permissions().filter((item) => item.origin === origin()),
  );

  const loadPermissions = async () => {
    try { setPermissions(await window.vessel.permissions.getAll()); } catch {}
  };

  const handleLearnMore = () => {
    window.vessel.security.showDetails(props.state);
    props.onClose();
  };

  const handleProceedAnyway = () => {
    window.vessel.security.proceedAnyway(props.tabId);
    props.onClose();
  };

  const handleGoBackToSafety = () => {
    window.vessel.security.goBackToSafety(props.tabId);
    props.onClose();
  };

  onMount(() => {
    void loadPermissions();
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".security-indicator-wrapper")) {
        props.onClose();
      }
    };
    document.addEventListener("click", handleClickOutside, true);
    onCleanup(() => document.removeEventListener("click", handleClickOutside, true));
  });

  return (
    <div class="security-popup" onClick={(e) => e.stopPropagation()}>
      <div class="security-popup-content">
        <p class="security-popup-text">{statusText()}</p>
        <button class="security-popup-link" onClick={handleLearnMore}>
          Learn More
        </button>
        <div class="security-popup-section">
          <div class="security-popup-section-title">Site permissions</div>
          <Show
            when={sitePermissions().length > 0}
            fallback={<p class="security-popup-muted">No saved permission decisions for this site.</p>}
          >
            <For each={sitePermissions()}>
              {(item) => (
                <div class="security-popup-permission-row">
                  <span>{item.permission}</span>
                  <strong class={item.decision}>{item.decision}</strong>
                </div>
              )}
            </For>
            <button
              class="security-popup-link"
              onClick={async () => {
                await window.vessel.permissions.clearOrigin(origin());
                await loadPermissions();
              }}
            >
              Reset permissions for this site
            </button>
          </Show>
        </div>
        {props.state.canProceed && (
          <div class="security-popup-actions">
            <button class="security-popup-action-proceed" onClick={handleProceedAnyway}>
              Proceed Anyway
            </button>
            <button class="security-popup-action-back" onClick={handleGoBackToSafety}>
              Go Back to Safety
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SecurityPopup;
