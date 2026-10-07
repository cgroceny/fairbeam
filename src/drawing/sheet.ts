// Drawing sheet: ISO 5457 frame with centring marks, an ISO 7200-style title block with parameter
// and material tables, the ISO 5456-2 projection symbol and a notes block.

import type { Bundle } from "../types";
import { roleOf, type Projection } from "./geometry.ts";
import { fit, textWidth, wrap } from "./metrics.ts";
import { circle, group, line, polygon, rect, text } from "./svg.ts";

export type SheetSize = "A4" | "A3";

export const SHEETS: Record<SheetSize, { w: number; h: number }> = {
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
};

/** Drawing frame: 20 mm filing margin on the left, 10 mm elsewhere. */
export function frameRect(size: SheetSize): [number, number, number, number] {
  const s = SHEETS[size];
  return [20, 10, s.w - 10, s.h - 10];
}

export function frame(size: SheetSize, thick: number, thin: number): string {
  const s = SHEETS[size];
  const [x0, y0, x1, y1] = frameRect(size);
  const marks = [
    line(s.w / 2, 0, s.w / 2, y0 + 5), line(s.w / 2, y1 - 5, s.w / 2, s.h),
    line(0, s.h / 2, x0 + 5, s.h / 2), line(x1 - 5, s.h / 2, s.w, s.h / 2),
  ];
  return group([
    rect(x0, y0, x1 - x0, y1 - y0, { fill: "none", stroke: "#000", "stroke-width": thick }),
    group(marks, { stroke: "#000", "stroke-width": thick }),
    // trimming corners (thin) so the sheet edge is visible on screen
    rect(0.2, 0.2, s.w - 0.4, s.h - 0.4, { fill: "none", stroke: "#000", "stroke-width": thin * 0.5, "stroke-opacity": 0.35 }),
  ], { class: "frame" });
}

/** ISO 5456-2 projection method symbol (truncated cone), `h` = symbol height. */
export function projectionSymbol(x: number, y: number, h: number, projection: Projection, sw: number): string {
  // elevation: trapezoid (cone seen from the side); end view: two concentric circles
  const d1 = h; // large diameter
  const d2 = h / 2; // small diameter
  const len = h * 1.1;
  const gap = h * 0.45;
  const cy = y + h / 2;
  // third angle: the small end of the cone points at the circles; first angle: the large end does
  const big = projection === "third" ? 0 : 1;
  const xa = x;
  const xb = x + len;
  const hA = big === 0 ? d1 / 2 : d2 / 2;
  const hB = big === 0 ? d2 / 2 : d1 / 2;
  const cone = polygon(
    [
      [xa, cy - hA],
      [xb, cy - hB],
      [xb, cy + hB],
      [xa, cy + hA],
    ],
    { fill: "none", stroke: "#000", "stroke-width": sw },
  );
  const ccx = xb + gap + d1 / 2;
  const axis = line(x - 1, cy, ccx + d1 / 2 + 1, cy, { stroke: "#000", "stroke-width": sw * 0.5, "stroke-dasharray": "3 0.6 0.4 0.6" });
  return group([
    cone,
    circle(ccx, cy, d1 / 2, { fill: "none", stroke: "#000", "stroke-width": sw }),
    circle(ccx, cy, d2 / 2, { fill: "none", stroke: "#000", "stroke-width": sw }),
    axis,
  ]);
}

export function projectionSymbolWidth(h: number) {
  return h * 1.1 + h * 0.45 + h;
}

export interface TitleInfo {
  scale: string;
  size: SheetSize;
  projection: Projection;
  date: string;
  version: string;
}

interface Cell {
  w: number;
  label: string;
  value: string;
  big?: boolean;
  custom?: (x: number, y: number, w: number, h: number) => string;
}

const fmtVal = (v: number | string) => (typeof v === "number" ? String(Number(v.toPrecision(6))).replace(/^-/, "−") : v);

/**
 * Parameters that describe the geometry (lengths, angles, counts such as fractal iterations).
 * Solver, mesh and band settings and the material constants (shown in the materials table) are
 * left to the README / PDF report, which list every parameter.
 */
