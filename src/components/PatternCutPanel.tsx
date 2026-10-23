import { createMemo, createSignal, createUniqueId, For, Show, type JSX } from 'solid-js';
import type { Bundle, FarField } from '../types';
import PolarChart from '../charts/PolarChart';
import LineChart from '../charts/LineChart';
import { cutPhi, setCutPhi } from '../compare/store';
import { analyzeCut, cutLabel, cutSpecs, patternMetrics, type CutMetric } from '../lib/patternMetrics';
import { cutTheta, patternCutChoice, patternCutMode, patternProjection, setCutTheta, setPatternCutMode, setPatternProjection } from '../lib/patternCutStore';
import { quantityGrid, quantityUnit, type PatternQuantity } from '../lib/farfieldQuantity';
import { axialRatioNote } from './FarfieldCard';
import NumberField from './NumberField';
import { num } from '../lib/format';
import { t } from '../i18n';
import '../styles/pattern-cuts.css';

export interface PatternEntry { id: string; label: string; color: string; bundle: Bundle; field: FarField; quantity: PatternQuantity }
export function PatternCutPanel(props: { entries: PatternEntry[]; principalAvailable?: boolean; children?: JSX.Element }) {
  const [invalid, setInvalid] = createSignal(false);
  const errorId = createUniqueId();
  let angleInput: HTMLInputElement | undefined;
  const principal = () => props.principalAvailable ?? props.entries.length === 1;
  const mode = () => patternCutMode() === 'principal' && !principal() ? 'elevation' : patternCutMode();
  const cuts = createMemo(() => props.entries.flatMap(entry => {
    const grid = quantityGrid(entry.bundle, entry.field, entry.quantity);
    return cutSpecs(patternCutChoice(), principal(), cutPhi()).map((spec, i) => {
      const cut = analyzeCut(entry.field.theta, entry.field.phi, grid, spec, !!entry.bundle.half_space);
      // The parent resolves the base quantity once; missing reference CP stays a gap.
      const quantity = entry.quantity;
      return { ...cut, id: `${entry.id}-${i}`, color: principal() && i ? '--al-series-2' : entry.color,
        label: `${entry.label ? `${entry.label} · ` : ''}${cutLabel(spec)} · ${t(`farfield.quantity.${quantity}`)}`,
        metrics: patternMetrics(cut, entry.field.theta, entry.field.phi, grid, !!entry.bundle.half_space, quantity) };
    });
  }));
  const axialRatio = () => props.entries[0]?.quantity === 'axial_ratio';
  const unit = () => quantityUnit(props.entries[0]?.quantity ?? 'directivity');
  const maximum = () => axialRatio() ? 60 : Math.ceil(Math.max(-60, ...cuts().flatMap(c => c.value.filter(Number.isFinite))));
  const half = () => mode() !== 'conical' && props.entries.every(e => !!e.bundle.half_space);
  const angleLabel = () => mode() === 'conical' ? 'φ' : 'θ';
  const metric = (m: CutMetric, unit: string) => m.value === null ? t(`patternCuts.reason.${m.reason}`) : `${num(m.value, 2)} ${unit}`;
  const updateAngle = (input: HTMLInputElement) => {
    const max = mode() === 'conical' ? 180 : 360;
    const valid = input.value.trim() !== '' && Number.isFinite(input.valueAsNumber) && input.valueAsNumber >= 0 && input.valueAsNumber <= max;
    setInvalid(!valid);
    if (valid) (mode() === 'conical' ? setCutTheta : setCutPhi)(input.valueAsNumber);
  };
  return <section class="pattern-analyzer" aria-label={t('patternCuts.title')}>
    <div class="pattern-cut-controls cluster">
      <label class="cluster-sm"><span>{t('results.pattern.cut')}</span><select data-pattern-cut="kind" value={mode()} onChange={e => {
        setInvalid(false); setPatternCutMode(e.currentTarget.value as ReturnType<typeof patternCutMode>);
      }}>
        <Show when={principal()}><option value="principal">{t('patternCuts.principal')}</option></Show>
        <option value="elevation">{t('patternCuts.elevation')}</option>
        <option value="conical">{t('patternCuts.conical')}</option>
      </select></label>
      <Show when={mode() !== 'principal'}>
        <label class="cluster-sm"><span>{mode() === 'conical' ? 'θ (°)' : 'φ (°)'}</span>
          <NumberField ref={angleInput} data-pattern-cut="angle" min="0" max={mode() === 'conical' ? 180 : 360} step="any"
            aria-invalid={invalid()} aria-describedby={invalid() ? errorId : undefined}
            value={mode() === 'conical' ? cutTheta() : cutPhi()} onInput={e => updateAngle(e.currentTarget)} />
        </label>
        <Show when={mode() === 'conical'}><button class="btn btn-sm" onClick={() => { setInvalid(false); setCutTheta(90); if (angleInput) angleInput.value = '90'; }}>{t('patternCuts.azimuth')}</button></Show>
      </Show>
      <label class="cluster-sm"><span>{t('patternCuts.projection')}</span><select data-pattern-cut="projection" value={patternProjection()}
        onChange={e => setPatternProjection(e.currentTarget.value as 'polar' | 'cartesian')}>
        <option value="polar">{t('patternCuts.polar')}</option><option value="cartesian">{t('patternCuts.cartesian')}</option>
      </select></label>
      <Show when={invalid()}><span id={errorId} role="alert">{t('patternCuts.invalid', { max: mode() === 'conical' ? 180 : 360 })}</span></Show>
    </div>
    <div class="pattern-analyzer-body">
      <div class="pattern-analyzer-chart">
        <Show when={cuts().some(c => c.value.some(Number.isFinite))} fallback={<p class="panel-empty">{t('patternCuts.noCoverage')}</p>}>
          <Show when={patternProjection() === 'polar'} fallback={<LineChart ariaLabel={t('patternCuts.cartesianChart')}
            series={cuts().map(c => ({ id: c.id, label: c.label, color: c.color, x: c.angle, y: c.value }))}
            xLabel={`${angleLabel()} (°)`} yLabel={unit()} yDomain={axialRatio() ? [0, 60] : undefined} xFormat={v => num(v, 1)} yFormat={v => num(v, 1)} />}>
            <PolarChart ariaLabel={t('patternCuts.polarChart')} series={cuts()} directLabels={props.entries.length > 1}
              half={half()} unit={unit()} range={axialRatio() ? 60 : 40} max={maximum()} angleLabel={angleLabel()} />
          </Show>
        </Show>
      </div>
      <div class="pattern-analyzer-details stack">
        {props.children}
        <p class="rdk-note" role="note">{axialRatio() ? axialRatioNote() : t('patternCuts.estimate')}</p>
        <For each={cuts()}>{cut => <section class="stack-sm" data-pattern-metrics={cut.id}>
          <strong>{cut.label}</strong>
          <dl class="kv kv-left">
            <dt>{t('patternCuts.peak')}</dt><dd>{cut.metrics.peak ? `${angleLabel()} = ${num(cut.metrics.peak.angle, 2)}° · ${num(cut.metrics.peak.dbi, 2)} ${unit()}` : t(`patternCuts.reason.${cut.metrics.hpbw.reason ?? 'ambiguous'}`)}</dd>
            <dt>HPBW</dt><dd>{metric(cut.metrics.hpbw, '°')}</dd>
            <dt>SLL</dt><dd>{metric(cut.metrics.sll, 'dB')}</dd>
            <dt>{t('patternCuts.fb')}</dt><dd>{metric(cut.metrics.frontBack, 'dB')}</dd>
            <dt>{t('patternCuts.spacing')}</dt><dd>{cut.metrics.spacing ? `${num(cut.metrics.spacing[0], 3)}–${num(cut.metrics.spacing[1], 3)}°` : '—'}</dd>
          </dl>
          <Show when={cut.interpolated}><p class="rdk-note">{t('patternCuts.interpolated')}</p></Show>
        </section>}</For>
        <Show when={!axialRatio()}><p class="rdk-note">{t('patternCuts.fbNote')}</p></Show>
      </div>
    </div>
  </section>;
}
