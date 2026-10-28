import type { OptGoal } from '../runner/api.ts';
import { REQUIREMENTS_SCHEMA, validateRequirements } from './requirements.ts';

/** Existing POST /api/optimizations admission; importing masks never increases solver budgets. */
export const REQUIREMENT_OPTIMIZER_LIMIT = 4;
export function requirementGoalDrafts(input: OptGoal[]) {
  const parsed = validateRequirements({ schema: REQUIREMENTS_SCHEMA, items: input.map((goal, i) => ({ id: `goal-${i}`, goal })) });
  if (!parsed.ok || !input.length || input.length > REQUIREMENT_OPTIMIZER_LIMIT) return null;
  return parsed.value.items.map(({ goal: g }) => ({ kind: g.kind, target: String(g.target),
    at: g.at == null ? '' : String(g.at), atHi: g.at_hi == null ? '' : String(g.at_hi), atHiInvalid: false,
    weight: String(g.weight ?? 1), i: g.ports ? String(g.ports[0]) : '', j: g.ports ? String(g.ports[1]) : '' }));
}
