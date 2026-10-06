import type { Axis, DesignPart, DesignPrimitive } from "./types.ts";
import { evaluate } from "./expr.ts";

/** Native polygonal corner treatment. Only the four edges parallel to axis are affected;
 * top/bottom rims stay sharp. Fillets use 16 chords per quarter circle in RF geometry too. */
export function treatedBox(part: DesignPart, j: number, axis: Axis, mode: "fillet" | "chamfer", size: number,
  names: Record<string, number>): DesignPrimitive {
  if (part.cuts?.length || part.booleanHistory) throw new Error("edgeTreatment.history");
  const p = part.primitives[j];
  if (p?.kind !== "box") throw new Error("edgeTreatment.onlyBox");
  const a = p.start.map(x => evaluate(x, names)), b = p.stop.map(x => evaluate(x, names));
  const lo = a.map((x,k) => Math.min(x,b[k])), hi = a.map((x,k) => Math.max(x,b[k]));
  const n = "xyz".indexOf(axis), u = (n+1)%3, v = (n+2)%3;
  const w = hi[u]-lo[u], h = hi[v]-lo[v];
  if (!(size > 0 && size < Math.min(w,h)/2)) throw new Error("edgeTreatment.sizeLimit");
  if ([0,1,2].some(k => k !== n && hi[k] === lo[k])) throw new Error("edgeTreatment.sheetAxis");
  const points: [number,number][] = [];
  // Walk CCW: lower-right, upper-right, upper-left, lower-left.
  for (const [cx,cy,start] of [[hi[u]-size,lo[v]+size,-90],[hi[u]-size,hi[v]-size,0],
    [lo[u]+size,hi[v]-size,90],[lo[u]+size,lo[v]+size,180]]) {
    const segments = mode === "fillet" ? 16 : 1;
    for (let k=0;k<=segments;k++) {
      const angle=(start+90*k/segments)*Math.PI/180;
      const c = k === 0 || k === segments ? Math.round(Math.cos(angle)) : Math.cos(angle);
      const s = k === 0 || k === segments ? Math.round(Math.sin(angle)) : Math.sin(angle);
      points.push([cx+size*c,cy+size*s]);
    }
  }
  const common = { normal: axis, elevation: lo[n], points, ...(p.priority === undefined ? {} : { priority:p.priority }), ...(p.label ? {label:p.label} : {}) };
  return hi[n] === lo[n] ? {kind:"polygon",...common} : {kind:"linpoly",...common,length:hi[n]-lo[n]};
}
