import type { PageContent, InteractiveElement, StructuredDataEntity } from "./types";

export type PageType =
  | "article"
  | "product"
  | "form"
  | "search"
  | "checkout"
  | "login"
  | "dashboard"
  | "unknown";

export interface FormField {
  name: string;
  type: "text" | "email" | "password" | "number" | "select" | "checkbox" | "date" | "file";
  label?: string;
  required?: boolean;
  selector: string;
}

export interface ActionButton {
  label: string;
  selector: string;
  intent?: "submit" | "cancel" | "navigate" | "download" | "addToCart" | "login" | "search";
}

export interface PrimaryEntity {
  type: string;
  nameField?: string;
  priceField?: string;
  imageField?: string;
  descriptionField?: string;
  reviewsField?: string;
  ratingField?: string;
  addToCartField?: string;
}

export interface PageSchema {
  pageType: PageType;
  primaryEntity?: PrimaryEntity;
  formFields?: FormField[];
  actionButtons?: ActionButton[];
  confidence: number;
}

function mapInputType(el: InteractiveElement): FormField["type"] {
  const inputType = el.inputType ?? el.type ?? "text";
  switch (inputType.toLowerCase()) {
    case "email":
      return "email";
    case "password":
      return "password";
    case "number":
    case "range":
      return "number";
    case "select-one":
    case "select":
      return "select";
    case "checkbox":
    case "radio":
      return "checkbox";
    case "date":
    case "datetime-local":
    case "time":
    case "month":
    case "week":
      return "date";
    case "file":
      return "file";
    default:
      return "text";
  }
}

function mapFormFields(
  forms: PageContent["forms"],
  interactiveElements: InteractiveElement[],
): FormField[] {
  const fields: FormField[] = [];
  const formFieldSelectors = new Set<string>();

  for (const form of forms) {
    for (const el of form.fields ?? []) {
      formFieldSelectors.add(el.selector || el.name || el.label || String(el.index));
    }
  }

  for (const el of interactiveElements) {
    const key = el.selector || el.name || el.label || String(el.index);
    if (formFieldSelectors.has(key)) {
      fields.push({
        name: el.name || el.label || key,
        type: mapInputType(el),
        label: el.label,
        required: el.required,
        selector: el.selector || "",
      });
    }
  }

  return fields;
}

function mapActionButtons(interactiveElements: InteractiveElement[]): ActionButton[] {
  const buttons: ActionButton[] = [];
  const seen = new Set<string>();

  for (const el of interactiveElements) {
    if (el.type !== "button" && el.type !== "submit" && el.type !== "reset") continue;
    const label = (el.label || el.textContent || "").trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);

    let intent: ActionButton["intent"] | undefined;
    const lower = label.toLowerCase();

    if (/\b(add to cart|buy now|add to bag|add to basket|shop now)\b/i.test(label)) {
      intent = "addToCart";
    } else if (/\b(login|sign in|log in|signin|log-in)\b/i.test(label)) {
      intent = "login";
    } else if (/\b(submit|send|continue|next|proceed|register|create account|sign up)\b/i.test(label)) {
      intent = "submit";
    } else if (/\b(cancel|back|return|go back|close)\b/i.test(label)) {
      intent = "cancel";
    } else if (/\b(download|export|save as)\b/i.test(label)) {
      intent = "download";
    } else if (/\b(search|find|go|submit search)\b/i.test(label)) {
      intent = "search";
    } else if (el.href || el.url) {
      intent = "navigate";
    }

    if (el.selector || el.name || el.label) {
      buttons.push({
        label,
        selector: el.selector || el.name || el.label,
        intent,
      });
    }
  }

  return buttons;
}

function extractPrimaryEntity(
  pageType: PageType,
  structuredData: StructuredDataEntity[] | undefined,
  metaTags: Record<string, string> | undefined,
): PrimaryEntity | undefined {
  if (pageType === "product") {
    const product = structuredData?.find((e) =>
      e.types.some((t) => /^product$/i.test(t))
    );
    if (product) {
      const attrs = product.attributes ?? {};
      return {
        type: "Product",
        nameField: typeof attrs.name === "string" ? attrs.name : undefined,
        priceField: typeof attrs.price === "string"
          ? attrs.price
          : typeof attrs.offers === "object" && attrs.offers !== null
            ? String((attrs.offers as Record<string, unknown>)["price"] ?? "")
            : undefined,
        imageField: typeof attrs.image === "string"
          ? attrs.image
          : Array.isArray(attrs.image)
            ? String(attrs.image[0])
            : undefined,
        descriptionField: typeof attrs.description === "string" ? attrs.description : undefined,
        reviewsField: typeof attrs.reviews === "string" ? attrs.reviews : undefined,
        ratingField: typeof attrs.rating === "string" ? attrs.rating : undefined,
        addToCartField: undefined,
      };
    }
  }

  if (pageType === "article") {
    const article = structuredData?.find((e) =>
      e.types.some((t) =>
        /^(article|newsarticle|blogposting|webpage)$/i.test(t)
      )
    );
    if (article) {
      const attrs = article.attributes ?? {};
      return {
        type: article.types[0] ?? "Article",
        nameField: typeof attrs.headline === "string"
          ? attrs.headline
          : typeof attrs.name === "string"
            ? attrs.name
            : undefined,
        descriptionField: typeof attrs.articleBody === "string"
          ? attrs.articleBody
          : typeof attrs.description === "string"
            ? attrs.description
            : undefined,
      };
    }
  }

  return undefined;
}

