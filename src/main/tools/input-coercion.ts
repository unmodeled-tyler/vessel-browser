import { z } from "zod";

const WRAPPING_QUOTES = new Set(['"', "'", "`"]);

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (first === last && WRAPPING_QUOTES.has(first)) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function normalizeArrayItem(value: unknown): string {
  if (typeof value === "string") {
    return stripWrappingQuotes(value).trim();
  }
  return String(value).trim();
}

export function normalizeLooseString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = stripWrappingQuotes(value);
  return normalized ? normalized : undefined;
}

export function coerceOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const normalized = normalizeLooseString(value);
  if (!normalized) return undefined;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function coerceStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map(normalizeArrayItem).filter(Boolean);
  }

  const normalized = normalizeLooseString(value);
  if (!normalized) return [];

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeArrayItem).filter(Boolean);
    }
  } catch {}

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);

  if (lines.length > 1) {
    return lines;
  }

  return [normalized];
}

export function optionalNumberLikeSchema() {
  return z.preprocess(
    (value) => {
      if (value == null) return undefined;
      return coerceOptionalNumber(value) ?? value;
    },
    z.number().finite().optional(),
  );
}

export function normalizedOptionalStringSchema() {
  return z.preprocess(
    (value) => {
      if (value == null) return undefined;
      return normalizeLooseString(value) ?? value;
    },
    z.string().optional(),
  );
}

export function stringArrayLikeSchema() {
  return z.preprocess(
    (value) => {
      if (value == null) return value;
      return coerceStringArray(value) ?? value;
    },
    z.array(z.string().min(1)).min(1),
  );
}
