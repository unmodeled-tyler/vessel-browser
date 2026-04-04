export function formatTime(
  iso: string,
  options?: { includeSeconds?: boolean },
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: options?.includeSeconds ? "2-digit" : "numeric",
    minute: "2-digit",
    ...(options?.includeSeconds && { second: "2-digit" }),
  });
}
