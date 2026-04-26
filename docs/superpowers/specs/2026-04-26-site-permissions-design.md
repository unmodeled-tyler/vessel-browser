# Site Permissions UI — Design Spec

## Overview

Add per-site permission management for camera, microphone, location, notifications, and popups. When a site requests a permission, show a native-style permission prompt. Allow users to manage all site permissions via a new panel in Settings.

---

## Architecture

### Permission Request Flow

1. Site calls `navigator.mediaDevices.getUserMedia()` or similar.
2. Electron fires `session.setPermissionRequestHandler`.
3. Main process shows a permission prompt (Electron native `dialog` or custom).
4. User choice is remembered per-origin in a JSON file.
5. Future requests for the same origin + permission are auto-resolved from stored policy.

### Permission Management Panel

A new tab/page in Settings that lists all sites with remembered permissions, letting users view, change, or remove them.

### Files

| File | Responsibility |
|---|---|
| `src/main/permissions/manager.ts` | Core: permission request handler, policy storage, lookup |
| `src/main/permissions/prompt.ts` | Show native permission prompt dialog |
| `src/shared/types.ts` | `PermissionType`, `PermissionPolicy`, `SitePermission` types |
| `src/shared/channels.ts` | `PERMISSION_REQUEST`, `PERMISSION_RESPONSE`, `PERMISSIONS_GET`, `PERMISSIONS_UPDATE` |
| `src/renderer/src/components/shared/Settings.tsx` | Add "Site permissions" tab |
| `src/renderer/src/components/shared/PermissionsPanel.tsx` | Permission management UI |
| `src/renderer/src/components/shared/settings.css` | Panel styles |
| `src/main/index.ts` | Register `setPermissionRequestHandler` on app startup |

---

## Component Design & Data Flow

### Permission Manager (`src/main/permissions/manager.ts`)

**Types:**
```typescript
type PermissionType = "media" | "geolocation" | "notifications" | "midi" | "midiSysex" | "clipboardRead" | "clipboardWrite" | "fullscreen" | "pointerLock" | "openExternal" | "window-management";

type PermissionPolicy = "allow" | "deny" | "prompt";

interface SitePermission {
  origin: string;
  permission: PermissionType;
  policy: PermissionPolicy;
}
```

**Storage:**
- Persisted to `userData/permissions.json`.
- Format: `{ [origin]: { [permission]: PermissionPolicy } }`.

**Core methods:**
- `handlePermissionRequest(webContents, permission, callback)`:
  1. Extract origin from URL.
  2. Look up stored policy for `origin + permission`.
  3. If found, call `callback(foundPolicy === "allow")` immediately.
  4. If not found or policy is `"prompt"`, show prompt.
  5. On user response, store policy and call `callback(granted)`.
- `getPermissions(): SitePermission[]` — return all stored permissions.
- `setPermission(origin, permission, policy)` — update a policy.
- `removePermission(origin, permission)` — delete a policy.
- `removeAllForOrigin(origin)` — delete all policies for an origin.

### Permission Prompt (`src/main/permissions/prompt.ts`)

Use `dialog.showMessageBox` for a native prompt:
- Title: `"{domain} wants to access your {resource}"`
- Buttons: `["Allow", "Block", "Always allow", "Always block"]`
- Default: `"Block"`

### Renderer — Permissions Panel

A table/list in Settings showing:
- Site (origin)
- Permission type
- Current policy (Allow / Block / Prompt)
- Actions: Change to Allow / Block / Prompt, Remove

No grouping by origin initially — simple flat list sorted by origin.

**IPC calls:**
- `window.vessel.permissions.get()` → returns `SitePermission[]`
- `window.vessel.permissions.set(origin, permission, policy)`
- `window.vessel.permissions.remove(origin, permission)`

---

## Error Handling

- If permission storage file is corrupted, reset to empty state and log a warning.
- If `dialog.showMessageBox` fails (no focused window), default to deny and log.
- Renderer handles empty permission list gracefully with an empty state message.

---

## Testing

- **Unit**: Permission manager unit tests (mock file system, test policy lookup).
- **Manual smoke test**:
  1. Visit a site that requests camera (e.g. a video call app).
  2. Permission prompt appears.
  3. Click "Always allow".
  4. Reload page — no prompt, camera works.
  5. Open Settings → Site permissions.
  6. Find the site, change policy to "Block".
  7. Reload page — camera access denied.
  8. Click "Remove" — reload, prompt appears again.

---

## Dependencies

- `session.setPermissionRequestHandler` (Electron)
- `dialog.showMessageBox` (Electron)
- `fs` for JSON file persistence.

## Risks

| Risk | Mitigation |
|---|---|
| Permission prompt during agent automation blocks the agent | Default unknown permissions to "deny" when agent is active (check agent runtime state) |
| Too many prompts for different permissions on the same site | Remember the user's preference pattern and auto-apply similar permissions |
| Permission file grows large over time | No limit needed — permissions are bounded by number of sites visited |
| Cross-origin iframes requesting permissions | Use top-level origin, not iframe origin, for policy lookup |
