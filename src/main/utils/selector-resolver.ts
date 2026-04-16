import type { WebContents } from "electron";
import { extractContent } from "../content/extractor";
import { findSelectorByIndex } from "../mcp/indexed-selector";

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
        function escapeSelectorValue(value) {
          if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
            return CSS.escape(value);
          }
          return String(value).replace(/["\\]/g, "\\$&");
        }

        function uniqueSelector(candidate) {
          if (!candidate) return null;
          try {
            return document.querySelectorAll(candidate).length === 1 ? candidate : null;
          } catch {
            return null;
          }
        }

        function uniqueAttributeSelector(el, attribute) {
          var value = el.getAttribute(attribute);
          if (!value) return null;
          value = value.trim();
          if (!value) return null;
          var candidate = el.tagName.toLowerCase() + "[" + attribute + "=\\"" + escapeSelectorValue(value) + "\\"]";
          return uniqueSelector(candidate);
        }

        function selectorFor(el) {
          if (!el) return null;
          if (el.id) return "#" + escapeSelectorValue(el.id);
          var attributes = ["data-testid", "name", "form", "aria-label"];
          for (var i = 0; i < attributes.length; i += 1) {
            var attributeCandidate = uniqueAttributeSelector(el, attributes[i]);
            if (attributeCandidate) return attributeCandidate;
          }
          var parts = [];
          var current = el;
          while (current) {
            if (current.id) {
              parts.unshift("#" + escapeSelectorValue(current.id));
              break;
            }
            var tag = current.tagName.toLowerCase();
            var parent = current.parentElement;
            if (!parent) { parts.unshift(tag); break; }
            var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === current.tagName; });
            var index = siblings.indexOf(current) + 1;
            parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
            current = parent;
          }
          var selector = parts.join(" > ");
          return uniqueSelector(selector) || selector;
        }

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
