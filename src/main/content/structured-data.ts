import type {
  StructuredDataEntity,
  StructuredDataObject,
  StructuredDataSource,
  StructuredDataValue,
} from "../../shared/types";

const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 500;

const SKIP_FIELDS = new Set([
  "@context",
  "@graph",
  "@id",
  "@type",
  "image",
  "logo",
  "thumbnailUrl",
  "sameAs",
  "mainEntityOfPage",
  "potentialAction",
]);

const WRAPPER_TYPES = new Set([
  "WebPage",
  "WebSite",
  "SearchResultsPage",
  "CollectionPage",
  "BreadcrumbList",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimString(value: unknown, maxLength = MAX_STRING_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function getTypes(value: Record<string, unknown>): string[] {
  const raw = value["@type"];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeInstructionItem(value: unknown): StructuredDataValue | undefined {
  if (typeof value === "string") {
    return trimString(value);
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => normalizeInstructionItem(item))
      .filter((item): item is StructuredDataValue => item !== undefined)
      .slice(0, MAX_ARRAY_ITEMS);
    return normalized.length > 0 ? normalized : undefined;
  }

  const record = asRecord(value);
  if (!record) return undefined;

  const text = firstString(
    record.text,
    record.name,
    record.description,
    record.itemListElement,
  );
  if (text) return text;

  return sanitizeValue(record, 1);
}

function normalizeNutrition(value: unknown): StructuredDataObject | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const nutrition: StructuredDataObject = {};
  const fields = [
    "calories",
    "carbohydrateContent",
    "cholesterolContent",
    "fatContent",
    "fiberContent",
    "proteinContent",
    "saturatedFatContent",
    "servingSize",
    "sodiumContent",
    "sugarContent",
    "transFatContent",
    "unsaturatedFatContent",
  ];

  for (const field of fields) {
    const normalized = sanitizeValue(record[field], 1);
    if (normalized !== undefined) {
      nutrition[field] = normalized;
    }
  }

  return Object.keys(nutrition).length > 0 ? nutrition : undefined;
}

function normalizeAggregateRating(value: unknown): StructuredDataObject | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const rating: StructuredDataObject = {};
  for (const field of ["ratingValue", "ratingCount", "reviewCount", "bestRating", "worstRating"]) {
    const normalized = sanitizeValue(record[field], 1);
    if (normalized !== undefined) {
      rating[field] = normalized;
    }
  }

  return Object.keys(rating).length > 0 ? rating : undefined;
}

function normalizeOffers(value: unknown): StructuredDataValue | undefined {
  if (Array.isArray(value)) {
    const offers = value
      .map((item) => normalizeOffers(item))
      .filter((item): item is StructuredDataValue => item !== undefined)
      .slice(0, MAX_ARRAY_ITEMS);
    return offers.length > 0 ? offers : undefined;
  }

  const record = asRecord(value);
  if (!record) return sanitizeValue(value, 1);

  const offer: StructuredDataObject = {};
  for (const field of [
    "price",
    "priceCurrency",
    "availability",
    "url",
    "itemCondition",
    "priceValidUntil",
    "seller",
  ]) {
    const normalized = sanitizeValue(record[field], 1);
    if (normalized !== undefined) {
      offer[field] = normalized;
    }
  }

  return Object.keys(offer).length > 0 ? offer : sanitizeValue(record, 1);
}

function sanitizeValue(
  value: unknown,
  depth = 0,
): StructuredDataValue | undefined {
  if (value == null) return undefined;

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value === "string" ? trimString(value) : value;
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return undefined;
    const normalized = value
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item): item is StructuredDataValue => item !== undefined)
      .slice(0, MAX_ARRAY_ITEMS);
    return normalized.length > 0 ? normalized : undefined;
  }

  const record = asRecord(value);
  if (!record || depth >= MAX_DEPTH) return undefined;

  const objectValue: StructuredDataObject = {};
  for (const [key, entry] of Object.entries(record)) {
    if (SKIP_FIELDS.has(key)) continue;
    const normalized = sanitizeValue(entry, depth + 1);
    if (normalized !== undefined) {
      objectValue[key] = normalized;
    }
  }

  return Object.keys(objectValue).length > 0 ? objectValue : undefined;
}

