import type { PickedFace } from "./faceAlign.ts";
import type { DesignPart, Expr, Axis } from "./types.ts";
import { t } from "../i18n/index.ts";

type V3 = [number, number, number];
const AXES: Axis[] = ["x", "y", "z"];
const IN_PLANE = (n: number): [number, number] => [(n + 1) % 3, (n + 2) % 3];

function outline(face: PickedFace): V3[] {
  const points = new Map<string, V3>();
  const edges = new Map<string, { a: V3; b: V3; count: number }>();
  const key = (p: V3) => p.map((x) => Math.round(x * 1e7) / 1e7).join(",");
  for (let i = 0; i + 2 < face.tris.length; i += 3) {
    const tri = face.tris.slice(i, i + 3);
    for (const p of tri) points.set(key(p), p);
    for (let j = 0; j < 3; j++) {
      const a = tri[j], b = tri[(j + 1) % 3], ka = key(a), kb = key(b);
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = edges.get(id);
      if (e) e.count++;
      else edges.set(id, { a, b, count: 1 });
    }
  }
  const boundary = [...edges.values()].filter((e) => e.count === 1);
  if (boundary.length < 3) throw new Error(t("faceExtrude.error.noOutline"));
  const next = new Map<string, string[]>();
  for (const e of boundary) {
    const a = key(e.a), b = key(e.b);
    next.set(a, [...(next.get(a) ?? []), b]); next.set(b, [...(next.get(b) ?? []), a]);
  }
  if ([...next.values()].some((ns) => ns.length !== 2)) throw new Error(t("faceExtrude.error.notSingle"));
  const start = [...next.keys()].sort()[0];
  const ordered = [start]; let prev = "", at = start;
  do {
    const ns = next.get(at)!; const following = ns.find((x) => x !== prev)!;
    prev = at; at = following;
    if (at !== start) ordered.push(at);
    if (ordered.length > boundary.length) throw new Error(t("faceExtrude.error.notClosed"));
  } while (at !== start);
  if (ordered.length !== boundary.length) throw new Error(t("faceExtrude.error.loops"));
  return ordered.map((k) => points.get(k)!);
}

/** Turn an axis-aligned picked face into ordinary box/polygon geometry. */
export function extrudeFace(face: PickedFace, source: DesignPart, thickness: Expr, evaluatedThickness: number, name: string, material: string, component?: string): DesignPart {
  if (!Number.isInteger(face.axis) || face.axis < 0 || face.axis > 2 || ![1, -1].includes(face.sign)) throw new Error(t("faceExtrude.error.orientation"));
  if (!Number.isFinite(evaluatedThickness)) throw new Error(t("faceExtrude.error.finite"));
  const kind = face.primitiveKind ?? (source.primitives.length === 1 ? source.primitives[0].kind : undefined);
  if (!kind) throw new Error(t("faceExtrude.error.primitive"));
  if (source.cuts?.length) throw new Error(t("faceExtrude.error.cutouts"));
  if (kind === "box") {
    const vs = face.tris;
    if (!vs.length) throw new Error(t("faceExtrude.error.noGeometry"));
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const p of vs) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const end = face.value + face.sign * evaluatedThickness;
    const symbolic = typeof thickness === "string" && !Number.isFinite(Number(thickness));
    const endExpr: Expr = symbolic ? `${face.value} ${face.sign < 0 ? "-" : "+"} (${thickness})` : end;
    lo[face.axis] = Math.min(face.value, end); hi[face.axis] = Math.max(face.value, end);
    const start: [Expr, Expr, Expr] = [...lo], stop: [Expr, Expr, Expr] = [...hi];
    if (end <= face.value) start[face.axis] = endExpr;
    else stop[face.axis] = endExpr;
    return { name, material, ...(component ? { component } : {}), primitives: [{ kind: "box", start, stop }] };
  }
  if (kind !== "polygon" && kind !== "linpoly") throw new Error(t("faceExtrude.error.unsupportedSource", { kind }));
  const vertices = outline(face);
  const [u, v] = IN_PLANE(face.axis);
  const points = vertices.map((p) => [p[u], p[v]] as [number, number]);
  const delta = face.sign * evaluatedThickness;
  const length: Expr = typeof thickness === "number" ? (face.sign * thickness) : (face.sign === 1 ? thickness : `-(${thickness})`);
  const elevation = face.value;
  const common = { name, material, ...(component ? { component } : {}) };
  const primitive = Math.abs(delta) < 1e-12
    ? { kind: "polygon" as const, normal: AXES[face.axis], elevation: face.value, points }
    : { kind: "linpoly" as const, normal: AXES[face.axis], elevation, length, points };
  return { ...common, primitives: [primitive] };
}
