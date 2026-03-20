// Content script preload - injected into web page views
// Provides readability-based content extraction + structured context for AI agents

import { contextBridge, ipcRenderer } from "electron";
import { Readability } from "@mozilla/readability";
import {
  generateStableSelector,
  escapeSelectorValue,
} from "../shared/dom/selectors";

// Mirror of InteractiveElement in src/shared/types.ts — keep in sync
interface SelectOption {
  label: string;
  value: string;
}

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
  options?: SelectOption[];
  visible?: boolean;
  inViewport?: boolean;
  fullyInViewport?: boolean;
  obscured?: boolean;
  blockedByOverlay?: boolean;
  disabled?: boolean;
  name?: string;
  autocomplete?: string;
  ariaExpanded?: boolean;
  ariaPressed?: boolean;
  ariaSelected?: boolean;
  checked?: boolean;
  maxLength?: number;
  min?: string;
  max?: string;
  pattern?: string;
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
  jsonLd?: Record<string, unknown>[];
  microdata?: Record<string, unknown>[];
  rdfa?: Record<string, unknown>[];
  metaTags?: Record<string, string>;
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
// Direct element references for shadow DOM support — CSS selectors can't cross shadow boundaries
const indexedElementRefs: Record<number, Element> = {};
let activeOverlays: OverlayCandidate[] = [];

/**
 * querySelectorAll that pierces open Shadow DOM roots.
 * Finds elements inside web components (Internet Archive, etc.)
 * Uses a TreeWalker for efficient traversal with generous limits.
 */
const MAX_SHADOW_HOSTS = 150;
const MAX_SHADOW_DEPTH = 5;
const MAX_WALK_ELEMENTS = 10000;

function collectShadowRoots(root: ParentNode): ShadowRoot[] {
  const shadowRoots: ShadowRoot[] = [];
  let walked = 0;

  const walk = (node: ParentNode, depth: number) => {
    if (depth > MAX_SHADOW_DEPTH || shadowRoots.length >= MAX_SHADOW_HOSTS) return;
    const tw = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    let el: Node | null = tw.nextNode();
    while (el && walked < MAX_WALK_ELEMENTS && shadowRoots.length < MAX_SHADOW_HOSTS) {
      walked++;
      if ((el as Element).shadowRoot) {
        shadowRoots.push((el as Element).shadowRoot!);
        walk((el as Element).shadowRoot!, depth + 1);
      }
      el = tw.nextNode();
    }
  };

  walk(root, 0);
  return shadowRoots;
}

function deepQuerySelectorAll(selector: string, root: ParentNode = document): Element[] {
  const results: Element[] = [];
  root.querySelectorAll(selector).forEach((el) => results.push(el));

  for (const sr of collectShadowRoots(root)) {
    sr.querySelectorAll(selector).forEach((el) => results.push(el));
  }

  return results;
}

/**
 * Check whether an element lives inside a shadow DOM tree.
 */
function isInShadowDom(el: Element): boolean {
  return el.getRootNode() instanceof ShadowRoot;
}

/**
 * Build a shadow-piercing selector path for an element inside shadow DOM.
 * Format: "hostSelector >>> innerSelector >>> deeperSelector"
 * Falls back to null if a stable path can't be built.
 */
function generateShadowPiercingSelector(el: Element): string | null {
  const segments: string[] = [];
  let current: Element | null = el;

  while (current) {
    const rootNode = current.getRootNode();
    const innerSel = generateStableSelector(current);

    if (rootNode instanceof ShadowRoot) {
      segments.unshift(innerSel);
      current = rootNode.host;
    } else {
      // We've reached the document root
      segments.unshift(innerSel);
      break;
    }
  }

  if (segments.length <= 1) return null; // not actually in shadow DOM
  return segments.join(" >>> ");
}

/**
 * Resolve a shadow-piercing selector path ("host >>> inner >>> deeper")
 * by walking through shadow roots at each boundary.
 */
function resolveShadowSelector(selectorPath: string): Element | null {
  const segments = selectorPath.split(" >>> ").map((s) => s.trim());
  let scope: ParentNode = document;

  for (let i = 0; i < segments.length; i++) {
    const el = scope.querySelector(segments[i]);
    if (!el) return null;
    if (i < segments.length - 1) {
      // Need to enter shadow root for next segment
      if (!el.shadowRoot) return null;
      scope = el.shadowRoot;
    } else {
      return el;
    }
  }
  return null;
}

function generateSelector(el: Element): string {
  // For shadow DOM elements, try to build a piercing selector path
  if (isInShadowDom(el)) {
    const shadowPath = generateShadowPiercingSelector(el);
    if (shadowPath) return shadowPath;
  }
  return generateStableSelector(el);
}

