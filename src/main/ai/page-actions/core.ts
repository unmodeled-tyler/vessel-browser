import type { WebContents } from "electron";
import type { AgentRuntime } from "../../agent/runtime";
import type { TabManager } from "../../tabs/tab-manager";
import type { AgentToolProfile } from "../tool-profile";
import {
  sleep,
  waitForPotentialNavigation as waitForPotentialNavigationQuietly,
  QUIET_NAVIGATION_WINDOW_MS,
} from "../../utils/webcontents-utils";
import { createLogger } from "../../../shared/logger";

export interface ActionContext {
  tabManager: TabManager;
  runtime: AgentRuntime;
  toolProfile?: AgentToolProfile;
  /** When set, executeAction switches to this tab before running the action */
  tabId?: string;
  /** Internal: serializes tab-switched actions across parallel callers */
  _tabMutex?: TabMutex;
}

/** Simple async mutex — ensures serialized access to the active tab */
export class TabMutex {
  private queue = Promise.resolve();
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export const logger = createLogger("PageActions");

export const DEFAULT_PAGE_SCRIPT_TIMEOUT_MS = 1500;
export const PAGE_SCRIPT_TIMEOUT = Symbol("page-script-timeout");

export function pageBusyError(action: string): string {
  return `Error: Page is still busy; ${action} timed out waiting for page scripts. Retry in a moment.`;
}

export interface FillFormFieldInput {
  index?: number;
  selector?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  value: string;
}

export interface FillFormFieldResult {
  field: FillFormFieldInput;
  selector: string | null;
  result: string;
}

export async function loadPermittedUrl(wc: WebContents, url: string): Promise<void> {
  const { assertPermittedNavigationURL } = await import("../../network/url-safety");
  assertPermittedNavigationURL(url);
  await wc.loadURL(url);
}

export async function executePageScript<T>(
  wc: WebContents,
  script: string,
  options?: {
    timeoutMs?: number;
    userGesture?: boolean;
    label?: string;
  },
): Promise<T | typeof PAGE_SCRIPT_TIMEOUT | null> {
  if (wc.isDestroyed()) return null;

  const timeoutMs = Math.max(150, options?.timeoutMs ?? DEFAULT_PAGE_SCRIPT_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const result = await Promise.race([
      wc.executeJavaScript(script, options?.userGesture ?? false) as Promise<T>,
      new Promise<typeof PAGE_SCRIPT_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(PAGE_SCRIPT_TIMEOUT), timeoutMs);
      }),
    ]);

    if (result === PAGE_SCRIPT_TIMEOUT) {
      return PAGE_SCRIPT_TIMEOUT;
    }

    return result as T;
  } catch (err) {
    const label = options?.label ? ` (${options.label})` : "";
    logger.warn(`Failed to execute page script${label}:`, err);
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Probe the page's JS thread until it responds. */
export async function waitForJsReady(wc: WebContents, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await executePageScript<number>(wc, "1", {
      timeoutMs: 250,
      userGesture: true,
      label: "js-ready probe",
    });
    if (ready === 1) return;
    await sleep(250);
  }
}

export function waitForPotentialNavigation(
  wc: WebContents,
  beforeUrl: string,
  timeout = 2500,
): Promise<void> {
  return waitForPotentialNavigationQuietly(wc, beforeUrl, timeout, QUIET_NAVIGATION_WINDOW_MS);
}
