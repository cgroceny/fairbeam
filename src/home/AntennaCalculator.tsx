import { createMemo, createSignal, Show } from 'solid-js';
import NumberField from '../components/NumberField';
import { t } from '../i18n';
import { saveDownload, downloadMessage } from '../lib/download';
import { antennaDimensions, calculatorRecord, type AntennaKind, type CalculatorInput } from './antennaDimensions';
import { antennaDraft } from './antennaDraft';
import { createDesign } from '../designer/store';
import { models, serverState } from '../runner/store';
import { freeDesignId } from '../lib/designId';
import NecTransferPanel from './NecTransfer';

// Local Start-screen extension: incumbent controls/colors, one native disclosure,
// inputs beside estimates on desktop and stacked on narrow screens. No solver launch.
export default function AntennaCalculator() {
  const [kind, setKind] = createSignal<AntennaKind>('dipole');
  const [frequency, setFrequency] = createSignal('2.45');
  const [shortening, setShortening] = createSignal('0.95');
  const [epsilon, setEpsilon] = createSignal('4.3');
  const [height, setHeight] = createSignal('1.6');
  const [message, setMessage] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const number = (s: string) => s.trim() === '' ? NaN : Number(s);
  const input = (): CalculatorInput => ({ kind: kind(), frequencyGHz: number(frequency()), shortening: number(shortening()), epsilonR: number(epsilon()), heightMm: number(height()) });
  const result = createMemo(() => antennaDimensions(input()));
  const dimensions = () => { const r = result(); return r.ok ? r.dimensions : undefined; };
  const error = () => { const r = result(); return r.ok ? '' : t(`antennaCalc.error.${r.error}`); };
  const invalid = (field: string) => { const r = result(); return !r.ok && r.error === field; };
  const update = (setter: (value: string) => void, text: string) => { setter(text); setMessage(''); };
  const format = (n: number | undefined) => n === undefined ? '' : Number(n.toPrecision(7)).toString();
  const download = async () => {
    if (!result().ok || saving()) return;
    const record = calculatorRecord(input());
    setSaving(true);
    try { setMessage(downloadMessage(await saveDownload('antenna-estimate.json', JSON.stringify(record, null, 2) + '\n', 'application/json'))); }
    catch { setMessage(t('antennaCalc.exportFailed')); }
    finally { setSaving(false); }
  };
  const create = async () => {
    if (!result().ok || creating() || serverState() !== 'online') return;
    const values=input(), name=`${t(`antennaCalc.${values.kind}`)} (${values.frequencyGHz} GHz)`;
    const id=freeDesignId(name,models().map(m=>m.key)).id;
    setCreating(true);setMessage('');
    try { await createDesign({id,name,design:antennaDraft(values,id,name)}); }
    catch { setMessage(t('antennaCalc.createFailed')); }
    finally { setCreating(false); }
  };
  return <details class="antenna-calculator" data-testid="antenna-calculator">
    <summary>{t('antennaCalc.title')}</summary>
    <p class="muted">{t('antennaCalc.intro')}</p>
    <div class="antenna-calc-grid">
      <div class="antenna-calc-inputs">
        <label>{t('antennaCalc.kind')}<select class="rp-input" value={kind()} onChange={e => { setKind(e.currentTarget.value as AntennaKind); setMessage(''); }}>
          <option value="dipole">{t('antennaCalc.dipole')}</option><option value="monopole">{t('antennaCalc.monopole')}</option><option value="patch">{t('antennaCalc.patch')}</option>
        </select></label>
        <label>{t('antennaCalc.frequency')}<NumberField class="rp-input" value={frequency()} min="0.000001" max="1000" step="0.01" aria-invalid={invalid('frequency')} aria-describedby="antenna-calc-error" onInput={e => update(setFrequency, e.currentTarget.value)} /></label>
        <Show when={kind() !== 'patch'} fallback={<>
          <label>{t('antennaCalc.epsilon')}<NumberField class="rp-input" value={epsilon()} min="1" max="20" step="0.1" aria-invalid={invalid('substrate')} aria-describedby="antenna-calc-error" onInput={e => update(setEpsilon, e.currentTarget.value)} /></label>
          <label>{t('antennaCalc.height')}<NumberField class="rp-input" value={height()} min="0" step="0.1" aria-invalid={invalid('substrate') || invalid('thickness')} aria-describedby="antenna-calc-error" onInput={e => update(setHeight, e.currentTarget.value)} /></label>
        </>}>
          <label>{t('antennaCalc.shortening')}<NumberField class="rp-input" value={shortening()} min="0.5" max="1" step="0.01" aria-invalid={invalid('shortening')} aria-describedby="antenna-calc-error" onInput={e => update(setShortening, e.currentTarget.value)} /></label>
        </Show>
      </div>
      <div>
        <p id="antenna-calc-error" role="status" class="note">{error()}</p>
        <Show when={dimensions()}>{d => <>
          <dl class="antenna-calc-results">
            <dt>{t('antennaCalc.wavelength')}</dt><dd>{format(d().wavelengthMm)} mm</dd>
            <dt>{t(kind() === 'dipole' ? 'antennaCalc.totalLength' : 'antennaCalc.length')}</dt><dd>{format(d().lengthMm)} mm</dd>
            <Show when={d().armMm !== undefined}><dt>{t('antennaCalc.arm')}</dt><dd>{format(d().armMm)} mm</dd></Show>
            <Show when={d().widthMm !== undefined}><dt>{t('antennaCalc.width')}</dt><dd>{format(d().widthMm)} mm</dd><dt>{t('antennaCalc.effective')}</dt><dd>{format(d().effectivePermittivity)}</dd><dt>{t('antennaCalc.fringe')}</dt><dd>{format(d().fringeMm)} mm</dd></Show>
          </dl>
          <p class="note">{t(`antennaCalc.assumption.${kind()}`)}</p>
        </>}</Show>
      </div>
    </div>
    <div class="antenna-calc-actions">
      <button class="btn" disabled={!result().ok || saving()} onClick={() => void download()}>{t('antennaCalc.export')}</button>
      <button class="btn" data-testid="antenna-create" disabled={!result().ok || creating() || serverState() !== 'online'} onClick={() => void create()}>{t('antennaCalc.create')}</button>
    </div>
    <p class="note">{t(`antennaCalc.draft.${kind()}`)} {serverState() !== 'online' ? t('antennaCalc.needsServer') : ''}</p>
    <p class="note" role="status">{message()}</p>
    <NecTransferPanel dipole={kind()==='dipole' && dimensions() ? {lengthMm:dimensions()!.lengthMm,frequencyGHz:input().frequencyGHz} : undefined} />
  </details>;
}
