import type {
  PageContent,
  InteractiveElement,
  HeadingStructure,
} from "../../shared/types";

const MAX_CONTENT_LENGTH = 60000; // ~15k tokens rough estimate
const MAX_STRUCTURED_ITEMS = 100; // Limit structured elements to keep context manageable

function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_LENGTH) return content;
  return (
    content.slice(0, MAX_CONTENT_LENGTH) +
    "\n\n[Content truncated for length...]"
  );
}

function limitItems<T>(items: T[], max: number = MAX_STRUCTURED_ITEMS): T[] {
  if (items.length <= max) return items;
  return items.slice(0, max);
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
  if (el.description) {
    meta.push(`desc="${el.description.slice(0, 80)}"`);
  }
  if (el.value) {
    meta.push(`value="${el.value.slice(0, 60)}"`);
  }
  if (el.selector) {
    const selectorHint =
      el.selector.length > 80 ? `${el.selector.slice(0, 77)}...` : el.selector;
    meta.push(`selector="${selectorHint}"`);
  }
  return meta;
}

function isVisibleToUser(el: InteractiveElement): boolean {
  return (
    el.visible === true &&
    el.inViewport === true &&
    el.obscured !== true &&
    el.blockedByOverlay !== true
  );
}

/**
 * Format interactive elements into a readable structure
 */
