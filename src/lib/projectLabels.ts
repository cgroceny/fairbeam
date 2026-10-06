// Labels for the project pickers (header, start screen, Compare). Results saved from runs of the
// same model share the model's display name ("Win patch" for a CPU and a CUDA run); a name that
// occurs more than once gets a short suffix from what the index says about each run. Unique names
// are left alone.

export interface LabelSource {
  file: string;
  name: string | null;
  /** "CPU", "Metal", "CUDA" or "GPU"; written by newer run servers (python/fairbeam/cli.py) */
  engine?: string;
  /** parameters set to something other than their default; newer indexes only */
  params?: Record<string, number | string | boolean>;
  /** "2026-09-25T21:20:31+0300" */
  created?: string | null;
}

const SEP = " · ";

const fmtValue = (v: number | string | boolean) =>
  typeof v === "number" ? String(Number.isInteger(v) ? v : +v.toPrecision(6)) : String(v);

/** "2026-09-25 21:20" in the time zone the run was saved in (no conversion, so it matches the file) */
function stamp(created: string | null | undefined, withDate: boolean, withSeconds: boolean): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/.exec(created ?? "");
  if (!m) return "";
  const time = m[2] + (withSeconds && m[3] ? m[3] : "");
  return withDate ? `${m[1]} ${time}` : time;
}

const unique = (xs: string[]) => new Set(xs).size === xs.length;
const varies = (xs: string[]) => new Set(xs).size > 1;
const fileStem = (f: string) => f.replace(/\.json$/i, "");

/** Suffixes that tell the entries of one same-name group apart, most telling first. */
function suffixes(group: LabelSource[]): string[] {
  const parts: string[][] = group.map(() => []);
  const done = () => unique(parts.map((p) => p.join(SEP)));
  const add = (values: string[]) => {
    if (!varies(values)) return;
    values.forEach((v, i) => v && parts[i].push(v));
  };

  // 1. the engine: CPU / Metal / CUDA
  add(group.map((e) => e.engine ?? ""));
  // 2. the parameters that differ within the group
  if (!done()) {
    const keys = [...new Set(group.flatMap((e) => Object.keys(e.params ?? {})))];
    const val = (e: LabelSource, k: string) => (e.params && k in e.params ? fmtValue(e.params[k]) : "");
    const differing = keys.filter((k) => varies(group.map((e) => val(e, k))));
    add(group.map((e) => differing.filter((k) => val(e, k)).map((k) => `${k}=${val(e, k)}`).join(", ")));
  }
  // 3. when the run was saved: the time, with the date when the runs span several days
  if (!done()) {
    const dates = group.map((e) => stamp(e.created, true, false).slice(0, 10));
    const withDate = varies(dates.filter(Boolean));
    let times = group.map((e) => stamp(e.created, withDate, false));
    if (!unique(times)) times = group.map((e) => stamp(e.created, withDate, true));
    add(times);
  }
  // 4. last resort: the file name
  if (!done()) return group.map((e) => fileStem(e.file));
  return parts.map((p) => p.join(SEP));
}

/** Picker label per file: the project name, plus a distinguishing suffix when names repeat. */
export function projectLabels(entries: readonly LabelSource[]): Map<string, string> {
  const nameOf = (e: LabelSource) => (e.name ?? "").trim() || fileStem(e.file);
  const groups = new Map<string, LabelSource[]>();
  for (const e of entries) {
    const n = nameOf(e);
    groups.set(n, [...(groups.get(n) ?? []), e]);
  }
  const out = new Map<string, string>();
  for (const [name, group] of groups) {
    if (group.length === 1) {
      out.set(group[0].file, name);
      continue;
    }
    const sfx = suffixes(group);
    group.forEach((e, i) => out.set(e.file, sfx[i] ? `${name}${SEP}${sfx[i]}` : name));
  }
  // a suffixed label may still equal another project's own name ("Patch · CUDA" saved as a name)
  const seen = new Map<string, number>();
  for (const l of out.values()) seen.set(l, (seen.get(l) ?? 0) + 1);
  for (const [file, l] of out) if (seen.get(l)! > 1) out.set(file, `${l}${SEP}${fileStem(file)}`);
  return out;
}

/** The label of one file, or its name / file name when it is not in the map. */
export const labelOf = (labels: Map<string, string>, e: { file: string; name?: string | null }) =>
  labels.get(e.file) ?? ((e.name ?? "").trim() || e.file);
