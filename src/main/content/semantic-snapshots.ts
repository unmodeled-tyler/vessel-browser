import { createHash } from "node:crypto";
import {
  extractPrimaryEntity,
  firstStructuredString,
  mapInputType,
  type PageType,
  type PrimaryEntity,
} from "../../shared/page-schema";
import type { InteractiveElement, PageContent, StructuredDataEntity } from "../../shared/types";
import type { ContentChange } from "../../shared/page-diff-types";
import { buildPageSnapshotKey } from "../../shared/page-url";

export interface SemanticPrimaryEntitySnapshot {
  type: string;
  name?: string;
  description?: string;
  price?: string;
  rating?: string;
  reviews?: string;
  image?: string;
  url?: string;
}

export interface SemanticActionSnapshot {
  label: string;
  type?: InteractiveElement["type"];
  intent?: string;
  visible?: boolean;
}

export interface SemanticFormFieldSnapshot {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
}

export interface SemanticPageSnapshot {
  schemaVersion: number;
  url: string;
  title: string;
  capturedAt: string;
  pageType: PageType | "unknown";
  confidence: number;
  primaryEntity?: SemanticPrimaryEntitySnapshot;
  headings: string[];
  visibleActions: SemanticActionSnapshot[];
  formFields: SemanticFormFieldSnapshot[];
  blockers: string[];
  pageIssues: string[];
  structuredDataDigest: string;
  semanticFingerprint: string;
}

export interface SemanticSnapshotDiff {
  hasChanges: boolean;
  changes: ContentChange[];
}

const SCHEMA_VERSION = 1;
const MAX_HEADINGS = 20;
const MAX_ACTIONS = 40;
const MAX_FORM_FIELDS = 40;
const MAX_BLOCKERS = 10;
const MAX_PAGE_ISSUES = 10;
const MAX_TEXT = 180;
const MAX_DIFF_ITEMS = 5;