export function inferPageSchema(page: PageContent): PageSchema {
  let pageType: PageType = "unknown";
  let confidence = 0.5;

  const structuredData = page.structuredData;
  const metaTags = page.metaTags;
  const url = page.url ?? "";
  const forms = page.forms ?? [];
  const interactiveElements = page.interactiveElements ?? [];

  const urlLower = url.toLowerCase();

  // --- Detect pageType from structured data (highest priority) ---
  const jsonLdTypes: string[] = [];
  for (const entity of structuredData ?? []) {
    jsonLdTypes.push(...entity.types);
  }

  const hasProduct = jsonLdTypes.some((t) => /^product$/i.test(t));
  const hasArticle = jsonLdTypes.some((t) =>
    /^(article|newsarticle|blogposting)$/i.test(t)
  );
  const hasEvent = jsonLdTypes.some((t) => /^event$/i.test(t));
  const hasSearchResults = jsonLdTypes.some((t) => /^searchresultspage$/i.test(t));

  if (hasProduct) {
    pageType = "product";
    confidence += 0.2;
  } else if (hasArticle) {
    pageType = "article";
    confidence += 0.2;
  } else if (hasEvent) {
    pageType = "form";
    confidence += 0.15;
  } else if (hasSearchResults) {
    pageType = "search";
    confidence += 0.2;
  }

  // --- Refine from meta tags ---
  const ogType = metaTags?.["og:type"];
  if (ogType) {
    const lower = ogType.toLowerCase();
    if (/^product$/i.test(lower) && pageType !== "product") {
      pageType = "product";
      confidence += 0.15;
    } else if (/^article|blog|news/i.test(lower) && pageType !== "article") {
      pageType = "article";
      confidence += 0.15;
    }
  }

  // --- URL patterns (strong signals) ---
  if (
    /\/checkout|\/cart|\/payment|\/billing/i.test(urlLower) &&
    pageType === "unknown"
  ) {
    pageType = "checkout";
    confidence += 0.1;
  } else if (/\/login|\/signin|\/auth/i.test(urlLower) && pageType === "unknown") {
    pageType = "login";
    confidence += 0.1;
  } else if (/\/dashboard|\/account|\/profile/i.test(urlLower) && pageType === "unknown") {
    pageType = "dashboard";
    confidence += 0.1;
  } else if (/\/search/i.test(urlLower) && pageType === "unknown") {
    pageType = "search";
    confidence += 0.1;
  }

  // --- DOM structure signals ---
  const hasFormWithSubmit = forms.some((f) =>
    f.fields.some(
      (el) =>
        el.type === "submit" ||
        (el.inputType ?? "").toLowerCase() === "submit" ||
        (el.name ?? "").toLowerCase() === "submit",
    )
  );

  const hasPriceSelectors = interactiveElements.some(
    (el) =>
      el.selector?.includes("price") ||
      el.label?.toLowerCase().includes("price") ||
      el.name?.toLowerCase().includes("price") ||
      el.selector?.includes("cost") ||
      el.selector?.includes("amount"),
  );

  if (pageType === "unknown") {
    if (hasFormWithSubmit && forms.length > 0) {
      pageType = "form";
      confidence += 0.1;
    } else if (hasPriceSelectors) {
      pageType = "product";
      confidence += 0.1;
    }
  }

  // Form/checkout specific: if we detected a form and pageType isn't set, mark form
  if ((pageType === "checkout" || pageType === "unknown") && forms.length > 0) {
    if (hasFormWithSubmit) {
      if (pageType === "unknown") {
        pageType = "form";
      }
      confidence += 0.15;
    }
  }

  // Confidence floor for "unknown" pages
  if (pageType === "unknown") {
    confidence = 0.5;
  }

  // Cap confidence
  confidence = Math.min(0.95, confidence);

  // --- Extract primary entity ---
  const primaryEntity = extractPrimaryEntity(pageType, structuredData, metaTags);

  // --- Extract form fields ---
  const formFields = (pageType === "form" || pageType === "checkout" || pageType === "login")
    ? mapFormFields(forms, interactiveElements)
    : undefined;

  // --- Extract action buttons ---
  const actionButtons = mapActionButtons(interactiveElements);

  return {
    pageType,
    primaryEntity,
    formFields,
    actionButtons,
    confidence,
  };
}
