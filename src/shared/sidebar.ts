export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 800;
export const SIDEBAR_RESIZE_HANDLE_OVERLAP = 6;

export function clampSidebarWidth(width: number): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)),
  );
}
