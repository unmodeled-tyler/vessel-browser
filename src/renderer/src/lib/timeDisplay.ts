export type RelativeTimeOptions = {
  now?: number | Date;
};

function resolveNow(options?: RelativeTimeOptions): number {
  if (options?.now instanceof Date) return options.now.getTime();
  if (typeof options?.now === "number") return options.now;
  return Date.now();
}

export function formatRelativeTime(
  isoDate: string,
  options?: RelativeTimeOptions,
): string {
  const timestamp = new Date(isoDate).getTime();
  if (Number.isNaN(timestamp)) return "recently";

  const now = resolveNow(options);
  if (Number.isNaN(now)) return "recently";

  const diff = Math.max(0, now - timestamp);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function formatShortDateTime(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "Unknown time";

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatElapsedTime(startIso: string, endIso: string): string {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return "unknown duration";

  const elapsedMs = Math.max(0, end - start);
  const secs = Math.round(elapsedMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return `${hours}h`;
}
