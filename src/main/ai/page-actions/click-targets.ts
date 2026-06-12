import type { WebContents } from "electron";
import { selectorHelpersJS } from "../../../shared/dom/selector-helpers-js";
import { sleep } from "../../utils/webcontents-utils";
import { invalidateExtractionCache } from "../../content/extractor";
import { executePageScript, PAGE_SCRIPT_TIMEOUT, pageBusyError } from "./core";

export async function clickElement(wc: WebContents, selector: string): Promise<string> {
  const target = await executePageScript<{
    x: number;
    y: number;
    obstructed: boolean;
    hiddenWindow: boolean;
    error?: string;
  }>(
    wc,
    `
    (async function() {
      function matchesTarget(candidate, el) {
        return !!candidate && (candidate === el || el.contains(candidate) || candidate.contains(el));
      }

      function samplePoints(rect) {
        const width = window.innerWidth || document.documentElement?.clientWidth || 0;
        const height = window.innerHeight || document.documentElement?.clientHeight || 0;
        const insetX = Math.min(12, rect.width / 4);
        const insetY = Math.min(12, rect.height / 4);
        const raw = [
          [rect.left + rect.width / 2, rect.top + rect.height / 2],
          [rect.left + insetX, rect.top + insetY],
          [rect.right - insetX, rect.top + insetY],
          [rect.left + insetX, rect.bottom - insetY],
          [rect.right - insetX, rect.bottom - insetY],
        ];
        return raw.map(([x, y]) => ({
          x: Math.min(Math.max(1, x), Math.max(1, width - 1)),
          y: Math.min(Math.max(1, y), Math.max(1, height - 1)),
        }));
      }

      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh." };

      if (el instanceof HTMLElement) {
        el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      }

      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve(undefined);
        };
        if (
          typeof requestAnimationFrame === "function" &&
          document.visibilityState === "visible"
        ) {
          requestAnimationFrame(() => finish());
        }
        setTimeout(finish, 32);
      });

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return { error: "Error[hidden]: Element has no visible area. It may be inside a collapsed, lazy-loaded, or virtual-scroll section. Scroll toward it (scroll or scroll_to_element) then call read_page to refresh visible elements before clicking again." };
      }

      const points = samplePoints(rect);
      const hit = points.find((point) => matchesTarget(document.elementFromPoint(point.x, point.y), el));
      const chosen = hit || points[0];
      const top = document.elementFromPoint(chosen.x, chosen.y);

      return {
        x: Math.round(chosen.x),
        y: Math.round(chosen.y),
        obstructed: !matchesTarget(top, el),
        hiddenWindow: document.visibilityState !== "visible",
      };
    })()
  `,
    {
      timeoutMs: 2000,
      label: "resolve click target",
    },
  );

  if (target === PAGE_SCRIPT_TIMEOUT) {
    // Page JS thread is unresponsive — the cached extraction is at
    // best stale. Invalidate so the next read_page re-extracts.
    invalidateExtractionCache(wc);
    return pageBusyError("click");
  }

  if (!target || typeof target !== "object") {
    return "Error: Could not resolve click target";
  }
  if ("error" in target && typeof target.error === "string") {
    // The page's DOM has shifted (stale-index, hidden, or any other
    // element-resolution failure). The cached extraction is at
    // minimum stale, possibly wrong. Invalidate so the next
    // read_page re-extracts the current page state — the model
    // gets fresh indexes and can re-pick a target.
    if (
      target.error.startsWith("Error[stale-index]") ||
      target.error.startsWith("Error[hidden]")
    ) {
      invalidateExtractionCache(wc);
    }
    return `Error: ${target.error}`;
  }

  const x = typeof target.x === "number" ? target.x : null;
  const y = typeof target.y === "number" ? target.y : null;
  const hiddenWindow = target.hiddenWindow === true;
  if (x == null || y == null) {
    return "Error: Could not resolve click coordinates";
  }

  if (hiddenWindow) {
    const activationResult = await activateElement(wc, selector);
    if (activationResult.startsWith("Error:")) {
      return activationResult;
    }
    await sleep(80);
    return "Clicked via DOM activation";
  }

  wc.sendInputEvent({ type: "mouseMove", x, y });
  await sleep(16);
  wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  await sleep(24);
  wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  await sleep(80);

  return target.obstructed
    ? "Clicked via pointer events (target may be partially obstructed)"
    : "Clicked via pointer events";
}

export async function activateElement(wc: WebContents, selector: string): Promise<string> {
  const activated = await executePageScript<{ ok?: boolean; error?: string }>(
    wc,
    `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "Element not found" };
      if (el instanceof HTMLElement) {
        el.focus({ preventScroll: true });
      }
      if (typeof el.click === "function") {
        el.click();
        return { ok: true };
      }
      return { error: "Element is not clickable" };
    })()
  `,
    {
      label: "activate element",
    },
  );

  if (activated === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("activate");
  }

  if (!activated || typeof activated !== "object") {
    return "Error: Could not activate element";
  }
  if ("error" in activated && typeof activated.error === "string") {
    return `Error: ${activated.error}`;
  }

  return "Activated element via DOM click";
}

