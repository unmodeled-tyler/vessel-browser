import type { ActionContext } from "../core";
import {
  PAGE_SCRIPT_TIMEOUT,
  pageBusyError,
  executePageScript,
  logger,
  waitForPotentialNavigation,
} from "../core";
import {
  focusElement,
  hoverElement,
  pressKey,
  selectOption,
  setElementValue,
  submitForm,
  typeKeystroke,
} from "../interaction";
import { resolveSelector } from "../../../utils/selector-resolver";
import {
  isInvalidTextTargetQuery,
  resolveTextTargetInDocument,
  type TextTargetMode,
} from "../../text-target-resolver";
import { clickResolvedSelector, scrollPage } from "../navigation";
import { clearOverlays, dismissPopup } from "../overlays";
import { locateImplicitTextTarget } from "../navigation";
import { coerceOptionalNumber } from "../../../tools/input-coercion";
import { inspectElement } from "../click-targets";

/**
 * Resolve a target element to a CSS selector (or `__vessel_idx:N`) by
 * combining index, selector, and visible-text hints. Used by click,
 * inspect, and scroll-to-element.
 */
async function resolveTargetByText(
  wc: import("electron").WebContents,
  query: string,
  mode: TextTargetMode,
): Promise<string | null | typeof PAGE_SCRIPT_TIMEOUT> {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (isInvalidTextTargetQuery(trimmed)) return null;

  const result = await executePageScript<{
    selector: string;
    label: string;
    kind: string;
    matchedText: string;
  } | { __vesselTextTargetError: string } | null>(
    wc,
    `(() => { const __name = (fn) => fn; try { return (${resolveTextTargetInDocument.toString()})(document, ${JSON.stringify(trimmed)}, ${JSON.stringify(mode)}); } catch (error) { return { __vesselTextTargetError: String((error && error.stack) || error) }; } })()`,
    {
      timeoutMs: 2200,
      label: `resolve ${mode} target by text`,
    },
  );

  if (result === PAGE_SCRIPT_TIMEOUT) return PAGE_SCRIPT_TIMEOUT;
  if (result && "__vesselTextTargetError" in result) {
    logger.warn(`Text target resolver failed (${mode}): ${result.__vesselTextTargetError}`);
    return null;
  }
  if (!result || typeof result.selector !== "string" || !result.selector) {
    return null;
  }
  return result.selector;
}

export async function handleClick(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const textTarget = typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";
  let selector: string | null | typeof PAGE_SCRIPT_TIMEOUT = null;

  if (typeof args.selector === "string" && args.selector.trim()) {
    selector = await resolveSelector(wc, undefined, args.selector);
  } else if (textTarget) {
    if (isInvalidTextTargetQuery(textTarget)) {
      return `Error: "${textTarget}" looks like HTML or markup, not a visible page label. Use a book title, button text, or element index instead.`;
    }
    selector = await resolveTargetByText(wc, textTarget, "interactive");
    if (!selector && typeof args.index === "number") {
      selector = `__vessel_idx:${args.index}`;
    }
  } else if (typeof args.index === "number") {
    selector = await resolveSelector(wc, args.index);
    if (!selector) selector = `__vessel_idx:${args.index}`;
  } else {
    selector = await resolveSelector(wc, args.index, args.selector);
  }
  if (selector === PAGE_SCRIPT_TIMEOUT) return pageBusyError("click");
  if (!selector) {
    return "Error: No element index, selector, or visible text provided";
  }
  return clickResolvedSelector(wc, selector);
}

export async function handleInspectElement(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  let selector: string | null | typeof PAGE_SCRIPT_TIMEOUT = null;
  const textTarget = typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";
  if (textTarget) {
    if (isInvalidTextTargetQuery(textTarget)) {
      return `Error: "${textTarget}" looks like HTML or markup, not visible page text. Use a section title, book title, or element index instead.`;
    }
    selector = await resolveTargetByText(wc, textTarget, "context");
  } else {
    selector = await resolveSelector(wc, args.index, args.selector);
  }
  if (selector === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("inspect_element");
  }
  if (!selector) {
    return "Error: No element index, selector, or visible text provided";
  }
  return inspectElement(wc, selector, typeof args.limit === "number" ? args.limit : 8);
}

