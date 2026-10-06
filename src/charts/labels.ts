/** Chart label placement helpers (presentational only). */
import { decimalComma } from "../i18n";

/** Approximate advance widths at 11 px: IBM Plex Mono is 0.6 em; Plex Sans averages ~0.55 em. */
export const MONO_ADVANCE = 6.6;
export const SANS_ADVANCE = 6.1;
export const LABEL_H = 14;

/** Replace a leading hyphen-minus with a typographic minus (U+2212). */
export const minus = (s: string) => s.replace(/^-/, "−");

/** A formatted number in the UI language's decimal separator (tick labels, tooltips, the marker
 * table); copied data keep the decimal point. */
export const localDecimal = (s: string) => (decimalComma() ? s.replace(/(\d)\.(\d)/g, "$1,$2") : s);

export interface LabelBox {
  /** anchor x, as passed to <text x> */
  x: number;
  /** baseline y, as passed to <text y> */
  y: number;
  text: string;
  anchor: "start" | "middle" | "end";
  mono?: boolean;
  /** obstacles (e.g. axis labels): placed first and never moved */
  fixed?: boolean;
}

function rect(l: LabelBox) {
  const w = l.text.length * (l.mono ? MONO_ADVANCE : SANS_ADVANCE);
  const x0 = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2;
  return { x0, x1: x0 + w, y0: l.y - LABEL_H + 3, y1: l.y + 3 };
}

/**
 * Greedy vertical declutter: labels are taken top to bottom and any label that overlaps one
 * already placed is pushed down just below it. Keeps x; returns new objects in input order.
 * `bounds` clamps the result (the whole stack is shifted up if it runs past the bottom).
 * `up` mirrors it for labels that sit above their point (a marker on a dip): they are taken
 * bottom to top and pushed up, so the stack grows away from the data, and shifted down if it runs
 * past the top.
 */
export function declutter<T extends LabelBox>(labels: T[], bounds?: { top: number; bottom: number }, gap = 1, up = false): T[] {
  const dir = up ? -1 : 1;
  const order = labels.map((l, i) => ({ l: { ...l }, i })).sort((a, b) => dir * (a.l.y - b.l.y));
  const placed: { l: T; i: number }[] = order.filter((o) => o.l.fixed);
  for (const item of order) {
    if (item.l.fixed) continue;
    if (bounds) item.l.y = up ? Math.min(item.l.y, bounds.bottom) : Math.max(item.l.y, bounds.top);
    let moved = true;
    let guard = 0;
    while (moved && guard++ < 64) {
      moved = false;
      const r = rect(item.l);
      for (const p of placed) {
        const q = rect(p.l);
        // 0.01 px tolerance: without it floating-point rounding can re-detect the same overlap forever
        if (r.x0 < q.x1 - 0.01 && q.x0 < r.x1 - 0.01 && r.y0 < q.y1 + gap - 0.01 && q.y0 < r.y1 + gap - 0.01) {
          // always make progress, even if rounding put the label a hair past the target
          item.l.y = up ? Math.min(item.l.y - 0.5, p.l.y - LABEL_H - gap) : Math.max(item.l.y + 0.5, p.l.y + LABEL_H + gap);
          moved = true;
          break;
        }
      }
    }
    placed.push(item);
  }
  if (bounds && placed.length) {
    const free = placed.filter((p) => !p.l.fixed);
    if (up) {
      const over = free.length ? bounds.top - Math.min(...free.map((p) => p.l.y)) : 0;
      if (over > 0) for (const p of free) p.l.y += over;
    } else {
      const over = free.length ? Math.max(...free.map((p) => p.l.y)) - bounds.bottom : 0;
      if (over > 0) for (const p of free) p.l.y -= over;
    }
  }
  return placed.sort((a, b) => a.i - b.i).map((p) => p.l);
}
