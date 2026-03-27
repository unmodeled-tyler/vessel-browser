import type { WebContents } from "electron";
import type { PageContent } from "../../shared/types";
import { detectPageIssues } from "./page-access-issues";
import { extractStructuredDataFromJsonLd } from "./structured-data";
import { trackExtractionFailed } from "../telemetry/posthog";

const EMPTY_PAGE_CONTENT: PageContent = {
  title: "",
  content: "",
  htmlContent: "",
  byline: "",
  excerpt: "",
  url: "",
  headings: [],
  navigation: [],
  interactiveElements: [],
  forms: [],
  viewport: {
    width: 0,
    height: 0,
    scrollX: 0,
    scrollY: 0,
  },
  overlays: [],
  dormantOverlays: [],
  landmarks: [],
  jsonLd: [],
  microdata: [],
  rdfa: [],
  metaTags: {},
  structuredData: [],
  pageIssues: [],
};

const PRELOAD_EXTRACTION_SCRIPT = String.raw`
  (function() {
    try {
      if (window.__vessel && typeof window.__vessel.extractContent === "function") {
        const structured = window.__vessel.extractContent();
        if (structured && typeof structured === "object") {
          return structured;
        }
      }
    } catch (_error) {
    }
    return null;
  })()
`;

const DIRECT_EXTRACTION_SCRIPT = String.raw`
  (function() {
    // Time budget: stop expensive DOM traversals after this many ms so heavy
    // pages (Newegg, Wikipedia, etc.) don't stall the agent for 30-60s+.
    var BUDGET_MS = 8000;
    var _budgetStart = performance.now();
    function withinBudget() {
      return (performance.now() - _budgetStart) < BUDGET_MS;
    }

    function getCleanBodyText() {
      var removed = [];
      document
        .querySelectorAll('.__vessel-highlight-label[data-vessel-highlight]')
        .forEach(function(label) {
          var parent = label.parentNode;
          if (!parent) return;
          removed.push({ label: label, parent: parent, nextSibling: label.nextSibling });
          parent.removeChild(label);
        });
      try {
        return document.body?.innerText || document.documentElement?.innerText || "";
      } finally {
        for (var i = removed.length - 1; i >= 0; i--) {
          var entry = removed[i];
          entry.parent.insertBefore(entry.label, entry.nextSibling);
        }
      }
    }

    function text(value) {
      const trimmed = value == null ? "" : String(value).trim();
      return trimmed || undefined;
    }

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
      const value = text(el.getAttribute && el.getAttribute(attribute));
      if (!value) return null;
      const candidate = el.tagName.toLowerCase() + "[" + attribute + "=\"" + escapeSelectorValue(value) + "\"]";
      return uniqueSelector(candidate);
    }

    function selectorFor(el) {
      if (!el) return "";
      if (el.id) return "#" + escapeSelectorValue(el.id);
      for (const attribute of ["data-testid", "name", "form", "aria-label"]) {
        const candidate = uniqueAttributeSelector(el, attribute);
        if (candidate) return candidate;
      }
      const parts = [];
      let current = el;
      while (current) {
        if (current.id) {
          parts.unshift("#" + escapeSelectorValue(current.id));
          break;
        }
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        const index = siblings.indexOf(current) + 1;
        parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
        current = parent;
      }
      const selector = parts.join(" > ");
      return uniqueSelector(selector) || selector;
    }

    function visible(el) {
      if (!(el instanceof HTMLElement)) return true;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function viewportWidth() {
      return Math.max(
        window.innerWidth || 0,
        window.visualViewport?.width || 0,
        document.documentElement?.clientWidth || 0,
        document.scrollingElement?.clientWidth || 0,
        document.body?.clientWidth || 0,
        window.screen?.availWidth || 0,
      );
    }

    function viewportHeight() {
      return Math.max(
        window.innerHeight || 0,
        window.visualViewport?.height || 0,
        document.documentElement?.clientHeight || 0,
        document.scrollingElement?.clientHeight || 0,
        document.body?.clientHeight || 0,
        window.screen?.availHeight || 0,
      );
    }

    function scrollingElement() {
      return document.scrollingElement || document.documentElement || document.body;
    }

    function inViewport(rect) {
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < viewportHeight() &&
        rect.left < viewportWidth();
    }

    function fullyInViewport(rect) {
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= viewportHeight() &&
        rect.right <= viewportWidth();
    }

    function parseZIndex(style) {
      const value = Number.parseInt(style.zIndex, 10);
      return Number.isFinite(value) ? value : 0;
    }

    function overlayLabel(el) {
      return text(el.getAttribute && el.getAttribute("aria-label")) ||
        text(el.id) ||
        undefined;
    }

    function overlayType(el) {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      if (tag === "dialog" || role === "dialog" || role === "alertdialog") {
        return "dialog";
      }
      if (el.getAttribute("aria-modal") === "true") {
        return "modal";
      }
      return "overlay";
    }

    function coversViewportCenter(rect) {
      const centerX = viewportWidth() / 2;
      const centerY = viewportHeight() / 2;
      return rect.left <= centerX &&
        rect.right >= centerX &&
        rect.top <= centerY &&
        rect.bottom >= centerY;
    }

    function touchesViewportEdge(rect) {
      const edgePadding = 24;
      return rect.left <= edgePadding ||
        rect.top <= edgePadding ||
        rect.right >= viewportWidth() - edgePadding ||
        rect.bottom >= viewportHeight() - edgePadding;
    }

    function hasFixedAncestor(el) {
      var cur = el.parentElement;
      while (cur && cur !== document.body) {
        var ps = getComputedStyle(cur).position;
        if (ps === "fixed" || ps === "sticky") return true;
        cur = cur.parentElement;
      }
      return false;
    }

    function isPositioned(style) {
      return style.position === "fixed" || style.position === "sticky" ||
        style.position === "absolute";
    }

    function effectiveZIndex(style, el) {
      var z = parseZIndex(style);
      if (z > 0) return z;
      var cur = el.parentElement;
      while (cur && cur !== document.body) {
        var pz = parseZIndex(getComputedStyle(cur));
        if (pz > 0) return pz;
        cur = cur.parentElement;
      }
      return 0;
    }

    function looksLikeDrawer(style, rect, areaRatio, el) {
      if (rect.width < 220 || rect.height < 160 || areaRatio < 0.08) return false;
      if (!touchesViewportEdge(rect)) return false;
      if (style.position === "fixed" || style.position === "sticky") {
        return effectiveZIndex(style, el) >= 5;
      }
      if (style.position === "absolute" && hasFixedAncestor(el)) {
        return effectiveZIndex(style, el) >= 5;
      }
      return false;
    }

    function looksLikeCartConfirmation(node) {
      var t = (node.textContent || "").slice(0, 500).toLowerCase();
      var signals = ["added to cart", "added to bag", "added to basket",
        "added to your cart", "added to your bag", "added to your basket"];
      return signals.some(function(s) { return t.indexOf(s) !== -1; });
    }

    function detectOverlays() {
      if (!document.body) return [];
      const viewportArea = Math.max(1, viewportWidth() * viewportHeight());
      const overlays = [];

      // Use targeted selectors instead of querySelectorAll("*") to avoid
      // expensive getComputedStyle/getBoundingClientRect on every DOM element.
      // On heavy SPAs (e.g. Newegg) the wildcard could hit 10,000+ elements.
      var candidates = new Set();

      // Semantic overlays: dialogs, modals, aria-modal
      document.body.querySelectorAll(
        "dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']"
      ).forEach(function(el) { candidates.add(el); });

      // Known consent manager containers — these are often missed by generic
      // heuristics because they use custom stacking or non-standard z-indices
      document.body.querySelectorAll(
        '#onetrust-consent-sdk, #CybotCookiebotDialog, [class*="consent-banner"], ' +
        '[class*="cookie-banner"], [class*="privacy-banner"], [id*="consent-wall"], ' +
        '.fc-consent-root, #sp_message_container_, [id*="trustarc"], ' +
        '[class*="cmp-"], [id*="cmp-container"], [class*="gdpr"], ' +
        '[data-testid*="consent"], [data-testid*="cookie"], [data-testid*="privacy"]'
      ).forEach(function(el) { candidates.add(el); });

      // Fixed/sticky elements are the other overlay category — walk only
      // direct children of body and high-level containers (depth ≤ 3)
      // since real overlays are almost always near the top of the DOM tree.
      var MAX_CANDIDATES = 2000;
      var allElements = document.body.querySelectorAll("*");
      for (var ci = 0; ci < allElements.length && candidates.size < MAX_CANDIDATES; ci++) {
        candidates.add(allElements[ci]);
      }

      candidates.forEach(function(node) {
        if (!withinBudget()) return;
        if (!(node instanceof HTMLElement)) return;
        if (!visible(node)) return;

        var style = window.getComputedStyle(node);
        if (style.pointerEvents === "none") return;

        var rect = node.getBoundingClientRect();
        if (!inViewport(rect)) return;

        var type = overlayType(node);
        var dialogLike = type === "dialog" || type === "modal";
        var areaRatio = (rect.width * rect.height) / viewportArea;
        var drawerLike = looksLikeDrawer(style, rect, areaRatio, node);
        var cartConfirm = !dialogLike && !drawerLike && isPositioned(style) &&
          rect.width >= 160 && rect.height >= 100 &&
          looksLikeCartConfirmation(node);
        // Body scroll-lock + large fixed element is a strong overlay signal
        // even without high z-index or exact center coverage
        var bodyLocked = (function() {
          var bs = window.getComputedStyle(document.body);
          var hs = window.getComputedStyle(document.documentElement);
          return bs.overflow === "hidden" || hs.overflow === "hidden";
        })();
        var blocksInteraction = dialogLike ||
          drawerLike ||
          cartConfirm ||
          ((style.position === "fixed" || style.position === "sticky") &&
            parseZIndex(style) >= 10 &&
            areaRatio >= 0.3 &&
            coversViewportCenter(rect)) ||
          (bodyLocked &&
            (style.position === "fixed" || style.position === "sticky") &&
            areaRatio >= 0.2);

        if (!blocksInteraction && type !== "dialog" && type !== "modal") return;

        overlays.push({
          element: node,
          type: type,
          role: text(node.getAttribute("role")),
          label: overlayLabel(node),
          selector: selectorFor(node),
          text: text(node.textContent)?.slice(0, 160),
          blocksInteraction: blocksInteraction,
          zIndex: parseZIndex(style),
        });
      });

      return overlays.sort(function(a, b) {
        if ((a.blocksInteraction ? 1 : 0) !== (b.blocksInteraction ? 1 : 0)) {
          return (b.blocksInteraction ? 1 : 0) - (a.blocksInteraction ? 1 : 0);
        }
        return b.zIndex - a.zIndex;
      });
    }

    const overlays = detectOverlays();

    function samplePoint(rect) {
      if (!inViewport(rect)) return null;
      return {
        x: Math.min(Math.max(0, rect.left + rect.width / 2), Math.max(0, viewportWidth() - 1)),
        y: Math.min(Math.max(0, rect.top + rect.height / 2), Math.max(0, viewportHeight() - 1)),
      };
    }

    function visibilityState(el) {
      if (!(el instanceof HTMLElement)) {
        return {
          visible: true,
          inViewport: true,
          fullyInViewport: true,
          obscured: false,
          blockedByOverlay: false,
        };
      }

      const rect = el.getBoundingClientRect();
      const isVisible = visible(el);
      const isInViewport = isVisible && inViewport(rect);
      const isFullyInViewport = isVisible && fullyInViewport(rect);
      let obscured = false;
      let blockedByOverlay = false;

      if (isInViewport) {
        const point = samplePoint(rect);
        if (point) {
          const topElement = document.elementFromPoint(point.x, point.y);
          if (
            topElement &&
            topElement !== el &&
            !el.contains(topElement) &&
            !(topElement instanceof HTMLElement && topElement.contains(el))
          ) {
            obscured = true;
            blockedByOverlay = overlays.some(
              (overlay) =>
                overlay.blocksInteraction &&
                overlay.element.contains(topElement) &&
                !overlay.element.contains(el),
            );
          }
        }
      }

      return {
        visible: isVisible,
        inViewport: isInViewport,
        fullyInViewport: isFullyInViewport,
        obscured,
        blockedByOverlay,
      };
    }

    function viewportSnapshot() {
      const scroller = scrollingElement();
      const scrollXCandidates = [
        window.scrollX,
        window.pageXOffset,
        window.visualViewport?.pageLeft,
        scroller?.scrollLeft,
        document.documentElement?.scrollLeft,
        document.body?.scrollLeft,
      ].filter((value) => typeof value === "number");
      const scrollYCandidates = [
        window.scrollY,
        window.pageYOffset,
        window.visualViewport?.pageTop,
        scroller?.scrollTop,
        document.documentElement?.scrollTop,
        document.body?.scrollTop,
      ].filter((value) => typeof value === "number");

      return {
        width: viewportWidth(),
        height: viewportHeight(),
        scrollX: Math.max(0, ...scrollXCandidates),
        scrollY: Math.max(0, ...scrollYCandidates),
      };
    }

    function disabled(el) {
      return !!(el && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true"));
    }

    function contextOf(el) {
      const overlayRoot = overlays.find(
        (overlay) => overlay.element === el || overlay.element.contains(el),
      );
      if (overlayRoot) return "dialog";

      let current = el.parentElement;
      while (current) {
        const tag = current.tagName.toLowerCase();
        const role = current.getAttribute("role");
        if (tag === "nav" || role === "navigation") return "nav";
        if (tag === "header" || role === "banner") return "header";
        if (tag === "main" || role === "main") return "main";
        if (tag === "footer" || role === "contentinfo") return "footer";
        if (tag === "aside" || role === "complementary") return "sidebar";
        if (tag === "article" || role === "article") return "article";
        if (tag === "dialog" || role === "dialog" || role === "alertdialog") return "dialog";
        if (tag === "form") return "form" + (current.id ? "#" + current.id : "");
        current = current.parentElement;
      }
      return "content";
    }

    function labelFor(el) {
      if (el.id) {
        const label = document.querySelector("label[for=\"" + escapeSelectorValue(el.id) + "\"]");
        if (label) return text(label.textContent);
      }
      const parentLabel = el.closest && el.closest("label");
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true);
        clone.querySelectorAll && clone.querySelectorAll("input, select, textarea").forEach((node) => node.remove());
        const labelText = text(clone.textContent);
        if (labelText) return labelText;
      }
      const aria = text(el.getAttribute && el.getAttribute("aria-label"));
      if (aria) return aria;
      const labelledBy = el.getAttribute && el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const joined = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ")
          .trim();
        if (joined) return joined;
      }
      return text(el.getAttribute && el.getAttribute("placeholder"));
    }

    function descriptionFor(el) {
      const aria = text(el.getAttribute && el.getAttribute("aria-description"));
      if (aria) return aria;
      const describedBy = el.getAttribute && el.getAttribute("aria-describedby");
      if (describedBy) {
        const joined = describedBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ")
          .trim();
        if (joined) return joined;
      }
      return text(el.getAttribute && el.getAttribute("title"));
    }

    let indexCounter = 0;
    function nextIndex(el) {
      indexCounter += 1;
      return indexCounter;
    }

    function ariaBoolean(el, attr) {
      var val = el.getAttribute(attr);
      if (val === "true") return true;
      if (val === "false") return false;
      return undefined;
    }

    function fieldMeta(el) {
      var meta = {};
      if (el.name) meta.name = el.name;
      var ac = el.getAttribute("autocomplete");
      if (ac) meta.autocomplete = ac;
      var elType = (el.type || "").toLowerCase();
      if (elType === "checkbox" || elType === "radio") meta.checked = !!el.checked;
      if (el.maxLength >= 0) meta.maxLength = el.maxLength;
      var min = el.getAttribute("min"); if (min) meta.min = min;
      var max = el.getAttribute("max"); if (max) meta.max = max;
      var pattern = el.getAttribute("pattern"); if (pattern) meta.pattern = pattern;
      return meta;
    }

    function serializeInteractive(el, kind) {
      var base = {
        type: kind,
        context: contextOf(el),
        selector: selectorFor(el),
        index: nextIndex(el),
        role: text(el.getAttribute && el.getAttribute("role")),
        description: descriptionFor(el),
        ...visibilityState(el),
        disabled: disabled(el),
        ariaExpanded: ariaBoolean(el, "aria-expanded"),
        ariaPressed: ariaBoolean(el, "aria-pressed"),
        ariaSelected: ariaBoolean(el, "aria-selected"),
      };

      if (kind === "link") {
        return {
          ...base,
          text: text(el.textContent)?.slice(0, 100),
          href: text(el.href || el.getAttribute("href"))?.slice(0, 500),
        };
      }

      if (kind === "button") {
        return {
          ...base,
          text: text(el.textContent || el.value || el.getAttribute("aria-label") || "Button")?.slice(0, 100),
        };
      }

      if (kind === "select") {
        return {
          ...base,
          label: labelFor(el)?.slice(0, 100),
          value: text(el.value),
          options: Array.from(el.options || []).map(function(option) { return { label: text(option.textContent || option.value) || option.value, value: option.value }; }).filter(function(o) { return o.label || o.value; }).slice(0, 25),
          required: el.hasAttribute("required") || undefined,
          ...fieldMeta(el),
        };
      }

      if (kind === "textarea") {
        return {
          ...base,
          label: labelFor(el)?.slice(0, 100),
          placeholder: text(el.getAttribute("placeholder")),
          value: text(el.value),
          required: el.hasAttribute("required") || undefined,
          ...fieldMeta(el),
        };
      }

      var elType = (el.type || "").toLowerCase();
      return {
        ...base,
        label: labelFor(el)?.slice(0, 100),
        inputType: text(el.getAttribute("type")),
        placeholder: text(el.getAttribute("placeholder")),
        value: (elType === "password" || elType === "checkbox" || elType === "radio") ? undefined : text(el.value),
        required: el.hasAttribute("required") || undefined,
        ...fieldMeta(el),
      };
    }

    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .map((el) => {
        const headingText = text(el.textContent);
        if (!headingText) return null;
        return { level: Number.parseInt(el.tagName[1], 10), text: headingText };
      })
      .filter(Boolean);

    const navigation = [];
    document.querySelectorAll("nav a[href], [role='navigation'] a[href], header nav a[href]").forEach((el) => {
      if (!withinBudget()) return;
      const item = serializeInteractive(el, "link");
      if (!item.text || !item.href || item.href.startsWith("#")) return;
      item.context = "nav";
      navigation.push(item);
    });

    const seenNav = new Set();
    const dedupedNavigation = navigation.filter((item) => {
      if (seenNav.has(item.href)) return false;
      seenNav.add(item.href);
      return true;
    });

    const interactiveElements = [];
    document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button']").forEach((el) => {
      if (!withinBudget()) return;
      interactiveElements.push(serializeInteractive(el, "button"));
    });
    document.querySelectorAll("a[href]").forEach((el) => {
      if (!withinBudget()) return;
      const item = serializeInteractive(el, "link");
      if (!item.text || !item.href || item.href.startsWith("#") || item.context === "nav") return;
      interactiveElements.push(item);
    });
    document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']), select, textarea").forEach((el) => {
      if (!withinBudget()) return;
      const tag = el.tagName.toLowerCase();
      interactiveElements.push(
        serializeInteractive(el, tag === "select" ? "select" : tag === "textarea" ? "textarea" : "input"),
      );
    });

    function isSubmitControlForForm(el, form) {
      if (el instanceof HTMLButtonElement) {
        const type = text(el.getAttribute("type"))?.toLowerCase();
        return (!type || type === "submit") && el.form === form;
      }
      return el instanceof HTMLInputElement &&
        (el.type === "submit" || el.type === "image") &&
        el.form === form;
    }

    const forms = Array.from(document.querySelectorAll("form")).map((form) => {
      const fields = [];
      form.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='image']), select, textarea").forEach((el) => {
        const tag = el.tagName.toLowerCase();
        fields.push(
          serializeInteractive(el, tag === "select" ? "select" : tag === "textarea" ? "textarea" : "input"),
        );
      });
      Array.from(form.querySelectorAll("button, input[type='submit'], input[type='image']"))
        .filter((el) => isSubmitControlForForm(el, form))
        .forEach((el) => {
        fields.push(serializeInteractive(el, "button"));
      });
      return {
        id: text(form.id),
        action: text(form.getAttribute("action")),
        method: text(form.getAttribute("method")),
        fields,
      };
    });

    const landmarks = [];
    [
      "header, [role='banner']",
      "nav, [role='navigation']",
      "main, [role='main']",
      "aside, [role='complementary']",
      "footer, [role='contentinfo']",
      "article, [role='article']",
      "section, [role='region']",
      "[role='search']",
      "[role='form']",
      "dialog, [role='dialog'], [role='alertdialog']",
    ].forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        landmarks.push({
          role: text(el.getAttribute("role")) || el.tagName.toLowerCase(),
          label: text(el.getAttribute("aria-label")) || text(el.id),
          text: text(el.textContent)?.slice(0, 200),
        });
      });
    });

    // Extract JSON-LD as fallback when preload bridge is unavailable
    var jsonLd = [];
    try {
      document.querySelectorAll('script[type="application/ld+json"]').forEach(function(script) {
        try {
          var parsed = JSON.parse(script.textContent || "");
          if (Array.isArray(parsed)) {
            parsed.forEach(function(item) { if (item && typeof item === "object") jsonLd.push(item); });
          } else if (parsed && typeof parsed === "object") {
            jsonLd.push(parsed);
          }
        } catch (_e) {}
      });
    } catch (_e) {}

    // Extract meta tags as fallback
    var metaTags = {};
    try {
      var relevantPrefixes = ["og:", "article:", "product:", "recipe:", "twitter:"];
      document.querySelectorAll("meta[name], meta[property], meta[itemprop]").forEach(function(meta) {
        var key = meta.getAttribute("property") || meta.getAttribute("name") || meta.getAttribute("itemprop") || "";
        var value = meta.getAttribute("content") || "";
        if (key && value) metaTags[key] = value;
      });
      var canonical = document.querySelector('link[rel="canonical"]');
      if (canonical && canonical.getAttribute("href")) metaTags["canonical"] = canonical.getAttribute("href");
    } catch (_e) {}

    return {
      title: document.title,
      content: getCleanBodyText(),
      htmlContent: "",
      byline: "",
      excerpt: "",
      url: window.location.href,
      headings,
      navigation: dedupedNavigation,
      interactiveElements,
      forms,
      viewport: viewportSnapshot(),
      overlays: overlays.map(({ element, zIndex, ...overlay }) => overlay),
      dormantOverlays: [],
      landmarks,
      jsonLd: jsonLd,
      metaTags: metaTags,
    };
  })()
`;

