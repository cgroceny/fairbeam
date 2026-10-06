import type { Part } from "../types";

export type PartKind = "metal" | "dielectric" | "other";

/** A vacuum carver (a Boolean Subtract of curved shapes): drawn as a ghost, never exported as material. */
export function isGhostPart(p: Pick<Part, "void">): boolean {
  return p.void === true;
}

/** The part a ghost belongs to (its name without the " (cut)" suffix); any other part is its own host. */
export function ghostHostName(p: Pick<Part, "name" | "void">): string {
  return p.void === true && p.name.endsWith(" (cut)") ? p.name.slice(0, -" (cut)".length) : p.name;
}

/** Material category used by the model panel and the 3D scene. */
export function partKind(p: Part): PartKind {
  if (isGhostPart(p)) return "other";
  if (p.type === "Metal" || p.type === "ConductingSheet" || p.conductor) return "metal";
  if (p.type === "Material") return "dielectric";
  return "other";
}
