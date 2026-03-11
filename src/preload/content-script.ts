// Content script preload - injected into web page views
// Provides readability-based content extraction + structured context for AI agents

import { contextBridge } from "electron";
import { Readability } from "@mozilla/readability";
import {
  generateStableSelector,
  escapeSelectorValue,
} from "../shared/dom/selectors";

interface InteractiveElement {
  type: "button" | "link" | "input" | "select" | "textarea";
  text?: string;
  label?: string;
  href?: string;
  inputType?: string;
  placeholder?: string;
  required?: boolean;
  context?: string;
  selector?: string;
  index?: number;
  role?: string;
  description?: string;
  value?: string;
  options?: string[];
  visible?: boolean;
  inViewport?: boolean;
  fullyInViewport?: boolean;
  obscured?: boolean;
  blockedByOverlay?: boolean;
  disabled?: boolean;
}

interface HeadingStructure {
  level: number;
  text: string;
}

interface PageContent {
  title: string;
  content: string;
  htmlContent: string;
  byline: string;
  excerpt: string;
  url: string;
  headings: HeadingStructure[];
  navigation: InteractiveElement[];
  interactiveElements: InteractiveElement[];
  forms: Array<{
    id?: string;
    action?: string;
    method?: string;
    fields: InteractiveElement[];
  }>;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  overlays: Array<{
    type: "dialog" | "modal" | "overlay";
    role?: string;
    label?: string;
    selector?: string;
    text?: string;
    blocksInteraction?: boolean;
  }>;
  dormantOverlays: Array<{
    type: "dialog" | "modal" | "overlay";
    role?: string;
    label?: string;
    selector?: string;
    text?: string;
  }>;
  landmarks: Array<{
    role: string;
    label?: string;
    text?: string;
  }>;
}

interface OverlayCandidate {
  element: HTMLElement;
  type: "dialog" | "modal" | "overlay";
  role?: string;
  label?: string;
  selector?: string;
  text?: string;
  blocksInteraction?: boolean;
  zIndex: number;
}

let elementIndex = 0;
const elementSelectors: Record<number, string> = {};
let indexedElements = new WeakMap<Element, number>();
let activeOverlays: OverlayCandidate[] = [];

function generateSelector(el: Element): string {
  return generateStableSelector(el);
}

function assignIndex(el: Element): number {
  const existing = indexedElements.get(el);
  if (existing != null) return existing;
  elementIndex += 1;
  elementSelectors[elementIndex] = generateSelector(el);
  indexedElements.set(el, elementIndex);
  return elementIndex;
}

function getNodeTextByIds(ids: string | null): string | undefined {
  if (!ids) return undefined;
  const text = ids
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() || "")
    .filter(Boolean)
    .join(" ")
    .trim();
  return text || undefined;
}

function getTrimmedText(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

function isElementVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  const style = window.getComputedStyle(el);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isInViewportRect(rect: DOMRect): boolean {
  const viewportWidth =
    window.innerWidth || document.documentElement?.clientWidth || 0;
  const viewportHeight =
    window.innerHeight || document.documentElement?.clientHeight || 0;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < viewportHeight &&
    rect.left < viewportWidth
  );
}

function isFullyInViewportRect(rect: DOMRect): boolean {
  const viewportWidth =
    window.innerWidth || document.documentElement?.clientWidth || 0;
  const viewportHeight =
    window.innerHeight || document.documentElement?.clientHeight || 0;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= viewportHeight &&
    rect.right <= viewportWidth
  );
}

function parseZIndex(style: CSSStyleDeclaration): number {
  const value = Number.parseInt(style.zIndex, 10);
  return Number.isFinite(value) ? value : 0;
}

function getViewportCenterCoverage(rect: DOMRect): boolean {
  const viewportWidth =
    window.innerWidth || document.documentElement?.clientWidth || 0;
  const viewportHeight =
    window.innerHeight || document.documentElement?.clientHeight || 0;
  const centerX = viewportWidth / 2;
  const centerY = viewportHeight / 2;
  return (
    rect.left <= centerX &&
    rect.right >= centerX &&
    rect.top <= centerY &&
    rect.bottom >= centerY
  );
}

function getOverlayLabel(el: HTMLElement): string | undefined {
  return (
    getTrimmedText(el.getAttribute("aria-label")) ||
    getNodeTextByIds(el.getAttribute("aria-labelledby")) ||
    getTrimmedText(el.id) ||
    undefined
  );
}