export async function describeElementForClick(
  wc: WebContents,
  selector: string,
): Promise<
  | { text: string; href?: string; target?: string; tag?: string; isInteractive?: boolean }
  | { error: string }
> {
  const result = await executePageScript<{
    text?: string;
    href?: string;
    target?: string;
    tag?: string;
    isInteractive?: boolean;
    error?: string;
  }>(
    wc,
    `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "Element not found" };
      const anchor = el instanceof HTMLAnchorElement ? el : el.closest("a[href]");
      const text = (el.textContent || el.tagName || "Element").trim().slice(0, 100);
      const tag = el.tagName.toLowerCase();
      const interactiveTags = new Set(["a","button","input","select","textarea","summary","details","option"]);
      const hasRole = el.getAttribute("role") === "button" || el.getAttribute("role") === "link" || el.getAttribute("role") === "tab";
      const hasClickListener = el.onclick != null || el.getAttribute("onclick") != null;
      const isInteractive = interactiveTags.has(tag) || hasRole || hasClickListener || !!anchor;
      return {
        text: text || "Element",
        href: anchor instanceof HTMLAnchorElement ? anchor.href : undefined,
        target: anchor instanceof HTMLAnchorElement ? (anchor.getAttribute("target") || "") : undefined,
        tag,
        isInteractive,
      };
    })()
  `,
    {
      label: "describe element",
    },
  );

  if (result === PAGE_SCRIPT_TIMEOUT) {
    return { error: "Page is still busy" };
  }

  if (!result || typeof result !== "object") {
    return { error: "Element not found" };
  }
  if ("error" in result && typeof result.error === "string") {
    return { error: result.error };
  }

  return {
    text: "text" in result && typeof result.text === "string" ? result.text : "Element",
    href: "href" in result && typeof result.href === "string" ? result.href : undefined,
    target: "target" in result && typeof result.target === "string" ? result.target : undefined,
    tag: "tag" in result && typeof result.tag === "string" ? result.tag : undefined,
    isInteractive:
      "isInteractive" in result && typeof result.isInteractive === "boolean"
        ? result.isInteractive
        : undefined,
  };
}

