import type {
  PageContent,
  InteractiveElement,
  HeadingStructure,
  StoredHighlight,
  StructuredDataEntity,
  StructuredDataValue,
  PageIssue,
} from "../../shared/types";
import * as highlightsManager from "../highlights/manager";
import { buildOverlayInventory } from "../content/overlay-inventory";

import { MAX_CONTEXT_CONTENT_LENGTH } from "./content-limits";
import { normalizeComparable, normalizeUrlForMatch, getUrlPathSegments } from "./url-normalization";

const MAX_STRUCTURED_ITEMS = 100; // Limit structured elements to keep context manageable
const LARGE_PAGE_HINT_THRESHOLD = 12000;

function truncateContent(content: string): string {
  if (content.length <= MAX_CONTEXT_CONTENT_LENGTH) return content;
  return (
    content.slice(0, MAX_CONTEXT_CONTENT_LENGTH) +
    "\n\n[Content truncated for length...]"
  );
}

function limitItems<T>(items: T[], max: number = MAX_STRUCTURED_ITEMS): T[] {
  if (items.length <= max) return items;
  return items.slice(0, max);
}

function shouldRenderFieldValue(el: InteractiveElement): boolean {
  const value =
    typeof el.value === "string" && el.value.trim() ? el.value.trim() : "";
  return Boolean(value) && isQuantityLike(el);
}

function formatElementMeta(el: InteractiveElement): string[] {
  const meta: string[] = [];
  if (el.context && el.context !== "content") {
    meta.push(`context=${el.context}`);
  }
  if (el.role) {
    meta.push(`role=${el.role}`);
  }
  if (el.visible === false) {
    meta.push("hidden");
  }
  if (el.visible !== false && el.inViewport === false) {
    meta.push("offscreen");
  }
  if (el.inViewport && el.fullyInViewport === false) {
    meta.push("partially-visible");
  }
  if (el.obscured) {
    meta.push("obscured");
  }
  if (el.blockedByOverlay) {
    meta.push("blocked-by-overlay");
  }
  if (el.disabled) {
    meta.push("disabled");
  }
  if (el.checked !== undefined) {
    meta.push(el.checked ? "checked" : "unchecked");
  }
  if (el.ariaExpanded !== undefined) {
    meta.push(`expanded=${el.ariaExpanded}`);
  }
  if (el.ariaPressed !== undefined) {
    meta.push(`pressed=${el.ariaPressed}`);
  }
  if (el.ariaSelected !== undefined) {
    meta.push(`selected=${el.ariaSelected}`);
  }
  if (el.name) {
    meta.push(`name="${el.name}"`);
  }
  if (el.autocomplete) {
    meta.push(`autocomplete=${el.autocomplete}`);
  }
  if (el.maxLength != null && el.maxLength >= 0) {
    meta.push(`maxlength=${el.maxLength}`);
  }
  if (el.min != null) {
    meta.push(`min=${el.min}`);
  }
  if (el.max != null) {
    meta.push(`max=${el.max}`);
  }
  if (el.pattern) {
    meta.push(`pattern="${el.pattern}"`);
  }
  if (el.labelSource) {
    meta.push(`source=${el.labelSource}`);
  }
  if (el.looksCorrect === true) {
    meta.push("likely-correct");
  } else if (el.looksCorrect === false) {
    meta.push("likely-wrong");
  }
  if (el.description) {
    meta.push(`desc="${el.description.slice(0, 80)}"`);
  }
  if (shouldRenderFieldValue(el)) {
    meta.push(`value="${el.value.slice(0, 60)}"`);
  }
  if (el.selector) {
    const selectorHint =
      el.selector.length > 80 ? `${el.selector.slice(0, 77)}...` : el.selector;
    meta.push(`selector="${selectorHint}"`);
  }
  return meta;
}

function summarizeElementValue(
  el: InteractiveElement,
): { label: string; value: string } | null {
  const value =
    typeof el.value === "string" && el.value.trim() ? el.value.trim() : "";
  if (!value || !shouldRenderFieldValue(el)) return null;

  if (el.type === "select") {
    return { label: "selected", value: value.slice(0, 60) };
  }
  if (el.type === "textarea") {
    return { label: "current", value: value.slice(0, 60) };
  }
  if (el.type === "input") {
    return { label: "current", value: value.slice(0, 60) };
  }
  return null;
}

function isQuantityLike(el: InteractiveElement): boolean {
  const text = [
    el.label,
    el.name,
    el.placeholder,
    el.text,
    el.description,
    el.selector,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    /\b(qty|quantity|count|items?)\b/.test(text) ||
    (el.inputType === "number" &&
      (/\b(quantity|qty|count|items?)\b/.test(text) ||
        el.name === "quantity" ||
        el.name === "qty"))
  );
}

