// Shared viewer/Designer controls; every result belongs to this array session.
import { createComputed, createMemo, createSignal, createUniqueId, For, on, Show } from 'solid-js';
import type { ArraySession } from '../lib/arraySession';
import { arrayPower, arraySidelobe, gratingLobes, linearLayout, scanTable, steeredWeights, taperWeights, type ScanTable, type TaperKind } from '../lib/arrayAnalysis';
import { arrayScanCsv } from '../export/arrayScan';
import { downloadFailedMessage, downloadMessage, saveDownload } from '../lib/download';
import { num } from '../lib/format';
import { t } from '../i18n';
import NumberField from './NumberField';

export default function ArrayAnalysisPanel(props: { session: ArraySession }) {
  const s = props.session, id = createUniqueId();
  const [kind, setKind] = createSignal<TaperKind>('chebyshev'), [attenuation, setAttenuation] = createSignal(30);
  const [from, setFrom] = createSignal(-60), [to, setTo] = createSignal(60), [step, setStep] = createSignal(10);
  const [scan, setScan] = createSignal<ScanTable | null>(null), [error, setError] = createSignal(''), [download, setDownload] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [invalid, setInvalid] = createSignal<Set<string>>(new Set());
  const layout = createMemo(() => s.source() ? linearLayout(s.source()!, [...s.weights().keys()]) : null);
  const power = createMemo(() => s.source() && s.set() ? arrayPower(s.source()!, s.weights(), s.set()!.f) : null);
  const baseline = createMemo(() => s.source() && s.set() ? arrayPower(s.source()!, steeredWeights(s.source()!, s.weights(), s.set()!.f, 0, s.scanPhi()), s.set()!.f) : null);
  const metrics = createMemo(() => s.set() ? arraySidelobe(s.set()!, s.weights(), s.scanPhi(), !!s.source()?.half_space) : null);
  const grating = createMemo(() => s.source() && s.set() ? gratingLobes(s.source()!, [...s.weights().keys()], s.set()!.f, s.scanTheta(), s.scanPhi()) : null);
  createComputed(on([s.source, s.set, s.weights, s.scanPhi], () => { setScan(null); setError(''); setDownload(''); }));
  const updateNumber = (key: string, input: HTMLInputElement, lo: number, hi: number, set: (n: number) => unknown) => {
    const n = input.valueAsNumber;
    const next = new Set(invalid()), valid = input.value.trim() !== '' && Number.isFinite(n) && n >= lo && n <= hi;
    if (valid) { set(n); next.delete(key); } else next.add(key);
    setInvalid(next); setError(''); setScan(null);
  };
  const apply = () => {
    const b = s.source(); if (!b || invalid().size) return;
    const result = taperWeights(b, s.weights(), kind(), attenuation());
    if (result.ok) { s.setWeights(result.value); s.setActive(true); setError(''); } else setError(result.reason);
  };
  const calculate = () => {
    const b = s.source(), set = s.set(); if (!b || !set || invalid().size) return;
    const result = scanTable(b, s.weights(), set.f, s.scanPhi(), from(), to(), step());
    setScan(result.ok ? result.value : null); setError(result.ok ? '' : result.reason); setDownload('');
  };
  const exportScan = async () => {
    const table = scan(); if (!table || saving()) return;
    const name = `array-scan-${table.frequencyHz}Hz.csv`, content = arrayScanCsv(table);
    setSaving(true);
    try { const result = await saveDownload(name, content, 'text/csv'); if (scan() === table) setDownload(downloadMessage(result)); }
    catch (e) { if (scan() === table) setDownload(downloadFailedMessage(name, e)); }
    finally { setSaving(false); }
  };
  const shown = (value: number | null | undefined, digits = 2) => value == null ? '—' : num(value, digits);
  const liveGain = () => { const p = power(); return p?.ok ? p.value.gainDbi : null; };
  const total = () => { const p = power(); return p?.ok ? p.value.totalEfficiency * 100 : null; };
  const powerReason = () => { const p = power(); return p && !p.ok ? p.reason : null; };
  const loss = () => { const p = power(), b = baseline(); return p?.ok && b?.ok ? b.value.gainDbi - p.value.gainDbi : null; };
  return <section class="array-block array-analysis-block stack" aria-labelledby={`array-analysis-${id}`} data-array-analysis>
    <h3 class="section-label" id={`array-analysis-${id}`}>{t('array.analysis.title')}</h3>
    <p class="note">{t('array.analysis.scope')}</p>
    <div class="array-analysis-grid">
      <div class="stack">
        <label class="stack-sm"><span>{t('array.analysis.taper')}</span>
          <select data-array-taper value={kind()} onChange={e => setKind(e.currentTarget.value as TaperKind)}>
            <For each={['uniform', 'chebyshev', 'taylor', 'binomial'] as TaperKind[]}>{k => <option value={k}>{t(`array.analysis.taper.${k}`)}</option>}</For>
          </select>
        </label>
        <Show when={kind() === 'chebyshev' || kind() === 'taylor'}>
          <label class="cluster-sm"><span>{t('array.analysis.target')}</span>
            <NumberField class="rp-input array-input" min="20" max="60" step="1" value={attenuation()} aria-invalid={invalid().has('attenuation')} onChange={e => updateNumber('attenuation', e.currentTarget, 20, 60, setAttenuation)} />
            <span>dB</span>
          </label>
        </Show>
        <button class="btn btn-sm" data-array-apply-taper disabled={!layout()?.ok || invalid().size > 0} onClick={apply}>{t('array.analysis.apply')}</button>
        <p class="note">{t(layout()?.ok ? 'array.analysis.taperNote' : 'array.analysis.reason.layout')}</p>
      </div>
      <div class="stack">
        <dl class="kv">
          <dt>{t('array.analysis.gain')}</dt><dd class="mono">{shown(liveGain())} dBi</dd>
          <dt>{t('array.analysis.loss')}</dt><dd class="mono">{shown(loss())} dB</dd>
          <dt>{t('array.analysis.total')}</dt><dd class="mono">{shown(total())} %</dd>
          <dt>{t('array.analysis.sll', { phi: num(s.scanPhi(), 1) })}</dt><dd class="mono">{shown(metrics()?.sll.value)} dB</dd>
        </dl>
        <Show when={powerReason()}><p class="note">{t(`array.analysis.reason.${powerReason()}`)}</p></Show>
        <Show when={metrics()?.sll.value == null}><p class="note">{t(`patternCuts.reason.${metrics()?.sll.reason ?? 'empty'}`)}</p></Show>
        <p class="note">{t('array.analysis.lossNote')}</p>
      </div>
      <div class="stack">
        <p class="note" role="status">{(() => {
          const g = grating();
          return g?.ok ? t(g.value.orders.length ? 'array.analysis.gratingFound' : 'array.analysis.gratingNone', { count: g.value.orders.length, spacing: num(g.value.spacingWavelengths, 3) })
            : t(`array.analysis.reason.${g && !g.ok ? g.reason : 'layout'}`);
        })()}</p>
        <p class="note">{t('array.analysis.gratingNote')}</p>
        <p class="note">{t('array.analysis.sampling', { theta: s.set()?.theta.length ?? 0, phi: s.set()?.phi.length ?? 0 })}</p>
      </div>
    </div>
    <details class="array-scan-details">
      <summary>{t('array.analysis.scan')}</summary>
      <div class="stack">
        <p class="note">{t('array.analysis.scanNote')}</p>
        <div class="cluster">
          <label class="cluster-sm"><span>{t('array.analysis.from')}</span><NumberField class="rp-input array-input" min="-90" max="90" step="1" value={from()} aria-invalid={invalid().has('from')} onChange={e => updateNumber('from', e.currentTarget, -90, 90, setFrom)} /><span>°</span></label>
          <label class="cluster-sm"><span>{t('array.analysis.to')}</span><NumberField class="rp-input array-input" min="-90" max="90" step="1" value={to()} aria-invalid={invalid().has('to')} onChange={e => updateNumber('to', e.currentTarget, -90, 90, setTo)} /><span>°</span></label>
          <label class="cluster-sm"><span>{t('array.analysis.step')}</span><NumberField class="rp-input array-input" min="0.1" max="180" step="1" value={step()} aria-invalid={invalid().has('step')} onChange={e => updateNumber('step', e.currentTarget, .1, 180, setStep)} /><span>°</span></label>
          <button class="btn btn-sm" data-array-calculate-scan disabled={invalid().size > 0} onClick={calculate}>{t('array.analysis.calculate')}</button>
          <button class="btn btn-sm" disabled={!scan() || saving()} onClick={exportScan}>{t('array.analysis.csv')}</button>
        </div>
        <Show when={scan()}>{table => <div class="array-table-wrap" tabindex="0" role="region" aria-label={t('array.analysis.scan')}>
          <table class="table"><caption>{t('array.analysis.tableCaption', { f: table().frequencyHz, phi: table().phi })}</caption>
            <thead><tr><th class="num">θ<span class="th-unit">°</span></th><th class="num">{t('array.analysis.gain')}<span class="th-unit">dBi</span></th><th class="num">{t('array.analysis.loss')}<span class="th-unit">dB</span></th>
              <For each={table().weights}>{([p]) => <th class="num">P{p} · |Γ|<span class="th-unit">dB</span></th>}</For>
            </tr></thead>
            <tbody><For each={table().rows}>{row => <tr><td class="num mono">{shown(row.theta, 1)}</td><td class="num mono">{shown(row.gainDbi)}</td><td class="num mono">{shown(row.scanLossDb)}</td>
              <For each={row.activeDb}>{([, value]) => <td class="num mono">{shown(value)}</td>}</For>
            </tr>}</For></tbody>
          </table>
        </div>}</Show>
      </div>
    </details>
    <Show when={error() || invalid().size}><p class="note" role="alert">{t(`array.analysis.reason.${invalid().size ? 'range' : error()}`)}</p></Show>
    <Show when={download()}><p class="note" role="status">{download()}</p></Show>
  </section>;
}
