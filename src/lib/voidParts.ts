import type { Bundle } from "../types";

/**
 * The bundle without its void parts (vacuum carvers, `void: true`). A void is not material: the
 * mesh, drawing, fabrication and report exporters work on the solids only. Returns `b` itself
 * when there is no void, so callers pay nothing in the common case.
 */
export function withoutVoids<T extends Pick<Bundle, "parts">>(b: T): T {
  return b.parts.some((p) => p.void === true) ? { ...b, parts: b.parts.filter((p) => p.void !== true) } : b;
}