export async function handleTypeText(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  let selector = await resolveSelector(wc, args.index, args.selector);
  if (selector === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("type_text");
  }
  if (!selector) {
    selector = await locateImplicitTextTarget(wc);
  }
  if (selector === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("type_text");
  }
  if (!selector) {
    return "Error: No element index or selector provided, and no focused or visible text input could be found.";
  }
  const mode = typeof args.mode === "string" ? args.mode : "default";
  if (mode === "keystroke") {
    return typeKeystroke(wc, selector, String(args.text || ""));
  }
  return setElementValue(wc, selector, String(args.text || ""));
}

export async function handleSelectOption(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  return selectOption(wc, args);
}

export async function handleSubmitForm(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const beforeUrl = wc.getURL();
  const result = await submitForm(wc, args);
  if (
    result.startsWith("Error") ||
    result.startsWith("Target") ||
    result.startsWith("No parent") ||
    result.startsWith("Submit control")
  ) {
    return result;
  }
  await waitForPotentialNavigation(wc, beforeUrl);
  const afterUrl = wc.getURL();
  return afterUrl !== beforeUrl ? `${result} -> ${afterUrl}` : result;
}

export async function handlePressKey(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const beforeUrl = wc.getURL();
  const result = await pressKey(wc, args);
  const key = typeof args.key === "string" ? args.key.trim() : "";
  if (key === "Enter") {
    await waitForPotentialNavigation(wc, beforeUrl, 3000);
    const afterUrl = wc.getURL();
    if (afterUrl !== beforeUrl) {
      return `${result} -> ${afterUrl}`;
    }
  } else {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return result;
}

export async function handleScroll(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const pixels = coerceOptionalNumber(args.amount) ?? 500;
  const dir = args.direction === "up" ? -pixels : pixels;
  const result = await scrollPage(wc, dir);
  return `Scrolled ${args.direction} by ${pixels}px (moved ${Math.abs(result.movedY)}px, now at y=${Math.round(result.afterY)})`;
}

export async function handleHover(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const selector = await resolveSelector(wc, args.index, args.selector);
  if (!selector) return "Error: No element index or selector provided";
  return hoverElement(wc, selector);
}

export async function handleFocus(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const selector = await resolveSelector(wc, args.index, args.selector);
  if (!selector) return "Error: No element index or selector provided";
  return focusElement(wc, selector);
}

export async function handleDismissPopup(ctx: ActionContext): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  return dismissPopup(wc);
}

export async function handleClearOverlays(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const strategy = args.strategy === "interactive" ? "interactive" : "auto";
  return clearOverlays(wc, strategy);
}

export async function handleScrollToElement(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  let sel: string | null | typeof PAGE_SCRIPT_TIMEOUT = null;
  const textTarget = typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";
  if (textTarget) {
    if (isInvalidTextTargetQuery(textTarget)) {
      return `Error: "${textTarget}" looks like HTML or markup, not visible page text. Use a section title or element index instead.`;
    }
    sel = await resolveTargetByText(wc, textTarget, "context");
  } else {
    sel = await resolveSelector(wc, args.index, args.selector);
  }
  if (sel === PAGE_SCRIPT_TIMEOUT) return pageBusyError("scroll_to_element");
  if (!sel) {
    return "Error: Provide an index, selector, or visible text for the element to scroll to.";
  }
  const block = args.position === "top" ? "start" : args.position === "bottom" ? "end" : "center";
  if (sel.startsWith("__vessel_idx:")) {
    const idx = Number(sel.slice("__vessel_idx:".length));
    return wc.executeJavaScript(`
      (function() {
        var el = window.__vessel?.interactByIndex && Object.values(window.__vessel)[2];
        var ref = (function() { try { return document.querySelector('[data-vessel-idx="${idx}"]'); } catch(e) { return null; } })();
        if (!ref) return "Error: Element not found";
        ref.scrollIntoView({ behavior: "smooth", block: "${block}" });
        return "Scrolled to element #${idx}";
      })()
    `);
  }
  if (sel.includes(" >>> ")) {
    return wc.executeJavaScript(`
      (function() {
        var el = window.__vessel?.resolveShadowSelector?.(${JSON.stringify(sel)});
        if (!el) return "Error: Shadow DOM element not found";
        el.scrollIntoView({ behavior: "smooth", block: "${block}" });
        return "Scrolled to shadow DOM element";
      })()
    `);
  }
  return wc.executeJavaScript(`
    (function() {
      var el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return "Error: Element not found";
      el.scrollIntoView({ behavior: "smooth", block: "${block}" });
      return "Scrolled to element";
    })()
  `);
}