function getOverlayType(
  el: HTMLElement,
): "dialog" | "modal" | "overlay" | null {
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

function detectOverlays(): OverlayCandidate[] {
  if (!document.body) return [];

  const viewportWidth =
    window.innerWidth || document.documentElement?.clientWidth || 0;
  const viewportHeight =
    window.innerHeight || document.documentElement?.clientHeight || 0;
  const viewportArea = Math.max(1, viewportWidth * viewportHeight);
  const overlays: OverlayCandidate[] = [];
  const seen = new Set<HTMLElement>();

  Array.from(document.body.querySelectorAll("*")).forEach((node) => {
    if (!(node instanceof HTMLElement) || seen.has(node)) return;
    if (!isElementVisible(node)) return;

    const style = window.getComputedStyle(node);
    if (style.pointerEvents === "none") return;

    const rect = node.getBoundingClientRect();
    if (!isInViewportRect(rect)) return;

    const position = style.position;
    const zIndex = parseZIndex(style);
    const areaRatio = (rect.width * rect.height) / viewportArea;
    const overlayType = getOverlayType(node);
    const dialogLike = overlayType === "dialog" || overlayType === "modal";
    const blockingSurface =
      (position === "fixed" || position === "sticky") &&
      zIndex >= 10 &&
      areaRatio >= 0.3 &&
      getViewportCenterCoverage(rect);

    if (!dialogLike && !blockingSurface) return;

    seen.add(node);
    overlays.push({
      element: node,
      type: overlayType ?? "overlay",
      role: getTrimmedText(node.getAttribute("role")) || undefined,
      label: getOverlayLabel(node),
      selector: generateSelector(node),
      text: getTrimmedText(node.textContent)?.slice(0, 160),
      blocksInteraction: dialogLike || blockingSurface,
      zIndex,
    });
  });

  return overlays.sort((a, b) => {
    if ((a.blocksInteraction ? 1 : 0) !== (b.blocksInteraction ? 1 : 0)) {
      return (b.blocksInteraction ? 1 : 0) - (a.blocksInteraction ? 1 : 0);
    }
    return b.zIndex - a.zIndex;
  });
}

function isLikelyDormantOverlay(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  const role = getTrimmedText(el.getAttribute("role")) || "";
  const attrs = [
    el.id,
    el.className,
    el.getAttribute("data-testid"),
    el.getAttribute("data-test"),
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.getAttribute("data-module-name"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const text = getTrimmedText(el.textContent)?.toLowerCase() || "";

  if (
    tag === "dialog" ||
    role === "dialog" ||
    role === "alertdialog" ||
    el.getAttribute("aria-modal") === "true"
  ) {
    return true;
  }

  return /cookie|consent|privacy|gdpr|ccpa|onetrust|ot-sdk|trustarc|didomi|sp_message|qc-cmp|cmp|newsletter|subscribe/.test(
    `${attrs} ${text.slice(0, 200)}`,
  );
}

function detectDormantOverlays(): Array<{
  type: "dialog" | "modal" | "overlay";
  role?: string;
  label?: string;
  selector?: string;
  text?: string;
}> {
  if (!document.body) return [];

  const seen = new Set<string>();
  const matches: Array<{
    type: "dialog" | "modal" | "overlay";
    role?: string;
    label?: string;
    selector?: string;
    text?: string;
  }> = [];

  Array.from(document.body.querySelectorAll("*")).forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    if (isElementVisible(node)) return;
    if (!isLikelyDormantOverlay(node)) return;

    const selector = generateSelector(node);
    if (!selector || seen.has(selector)) return;
    seen.add(selector);

    matches.push({
      type: getOverlayType(node) ?? "overlay",
      role: getTrimmedText(node.getAttribute("role")) || undefined,
      label: getOverlayLabel(node),
      selector,
      text: getTrimmedText(node.textContent)?.slice(0, 160),
    });
  });

  return matches.slice(0, 10);
}

function samplePointForRect(rect: DOMRect): { x: number; y: number } | null {
  if (!isInViewportRect(rect)) return null;
  const viewportWidth =
    window.innerWidth || document.documentElement?.clientWidth || 0;
  const viewportHeight =
    window.innerHeight || document.documentElement?.clientHeight || 0;
  const maxX = Math.max(0, viewportWidth - 1);
  const maxY = Math.max(0, viewportHeight - 1);
  return {
    x: Math.min(maxX, Math.max(0, rect.left + rect.width / 2)),
    y: Math.min(maxY, Math.max(0, rect.top + rect.height / 2)),
  };
}

function getVisibilityState(
  el: Element,
): Pick<
  InteractiveElement,
  "visible" | "inViewport" | "fullyInViewport" | "obscured" | "blockedByOverlay"
> {
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
  const visible = isElementVisible(el);
  const inViewport = visible && isInViewportRect(rect);
  const fullyInViewport = visible && isFullyInViewportRect(rect);
  let obscured = false;
  let blockedByOverlay = false;

  if (inViewport) {
    const point = samplePointForRect(rect);
    if (point) {
      const topElement = document.elementFromPoint(point.x, point.y);
      if (
        topElement &&
        topElement !== el &&
        !el.contains(topElement) &&
        !(topElement instanceof HTMLElement && topElement.contains(el))
      ) {
        obscured = true;
        blockedByOverlay = activeOverlays.some(
          (overlay) =>
            overlay.blocksInteraction &&
            overlay.element.contains(topElement) &&
            !overlay.element.contains(el),
        );
      }
    }
  }

  return {
    visible,
    inViewport,
    fullyInViewport,
    obscured,
    blockedByOverlay,
  };
}

function getViewportSnapshot() {
  const scrollingElement =
    document.scrollingElement || document.documentElement || document.body;
  const scrollXCandidates = [
    window.scrollX,
    window.pageXOffset,
    window.visualViewport?.pageLeft,
    scrollingElement?.scrollLeft,
    document.documentElement?.scrollLeft,
    document.body?.scrollLeft,
  ].filter((value): value is number => typeof value === "number");
  const scrollYCandidates = [
    window.scrollY,
    window.pageYOffset,
    window.visualViewport?.pageTop,
    scrollingElement?.scrollTop,
    document.documentElement?.scrollTop,
    document.body?.scrollTop,
  ].filter((value): value is number => typeof value === "number");

  return {
    width: window.innerWidth || document.documentElement?.clientWidth || 0,
    height: window.innerHeight || document.documentElement?.clientHeight || 0,
    scrollX: Math.max(0, ...scrollXCandidates),
    scrollY: Math.max(0, ...scrollYCandidates),
  };
}

function isElementDisabled(el: Element): boolean {
  return (
    el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true"
  );
}

function getElementContext(el: Element): string {
  let parent = el.parentElement;
  while (parent) {
    const tag = parent.tagName.toLowerCase();
    const role = parent.getAttribute("role");

    if (tag === "nav" || role === "navigation") return "nav";
    if (tag === "header" || role === "banner") return "header";
    if (tag === "main" || role === "main") return "main";
    if (tag === "footer" || role === "contentinfo") return "footer";
    if (tag === "aside" || role === "complementary") return "sidebar";
    if (tag === "article" || role === "article") return "article";
    if (tag === "dialog" || role === "dialog" || role === "alertdialog") {
      return "dialog";
    }
    if (tag === "form") return `form${parent.id ? `#${parent.id}` : ""}`;

    parent = parent.parentElement;
  }

  return "content";
}

function getInputLabel(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): string | undefined {
  if (el.id) {
    const label = document.querySelector(
      `label[for="${escapeSelectorValue(el.id)}"]`,
    );
    if (label) return getTrimmedText(label.textContent);
  }

  const parentLabel = el.closest("label");
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("input, select, textarea").forEach((input) => {
      input.remove();
    });
    const text = getTrimmedText(clone.textContent);
    if (text) return text;
  }

  return (
    getTrimmedText(el.getAttribute("aria-label")) ||
    getNodeTextByIds(el.getAttribute("aria-labelledby")) ||
    getTrimmedText(el.getAttribute("placeholder")) ||
    undefined
  );
}