const SAFE_EXTRACTION_SCRIPT = String.raw`
  (function() {
    function getCleanBodyText() {
      var removed = [];
      document
        .querySelectorAll('.__vessel-highlight-label[data-vessel-highlight]')
        .forEach(function(label) {
          var parent = label.parentNode;
          if (!parent) return;
          removed.push({ label: label, parent: parent, nextSibling: label.nextSibling });
          parent.removeChild(label);
        });
      try {
        return document.body?.innerText || document.documentElement?.innerText || "";
      } finally {
        for (var i = removed.length - 1; i >= 0; i--) {
          var entry = removed[i];
          entry.parent.insertBefore(entry.label, entry.nextSibling);
        }
      }
    }

    function text(value) {
      const trimmed = value == null ? "" : String(value).trim();
      return trimmed || undefined;
    }

    function labelFor(el) {
      const aria = text(el.getAttribute && el.getAttribute("aria-label"));
      if (aria) return aria;
      const placeholder = text(el.getAttribute && el.getAttribute("placeholder"));
      if (placeholder) return placeholder;
      if (el.id) {
        const directLabel = document.querySelector('label[for="' + String(el.id).replace(/["\\]/g, "\\$&") + '"]');
        const labelText = text(directLabel && directLabel.textContent);
        if (labelText) return labelText;
      }
      return text(el.textContent);
    }

    let indexCounter = 0;
    function nextIndex() {
      indexCounter += 1;
      return indexCounter;
    }

    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .map((el) => {
        const headingText = text(el.textContent);
        if (!headingText) return null;
        return { level: Number.parseInt(el.tagName[1], 10), text: headingText };
      })
      .filter(Boolean);

    const navigation = Array.from(document.querySelectorAll("nav a[href], [role='navigation'] a[href], header nav a[href]"))
      .map((el) => {
        const href = text(el.href || el.getAttribute("href"));
        const linkText = text(el.textContent);
        if (!href || href.startsWith("#") || !linkText) return null;
        return {
          type: "link",
          text: linkText.slice(0, 100),
          href: href.slice(0, 500),
          context: "nav",
          index: nextIndex(),
          visible: true,
          disabled: false,
        };
      })
      .filter(Boolean);

    const interactiveElements = [];
    Array.from(document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button']"))
      .forEach((el) => {
        interactiveElements.push({
          type: "button",
          text: text(el.textContent || el.value || el.getAttribute("aria-label") || "Button")?.slice(0, 100),
          index: nextIndex(),
          visible: true,
          disabled: !!(el.hasAttribute && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true")),
        });
      });

    Array.from(document.querySelectorAll("a[href]")).forEach((el) => {
      const href = text(el.href || el.getAttribute("href"));
      const linkText = text(el.textContent);
      if (!href || href.startsWith("#") || !linkText) return;
      interactiveElements.push({
        type: "link",
        text: linkText.slice(0, 100),
        href: href.slice(0, 500),
        index: nextIndex(),
        visible: true,
        disabled: false,
      });
    });

    Array.from(document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']), select, textarea"))
      .forEach((el) => {
        const tag = el.tagName.toLowerCase();
        var elType = (el.type || "").toLowerCase();
        interactiveElements.push({
          type: tag === "select" ? "select" : tag === "textarea" ? "textarea" : "input",
          label: labelFor(el)?.slice(0, 100),
          inputType: text(el.getAttribute && el.getAttribute("type")),
          placeholder: text(el.getAttribute && el.getAttribute("placeholder")),
          value: tag === "select" ? text(el.value) : (elType === "password" || elType === "checkbox" || elType === "radio") ? undefined : text(el.value),
          options: tag === "select"
            ? Array.from(el.options || []).map(function(option) { return { label: text(option.textContent || option.value) || option.value, value: option.value }; }).filter(function(o) { return o.label || o.value; }).slice(0, 25)
            : undefined,
          required: !!(el.hasAttribute && el.hasAttribute("required")) || undefined,
          index: nextIndex(),
          visible: true,
          disabled: !!(el.hasAttribute && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true")),
          name: el.name || undefined,
          autocomplete: text(el.getAttribute && el.getAttribute("autocomplete")),
          checked: (elType === "checkbox" || elType === "radio") ? !!el.checked : undefined,
        });
      });

    const forms = Array.from(document.querySelectorAll("form")).map((form) => ({
      id: text(form.id),
      action: text(form.getAttribute("action")),
      method: text(form.getAttribute("method")),
      fields: [],
    }));

    return {
      title: document.title || "",
      content: getCleanBodyText(),
      htmlContent: "",
      byline: "",
      excerpt: "",
      url: window.location.href || "",
      headings,
      navigation,
      interactiveElements,
      forms,
      viewport: {
        width: window.innerWidth || document.documentElement?.clientWidth || 0,
        height: window.innerHeight || document.documentElement?.clientHeight || 0,
        scrollX: 0,
        scrollY: 0,
      },
      overlays: [],
      dormantOverlays: [],
      landmarks: [],
    };
  })()
`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EXECUTE_SCRIPT_TIMEOUT_MS = 3000;

