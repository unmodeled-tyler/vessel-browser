import type { KitCategory } from "./types";

export const VALID_KIT_CATEGORIES: ReadonlySet<KitCategory> = new Set([
  "research",
  "shopping",
  "productivity",
  "forms",
]);

export const BUNDLED_KIT_IDS: ReadonlySet<string> = new Set([
  "research-collect",
  "price-scout",
  "form-filler",
]);

const KIT_ID_UNSAFE_CHAR_PATTERN = /[\/\\\0]/;

export function isSafeAutomationKitId(id: string): boolean {
  return id.length > 0 && !KIT_ID_UNSAFE_CHAR_PATTERN.test(id);
}
