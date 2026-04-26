# View Page Source, Save Page As, and Disable Spellcheck

## Overview

This spec covers three independent but related features for the Vessel browser:

1. **View Page Source** — Open the raw HTML of the active tab in a new window.
2. **Save Page As...** — Save the current page as MHTML (and optionally HTML Complete) via a native save dialog.
3. **Disable Spellcheck** — Globally disable Chromium's spellchecker so no browser-level spellcheck UI appears in any view or input field.

All three are confined to the **main process** and require no renderer UI changes.

---

## Architecture

### Files touched

| File | Change |
|---|---|
| `src/main/tabs/tab.ts` | Add `viewSource()` method; add `Ctrl+U` handler; add context-menu items |
| `src/main/tabs/tab-manager.ts` | Add `savePage()` method |
| `src/main/startup/menu.ts` | Add app-menu items for View Source and Save Page As |
| `src/main/window.ts` | Add `spellcheck: false` to all `WebContentsView` constructors |

### Component Design & Data Flow

#### View Page Source

- `Tab.viewSource()`:
  1. Call `this.view.webContents.mainFrame.executeJavaScript("document.documentElement.outerHTML")` to get the raw HTML string.
  2. Create a new plain `BrowserWindow` with minimal chrome and a background color matching the app theme.
  3. Load a data URL containing an HTML document with `<pre>` wrapped around the escaped HTML. Use a monospace font. Window title: `view-source:{url}`.
  4. Return immediately (fire-and-forget).
- **Context menu item**: In `Tab.buildContextMenu()`, add `"View Page Source"` above the `"Copy Link"` separator.
- **Keyboard shortcut**: `Ctrl+U` (`Command+U` on macOS) handled in `Tab`'s `before-input-event` listener.

#### Save Page As

- `TabManager.savePage(id: string, format: 'MHTML' | 'HTMLComplete' = 'MHTML')`:
  1. Get the tab's current title.
  2. Show `dialog.showSaveDialog` with `defaultPath: sanitizePageFilename(title, format)` and a filter for the chosen format.
  3. If not cancelled, call `tab.view.webContents.savePage(filePath, format)`.
  4. Return the saved file path or `null`.
- **Context menu item**: In `Tab.buildContextMenu()`, add `"Save Page As..."` below `"Copy Link"`.
- **App menu item**: In `setupAppMenu()`, add `"Save Page As..."` under **File** with `Ctrl+S`. If no active tab, the menu item is disabled.

#### Spellcheck

- In `window.ts`, add `spellcheck: false` to `webPreferences` for `chromeView`, `sidebarView`, and `devtoolsPanelView`.
- In `Tab` constructor (`tab.ts`), add `spellcheck: false` to `webPreferences`.
- This is a single property addition in four locations. It disables Chromium's spellchecker globally, so no red squiggles or context-menu suggestions ever appear.

### Error Handling

- `viewSource()`: If `executeJavaScript` throws (e.g., page is `about:blank`, cross-origin iframe), catch and log a warning. The source window simply won't open.
- `savePage()`: If `savePage()` throws, catch and log. Return `null` so callers know it failed.
- Both are non-critical operations — no user-facing error dialogs needed.

### Testing

- **Unit**: None required; these are thin wrappers around Electron APIs.
- **Manual smoke test**:
  1. Open any page, press `Ctrl+U` — source window opens with raw HTML.
  2. Right-click on a tab → Save Page As → choose location → file is written.
  3. Click File → Save Page As → same behavior.
  4. Type in any `<input>` in the app chrome or on a webpage — no red squiggles appear.

---

## Dependencies

- None beyond existing Electron APIs (`webContents.savePage`, `dialog.showSaveDialog`, `BrowserWindow`).

## Risks

| Risk | Mitigation |
|---|---|
| `executeJavaScript` fails on cross-origin iframes | Catch error silently; source window won't open |
| `savePage` returns a promise that may reject on permission errors | Wrap in try/catch and log |
| `spellcheck: false` might be wanted back later by some users | If requested, can be made a user setting; for now, it's global off |

## Notes

- `webContents.savePage` supports `'MHTML'` and `'HTMLComplete'`. We default to MHTML because it produces a single self-contained file, which is what users typically expect from "Save Page As."
- The source viewer window should not have a preload script or node integration — it only displays static HTML.
