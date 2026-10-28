import type { Bundle } from '../types.ts';
import { savedRequirements } from '../lib/requirementsSnapshot.ts';
import { toCsv } from './csv.ts';

// File exports use fixed English descriptions and locale-free numeric values.
const REPORT_TEXT: Readonly<Record<string, string>> = {
  "requirements.verdict.pass": "Pass",
  "requirements.verdict.fail": "Fail",
  "requirements.verdict.unknown": "Unknown",
  "requirements.qualification.converged": "Qualified",
  "requirements.qualification.not-converged": "Not converged",
  "requirements.qualification.unknown": "Not verified",
  "requirements.qualification.suspicious": "Review result quality",
  "requirements.reason.requirements-schema": "The saved requirement format is missing, unsupported, or exceeds 64 items.",
  "requirements.reason.requirement-id": "Use distinct requirement IDs and names of at most 160 characters.",
  "requirements.reason.requirement-goal": "Choose a supported quantity with a finite limit and a positive optimizer weight.",
  "requirements.reason.requirement-frequency": "Enter a finite, positive frequency in GHz for this quantity.",
  "requirements.reason.requirement-band": "The upper edge must exceed the lower edge. Bands are supported only for S-parameter limits.",
  "requirements.reason.requirement-ports": "Sij limits require two positive integer physical port IDs. Other quantities do not take port selectors.",
  "requirements.reason.requirement-target": "Use a valid limit: negative reflection/isolation, nonpositive transmission, positive resonance/bandwidth, or efficiency above 0% and at most 100%.",
  "requirements.reason.source-mismatch": "Requirements are not bound to this saved run. Load its original requirement snapshot.",
  "requirements.reason.invalid-spectrum": "The frequency grid or physical-port mapping is missing or invalid, or this is a session-transformed result.",
  "requirements.reason.no-requirements": "This saved run has no requirements.",
  "requirements.reason.incomplete-band": "The stored spectrum does not cover the requested frequency range.",
  "requirements.reason.missing-driven-port": "A unique driven physical port is unavailable.",
  "requirements.reason.missing-or-invalid-trace": "A required trace is missing or contains invalid samples. Corrupt columns are not repaired by reciprocity.",
  "requirements.reason.unsupported-band-threshold": "This bandwidth objective requires the optimizer’s −10 dB definition.",
  "requirements.reason.open-band-lower-bound": "The observed bandwidth is a lower bound at the sweep boundary; it cannot establish failure of the requested width.",
  "requirements.reason.missing-exact-field": "One matching stored far field for this driven port and frequency is required. Nearby or duplicate fields are not substituted.",
  "requirements.reason.unqualified-field": "The field frequency or run convergence is not qualified.",
  "requirements.reason.unqualified-field-power": "Gain/efficiency needs consistent finite accepted/radiated power and a converged run with an energy criterion of −60 dB or stricter.",
  "requirements.reason.invalid-data": "The required value is missing or nonfinite.",
  "requirements.reason.energy-unqualified": "The numeric result is not certified because energy convergence or result quality is unverified.",
  "requirements.reason.mesh-unqualified": "The numeric result is not certified because a qualifying mesh study for this exact source is unavailable.",
  "requirements.reason.work-limit": "This mask exceeds the interactive evaluation work limit. Reduce the number of requirements or spectrum samples.",
  "requirements.reason.no-snapshot": "This result has no saved requirement snapshot. The current design's requirements are not applied to historical results."
};
const reportText = (key: string): string => REPORT_TEXT[key] ?? key;

export const REQUIREMENTS_REPORT_SCOPE = 'Requirements saved with this run, evaluated on stored samples only. Numeric limits, energy convergence and mesh qualification are separate. Missing data, missing source identity and missing verified mesh-study membership remain unknown. A sampled pass is not a continuous-band or physical accuracy certificate.';
export const REQUIREMENTS_REPORT_HEADERS = ['Requirement', 'Quantity', 'Target', 'Value', 'Unit', 'Numeric limit', 'Reason'];

/** Full saved list (bounded to 64 by admission), never current editor masks or stored verdicts. */
export function bundleRequirementsReport(bundle: Bundle) {
  const evaluation = savedRequirements(bundle);
  return { evaluation, scope: REQUIREMENTS_REPORT_SCOPE, sourceId: evaluation.sourceId,
    status: reportText(`requirements.verdict.${evaluation.status}`), metric: reportText(`requirements.verdict.${evaluation.metric}`),
    energy: reportText(`requirements.qualification.${evaluation.energy}`), mesh: reportText(`requirements.qualification.${evaluation.mesh}`),
    reason: evaluation.reason ? reportText(`requirements.reason.${evaluation.reason}`) : '',
    rows: evaluation.items.map((item, i) => { const requirement = evaluation.requirements!.items[i];
      return [requirement.label || requirement.id, requirement.goal.kind, String(requirement.goal.target),
        item.value === null ? '—' : String(item.value), item.unit, reportText(`requirements.verdict.${item.metric}`),
        item.reason ? reportText(`requirements.reason.${item.reason}`) : '']; }),
  };
}

/** Machine-readable values include masks, physical source IDs and qualification on every row. */
export function requirementsCsv(bundle: Bundle): string {
  const e = savedRequirements(bundle);
  const headers = ['source_id', 'input_sha256', 'requirement_id', 'kind', 'target', 'at_ghz', 'at_hi_ghz', 'ports', 'weight',
    'value', 'unit', 'numeric_verdict', 'qualified_verdict', 'energy', 'mesh', 'reason', 'method', 'samples', 'frequencies_hz', 'sources', 'lower_bound'];
  const shared = [e.sourceId, bundle.requirements_source?.input_sha256];
  const rows = e.items.length ? e.items.map((item, i) => { const r = e.requirements!.items[i], g = r.goal;
    return [...shared, r.id, g.kind, g.target, g.at, g.at_hi, g.ports?.join(' '), g.weight ?? 1,
      item.value, item.unit, item.metric, e.status, e.energy, e.mesh, item.reason ?? e.reason, item.method, item.samples,
      JSON.stringify(item.frequenciesHz), JSON.stringify(item.sources), item.lowerBound]; }) :
    [[...shared, '', '', '', '', '', '', '', '', '', e.metric, e.status, e.energy, e.mesh, e.reason, '', '', '', '', '']];
  return toCsv(headers, rows);
}