async function waitForDomReady(
  webContents: WebContents,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const readyState = await executeScript(
      webContents,
      String.raw`
      (function() {
        return document.readyState || "";
      })()
    `,
    );

    if (readyState === "interactive" || readyState === "complete") {
      return;
    }

    await delay(75);
  }
}

async function executeScript(
  webContents: WebContents,
  script: string,
): Promise<unknown> {
  if (webContents.isDestroyed()) {
    return null;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      webContents.executeJavaScript(script),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), EXECUTE_SCRIPT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (typeof timer !== "undefined" && timer) {
      clearTimeout(timer);
    }
  }
}

function bestString(values: Array<unknown>): string {
  return (
    values
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
      .sort((left, right) => right.length - left.length)[0] || ""
  );
}

function bestArray<T>(values: Array<unknown>): T[] {
  return (
    values
      .filter((value): value is T[] => Array.isArray(value))
      .sort((left, right) => right.length - left.length)[0] || []
  );
}

function mergeObjects<T extends Record<string, unknown>>(
  values: Array<unknown>,
): T {
  return values
    .filter(
      (value): value is T =>
        Boolean(value) && typeof value === "object" && !Array.isArray(value),
    )
    .reduce<T>((acc, value) => ({ ...acc, ...value }), {} as T);
}

