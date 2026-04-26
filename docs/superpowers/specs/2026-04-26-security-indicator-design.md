# Security Indicator — Design Spec

## Overview

Add a security indicator (padlock icon) to the AddressBar that shows the connection security status of the current page. The indicator has three visual states (secure, insecure, error) and reveals a summary popup on click, with a "Learn More" option that opens a new window with certificate details.

---

## Architecture

All security state tracking happens in the main process. The renderer receives state updates via IPC and renders the icon + popup.

### Files

| File | Responsibility |
|---|---|
| `src/main/tabs/tab.ts` | Track security state, emit `security-state-update` IPC |
| `src/main/tabs/tab-manager.ts` | Broadcast security state changes to renderer |
| `src/shared/types.ts` | `SecurityState` interface |
| `src/shared/channels.ts` | `SECURITY_STATE_UPDATE` channel |
| `src/renderer/src/stores/security.ts` | SolidJS store tracking security state per-tab |
| `src/renderer/src/components/chrome/AddressBar.tsx` | Render padlock icon + popup |
| `src/renderer/src/components/chrome/SecurityPopup.tsx` | Popup panel component |
| `src/renderer/src/components/chrome/chrome.css` | Icon and popup styles |

---

## Component Design & Data Flow

### Security State Tracking (Main Process)

`Tab` maintains a `securityState` field updated by navigation events:

- `did-navigate` / `did-navigate-in-page`: check protocol. `https:` = `secure`, `http:` = `insecure`, others = `none`.
- `certificate-error`: set `status: "error"` with `errorMessage`.

```typescript
type SecurityStatus = "secure" | "insecure" | "error" | "none";

interface SecurityState {
  status: SecurityStatus;
  url: string;
  errorMessage?: string;
}
```

On every change, `Tab` emits `Channels.SECURITY_STATE_UPDATE` to the chrome view with `{ tabId, state }`.

### Renderer — AddressBar

- New `useSecurity` store subscribes to `SECURITY_STATE_UPDATE`.
- `AddressBar` reads `securityState()` for the active tab.
- Render logic:
  - `"secure"`: green locked padlock (`#4ade80`)
  - `"insecure"`: gray unlocked padlock (`#9ca3af`)
  - `"error"`: red broken padlock (`#f87171`)
  - `"none"`: no icon

### Security Popup Panel

Small popup below the padlock icon:
- **Secure**: "Connection is secure. This site uses HTTPS."
- **Insecure**: "Connection is not secure. Information sent to this site could be read by others."
- **Error**: "Certificate error: {errorMessage}. Proceed with caution."

"Learn More" link sends IPC `Channels.SECURITY_SHOW_DETAILS`.

### "Learn More" Certificate Window

- Main process opens a new `BrowserWindow` (600x400, dark theme).
- Title: `"Certificate info for {domain}"`
- Content: protocol, URL, error message if any. For valid HTTPS: "This site uses a valid TLS certificate."

---

## Error Handling

- Deduplicate `certificate-error` by URL to avoid spam.
- Popup auto-closes on tab switch (SolidJS `onCleanup`).
- "Learn More" window errors are silently logged.

---

## Testing

- **Unit**: None required.
- **Manual smoke test**:
  1. Navigate to `https://example.com` → green padlock.
  2. Click padlock → "Connection is secure."
  3. Click "Learn More" → cert info window.
  4. Navigate to `http://example.com` → gray unlocked.
  5. Self-signed cert → red broken padlock with error.

---

## Dependencies

- None beyond existing Electron IPC and renderer stores.

## Risks

| Risk | Mitigation |
|---|---|
| `certificate-error` fires repeatedly | Deduplicate by URL |
| Popup positioning near window edge | Use existing dropdown positioning pattern |
| Security icon layout conflicts with address bar | Test layout at multiple widths |
