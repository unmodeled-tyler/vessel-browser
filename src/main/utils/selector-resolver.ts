import type { WebContents } from "electron";
import { extractContent } from "../content/extractor";
import { findSelectorByIndex } from "../mcp/indexed-selector";
import { selectorHelpersJS } from "../../shared/dom/selector-helpers-js";

async function resolveSelector(
  wc: WebContents,
  index?: number,
  selector?: string,
): Promise<string | null> {
  if (selector) return selector;
  if (index == null) return null;

  const authoritativeSelector = await wc.executeJavaScript(
    `
      (function() {
        return window.__vessel?.getElementSelector
          ? window.__vessel.getElementSelector(${index})
          : null;
      })()
    `,
  );
  if (typeof authoritativeSelector === "string" && authoritativeSelector) {
    if (authoritativeSelector.includes(" >>> ")) {
      const resolves = await wc.executeJavaScript(
        `!!window.__vessel?.resolveShadowSelector?.(${JSON.stringify(authoritativeSelector)})`,
      );
      if (resolves) return authoritativeSelector;
      return `__vessel_idx:${index}`;
    }
    const resolves = await wc.executeJavaScript(
      `!!document.querySelector(${JSON.stringify(authoritativeSelector)})`,
    );
    if (resolves) return authoritativeSelector;
    return `__vessel_idx:${index}`;
  }

  const fallbackSelector = await wc.executeJavaScript(
    `
      (function() {
        ${selectorHelpersJS(["data-testid", "name", "form", "aria-label"])}

        var seen = new Set();
        var ordered = [];
        document.querySelectorAll("nav a[href], [role='navigation'] a[href]").forEach(function(el) {
          if (!seen.has(el)) { seen.add(el); ordered.push(el); }
        });
        document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button']").forEach(function(el) {
          if (!seen.has(el)) { seen.add(el); ordered.push(el); }
        });
        document.querySelectorAll("a[href]").forEach(function(el) {
          if (!seen.has(el)) { seen.add(el); ordered.push(el); }
        });
        document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']), select, textarea").forEach(function(el) {
          if (!seen.has(el)) { seen.add(el); ordered.push(el); }
        });

        var target = ordered[${index} - 1];
        return target ? selectorFor(target) : null;
      })()
    `,
  );
  if (typeof fallbackSelector === "string" && fallbackSelector) {
    return fallbackSelector;
  }

  const page = await extractContent(wc);
  const extractedSelector = findSelectorByIndex(page, index);
  if (extractedSelector) return extractedSelector;

  return null;
}

export { resolveSelector };