function compactText(value: unknown, max = MAX_TEXT): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function asString(value: unknown): string | undefined {
  const text = compactText(value);
  return text || undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeString(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = stableValue((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function firstStructuredEntity(
  structuredData: StructuredDataEntity[] | undefined,
): StructuredDataEntity | undefined {
  return structuredData?.find((entity) => entity.types.length > 0) ?? structuredData?.[0];
}

function compactStructuredString(
  ...values: Parameters<typeof firstStructuredString>
): string | undefined {
  return asString(firstStructuredString(...values));
}

function buildPrimaryFromSchema(
  primary: PrimaryEntity | undefined,
): SemanticPrimaryEntitySnapshot | undefined {
  if (!primary) return undefined;
  return pruneUndefined({
    type: primary.type,
    name: asString(primary.nameField),
    description: asString(primary.descriptionField),
    price: asString(primary.priceField),
    rating: asString(primary.ratingField),
    reviews: asString(primary.reviewsField),
    image: asString(primary.imageField),
  });
}

function buildPrimaryFromStructuredData(
  page: PageContent,
): SemanticPrimaryEntitySnapshot | undefined {
  const entity = firstStructuredEntity(page.structuredData);
  if (!entity) return undefined;
  const attrs = entity.attributes ?? {};
  return pruneUndefined({
    type: entity.types[0] ?? "Thing",
    name: asString(entity.name) ?? compactStructuredString(attrs.name, attrs.headline),
    description:
      asString(entity.description) ?? compactStructuredString(attrs.description, attrs.articleBody),
    price: compactStructuredString(attrs.price),
    rating: compactStructuredString(attrs.rating, attrs.ratingValue),
    reviews: compactStructuredString(attrs.reviewCount, attrs.ratingCount),
    image: compactStructuredString(attrs.image),
    url: asString(entity.url),
  });
}

function buildPrimaryEntity(page: PageContent): SemanticPrimaryEntitySnapshot | undefined {
  return (
    buildPrimaryFromSchema(page.pageSchema?.primaryEntity) ??
    buildPrimaryFromSchema(
      extractPrimaryEntity(
        page.pageSchema?.pageType ?? "unknown",
        page.structuredData,
        page.metaTags,
      ),
    ) ??
    buildPrimaryFromStructuredData(page)
  );
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined || value[key] === "") {
      delete value[key];
    }
  }
  return value;
}

function actionLabel(el: InteractiveElement): string {
  return compactText(el.label || el.text || el.placeholder || el.name || "");
}

function buildVisibleActions(page: PageContent): SemanticActionSnapshot[] {
  const schemaIntents = new Map(
    (page.pageSchema?.actionButtons ?? []).map((button) => [
      normalizeString(button.label),
      button.intent,
    ]),
  );
  const actions: SemanticActionSnapshot[] = [];
  const seen = new Set<string>();

  for (const el of page.interactiveElements) {
    if (el.type !== "button" && el.type !== "link") continue;
    const label = actionLabel(el);
    if (!label) continue;
    const visible = el.visible !== false && el.obscured !== true && el.blockedByOverlay !== true;
    if (!visible) continue;
    const normalizedLabel = normalizeString(label);
    const intent = schemaIntents.get(normalizedLabel);
    const key = `${normalizedLabel}|${el.type}|${intent || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(pruneUndefined({ label, type: el.type, intent, visible: true }));
    if (actions.length >= MAX_ACTIONS) break;
  }

  for (const button of page.pageSchema?.actionButtons ?? []) {
    const label = compactText(button.label);
    if (!label) continue;
    const key = `${normalizeString(label)}|button|${button.intent || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(pruneUndefined({ label, type: "button", intent: button.intent }));
    if (actions.length >= MAX_ACTIONS) break;
  }

  return actions;
}

function buildFormFields(page: PageContent): SemanticFormFieldSnapshot[] {
  const fields: SemanticFormFieldSnapshot[] = [];
  const seen = new Set<string>();
  const schemaFields = page.pageSchema?.formFields ?? [];

  for (const field of schemaFields) {
    const name = compactText(field.name || field.label || "field", 80);
    if (!name) continue;
    const next = pruneUndefined({
      name,
      type: field.type,
      label: asString(field.label),
      required: field.required === true ? true : undefined,
    });
    const key = fieldSignature(next);
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push(next);
    if (fields.length >= MAX_FORM_FIELDS) return fields;
  }

  for (const field of page.forms.flatMap((form) => form.fields)) {
    const name = compactText(field.name || field.label || field.placeholder || "field", 80);
    if (!name) continue;
    const next = pruneUndefined({
      name,
      type: mapInputType(field),
      label: asString(field.label),
      required: field.required === true ? true : undefined,
    });
    const key = fieldSignature(next);
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push(next);
    if (fields.length >= MAX_FORM_FIELDS) break;
  }

  return fields;
}

function buildBlockers(page: PageContent): string[] {
  return page.overlays
    .filter((overlay) => overlay.blocksInteraction)
    .map((overlay) =>
      compactText(overlay.label || overlay.message || overlay.text || overlay.kind || overlay.type),
    )
    .filter(Boolean)
    .slice(0, MAX_BLOCKERS);
}

function buildStructuredDigest(page: PageContent): string {
  return digest({
    structuredData: page.structuredData ?? [],
    metaTags: page.metaTags ?? {},
    pageSchema: page.pageSchema ?? null,
  });
}

export function buildSemanticSnapshot(
  rawUrl: string,
  page: PageContent,
  capturedAt = new Date().toISOString(),
): SemanticPageSnapshot {
  const url = buildPageSnapshotKey(rawUrl || page.url);
  const structuredDataDigest = buildStructuredDigest(page);
  const snapshotBase = {
    schemaVersion: SCHEMA_VERSION,
    url,
    title: compactText(page.title, 240),
    capturedAt,
    pageType: page.pageSchema?.pageType ?? "unknown",
    confidence: page.pageSchema?.confidence ?? 0,
    primaryEntity: buildPrimaryEntity(page),
    headings: page.headings
      .map((heading) => `H${heading.level}: ${compactText(heading.text, 120)}`)
      .filter(Boolean)
      .slice(0, MAX_HEADINGS),
    visibleActions: buildVisibleActions(page),
    formFields: buildFormFields(page),
    blockers: buildBlockers(page),
    pageIssues: (page.pageIssues ?? [])
      .map((issue) => compactText(issue.summary))
      .filter(Boolean)
      .slice(0, MAX_PAGE_ISSUES),
    structuredDataDigest,
  } satisfies Omit<SemanticPageSnapshot, "semanticFingerprint">;

  return {
    ...snapshotBase,
    semanticFingerprint: digest({ ...snapshotBase, capturedAt: undefined }),
  };
}

function normalizeStringArray(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => compactText(item))
        .filter(Boolean)
        .slice(0, max)
    : [];
}

function normalizePrimaryEntity(value: unknown): SemanticPrimaryEntitySnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const type = asString(raw.type);
  if (!type) return undefined;
  return pruneUndefined({
    type,
    name: asString(raw.name),
    description: asString(raw.description),
    price: asString(raw.price),
    rating: asString(raw.rating),
    reviews: asString(raw.reviews),
    image: asString(raw.image),
    url: asString(raw.url),
  });
}

function normalizeActions(value: unknown): SemanticActionSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const raw = item as Record<string, unknown>;
      const label = asString(raw.label);
      if (!label) return null;
      return pruneUndefined({
        label,
        type: asString(raw.type) as InteractiveElement["type"] | undefined,
        intent: asString(raw.intent),
        visible: raw.visible === true ? true : undefined,
      });
    })
    .filter((item): item is SemanticActionSnapshot => item !== null)
    .slice(0, MAX_ACTIONS);
}