export function geometryParams(b: Bundle) {
  const skip = /mesh|cell|div|refine|thirds|boundary|band|freq|thread|^f_|_r$|^eps|tan_?d|^pad$/i;
  return b.model.params.filter((p) => !/^(ghz|mhz|hz|ohm|Ω|s\/m)$/i.test(p.unit) && !skip.test(p.key) && !/mesh|cells? |band (start|stop)/i.test(p.label));
}

export function paramRows(b: Bundle): string[][] {
  return geometryParams(b).map((p) => {
    const changed = p.value !== p.default;
    return [p.label || p.key, p.key, `${fmtVal(p.value)}${p.unit ? ` ${p.unit}` : ""}${changed ? " *" : ""}`];
  });
}

export function materialRows(b: Bundle): string[][] {
  const rows = b.parts.map((p) => {
    const role = roleOf(p);
    const label = p.label ?? p.name;
    if (role === "metal") {
      const c = p.conductor;
      const kind = c ? `${c.thickness !== null ? `Conducting sheet ${fmtVal(c.thickness)} mm` : "Metal"}, σ ${c.conductivity.toPrecision(3)} S/m` : p.type === "ConductingSheet" ? "Conducting sheet" : "PEC";
      return [label, kind, "—", "—"];
    }
    if (p.material) {
      const m = p.material;
      // an instant preview carries no loss: "—" (a run or a server preview has tan δ, or the conductivity)
      const tan = m.tan_d == null ? (typeof m.kappa === "number" ? `σ ${m.kappa.toPrecision(3)} S/m` : "—") : `${fmtVal(m.tan_d)}${m.tan_d_freq ? ` @ ${fmtVal(m.tan_d_freq / 1e9)} GHz` : ""}`;
      return [label, m.mu_r !== 1 ? `Dielectric, μr ${fmtVal(m.mu_r)}` : "Dielectric", fmtVal(m.eps_r), tan];
    }
    return [label, p.type, "—", "—"];
  });
  if (b.half_space) rows.push(["Ground (boundary)", `${b.half_space.kind}, infinite`, "—", "—"]);
  return rows;
}

