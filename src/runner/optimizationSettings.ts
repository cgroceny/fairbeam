import type { ParamSpec } from './api.ts';
import type { GoalDraft, VaryDraft, OptimizeMethod } from './optimize.ts';
import { settingsData, settingsObject } from '../lib/settingsFile.ts';

export interface OptimizationSettings {
  vary: VaryDraft[]; goals: GoalDraft[]; maxEvals: number; method: OptimizeMethod; excite: 'auto' | 'all';
}
const methods = ['auto', 'secant', 'nelder-mead', 'bayesian', 'cma-es', 'particle-swarm', 'genetic', 'trust-region'];
const kinds = ['f0', 's11_max', 'bw_min', 'dmax_min', 'realized_gain_min', 'efficiency_min', 'match_all', 'sij_max', 'sij_min'];
function requireValue(ok: unknown) { if (!ok) throw new Error('settingsFile.invalid'); }
export function exportOptimizationSettings(settings: OptimizationSettings, specs: readonly ParamSpec[]): string {
  return JSON.stringify({ schema: 'fairbeam.optimization-settings/1', settings,
    parameters: settings.vary.map(v => {
      const spec = specs.find(s => s.key === v.key);
      if (!spec) throw new Error('settingsFile.incompatible');
      return { key: v.key, unit: spec.unit, type: spec.type };
    }) }, null, 2) + '\n';
}
/** Shape and destination compatibility checks; the existing optimizer validates goals/ranges next. */
export function importOptimizationSettings(text: string, specs: readonly ParamSpec[]): OptimizationSettings {
  const data = settingsData(text);
  settingsObject(data, ['schema', 'settings', 'parameters']);
  requireValue(data.schema === 'fairbeam.optimization-settings/1');
  settingsObject(data.settings, ['vary', 'goals', 'maxEvals', 'method', 'excite']);
  const s = data.settings;
  requireValue(Array.isArray(s.vary) && s.vary.length >= 1 && s.vary.length <= 32);
  requireValue(Array.isArray(s.goals) && s.goals.length >= 1 && s.goals.length <= 4);
  requireValue(Number.isSafeInteger(s.maxEvals) && methods.includes(String(s.method)) && ['auto', 'all'].includes(String(s.excite)));
  const string = (v: unknown) => typeof v === 'string' && v.length <= 1024;
  const keys = new Set<string>();
  for (const v of s.vary as unknown[]) {
    settingsObject(v, ['key', 'min', 'max', 'start']);
    requireValue(['key', 'min', 'max', 'start'].every(k => string(v[k])) && !keys.has(v.key as string));
    requireValue(['min', 'max', 'start'].every(k => (v[k] as string).trim() !== '' && Number.isFinite(Number(v[k]))));
    keys.add(v.key as string);
  }
  for (const g of s.goals as unknown[]) {
    settingsObject(g, ['kind', 'target', 'at', 'atHi', 'atHiInvalid', 'weight', 'i', 'j']);
    requireValue(kinds.includes(String(g.kind)) && ['target', 'at', 'weight', 'i', 'j'].every(k => string(g[k])));
    if ('atHi' in g) requireValue(string(g.atHi));
    if ('atHiInvalid' in g) requireValue(g.atHiInvalid === false);
  }
  requireValue(Array.isArray(data.parameters) && data.parameters.length === keys.size);
  const seen = new Set<string>();
  for (const p of data.parameters as unknown[]) {
    settingsObject(p, ['key', 'type', 'unit']);
    requireValue(typeof p.key === 'string' && keys.has(p.key) && !seen.has(p.key));
    seen.add(p.key as string);
    if (!specs.some(d => d.key === p.key && d.unit === p.unit && d.type === p.type && ['int', 'float'].includes(d.type)))
      throw new Error('settingsFile.incompatible');
  }
  return s as unknown as OptimizationSettings;
}