export async function inspectElement(
  wc: WebContents,
  selector: string,
  limit = 8,
): Promise<string> {
  const result = await executePageScript<{
    target?: {
      label: string;
      tag: string;
      text?: string;
      href?: string;
      value?: string;
    };
    region?: {
      tag: string;
      label: string;
      text?: string;
    };
    nearby?: Array<{
      index?: number;
      label: string;
      type: string;
      selector: string;
      href?: string;
    }>;
    purchaseActions?: Array<{
      index?: number;
      label: string;
      type: string;
      selector: string;
      href?: string;
      source: "nearby" | "page";
    }>;
    error?: string;
  }>(
    wc,
    `
    (function() {
      function text(value) {
        const trimmed = value == null ? "" : String(value).trim();
        return trimmed || undefined;
      }

      ${selectorHelpersJS(["data-testid", "name", "form", "aria-label", "title"])}

      function isVisible(el) {
        if (!(el instanceof HTMLElement)) return true;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function labelFor(el) {
        return text(
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.getAttribute("name") ||
          el.getAttribute("placeholder") ||
          el.textContent ||
          el.getAttribute("value") ||
          el.tagName
        ) || "element";
      }

      function purchasePriority(label, href) {
        const haystack = ((label || "") + " " + (href || ""))
          .toLowerCase()
          .replace(/\\s+/g, " ")
          .trim();
        if (!haystack) return null;
        if (/\\badd(?: item)? to (?:cart|bag|basket)\\b/.test(haystack)) return 0;
        if (/\\b(?:buy now|preorder|pre-order|reserve now|shop now)\\b/.test(haystack)) return 1;
        if (/\\b(?:checkout|view cart|view basket|go to cart|view bag)\\b/.test(haystack)) return 2;
        return null;
      }

      function chooseRegion(target) {
        const preferred = target.closest(
          "[data-testid], article, [role='article'], [role='listitem'], li, tr, form, section, aside, dialog, [role='dialog']"
        );
        if (preferred) return preferred;
        let current = target.parentElement;
        let depth = 0;
        while (current && depth < 5) {
          const count = current.querySelectorAll("a[href], button, input, select, textarea").length;
          if (count >= 2 && count <= 16) return current;
          current = current.parentElement;
          depth += 1;
        }
        return target.parentElement || target;
      }

      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return { error: "Element not found" };
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      }

      const region = chooseRegion(target);
      const nearby = [];
      const seen = new Set();
      const purchaseActions = [];
      const purchaseSeen = new Set();
      region.querySelectorAll("a[href], button, input:not([type='hidden']), select, textarea").forEach((el) => {
        if (!(el instanceof HTMLElement) || !isVisible(el)) return;
        const candidateSelector = selectorFor(el);
        if (!candidateSelector || seen.has(candidateSelector)) return;
        seen.add(candidateSelector);
        const candidateLabel = labelFor(el).slice(0, 100);
        const candidateHref = el instanceof HTMLAnchorElement ? text(el.href) : undefined;
        nearby.push({
          index: typeof window.__vessel?.getElementIndexBySelector === "function"
            ? window.__vessel.getElementIndexBySelector(candidateSelector) ?? undefined
            : undefined,
          label: candidateLabel,
          type: el.tagName.toLowerCase(),
          selector: candidateSelector,
          href: candidateHref,
        });
        const purchaseRank = purchasePriority(candidateLabel, candidateHref);
        if (purchaseRank !== null && !purchaseSeen.has(candidateSelector)) {
          purchaseSeen.add(candidateSelector);
          purchaseActions.push({
            index: typeof window.__vessel?.getElementIndexBySelector === "function"
              ? window.__vessel.getElementIndexBySelector(candidateSelector) ?? undefined
              : undefined,
            label: candidateLabel,
            type: el.tagName.toLowerCase(),
            selector: candidateSelector,
            href: candidateHref,
            source: "nearby",
            rank: purchaseRank,
          });
        }
      });

      document.querySelectorAll("button, a[href], input[type='submit'], input[type='button']").forEach((el) => {
        if (!(el instanceof HTMLElement) || !isVisible(el)) return;
        const candidateSelector = selectorFor(el);
        if (!candidateSelector || purchaseSeen.has(candidateSelector)) return;
        const candidateLabel = labelFor(el).slice(0, 100);
        const candidateHref = el instanceof HTMLAnchorElement ? text(el.href) : undefined;
        const purchaseRank = purchasePriority(candidateLabel, candidateHref);
        if (purchaseRank === null) return;
        purchaseSeen.add(candidateSelector);
        purchaseActions.push({
          index: typeof window.__vessel?.getElementIndexBySelector === "function"
            ? window.__vessel.getElementIndexBySelector(candidateSelector) ?? undefined
            : undefined,
          label: candidateLabel,
          type: el.tagName.toLowerCase(),
          selector: candidateSelector,
          href: candidateHref,
          source: "page",
          rank: purchaseRank,
        });
      });

      purchaseActions.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (a.source !== b.source) return a.source === "nearby" ? -1 : 1;
        return a.label.localeCompare(b.label);
      });

      return {
        target: {
          label: labelFor(target).slice(0, 120),
          tag: target.tagName.toLowerCase(),
          text: text(target.textContent)?.slice(0, 240),
          href: target instanceof HTMLAnchorElement ? text(target.href) : undefined,
          value: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
            ? text(target.value)?.slice(0, 120)
            : undefined,
        },
        region: {
          tag: region.tagName.toLowerCase(),
          label: labelFor(region).slice(0, 120),
          text: text(region.textContent)?.slice(0, 400),
        },
        nearby: nearby.slice(0, ${Math.max(1, Math.min(20, limit))}),
        purchaseActions: purchaseActions.slice(0, 8).map((item) => ({
          index: item.index,
          label: item.label,
          type: item.type,
          selector: item.selector,
          href: item.href,
          source: item.source,
        })),
      };
    })()
  `,
    {
      timeoutMs: 2000,
      label: "inspect element",
    },
  );

  if (result === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("inspect_element");
  }
  if (!result || typeof result !== "object") {
    return "Error: Could not inspect element";
  }
  if ("error" in result && typeof result.error === "string") {
    return `Error: ${result.error}`;
  }

  const lines: string[] = [];
  if (result.target) {
    lines.push(`Target: ${result.target.label} <${result.target.tag}>`);
    if (result.target.text) lines.push(`Target text: ${result.target.text}`);
    if (result.target.href) lines.push(`Target href: ${result.target.href}`);
    if (result.target.value) lines.push(`Target value: ${result.target.value}`);
  }
  if (result.region) {
    lines.push(`Region: ${result.region.label} <${result.region.tag}>`);
    if (result.region.text) lines.push(`Region text: ${result.region.text}`);
  }
  if (Array.isArray(result.nearby) && result.nearby.length > 0) {
    lines.push("Nearby controls:");
    for (const item of result.nearby) {
      const hrefSuffix = item.href ? ` -> ${item.href}` : "";
      const indexPrefix = typeof item.index === "number" ? `[#${item.index}] ` : "";
      lines.push(
        `- ${indexPrefix}${item.label} [${item.type}] selector=${item.selector}${hrefSuffix}`,
      );
    }
  }
  if (Array.isArray(result.purchaseActions) && result.purchaseActions.length > 0) {
    lines.push("Likely purchase actions:");
    for (const item of result.purchaseActions) {
      const hrefSuffix = item.href ? ` -> ${item.href}` : "";
      const sourceSuffix = item.source === "nearby" ? " (same region)" : " (elsewhere on page)";
      const indexPrefix = typeof item.index === "number" ? `[#${item.index}] ` : "";
      lines.push(
        `- ${indexPrefix}${item.label} [${item.type}] selector=${item.selector}${hrefSuffix}${sourceSuffix}`,
      );
    }
    lines.push(
      "When an index is available, prefer click(index=N) over selector-based clicks because it is more stable.",
    );
  }

  return lines.join("\n");
}
