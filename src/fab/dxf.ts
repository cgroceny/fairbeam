// DXF R12 (AC1009) writer: closed POLYLINE outlines (VERTEX … SEQEND, flag 70 = 1) and CIRCLEs,
// one named layer per content, in mm ($INSUNITS 4). R12 has no LWPOLYLINE; POLYLINE is what every reader takes.

import type { Region, Ring } from "./polygon.ts";

export interface DxfLayer {
  name: string;
  /** AutoCAD colour index */
  color: number;
  rings: Ring[];
  circles: { x: number; y: number; r: number }[];
}

const g = (code: number, value: string | number) => `${code}\n${typeof value === "number" ? fmt(value) : value}`;
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6))));

export function dxf(layers: DxfLayer[]): string {
  const out: string[] = [];
  const pair = (code: number, value: string | number) => out.push(g(code, value));
  pair(0, "SECTION"); pair(2, "HEADER");
  pair(9, "$ACADVER"); pair(1, "AC1009");
  // the drawing's unit (4 = millimetres): readers do not have to guess it (R12 readers skip a variable they do not know)
  pair(9, "$INSUNITS"); pair(70, 4);
  pair(0, "ENDSEC");
  pair(0, "SECTION"); pair(2, "TABLES");
  pair(0, "TABLE"); pair(2, "LTYPE"); pair(70, 1);
  pair(0, "LTYPE"); pair(2, "CONTINUOUS"); pair(70, 0); pair(3, "Solid line"); pair(72, 65); pair(73, 0); pair(40, 0);
  pair(0, "ENDTAB");
  pair(0, "TABLE"); pair(2, "LAYER"); pair(70, layers.length);
  for (const l of layers) {
    pair(0, "LAYER"); pair(2, l.name); pair(70, 0); pair(62, l.color); pair(6, "CONTINUOUS");
  }
  pair(0, "ENDTAB");
  pair(0, "ENDSEC");
  pair(0, "SECTION"); pair(2, "ENTITIES");
  for (const l of layers) {
    for (const r of l.rings) {
      pair(0, "POLYLINE"); pair(8, l.name); pair(66, 1); pair(70, 1); pair(10, 0); pair(20, 0); pair(30, 0);
      for (const [x, y] of r) {
        pair(0, "VERTEX"); pair(8, l.name); pair(10, x); pair(20, y); pair(30, 0);
      }
      pair(0, "SEQEND"); pair(8, l.name);
    }
    for (const c of l.circles) {
      pair(0, "CIRCLE"); pair(8, l.name); pair(10, c.x); pair(20, c.y); pair(30, 0); pair(40, c.r);
    }
  }
  pair(0, "ENDSEC");
  pair(0, "EOF");
  return out.join("\n") + "\n";
}

export const regionRings = (regions: Region[]): Ring[] => regions.flatMap((r) => [r.outer, ...r.holes]);