/** Title block of width `w`. Returns its height and a renderer. */
export function titleBlock(b: Bundle, info: Omit<TitleInfo, "scale">, st: { fs: number; thick: number; thin: number }): {
  w: number;
  h: number;
  render: (x: number, y: number, scale: string) => string;
} {
  const w = 180;
  const rowH = st.fs * 1.42;
  const params = paramRows(b);
  const mats = materialRows(b);
  const tableRows = Math.max(params.length, mats.length) + 1;
  const tablesH = tableRows * rowH;
  const labelFs = st.fs * 0.68;
  const idH = [st.fs * 3.6, st.fs * 2.9, st.fs * 2.9];
  const h = tablesH + idH.reduce((a, c) => a + c, 0);
  const pw = [40, 22, 22];
  const mw = [30, 30, 14, 22];

  const render = (x: number, y: number, scale: string) => {
    const out: string[] = [];
    const thinL: string[] = [];
    const texts: string[] = [];
    out.push(rect(x, y, w, h, { fill: "#fff", stroke: "#000", "stroke-width": st.thick }));
    // --- tables
    const table = (x0: number, widths: number[], head: string[], rows: string[][], alignRight: number[]) => {
      let cx = x0;
      widths.forEach((cw, i) => {
        if (i) thinL.push(line(cx, y, cx, y + tablesH));
        texts.push(text(cx + 1.2, y + rowH * 0.74, head[i], { "font-weight": 600, "font-size": st.fs * 0.76 }));
        rows.forEach((r, j) => {
          const v = fit(r[i] ?? "", st.fs * 0.76, cw - 2.4);
          const ty = y + rowH * (j + 1) + rowH * 0.74;
          texts.push(
            alignRight.includes(i)
              ? text(cx + cw - 1.2, ty, v, { "text-anchor": "end", "font-size": st.fs * 0.76 })
              : text(cx + 1.2, ty, v, { "font-size": st.fs * 0.76 }),
          );
        });
        cx += cw;
      });
    };
    for (let j = 1; j < tableRows; j++) thinL.push(line(x, y + j * rowH, x + w, y + j * rowH, { "stroke-opacity": j === 1 ? 1 : 0.35 }));
    table(x, pw, ["Geometry parameter", "Key", "Value"], params, [2]);
    const mx = x + pw.reduce((a, c) => a + c, 0);
    out.push(line(mx, y, mx, y + tablesH, { stroke: "#000", "stroke-width": st.thick }));
    table(mx, mw, ["Part", "Material", "εr", "tan δ"], mats, [2]);
    out.push(line(x, y + tablesH, x + w, y + tablesH, { stroke: "#000", "stroke-width": st.thick }));

    // --- identification rows
    const changed = geometryParams(b).some((p) => p.value !== p.default);
    const rows: Cell[][] = [
      [
        { w: 140, label: "Title", value: b.name, big: true },
        { w: 40, label: "Sheet", value: "1 / 1" },
      ],
      [
        { w: 52, label: "Model", value: b.model.id },
        { w: 24, label: "Scale", value: scale },
        { w: 18, label: "Units", value: "mm" },
        {
          w: 56, label: `Projection: ${info.projection === "third" ? "third angle" : "first angle"}`, value: "",
          custom: (cx, cy, cw, ch) => projectionSymbol(cx + cw - projectionSymbolWidth(ch * 0.5) - 3, cy + ch * 0.3, ch * 0.5, info.projection, st.thin),
        },
        { w: 30, label: "Size", value: info.size },
      ],
      [
        { w: 30, label: "Date", value: info.date },
        { w: 42, label: "Generator", value: `Fairbeam ${info.version}` },
        { w: 78, label: "Solver", value: `${b.solver.engine}${b.generator.openems ? ` ${b.generator.openems.split(/\.post|\+/)[0]}` : ""} · ${b.solver.method.split(" (")[0]}` },
        { w: 30, label: "Drawing no.", value: `${b.model.id.toUpperCase().slice(0, 14)}-01` },
      ],
    ];
    let cy = y + tablesH;
    rows.forEach((r, i) => {
      const ch = idH[i];
      if (i) out.push(line(x, cy, x + w, cy, { stroke: "#000", "stroke-width": st.thin }));
      let cx = x;
      r.forEach((c, k) => {
        if (k) out.push(line(cx, cy, cx, cy + ch, { stroke: "#000", "stroke-width": st.thin }));
        texts.push(text(cx + 1.2, cy + labelFs + 0.8, c.label, { "font-size": labelFs, fill: "#444" }));
        if (c.custom) out.push(c.custom(cx, cy, c.w, ch));
        else {
          const fs = c.big ? st.fs * 1.4 : st.fs;
          texts.push(text(cx + 1.2, cy + ch - (c.big ? 1.6 : 1.1), fit(c.value, fs, c.w - 2.4, c.big ? 600 : 400), { "font-size": fs, "font-weight": c.big ? 600 : undefined }));
        }
        cx += c.w;
      });
      cy += ch;
    });
    if (changed) {
      texts.push(text(x + 1.2, y - 1.2, "* differs from the model default", { "font-size": labelFs, fill: "#444" }));
    }
    return group([
      ...out,
      group(thinL, { stroke: "#000", "stroke-width": st.thin }),
      group(texts, { fill: "#000" }),
    ], { class: "title-block" });
  };
  return { w, h, render };
}

export function notesBlock(notes: string[], width: number, fs: number): { w: number; h: number; render: (x: number, y: number) => string } {
  const lh = fs * 1.4;
  const lines: { t: string; indent: number }[] = [];
  notes.forEach((n, i) => {
    wrap(`${i + 1}. ${n}`, fs, width - fs * 1.4).forEach((l, j) => lines.push({ t: l, indent: j ? fs * 1.3 : 0 }));
  });
  const h = lh * (lines.length + 1) + 1;
  const maxW = Math.max(textWidth("NOTES", fs, 600), ...lines.map((l) => l.indent + textWidth(l.t, fs)));
  const w = Math.min(width, maxW + 1);
  return {
    w,
    h,
    render: (x, y) =>
      group(
        [
          text(x, y + fs, "NOTES", { "font-weight": 600 }),
          ...lines.map((l, i) => text(x + l.indent, y + fs + lh * (i + 1), l.t)),
        ],
        { "font-size": fs, fill: "#000", class: "notes" },
      ),
  };
}
