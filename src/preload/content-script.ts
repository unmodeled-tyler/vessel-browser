// Content script preload - injected into web page views
// Provides readability-based content extraction + structured context for AI agents

import { contextBridge, ipcRenderer } from "electron";
import { Readability } from "@mozilla/readability";
import { Channels } from "../shared/channels";
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
  labelSource?: "text" | "value" | "aria-label" | "label" | "placeholder";
  href?: string;
  inputType?: string;
  placeholder?: string;
  required?: boolean;
  context?: string;
  parentOverlay?: string;
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
  looksCorrect?: boolean;
  maxLength?: number;
  min?: string;
  max?: string;
  pattern?: string;
}

interface HeadingStructure {
  level: number;
  text: string;
}

interface OverlayAction {
  label?: string;
  selector?: string;
  kind?: "dismiss" | "accept" | "submit" | "radio" | "action";
  disabled?: boolean;
}

interface OverlayRadioOption {
  label: string;
  selector?: string;
  checked?: boolean;
  labelSource?: string;
  looksCorrect?: boolean;
}

interface PageOverlay {
  type: "dialog" | "modal" | "overlay";
  kind?:
    | "cookie_consent"
    | "selection_modal"
    | "alert"
    | "cart_confirmation"
    | "drawer"
    | "overlay";
  role?: string;
  label?: string;
  selector?: string;
  text?: string;
  message?: string;
  blocksInteraction?: boolean;
  dismissSelector?: string;
  acceptSelector?: string;
  submitSelector?: string;
  actions?: OverlayAction[];
  radioOptions?: OverlayRadioOption[];
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
  overlays: PageOverlay[];
  dormantOverlays: PageOverlay[];
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

interface OverlayCandidate extends PageOverlay {
  element: HTMLElement;
  zIndex: number;
}

function looksLikeCorrectOption(value?: string): boolean | undefined {
  const text = getTrimmedText(value);
  if (!text) return undefined;
  if (
    /\b(correct|right choice|this is correct|correct answer|pick this|select this|choose this|right answer)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(wrong|incorrect|not this|don't pick|do not pick|bad option|decoy)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return undefined;
}

let elementIndex = 0;
const elementSelectors: Record<number, string> = {};
let indexedElements = new WeakMap<Element, number>();
// Direct element references for shadow DOM support — CSS selectors can't cross shadow boundaries
const indexedElementRefs: Record<number, Element> = {};
let activeOverlays: OverlayCandidate[] = [];
let pageDiffMutationTimer: ReturnType<typeof setTimeout> | null = null;
let pageDiffActivityThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let lastPageDiffSignature = "";

const PAGE_DIFF_ACTIVITY_THROTTLE_MS = 350;
const PAGE_DIFF_MUTATION_DEBOUNCE_MS = 1200;

function normalizeSignatureText(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function getPageDiffSignature(): string {
  const title = normalizeSignatureText(document.title);
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .slice(0, 8)
    .map((el) => normalizeSignatureText(el.textContent))
    .filter(Boolean)
    .join(" | ");
  const mainRoot =
    document.querySelector("main, article, [role='main']") || document.body;
  const visibleText = normalizeSignatureText(
    mainRoot instanceof HTMLElement
      ? mainRoot.innerText
      : document.body?.innerText || "",
  ).slice(0, 1200);
  return [window.location.href, title, headings, visibleText].join("\n");
}

function asElement(node: Node | null): Element | null {
  if (node instanceof Element) return node;
  return node?.parentElement || null;
}

function isVesselOwnedNode(node: Node | null): boolean {
  const el = asElement(node);
  return !!el?.closest?.("[data-vessel-highlight], .__vessel-highlight-label");
}

function shouldIgnorePageDiffMutation(mutation: MutationRecord): boolean {
  if (mutation.type === "attributes") {
    return isVesselOwnedNode(mutation.target);
  }
  if (mutation.type === "characterData") {
    return isVesselOwnedNode(mutation.target);
  }
  if (mutation.type === "childList") {
    const added = Array.from(mutation.addedNodes);
    const removed = Array.from(mutation.removedNodes);
    return [...added, ...removed].every((node) => isVesselOwnedNode(node));
  }
  return false;
}

function emitPageDiffDirty(): void {
  const nextSignature = getPageDiffSignature();
  if (!nextSignature || nextSignature === lastPageDiffSignature) return;
  lastPageDiffSignature = nextSignature;
  ipcRenderer.send(Channels.PAGE_DIFF_DIRTY);
}

function notifyPageDiffActivity(): void {
  if (pageDiffActivityThrottleTimer) return;
  ipcRenderer.send(Channels.PAGE_DIFF_ACTIVITY);
  pageDiffActivityThrottleTimer = setTimeout(() => {
    pageDiffActivityThrottleTimer = null;
  }, PAGE_DIFF_ACTIVITY_THROTTLE_MS);
}

function startPageDiffObserver(): void {
  if (typeof MutationObserver === "undefined") return;
  if (!document.documentElement) return;

  lastPageDiffSignature = getPageDiffSignature();

  const observer = new MutationObserver((mutations) => {
    if (mutations.every((mutation) => shouldIgnorePageDiffMutation(mutation))) {
      return;
    }

    notifyPageDiffActivity();
    if (pageDiffMutationTimer) {
      clearTimeout(pageDiffMutationTimer);
    }
    pageDiffMutationTimer = setTimeout(() => {
      pageDiffMutationTimer = null;
      emitPageDiffDirty();
    }, PAGE_DIFF_MUTATION_DEBOUNCE_MS);
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "class",
      "style",
      "hidden",
      "aria-hidden",
      "aria-expanded",
      "aria-selected",
      "aria-checked",
      "aria-label",
      "title",
      "open",
    ],
  });

  window.addEventListener("beforeunload", () => {
    observer.disconnect();
    if (pageDiffActivityThrottleTimer) {
      clearTimeout(pageDiffActivityThrottleTimer);
      pageDiffActivityThrottleTimer = null;
    }
    if (pageDiffMutationTimer) {
      clearTimeout(pageDiffMutationTimer);
      pageDiffMutationTimer = null;
    }
  });
}

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
    if (depth > MAX_SHADOW_DEPTH || shadowRoots.length >= MAX_SHADOW_HOSTS)
      return;
    const tw = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    let el: Node | null = tw.nextNode();
    while (
      el &&
      walked < MAX_WALK_ELEMENTS &&
      shadowRoots.length < MAX_SHADOW_HOSTS
    ) {
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

function deepQuerySelectorAll(
  selector: string,
  root: ParentNode = document,
): Element[] {
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

function touchesViewportEdge(rect: DOMRect): boolean {
  const viewportWidth =
    window.innerWidth || document.documentElement?.clientWidth || 0;
  const viewportHeight =
    window.innerHeight || document.documentElement?.clientHeight || 0;
  const edgePadding = 24;
  return (
    rect.left <= edgePadding ||
    rect.top <= edgePadding ||
    rect.right >= viewportWidth - edgePadding ||
    rect.bottom >= viewportHeight - edgePadding
  );
}

function hasFixedAncestor(el: HTMLElement): boolean {
  let current = el.parentElement;
  while (current && current !== document.body) {
    const position = window.getComputedStyle(current).position;
    if (position === "fixed" || position === "sticky") return true;
    current = current.parentElement;
  }
  return false;
}

function getEffectiveZIndex(
  el: HTMLElement,
  style: CSSStyleDeclaration = window.getComputedStyle(el),
): number {
  const own = parseZIndex(style);
  if (own > 0) return own;

  let current = el.parentElement;
  while (current && current !== document.body) {
    const parentZ = parseZIndex(window.getComputedStyle(current));
    if (parentZ > 0) return parentZ;
    current = current.parentElement;
  }

  return 0;
}

function looksLikeDrawer(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  rect: DOMRect,
  areaRatio: number,
): boolean {
  if (rect.width < 220 || rect.height < 160 || areaRatio < 0.08) return false;
  if (!touchesViewportEdge(rect)) return false;
  if (style.position === "fixed" || style.position === "sticky") {
    return getEffectiveZIndex(el, style) >= 5;
  }
  if (style.position === "absolute" && hasFixedAncestor(el)) {
    return getEffectiveZIndex(el, style) >= 5;
  }
  return false;
}

function looksLikeCartConfirmation(el: HTMLElement): boolean {
  const text = (el.textContent || "").slice(0, 500).toLowerCase();
  const signals = [
    "added to cart",
    "added to bag",
    "added to basket",
    "added to your cart",
    "added to your bag",
    "added to your basket",
  ];
  return signals.some((signal) => text.includes(signal));
}

function getControlTextData(el: Element): { text?: string; source?: string } {
  if (
    el instanceof HTMLInputElement &&
    (el.type === "radio" || el.type === "checkbox")
  ) {
    const label = getInputLabel(el);
    if (label) return { text: label, source: "label" };
  }

  const aria = getTrimmedText(el.getAttribute("aria-label"));
  if (aria) return { text: aria, source: "aria-label" };

  const textContent = getTrimmedText(el.textContent);
  if (textContent) return { text: textContent, source: "textContent" };

  if (el instanceof HTMLInputElement) {
    const value =
      getTrimmedText(el.value) || getTrimmedText(el.getAttribute("value"));
    if (value) return { text: value, source: "value" };
  }

  const valueAttr = getTrimmedText(el.getAttribute("value"));
  if (valueAttr) return { text: valueAttr, source: "value" };

  const title = getTrimmedText(el.getAttribute("title"));
  if (title) return { text: title, source: "title" };

  return {};
}

function getOverlayActionKind(
  el: Element,
  label: string,
): OverlayAction["kind"] {
  const lower = label.toLowerCase();
  const attrText = [
    el.getAttribute("id"),
    typeof (el as HTMLElement).className === "string"
      ? (el as HTMLElement).className
      : "",
    el.getAttribute("name"),
    el.getAttribute("title"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    el.getAttribute("role") === "radio" ||
    (el instanceof HTMLInputElement && el.type === "radio")
  ) {
    return "radio";
  }
  if (
    /close|dismiss|skip|cancel|not now|maybe later|no thanks|reject|decline/.test(
      lower,
    ) ||
    /modal-close|overlay-close/.test(attrText)
  ) {
    return "dismiss";
  }
  if (
    /accept|agree|allow/.test(lower) &&
    /cookie|consent|privacy|gdpr|onetrust|cookiebot/.test(
      `${lower} ${attrText}`,
    )
  ) {
    return "accept";
  }
  if (/submit|continue|next|confirm|done|ok|start|proceed/.test(lower)) {
    return "submit";
  }
  return "action";
}

function getOverlayActionPriority(action: OverlayAction): number {
  switch (action.kind) {
    case "dismiss":
      return 40;
    case "accept":
      return 35;
    case "submit":
      return 30;
    case "radio":
      return 20;
    default:
      return 10;
  }
}

function collectOverlayRadioOptions(root: HTMLElement): OverlayRadioOption[] {
  const seen = new Set<string>();
  const options: OverlayRadioOption[] = [];

  root
    .querySelectorAll('[role="radio"], input[type="radio"]')
    .forEach((node) => {
      if (!(node instanceof HTMLElement) || !isElementVisible(node)) return;
      const data = getControlTextData(node);
      if (!data.text) return;
      const selector = generateSelector(node);
      const key = selector || data.text;
      if (seen.has(key)) return;
      seen.add(key);

      const checked =
        node.getAttribute("aria-checked") === "true" ||
        (node instanceof HTMLInputElement ? node.checked : false);

      options.push({
        label: data.text.slice(0, 100),
        selector,
        checked,
        labelSource: data.source,
        looksCorrect: looksLikeCorrectOption(data.text),
      });
    });

  return options.slice(0, 8);
}

function collectOverlayActions(root: HTMLElement): OverlayAction[] {
  const seen = new Set<string>();
  const actions: OverlayAction[] = [];

  root
    .querySelectorAll(
      'button, [role="button"], a[href], input[type="button"], input[type="submit"], [role="radio"], input[type="radio"]',
    )
    .forEach((node) => {
      if (!(node instanceof HTMLElement) || !isElementVisible(node)) return;
      const selector = generateSelector(node);
      if (!selector || seen.has(selector)) return;

      let data = getControlTextData(node);
      if (!data.text) {
        const attrText = [
          node.id,
          typeof node.className === "string" ? node.className : "",
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (
          /onetrust|consent|cookie|banner|gdpr|trustarc|cookiebot/.test(
            attrText,
          )
        ) {
          data = {
            text: attrText.includes("accept")
              ? "Accept cookies"
              : attrText.includes("reject")
                ? "Reject cookies"
                : attrText.includes("close")
                  ? "Close"
                  : "Consent button",
            source: "fallback",
          };
        }
      }
      if (!data.text) return;

      seen.add(selector);
      actions.push({
        label: data.text.slice(0, 100),
        selector,
        kind: getOverlayActionKind(node, data.text),
        disabled: isElementDisabled(node),
      });
    });

  return actions
    .sort((a, b) => getOverlayActionPriority(b) - getOverlayActionPriority(a))
    .slice(0, 10);
}

function getOverlayMessage(el: HTMLElement): string | undefined {
  const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
  return (
    getTrimmedText(heading?.textContent)?.slice(0, 160) ||
    getNodeTextByIds(el.getAttribute("aria-describedby"))?.slice(0, 160) ||
    getTrimmedText(el.textContent)?.slice(0, 160)
  );
}

function classifyOverlayKind(args: {
  node: HTMLElement;
  drawerLike: boolean;
  cartConfirm: boolean;
  radioOptions: OverlayRadioOption[];
}): PageOverlay["kind"] {
  const haystack = [
    args.node.id,
    typeof args.node.className === "string" ? args.node.className : "",
    args.node.getAttribute("role"),
    args.node.getAttribute("aria-label"),
    args.node.textContent,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    /cookie|consent|privacy|gdpr|onetrust|cookiebot|trustarc/.test(haystack)
  ) {
    return "cookie_consent";
  }
  if (args.cartConfirm) return "cart_confirmation";
  if (args.radioOptions.length > 0) return "selection_modal";
  if (args.drawerLike) return "drawer";
  if (/alert|warning|notice|success|error/.test(haystack)) return "alert";
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

    const overlayType = getOverlayType(node);
    const dialogLike = overlayType === "dialog" || overlayType === "modal";
    const areaRatio = (rect.width * rect.height) / viewportArea;
    const drawerLike = looksLikeDrawer(node, style, rect, areaRatio);
    const cartConfirm =
      !dialogLike &&
      !drawerLike &&
      (style.position === "fixed" ||
        style.position === "sticky" ||
        style.position === "absolute") &&
      rect.width >= 160 &&
      rect.height >= 100 &&
      looksLikeCartConfirmation(node);
    const blockingSurface =
      dialogLike ||
      drawerLike ||
      cartConfirm ||
      ((style.position === "fixed" || style.position === "sticky") &&
        parseZIndex(style) >= 10 &&
        areaRatio >= 0.3 &&
        getViewportCenterCoverage(rect));

    if (
      !blockingSurface &&
      overlayType !== "dialog" &&
      overlayType !== "modal"
    ) {
      return;
    }

    const actions = collectOverlayActions(node);
    const radioOptions = collectOverlayRadioOptions(node);
    seen.add(node);
    overlays.push({
      element: node,
      type: overlayType ?? "overlay",
      kind: classifyOverlayKind({
        node,
        drawerLike,
        cartConfirm,
        radioOptions,
      }),
      role: getTrimmedText(node.getAttribute("role")) || undefined,
      label: getOverlayLabel(node),
      selector: generateSelector(node),
      text: getTrimmedText(node.textContent)?.slice(0, 160),
      message: getOverlayMessage(node),
      blocksInteraction: blockingSurface,
      dismissSelector: actions.find((action) => action.kind === "dismiss")
        ?.selector,
      acceptSelector: actions.find((action) => action.kind === "accept")
        ?.selector,
      submitSelector: actions.find((action) => action.kind === "submit")
        ?.selector,
      actions,
      radioOptions,
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

function getInputLabelWithSource(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): {
  label?: string;
  source?: InteractiveElement["labelSource"];
} {
  if (el.id) {
    const label = document.querySelector(
      `label[for="${escapeSelectorValue(el.id)}"]`,
    );
    const text = getTrimmedText(label?.textContent);
    if (text) return { label: text, source: "label" };
  }

  const parentLabel = el.closest("label");
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("input, select, textarea").forEach((input) => {
      input.remove();
    });
    const text = getTrimmedText(clone.textContent);
    if (text) return { label: text, source: "label" };
  }

  const ariaLabel = getTrimmedText(el.getAttribute("aria-label"));
  if (ariaLabel) return { label: ariaLabel, source: "aria-label" };

  const labelledBy = getNodeTextByIds(el.getAttribute("aria-labelledby"));
  if (labelledBy) return { label: labelledBy, source: "label" };

  const placeholder = getTrimmedText(el.getAttribute("placeholder"));
  if (placeholder) return { label: placeholder, source: "placeholder" };

  return {};
}

function getButtonTextWithSource(el: Element): {
  text?: string;
  source?: InteractiveElement["labelSource"];
} {
  const textContent = getTrimmedText(el.textContent);
  if (textContent) return { text: textContent, source: "text" };

  const value =
    el instanceof HTMLInputElement || el instanceof HTMLButtonElement
      ? getTrimmedText(el.value)
      : getTrimmedText(el.getAttribute("value"));
  if (value) return { text: value, source: "value" };

  const ariaLabel = getTrimmedText(el.getAttribute("aria-label"));
  if (ariaLabel) return { text: ariaLabel, source: "aria-label" };

  return { text: "Button", source: "text" };
}

function getParentOverlaySelector(el: Element): string | undefined {
  const overlay = activeOverlays.find(
    (candidate) =>
      candidate.element === el ||
      candidate.element.contains(el as Node) ||
      (el instanceof HTMLElement && el.contains(candidate.element)),
  );
  return overlay?.selector;
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

function shouldExposeFieldValue(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): boolean {
  if (!(el instanceof HTMLInputElement)) {
    return false;
  }

  const type = (el.type || "").toLowerCase();
  if (type !== "number") {
    return false;
  }

  const label = getInputLabelWithSource(el).label;
  const signals = [
    el.name,
    el.id,
    el.getAttribute("placeholder"),
    el.getAttribute("aria-label"),
    label,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /\b(qty|quantity|count|items?)\b/.test(signals);
}

function getElementValue(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (
      el.type === "password" ||
      el.type === "checkbox" ||
      el.type === "radio"
    ) {
      return undefined; // checkbox/radio state exposed via dedicated checked boolean
    }
    return shouldExposeFieldValue(el)
      ? getTrimmedText(el.value)
      : undefined;
  }
  return undefined;
}

function getSelectOptions(el: HTMLSelectElement): SelectOption[] | undefined {
  const options = Array.from(el.options)
    .map((option) => ({
      label: option.textContent?.trim() || option.value.trim(),
      value: option.value,
    }))
    .filter((o) => o.label || o.value)
    .slice(0, 25);
  return options.length > 0 ? options : undefined;
}

function getAriaBoolean(el: Element, attr: string): boolean | undefined {
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
  | "parentOverlay"
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
    parentOverlay: getParentOverlaySelector(el),
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
  ).forEach((nav) => {
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
  ).forEach((btn) => {
    const { text, source } = getButtonTextWithSource(btn);
    const role = getElementRole(btn);

    elements.push({
      type: "button",
      text: text?.slice(0, 100),
      labelSource: source,
      ...buildBaseMetadata(btn),
      role,
      looksCorrect: role === "radio" ? looksLikeCorrectOption(text) : undefined,
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
  ).forEach((input) => {
    const element = input as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement;
    const tag = input.tagName.toLowerCase();
    const label = getInputLabelWithSource(element);
    const role = getElementRole(input);
    const radioText =
      role === "radio" ||
      (element instanceof HTMLInputElement && element.type === "radio")
        ? getTrimmedText(
            element.getAttribute("value") ||
              element.getAttribute("aria-label") ||
              label.label,
          )
        : undefined;

    elements.push({
      type:
        tag === "select" ? "select" : tag === "textarea" ? "textarea" : "input",
      label: label.label?.slice(0, 100),
      labelSource: label.source,
      inputType: element.getAttribute("type") || undefined,
      placeholder: element.getAttribute("placeholder") || undefined,
      required: element.hasAttribute("required") || undefined,
      value: getElementValue(element),
      options:
        element instanceof HTMLSelectElement
          ? getSelectOptions(element)
          : undefined,
      ...buildBaseMetadata(input),
      role,
      text: radioText?.slice(0, 100),
      looksCorrect:
        radioText || label.label
          ? looksLikeCorrectOption(radioText || label.label)
          : undefined,
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
        const label = getInputLabelWithSource(element);
        const role = getElementRole(input);
        const radioText =
          role === "radio" ||
          (element instanceof HTMLInputElement && element.type === "radio")
            ? getTrimmedText(
                element.getAttribute("value") ||
                  element.getAttribute("aria-label") ||
                  label.label,
              )
            : undefined;

        fields.push({
          type:
            tag === "select"
              ? "select"
              : tag === "textarea"
                ? "textarea"
                : "input",
          label: label.label?.slice(0, 100),
          labelSource: label.source,
          inputType: element.getAttribute("type") || undefined,
          placeholder: element.getAttribute("placeholder") || undefined,
          required: element.hasAttribute("required") || undefined,
          value: getElementValue(element),
          options:
            element instanceof HTMLSelectElement
              ? getSelectOptions(element)
              : undefined,
          ...buildBaseMetadata(input),
          role,
          text: radioText?.slice(0, 100),
          looksCorrect:
            radioText || label.label
              ? looksLikeCorrectOption(radioText || label.label)
              : undefined,
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
        const { text, source } = getButtonTextWithSource(btn);
        fields.push({
          type: "button",
          text: text?.slice(0, 100),
          labelSource: source,
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
  const scripts = document.querySelectorAll(
    'script[type="application/ld+json"]',
  );
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
      const isNestedItemRoot =
        nearestScope === node && node.hasAttribute("itemscope");
      if (nearestScope !== scope && !isNestedItemRoot) {
        return;
      }
      if (
        isNestedItemRoot &&
        node.parentElement?.closest("[itemscope]") !== scope
      ) {
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
    document.querySelectorAll(
      ".__vessel-highlight-label[data-vessel-highlight]",
    ),
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
      (key) => delete elementSelectors[Number(key)],
    );
    Object.keys(indexedElementRefs).forEach(
      (key) => delete indexedElementRefs[Number(key)],
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

function resolveElementIndexBySelector(selector: string): number | null {
  if (!selector || typeof selector !== "string") return null;

  let el: Element | null = null;
  try {
    if (selector.includes(" >>> ")) {
      el = resolveShadowSelector(selector);
    } else {
      el = document.querySelector(selector);
    }
  } catch {
    return null;
  }

  if (!el) return null;
  const existing = indexedElements.get(el);
  return typeof existing === "number" ? existing : null;
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
  if (!el || !(el instanceof HTMLElement) || !document.contains(el)) {
    return "Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh.";
  }
  if (action === "click") {
    // Bring offscreen elements into view so the user can see the interaction
    el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    // Guard: zero-dimension elements (collapsed, virtual-scroll, lazy-loaded)
    // cannot be meaningfully clicked — return an actionable error instead.
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return "Error[hidden]: Element has no visible area. It may be inside a collapsed, lazy-loaded, or virtual-scroll section. Scroll toward it, then call read_page to refresh visible elements.";
    }
    el.focus();
    el.click();
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox") {
        const label =
          getInputLabel(el) ||
          el.getAttribute("aria-label") ||
          el.name ||
          "checkbox";
        return `${el.checked ? "Checked" : "Unchecked"}: ${label}`;
      }
      if (el.type === "radio") {
        const label =
          getTrimmedText(el.value) ||
          getInputLabel(el) ||
          el.getAttribute("aria-label") ||
          el.name ||
          "radio";
        return `${el.checked ? "Selected" : "Clicked"}: ${label}`;
      }
    }
    const role = el.getAttribute("role");
    if (role === "checkbox" || role === "radio") {
      const label =
        getTrimmedText(el.getAttribute("aria-label")) ||
        getTrimmedText(el.textContent) ||
        el.tagName.toLowerCase();
      const ariaChecked = el.getAttribute("aria-checked");
      if (role === "checkbox") {
        return `${ariaChecked === "true" ? "Checked" : "Unchecked"}: ${label}`;
      }
      return `${ariaChecked === "true" ? "Selected" : "Clicked"}: ${label}`;
    }
    const anchor =
      el instanceof HTMLAnchorElement
        ? el
        : el.closest("a[href]");
    const href =
      anchor instanceof HTMLAnchorElement ? anchor.href : null;
    return (
      "Clicked: " +
      (el.getAttribute("aria-label") ||
        el.textContent?.trim().slice(0, 60) ||
        el.tagName.toLowerCase()) +
      (href ? "\nhref: " + href : "")
    );
  }
  if (action === "focus") {
    el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
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
  getElementIndexBySelector: resolveElementIndexBySelector,
  interactByIndex,
  resolveShadowSelector,
  notifyHighlightSelection: (text: string) => {
    if (typeof text === "string" && text.trim()) {
      ipcRenderer.send("vessel:highlight-selection", text.trim());
    }
  },
});

if (document.readyState === "loading") {
  window.addEventListener(
    "DOMContentLoaded",
    () => {
      startPageDiffObserver();
    },
    { once: true },
  );
} else {
  startPageDiffObserver();
}
