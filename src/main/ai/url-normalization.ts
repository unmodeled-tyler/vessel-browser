export function normalizeComparable(value: string | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeUrlForMatch(value?: string): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`.toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase() || null;
  }
}

export function getUrlPathSegments(value?: string): string[] {
  if (!value) return [];

  try {
    return new URL(value).pathname.split("/").filter(Boolean);
  } catch {
    return value.split("?")[0].split("#")[0].split("/").filter(Boolean);
  }
}