function normalizeFormFields(value: unknown): SemanticFormFieldSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const raw = item as Record<string, unknown>;
      const name = asString(raw.name);
      const type = asString(raw.type);
      if (!name || !type) return null;
      return pruneUndefined({
        name,
        type,
        label: asString(raw.label),
        required: raw.required === true ? true : undefined,
      });
    })
    .filter((item): item is SemanticFormFieldSnapshot => item !== null)
    .slice(0, MAX_FORM_FIELDS);
}

export function normalizeStoredSemanticSnapshot(value: unknown): SemanticPageSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const url = asString(raw.url);
  const title = asString(raw.title) ?? "";
  const capturedAt = asString(raw.capturedAt);
  const pageType = asString(raw.pageType) as SemanticPageSnapshot["pageType"] | undefined;
  const structuredDataDigest = asString(raw.structuredDataDigest);
  const semanticFingerprint = asString(raw.semanticFingerprint);
  if (!url || !capturedAt || !pageType || !structuredDataDigest || !semanticFingerprint) {
    return null;
  }

  return {
    schemaVersion: asNumber(raw.schemaVersion) ?? SCHEMA_VERSION,
    url,
    title,
    capturedAt,
    pageType,
    confidence: asNumber(raw.confidence) ?? 0,
    primaryEntity: normalizePrimaryEntity(raw.primaryEntity),
    headings: normalizeStringArray(raw.headings, MAX_HEADINGS),
    visibleActions: normalizeActions(raw.visibleActions),
    formFields: normalizeFormFields(raw.formFields),
    blockers: normalizeStringArray(raw.blockers, MAX_BLOCKERS),
    pageIssues: normalizeStringArray(raw.pageIssues, MAX_PAGE_ISSUES),
    structuredDataDigest,
    semanticFingerprint,
  };
}

function actionSignature(action: SemanticActionSnapshot): string {
  return [action.label, action.type ?? "", action.intent ?? ""].map(normalizeString).join("|");
}

function fieldSignature(field: SemanticFormFieldSnapshot): string {
  return [field.name, field.type, field.label ?? "", field.required ? "required" : ""]
    .map(normalizeString)
    .join("|");
}

function describeAction(action: SemanticActionSnapshot): string {
  return [action.label, action.intent ? `(${action.intent})` : ""].filter(Boolean).join(" ");
}

function describeField(field: SemanticFormFieldSnapshot): string {
  return `${field.label || field.name} (${field.type}${field.required ? ", required" : ""})`;
}

