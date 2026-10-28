import { createEffect, createMemo, createSignal, createUniqueId, For, Index, on, Show } from 'solid-js';
import { unwrap } from 'solid-js/store';
import type { OptGoal, GoalKind } from '../runner/api';
import { goalText } from '../runner/optimizeGoals';
import { REQUIREMENTS_SCHEMA, REQUIREMENT_KINDS, REQUIREMENT_LIMIT, requirementsToGoals, validateRequirements, type RequirementSet, type RequirementEvaluation } from '../lib/requirements';
import { t } from '../i18n';
import { num } from '../lib/format';
import { REQUIREMENT_OPTIMIZER_LIMIT } from '../lib/requirementGoals';
import NumberField from './NumberField';
import '../styles/requirements.css';

const bands = ['s11_max', 'sij_max', 'sij_min', 'match_all'];
const pairs = ['sij_max', 'sij_min'];
const pointFrequency = (kind: GoalKind) => !['f0', 'bw_min'].includes(kind);
const reasonText = (reason: string | null) => reason ? t(`requirements.reason.${reason}`) : '';
const defaults = (kind: GoalKind): OptGoal => ({ kind,
  target: ['f0'].includes(kind) ? 2.45 : kind === 'bw_min' ? 100 : kind === 'efficiency_min' ? 80 : ['dmax_min', 'realized_gain_min'].includes(kind) ? 3 : kind === 'sij_min' ? -3 : -10,
  ...(pointFrequency(kind) ? { at: 2.45 } : {}), ...(pairs.includes(kind) ? { ports: [2, 1] as [number, number] } : {}), weight: 1 });
const empty = (): RequirementSet => ({ schema: REQUIREMENTS_SCHEMA, items: [] });

/** An explicit draft/apply editor. Partial numeric entries stay local; no invalid document is saved.
 * Conversion only prepares the optimizer form. It never starts an optimization or solver run.
 */
