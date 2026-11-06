import type { Design } from './types.ts';
import { designChecks } from './checks.ts';
import { evaluate, nameMap, namesIn } from './expr.ts';
import { settingsData, settingsObject } from '../lib/settingsFile.ts';

const meshKeys = ['mode', 'lines', 'automatic', 'overrides', 'cells_per_wavelength', 'pad', 'edge_rule',
  'max_ratio', 'air_cells_per_wavelength', 'thin_metal', 'refine_features', 'axis_precision', 'local_regions'];
const overrideKeys = ['cells_per_wavelength', 'pad', 'edge_rule', 'max_ratio', 'air_cells_per_wavelength', 'dielectric_cells'];
const simulationKeys = ['f_min', 'f_max', 'boundaries', 'end_criteria_db', 'max_timesteps'];
const expr = (v: unknown) => typeof v === 'number' && Number.isFinite(v) || typeof v === 'string' && v.length > 0 && v.length <= 1024;
function requireValue(ok: unknown) { if (!ok) throw new Error('settingsFile.invalid'); }
function overrides(value: unknown, expression: (v: unknown, key?: string) => boolean) {
  settingsObject(value, overrideKeys);
  for (const [k, v] of Object.entries(value)) requireValue(k === 'edge_rule' ? ['thirds', 'edge'].includes(String(v)) : expression(v, k));
}
function mesh(value: unknown, expression: (v: unknown, key?: string) => boolean) {
  settingsObject(value, meshKeys);
  for (const [k, v] of Object.entries(value)) {
    if (k === 'mode') requireValue(['auto', 'design', 'manual'].includes(String(v)));
    else if (k === 'overrides') overrides(v, expression);
    else if (k === 'automatic') {
      // Imported macros can retain the legacy automatic fields directly rather
      // than inside overrides. Preserve and validate those fields as well.
      settingsObject(v, meshKeys.filter(key => !['automatic', 'lines', 'local_regions', 'axis_precision'].includes(key)));
      if ('mode' in v) requireValue(v.mode === 'auto' || v.mode === 'design');
      mesh(v, expression);
    } else if (k === 'lines') {
      settingsObject(v, ['x', 'y', 'z']);
      for (const axis of ['x', 'y', 'z']) requireValue(Array.isArray(v[axis]) && (v[axis] as unknown[]).length >= 2 && (v[axis] as unknown[]).every(x => expression(x)));
    } else if (k === 'local_regions') {
      requireValue(Array.isArray(v) && v.length <= 32);
      for (const r of v as unknown[]) {
        settingsObject(r, ['id', 'name', 'start', 'stop', 'cell_size']);
        requireValue(typeof r.id === 'string' && typeof r.name === 'string');
        for (const key of ['start', 'stop']) requireValue(Array.isArray(r[key]) && (r[key] as unknown[]).length === 3 && (r[key] as unknown[]).every(x => expression(x)));
        requireValue(expression(r.cell_size));
      }
    } else if (k === 'refine_features') requireValue(typeof v === 'boolean');
    else if (k === 'axis_precision') requireValue(v === 'float64');
    else if (k === 'thin_metal') requireValue(v === 'sheet' || v === 'volume');
    else if (k === 'edge_rule') requireValue(v === 'thirds' || v === 'edge');
    else requireValue(v === null && ['pad', 'air_cells_per_wavelength'].includes(k) || expression(v, k));
  }
  requireValue(value.mode !== 'manual' || value.lines);
}
export function exportSimulationSettings(design: Design): string {
  const used = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === 'string') namesIn(v).forEach(n => used.add(n));
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(design.mesh); visit(design.simulation);
  return JSON.stringify({ schema: 'fairbeam.simulation-settings/1', units: 'mm/GHz',
    parameters: design.params.filter(p => used.has(p.key)).map(p => ({ key: p.key, unit: p.unit ?? '' })),
    mesh: design.mesh, simulation: design.simulation }, null, 2) + '\n';
}
/** Validate against the destination's parameters before one undoable edit. Geometry stays intact. */
export function importSimulationSettings(text: string, destination: Design): Pick<Design, 'mesh' | 'simulation'> {
  const data = settingsData(text);
  settingsObject(data, ['schema', 'units', 'parameters', 'mesh', 'simulation']);
  requireValue(data.schema === 'fairbeam.simulation-settings/1' && data.units === 'mm/GHz');
  requireValue(Array.isArray(data.parameters));
  for (const p of data.parameters as unknown[]) {
    settingsObject(p, ['key', 'unit']);
    requireValue(typeof p.key === 'string' && typeof p.unit === 'string');
    if (!destination.params.some(d => d.key === p.key && (d.unit ?? '') === p.unit)) throw new Error('settingsFile.incompatible');
  }
  const names = nameMap();
  try {
    for (const p of destination.params) names[p.key] = evaluate(p.expr ?? p.default!, names);
    const expression = (v: unknown, key?: string) => {
      if (!expr(v)) return false;
      try {
        const n = evaluate(v as number | string, names);
        return Number.isFinite(n) && (key === 'dielectric_cells' ? Number.isInteger(n) && n >= 1 && n <= 20
          : key === 'max_ratio' ? n > 1 : key === 'pad' ? n >= 0
          : key === 'cells_per_wavelength' || key === 'air_cells_per_wavelength' ? n > 0 : true);
      } catch { return false; }
    };
    mesh(data.mesh, expression);
  } catch { throw new Error('settingsFile.incompatible'); }
  settingsObject(data.simulation, simulationKeys);
  const sim = data.simulation;
  requireValue(expr(sim.f_min) && expr(sim.f_max));
  const boundary = (v: unknown) => typeof v === 'string' && /^(PEC|PMC|MUR|PML_[1-9][0-9]*)$/.test(v);
  requireValue(boundary(sim.boundaries) || Array.isArray(sim.boundaries) && sim.boundaries.length === 6 && sim.boundaries.every(boundary));
  if ('end_criteria_db' in sim) requireValue(typeof sim.end_criteria_db === 'number' && Number.isFinite(sim.end_criteria_db));
  if ('max_timesteps' in sim) requireValue(Number.isSafeInteger(sim.max_timesteps) && (sim.max_timesteps as number) > 0);
  const result = { mesh: data.mesh, simulation: data.simulation } as Pick<Design, 'mesh' | 'simulation'>;
  const candidate = { ...destination, ...result };
  const before = new Set(designChecks(destination).filter(c => c.severity === 'error').map(c => `${c.path}:${c.message}`));
  const settingsErrors = designChecks({ ...candidate, requirements: undefined, components: [], parts: [], ports: [], resistors: [], far_field: { enabled: false } })
    .some(c => c.severity === 'error' && /^(mesh|simulation)(\.|\[|$)/.test(c.path));
  if (settingsErrors || designChecks(candidate).some(c => c.severity === 'error' && !before.has(`${c.path}:${c.message}`)))
    throw new Error('settingsFile.incompatible');
  return result;
}
