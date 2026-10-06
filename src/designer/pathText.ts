// JSON paths of a design ("params[2].expr", "parts[0].primitives[1].stop[2]", "materials.FR4.tan_d_freq")
// are how the checks and the server name a field. They stay in the data (the Checks list focuses a
// field by its path, the parity tests compare them); what the user reads is a place in words:
// "Parameter W (expression)", "patch › Brick 2 › stop z", "Material FR4 (tan δ frequency)".
import { hasKey, t } from "../i18n/index.ts";
import type { Design, DesignPrimitive } from "./types.ts";

interface Seg { name: string; index?: number }

/** "parts[1].primitives[0].stop[2]" -> [parts 1, primitives 0, stop 2]; "materials.FR4.tan_d" -> [materials, FR4, tan_d] */
function segments(path: string): Seg[] {
  const out: Seg[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (m[2] !== undefined) { if (out.length) out[out.length - 1].index = Number(m[2]); }
    else out.push({ name: m[1] });
  }
  return out;
}

/** Coordinates of a vector field: stop[2] is "stop z". */
const VECTOR = new Set(["start", "stop", "center", "origin", "position", "offset", "a", "b", "direction", "phase_center", "translate", "scale"]);
const humanize = (name: string) => name.replace(/_/g, " ");

/** One field name in words: the translated label when there is one, else the name with spaces. */
export function fieldLabel(name: string, index?: number): string {
  const key = `checks.field.${name}`;
  const base = hasKey(key) ? t(key) : humanize(name);
  if (index === undefined) return base;
  if (VECTOR.has(name) && index >= 0 && index <= 2) return `${base} ${"xyz"[index]}`;
  return `${base} ${index + 1}`;
}

/** The place a JSON path names, in words. `shape` names a shape of a part ("Brick"); `design` is the
 * draft the indices refer to (a path into a design that is not there falls back to the raw path). */
export function pathText(path: string, design: Partial<Design> | null | undefined, shape: (p: DesignPrimitive) => string = (p) => p.kind): string {
  const segs = segments(path);
  if (!segs.length) return t("props.checks.design");
  const [head, ...rest] = segs;
  const fields = (list: Seg[]) => list.map((s) => fieldLabel(s.name, s.index));
  const paren = (base: string, list: Seg[]) => (list.length ? `${base} (${fields(list).join(" › ")})` : base);
  const arrow = (base: string, list: Seg[]) => [base, ...fields(list)].join(" › ");
  switch (head.name) {
    case "params": {
      const p = head.index !== undefined ? design?.params?.[head.index] : undefined;
      return p ? paren(t("checks.place.param", { name: p.key }), rest) : paren(t("checks.place.params"), rest);
    }
    case "materials": {
      // materials are keyed by name in the path: materials.FR4.tan_d_freq
      const [name, ...more] = rest;
      return name ? paren(t("checks.place.material", { name: name.name }), more) : t("checks.place.materials");
    }
    case "parts": {
      const part = head.index !== undefined ? design?.parts?.[head.index] : undefined;
      if (!part) return arrow(t("checks.place.parts"), rest);
      const [prim, ...more] = rest;
      if (prim?.name === "primitives" && prim.index !== undefined) {
        const pr = part.primitives?.[prim.index];
        return [part.name, `${pr ? shape(pr) : fieldLabel("primitives")} ${prim.index + 1}`, ...fields(more)].join(" › ");
      }
      return arrow(part.name, rest);
    }
    case "ports": {
      if (head.index === undefined) return paren(t("checks.place.ports"), rest);
      const p = head.index !== undefined ? design?.ports?.[head.index] : undefined;
      return arrow(t("checks.place.port", { n: p ? p.number : head.index !== undefined ? head.index + 1 : "" }).trim(), rest);
    }
    case "resistors": {
      if (head.index === undefined) return paren(t("checks.place.resistors"), rest);
      const r = head.index !== undefined ? design?.resistors?.[head.index] : undefined;
      return arrow(t("checks.place.resistor", { n: r ? (r.name ?? head.index! + 1) : head.index !== undefined ? head.index + 1 : "" }).trim(), rest);
    }
    case "simulation": return paren(t("checks.place.simulation"), rest);
    case "mesh": return paren(t("checks.place.mesh"), rest);
    case "far_field": return paren(t("checks.place.farField"), rest);
    case "monitors": return paren(t("checks.place.monitors"), rest);
    case "boundaries": return t("checks.place.boundaries");
    default: return path;
  }
}

const PATH_IN_TEXT = /\b(?:params|materials|parts|ports|resistors|simulation|mesh|far_field|monitors|boundaries)(?:\[\d+\]|\.[A-Za-z_][\w-]*)+/g;

/** Free text with the JSON paths in it ("params[2].expr: unknown name 'wx'") turned into places. */
export function humanizePaths(text: string, design: Partial<Design> | null | undefined, shape?: (p: DesignPrimitive) => string): string {
  return text.replace(PATH_IN_TEXT, (path) => pathText(path, design, shape));
}