function buildNormalizedAttributes(
  record: Record<string, unknown>,
  types: string[],
): StructuredDataObject {
  const attributes: StructuredDataObject = {};
  const consumed = new Set<string>();

  const consume = (key: string, value: StructuredDataValue | undefined) => {
    if (value === undefined) return;
    consumed.add(key);
    attributes[key] = value;
  };

  if (types.includes("Recipe")) {
    consume("yield", sanitizeValue(record.recipeYield));
    consume("totalTime", sanitizeValue(record.totalTime));
    consume("prepTime", sanitizeValue(record.prepTime));
    consume("cookTime", sanitizeValue(record.cookTime));
    consume("category", sanitizeValue(record.recipeCategory));
    consume("cuisine", sanitizeValue(record.recipeCuisine));
    consume("ingredients", sanitizeValue(record.recipeIngredient));
    consume("instructions", normalizeInstructionItem(record.recipeInstructions));
    consume("nutrition", normalizeNutrition(record.nutrition));
  }

  if (types.some((type) => ["Article", "NewsArticle", "BlogPosting"].includes(type))) {
    consume("author", sanitizeValue(record.author));
    consume("datePublished", sanitizeValue(record.datePublished));
    consume("dateModified", sanitizeValue(record.dateModified));
    consume("keywords", sanitizeValue(record.keywords));
    consume("section", sanitizeValue(record.articleSection));
  }

  if (types.includes("Product")) {
    consume("brand", sanitizeValue(record.brand));
    consume("sku", sanitizeValue(record.sku));
    consume("gtin", sanitizeValue(record.gtin));
    consume("offers", normalizeOffers(record.offers));
    consume("aggregateRating", normalizeAggregateRating(record.aggregateRating));
  }

  if (types.includes("Event")) {
    consume("startDate", sanitizeValue(record.startDate));
    consume("endDate", sanitizeValue(record.endDate));
    consume("eventStatus", sanitizeValue(record.eventStatus));
    consume("eventAttendanceMode", sanitizeValue(record.eventAttendanceMode));
    consume("location", sanitizeValue(record.location));
    consume("performer", sanitizeValue(record.performer));
    consume("organizer", sanitizeValue(record.organizer));
    consume("offers", normalizeOffers(record.offers));
  }

  if (types.includes("FAQPage")) {
    const questions = sanitizeValue(record.mainEntity);
    if (questions !== undefined) {
      consumed.add("mainEntity");
      attributes.questions = questions;
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (SKIP_FIELDS.has(key) || consumed.has(key)) continue;
    if (key === "name" || key === "headline" || key === "url" || key === "description") {
      continue;
    }
    const normalized = sanitizeValue(value);
    if (normalized !== undefined) {
      attributes[key] = normalized;
    }
  }

  return attributes;
}

function collectCandidateEntities(
  value: unknown,
  results: Record<string, unknown>[] = [],
  seen = new WeakSet<object>(),
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectCandidateEntities(item, results, seen));
    return results;
  }

  const record = asRecord(value);
  if (!record || seen.has(record)) return results;
  seen.add(record);

  const types = getTypes(record);
  const hasIdentity = Boolean(
    firstString(record.name, record.headline, record.url, record["@id"]),
  );

  if (types.length > 0 || hasIdentity) {
    results.push(record);
  }

  for (const key of [
    "@graph",
    "mainEntity",
    "mainEntityOfPage",
    "itemListElement",
    "item",
    "hasPart",
    "about",
    "subjectOf",
    "mentions",
    "acceptedAnswer",
    "suggestedAnswer",
  ]) {
    collectCandidateEntities(record[key], results, seen);
  }

  return results;
}

function dedupeKey(entity: StructuredDataEntity): string {
  return [
    entity.source,
    entity.types.join("|"),
    entity.name || "",
    entity.url || "",
    JSON.stringify(entity.attributes),
  ].join("::");
}

