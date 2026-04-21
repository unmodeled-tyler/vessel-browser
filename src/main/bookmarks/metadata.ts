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

export function normalizeBookmarkMetadata(
  input: NormalizeBookmarkMetadataInput,
): Partial<Bookmark> {
  return {
    intent: normalizeOptionalString(input.intent),
    expectedContent: normalizeOptionalString(input.expectedContent),
    keyFields: normalizeKeyFields(input.keyFields),
    agentHints: normalizeAgentHints(input.agentHints),
  };
}