function isMeaningfullyEmpty(page: PageContent): boolean {
  return !(
    page.title.trim() ||
    page.url.trim() ||
    page.content.trim() ||
    page.headings.length ||
    page.navigation.length ||
    page.interactiveElements.length ||
    page.forms.length ||
    page.landmarks.length
  );
}

function mergePageContent(
  candidates: unknown[],
  webContents: WebContents,
): PageContent {
  const pages = candidates
    .map((candidate) => normalizePageContent(candidate))
    .filter((page) => !isMeaningfullyEmpty(page));

  if (pages.length === 0) {
    return {
      ...EMPTY_PAGE_CONTENT,
      title: webContents.getTitle() || "",
      url: webContents.getURL() || "",
    };
  }

  // The first candidate (preload) is authoritative for interactive elements
  // because its indices match the content-script's elementSelectors map used
  // by resolveElementSelector(). Other candidates may supply richer text content.
  const preload = pages[0];
  const hasPreloadInteractives =
    preload.interactiveElements.length > 0 ||
    preload.navigation.length > 0 ||
    preload.forms.length > 0;

  const mergedBase = {
    title: bestString(pages.map((page) => page.title)),
    content: bestString(pages.map((page) => page.content)),
    htmlContent: bestString(pages.map((page) => page.htmlContent)),
    byline: bestString(pages.map((page) => page.byline)),
    excerpt: bestString(pages.map((page) => page.excerpt)),
    url: bestString(pages.map((page) => page.url)),
    headings: bestArray(pages.map((page) => page.headings)),
    // Use preload's interactive data when available to keep indices consistent
    navigation: hasPreloadInteractives
      ? preload.navigation
      : bestArray(pages.map((page) => page.navigation)),
    interactiveElements: hasPreloadInteractives
      ? preload.interactiveElements
      : bestArray(pages.map((page) => page.interactiveElements)),
    forms: hasPreloadInteractives
      ? preload.forms
      : bestArray(pages.map((page) => page.forms)),
    viewport:
      pages.find((page) => page.viewport.width > 0 || page.viewport.height > 0)
        ?.viewport ?? EMPTY_PAGE_CONTENT.viewport,
    overlays: bestArray(pages.map((page) => page.overlays)),
    dormantOverlays: bestArray(pages.map((page) => page.dormantOverlays)),
    landmarks: bestArray(pages.map((page) => page.landmarks)),
    jsonLd: bestArray(pages.map((page) => page.jsonLd ?? [])),
    microdata: bestArray(pages.map((page) => page.microdata ?? [])),
    rdfa: bestArray(pages.map((page) => page.rdfa ?? [])),
    metaTags: mergeObjects<Record<string, string>>(
      pages.map((page) => page.metaTags ?? {}),
    ),
    structuredData: bestArray(pages.map((page) => page.structuredData ?? [])),
  };

  const normalizedStructuredData =
    mergedBase.structuredData.length > 0
      ? mergedBase.structuredData
      : extractStructuredDataFromJsonLd(
          mergedBase.jsonLd,
          mergedBase.microdata,
          mergedBase.rdfa,
          mergedBase.metaTags,
          mergedBase.title,
          mergedBase.url,
          mergedBase.excerpt,
          mergedBase.byline,
          mergedBase.headings,
        );

  const pageIssues = detectPageIssues({
    url: mergedBase.url || webContents.getURL() || "",
    title: mergedBase.title || webContents.getTitle() || "",
    content: mergedBase.content,
    excerpt: mergedBase.excerpt,
    headings: mergedBase.headings,
    metaTags: mergedBase.metaTags,
  });

  return {
    ...mergedBase,
    structuredData: normalizedStructuredData,
    pageIssues,
    title: mergedBase.title || webContents.getTitle() || "",
    url: mergedBase.url || webContents.getURL() || "",
  };
}

