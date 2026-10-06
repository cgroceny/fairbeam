import { evaluate } from "./expr.ts";
import { t } from "../i18n/index.ts";
import type { Design, ParameterSweepDefinition, ParameterSweepSequence } from "./types";

export const MAX_SWEEP_CELLS = 500;
/** The server's MAX_SEQUENCES / MAX_SEQUENCE_AXES (python/fairbeam/server.py). */
export const MAX_SWEEP_SEQUENCES = 100;
export const MAX_SEQUENCE_AXES = 6;
/** Match the server's ten-significant-digit rounding for linear ranges. */
const nice = (value: number) => Number(value.toPrecision(10));
export interface PlannedSequence { name: string; sweep: ({ key: string; values: number[] } | { key: string; start: number; stop: number; steps: number })[]; count: number }
export interface SweepPlan { sequences: PlannedSequence[]; count: number; warning: string | null; error: string | null; estimateSeconds: number | null }

/**
 * Validate and count a sweep the way the run server will (expand_sequences). `intKeys` are the
 * parameters the server types as int (a model's `int` specs; a design's parameters are all float):
 * like the server, their samples must be whole numbers.
 */
export function planParameterSweep(definition: ParameterSweepDefinition, design: Design, names: Record<string, number>, lastDuration: number | null = null, previewCells: number | null = null, intKeys: ReadonlySet<string> = new Set()): SweepPlan {
  const independent = new Map((design.params ?? []).filter((p) => p.expr === undefined).map((p) => [p.key, p]));
  const planned: PlannedSequence[] = [];
  try {
    if (definition.schema !== "fairbeam.parameter-sweep/1" || !definition.sequences.length) throw new Error(t("sweep.plan.noSequence"));
    if (definition.sequences.length > MAX_SWEEP_SEQUENCES) throw new Error(t("sweep.plan.tooManySequences", { n: definition.sequences.length, max: MAX_SWEEP_SEQUENCES }));
    let total = 0;
    const sequenceNames = new Set<string>();
    for (const sequence of definition.sequences) {
      if (sequenceNames.has(sequence.name.trim())) throw new Error(t("sweep.plan.duplicateName", { name: sequence.name }));
      sequenceNames.add(sequence.name.trim());
      const p = planSequence(sequence, independent, names, intKeys);
      total += p.count;
      if (total > MAX_SWEEP_CELLS) throw new Error(t("sweep.plan.tooManyCells", { n: total, max: MAX_SWEEP_CELLS }));
      planned.push(p);
    }
    const estimateSeconds = lastDuration != null ? total * lastDuration : previewCells != null && previewCells > 0 ? total * previewCells / 1e6 : null;
    return { sequences: planned, count: total, warning: total > 50 ? t("sweep.plan.large") : null, error: null, estimateSeconds };
  } catch (error) {
    return { sequences: planned, count: planned.reduce((n, s) => n + s.count, 0), warning: null, error: error instanceof Error ? error.message : String(error), estimateSeconds: null };
  }
}

function planSequence(sequence: ParameterSweepSequence, independent: Map<string, Design["params"][number]>, names: Record<string, number>, intKeys: ReadonlySet<string>): PlannedSequence {
  if (!sequence.name.trim()) throw new Error(t("sweep.plan.noName"));
  if (sequence.name.trim().length > 80 || /[\r\n\x00-\x1f]/.test(sequence.name)) throw new Error(t("sweep.plan.badName"));
  if (!sequence.axes.length) throw new Error(t("sweep.plan.noAxis", { name: sequence.name }));
  if (sequence.axes.length > MAX_SEQUENCE_AXES) throw new Error(t("sweep.plan.tooManyAxes", { name: sequence.name, max: MAX_SEQUENCE_AXES }));
  const seen = new Set<string>();
  let count = 1;
  const sweep: PlannedSequence["sweep"] = [];
  const value = (text: string) => {
    if (!text.trim()) throw new Error(t("sweep.plan.emptyValue"));
    const n = evaluate(text, names);
    if (!Number.isFinite(n)) throw new Error(t("sweep.plan.notFinite"));
    return n;
  };
  for (const axis of sequence.axes) {
    if (seen.has(axis.key)) throw new Error(t("sweep.plan.duplicateAxis", { name: sequence.name, key: axis.key }));
    seen.add(axis.key);
    const param = independent.get(axis.key);
    if (!param) throw new Error(t("sweep.plan.unknownParam", { name: sequence.name, key: axis.key }));
    let values: number[];
    if (axis.kind === "range") {
      const start = value(axis.start), stop = value(axis.stop), steps = Number(axis.steps);
      if (!Number.isInteger(steps) || steps < 1 || steps > MAX_SWEEP_CELLS) throw new Error(t("sweep.plan.badSteps", { key: axis.key, max: MAX_SWEEP_CELLS }));
      values = steps === 1 ? [start] : Array.from({ length: steps }, (_, i) => nice(start + (stop - start) * i / (steps - 1)));
      if (new Set(values).size !== values.length) throw new Error(t("sweep.plan.collapsed", { key: axis.key }));
      sweep.push({ key: axis.key, start, stop, steps });
    } else {
      const tokens = axis.list.split(/[,;\r\n]+/).map((s) => s.trim()).filter(Boolean);
      if (!tokens.length) throw new Error(t("sweep.plan.emptyList", { key: axis.key }));
      values = tokens.map(value);
      if (new Set(values).size !== values.length) throw new Error(t("sweep.plan.duplicateList", { key: axis.key }));
      sweep.push({ key: axis.key, values });
    }
    for (const n of values) {
      // the server refuses a non-whole sample of an int parameter (validate_params) rather than rounding it
      if (intKeys.has(axis.key) && !Number.isInteger(n)) throw new Error(t("sweep.plan.notWhole", { key: axis.key, value: String(n) }));
      if (param.min != null && n < param.min) throw new Error(t("sweep.plan.belowMin", { key: axis.key, value: String(n), min: String(param.min) }));
      if (param.max != null && n > param.max) throw new Error(t("sweep.plan.aboveMax", { key: axis.key, value: String(n), max: String(param.max) }));
    }
    count *= values.length;
    if (count > MAX_SWEEP_CELLS) throw new Error(t("sweep.plan.gridTooLarge", { max: MAX_SWEEP_CELLS }));
  }
  return { name: sequence.name, sweep, count };
}