function assignIndex(el: Element): number {
  const existing = indexedElements.get(el);
  if (existing != null) return existing;
  elementIndex += 1;
  elementSelectors[elementIndex] = generateSelector(el);
  indexedElementRefs[elementIndex] = el;
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

function pushPropertyValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!key || value == null) return;

  const existing = target[key];
  if (existing === undefined) {
    target[key] = value;
    return;
  }

  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }

  target[key] = [existing, value];
}

function getStructuredElementValue(el: Element): unknown {
  if (el instanceof HTMLMetaElement) {
    return getTrimmedText(el.content);
  }

  if (
    el instanceof HTMLAnchorElement ||
    el instanceof HTMLAreaElement ||
    el instanceof HTMLLinkElement
  ) {
    return getTrimmedText(el.href);
  }

  if (
    el instanceof HTMLImageElement ||
    el instanceof HTMLAudioElement ||
    el instanceof HTMLVideoElement ||
    el instanceof HTMLSourceElement ||
    el instanceof HTMLTrackElement ||
    el instanceof HTMLIFrameElement ||
    el instanceof HTMLEmbedElement
  ) {
    return getTrimmedText(el.src);
  }

  if (el instanceof HTMLObjectElement) {
    return getTrimmedText(el.data);
  }

  if (el instanceof HTMLDataElement || el instanceof HTMLMeterElement) {
    return getTrimmedText(el.value);
  }

  if (el instanceof HTMLTimeElement) {
    return getTrimmedText(el.dateTime) || getTrimmedText(el.textContent);
  }

  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    return getTrimmedText(el.value);
  }

  const contentAttr = getTrimmedText(el.getAttribute("content"));
  if (contentAttr) return contentAttr;

  const resourceAttr =
    getTrimmedText(el.getAttribute("resource")) ||
    getTrimmedText(el.getAttribute("href")) ||
    getTrimmedText(el.getAttribute("src")) ||
    getTrimmedText(el.getAttribute("datetime")) ||
    getTrimmedText(el.getAttribute("data"));
  if (resourceAttr) return resourceAttr;

  return getTrimmedText(el.textContent);
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
      return undefined; // checkbox/radio state exposed via dedicated checked boolean
    }
    return getTrimmedText(el.value);
  }
  return undefined;
}

function getSelectOptions(
  el: HTMLSelectElement,
): SelectOption[] | undefined {
  const options = Array.from(el.options)
    .map((option) => ({
      label: option.textContent?.trim() || option.value.trim(),
      value: option.value,
    }))
    .filter((o) => o.label || o.value)
    .slice(0, 25);
  return options.length > 0 ? options : undefined;
}