export function RequirementsEditor(props: {
  value?: RequirementSet;
  onChange: (value: RequirementSet) => void;
  onUseGoals?: (goals: OptGoal[], f0TolerancePct: number) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const uid = createUniqueId(), [draft, setDraft] = createSignal<RequirementSet>(empty());
  const [dirty, setDirty] = createSignal(false), [saved, setSaved] = createSignal(false);
  createEffect(() => props.onDirtyChange?.(dirty()));
  createEffect(on(() => props.value, value => { setDraft(structuredClone(unwrap(value ?? empty()))); setDirty(false); setSaved(false); }));
  const validation = createMemo(() => validateRequirements(draft()));
  const modify = (index: number, patch: Partial<OptGoal>) => {
    setDraft(s => ({ ...s, items: s.items.map((r, i) => i === index ? { ...r, goal: { ...r.goal, ...patch } } : r) })); setDirty(true); setSaved(false);
  };
  const numeric = (e: HTMLInputElement) => e.value.trim() && Number.isFinite(e.valueAsNumber) ? e.valueAsNumber : NaN;
  const reset = () => { setDraft(structuredClone(unwrap(props.value ?? empty()))); setDirty(false); setSaved(false); };
  const apply = () => { const p = validation(); if (p.ok) { props.onChange(p.value); setDirty(false); setSaved(true); } };
  const convert = () => {
    const result = requirementsToGoals(draft());
    if (result.ok && props.onUseGoals) { apply(); props.onUseGoals(result.goals, result.f0TolerancePct); }
  };
  const add = () => {
    if (draft().items.length >= REQUIREMENT_LIMIT) return;
    const used = new Set(draft().items.map(r => r.id)); let n = 1;
    while (used.has(`requirement-${n}`)) n++;
    setDraft(s => ({ ...s, items: [...s.items, { id: `requirement-${n}`, goal: defaults('s11_max') }] })); setDirty(true); setSaved(false);
  };
  return <section class="requirements-panel" data-requirements-editor aria-label={t('requirements.title')}>
    <details>
      <summary>{t('requirements.title')} ({draft().items.length})</summary>
      <p class="note">{t('requirements.editorNote')}</p>
      <Index each={draft().items}>{(r, index) => <fieldset class="requirements-row">
        <legend>{r().label || t('requirements.item', { n: index + 1 })}</legend>
        <label class="rdk-field" for={`${uid}-${index}-label`}><span>{t('requirements.label')}</span>
          <input class="dz-input" id={`${uid}-${index}-label`} maxLength={160} value={r().label ?? ''}
            onInput={e => { setDraft(s => ({ ...s, items: s.items.map((v, i) => i === index ? { ...v, label: e.currentTarget.value } : v) })); setDirty(true); setSaved(false); }} /></label>
        <label class="rdk-field" for={`${uid}-${index}-kind`}><span>{t('requirements.quantity')}</span>
          <select class="dz-input" id={`${uid}-${index}-kind`} value={r().goal.kind} onChange={e => {
            const goal = defaults(e.currentTarget.value as GoalKind);
            setDraft(s => ({ ...s, items: s.items.map((v, i) => i === index ? { ...v, goal } : v) })); setDirty(true); setSaved(false);
          }}><For each={REQUIREMENT_KINDS}>{k => <option value={k}>{t(`requirements.kind.${k}`)}</option>}</For></select></label>
        <label class="rdk-field" for={`${uid}-${index}-target`}><span>{t('requirements.target')}</span>
          <NumberField class="dz-input" id={`${uid}-${index}-target`} value={Number.isFinite(r().goal.target) ? r().goal.target : ''}
            aria-invalid={!Number.isFinite(r().goal.target)} onInput={e => modify(index, { target: numeric(e.currentTarget) })} /></label>
        <Show when={pointFrequency(r().goal.kind)}>
          <label class="rdk-field" for={`${uid}-${index}-at`}><span>{t('requirements.frequency')} (GHz)</span>
            <NumberField class="dz-input" id={`${uid}-${index}-at`} min="0" value={Number.isFinite(r().goal.at) ? r().goal.at! : ''}
              aria-invalid={!Number.isFinite(r().goal.at) || !(r().goal.at! > 0)} onInput={e => modify(index, { at: numeric(e.currentTarget) })} /></label>
        </Show>
        <Show when={bands.includes(r().goal.kind)}>
          <label class="requirements-check"><input type="checkbox" checked={r().goal.at_hi != null} onChange={e => modify(index, { at_hi: e.currentTarget.checked ? (r().goal.at ?? 2.45) + .1 : null })} />{t('requirements.band')}</label>
          <Show when={r().goal.at_hi != null}><label class="rdk-field" for={`${uid}-${index}-hi`}><span>{t('requirements.upperFrequency')} (GHz)</span>
            <NumberField class="dz-input" id={`${uid}-${index}-hi`} min="0" value={Number.isFinite(r().goal.at_hi) ? r().goal.at_hi! : ''}
              aria-invalid={!Number.isFinite(r().goal.at_hi) || !(r().goal.at_hi! > r().goal.at!)} onInput={e => modify(index, { at_hi: numeric(e.currentTarget) })} /></label></Show>
        </Show>
        <Show when={pairs.includes(r().goal.kind)}><For each={[0, 1]}>{which =>
          <label class="rdk-field" for={`${uid}-${index}-port-${which}`}><span>{t(which ? 'requirements.drivenPort' : 'requirements.receivingPort')}</span>
            <NumberField class="dz-input" id={`${uid}-${index}-port-${which}`} min="1" step="1" value={Number.isFinite(r().goal.ports?.[which]) ? r().goal.ports![which] : ''}
              onInput={e => { const port: [number, number] = [...(r().goal.ports ?? [2, 1])]; port[which] = numeric(e.currentTarget); modify(index, { ports: port }); }} /></label>
        }</For></Show>
        <label class="rdk-field" for={`${uid}-${index}-weight`}><span>{t('requirements.weight')}</span>
          <NumberField class="dz-input" id={`${uid}-${index}-weight`} min="0" value={Number.isFinite(r().goal.weight ?? 1) ? r().goal.weight ?? 1 : ''}
            onInput={e => modify(index, { weight: numeric(e.currentTarget) })} /></label>
        <button type="button" class="dz-btn" onClick={() => { setDraft(s => ({ ...s, items: s.items.filter((_, i) => i !== index) })); setDirty(true); setSaved(false); }}>{t('requirements.remove')}</button>
        <p class="note requirements-description">{goalText(r().goal)}</p>
      </fieldset>}</Index>
      <Show when={!validation().ok}><p class="note" role="status">{reasonText((validation() as { ok: false; reason: string }).reason)}</p></Show>
      <p class="note">{t('requirements.conversionNote')}</p>
      <div class="requirements-actions">
        <button type="button" class="dz-btn" disabled={draft().items.length >= REQUIREMENT_LIMIT} onClick={add}>{t('requirements.add')}</button>
        <button type="button" class="dz-btn" disabled={!dirty() || !validation().ok} onClick={apply}>{t('requirements.apply')}</button>
        <button type="button" class="dz-btn" disabled={!dirty()} onClick={reset}>{t('requirements.reset')}</button>
        <Show when={props.onUseGoals}><button type="button" class="dz-btn" disabled={!validation().ok || !draft().items.length || draft().items.length > REQUIREMENT_OPTIMIZER_LIMIT} onClick={convert}>{t('requirements.useGoals')}</button></Show>
      </div>
      <Show when={props.onUseGoals && draft().items.length > REQUIREMENT_OPTIMIZER_LIMIT}><p class="note">{t('requirements.optimizerLimit')}</p></Show>
      <Show when={saved()}><p class="note" role="status">{t('requirements.saved')}</p></Show>
    </details>
  </section>;
}

/** One immutable run evaluation; reuse its rows and qualification fields in navigation/reports. */
export function RequirementsSummary(props: { evaluation: RequirementEvaluation }) {
  const e = () => props.evaluation;
  return <section class="requirements-panel" data-requirements-summary aria-label={t('requirements.title')}>
    <h3>{t('requirements.title')}: {t(`requirements.verdict.${e().status}`)}</h3>
    <dl class="kv">
      <dt>{t('requirements.numericLimits')}</dt><dd>{t(`requirements.verdict.${e().metric}`)}</dd>
      <dt>{t('requirements.energy')}</dt><dd>{t(`requirements.qualification.${e().energy}`)}</dd>
      <dt>{t('requirements.mesh')}</dt><dd>{t(`requirements.qualification.${e().mesh}`)}</dd>
    </dl>
    <Show when={e().reason}><p class="note">{reasonText(e().reason)}</p></Show>
    <p class="note">{t('requirements.samplingNote')}</p>
    <div class="requirements-table" tabIndex={0} role="region" aria-label={t('requirements.results')}>
      <table class="table"><thead><tr><th>{t('requirements.quantity')}</th><th>{t('requirements.numericLimits')}</th><th>{t('requirements.value')}</th></tr></thead>
        <tbody><For each={e().items}>{row => <tr>
          <td>{e().requirements?.items.find(r => r.id === row.id)?.label || row.id}<br />{(() => { const r = e().requirements?.items.find(v => v.id === row.id); return r ? goalText(r.goal) : ''; })()}</td>
          <td>{t(`requirements.verdict.${row.metric}`)}<Show when={row.reason}><span class="note requirements-reason">{reasonText(row.reason)}</span></Show></td>
          <td class="mono">{row.value === null ? '—' : `${row.lowerBound ? '≥ ' : ''}${num(row.value, 6)} ${row.unit}`}<Show when={row.sources.some(s => s.reciprocal)}><span class="note requirements-reason">{t('requirements.reciprocal')}</span></Show></td>
        </tr>}</For></tbody>
      </table>
    </div>
  </section>;
}
