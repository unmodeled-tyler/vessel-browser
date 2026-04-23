import type { Bookmark } from "../../shared/types";

interface NormalizeBookmarkMetadataInput {
  intent?: unknown;
  expectedContent?: unknown;
  keyFields?: unknown;
  agentHints?: unknown;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeKeyFields(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((field): field is string => typeof field === "string")
    .map((field) => field.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAgentHints(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, hint]) => [key.trim(), normalizeOptionalString(hint)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function hasOwn(
  value: object,
  key: keyof NormalizeBookmarkMetadataInput,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeBookmarkMetadata(
  input: NormalizeBookmarkMetadataInput,
): Partial<Bookmark> {
  const normalized: Partial<Bookmark> = {};
  const intent = normalizeOptionalString(input.intent);
  const expectedContent = normalizeOptionalString(input.expectedContent);
  const keyFields = normalizeKeyFields(input.keyFields);
  const agentHints = normalizeAgentHints(input.agentHints);

  if (intent !== undefined) normalized.intent = intent;
  if (expectedContent !== undefined) {
    normalized.expectedContent = expectedContent;
  }
  if (keyFields !== undefined) normalized.keyFields = keyFields;
  if (agentHints !== undefined) normalized.agentHints = agentHints;

  return normalized;
}

export function normalizeBookmarkMetadataUpdate(
  input: NormalizeBookmarkMetadataInput,
): Partial<Bookmark> {
  const normalized: Partial<Bookmark> = {};

  if (hasOwn(input, "intent")) {
    normalized.intent = normalizeOptionalString(input.intent);
  }
  if (hasOwn(input, "expectedContent")) {
    normalized.expectedContent = normalizeOptionalString(
      input.expectedContent,
    );
  }
  if (hasOwn(input, "keyFields")) {
    normalized.keyFields = normalizeKeyFields(input.keyFields);
  }
  if (hasOwn(input, "agentHints")) {
    normalized.agentHints = normalizeAgentHints(input.agentHints);
  }

  return normalized;
}
