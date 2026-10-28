/** Result-owned requirements. No current Designer state and no stored pass/fail verdict is read. */
import type { Bundle } from '../types.ts';
import { evaluateRequirements, requirementSegments, type RequirementEvaluation, type RequirementSet } from './requirements.ts';

export interface RequirementsSource {
  schema: 'fairbeam.requirement-source/1'; source_id: string; input_sha256: string;
  resolved_parameters: Record<string, number | string | boolean | null>;
}
export interface RequirementsSnapshot {
  schema: 'fairbeam.requirement-snapshot/1'; source_id: string; input_sha256: string;
  requirements: RequirementSet;
}
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
/** Source IDs are produced from exact saved input bytes + resolved run parameters. Here the two
 * separately stored source links must agree. This is provenance, not signature authentication.
 * A mesh-study verdict is deliberately not inferred from the run's energy or a saved flag.
 */
export function savedRequirements(bundle: Bundle): RequirementEvaluation {
  const source = object(bundle.requirements_source), snapshot = object(bundle.requirements_snapshot);
  const valid = source.schema === 'fairbeam.requirement-source/1' && hash(source.source_id) && hash(source.input_sha256) &&
    snapshot.schema === 'fairbeam.requirement-snapshot/1' && snapshot.input_sha256 === source.input_sha256;
  const evaluation = evaluateRequirements(snapshot.requirements, bundle,
    valid ? { sourceId: source.source_id as string, snapshotSourceId: snapshot.source_id as string } : {});
  if (bundle.requirements_snapshot === undefined) evaluation.reason = 'no-snapshot';
  return evaluation;
}

/** Mask-free historical bundles do not acquire the currently edited design's requirements. */
export const hasSavedRequirements = (bundle: Bundle) => bundle.requirements_snapshot !== undefined;

/** Annotations, not sampled traces: never contribute to extrema, markers, interpolation or axes. */
export function requirementPlotSegments(bundle: Bundle, pairs: readonly (readonly [number, number])[]) {
  const evaluation = savedRequirements(bundle);
  if (!evaluation.sourceId || ['source-mismatch', 'invalid-spectrum', 'requirements-schema'].includes(evaluation.reason ?? '') || !evaluation.requirements) return [];
  const excited = bundle.ports.filter(p => p.excite === true).map(p => p.number);
  const primary = excited.length === 1 ? excited[0] : bundle.ports.length === 1 ? bundle.ports[0].number : null;
  return requirementSegments(evaluation.requirements).flatMap(segment => {
    const selected = segment.ports ? pairs.filter(p => p[0] === segment.ports![0] && p[1] === segment.ports![1]) :
      pairs.filter(p => p[0] === p[1] && (segment.kind === 'match_all' || p[0] === primary));
    return selected.map(pair => ({ x0: segment.fromHz / 1e9, x1: segment.toHz / 1e9, y: segment.valueDb,
      label: `${segment.id}: S(${pair.join(',')}) ${segment.direction === 'min' ? '≥' : '≤'} ${segment.valueDb} dB` }));
  });
}
