// Content script preload - injected into web page views
// Provides readability-based content extraction + structured context for AI agents

import { contextBridge } from "electron";
import { Readability } from "@mozilla/readability";

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
  landmarks: Array<{
    role: string;
    label?: string;
    text?: string;
  }>;
}

let elementIndex = 0;
const elementSelectors: Record<number, string> = {};
const indexedElements = new WeakMap<Element, number>();

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/["\\]/g, "\\$&");
}

function generateSelector(el: Element): string {
  if (el.id) return `#${escapeSelectorValue(el.id)}`;

  const testId = el.getAttribute("data-testid");
  if (testId) {
    return `[data-testid="${escapeSelectorValue(testId)}"]`;
  }

  const name = el.getAttribute("name");
  if (name) {
    return `${el.tagName.toLowerCase()}[name="${escapeSelectorValue(name)}"]`;
  }

  const parts: string[] = [];
  let current: Element | null = el;
  for (
    let depth = 0;
    current && current !== document.body && depth < 5;
    depth += 1
  ) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }

    const siblings = Array.from(parent.children).filter(
      (child) => child.tagName === current!.tagName,
    );
    if (siblings.length > 1) {
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
    } else {
      parts.unshift(tag);
    }

    current = parent;
  }

  return parts.join(" > ");
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
  | "disabled"
> {
  return {
    context: getElementContext(el),
    selector: generateSelector(el),
    index: assignIndex(el),
    role: getElementRole(el),
    description: getElementDescription(el),
    visible: isElementVisible(el),
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

  document.querySelectorAll("form").forEach((form) => {
    const fields: InteractiveElement[] = [];

    form
      .querySelectorAll("input:not([type='hidden']), select, textarea")
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

    form
      .querySelectorAll("button[type='submit'], input[type='submit'], button:not([type])")
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
  try {
    elementIndex = 0;
    Object.keys(elementSelectors).forEach(
      (key) => delete elementSelectors[key as any],
    );
    // WeakMap entries are GC'd automatically; no explicit clearing needed

    const documentClone = document.cloneNode(true) as Document;
    const reader = new Readability(documentClone);
    const article = reader.parse();

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
      landmarks: extractLandmarks(),
    };
  } catch (error) {
    console.error("Vessel content extraction error:", error);
    return {
      title: document.title,
      content: document.body?.innerText || "",
      htmlContent: "",
      byline: "",
      excerpt: "",
      url: window.location.href,
      headings: extractHeadings(),
      navigation: extractNavigation(),
      interactiveElements: extractInteractiveElements(),
      forms: extractForms(),
      landmarks: extractLandmarks(),
    };
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
