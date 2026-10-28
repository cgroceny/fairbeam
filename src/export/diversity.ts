import type { MimoAnalysis, MimoValue } from "../lib/mimo.ts";
import { toCsv } from "./csv.ts";

export const DIVERSITY_ASSUMPTIONS = "S estimates: lossless reciprocal antenna, matched unused ports, isotropic unpolarized environment; R=I-S^H S. ECC_field: normalized complex full-sphere field inner product at exact stored frequencies only, cell solid-angle quadrature. DG proxy=10 sqrt(1-ECC^2) dB, not measured outage gain. TARC=norm(S a)/norm(a), reflected-wave ratio for the explicitly recorded physical-port weights; it excludes dissipative loss. CCL=-log2 det(R) bits/s/Hz is a high-SNR antenna-only approximation, not measured channel capacity. MEG_S=R_ii/2, a linear isotropic lossless estimate. Disagreement warning: absolute ECC difference >0.05; low radiation-efficiency warning: eta<0.9. These warnings do not qualify a design or mesh.";

/** Selected run and excitation snapshot, locale-independent numbers. Missing values stay blank
 * beside their explicit reason; no sparse field samples are connected or interpolated. */
export function diversityCsv(a: MimoAnalysis, selectedPair?: readonly [number, number]): string {
  const rows: (string | number | null)[][] = [];
  const excitation = a.weights.map(w => `P${w.port}=${w.re}+j(${w.im})`).join("; ");
  const add = (f: number | null, pair: string, metric: string, units: string, result: MimoValue, warnings: string[]) =>
    rows.push([f, pair, metric, units, result.value, result.reason, warnings.join("; "), excitation, DIVERSITY_ASSUMPTIONS]);
  if (a.reason) add(null, "", "unavailable", "", { value: null, reason: a.reason }, []);
  for (const row of a.rows) {
    for (const p of row.pairs.filter(p => !selectedPair || p.ports[0] === selectedPair[0] && p.ports[1] === selectedPair[1])) {
      const pair = p.ports.map(p => `P${p}`).join(" / ");
      add(row.frequency, pair, "ECC_S", "1", p.eccS, p.warnings);
      add(row.frequency, pair, "ECC_field", "1", p.eccField, p.warnings);
      add(row.frequency, pair, "DG_proxy_S", "dB", p.dgS, p.warnings);
      add(row.frequency, pair, "DG_proxy_field", "dB", p.dgField, p.warnings);
    }
    add(row.frequency, "all ports", "TARC", "1", row.tarc, row.warnings);
    add(row.frequency, "all ports", "CCL_S_estimate", "bits/s/Hz", row.ccl, row.warnings);
    row.meg.forEach(m => add(row.frequency, `P${m.port}`, "MEG_S_estimate", "1", m.estimate, row.warnings));
  }
  return toCsv(["frequency_Hz", "physical_ports", "metric", "unit", "value", "unavailable_reason", "warnings", "complex_incident_weights", "assumptions"], rows);
}
