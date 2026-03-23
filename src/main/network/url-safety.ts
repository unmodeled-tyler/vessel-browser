/**
 * Centralized URL safety validation for all navigation paths.
 * Ensures only http/https URLs can be loaded in tab WebContentsViews.
 */

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Returns true if the URL uses an allowed scheme (http or https).
 * Returns false for javascript:, file:, data:, blob:, etc.
 */
export function isSafeNavigationURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Guards a `webContents.loadURL()` call. Throws if the URL is not safe.
 * Use this as a drop-in wrapper around any direct `wc.loadURL(url)` call
 * that handles external/untrusted URLs.
 */
export function assertSafeURL(url: string): void {
  if (!isSafeNavigationURL(url)) {
    throw new Error(
      `Blocked navigation to disallowed URL scheme: ${url.slice(0, 80)}`,
    );
  }
}