function getQuantityElements(page: PageContent): InteractiveElement[] {
  const seen = new Set<string>();
  const elements = [
    ...page.interactiveElements,
    ...page.forms.flatMap((form) => form.fields),
  ];

  return elements.filter((el) => {
    if (!isQuantityLike(el)) return false;
    const key = String(
      el.index ??
        el.selector ??
        `${el.type}|${el.name || ""}|${el.label || ""}|${el.value || ""}`,
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatQuantityElements(elements: InteractiveElement[]): string {
  if (elements.length === 0) return "None detected";

  return limitItems(elements, 12)
    .map((el) => {
      const prefix = el.index ? `[#${el.index}]` : "-";
      const name = el.label || el.name || el.placeholder || "Quantity";
      const summary = summarizeElementValue(el);
      const parts = [prefix, `[${name}]`, el.type];
      if (summary) {
        parts.push(`${summary.label}="${summary.value}"`);
      }
      const meta = formatElementMeta({
        ...el,
        value: undefined,
      });
      if (meta.length > 0) {
        parts.push(`(${meta.join(", ")})`);
      }
      return parts.join(" ");
    })
    .join("\n");
}

function isCartLikePage(page: PageContent): boolean {
  const url = page.url.toLowerCase();
  const text = `${page.title}\n${page.content}`.toLowerCase();
  return (
    url.includes("cart") ||
    url.includes("checkout") ||
    url.includes("basket") ||
    url.includes("bag") ||
    getQuantityElements(page).length > 0 ||
    /\b(subtotal|order total|cart total|checkout|shopping cart)\b/.test(text)
  );
}

function getCartItemLinks(page: PageContent): InteractiveElement[] {
  const blockedText =
    /\b(remove|delete|wishlist|save for later|move to|checkout|view cart|continue shopping|edit|details?)\b/i;
  const blockedHref =
    /\/(cart|checkout|wishlist|account|login|signin|remove|delete)(\/|$)|[?&](remove|delete|wishlist)=/i;
  const seen = new Set<string>();

  return page.interactiveElements
    .filter((el) => el.type === "link")
    .filter((el) => {
      const text = (el.text || "").trim();
      const href = (el.href || "").trim();
      if (!text || text.length < 3 || !href) return false;
      if (
        el.context === "nav" ||
        el.context === "footer" ||
        el.context === "sidebar"
      ) {
        return false;
      }
      if (blockedText.test(text) || blockedHref.test(href)) return false;
      const key = `${normalizeComparable(text)}|${normalizeUrlForMatch(href) || href}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function extractCartTotals(content: string): string[] {
  const lines = content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const totalLines: string[] = [];
  const seen = new Set<string>();
  const keyword =
    /\b(subtotal|order total|estimated total|total|tax|shipping|discount|savings?)\b/i;
  const money =
    /([$€£]\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*(?:\.\d{2})?\s?(?:usd|eur|gbp))/i;

  for (const line of lines) {
    if (!keyword.test(line)) continue;
    if (!money.test(line) && line.length > 90) continue;
    const cleaned = line.replace(/\s+/g, " ").trim();
    if (seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    totalLines.push(cleaned);
    if (totalLines.length >= 6) break;
  }

  return totalLines;
}

function formatCartSnapshot(page: PageContent): string | null {
  if (!isCartLikePage(page)) return null;

  const itemLinks = getCartItemLinks(page);
  const quantityElements = getQuantityElements(page);
  const quantityValues = quantityElements
    .map((el) => summarizeElementValue(el)?.value || "")
    .filter(Boolean);
  const numericQuantities = quantityValues
    .map((value) => Number.parseFloat(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const totalLines = extractCartTotals(page.content);
  const lines: string[] = [];

  if (itemLinks.length > 0) {
    lines.push(`Distinct items: ${itemLinks.length}`);
    lines.push(
      `Items: ${itemLinks
        .slice(0, 8)
        .map((item) => item.text || item.label || "Untitled item")
        .join(" | ")}`,
    );
  }

  if (quantityElements.length > 0) {
    if (
      numericQuantities.length === quantityElements.length &&
      numericQuantities.length > 0
    ) {
      const unique = Array.from(new Set(numericQuantities));
      const totalUnits = numericQuantities.reduce(
        (sum, value) => sum + value,
        0,
      );
      lines.push(
        unique.length === 1
          ? `Quantity controls: ${quantityElements.length} (all set to ${unique[0]})`
          : `Quantity controls: ${quantityElements.length} (${numericQuantities.join(", ")})`,
      );
      lines.push(`Total units inferred: ${totalUnits}`);
      if (itemLinks.length > 0 && totalUnits > itemLinks.length) {
        lines.push(
          `Attention: ${itemLinks.length} distinct items but ${totalUnits} total units. Check for duplicate quantities.`,
        );
      }
    } else {
      lines.push(
        `Quantity controls: ${quantityElements.length}${quantityValues.length > 0 ? ` (${quantityValues.join(", ")})` : ""}`,
      );
    }
  }

  if (totalLines.length > 0) {
    lines.push("Totals:");
    totalLines.forEach((line) => lines.push(`- ${line}`));
  }

  if (lines.length === 0) return null;
  return lines.join("\n");
}

function isVisibleToUser(el: InteractiveElement): boolean {
  return (
    el.visible === true &&
    el.inViewport === true &&
    el.obscured !== true &&
    el.blockedByOverlay !== true
  );
}

function purchaseActionPriority(el: InteractiveElement): number {
  const haystack = normalizeComparable(
    [
      el.text,
      el.label,
      el.name,
      el.placeholder,
      el.description,
      el.href,
    ]
      .filter(Boolean)
      .join(" "),
  );

  if (!haystack) return Number.POSITIVE_INFINITY;
  if (/\badd(?: item)? to (?:cart|bag|basket)\b/.test(haystack)) return 0;
  if (/\b(?:buy now|preorder|pre-order|reserve now|shop now)\b/.test(haystack)) {
    return 1;
  }
  if (/\b(?:checkout|view cart|view basket|go to cart|view bag)\b/.test(haystack)) {
    return 2;
  }
  return Number.POSITIVE_INFINITY;
}

function isPurchaseActionElement(el: InteractiveElement): boolean {
  if (
    el.type !== "button" &&
    el.type !== "link" &&
    !(el.type === "input" &&
      (el.inputType === "submit" || el.inputType === "button"))
  ) {
    return false;
  }

  return Number.isFinite(purchaseActionPriority(el));
}

function getPurchaseActionElements(
  page: PageContent,
  options?: { visibleOnly?: boolean },
): InteractiveElement[] {
  const visibleOnly = options?.visibleOnly !== false;
  const seen = new Set<string>();

  return page.interactiveElements
    .filter((el) => {
      if (!isPurchaseActionElement(el)) return false;
      if (visibleOnly && !isVisibleToUser(el)) return false;
      if (el.blockedByOverlay) return false;

      const key = String(
        el.index ??
          el.selector ??
          `${el.type}|${el.text || ""}|${el.label || ""}|${el.href || ""}`,
      );
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const delta = purchaseActionPriority(a) - purchaseActionPriority(b);
      if (delta !== 0) return delta;
      return (a.index ?? Number.MAX_SAFE_INTEGER) -
        (b.index ?? Number.MAX_SAFE_INTEGER);
    })
    .slice(0, 8);
}

function getOffscreenPurchaseActionElements(page: PageContent): InteractiveElement[] {
  const visibleKeys = new Set(
    getPurchaseActionElements(page, { visibleOnly: true }).map((el) =>
      String(
        el.index ??
          el.selector ??
          `${el.type}|${el.text || ""}|${el.label || ""}|${el.href || ""}`,
      ),
    ),
  );

  return getPurchaseActionElements(page, { visibleOnly: false }).filter((el) => {
    const key = String(
      el.index ??
        el.selector ??
        `${el.type}|${el.text || ""}|${el.label || ""}|${el.href || ""}`,
    );
    return !visibleKeys.has(key) && el.visible !== false;
  });
}

function getDialogFocusedElements(page: PageContent): InteractiveElement[] {
  return page.interactiveElements.filter(
    (el) => isVisibleToUser(el) && el.context === "dialog",
  );
}

function normalizeOverlayText(value: string | undefined): string {
  return (value || "").trim().toLowerCase();
}

function isCartConfirmationLike(page: PageContent): boolean {
  const overlayText = page.overlays
    .map((overlay) =>
      normalizeOverlayText(
        [overlay.label, overlay.text].filter(Boolean).join(" "),
      ),
    )
    .join(" ");
  const dialogText = getDialogFocusedElements(page)
    .map((el) => normalizeOverlayText(el.text || el.label || el.description))
    .join(" ");

  const haystack = `${overlayText} ${dialogText}`.trim();
  if (!haystack) return false;

  const cartSignals = [
    "added to cart",
    "added to bag",
    "added to basket",
    "shopping cart",
    "view cart",
    "go to cart",
    "continue shopping",
    "keep shopping",
    "checkout",
  ];

  return cartSignals.some((signal) => haystack.includes(signal));
}

function formatDialogFocus(page: PageContent): string | null {
  const dialogElements = getDialogFocusedElements(page);
  if (dialogElements.length === 0) return null;

  const lines: string[] = [];
  lines.push(
    "A live dialog/modal is open. Prioritize its controls before acting on the page behind it.",
  );

  if (isCartConfirmationLike(page)) {
    lines.push(
      "Cart confirmation detected: choose a dialog action such as Continue Shopping, View Cart, or Checkout. Do not click background Add to Cart again.",
    );
  }

  lines.push("");
  lines.push("Visible dialog controls:");
  lines.push(formatInteractiveElements(dialogElements));
  return lines.join("\n");
}

/**
 * Format interactive elements into a readable structure
 */
function formatInteractiveElements(elements: InteractiveElement[]): string {
  if (elements.length === 0) return "None";

  // Prioritize visible, in-viewport, content-area elements over offscreen nav/sidebar links
  const sorted = [...elements].sort((a, b) => {
    const scoreEl = (el: InteractiveElement) => {
      let s = 0;
      if (el.context === "dialog") s -= 40;
      const purchasePriority = purchaseActionPriority(el);
      if (Number.isFinite(purchasePriority)) {
        s -= 25 - purchasePriority * 5;
      }
      if (el.visible === false) s += 100;
      if (el.inViewport === false) s += 50;
      if (
        el.context === "nav" ||
        el.context === "footer" ||
        el.context === "sidebar"
      )
        s += 30;
      if (el.obscured) s += 20;
      // Inputs/buttons are higher priority than links (fewer of them, more actionable)
      if (el.type === "link") s += 5;
      return s;
    };
    return scoreEl(a) - scoreEl(b);
  });
  const items = limitItems(sorted, 50);

  return items
    .map((el) => {
      const prefix = el.index ? `[#${el.index}]` : "-";
      const parts: string[] = [prefix];

      if (el.type === "button") {
        parts.push(`[${el.text || "Button"}]`);
        parts.push(el.role === "radio" ? "radio" : "button");
      } else if (el.type === "link") {
        parts.push(`[${el.text || "Link"}]`);
        parts.push("link");
        if (el.href) parts.push(`→ ${el.href}`);
      } else if (el.type === "input") {
        parts.push(`[${el.label || el.placeholder || "Input"}]`);
        parts.push(el.inputType || "text");
        parts.push("input");
        const summary = summarizeElementValue(el);
        if (summary) parts.push(`${summary.label}="${summary.value}"`);
        if (el.required) parts.push("(required)");
      } else if (el.type === "select") {
        parts.push(`[${el.label || "Select"}]`);
        parts.push("dropdown");
        const summary = summarizeElementValue(el);
        if (summary) parts.push(`${summary.label}="${summary.value}"`);
        if (el.options?.length) {
          parts.push(
            `options=${el.options
              .slice(0, 5)
              .map((o) => (typeof o === "string" ? o : o.label || o.value))
              .join("|")}`,
          );
        }
      } else if (el.type === "textarea") {
        parts.push(`[${el.label || "Text Area"}]`);
        parts.push("textarea");
        const summary = summarizeElementValue(el);
        if (summary) parts.push(`${summary.label}="${summary.value}"`);
      }

      const meta = formatElementMeta(el);
      if (meta.length > 0) parts.push(`(${meta.join(", ")})`);

      return parts.join(" ");
    })
    .join("\n");
}

/**
 * Format headings hierarchy
 */
function formatHeadings(headings: HeadingStructure[]): string {
  if (headings.length === 0) return "None";

  const items = limitItems(headings, 30);

  return items
    .map((h) => {
      const indent = "  ".repeat(h.level - 1);
      return `${indent}H${h.level}: ${h.text}`;
    })
    .join("\n");
}

/**
 * Format navigation links
 */
function formatNavigation(nav: InteractiveElement[]): string {
  if (nav.length === 0) return "None detected";

  const items = limitItems(nav, 20);

  return items
    .map((item) => {
      const prefix = item.index ? `[#${item.index}]` : "-";
      return `${prefix} [${item.text}] → ${item.href}`;
    })
    .join("\n");
}

/**
 * Format forms
 */
function formatForms(forms: PageContent["forms"]): string {
  if (forms.length === 0) return "None";

  return forms
    .map((form, index) => {
      const parts: string[] = [
        `Form ${index + 1}${form.id ? ` (#${form.id})` : ""}:`,
      ];

      if (form.action) parts.push(`  Action: ${form.action}`);
      if (form.method) parts.push(`  Method: ${form.method.toUpperCase()}`);

      if (form.fields.length > 0) {
        parts.push("  Fields:");
        form.fields.forEach((field) => {
          const fieldParts: string[] = [
            field.index ? `    [#${field.index}]` : "    -",
          ];

          if (field.type === "button") {
            fieldParts.push(`[${field.text || "Submit"}]`);
            fieldParts.push(field.role === "radio" ? "radio" : "button");
          } else if (field.type === "input") {
            fieldParts.push(`[${field.label || field.placeholder || "Input"}]`);
            fieldParts.push(field.inputType || "text");
            const summary = summarizeElementValue(field);
            if (summary) fieldParts.push(`${summary.label}="${summary.value}"`);
            if (field.required) fieldParts.push("(required)");
          } else if (field.type === "select") {
            fieldParts.push(`[${field.label || "Select"}]`);
            fieldParts.push("dropdown");
            const summary = summarizeElementValue(field);
            if (summary) fieldParts.push(`${summary.label}="${summary.value}"`);
            if (field.options?.length) {
              fieldParts.push(
                `options=${field.options
                  .slice(0, 5)
                  .map((o) => (typeof o === "string" ? o : o.label || o.value))
                  .join("|")}`,
              );
            }
          } else if (field.type === "textarea") {
            fieldParts.push(`[${field.label || "Text"}]`);
            fieldParts.push("textarea");
            const summary = summarizeElementValue(field);
            if (summary) fieldParts.push(`${summary.label}="${summary.value}"`);
          }

          const meta = formatElementMeta(field);
          if (meta.length > 0) fieldParts.push(`(${meta.join(", ")})`);

          parts.push(fieldParts.join(" "));
        });
      }

      return parts.join("\n");
    })
    .join("\n\n");
}

/**
 * Format landmarks
 */
function formatLandmarks(landmarks: PageContent["landmarks"]): string {
  if (landmarks.length === 0) return "None detected";

  const items = limitItems(landmarks, 20);

  return items
    .map((lm) => {
      const parts: string[] = [`- ${lm.role}`];
      if (lm.label) parts.push(`(label: "${lm.label}")`);
      if (lm.text)
        parts.push(
          `- "${lm.text.slice(0, 100)}${lm.text.length > 100 ? "..." : ""}"`,
        );
      return parts.join(" ");
    })
    .join("\n");
}

function formatViewport(page: PageContent): string {
  return `${page.viewport.width}x${page.viewport.height} at scroll (${page.viewport.scrollX}, ${page.viewport.scrollY})`;
}

function formatOverlays(page: PageContent): string {
  if (page.overlays.length === 0) return "None detected";

  const items = limitItems(buildOverlayInventory(page), 10);
  return items
    .map((overlay) => {
      const lines = [
        [
          `- ${overlay.kind}`,
          overlay.role ? `role=${overlay.role}` : "",
          overlay.blocksInteraction ? "blocking" : "",
          overlay.label ? `label="${overlay.label.slice(0, 80)}"` : "",
          overlay.text ? `text="${overlay.text.slice(0, 100)}"` : "",
        ]
          .filter(Boolean)
          .join(" "),
      ];

      if (overlay.radioOptions.length > 0) {
        const options = overlay.radioOptions
          .slice(0, 4)
          .map((option) => {
            const tags = [];
            if (option.labelSource) tags.push(`source=${option.labelSource}`);
            if (option.looksCorrect === true) tags.push("likely-correct");
            if (option.looksCorrect === false) tags.push("likely-wrong");
            const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
            return `${option.label || option.selector || "radio"}${suffix}`;
          })
          .join(" | ");
        lines.push(`  options: ${options}`);
      }

      const actionLabels = [
        overlay.dismissAction?.label
          ? `dismiss="${overlay.dismissAction.label}"`
          : "",
        overlay.acceptAction?.label
          ? `accept="${overlay.acceptAction.label}"`
          : "",
        overlay.submitAction?.label
          ? `submit="${overlay.submitAction.label}"`
          : "",
      ].filter(Boolean);
      if (actionLabels.length > 0) {
        lines.push(`  actions: ${actionLabels.join(" ")}`);
      }

      return lines.join("\n");
    })
    .join("\n");
}

function getScrollHints(page: PageContent): string[] {
  const candidates = page.interactiveElements.filter(
    (el) =>
      el.visible !== false &&
      el.inViewport === false &&
      el.context !== "nav" &&
      el.context !== "footer" &&
      el.context !== "sidebar" &&
      el.blockedByOverlay !== true &&
      (el.type === "input" ||
        el.type === "textarea" ||
        el.type === "select" ||
        el.type === "button"),
  );

  if (candidates.length === 0) return [];

  const labels = limitItems(candidates, 3)
    .map((el) => el.text || el.label || el.placeholder || el.type)
    .filter(Boolean);

  return [
    `Scroll to reveal offscreen controls: ${labels.join(", ")}${candidates.length > labels.length ? ", ..." : ""}`,
  ];
}

function formatDormantOverlays(
  overlays: PageContent["dormantOverlays"],
): string {
  if (overlays.length === 0) return "None detected";

  const items = limitItems(overlays, 10);
  return items
    .map((overlay) => {
      const parts = [`- ${overlay.type}`];
      if (overlay.role) parts.push(`role=${overlay.role}`);
      if (overlay.label) parts.push(`label="${overlay.label.slice(0, 80)}"`);
      if (overlay.text) parts.push(`text="${overlay.text.slice(0, 100)}"`);
      return parts.join(" ");
    })
    .join("\n");
}

function formatPageIssues(issues: PageIssue[]): string {
  if (issues.length === 0) return "None detected";

  return limitItems(issues, 3)
    .map((issue) => {
      const lines = [`- ${issue.summary}`];
      if (issue.detail) {
        lines.push(`  detail: ${issue.detail}`);
      }
      if (issue.recommendation) {
        lines.push(`  recommendation: ${issue.recommendation}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

function formatStructuredValue(value: StructuredDataValue, depth = 0): string {
  if (value == null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const rendered = value
      .map((item) => formatStructuredValue(item, depth + 1))
      .filter(Boolean)
      .slice(0, depth === 0 ? 8 : 5);
    return rendered.join(depth === 0 ? ", " : " | ");
  }
  const entries = Object.entries(value)
    .slice(0, 6)
    .map(([key, entry]) => `${key}: ${formatStructuredValue(entry, depth + 1)}`)
    .filter((entry) => !entry.endsWith(": "));
  return entries.join(", ");
}

function formatStructuredEntities(entities: StructuredDataEntity[]): string {
  if (entities.length === 0) return "None detected";

  return limitItems(entities, 12)
    .map((entity) => {
      const lines: string[] = [];
      const label = entity.name || entity.url || "Unnamed entity";
      lines.push(`- [${entity.types.join(", ")}] ${label}`);
      if (entity.description) {
        lines.push(`  description: ${entity.description.slice(0, 180)}`);
      }
      if (entity.url && entity.url !== entity.name) {
        lines.push(`  url: ${entity.url}`);
      }
      for (const [key, value] of Object.entries(entity.attributes).slice(
        0,
        8,
      )) {
        const rendered = formatStructuredValue(value);
        if (rendered) {
          lines.push(`  ${key}: ${rendered}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n");
}

function hasOnlyFallbackStructuredData(page: PageContent): boolean {
  return (
    (page.structuredData?.length ?? 0) > 0 &&
    (page.structuredData ?? []).every((entity) => entity.source === "page")
  );
}

function formatLargePageHint(page: PageContent): string | null {
  if (page.content.length < LARGE_PAGE_HINT_THRESHOLD) return null;

  return `Large page detected: ${page.content.length} chars across ${page.headings.length} headings. Prefer summary, results_only, forms_only, or interactives_only before reading raw page text.`;
}

function formatHighlights(highlights: StoredHighlight[]): string {
  if (highlights.length === 0) return "No highlights on this page.";
  return highlights
    .map((h) => {
      const parts: string[] = [];
      const source = h.source === "user" ? "user" : "agent";
      parts.push(`- [${source}]`);
      if (h.label) parts.push(`**${h.label}**`);
      if (h.text) {
        const preview =
          h.text.length > 120 ? h.text.slice(0, 117) + "..." : h.text;
        parts.push(`"${preview}"`);
      }
      if (h.selector) parts.push(`(${h.selector})`);
      if (h.color) parts.push(`color=${h.color}`);
      parts.push(`id=${h.id}`);
      return parts.join(" ");
    })
    .join("\n");
}

function getHighlightsForPage(url: string): StoredHighlight[] {
  try {
    return highlightsManager.getHighlightsForUrl(url);
  } catch {
    return [];
  }
}

function formatJsonLd(items: Record<string, unknown>[]): string {
  if (!items || items.length === 0) return "";

  const lines: string[] = [];

  // Fields to omit as too noisy for agents
  const SKIP = new Set([
    "@context",
    "image",
    "logo",
    "thumbnail",
    "potentialAction",
  ]);

  // Type-specific field priority (shown first)
  const TYPE_FIELDS: Record<string, string[]> = {
    Recipe: [
      "name",
      "url",
      "description",
      "recipeYield",
      "totalTime",
      "cookTime",
      "prepTime",
      "recipeIngredient",
      "recipeInstructions",
    ],
    Article: [
      "headline",
      "name",
      "url",
      "datePublished",
      "dateModified",
      "author",
      "description",
    ],
    Product: ["name", "url", "description", "offers"],
    BreadcrumbList: ["itemListElement"],
    Organization: ["name", "url", "description"],
  };

  for (const item of items) {
    const type = (item["@type"] as string) || "Unknown";
    lines.push(`**[${type}]**`);

    const priorityFields = TYPE_FIELDS[type] ?? [];
    const seen = new Set<string>();

    const renderValue = (val: unknown, depth = 0): string => {
      if (val === null || val === undefined) return "";
      if (typeof val === "string") return val;
      if (typeof val === "number" || typeof val === "boolean")
        return String(val);
      if (Array.isArray(val)) {
        if (depth > 0)
          return val
            .map((v) => renderValue(v, depth + 1))
            .filter(Boolean)
            .join(", ");
        return val
          .map((v, i) => {
            const s = renderValue(v, depth + 1);
            return s ? `  ${i + 1}. ${s}` : "";
          })
          .filter(Boolean)
          .join("\n");
      }
      if (typeof val === "object") {
        const obj = val as Record<string, unknown>;
        // Common single-value wrappers
        const text =
          obj["@value"] ??
          obj["text"] ??
          obj["name"] ??
          obj["url"] ??
          obj["item"];
        if (text) return renderValue(text, depth + 1);
        return Object.entries(obj)
          .filter(([k]) => !SKIP.has(k))
          .map(([k, v]) => `${k}: ${renderValue(v, depth + 1)}`)
          .join(", ");
      }
      return String(val);
    };

    // Priority fields first
    for (const key of priorityFields) {
      if (key in item) {
        seen.add(key);
        const rendered = renderValue(item[key]);
        if (rendered) lines.push(`  ${key}: ${rendered}`);
      }
    }
    // Remaining fields
    for (const [key, val] of Object.entries(item)) {
      if (seen.has(key) || SKIP.has(key) || key === "@type") continue;
      const rendered = renderValue(val);
      if (rendered) lines.push(`  ${key}: ${rendered}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Build the structured context section
 */
export type ExtractMode =
  | "full"
  | "summary"
  | "interactives_only"
  | "forms_only"
  | "text_only"
  | "visible_only"
  | "results_only"
  | "glance";

export function chooseAgentReadMode(page: PageContent): ExtractMode {
  const pageType = detectPageType(page);
  switch (pageType) {
    case "SEARCH_RESULTS":
    case "PAGINATED_LIST":
      return "results_only";
    case "LOGIN":
    case "SEARCH_READY":
    case "SHOPPING":
    case "FORM":
      return "visible_only";
    case "ARTICLE":
      return "summary";
    case "GENERAL":
    default:
      return "visible_only";
  }
}

function isSearchOrListingPage(page: PageContent): boolean {
  const haystack = normalizeComparable(
    [
      page.url,
      page.title,
      page.excerpt,
      page.headings.map((heading) => heading.text).join(" "),
    ]
      .filter(Boolean)
      .join(" "),
  );

  return /\b(search|results|find|discover|browse|repositories|repository|issues|pull requests|prs|users|events|listings)\b/.test(
    haystack,
  );
}

function collectJsonLdEntityItems(
  input: unknown,
  results: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (!input) return results;

  if (Array.isArray(input)) {
    input.forEach((item) => collectJsonLdEntityItems(item, results));
    return results;
  }

  if (typeof input !== "object") return results;

  const item = input as Record<string, unknown>;
  const type = item["@type"];
  const types = Array.isArray(type) ? type : [type];
  const typeNames = types.filter(
    (entry): entry is string => typeof entry === "string",
  );

  if (
    (typeof item.name === "string" || typeof item.url === "string") &&
    !typeNames.some((entry) =>
      ["BreadcrumbList", "Organization", "WebSite", "WebPage"].includes(entry),
    )
  ) {
    results.push(item);
  }

  collectJsonLdEntityItems(item["@graph"], results);
  collectJsonLdEntityItems(item.mainEntity, results);
  collectJsonLdEntityItems(item.itemListElement, results);
  collectJsonLdEntityItems(item.item, results);

  return results;
}

function getResultCandidates(page: PageContent): InteractiveElement[] {
  const entityItems = collectJsonLdEntityItems(page.jsonLd ?? []);
  const entityNames = new Set(
    entityItems
      .map((item) =>
        typeof item.name === "string" ? normalizeComparable(item.name) : "",
      )
      .filter(Boolean),
  );
  const entityUrls = new Set(
    entityItems
      .map((item) =>
        typeof item.url === "string" ? normalizeUrlForMatch(item.url) : null,
      )
      .filter((value): value is string => Boolean(value)),
  );

  const pageHost = normalizeUrlForMatch(page.url);
  const searchOrListingPage = isSearchOrListingPage(page);

  const scored = page.interactiveElements
    .filter(
      (element) =>
        element.type === "link" && element.text?.trim() && element.href,
    )
    .map((element) => {
      const text = element.text?.trim() || "";
      const comparableText = normalizeComparable(text);
      const href = normalizeUrlForMatch(element.href);
      const haystack = normalizeComparable(
        [element.text, element.description, element.selector, element.href]
          .filter(Boolean)
          .join(" "),
      );

      let score = 0;

      if (entityNames.has(comparableText)) score += 6;
      if (href && entityUrls.has(href)) score += 6;
      if (
        entityItems.some((item) => {
          const name =
            typeof item.name === "string" ? normalizeComparable(item.name) : "";
          return (
            Boolean(name) &&
            (name.includes(comparableText) || comparableText.includes(name))
          );
        })
      ) {
        score += 4;
      }

      if (element.context === "article") score += 3;
      else if (element.context === "main" || element.context === "content")
        score += 1;

      if (href && pageHost) {
        try {
          if (new URL(href).origin === new URL(pageHost).origin) score += 1;
        } catch {
          // ignore malformed URLs
        }
      }

      const hrefSegments = getUrlPathSegments(element.href);
      if (hrefSegments.length >= 2) score += 1;
      if (text.includes("/")) score += 1;

      if (
        searchOrListingPage &&
        (element.context === "article" ||
          element.context === "main" ||
          element.context === "content")
      ) {
        score += 2;
      }

      if (/\b(card|tile|result|rating|review)\b/.test(haystack)) score += 1;
      if (
        /\b(item|list|row|repo|repository|issue|pull request|event)\b/.test(
          haystack,
        )
      ) {
        score += 1;
      }
      if (text.length >= 12 && text.split(/\s+/).length >= 2) score += 1;

      if (
        element.context === "nav" ||
        element.context === "header" ||
        element.context === "footer" ||
        element.context === "sidebar" ||
        element.context === "dialog"
      ) {
        score -= 5;
      }

      if (
        /\b(home|menu|about|contact|privacy|terms|login|sign in|sign up|subscribe|newsletter|facebook|instagram|pinterest|share|print|next|previous|prev|sort|filter|star|sponsor)\b/.test(
          comparableText,
        )
      ) {
        score -= 4;
      }

      return { element, score };
    })
    .filter(({ score, element }) => {
      if (entityItems.length > 0) return score >= 4;
      if (searchOrListingPage) {
        return (
          score >= 4 ||
          (score >= 3 &&
            (element.context === "article" ||
              element.context === "main" ||
              element.context === "content"))
        );
      }
      return score >= 4 || (score >= 3 && element.context === "article");
    })
    .sort(
      (a, b) =>
        b.score - a.score || (a.element.index ?? 0) - (b.element.index ?? 0),
    );

  const seen = new Set<string>();
  return scored
    .map(({ element }) => element)
    .filter((element) => {
      const key = `${normalizeComparable(element.text || "")}|${normalizeUrlForMatch(element.href) || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function buildScopedContext(
  page: PageContent,
  mode: ExtractMode,
): string {
  switch (mode) {
    case "summary": {
      const sections: string[] = [];
      const cartSnapshot = formatCartSnapshot(page);
      sections.push(`**URL:** ${page.url}`);
      sections.push(`**Title:** ${page.title}`);
      sections.push(`**Viewport:** ${formatViewport(page)}`);
      if (page.byline) sections.push(`**Author:** ${page.byline}`);
      if (page.excerpt) sections.push(`**Summary:** ${page.excerpt}`);
      const largePageHint = formatLargePageHint(page);
      if (largePageHint) sections.push(`**Reading Hint:** ${largePageHint}`);
      const scrollHints = getScrollHints(page);
      if (scrollHints.length > 0) {
        sections.push(`**Scroll Hint:** ${scrollHints[0]}`);
      }
      sections.push("");
      const summaryIntent = analyzePageIntent(page);
      if (summaryIntent) {
        sections.push(summaryIntent);
        sections.push("");
      }
      if (cartSnapshot) {
        sections.push("### Cart Snapshot");
        sections.push(cartSnapshot);
        sections.push("");
      }
      if ((page.pageIssues?.length ?? 0) > 0) {
        sections.push("### Page Access Warnings");
        sections.push(formatPageIssues(page.pageIssues ?? []));
        sections.push("");
      }
      sections.push("### Document Outline");
      sections.push(formatHeadings(page.headings));
      sections.push("");
      const summaryHighlights = getHighlightsForPage(page.url);
      sections.push(
        `Stats: ${page.interactiveElements.length} interactives, ${page.forms.length} forms, ${page.navigation.length} nav links, ${page.headings.length} headings, ${page.content.length} chars`,
      );
      if (summaryHighlights.length > 0) {
        sections.push("");
        sections.push("### Highlights & Annotations");
        sections.push(formatHighlights(summaryHighlights));
      }
      if ((page.structuredData?.length ?? 0) > 0) {
        if (hasOnlyFallbackStructuredData(page)) {
          const rawSources = [
            (page.jsonLd?.length ?? 0) > 0
              ? `${page.jsonLd!.length} JSON-LD`
              : "",
            (page.microdata?.length ?? 0) > 0
              ? `${page.microdata!.length} microdata`
              : "",
            (page.rdfa?.length ?? 0) > 0 ? `${page.rdfa!.length} RDFa` : "",
          ].filter(Boolean);
          if (rawSources.length > 0) {
            sections.push(
              `Structured data: generic page metadata only (raw sources present: ${rawSources.join(", ")} — use extract_structured_data or read_page with mode=structured for details)`,
            );
          } else {
            sections.push("Structured data: generic page metadata only");
          }
        } else {
          sections.push(
            `Structured entities: ${page.structuredData?.map((entity) => entity.types[0]).join(", ")}`,
          );
        }
      }
      if (page.overlays.length > 0) {
        sections.push(
          `Blocking overlays: ${page.overlays.filter((overlay) => overlay.blocksInteraction).length}`,
        );
      }
      if (page.dormantOverlays.length > 0) {
        sections.push(
          `Dormant consent/modal surfaces: ${page.dormantOverlays.length}`,
        );
      }
      return sections.join("\n");
    }

    case "interactives_only": {
      const sections: string[] = [];
      const quantityElements = getQuantityElements(page);
      const cartSnapshot = formatCartSnapshot(page);
      const dialogFocus = formatDialogFocus(page);
      sections.push(`**URL:** ${page.url}`);
      sections.push(`**Title:** ${page.title}`);
      sections.push(`**Viewport:** ${formatViewport(page)}`);
      const interactivesScrollHints = getScrollHints(page);
      if (interactivesScrollHints.length > 0) {
        sections.push(`**Scroll Hint:** ${interactivesScrollHints[0]}`);
      }
      sections.push("");
      const interactivesIntent = analyzePageIntent(page);
      if (interactivesIntent) {
        sections.push(interactivesIntent);
        sections.push("");
      }
      const interactivesHighlights = getHighlightsForPage(page.url);
      if (interactivesHighlights.length > 0) {
        sections.push("### Highlights & Annotations");
        sections.push(formatHighlights(interactivesHighlights));
        sections.push("");
      }
      if (cartSnapshot) {
        sections.push("### Cart Snapshot");
        sections.push(cartSnapshot);
        sections.push("");
      }
      if ((page.pageIssues?.length ?? 0) > 0) {
        sections.push("### Page Access Warnings");
        sections.push(formatPageIssues(page.pageIssues ?? []));
        sections.push("");
      }
      if (page.overlays.length > 0) {
        sections.push("### Active Overlays");
        sections.push(formatOverlays(page));
        sections.push("");
      }
      if (dialogFocus) {
        sections.push("### Immediate Overlay Actions");
        sections.push(dialogFocus);
        sections.push("");
      }
      if (page.dormantOverlays.length > 0) {
        sections.push("### Dormant Consent / Modal UI");
        sections.push(formatDormantOverlays(page.dormantOverlays));
        sections.push("");
      }
      if (page.navigation.length > 0) {
        sections.push("### Navigation");
        sections.push(formatNavigation(page.navigation));
        sections.push("");
      }
      if (quantityElements.length > 0) {
        sections.push("### Quantity / Count Controls");
        sections.push(formatQuantityElements(quantityElements));
        sections.push("");
      }
      if (page.interactiveElements.length > 0) {
        sections.push(
          `### Interactive Elements (${page.interactiveElements.length})`,
        );
        sections.push(formatInteractiveElements(page.interactiveElements));
      }
      return sections.join("\n");
    }

    case "forms_only": {
      const sections: string[] = [];
      const quantityElements = getQuantityElements(page);
      const cartSnapshot = formatCartSnapshot(page);
      sections.push(`**URL:** ${page.url}`);
      sections.push(`**Title:** ${page.title}`);
      sections.push(`**Viewport:** ${formatViewport(page)}`);
      const visibleScrollHints = getScrollHints(page);
      if (visibleScrollHints.length > 0) {
        sections.push(`**Scroll Hint:** ${visibleScrollHints[0]}`);
      }
      sections.push("");
      const formsHighlights = getHighlightsForPage(page.url);
      if (formsHighlights.length > 0) {
        sections.push("### Highlights & Annotations");
        sections.push(formatHighlights(formsHighlights));
        sections.push("");
      }
      if (cartSnapshot) {
        sections.push("### Cart Snapshot");
        sections.push(cartSnapshot);
        sections.push("");
      }
      if ((page.pageIssues?.length ?? 0) > 0) {
        sections.push("### Page Access Warnings");
        sections.push(formatPageIssues(page.pageIssues ?? []));
        sections.push("");
      }
      if (page.overlays.length > 0) {
        sections.push("### Active Overlays");
        sections.push(formatOverlays(page));
        sections.push("");
      }
      if (page.dormantOverlays.length > 0) {
        sections.push("### Dormant Consent / Modal UI");
        sections.push(formatDormantOverlays(page.dormantOverlays));
        sections.push("");
      }
      if (quantityElements.length > 0) {
        sections.push("### Quantity / Count Controls");
        sections.push(formatQuantityElements(quantityElements));
        sections.push("");
      }
      if (page.forms.length > 0) {
        sections.push(`### Forms (${page.forms.length})`);
        sections.push(formatForms(page.forms));
      } else {
        sections.push("No forms found on this page.");
      }
      return sections.join("\n");
    }

    case "text_only": {
      const sections: string[] = [];
      sections.push(`**URL:** ${page.url}`);
      sections.push(`**Title:** ${page.title}`);
      sections.push(`**Viewport:** ${formatViewport(page)}`);
      sections.push("");
      const textHighlights = getHighlightsForPage(page.url);
      if (textHighlights.length > 0) {
        sections.push("### Highlights & Annotations");
        sections.push(formatHighlights(textHighlights));
        sections.push("");
      }
      if ((page.pageIssues?.length ?? 0) > 0) {
        sections.push("### Page Access Warnings");
        sections.push(formatPageIssues(page.pageIssues ?? []));
        sections.push("");
      }
      const truncated =
        page.content.length > MAX_CONTEXT_CONTENT_LENGTH
          ? page.content.slice(0, MAX_CONTEXT_CONTENT_LENGTH) + "\n[Content truncated...]"
          : page.content;
      sections.push(truncated);
      return sections.join("\n");
    }

    case "visible_only": {
      const visibleElements = page.interactiveElements.filter(isVisibleToUser);
      const visibleNav = page.navigation.filter(isVisibleToUser);
      const dialogFocusedElements = getDialogFocusedElements(page);
      const visiblePage = {
        ...page,
        interactiveElements:
          dialogFocusedElements.length > 0
            ? dialogFocusedElements
            : visibleElements,
        forms: page.forms
          .map((form) => ({
            ...form,
            fields: form.fields.filter(
              (field) =>
                isVisibleToUser(field) &&
                (dialogFocusedElements.length === 0 ||
                  field.context === "dialog"),
            ),
          }))
          .filter((form) => form.fields.length > 0),
      };
      const quantityElements = getQuantityElements(visiblePage);
      const purchaseActions = getPurchaseActionElements(visiblePage, {
        visibleOnly: true,
      });
      const offscreenPurchaseActions = getOffscreenPurchaseActionElements(page);
      const cartSnapshot = formatCartSnapshot(visiblePage);
      const visibleForms = visiblePage.forms;
      const dialogFocus = formatDialogFocus(page);
      const sections: string[] = [];
      sections.push(`**URL:** ${page.url}`);
      sections.push(`**Title:** ${page.title}`);
      sections.push(`**Viewport:** ${formatViewport(page)}`);
      sections.push("");
      const visibleHighlights = getHighlightsForPage(page.url);
      if (visibleHighlights.length > 0) {
        sections.push("### Highlights & Annotations");
        sections.push(formatHighlights(visibleHighlights));
        sections.push("");
      }
      if (cartSnapshot) {
        sections.push("### Cart Snapshot");
        sections.push(cartSnapshot);
        sections.push("");
      }
      if ((page.pageIssues?.length ?? 0) > 0) {
        sections.push("### Page Access Warnings");
        sections.push(formatPageIssues(page.pageIssues ?? []));
        sections.push("");
      }
      if (page.overlays.length > 0) {
        sections.push("### Active Overlays");
        sections.push(formatOverlays(page));
        sections.push("");
      }
      if (dialogFocus) {
        sections.push("### Immediate Overlay Actions");
        sections.push(dialogFocus);
        if (visibleElements.length > dialogFocusedElements.length) {
          sections.push("");
          sections.push(
            `Background controls hidden while the dialog is active: ${visibleElements.length - dialogFocusedElements.length}`,
          );
        }
        sections.push("");
      }
      if (page.dormantOverlays.length > 0) {
        sections.push("### Dormant Consent / Modal UI");
        sections.push(formatDormantOverlays(page.dormantOverlays));
        sections.push("");
      }
      if (visibleNav.length > 0) {
        sections.push("### Visible Navigation");
        sections.push(formatNavigation(visibleNav));
        sections.push("");
      }
      if (quantityElements.length > 0) {
        sections.push("### Quantity / Count Controls");
        sections.push(formatQuantityElements(quantityElements));
        sections.push("");
      }
      if (purchaseActions.length > 0) {
        sections.push("### Primary Purchase Actions");
        sections.push(formatInteractiveElements(purchaseActions));
        sections.push("");
      }
      if (offscreenPurchaseActions.length > 0) {
        sections.push("### Offscreen Purchase Actions");
        sections.push(
          "These purchase controls are present on the page but currently outside the viewport. You can scroll to reveal them or click them by index.",
        );
        sections.push(formatInteractiveElements(offscreenPurchaseActions));
        sections.push("");
      }
      if (visiblePage.interactiveElements.length > 0) {
        sections.push(
          `### Visible In-Viewport Interactive Elements (${visiblePage.interactiveElements.length})`,
        );
        sections.push(
          formatInteractiveElements(visiblePage.interactiveElements),
        );
        sections.push("");
      }
      if (visibleForms.length > 0) {
        sections.push("### Visible Forms");
        sections.push(formatForms(visibleForms));
      } else if (visibleElements.length === 0 && visibleNav.length === 0) {
        sections.push(
          "No currently visible, unobstructed interactive elements were detected in the viewport.",
        );
      }
      return sections.join("\n");
    }

    case "results_only": {
      const resultElements = getResultCandidates(page);
      const sections: string[] = [];
      sections.push(`**URL:** ${page.url}`);
      sections.push(`**Title:** ${page.title}`);
      sections.push(`**Viewport:** ${formatViewport(page)}`);
      sections.push("");
      const resultsHighlights = getHighlightsForPage(page.url);
      if (resultsHighlights.length > 0) {
        sections.push("### Highlights & Annotations");
        sections.push(formatHighlights(resultsHighlights));
        sections.push("");
      }
      if ((page.pageIssues?.length ?? 0) > 0) {
        sections.push("### Page Access Warnings");
        sections.push(formatPageIssues(page.pageIssues ?? []));
        sections.push("");
      }
      if (resultElements.length > 0) {
        sections.push(`### Likely Search Results (${resultElements.length})`);
        sections.push(formatInteractiveElements(resultElements));
      } else {
        sections.push(
          "No likely primary result links were detected on this page.",
        );
      }
      return sections.join("\n");
    }

    case "full":
    default:
      return buildStructuredContext(page);
  }
}

/**
 * Speedee System — Page type classification.
 * Exported so the tool pruner can dynamically reorder tools for the current context.
 */
export type PageType =
  | "LOGIN"
  | "SEARCH_READY"
  | "SEARCH_RESULTS"
  | "SHOPPING"
  | "FORM"
  | "PAGINATED_LIST"
  | "ARTICLE"
  | "GENERAL";

export function detectPageType(page: PageContent): PageType {
  const url = page.url.toLowerCase();
  const hasPasswordField = page.forms.some((f) =>
    f.fields.some((el) => el.inputType === "password"),
  );
  const searchInputs = page.interactiveElements.filter(
    (el) =>
      el.inputType === "search" ||
      el.name === "q" ||
      el.name === "query" ||
      el.name === "search" ||
      (el.placeholder || "").toLowerCase().includes("search"),
  );
  const hasSearchInput =
    searchInputs.length > 0 ||
    page.forms.some((f) =>
      f.fields.some(
        (el) =>
          el.inputType === "search" || el.name === "q" || el.name === "query",
      ),
    );
  const hasVisibleSearchInput = searchInputs.some(
    (el) =>
      el.visible === true &&
      el.inViewport === true &&
      el.obscured !== true &&
      el.blockedByOverlay !== true,
  );
  const formCount = page.forms.length;
  const hasCart =
    page.interactiveElements.some(
      (el) =>
        (el.text || "").toLowerCase().includes("cart") ||
        (el.text || "").toLowerCase().includes("checkout"),
    ) ||
    url.includes("cart") ||
    url.includes("checkout");
  const contentLinks = page.interactiveElements.filter(
    (el) =>
      el.type === "link" &&
      el.context !== "nav" &&
      el.context !== "header" &&
      el.context !== "sidebar" &&
      (el.href || "").startsWith("http"),
  );
  const hasResults = contentLinks.length > 10;
  const hasPagination = page.interactiveElements.some(
    (el) =>
      (el.text || "").toLowerCase() === "next" ||
      el.text === "›" ||
      el.text === "»" ||
      (el.label || "").toLowerCase().includes("next page"),
  );
  const listingLike =
    isSearchOrListingPage(page) ||
    hasPagination ||
    /[?&](d|q|query|search)=/.test(url) ||
    /\/(search|results)\b/.test(url) ||
    /\/p\/pl\b/.test(url);

  if (hasPasswordField) return "LOGIN";
  if (hasSearchInput && hasVisibleSearchInput && !listingLike) {
    return "SEARCH_READY";
  }
  if (hasResults && hasSearchInput && listingLike) return "SEARCH_RESULTS";
  if (hasCart) return "SHOPPING";
  if (formCount > 0 && !hasPasswordField) return "FORM";
  if (hasPagination && listingLike) return "PAGINATED_LIST";
  if (hasSearchInput && !listingLike) return "SEARCH_READY";
  if (page.content.length > 3000 && page.interactiveElements.length < 10)
    return "ARTICLE";
  return "GENERAL";
}

/**
 * Speedee System — Semantic Page Analysis
 * Detects page intent and suggests the most relevant actions,
 * so agents spend zero tokens deciding *which* tool to use.
 */
function analyzePageIntent(page: PageContent): string {
  const hints: string[] = [];
  const pageType = detectPageType(page);
  const hasPagination = page.interactiveElements.some(
    (el) =>
      (el.text || "").toLowerCase() === "next" ||
      el.text === "›" ||
      el.text === "»" ||
      (el.label || "").toLowerCase().includes("next page"),
  );

  switch (pageType) {
    case "LOGIN": {
      hints.push("Page type: LOGIN/SIGNUP");
      hints.push(
        "Suggested: vessel_login or vessel_fill_form → auto-fills credentials and submits",
      );
      const userField = page.forms
        .flatMap((f) => f.fields)
        .find(
          (el) =>
            el.inputType === "email" ||
            el.name === "email" ||
            el.name === "username" ||
            el.autocomplete === "username",
        );
      if (userField) {
        hints.push(
          `Username field: #${userField.index} [${userField.label || userField.name || userField.placeholder || "input"}]`,
        );
      }
      break;
    }
    case "SEARCH_READY":
      hints.push("Page type: SEARCH READY");
      hints.push(
        "Suggested: vessel_search → auto-finds search box, types query, and submits",
      );
      hints.push(
        "Treat the visible site search box as the primary navigation control before jumping to direct URLs.",
      );
      break;
    case "SEARCH_RESULTS":
      hints.push("Page type: SEARCH RESULTS");
      hints.push(
        "Suggested: click a result link, or vessel_paginate for more results",
      );
      if (hasPagination)
        hints.push("Pagination detected — vessel_paginate available");
      break;
    case "SHOPPING":
      hints.push("Page type: SHOPPING/CHECKOUT");
      hints.push("Suggested: vessel_fill_form for payment/address fields");
      break;
    case "FORM": {
      const formCount = page.forms.length;
      const totalFields = page.forms.reduce((n, f) => n + f.fields.length, 0);
      hints.push(
        `Page type: FORM (${formCount} form${formCount > 1 ? "s" : ""}, ${totalFields} fields)`,
      );
      hints.push("Suggested: vessel_fill_form → fill all fields in one call");
      break;
    }
    case "PAGINATED_LIST":
      hints.push("Page type: PAGINATED LIST");
      hints.push("Suggested: vessel_paginate to navigate between pages");
      break;
    case "ARTICLE":
      hints.push("Page type: ARTICLE/CONTENT");
      hints.push("Suggested: vessel_extract_content for readable text");
      break;
  }

  if (hints.length === 0) return "";
  return `### Page Intent (Speedee)\n${hints.join("\n")}`;
}

export function buildStructuredContext(page: PageContent): string {
  const sections: string[] = [];

  // Page Overview
  sections.push("## PAGE STRUCTURE");
  sections.push("");
  sections.push(
    "**User Focus:** This page is from the active tab currently visible to the human user.",
  );
  sections.push(`**URL:** ${page.url}`);
  sections.push(`**Title:** ${page.title}`);
  sections.push(`**Viewport:** ${formatViewport(page)}`);
  if (page.byline) sections.push(`**Author:** ${page.byline}`);
  if (page.excerpt) sections.push(`**Summary:** ${page.excerpt}`);
  const structuredScrollHints = getScrollHints(page);
  if (structuredScrollHints.length > 0) {
    sections.push(`**Scroll Hint:** ${structuredScrollHints[0]}`);
  }
  sections.push("");

  // Speedee semantic hints
  const pageIntent = analyzePageIntent(page);
  if (pageIntent) {
    sections.push(pageIntent);
    sections.push("");
  }

  if ((page.pageIssues?.length ?? 0) > 0) {
    sections.push("### Page Access Warnings");
    sections.push(formatPageIssues(page.pageIssues ?? []));
    sections.push("");
  }

  const largePageHint = formatLargePageHint(page);
  if (largePageHint) {
    sections.push("### Reading Hint");
    sections.push(largePageHint);
    sections.push("");
  }

  if (page.structuredData && page.structuredData.length > 0) {
    sections.push(
      hasOnlyFallbackStructuredData(page)
        ? "### Page Metadata"
        : "### Structured Data",
    );
    sections.push(formatStructuredEntities(page.structuredData));
    sections.push("");
  } else if (page.jsonLd && page.jsonLd.length > 0) {
    sections.push("### Structured Data (Raw JSON-LD)");
    sections.push(formatJsonLd(page.jsonLd));
    sections.push("");
  }

  // Headings
  sections.push("### Document Outline (Headings)");
  sections.push(formatHeadings(page.headings));
  sections.push("");

  // Navigation
  sections.push("### Navigation");
  sections.push(formatNavigation(page.navigation));
  sections.push("");

  // Landmarks
  sections.push("### Page Landmarks (ARIA)");
  sections.push(formatLandmarks(page.landmarks));
  sections.push("");

  sections.push("### Active Overlays / Modals");
  sections.push(formatOverlays(page));
  sections.push("");

  sections.push("### Dormant Consent / Modal UI");
  sections.push(formatDormantOverlays(page.dormantOverlays));
  sections.push("");

  // Highlights (user + agent annotations)
  const fullHighlights = getHighlightsForPage(page.url);
  if (fullHighlights.length > 0) {
    sections.push("### Highlights & Annotations");
    sections.push(formatHighlights(fullHighlights));
    sections.push("");
  }

  // Interactive Elements
  if (page.interactiveElements.length > 0) {
    sections.push("### Interactive Elements");
    sections.push(
      `Found ${page.interactiveElements.length} interactive elements:`,
    );
    sections.push(formatInteractiveElements(page.interactiveElements));
    sections.push("");
  }

  // Forms
  if (page.forms.length > 0) {
    sections.push("### Forms");
    sections.push(formatForms(page.forms));
    sections.push("");
  }

  // Content stats
  sections.push("---");
  sections.push(`**Content Length:** ${page.content.length} characters`);
  sections.push(`**Navigation Links:** ${page.navigation.length}`);
  sections.push(`**Interactive Elements:** ${page.interactiveElements.length}`);
  sections.push(`**Forms:** ${page.forms.length}`);
  sections.push(
    `**Visible In-Viewport Elements:** ${page.interactiveElements.filter(isVisibleToUser).length}`,
  );
  sections.push(
    `**Blocking Overlays:** ${page.overlays.filter((overlay) => overlay.blocksInteraction).length}`,
  );
  sections.push(
    `**Dormant Consent / Modal UI:** ${page.dormantOverlays.length}`,
  );
  sections.push(`**Landmarks:** ${page.landmarks.length}`);

  return sections.join("\n");
}

export function buildSummarizePrompt(page: PageContent): {
  system: string;
  user: string;
} {
  const structuredContext = buildStructuredContext(page);

  return {
    system:
      "You are Vessel, an AI browsing assistant. Analyze the provided web page context and provide a comprehensive summary. Use the structured page information (headings, navigation, interactive elements) to understand the page organization.",
    user: `${structuredContext}

## PAGE CONTENT

${truncateContent(page.content)}

---

**Task:** Summarize this web page based on the structure and content above. Identify the main purpose, key sections, and important interactive elements.`,
  };
}

export function buildQuestionPrompt(
  page: PageContent,
  question: string,
): { system: string; user: string } {
  const structuredContext = buildStructuredContext(page);

  return {
    system:
      "You are Vessel, an AI browsing assistant. Use the provided page structure and content to answer questions accurately. You can reference specific elements by their labels or positions.",
    user: `${structuredContext}

## PAGE CONTENT

${truncateContent(page.content)}

---

**Question:** ${question}

**Instructions:** Answer based on the page structure and content above. If the question asks about interactive elements, forms, or navigation, use the structured context to provide specific details.`,
  };
}

export function buildGeneralPrompt(query: string): {
  system: string;
  user: string;
} {
  return {
    system:
      "You are Vessel, an AI assistant embedded in a web browser. You can normally see the content of the page the user is viewing, but no page is currently active. Help the user with their browsing needs. Be concise and helpful.",
    user: query,
  };
}
