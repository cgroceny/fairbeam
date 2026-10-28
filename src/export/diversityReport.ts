import type { Bundle } from "../types.ts";
import { mimoAnalysis, type MimoAnalysis, type MimoValue } from "../lib/mimo.ts";
import { DIVERSITY_ASSUMPTIONS } from "./diversity.ts";

// File exports use fixed English descriptions and locale-free numeric values.
const REPORT_TEXT: Readonly<Record<string, string>> = {
  "mimo.warning.efficiencyUnknown": "Radiation efficiency is unknown at some exact port/frequency samples. Negligible dissipative loss has not been established; S-based estimates may differ from field correlation.",
  "mimo.warning.lossy": "Known radiation efficiency is below 0.9 at one or more samples. Treat S-based correlation, DG, CCL and MEG as lossless approximations; prefer field ECC when available.",
  "mimo.warning.efficiencyInvalid": "A recorded radiation efficiency exceeds 1. Review the original run and power balance before interpreting diversity estimates.",
  "mimo.warning.disagreement": "The absolute difference between S-based and field ECC exceeds 0.05 at one or more samples. Review loss, pattern sampling and numerical evidence; this warning is not an acceptance threshold.",
  "mimo.reason.matrix": "Diversity needs a stored matrix for 2–64 physical ports. Run all ports and reopen its result.",
  "mimo.reason.phase": "The imported data have no measured complex S-parameter phase. Diversity values are unavailable.",
  "mimo.reason.processed": "This view has transformed port waves. Use the original run so S-parameters and stored fields share the same incident-wave basis.",
  "mimo.reason.mapping": "Physical port identities are missing, duplicated or inconsistent with the stored matrix. Open an unmodified complete run.",
  "mimo.reason.complete": "A complete S-matrix with every physical port excited is required. Missing entries or columns are not assumed to be zero.",
  "mimo.reason.references": "Finite positive real power-wave references are required for every port.",
  "mimo.reason.frequency": "Stored S frequencies must be positive, finite, unique and increasing.",
  "mimo.reason.nonfinite": "A required sample is missing, nonfinite or malformed. It has not been replaced with a numerical value.",
  "mimo.reason.passivity": "The stored S-matrix fails the full passive-power check at this frequency. Diversity estimates from that matrix are unavailable.",
  "mimo.reason.weights": "TARC needs one finite complex incident weight per physical port and nonzero total incident power.",
  "mimo.reason.singular": "The accepted-power matrix is singular or numerically unresolved. A finite CCL cannot be reported.",
  "mimo.reason.denominator": "A port pair has zero or invalid accepted-power normalization. S-based ECC and its DG proxy are unavailable.",
  "mimo.reason.pair": "Choose two distinct physical ports present in the matched field data.",
  "mimo.reason.fieldGrid": "Field ECC needs an ordered full-sphere angular grid with distinct periodic azimuth samples.",
  "mimo.reason.zeroField": "A field norm is zero or invalid, so its normalized correlation is unavailable.",
  "mimo.reason.exactS": "No S-matrix is stored at this exact field frequency. No interpolation is presented as a new sample.",
  "mimo.reason.pattern": "No admissible full-sphere matched-basis complex fields exist at this exact frequency. Missing or corrupt fields and mirrored/half-space data are not used."
};
const reportText = (key: string): string => REPORT_TEXT[key] ?? key;

export const DIVERSITY_REPORT_SCOPE = "Stored source run only. Report/package exports have no session excitation weights, so TARC remains unavailable; export the Diversity panel CSV to retain its current weights. Ranges below summarize finite stored samples, without interpolation or mesh/antenna qualification. Full frequency rows, reasons and warnings are in the diversity CSV when data are included.";
export const DIVERSITY_REPORT_HEADERS = ["Physical ports", "Metric (unit)", "Min", "Max", "Available / total"];

/** Bounded report presentation of the same numeric analysis used by CSV. All absent
 * samples remain counted. Limiting report groups never silently limits the data export. */
export function diversitySummary(a: MimoAnalysis, maxGroups = 64) {
  const groups = new Map<string, { ports: string; metric: string; values: number[]; total: number }>();
  const reasons = new Set<string>(), warnings = new Set<string>();
  if (a.reason) reasons.add(a.reason);
  const add = (ports: string, metric: string, v: MimoValue) => {
    const key = `${ports}:${metric}`;
    let group = groups.get(key);
    if (!group) { group = { ports, metric, values: [], total: 0 }; groups.set(key, group); }
    group.total++;
    if (v.value !== null && Number.isFinite(v.value)) group.values.push(v.value);
    else reasons.add(v.reason ?? "mimo.reason.nonfinite");
  };
  for (const row of a.rows) {
    row.warnings.forEach(w => warnings.add(w));
    for (const pair of row.pairs) {
      const ports = pair.ports.map(p => `P${p}`).join(" / ");
      add(ports, "ECC S (1)", pair.eccS); add(ports, "ECC field (1)", pair.eccField);
      add(ports, "DG proxy S (dB)", pair.dgS); add(ports, "DG proxy field (dB)", pair.dgField);
      pair.warnings.forEach(w => warnings.add(w));
    }
    add("All ports", "TARC (1)", row.tarc); add("All ports", "CCL S (bits/s/Hz)", row.ccl);
    row.meg.forEach(m => add(`P${m.port}`, "MEG S (1)", m.estimate));
  }
  const display = (values: number[], low: boolean) => values.length
    ? values.reduce((a, b) => low ? Math.min(a, b) : Math.max(a, b)).toPrecision(6) : "—";
  const limit = Number.isSafeInteger(maxGroups) && maxGroups >= 0 ? maxGroups : 64;
  const all = [...groups.values()];
  return {
    rows: all.slice(0, limit).map(g => [g.ports, g.metric, display(g.values, true), display(g.values, false), `${g.values.length} / ${g.total}`]),
    omittedGroups: Math.max(0, all.length - limit),
    reasons: [...reasons].map(k => reportText(k)), warnings: [...warnings].map(k => reportText(k)),
    frequencyHz: a.rows.length ? [a.rows[0].frequency, a.rows[a.rows.length - 1].frequency] : null,
  };
}

export function bundleDiversityReport(b: Bundle) {
  if (!b.results || !Array.isArray(b.ports) || b.ports.length < 2) return null;
  const analysis = mimoAnalysis(b);
  return { ...diversitySummary(analysis), scope: DIVERSITY_REPORT_SCOPE, assumptions: DIVERSITY_ASSUMPTIONS };
}
