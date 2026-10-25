import { createMemo, createSignal, createUniqueId, For, Show } from 'solid-js';
import LineChart from '../charts/LineChart';
import NumberField from '../components/NumberField';
import { saveVisibleFigure } from '../components/visibleFigure';
import { exportNotice } from '../components/exportContext';
import { saveDownload } from '../lib/download';
import { downloadToast } from '../lib/toast';
import { num } from '../lib/format';
import { fmt, t } from '../i18n';
import { SERIES_COLORS } from '../compare/series';
import type { SweepGroup } from './sweep';
import { defaultTrendFrequency, sweepTrend, sweepTrendCsv, TREND_METRICS, trendSequences, trendUnit, type TrendMetric, type TrendSeries } from './sweepTrend';

export default function SweepTrend(props: { group: SweepGroup }) {
  const [sequence, setSequence] = createSignal(0);
  const [metric, setMetric] = createSignal<TrendMetric>('frequency');
  const [reference, setReference] = createSignal<number>();
  const [windowMHz, setWindowMHz] = createSignal<number>();
  const [invalidReference, setInvalidReference] = createSignal(false);
  const [invalidWindow, setInvalidWindow] = createSignal(false);
  const [selectedSeries, setSelectedSeries] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const sequences = () => trendSequences(props.group.jobs);
  const selectedSequence = () => sequences().some(([i]) => i === sequence()) ? sequence() : sequences()[0]?.[0] ?? 0;
  const refGHz = () => reference() ?? defaultTrendFrequency(props.group.jobs.filter(j => (j.sweep?.sequence_index ?? 0) === selectedSequence()));
  const radius = () => windowMHz() ?? refGHz() * 100;
  const data = createMemo(() => sweepTrend(props.group.jobs, selectedSequence(), metric(), invalidReference() ? NaN : refGHz(), invalidWindow() ? NaN : radius()));
  const coordinate = (v: number) => fmt.intl(v, { maximumSignificantDigits: 10, useGrouping: false });
  const label = (s: TrendSeries) => data().second ? `${data().second}=${coordinate(s.second!)}` : data().first;
  // More than eight categorical traces are selected individually, never silently omitted.
  const plotted = () => data().series.length <= 8 ? data().series : [data().series.find(s => s.id === selectedSeries()) ?? data().series[0]];
  const traces = () => plotted().map((s, i) => ({ id: s.id, label: label(s), color: SERIES_COLORS[i], x: s.points.map(p => p.x), y: s.points.map(p => p.value ?? NaN) }));
  const points = () => traces().map(s => ({ ...s, shape: 'circle' as const, hideLegend: true }));
  const available = () => plotted().some(s => s.points.some(p => p.value !== null));
  const value = (v: number | null) => v === null ? '—' : num(v, 6);
  const description = createUniqueId();
  let figure: HTMLDivElement | undefined;
  const figureTitle = () => `${props.group.name} · ${t('sweepTrend.title')} · ${t('runHistory.sequence')} ${selectedSequence() + 1} · ${t(`sweepTrend.metric.${metric()}`)} · ${refGHz()} GHz ± ${radius()} MHz`;
  const updateNumber = (input: HTMLInputElement, reference: boolean) => {
    const valid = input.value.trim() !== '' && Number.isFinite(input.valueAsNumber) && input.valueAsNumber > 0;
    (reference ? setInvalidReference : setInvalidWindow)(!valid);
    // Invalid text belongs to the editor. Never replace it with the numeric sentinel NaN.
    if (valid) (reference ? setReference : setWindowMHz)(input.valueAsNumber);
  };
  const exportCsv = async () => {
    try { downloadToast(await saveDownload(`${props.group.name.replace(/[^\w.-]+/g, '-')}-trend.csv`, sweepTrendCsv(data(), metric(), selectedSequence(), refGHz(), radius()), 'text/csv;charset=utf-8')); }
    catch (error) { exportNotice(String(error)); }
  };
  const exportFigure = async (format: 'svg' | 'png') => {
    setSaving(true);
    try { await saveVisibleFigure(figure ?? null, `${props.group.name}-trend`, format, figureTitle()); }
    catch (error) { exportNotice(String(error)); }
    finally { setSaving(false); }
  };
  return <details class="sweep-trend" open>
    <summary>{t('sweepTrend.title')}</summary>
    <div class="stack-sm">
      <div class="cluster sweep-trend-controls">
        <label>{t('runHistory.sequence')}<select data-trend-sequence value={selectedSequence()} onChange={e => { setSequence(Number(e.currentTarget.value)); setReference(undefined); setWindowMHz(undefined); setInvalidReference(false); setInvalidWindow(false); }}>
          <For each={sequences()}>{([i, name]) => <option value={i}>{i + 1}{name ? ` · ${name}` : ''}</option>}</For>
        </select></label>
        <label>{t('sweepTrend.metric')}<select data-trend-metric value={metric()} onChange={e => setMetric(e.currentTarget.value as TrendMetric)}>
          <For each={TREND_METRICS}>{m => <option value={m}>{t(`sweepTrend.metric.${m}`)} ({trendUnit(m)})</option>}</For>
        </select></label>
        <For each={[selectedSequence()]}>{() => <>
          <label>{t('sweepTrend.reference')}<NumberField data-trend-reference value={refGHz()} min={0} step="any" aria-describedby={description} aria-invalid={invalidReference()} onInput={e => updateNumber(e.currentTarget, true)} /></label>
          <label>{t('sweepTrend.window')}<NumberField data-trend-window value={radius()} min={0} step="any" aria-describedby={description} aria-invalid={invalidWindow()} onInput={e => updateNumber(e.currentTarget, false)} /></label>
        </>}</For>
      </div>
      <p class="muted rp-small" id={description}>{t('sweepTrend.tracking')}</p>
      <Show when={data().error} fallback={<>
        <Show when={data().series.length > 8}>
          <label>{t('sweepTrend.many')}<select data-trend-series value={plotted()[0]?.id} onChange={e => setSelectedSeries(e.currentTarget.value)}><For each={data().series}>{s => <option value={s.id}>{label(s)}</option>}</For></select></label>
        </Show>
        <div class="cluster-sm">
          <button class="btn btn-ghost btn-sm" data-trend-csv onClick={() => void exportCsv()}>{t('sweepTrend.csv')}</button>
          <For each={['svg', 'png'] as const}>{format => <button class="btn btn-ghost btn-sm" data-trend-figure={format} disabled={!available() || saving()} onClick={() => void exportFigure(format)}>{t('contextExport.figureFormat', { format: format.toUpperCase() })}</button>}</For>
        </div>
        <Show when={available()} fallback={<p role="status">{t('sweepTrend.empty')}</p>}>
          <div class="sweep-trend-chart" ref={figure}><LineChart series={traces()} points={points()} preserveSampleGaps xLabel={data().first} yLabel={`${t(`sweepTrend.metric.${metric()}`)} (${trendUnit(metric())})`} xFormat={coordinate} yFormat={y => num(y, 6)} ariaLabel={figureTitle()} /></div>
        </Show>
        <p class="muted rp-small">{t('sweepTrend.qualification')}</p>
        <div class="sweep-trend-table"><table class="table" data-trend-table>
          <caption>{t('sweepTrend.slope', { unit: trendUnit(metric()), parameter: data().first })}</caption>
          <thead><tr><th>{data().second ?? t('runHistory.sequence')}</th><th class="num">{data().first}</th><th>{t('runHistory.status')}</th><th class="num">{t(`sweepTrend.metric.${metric()}`)} ({trendUnit(metric())})</th><th class="num">Δ / Δ{data().first}</th><th class="num">{t('sweepTrend.band')}</th><th class="num">{t('sweepTrend.field')}</th><th>{t('sweepTrend.availability')}</th></tr></thead>
          <tbody><For each={data().series}>{s => <For each={s.points}>{p => <tr>
            <td>{s.second === null ? selectedSequence() + 1 : coordinate(s.second!)}</td><td class="num">{coordinate(p.x)}</td><td>{p.status ? p.status.split('|').map(status => t(`progress.status.${status}`)).join(' / ') : '—'}</td>
            <td class="num" classList={{ 'rp-over': p.nonphysical }}>{value(p.value)}{p.nonphysical ? ' ⚠' : ''}</td><td class="num">{value(p.slope)}</td><td class="num">{value(p.bandGHz)}</td><td class="num">{value(p.fieldGHz)}</td><td>{t(`sweepTrend.reason.${p.reason}`)}<Show when={p.nonphysical}> · {t('runHistory.radEffOver')}</Show></td>
          </tr>}</For>}</For></tbody>
        </table></div>
      </>}><p role="alert">{t(`sweepTrend.error.${data().error}`)}</p></Show>
    </div>
  </details>;
}
