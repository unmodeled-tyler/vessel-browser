/**
 * Centralized URL safety validation for all navigation paths.
 * Ensures only http/https URLs can be loaded in tab WebContentsViews.
 */

import { checkDomainPolicy } from "./domain-policy";
import type { WebContents } from "electron";

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

/**
 * Guards synthetic/fallback navigations performed outside Tab.navigate().
 * Enforces both scheme validation and the configured domain policy.
 */
export function assertPermittedNavigationURL(url: string): void {
  assertSafeURL(url);
  const policyError = checkDomainPolicy(url);
  if (policyError) {
    throw new Error(policyError);
  }
}

export function loadPermittedNavigationURL(wc: WebContents, url: string): Promise<void> {
  assertPermittedNavigationURL(url);
  return wc.loadURL(url);
}

export function loadInternalDataURL(wc: WebContents, dataUrl: string): Promise<void> {
  if (!dataUrl.startsWith("data:text/html;charset=utf-8,")) {
    throw new Error("Blocked unexpected internal data URL");
  }
  return wc.loadURL(dataUrl);
}

export function loadTrustedAppURL(wc: WebContents, url: string): Promise<void> {
  const parsed = new URL(url);
  if (!["file:", "http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Blocked unexpected app URL scheme: ${parsed.protocol}`);
  }
  const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (isHttp && !isLocalhost) {
    throw new Error(`Blocked unexpected app URL host: ${parsed.hostname}`);
  }
  return wc.loadURL(parsed.toString());
}
