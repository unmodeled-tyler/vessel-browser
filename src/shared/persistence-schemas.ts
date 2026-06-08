/**
 * Zod schemas for validating data loaded from disk.
 *
 * These schemas are used by the persistence layer's `parse` callbacks
 * to ensure that data read from JSON files matches expected shapes.
 * If the data is corrupt or malformed, the schema falls back to safe
 * defaults instead of trusting the `as Partial<T>` cast.
 */
import { z } from "zod";
import type {
  DownloadRecord,
  HighlightsState,
  HistoryEntry,
  HistoryState,
} from "./types";

// --- DownloadRecord ---

export const DownloadStateSchema = z.enum([
  "progressing",
  "completed",
  "cancelled",
  "interrupted",
]);

export const DownloadRecordSchema: z.ZodType<DownloadRecord> = z.object({
  id: z.string(),
  filename: z.string(),
  savePath: z.string(),
  url: z.string().optional(),
  mimeType: z.string().optional(),
  totalBytes: z.number(),
  receivedBytes: z.number(),
  state: DownloadStateSchema,
  startedAt: z.string(),
  updatedAt: z.string(),
});

export const DownloadsStateSchema = z.object({
  items: z.array(DownloadRecordSchema),
});

// --- HistoryEntry / HistoryState ---

export const HistoryEntrySchema: z.ZodType<HistoryEntry> = z.object({
  url: z.string(),
  title: z.string(),
  visitedAt: z.string(),
});

export const HistoryStateSchema: z.ZodType<HistoryState> = z.object({
  entries: z.array(HistoryEntrySchema),
});

export const HistoryImportEntrySchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  visitedAt: z.string().optional(),
});

export const HistoryImportStateSchema = z.object({
  entries: z.array(HistoryImportEntrySchema),
});

// --- HighlightColor / StoredHighlight / HighlightsState ---

export const HighlightColorSchema = z.enum([
  "yellow",
  "red",
  "green",
  "blue",
  "purple",
  "orange",
]);

export const HighlightSourceSchema = z.enum(["agent", "user"]);

export const StoredHighlightSchema = z.object({
  id: z.string(),
  url: z.string(),
  selector: z.string().optional(),
  text: z.string().optional(),
  label: z.string().optional(),
  color: HighlightColorSchema.optional(),
  source: HighlightSourceSchema.optional(),
  createdAt: z.string(),
});

export const HighlightsStateSchema = z.object({
  highlights: z.array(StoredHighlightSchema),
}) satisfies z.ZodType<HighlightsState>;

/**
 * Safe parse helper: validate unknown data against a Zod schema,
 * returning the parsed value on success or a fallback on failure.
 * Logs a warning if validation fails.
 */
export function parseWithFallback<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  fallback: T,
  label: string,
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  console.warn(
    `[persistence] ${label} validation failed, using fallback:`,
    result.error.issues.map((i) => i.message).join("; "),
  );
  return fallback;
}

export function parseArrayStateWithFallback<
  TItem,
  TKey extends string,
  TState extends Record<TKey, TItem[]>,
>(
  itemSchema: z.ZodSchema<TItem>,
  data: unknown,
  field: TKey,
  fallback: TState,
  label: string,
): TState {
  if (!data || typeof data !== "object") return fallback;
  const rawItems = (data as Record<string, unknown>)[field];
  if (!Array.isArray(rawItems)) return fallback;

  const items: TItem[] = [];
  let invalid = 0;
  for (const item of rawItems) {
    const result = itemSchema.safeParse(item);
    if (result.success) {
      items.push(result.data);
    } else {
      invalid++;
    }
  }

  if (invalid > 0) {
    console.warn(
      `[persistence] ${label} dropped ${invalid} invalid ${field} item${invalid === 1 ? "" : "s"}`,
    );
  }

  return { ...fallback, [field]: items } as TState;
}