function getElementRole(el: Element): string | undefined {
  return (
    getTrimmedText(el.getAttribute("role")) ||
    (el.tagName.toLowerCase() === "a"
      ? "link"
      : el.tagName.toLowerCase() === "button"
        ? "button"
        : undefined)
  );
}

function getElementDescription(el: Element): string | undefined {
  return (
    getTrimmedText(el.getAttribute("aria-description")) ||
    getNodeTextByIds(el.getAttribute("aria-describedby")) ||
    getTrimmedText(el.getAttribute("title")) ||
    undefined
  );
}

function getElementValue(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): string | undefined {
  if (el instanceof HTMLSelectElement) {
    return getTrimmedText(el.value);
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.type === "password") return undefined;
    if (el.type === "checkbox" || el.type === "radio") {
      return el.checked ? "checked" : "unchecked";
    }
    return getTrimmedText(el.value);
  }
  return undefined;
}

function getSelectOptions(el: HTMLSelectElement): string[] | undefined {
  const options = Array.from(el.options)
    .map((option) => option.textContent?.trim() || option.value.trim())
    .filter(Boolean)
    .slice(0, 25);
  return options.length > 0 ? options : undefined;
}

function buildBaseMetadata(
  el: Element,
): Pick<
  InteractiveElement,
  | "context"
  | "selector"
  | "index"
  | "role"
  | "description"
  | "visible"
  | "inViewport"
  | "fullyInViewport"
  | "obscured"
  | "blockedByOverlay"
  | "disabled"