const EXTRACT_TIMEOUT_BASE_MS = 12000;
const EXTRACT_TIMEOUT_MAX_MS = 20000;

/** Estimate extraction timeout based on page complexity. */
async function estimateExtractionTimeout(webContents: WebContents): Promise<number> {
  try {
    const elementCount = await executeScript(
      webContents,
      `(function() { try { return document.querySelectorAll('*').length; } catch { return 0; } })()`,
    );
    if (typeof elementCount === "number" && elementCount > 5000) {
      // Heavy page — scale timeout: +1s per 2000 elements beyond 5000, capped
      const extra = Math.min(
        EXTRACT_TIMEOUT_MAX_MS - EXTRACT_TIMEOUT_BASE_MS,
        Math.ceil((elementCount - 5000) / 2000) * 1000,
      );
      return EXTRACT_TIMEOUT_BASE_MS + extra;
    }
  } catch {
    // Can't estimate — use base
  }
  return EXTRACT_TIMEOUT_BASE_MS;
}

async function extractContentInner(
  webContents: WebContents,
): Promise<PageContent> {
  await waitForDomReady(webContents);

  const [preloadResult, directResult, safeResult] = await Promise.all([
    executeScript(webContents, PRELOAD_EXTRACTION_SCRIPT),
    executeScript(webContents, DIRECT_EXTRACTION_SCRIPT),
    executeScript(webContents, SAFE_EXTRACTION_SCRIPT),
  ]);

  return mergePageContent(
    [preloadResult, directResult, safeResult],
    webContents,
  );
}

