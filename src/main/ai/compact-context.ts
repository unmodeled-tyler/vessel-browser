import type { InteractiveElement, PageContent } from "../../shared/types";
import {
  detectPageType,
  type ExtractMode,
  type PageType,
} from "./context-builder";

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
    page.interactiveElements.filter(
      (element) =>
        element.type === "link" &&
        isVisibleElement(element) &&
        element.context !== "nav" &&
        element.context !== "footer" &&
        !isPaginationLike(element) &&
        Boolean((element.text || "").trim()),
    ),
  ).slice(0, MAX_RESULTS);
}

function isPurchaseControl(element: InteractiveElement): boolean {
  if (!isVisibleElement(element)) return false;
  const text = `${element.text || ""} ${element.label || ""}`.toLowerCase();
  return /\b(add to cart|add to bag|add to basket|buy now|checkout|view cart)\b/.test(
    text,
  );
}

function getVisibleControls(page: PageContent): InteractiveElement[] {
  return uniqueElements(page.interactiveElements.filter(isVisibleElement)).slice(
    0,
    MAX_CONTROLS,
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

  const purchaseControls = getVisibleControls(page)
    .filter(isPurchaseControl)
    .slice(0, 4)
    .map(formatElement);
  pushSection(lines, "### Visible Purchase Controls", purchaseControls);

  if (pageType === "SEARCH_RESULTS" || mode === "results_only") {
    pushSection(
      lines,
      "### Primary Results",
      getPrimaryResultLinks(page).map(formatElement),
    );
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
    pushSection(
      lines,
      "### Visible Controls",
      getVisibleControls(page).map(formatElement),
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