function formatInteractiveElements(elements: InteractiveElement[]): string {
  if (elements.length === 0) return "None";

  const items = limitItems(elements, 50);

  return items
    .map((el) => {
      const prefix = el.index ? `[#${el.index}]` : "-";
      const parts: string[] = [prefix];

      if (el.type === "button") {
        parts.push(`[${el.text || "Button"}]`);
        parts.push("button");
      } else if (el.type === "link") {
        parts.push(`[${el.text || "Link"}]`);
        parts.push("link");
        if (el.href) parts.push(`→ ${el.href}`);
      } else if (el.type === "input") {
        parts.push(`[${el.label || el.placeholder || "Input"}]`);
        parts.push(el.inputType || "text");
        parts.push("input");
        if (el.required) parts.push("(required)");
      } else if (el.type === "select") {
        parts.push(`[${el.label || "Select"}]`);
        parts.push("dropdown");
        if (el.options?.length) {
          parts.push(`options=${el.options.slice(0, 5).join("|")}`);
        }
      } else if (el.type === "textarea") {
        parts.push(`[${el.label || "Text Area"}]`);
        parts.push("textarea");
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
            fieldParts.push("button");
          } else if (field.type === "input") {
            fieldParts.push(`[${field.label || field.placeholder || "Input"}]`);
            fieldParts.push(field.inputType || "text");
            if (field.required) fieldParts.push("(required)");
          } else if (field.type === "select") {
            fieldParts.push(`[${field.label || "Select"}]`);
            fieldParts.push("dropdown");
            if (field.options?.length) {
              fieldParts.push(`options=${field.options.slice(0, 5).join("|")}`);
            }
          } else if (field.type === "textarea") {
            fieldParts.push(`[${field.label || "Text"}]`);
            fieldParts.push("textarea");
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

function formatOverlays(overlays: PageContent["overlays"]): string {
  if (overlays.length === 0) return "None detected";

  const items = limitItems(overlays, 10);
  return items
    .map((overlay) => {
      const parts = [`- ${overlay.type}`];
      if (overlay.role) parts.push(`role=${overlay.role}`);
      if (overlay.blocksInteraction) parts.push("blocking");
      if (overlay.label) parts.push(`label="${overlay.label.slice(0, 80)}"`);
      if (overlay.text) parts.push(`text="${overlay.text.slice(0, 100)}"`);
      return parts.join(" ");
    })
    .join("\n");
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

function formatJsonLd(items: Record<string, unknown>[]): string {
  if (!items || items.length === 0) return "";

  const lines: string[] = [];

  // Fields to omit as too noisy for agents
  const SKIP = new Set(["@context", "image", "logo", "thumbnail", "potentialAction"]);

  // Type-specific field priority (shown first)
  const TYPE_FIELDS: Record<string, string[]> = {
    Recipe: ["name", "url", "description", "recipeYield", "totalTime", "cookTime", "prepTime", "recipeIngredient", "recipeInstructions"],
    Article: ["headline", "name", "url", "datePublished", "dateModified", "author", "description"],
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
      if (typeof val === "number" || typeof val === "boolean") return String(val);
      if (Array.isArray(val)) {
        if (depth > 0) return val.map((v) => renderValue(v, depth + 1)).filter(Boolean).join(", ");
        return val.map((v, i) => {
          const s = renderValue(v, depth + 1);
          return s ? `  ${i + 1}. ${s}` : "";
        }).filter(Boolean).join("\n");
      }
      if (typeof val === "object") {
        const obj = val as Record<string, unknown>;
        // Common single-value wrappers
        const text = obj["@value"] ?? obj["text"] ?? obj["name"] ?? obj["url"] ?? obj["item"];
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
  | "results_only";

function normalizeComparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeUrlForMatch(value?: string): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`.toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase() || null;
  }
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
  const typeNames = types.filter((entry): entry is string => typeof entry === "string");

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

  const scored = page.interactiveElements
    .filter(
      (element) => element.type === "link" && element.text?.trim() && element.href,
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
          const name = typeof item.name === "string" ? normalizeComparable(item.name) : "";
          return Boolean(name) && (name.includes(comparableText) || comparableText.includes(name));
        })
      ) {
        score += 4;
      }

      if (element.context === "article") score += 3;
      else if (element.context === "main" || element.context === "content") score += 1;

      if (href && pageHost) {
        try {
          if (new URL(href).origin === new URL(pageHost).origin) score += 1;
        } catch {
          // ignore malformed URLs
        }
      }

      if (/\b(card|tile|result|rating|review)\b/.test(haystack)) score += 1;
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
        /\b(home|menu|about|contact|privacy|terms|login|sign in|sign up|subscribe|newsletter|facebook|instagram|pinterest|share|print)\b/.test(
          comparableText,
        )
      ) {
        score -= 4;
      }

      return { element, score };
    })
    .filter(({ score, element }) => {
      if (entityItems.length > 0) return score >= 4;
      return score >= 4 || (score >= 3 && element.context === "article");
    })
    .sort((a, b) => b.score - a.score || (a.element.index ?? 0) - (b.element.index ?? 0));

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
      sections.push(`**URL:** ${page.url}`);
      sections.push(`**Title:** ${page.title}`);
      sections.push(`**Viewport:** ${formatViewport(page)}`);
      if (page.byline) sections.push(`**Author:** ${page.byline}`);
      if (page.excerpt) sections.push(`**Summary:** ${page.excerpt}`);
      sections.push("");
      sections.push("### Document Outline");
      sections.push(formatHeadings(page.headings));
      sections.push("");
      sections.push(
        `Stats: ${page.interactiveElements.length} interactives, ${page.forms.length} forms, ${page.navigation.length} nav links, ${page.content.length} chars`,
      );
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
      sections.push(`**URL:** ${page.url}`);
      sections.push(`**Title:** ${page.title}`);
      sections.push(`**Viewport:** ${formatViewport(page)}`);
      sections.push("");
      if (page.overlays.length > 0) {
        sections.push("### Active Overlays");
        sections.push(formatOverlays(page.overlays));
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
      sections.push(`**URL:** ${page.url}`);
      sections.push(`**Title:** ${page.title}`);
      sections.push(`**Viewport:** ${formatViewport(page)}`);
      sections.push("");
      if (page.overlays.length > 0) {
        sections.push("### Active Overlays");
        sections.push(formatOverlays(page.overlays));
        sections.push("");
      }
      if (page.dormantOverlays.length > 0) {
        sections.push("### Dormant Consent / Modal UI");
        sections.push(formatDormantOverlays(page.dormantOverlays));
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
      const truncated =
        page.content.length > 60000
          ? page.content.slice(0, 60000) + "\n[Content truncated...]"
          : page.content;
      sections.push(truncated);
      return sections.join("\n");
    }

    case "visible_only": {
      const visibleElements = page.interactiveElements.filter(isVisibleToUser);
      const visibleNav = page.navigation.filter(isVisibleToUser);
      const visibleForms = page.forms
        .map((form) => ({
          ...form,
          fields: form.fields.filter(isVisibleToUser),
        }))
        .filter((form) => form.fields.length > 0);
      const sections: string[] = [];
      sections.push(`**URL:** ${page.url}`);
      sections.push(`**Title:** ${page.title}`);
      sections.push(`**Viewport:** ${formatViewport(page)}`);
      sections.push("");
      if (page.overlays.length > 0) {
        sections.push("### Active Overlays");
        sections.push(formatOverlays(page.overlays));
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
      if (visibleElements.length > 0) {
        sections.push(
          `### Visible In-Viewport Interactive Elements (${visibleElements.length})`,
        );
        sections.push(formatInteractiveElements(visibleElements));
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
      if (resultElements.length > 0) {
        sections.push(`### Likely Search Results (${resultElements.length})`);
        sections.push(formatInteractiveElements(resultElements));
      } else {
        sections.push("No likely primary result links were detected on this page.");
      }
      return sections.join("\n");
    }

    case "full":
    default:
      return buildStructuredContext(page);
  }
}

export function buildStructuredContext(page: PageContent): string {
  const sections: string[] = [];

  // Page Overview
  sections.push("## PAGE STRUCTURE");
  sections.push("");
  sections.push(`**URL:** ${page.url}`);
  sections.push(`**Title:** ${page.title}`);
  sections.push(`**Viewport:** ${formatViewport(page)}`);
  if (page.byline) sections.push(`**Author:** ${page.byline}`);
  if (page.excerpt) sections.push(`**Summary:** ${page.excerpt}`);
  sections.push("");

  // Structured data (JSON-LD)
  if (page.jsonLd && page.jsonLd.length > 0) {
    sections.push("### Structured Data (JSON-LD)");
    sections.push(formatJsonLd(page.jsonLd));
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
  sections.push(formatOverlays(page.overlays));
  sections.push("");

  sections.push("### Dormant Consent / Modal UI");
  sections.push(formatDormantOverlays(page.dormantOverlays));
  sections.push("");

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