function extractEntitiesFromRecords(
  records: Record<string, unknown>[] | undefined,
  source: StructuredDataSource,
): StructuredDataEntity[] {
  if (!records || records.length === 0) return [];
  const entities: StructuredDataEntity[] = [];
  const seen = new Set<string>();

  for (const candidate of collectCandidateEntities(records)) {
    const types = getTypes(candidate);
    const name = firstString(candidate.name, candidate.headline);
    const url = firstString(candidate.url, candidate["@id"]);
    const description = firstString(candidate.description);
    const attributes = buildNormalizedAttributes(candidate, types);

    if (
      types.length === 0 &&
      !name &&
      !url &&
      Object.keys(attributes).length === 0
    ) {
      continue;
    }

    if (
      types.length > 0 &&
      types.every((type) => WRAPPER_TYPES.has(type)) &&
      !name &&
      !description &&
      Object.keys(attributes).length === 0
    ) {
      continue;
    }

    const entity: StructuredDataEntity = {
      source,
      types: types.length > 0 ? types : ["Thing"],
      attributes,
    };

    addIfPresent(entity, "name", name);
    addIfPresent(entity, "url", url);
    addIfPresent(entity, "description", description);

    const key = dedupeKey(entity);
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push(entity);
  }

  return entities.slice(0, 25);
}

function getMetaType(metaTags: Record<string, string>): string[] {
  const rawType = metaTags["og:type"] || metaTags["twitter:label1"];
  if (!rawType) return ["WebPage"];

  const normalized = rawType.toLowerCase();
  if (normalized.includes("article")) return ["Article"];
  if (normalized.includes("product")) return ["Product"];
  if (normalized.includes("recipe")) return ["Recipe"];
  if (normalized.includes("video")) return ["VideoObject"];
  if (normalized.includes("book")) return ["Book"];
  return [rawType];
}

function extractEntityFromMetaTags(
  metaTags: Record<string, string> | undefined,
  pageTitle?: string,
  pageUrl?: string,
): StructuredDataEntity[] {
  if (!metaTags || Object.keys(metaTags).length === 0) return [];

  const name =
    metaTags["og:title"] ||
    metaTags["twitter:title"] ||
    metaTags["title"] ||
    pageTitle;
  const description =
    metaTags["og:description"] ||
    metaTags.description ||
    metaTags["twitter:description"];
  const url = metaTags["og:url"] || metaTags.canonical || pageUrl;
  const types = getMetaType(metaTags);

  const attributes: StructuredDataObject = {};
  for (const [key, value] of Object.entries(metaTags)) {
    if (
      key === "og:title" ||
      key === "twitter:title" ||
      key === "title" ||
      key === "og:description" ||
      key === "description" ||
      key === "twitter:description" ||
      key === "og:url" ||
      key === "canonical"
    ) {
      continue;
    }
    const normalized = sanitizeValue(value);
    if (normalized !== undefined) {
      attributes[key] = normalized;
    }
  }

  const entity: StructuredDataEntity = {
    source: "meta",
    types,
    attributes,
  };
  addIfPresent(entity, "name", name);
  addIfPresent(entity, "url", url);
  addIfPresent(entity, "description", description);

  if (
    !entity.name &&
    !entity.url &&
    !entity.description &&
    Object.keys(entity.attributes).length === 0
  ) {
    return [];
  }

  return [entity];
}

export function extractStructuredDataFromJsonLd(
  jsonLd: Record<string, unknown>[] | undefined,
  microdata?: Record<string, unknown>[] | undefined,
  rdfa?: Record<string, unknown>[] | undefined,
  metaTags?: Record<string, string> | undefined,
  pageTitle?: string,
  pageUrl?: string,
): StructuredDataEntity[] {
  const candidates = [
    ...extractEntitiesFromRecords(jsonLd, "json-ld"),
    ...extractEntitiesFromRecords(microdata, "microdata"),
    ...extractEntitiesFromRecords(rdfa, "rdfa"),
    ...extractEntityFromMetaTags(metaTags, pageTitle, pageUrl),
  ];

  const deduped: StructuredDataEntity[] = [];
  const seen = new Set<string>();
  for (const entity of candidates) {
    const key = dedupeKey(entity);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entity);
  }

  return deduped.slice(0, 25);
}

function addIfPresent(
  target: { name?: string; url?: string; description?: string },
  key: "name" | "url" | "description",
  value: string | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