function getAriaBoolean(
  el: Element,
  attr: string,
): boolean | undefined {
  const val = el.getAttribute(attr);
  if (val === "true") return true;
  if (val === "false") return false;
  return undefined;
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
  | "ariaExpanded"
  | "ariaPressed"
  | "ariaSelected"
> {
  return {
    context: getElementContext(el),
    selector: generateSelector(el),
    index: assignIndex(el),
    role: getElementRole(el),
    description: getElementDescription(el),
    ...getVisibilityState(el),
    disabled: isElementDisabled(el),
    ariaExpanded: getAriaBoolean(el, "aria-expanded"),
    ariaPressed: getAriaBoolean(el, "aria-pressed"),
    ariaSelected: getAriaBoolean(el, "aria-selected"),
  };
}

function extractHeadings(): HeadingStructure[] {
  return deepQuerySelectorAll("h1, h2, h3, h4, h5, h6")
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

  deepQuerySelectorAll(
      'nav, [role="navigation"], header nav, [role="banner"] nav',
    )
    .forEach((nav) => {
      // Also pierce shadow DOM within nav elements
      deepQuerySelectorAll("a[href]", nav as ParentNode).forEach((link) => {
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

function getFieldMetadata(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): Partial<InteractiveElement> {
  const meta: Partial<InteractiveElement> = {};
  const name = el.name;
  if (name) meta.name = name;
  const autocomplete = el.getAttribute("autocomplete");
  if (autocomplete) meta.autocomplete = autocomplete;
  if (
    el instanceof HTMLInputElement &&
    (el.type === "checkbox" || el.type === "radio")
  ) {
    meta.checked = el.checked;
  }
  if (el instanceof HTMLInputElement) {
    if (el.maxLength >= 0) meta.maxLength = el.maxLength;
    const min = el.getAttribute("min");
    if (min) meta.min = min;
    const max = el.getAttribute("max");
    if (max) meta.max = max;
    const pattern = el.getAttribute("pattern");
    if (pattern) meta.pattern = pattern;
  }
  if (el instanceof HTMLTextAreaElement) {
    if (el.maxLength >= 0) meta.maxLength = el.maxLength;
  }
  return meta;
}

function extractInteractiveElements(): InteractiveElement[] {
  const elements: InteractiveElement[] = [];

  deepQuerySelectorAll(
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

  deepQuerySelectorAll("a[href]").forEach((link) => {
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

  deepQuerySelectorAll(
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
        ...getFieldMetadata(element),
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

  deepQuerySelectorAll("form").forEach((formEl) => {
    const form = formEl as HTMLFormElement;
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
          ...getFieldMetadata(element),
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
    deepQuerySelectorAll(selector).forEach((el) => {
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

function extractJsonLd(): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script.textContent || "");
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") results.push(item);
        }
      } else if (parsed && typeof parsed === "object") {
        results.push(parsed);
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return results;
}

function extractMetaTags(): Record<string, string> {
  const tags: Record<string, string> = {};

  document
    .querySelectorAll("meta[name], meta[property], meta[itemprop]")
    .forEach((el) => {
      if (!(el instanceof HTMLMetaElement)) return;
      const key =
        getTrimmedText(el.getAttribute("property")) ||
        getTrimmedText(el.getAttribute("name")) ||
        getTrimmedText(el.getAttribute("itemprop"));
      const value = getTrimmedText(el.content);
      if (!key || !value || tags[key]) return;

      if (
        key === "description" ||
        key === "author" ||
        key.startsWith("og:") ||
        key.startsWith("article:") ||
        key.startsWith("product:") ||
        key.startsWith("recipe:") ||
        key.startsWith("twitter:")
      ) {
        tags[key] = value;
      }
    });

  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical instanceof HTMLLinkElement && canonical.href) {
    tags.canonical = canonical.href;
  }

  return tags;
}

function extractMicrodata(): Record<string, unknown>[] {
  const serializeItem = (
    scope: HTMLElement,
    depth = 0,
  ): Record<string, unknown> | null => {
    if (depth > 3) return null;

    const item: Record<string, unknown> = {};
    const itemType = getTrimmedText(scope.getAttribute("itemtype"));
    const itemId = getTrimmedText(scope.getAttribute("itemid"));

    if (itemType) {
      const types = itemType.split(/\s+/).filter(Boolean);
      item["@type"] = types.length === 1 ? types[0] : types;
    }
    if (itemId) item["@id"] = itemId;

    scope.querySelectorAll("[itemprop]").forEach((node) => {
      if (!(node instanceof HTMLElement)) return;

      const nearestScope = node.closest("[itemscope]");
      const isNestedItemRoot = nearestScope === node && node.hasAttribute("itemscope");
      if (nearestScope !== scope && !isNestedItemRoot) {
        return;
      }
      if (isNestedItemRoot && node.parentElement?.closest("[itemscope]") !== scope) {
        return;
      }

      const propNames = (node.getAttribute("itemprop") || "")
        .split(/\s+/)
        .map((name) => name.trim())
        .filter(Boolean);
      if (propNames.length === 0) return;

      const value =
        node.hasAttribute("itemscope") && isNestedItemRoot
          ? serializeItem(node, depth + 1)
          : getStructuredElementValue(node);
      if (value == null) return;

      propNames.forEach((name) => pushPropertyValue(item, name, value));
    });

    return Object.keys(item).length > 0 ? item : null;
  };

  return Array.from(document.querySelectorAll("[itemscope]"))
    .filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && !node.hasAttribute("itemprop"),
    )
    .map((scope) => serializeItem(scope))
    .filter((item): item is Record<string, unknown> => item !== null);
}

function extractRdfa(): Record<string, unknown>[] {
  const serializeEntity = (
    scope: HTMLElement,
    depth = 0,
  ): Record<string, unknown> | null => {
    if (depth > 3) return null;

    const entity: Record<string, unknown> = {};
    const typeAttr = getTrimmedText(scope.getAttribute("typeof"));
    const about =
      getTrimmedText(scope.getAttribute("about")) ||
      getTrimmedText(scope.getAttribute("resource")) ||
      getTrimmedText(scope.getAttribute("href")) ||
      getTrimmedText(scope.getAttribute("src"));

    if (typeAttr) {
      const types = typeAttr.split(/\s+/).filter(Boolean);
      entity["@type"] = types.length === 1 ? types[0] : types;
    }
    if (about) entity["@id"] = about;

    scope.querySelectorAll("[property]").forEach((node) => {
      if (!(node instanceof HTMLElement)) return;

      const nearestTypedAncestor = node.closest("[typeof]");
      const isNestedEntityRoot =
        nearestTypedAncestor === node && node.hasAttribute("typeof");
      if (nearestTypedAncestor !== scope && !isNestedEntityRoot) {
        return;
      }
      if (
        isNestedEntityRoot &&
        node.parentElement?.closest("[typeof]") !== scope &&
        node !== scope
      ) {
        return;
      }

      const propNames = (node.getAttribute("property") || "")
        .split(/\s+/)
        .map((name) => name.trim())
        .filter(Boolean);
      if (propNames.length === 0) return;

      const value =
        node.hasAttribute("typeof") && isNestedEntityRoot && node !== scope
          ? serializeEntity(node, depth + 1)
          : getStructuredElementValue(node);
      if (value == null) return;

      propNames.forEach((name) => pushPropertyValue(entity, name, value));
    });

    return Object.keys(entity).length > 0 ? entity : null;
  };

  return Array.from(document.querySelectorAll("[typeof]"))
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map((scope) => serializeEntity(scope))
    .filter((entity): entity is Record<string, unknown> => entity !== null);
}

function withHighlightLabelsRemoved<T>(read: () => T): T {
  const labels = Array.from(
    document.querySelectorAll(".__vessel-highlight-label[data-vessel-highlight]"),
  ).filter((node): node is HTMLElement => node instanceof HTMLElement);

  const removed = labels
    .map((label) => {
      const parent = label.parentNode;
      if (!parent) return null;
      const nextSibling = label.nextSibling;
      parent.removeChild(label);
      return { label, parent, nextSibling };
    })
    .filter(
      (
        entry,
      ): entry is {
        label: HTMLElement;
        parent: Node;
        nextSibling: ChildNode | null;
      } => entry !== null,
    );

  try {
    return read();
  } finally {
    for (let i = removed.length - 1; i >= 0; i -= 1) {
      const { label, parent, nextSibling } = removed[i];
      parent.insertBefore(label, nextSibling);
    }
  }
}

function getVisiblePageText(): string {
  return withHighlightLabelsRemoved(
    () => document.body?.innerText || document.documentElement?.innerText || "",
  );
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

    // Use whichever content source is richer — Readability misses shadow DOM,
    // while innerText captures it but includes all visible text (nav, footers, etc.)
    const readabilityText = article?.textContent || "";
    const visibleText = getVisiblePageText();
    const content =
      readabilityText.length > visibleText.length * 0.3
        ? readabilityText
        : visibleText;

    return {
      title: article?.title || document.title,
      content,
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
      jsonLd: extractJsonLd(),
      microdata: extractMicrodata(),
      rdfa: extractRdfa(),
      metaTags: extractMetaTags(),
    };
  };

  try {
    elementIndex = 0;
    activeOverlays = [];
    Object.keys(elementSelectors).forEach(
      (key) => delete elementSelectors[key as any],
    );
    Object.keys(indexedElementRefs).forEach(
      (key) => delete indexedElementRefs[key as any],
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

/**
 * Interact with an element by index — works even for shadow DOM elements
 * where CSS selectors fail. Returns a result string.
 */
function interactByIndex(
  index: number,
  action: "click" | "focus" | "value",
  value?: string,
): string {
  const el = indexedElementRefs[index];
  if (!el || !(el instanceof HTMLElement)) {
    return "Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh.";
  }
  if (action === "click") {
    el.focus();
    el.click();
    return (
      "Clicked: " +
      (el.getAttribute("aria-label") ||
        el.textContent?.trim().slice(0, 60) ||
        el.tagName.toLowerCase())
    );
  }
  if (action === "focus") {
    el.focus();
    return (
      "Focused: " +
      (el.getAttribute("aria-label") ||
        el.textContent?.trim().slice(0, 60) ||
        el.tagName.toLowerCase())
    );
  }
  if (action === "value" && value != null) {
    if (
      !(el instanceof HTMLInputElement) &&
      !(el instanceof HTMLTextAreaElement) &&
      !(el instanceof HTMLSelectElement)
    ) {
      return "Error[not-input]: Element is not a text input";
    }
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return (
      "Typed into: " +
      (el.getAttribute("aria-label") ||
        (el as HTMLInputElement).placeholder ||
        (el as HTMLInputElement).name ||
        "input")
    );
  }
  return "Error: Unknown action";
}

contextBridge.exposeInMainWorld("__vessel", {
  extractContent: vesselExtractContent,
  getElementSelector: resolveElementSelector,
  interactByIndex,
  resolveShadowSelector,
  notifyHighlightSelection: (text: string) => {
    if (typeof text === "string" && text.trim()) {
      ipcRenderer.send("vessel:highlight-selection", text.trim());
    }
  },
});