function diffStringSets(
  oldItems: string[],
  newItems: string[],
): { added: string[]; removed: string[] } {
  const oldSet = new Set(oldItems.map(normalizeString));
  const newSet = new Set(newItems.map(normalizeString));
  return {
    added: newItems.filter((item) => !oldSet.has(normalizeString(item))),
    removed: oldItems.filter((item) => !newSet.has(normalizeString(item))),
  };
}

function diffObjectSets<T>(
  oldItems: T[],
  newItems: T[],
  signature: (item: T) => string,
  describe: (item: T) => string,
): { added: string[]; removed: string[] } {
  const oldSet = new Set(oldItems.map(signature));
  const newSet = new Set(newItems.map(signature));
  return {
    added: newItems.filter((item) => !oldSet.has(signature(item))).map(describe),
    removed: oldItems.filter((item) => !newSet.has(signature(item))).map(describe),
  };
}

function pushSetChange(
  changes: ContentChange[],
  label: string,
  added: string[],
  removed: string[],
): void {
  if (added.length === 0 && removed.length === 0) return;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`Added ${added.slice(0, MAX_DIFF_ITEMS).join(", ")}`);
  if (removed.length > 0) parts.push(`Removed ${removed.slice(0, MAX_DIFF_ITEMS).join(", ")}`);
  changes.push({
    kind:
      added.length > 0 && removed.length > 0 ? "changed" : added.length > 0 ? "added" : "removed",
    section: "semantic",
    summary: `${label}: ${parts.join(". ")}`,
    addedItems: added.slice(0, MAX_DIFF_ITEMS),
    removedItems: removed.slice(0, MAX_DIFF_ITEMS),
  });
}

function pushFieldChange(
  changes: ContentChange[],
  label: string,
  before: string | undefined,
  after: string | undefined,
): void {
  if ((before || "") === (after || "")) return;
  changes.push({
    kind: before && after ? "changed" : after ? "added" : "removed",
    section: "semantic",
    summary: `${label}: "${before || "None"}" -> "${after || "None"}"`,
    before,
    after,
  });
}

export function diffSemanticSnapshots(
  oldSnap: SemanticPageSnapshot,
  newSnap: SemanticPageSnapshot,
): SemanticSnapshotDiff {
  const changes: ContentChange[] = [];

  pushFieldChange(changes, "Page type", oldSnap.pageType, newSnap.pageType);
  pushFieldChange(
    changes,
    "Primary entity",
    oldSnap.primaryEntity?.name,
    newSnap.primaryEntity?.name,
  );
  pushFieldChange(changes, "Price", oldSnap.primaryEntity?.price, newSnap.primaryEntity?.price);
  pushFieldChange(changes, "Rating", oldSnap.primaryEntity?.rating, newSnap.primaryEntity?.rating);
  pushFieldChange(
    changes,
    "Reviews",
    oldSnap.primaryEntity?.reviews,
    newSnap.primaryEntity?.reviews,
  );

  const actionDiff = diffObjectSets(
    oldSnap.visibleActions,
    newSnap.visibleActions,
    actionSignature,
    describeAction,
  );
  pushSetChange(changes, "Actions", actionDiff.added, actionDiff.removed);

  const fieldDiff = diffObjectSets(
    oldSnap.formFields,
    newSnap.formFields,
    fieldSignature,
    describeField,
  );
  pushSetChange(changes, "Form fields", fieldDiff.added, fieldDiff.removed);

  const blockerDiff = diffStringSets(oldSnap.blockers, newSnap.blockers);
  pushSetChange(changes, "Blockers", blockerDiff.added, blockerDiff.removed);

  const issueDiff = diffStringSets(oldSnap.pageIssues, newSnap.pageIssues);
  pushSetChange(changes, "Access issues", issueDiff.added, issueDiff.removed);

  if (changes.length === 0 && oldSnap.structuredDataDigest !== newSnap.structuredDataDigest) {
    changes.push({
      kind: "changed",
      section: "semantic",
      summary: "Structured metadata changed",
    });
  }

  return {
    hasChanges: changes.length > 0,
    changes,
  };
}
