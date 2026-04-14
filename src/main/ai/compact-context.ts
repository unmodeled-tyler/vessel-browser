import type { InteractiveElement, PageContent } from "../../shared/types";
import {
  detectPageType,
  type ExtractMode,
  type PageType,
} from "./context-builder";
import { getCompactPrimaryResultLinks } from "./compact-listing";

const MAX_RESULTS = 6;
const MAX_CONTROLS = 8;
const MAX_FIELDS = 8;
const MAX_HEADINGS = 5;
const MAX_TEXT_CHARS = 420;

function compactText(value: string | undefined, max = MAX_TEXT_CHARS): string {
  const text = (value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isVisibleElement(element: InteractiveElement): boolean {
  return (
    element.visible !== false &&
    element.inViewport !== false &&
    element.blockedByOverlay !== true &&
    element.obscured !== true
  );
}

function elementLabel(element: InteractiveElement): string {
  return (
    compactText(
      element.text ||
        element.label ||
        element.placeholder ||
        element.name ||
        element.href ||
        element.description,
      96,
    ) || "Element"
  );
}

function formatElement(element: InteractiveElement): string {
  const prefix = element.index != null ? `[#${element.index}] ` : "";
  const kind =
    element.type === "input"
      ? `${element.inputType || "text"} input`
      : element.type === "select"
        ? "select"
        : element.type;
  const href = element.type === "link" && element.href ? ` -> ${element.href}` : "";
  return `${prefix}${elementLabel(element)} (${kind})${href}`;
}

function uniqueElements(elements: InteractiveElement[]): InteractiveElement[] {
  const seen = new Set<string>();
  return elements.filter((element) => {
    const key = `${element.index ?? ""}|${element.type}|${elementLabel(element)}|${element.href ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPaginationLike(element: InteractiveElement): boolean {
  const text = `${element.text || ""} ${element.label || ""}`.toLowerCase();
  return /\b(next|prev|previous|load more|more results)\b/.test(text);
}

function getPrimaryResultLinks(page: PageContent): InteractiveElement[] {
  return uniqueElements(
    getCompactPrimaryResultLinks(page, {
      visibleOnly: true,
      max: MAX_RESULTS,
    }).filter((element) => !isPaginationLike(element)),
  );
}

function isPurchaseControl(element: InteractiveElement): boolean {
  const text = `${element.text || ""} ${element.label || ""}`.toLowerCase();
  return /\b(add to cart|add to bag|add to basket|buy now|checkout|view cart)\b/.test(
    text,
  );
}

function isAddToCartControl(element: InteractiveElement): boolean {
  const text = `${element.text || ""} ${element.label || ""}`.toLowerCase();
  return /\badd to cart|add to bag|add to basket\b/.test(text);
}

function looksLikeProductDetailPage(page: PageContent): boolean {
  return /\/book\//i.test(page.url) || /\bbook\b/i.test(page.title);
}

function hasCartConfirmationState(page: PageContent): boolean {
  const haystack = compactText(
    [
      page.url,
      page.title,
      page.excerpt,
      page.content.slice(0, 1200),
      page.overlays
        .map((overlay) => overlay.label || overlay.message || overlay.text || overlay.kind || "")
        .join(" "),
    ]
      .filter(Boolean)
      .join(" "),
    1600,
  ).toLowerCase();

  return (
    /\/cart\b/.test(page.url.toLowerCase()) ||
    /\b(cart confirmation|added to cart|added to bag|added to basket|continue shopping|shopping cart|view cart|checkout)\b/.test(
      haystack,
    )
  );
}

function getVisibleControls(page: PageContent): InteractiveElement[] {
  return uniqueElements(page.interactiveElements.filter(isVisibleElement)).slice(
    0,
    MAX_CONTROLS,
  );
}

function getVisiblePurchaseControls(page: PageContent): InteractiveElement[] {
  // Scan ALL interactive elements for purchase controls, not just the first
  // MAX_CONTROLS visible ones. Purchase controls like "Add to Cart" are
  // critical and may appear late in the DOM after many other interactive elements.
  return uniqueElements(
    page.interactiveElements
      .filter(isVisibleElement)
      .filter(isPurchaseControl)
      .sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER)),
  ).slice(0, 6);
}

function getOffscreenPurchaseControls(page: PageContent): InteractiveElement[] {
  const visibleKeys = new Set(getVisiblePurchaseControls(page).map(controlKey));

  return uniqueElements(
    page.interactiveElements
      .filter((element) => isPurchaseControl(element))
      .filter((element) => element.blockedByOverlay !== true)
      .filter((element) => element.visible !== false)
      .filter((element) => !visibleKeys.has(controlKey(element)))
      .sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER)),
  ).slice(0, 4);
}

function controlKey(element: InteractiveElement): string {
  return `${element.index ?? ""}|${element.type}|${elementLabel(element)}|${element.href ?? ""}`;
}

function isLowValueListingControl(element: InteractiveElement): boolean {
  const label = elementLabel(element).toLowerCase();
  // Penalize filter/sort controls. Avoid blocking common book title words
  // like "new", "good", "edition" — only block clearly filter-specific terms.
  return /\b(filter|sort|format|price|availability|signed edition|binding|language|refine|clear all|remove filter)\b/.test(
    label,
  );
}

function getVisibleFormFields(page: PageContent): InteractiveElement[] {
  return uniqueElements(
    page.forms.flatMap((form) => form.fields).filter(isVisibleElement),
  ).slice(0, MAX_FIELDS);
}

function pushSection(
  lines: string[],
  title: string,
  items: string[],
): void {
  if (items.length === 0) return;
  lines.push("");
  lines.push(title);
  lines.push(...items.map((item) => `- ${item}`));
}

function buildTextSnapshot(page: PageContent): string[] {
  const excerpt = compactText(page.excerpt);
  if (excerpt) return [excerpt];

  const content = compactText(page.content);
  return content ? [content] : [];
}

export function buildCompactScopedContext(
  page: PageContent,
  mode: ExtractMode,
  pageType: PageType = detectPageType(page),
): string {
  const lines: string[] = [
    `**URL:** ${page.url}`,
    `**Title:** ${page.title}`,
    `**Page Type:** ${pageType}`,
    `**Mode:** ${mode}`,
  ];

  if (page.byline) {
    lines.push(`**Author:** ${compactText(page.byline, 120)}`);
  }

  const warnings = (page.pageIssues || [])
    .slice(0, 3)
    .map((issue) => compactText(issue.summary, 140));
  pushSection(lines, "### Access Warnings", warnings);

  const blockingOverlays = page.overlays
    .filter((overlay) => overlay.blocksInteraction)
    .slice(0, 3)
    .map((overlay) =>
      compactText(
        overlay.label || overlay.message || overlay.text || overlay.kind || overlay.type,
        140,
      ),
    );
  pushSection(lines, "### Immediate Blockers", blockingOverlays);

  const visiblePurchaseControls = getVisiblePurchaseControls(page);
  const offscreenPurchaseControls = getOffscreenPurchaseControls(page);
  const purchaseControls = visiblePurchaseControls.map(formatElement);
  const addToCartVisible = visiblePurchaseControls.some(isAddToCartControl);
  const addToCartOffscreen = offscreenPurchaseControls.some(isAddToCartControl);
  if (looksLikeProductDetailPage(page) && !hasCartConfirmationState(page)) {
    if (addToCartVisible) {
      pushSection(lines, "### Action Status", [
        "Product detail page open. This item is not in the cart yet.",
        "Click Add to Cart and wait for cart confirmation before moving on.",
      ]);
    } else if (addToCartOffscreen) {
      pushSection(lines, "### Action Status", [
        "Product detail page open. This item is not in the cart yet.",
        "Add to Cart is present but outside the current viewport.",
        "Scroll once or use the offscreen purchase control below, then wait for cart confirmation.",
      ]);
    }
  }
  pushSection(lines, "### Visible Purchase Controls", purchaseControls);
  pushSection(
    lines,
    "### Offscreen Purchase Actions",
    offscreenPurchaseControls.map(formatElement),
  );

  const primaryResultElements = getPrimaryResultLinks(page);
  const primaryResults = primaryResultElements.map(formatElement);
  if (primaryResults.length > 0) {
    lines.push("");
    lines.push("### Results — click one of these to open a product");
    lines.push(...primaryResults.map((item) => `- ${item}`));
    lines.push("");
    lines.push("IMPORTANT: Use click(index=N) on a result above. Do NOT click filter or sort links.");
  }

  if (
    pageType === "FORM" ||
    pageType === "LOGIN" ||
    mode === "forms_only"
  ) {
    pushSection(
      lines,
      "### Form Fields",
      getVisibleFormFields(page).map(formatElement),
    );
  }

  if (
    mode === "visible_only" ||
    mode === "interactives_only" ||
    pageType === "SEARCH_READY" ||
    pageType === "GENERAL"
  ) {
    const primaryResultKeys = new Set(primaryResultElements.map(controlKey));
    const visibleControls = getVisibleControls(page)
      .filter((element) => !primaryResultKeys.has(controlKey(element)))
      .filter((element) =>
        primaryResultElements.length > 0 ? !isLowValueListingControl(element) : true,
      )
      .map(formatElement);
    pushSection(
      lines,
      "### Page Controls (filters, sorts — avoid when selecting products)",
      visibleControls,
    );
  }

  const headingItems = page.headings
    .slice(0, MAX_HEADINGS)
    .map((heading) => `H${heading.level}: ${compactText(heading.text, 100)}`);
  pushSection(lines, "### Top Headings", headingItems);

  if (mode === "summary" || mode === "text_only" || lines.length <= 6) {
    pushSection(lines, "### Text Snapshot", buildTextSnapshot(page));
  }

  lines.push("");
  lines.push(
    `Stats: ${page.interactiveElements.length} interactives, ${page.forms.length} forms, ${page.navigation.length} nav links, ${page.headings.length} headings`,
  );

  return lines.join("\n");
}
