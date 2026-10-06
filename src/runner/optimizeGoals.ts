// Pure text of optimizer goals (no store, no Solid): shared by the progress card and the navigation tree.
import { t } from "../i18n/index.ts";
import type { OptGoal } from "./api.ts";

/** Python's f"{x:g}" for the metric keys ("2.4", "2.45"). */
export const fmtG = (x: number | null | undefined) => (x === null || x === undefined ? "" : String(Number(x.toPrecision(6))));

const sub = (i: number, j: number) => (i < 10 && j < 10 ? `S${i}${j}` : `S${i},${j}`);

/** Goal as shown in the progress card, e.g. "|S23| ≤ −25 dB @ 2.4 GHz"; `tx` tEn for exported files. */
export function goalText(g: OptGoal, tx: typeof t = t): string {
  const at = ` @ ${fmtG(g.at)} GHz`;
  const w = g.weight && g.weight !== 1 ? ` ×${g.weight}` : "";
  const [i, j] = g.ports ?? [1, 1];
  const text = {
    f0: `f0 = ${g.target} GHz`,
    s11_max: `|S11| ≤ ${g.target} dB${at}`,
    bw_min: `BW ≥ ${g.target} MHz`,
    dmax_min: `Dmax ≥ ${g.target} dBi${at}`,
    sij_max: `|${sub(i, j)}| ≤ ${g.target} dB${at}`,
    sij_min: `|${sub(i, j)}| ≥ ${g.target} dB${at}`,
    match_all: `${tx("opt.goalText.allSii")} ≤ ${g.target} dB${at}`,
  }[g.kind];
  return (text ?? g.kind) + w;
}