> {
  return {
    context: getElementContext(el),
    selector: generateSelector(el),
    index: assignIndex(el),
    role: getElementRole(el),
    description: getElementDescription(el),
    ...getVisibilityState(el),
    disabled: isElementDisabled(el),
  };
}

function extractHeadings(): HeadingStructure[] {
  return Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .map((el) => {
      const text = el.textContent?.trim() || "";
      if (!text) return null;
      return {
        level: Number.parseInt(el.tagName[1], 10),
        text,
      };
    })
    .filter((value): value is HeadingStructure => Boolean(value));
}

function extractNavigation(): InteractiveElement[] {
  const navigation: InteractiveElement[] = [];

  document
    .querySelectorAll(
      'nav, [role="navigation"], header nav, [role="banner"] nav',
    )
    .forEach((nav) => {
      nav.querySelectorAll("a[href]").forEach((link) => {
        const anchor = link as HTMLAnchorElement;
        const text = anchor.textContent?.trim();
        if (!text || anchor.getAttribute("href")?.startsWith("#")) return;

        navigation.push({
          type: "link",
          text: text.slice(0, 100),
          href: anchor.href.slice(0, 500),
          ...buildBaseMetadata(anchor),
          context: "nav",
        });
      });
    });

  const seen = new Set<string>();
  return navigation.filter((item) => {
    if (!item.href || seen.has(item.href)) return false;
    seen.add(item.href);
    return true;
  });
}

function extractInteractiveElements(): InteractiveElement[] {
  const elements: InteractiveElement[] = [];

  document
    .querySelectorAll(
      'button, [role="button"], input[type="submit"], input[type="button"]',
    )
    .forEach((btn) => {
      const input = btn as HTMLInputElement;
      const text =
        btn.textContent?.trim() ||
        input.value ||
        btn.getAttribute("aria-label") ||
        "Button";

      elements.push({
        type: "button",
        text: text.slice(0, 100),
        ...buildBaseMetadata(btn),
      });
    });

  document.querySelectorAll("a[href]").forEach((link) => {
    const anchor = link as HTMLAnchorElement;
    const text = anchor.textContent?.trim();
    if (!text || anchor.getAttribute("href")?.startsWith("#")) return;
    const context = getElementContext(anchor);
    if (context === "nav") return;

    elements.push({
      type: "link",
      text: text.slice(0, 100),
      href: anchor.href.slice(0, 500),
      ...buildBaseMetadata(anchor),
      context,
    });
  });

  document
    .querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea',
    )
    .forEach((input) => {
      const element = input as
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement;
      const tag = input.tagName.toLowerCase();

      elements.push({
        type:
          tag === "select"
            ? "select"
            : tag === "textarea"
              ? "textarea"
              : "input",
        label: getInputLabel(element)?.slice(0, 100),
        inputType: element.getAttribute("type") || undefined,
        placeholder: element.getAttribute("placeholder") || undefined,
        required: element.hasAttribute("required") || undefined,
        value: getElementValue(element),
        options:
          element instanceof HTMLSelectElement
            ? getSelectOptions(element)
            : undefined,
        ...buildBaseMetadata(input),
      });
    });

  return elements;
}

