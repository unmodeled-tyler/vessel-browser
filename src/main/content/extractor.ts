import type { WebContents } from "electron";
import type { PageContent } from "../../shared/types";

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
  landmarks: [],
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

    function selectorFor(el) {
      if (!el) return "";
      if (el.id) return "#" + escapeSelectorValue(el.id);
      const name = el.getAttribute && el.getAttribute("name");
      if (name) return el.tagName.toLowerCase() + "[name=\"" + escapeSelectorValue(name) + "\"]";
      const parts = [];
      let current = el;
      for (let depth = 0; current && current !== document.body && depth < 5; depth += 1) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) {
          parts.unshift(tag + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")");
        } else {
          parts.unshift(tag);
        }
        current = parent;
      }
      return parts.join(" > ");
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
        visible: visible(el),
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
    landmarks: bestArray(pages.map((page) => page.landmarks)),
  };

  return {
    ...mergedBase,
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
    landmarks: Array.isArray(page.landmarks) ? page.landmarks : [],
  };
}
