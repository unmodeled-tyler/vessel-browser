import type {
  SidebarDetachedBounds,
  SidebarPanelMode,
} from "./types";

export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 800;
export const SIDEBAR_RESIZE_HANDLE_OVERLAP = 6;
export const DETACHED_SIDEBAR_MIN_WIDTH = 360;
export const DETACHED_SIDEBAR_MIN_HEIGHT = 480;
export const DETACHED_SIDEBAR_DEFAULT_WIDTH = 420;
export const DETACHED_SIDEBAR_DEFAULT_HEIGHT = 760;

export function clampSidebarWidth(width: number): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)),
  );
}

export function sanitizeSidebarPanelMode(value: unknown): SidebarPanelMode {
  return value === "closed" || value === "docked" || value === "detached"
    ? value
    : "docked";
}

export function sanitizeSidebarDetachedBounds(
  value: unknown,
): SidebarDetachedBounds | null {
  if (!value || typeof value !== "object") return null;
  const bounds = value as Partial<SidebarDetachedBounds>;
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  return {
    ...(Number.isFinite(x) ? { x: Math.round(x) } : {}),
    ...(Number.isFinite(y) ? { y: Math.round(y) } : {}),
    width: Math.max(DETACHED_SIDEBAR_MIN_WIDTH, Math.round(width)),
    height: Math.max(DETACHED_SIDEBAR_MIN_HEIGHT, Math.round(height)),
  };
}