export async function extractContent(
  webContents: WebContents,
): Promise<PageContent> {
  try {
    const timeoutMs = await estimateExtractionTimeout(webContents);
    return await Promise.race([
      extractContentInner(webContents),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("extractContent timeout")),
          timeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    const url = webContents.getURL() || "";
    let domain = "unknown";
    try { domain = new URL(url).hostname; } catch { /* invalid URL */ }
    const reason = err instanceof Error ? err.message : "unknown";
    trackExtractionFailed(domain, reason);
    return {
      ...EMPTY_PAGE_CONTENT,
      title: webContents.getTitle() || "",
      url,
    };
  }
}

function normalizePageContent(value: unknown): PageContent {
  if (!value || typeof value !== "object") {
    return { ...EMPTY_PAGE_CONTENT };
  }

  const page = value as Partial<PageContent>;
  return {
    title: typeof page.title === "string" ? page.title : "",
    content: typeof page.content === "string" ? page.content : "",
    htmlContent: typeof page.htmlContent === "string" ? page.htmlContent : "",
    byline: typeof page.byline === "string" ? page.byline : "",
    excerpt: typeof page.excerpt === "string" ? page.excerpt : "",
    url: typeof page.url === "string" ? page.url : "",
    headings: Array.isArray(page.headings) ? page.headings : [],
    navigation: Array.isArray(page.navigation) ? page.navigation : [],
    interactiveElements: Array.isArray(page.interactiveElements)
      ? page.interactiveElements
      : [],
    forms: Array.isArray(page.forms) ? page.forms : [],
    viewport:
      page.viewport &&
      typeof page.viewport === "object" &&
      typeof page.viewport.width === "number" &&
      typeof page.viewport.height === "number" &&
      typeof page.viewport.scrollX === "number" &&
      typeof page.viewport.scrollY === "number"
        ? page.viewport
        : EMPTY_PAGE_CONTENT.viewport,
    overlays: Array.isArray(page.overlays) ? page.overlays : [],
    dormantOverlays: Array.isArray(page.dormantOverlays)
      ? page.dormantOverlays
      : [],
    landmarks: Array.isArray(page.landmarks) ? page.landmarks : [],
    jsonLd: Array.isArray(page.jsonLd) ? page.jsonLd : [],
    microdata: Array.isArray(page.microdata) ? page.microdata : [],
    rdfa: Array.isArray(page.rdfa) ? page.rdfa : [],
    metaTags:
      page.metaTags &&
      typeof page.metaTags === "object" &&
      !Array.isArray(page.metaTags)
        ? (page.metaTags as Record<string, string>)
        : {},
    structuredData: Array.isArray(page.structuredData)
      ? page.structuredData
      : [],
    pageIssues: Array.isArray(page.pageIssues) ? page.pageIssues : [],
  };
}
