# Clear Browsing Data Dialog — Design Spec

## Overview

Add a user-facing dialog to selectively clear browser data (cache, cookies, history, localStorage) by time range. Accessible from the Settings panel.

---

## Architecture

The dialog is a renderer-side modal in the Settings panel. It collects user choices (data types + time range) and sends them to the main process via IPC, which calls `session.defaultSession.clearStorageData()` and `historyManager.clear()`.

### Files

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | `ClearBrowsingDataOptions` type |
| `src/shared/channels.ts` | `CLEAR_BROWSING_DATA` channel |
| `src/renderer/src/components/shared/Settings.tsx` | Add "Clear browsing data..." button + dialog |
| `src/renderer/src/components/shared/ClearDataDialog.tsx` | Dialog component (checkboxes + time range) |
| `src/renderer/src/components/shared/settings.css` | Dialog styles |
| `src/main/ipc/handlers.ts` | IPC handler: `CLEAR_BROWSING_DATA` |
| `src/main/history/manager.ts` | `clearHistory(since: Date)` method |

---

## Component Design & Data Flow

### Clear Data Dialog (Renderer)

A modal dialog with:
- **Data types** (checkboxes):
  - Browsing history
  - Download history
  - Cookies and site data
  - Cached images and files
  - Local storage
  - Passwords (optional, default unchecked)
- **Time range** (dropdown):
  - Last hour
  - Last 24 hours
  - Last 7 days
  - Last 4 weeks
  - All time
- **Buttons**: "Clear data" (primary, destructive), "Cancel"

On "Clear data", send IPC `Channels.CLEAR_BROWSING_DATA` with `ClearBrowsingDataOptions`:
```typescript
interface ClearBrowsingDataOptions {
  dataTypes: {
    history: boolean;
    downloads: boolean;
    cookies: boolean;
    cache: boolean;
    localStorage: boolean;
    passwords: boolean;
  };
  timeRange: "last-hour" | "last-24-hours" | "last-7-days" | "last-4-weeks" | "all-time";
}
```

### IPC Handler (Main Process)

`registerIpcHandlers` adds:
```typescript
ipcMain.handle(Channels.CLEAR_BROWSING_DATA, async (_event, options: ClearBrowsingDataOptions) => {
  const since = calculateSinceDate(options.timeRange);
  const tasks: Promise<void>[] = [];

  if (options.dataTypes.cookies) {
    tasks.push(session.defaultSession.clearStorageData({
      storages: ["cookies"],
      since,
    }));
  }
  if (options.dataTypes.cache) {
    tasks.push(session.defaultSession.clearCache());
  }
  if (options.dataTypes.localStorage) {
    tasks.push(session.defaultSession.clearStorageData({
      storages: ["localstorage"],
      since,
    }));
  }
  if (options.dataTypes.history) {
    historyManager.clearHistory(since);
  }

  await Promise.all(tasks);
  return { success: true };
});
```

### History Manager

Add `clearHistory(since: Date)` to `src/main/history/manager.ts`:
- Filter entries by `visitedAt >= since`
- Persist the filtered list back to disk.

---

## Error Handling

- If any `clearStorageData()` call fails, log and continue with the rest.
- Return `{ success: false, error: string }` if a critical failure occurs.
- Show a toast/notification in the renderer on success or failure.

---

## Testing

- **Unit**: None required.
- **Manual smoke test**:
  1. Open Settings → click "Clear browsing data..."
  2. Check "Browsing history" and "Cookies"
  3. Select "Last hour"
  4. Click "Clear data"
  5. Verify history entries older than 1 hour remain, newer ones are gone.
  6. Verify cookies are cleared.

---

## Dependencies

- `session.defaultSession.clearStorageData` and `session.defaultSession.clearCache` from Electron.
- `historyManager` already persists history to disk.

## Risks

| Risk | Mitigation |
|---|---|
| Clearing cookies logs users out of all sites | Warn user in the dialog UI |
| Password clearing affects autofill | Keep it unchecked by default |
| History clearing with large files | Do it synchronously but show a loading spinner |
