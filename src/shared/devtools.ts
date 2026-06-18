import type {
  DevToolsPanelDetachedBounds,
  DevToolsPanelMode,
} from "./types";

export const DETACHED_DEVTOOLS_DEFAULT_WIDTH = 920;
export const DETACHED_DEVTOOLS_DEFAULT_HEIGHT = 560;
export const DETACHED_DEVTOOLS_MIN_WIDTH = 520;
export const DETACHED_DEVTOOLS_MIN_HEIGHT = 320;

export function sanitizeDevToolsPanelMode(
  value: unknown,
): DevToolsPanelMode {
  return value === "closed" || value === "docked" || value === "detached"
    ? value
    : "closed";
}

export function sanitizeDevToolsDetachedBounds(
  value: unknown,
): DevToolsPanelDetachedBounds | null {
  if (!value || typeof value !== "object") return null;
  const bounds = value as Partial<DevToolsPanelDetachedBounds>;
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  return {
    ...(Number.isFinite(x) ? { x: Math.round(x) } : {}),
    ...(Number.isFinite(y) ? { y: Math.round(y) } : {}),
    width: Math.max(DETACHED_DEVTOOLS_MIN_WIDTH, Math.round(width)),
    height: Math.max(DETACHED_DEVTOOLS_MIN_HEIGHT, Math.round(height)),
  };
}
