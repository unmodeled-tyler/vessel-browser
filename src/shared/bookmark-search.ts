export type BookmarkSearchField =
  | "title"
  | "url"
  | "note"
  | "folder"
  | "folderSummary"
  | "intent"
  | "expectedContent";

const WORD_NORMALIZATIONS: Array<[RegExp, string]> = [
  [/\bminutes?\b/g, "min"],
  [/\bmins?\b/g, "min"],
  [/\bhours?\b/g, "hr"],
  [/\bhrs?\b/g, "hr"],
  [/\bserves\b/g, "serving"],
  [/\bservings?\b/g, "serving"],
];

const FIELD_WEIGHTS: Record<BookmarkSearchField, number> = {
  title: 6,
  note: 5,
  folder: 3,
  folderSummary: 2,
  url: 1,
  intent: 4,
  expectedContent: 3,
};

export function normalizeBookmarkSearchText(value: string): string {
  let normalized = value.toLowerCase();
  for (const [pattern, replacement] of WORD_NORMALIZATIONS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function bookmarkSearchTokens(query: string): string[] {
  const normalized = normalizeBookmarkSearchText(query);
  return normalized ? normalized.split(" ") : [];
}

export function bookmarkFieldMatchesQuery(
  value: string | undefined,
  normalizedQuery: string,
  tokens: string[],
): boolean {
  if (!value) return false;
  const normalizedValue = normalizeBookmarkSearchText(value);
  if (!normalizedValue) return false;
  if (normalizedQuery && normalizedValue.includes(normalizedQuery)) return true;
  if (tokens.length === 0) return false;
  return tokens.every((token) => normalizedValue.includes(token));
}

export function getBookmarkSearchMatch(args: {
  query: string;
  title?: string;
  url?: string;
  note?: string;
  folder?: string;
  folderSummary?: string;
  intent?: string;
  expectedContent?: string;
}): { matchedFields: BookmarkSearchField[]; score: number } {
  const normalizedQuery = normalizeBookmarkSearchText(args.query);
  const tokens = bookmarkSearchTokens(args.query);
  const matchedFields: BookmarkSearchField[] = [];
  let score = 0;

  const values: Record<BookmarkSearchField, string | undefined> = {
    title: args.title,
    url: args.url,
    note: args.note,
    folder: args.folder,
    folderSummary: args.folderSummary,
    intent: args.intent,
    expectedContent: args.expectedContent,
  };

  for (const field of Object.keys(values) as BookmarkSearchField[]) {
    if (!bookmarkFieldMatchesQuery(values[field], normalizedQuery, tokens)) {
      continue;
    }
    matchedFields.push(field);
    score += FIELD_WEIGHTS[field];
  }

  return { matchedFields, score };
}
