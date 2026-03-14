import type { WebContents } from "electron";
import type { PageContent } from "../../shared/types";
import { extractStructuredDataFromJsonLd } from "./structured-data";

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
  structuredData: [],
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
      return window.innerWidth || document.documentElement?.clientWidth || 0;
    }

    function viewportHeight() {
      return window.innerHeight || document.documentElement?.clientHeight || 0;
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

    function detectOverlays() {
      if (!document.body) return [];
      const viewportArea = Math.max(1, viewportWidth() * viewportHeight());
      const overlays = [];

      Array.from(document.body.querySelectorAll("*")).forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (!visible(node)) return;

        const style = window.getComputedStyle(node);
        if (style.pointerEvents === "none") return;

        const rect = node.getBoundingClientRect();
        if (!inViewport(rect)) return;

        const type = overlayType(node);
        const dialogLike = type === "dialog" || type === "modal";
        const areaRatio = (rect.width * rect.height) / viewportArea;
        const blocksInteraction = dialogLike ||
          ((style.position === "fixed" || style.position === "sticky") &&
            parseZIndex(style) >= 10 &&
            areaRatio >= 0.3 &&
            coversViewportCenter(rect));

        if (!blocksInteraction && type !== "dialog" && type !== "modal") return;

        overlays.push({
          element: node,
          type,
          role: text(node.getAttribute("role")),
          label: overlayLabel(node),
          selector: selectorFor(node),
          text: text(node.textContent)?.slice(0, 160),
          blocksInteraction,
          zIndex: parseZIndex(style),
        });
      });

      return overlays.sort((a, b) => {
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

    function serializeInteractive(el, kind) {
      const base = {
        type: kind,
        context: contextOf(el),
        selector: selectorFor(el),
        index: nextIndex(el),
        role: text(el.getAttribute && el.getAttribute("role")),
        description: descriptionFor(el),
        ...visibilityState(el),
        disabled: disabled(el),
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
          options: Array.from(el.options || []).map((option) => text(option.textContent || option.value)).filter(Boolean).slice(0, 25),
          required: el.hasAttribute("required") || undefined,
        };
      }

      if (kind === "textarea") {
        return {
          ...base,
          label: labelFor(el)?.slice(0, 100),
          placeholder: text(el.getAttribute("placeholder")),
          value: text(el.value),
          required: el.hasAttribute("required") || undefined,
        };
      }

      return {
        ...base,
        label: labelFor(el)?.slice(0, 100),
        inputType: text(el.getAttribute("type")),
        placeholder: text(el.getAttribute("placeholder")),
        value: ["password"].includes((el.type || "").toLowerCase()) ? undefined : text(el.value),
        required: el.hasAttribute("required") || undefined,
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
      interactiveElements.push(serializeInteractive(el, "button"));
    });
    document.querySelectorAll("a[href]").forEach((el) => {
      const item = serializeInteractive(el, "link");
      if (!item.text || !item.href || item.href.startsWith("#") || item.context === "nav") return;
      interactiveElements.push(item);
    });
    document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']), select, textarea").forEach((el) => {
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
      Array.from(document.querySelectorAll("button, input[type='submit'], input[type='image']"))
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

    return {
      title: document.title,
      content: document.body?.innerText || document.documentElement?.innerText || "",
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
    };
  })()
`;

const SAFE_EXTRACTION_SCRIPT = String.raw`
  (function() {
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
        interactiveElements.push({
          type: tag === "select" ? "select" : tag === "textarea" ? "textarea" : "input",
          label: labelFor(el)?.slice(0, 100),
          inputType: text(el.getAttribute && el.getAttribute("type")),
          placeholder: text(el.getAttribute && el.getAttribute("placeholder")),
          value: tag === "select" ? text(el.value) : ((el.type || "").toLowerCase() === "password" ? undefined : text(el.value)),
          options: tag === "select"
            ? Array.from(el.options || []).map((option) => text(option.textContent || option.value)).filter(Boolean).slice(0, 25)
            : undefined,
          required: !!(el.hasAttribute && el.hasAttribute("required")) || undefined,
          index: nextIndex(),
          visible: true,
          disabled: !!(el.hasAttribute && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true")),
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
      content: document.body?.innerText || document.documentElement?.innerText || "",
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

  try {
    return await webContents.executeJavaScript(script);
  } catch {
    return null;
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
    structuredData: bestArray(pages.map((page) => page.structuredData ?? [])),
  };

  const normalizedStructuredData =
    mergedBase.structuredData.length > 0
      ? mergedBase.structuredData
      : extractStructuredDataFromJsonLd(mergedBase.jsonLd);

  return {
    ...mergedBase,
    structuredData: normalizedStructuredData,
    title: mergedBase.title || webContents.getTitle() || "",
    url: mergedBase.url || webContents.getURL() || "",
  };
}

export async function extractContent(
  webContents: WebContents,
): Promise<PageContent> {
  try {
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
  } catch {
    return {
      ...EMPTY_PAGE_CONTENT,
      title: webContents.getTitle() || "",
      url: webContents.getURL() || "",
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
    structuredData: Array.isArray(page.structuredData)
      ? page.structuredData
      : [],
  };
}
