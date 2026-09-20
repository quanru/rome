// The window is the icon — a 48px logo disc, a 4px gap and a 20px name label
// under it — plus a 4px transparent gutter on every side, so no border is
// clipped by the window edge. PillPage.tsx carries the same numbers.
export const PILL_HEIGHT = 80;
export const PILL_DEFAULT_WIDTH = 96;
export const PILL_EDGE_MARGIN = 24;
export const PILL_FALLBACK_NAME = "Rome";

export const PILL_ENABLED_KEY = "floatingPill.enabled";
export const PILL_POSITION_KEY = "floatingPill.position";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** The agent's name out of a `GET /api/settings` body, or null when unset. */
export function parseAgentName(settings: unknown): string | null {
  if (typeof settings !== "object" || settings === null) return null;
  const raw = (settings as Record<string, unknown>).agentName;
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length > 0 ? name : null;
}

// Same convention as the auto-update switch: only an explicit "false" is off.
export function isPillEnabled(raw: string | null): boolean {
  return raw !== "false";
}

export function parsePillPosition(raw: string | null): Point | null {
  if (!raw) return null;
  try {
    const { x, y } = JSON.parse(raw) as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number") return null;
    return { x, y };
  } catch {
    return null;
  }
}

export function defaultPillPosition(workArea: Rect, size: Size): Point {
  return {
    x: workArea.x + workArea.width - size.width - PILL_EDGE_MARGIN,
    y: workArea.y + workArea.height - size.height - PILL_EDGE_MARGIN,
  };
}

/**
 * Keep the whole pill inside a display's work area. AppKit does not constrain
 * borderless windows, so without this a drag can leave the pill under the menu
 * bar, and undocking a laptop can leave it on a display that is gone.
 */
export function clampPillPosition(position: Point, size: Size, workArea: Rect): Point {
  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;
  return {
    x: Math.max(workArea.x, Math.min(position.x, maxX)),
    y: Math.max(workArea.y, Math.min(position.y, maxY)),
  };
}