function extractForms(): Array<{
  id?: string;
  action?: string;
  method?: string;
  fields: InteractiveElement[];
}> {
  const forms: Array<{
    id?: string;
    action?: string;
    method?: string;
    fields: InteractiveElement[];
  }> = [];

  function isSubmitControlForForm(
    el: Element,
    form: HTMLFormElement,
  ): el is HTMLButtonElement | HTMLInputElement {
    if (el instanceof HTMLButtonElement) {
      const type = getTrimmedText(el.getAttribute("type"))?.toLowerCase();
      return (!type || type === "submit") && el.form === form;
    }

    return (
      el instanceof HTMLInputElement &&
      (el.type === "submit" || el.type === "image") &&
      el.form === form
    );
  }

  document.querySelectorAll("form").forEach((form) => {
    const fields: InteractiveElement[] = [];

    form
      .querySelectorAll(
        "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='image']), select, textarea",
      )
      .forEach((input) => {
        const element = input as
          | HTMLInputElement
          | HTMLSelectElement
          | HTMLTextAreaElement;
        const tag = input.tagName.toLowerCase();

        fields.push({
          type:
            tag === "select"
              ? "select"
              : tag === "textarea"
                ? "textarea"
                : "input",
          label: getInputLabel(element)?.slice(0, 100),
          inputType: element.getAttribute("type") || undefined,
          placeholder: element.getAttribute("placeholder") || undefined,
          required: element.hasAttribute("required") || undefined,
          value: getElementValue(element),
          options:
            element instanceof HTMLSelectElement
              ? getSelectOptions(element)
              : undefined,
          ...buildBaseMetadata(input),
        });
      });

    Array.from(
      document.querySelectorAll(
        "button, input[type='submit'], input[type='image']",
      ),
    )
      .filter((control) => isSubmitControlForForm(control, form))
      .forEach((btn) => {
        const input = btn as HTMLInputElement;
        const text =
          btn.textContent?.trim() ||
          input.value ||
          btn.getAttribute("aria-label") ||
          "Submit";
        fields.push({
          type: "button",
          text: text.slice(0, 100),
          ...buildBaseMetadata(btn),
        });
      });

    forms.push({
      id: form.id || undefined,
      action: form.getAttribute("action") || undefined,
      method: form.getAttribute("method") || undefined,
      fields,
    });
  });

  return forms;
}

function extractLandmarks(): Array<{
  role: string;
  label?: string;
  text?: string;
}> {
  const landmarks: Array<{ role: string; label?: string; text?: string }> = [];
  const selectors = [
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
  ];

  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const role =
        el.getAttribute("role") ||
        (tag === "header"
          ? "banner"
          : tag === "nav"
            ? "navigation"
            : tag === "main"
              ? "main"
              : tag === "aside"
                ? "complementary"
                : tag === "footer"
                  ? "contentinfo"
                  : tag === "article"
                    ? "article"
                    : tag === "section"
                      ? "region"
                      : tag === "dialog"
                        ? "dialog"
                        : "generic");
      landmarks.push({
        role,
        label:
          getTrimmedText(el.getAttribute("aria-label")) ||
          getNodeTextByIds(el.getAttribute("aria-labelledby")) ||
          getTrimmedText(el.id),
        text: getTrimmedText(el.textContent)?.slice(0, 200),
      });
    });
  });

  return landmarks;
}

function vesselExtractContent(): PageContent {
  const extractStructuredContent = (article?: {
    title?: string | null;
    textContent?: string | null;
    content?: string | null;
    byline?: string | null;
    excerpt?: string | null;
  }): PageContent => {
    activeOverlays = detectOverlays();

    return {
      title: article?.title || document.title,
      content: article?.textContent || document.body?.innerText || "",
      htmlContent: article?.content || "",
      byline: article?.byline || "",
      excerpt: article?.excerpt || "",
      url: window.location.href,
      headings: extractHeadings(),
      navigation: extractNavigation(),
      interactiveElements: extractInteractiveElements(),
      forms: extractForms(),
      viewport: getViewportSnapshot(),
      overlays: activeOverlays.map(
        ({ element: _element, zIndex: _zIndex, ...overlay }) => overlay,
      ),
      dormantOverlays: detectDormantOverlays(),
      landmarks: extractLandmarks(),
    };
  };

  try {
    elementIndex = 0;
    activeOverlays = [];
    Object.keys(elementSelectors).forEach(
      (key) => delete elementSelectors[key as any],
    );
    // WeakMap entries are GC'd automatically; no explicit clearing needed

    const documentClone = document.cloneNode(true) as Document;
    const reader = new Readability(documentClone);
    const article = reader.parse();
    return extractStructuredContent(article || undefined);
  } catch (error) {
    console.error("Vessel content extraction error:", error);
    return extractStructuredContent();
  }
}

function resolveElementSelector(index: number): string | null {
  // Only use the authoritative elementSelectors map — never fall back to DOM
  // order scanning, which uses a different element ordering than extraction.
  return elementSelectors[index] || null;
}

contextBridge.exposeInMainWorld("__vessel", {
  extractContent: vesselExtractContent,
  getElementSelector: resolveElementSelector,
});
