import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import NumberField from '../components/NumberField';
import { t } from '../i18n';
import { saveDownload, downloadMessage } from '../lib/download';
import { api, type NecTransfer, type NecTransferInput } from '../runner/api';
import { serverState } from '../runner/store';

const wireLabels = ['necTransfer.segments', 'necTransfer.x1', 'necTransfer.y1', 'necTransfer.z1',
  'necTransfer.x2', 'necTransfer.y2', 'necTransfer.z2', 'necTransfer.radius'];
const exportLabels = { deck: 'necTransfer.export.deck', model: 'necTransfer.export.model', record: 'necTransfer.export.record' };

/** An explicit round-wire model, never an implicit conversion of a strip/solid Design. */
export default function NecTransferPanel(props: { dipole?: { lengthMm: number; frequencyGHz: number } }) {
  const [radius, setRadius] = createSignal('0.05'), [segments, setSegments] = createSignal('31');
  const [reference, setReference] = createSignal('50');
  const [result, setResult] = createSignal<NecTransfer | null>(null), [page, setPage] = createSignal(0);
  const [busy, setBusy] = createSignal(false), [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal(''), [message, setMessage] = createSignal('');
  const [editing, setEditing] = createSignal<number | null>(null), [fields, setFields] = createSignal<string[]>([]);
  let picker!: HTMLInputElement, generation = 0, controller: AbortController | undefined;
  const invalidate = () => { generation++; controller?.abort(); controller=undefined;setBusy(false); };
  onCleanup(invalidate);
  createEffect(() => { if (serverState() !== 'online') invalidate(); });
  const number = (value: string) => value.trim() === '' ? NaN : Number(value);
  const referenceValid = () => Number.isFinite(number(reference())) && number(reference()) > 0;
  const canCreate = () => !!props.dipole && referenceValid() && Number.isFinite(number(radius())) && number(radius()) > 0
    && Number.isInteger(number(segments())) && number(segments()) >= 3 && number(segments()) <= 399 && number(segments()) % 2 === 1;
  const visible = createMemo(() => result()?.model.wires.slice(page()*25, (page()+1)*25) ?? []);
  const request = async (body: NecTransferInput, token = ++generation) => {
    controller?.abort(); const abort = new AbortController();controller=abort;
    setBusy(true);setError('');setMessage('');
    try {
      const next = await api.necTransfer(body, abort.signal);
      if (token === generation) { setResult(next);setPage(0);setEditing(null); }
    } catch (cause) {
      if (token === generation && !abort.signal.aborted) setError(t('necTransfer.failed')+' '+(cause instanceof Error ? cause.message : ''));
    } finally { if (token === generation) { setBusy(false);controller=undefined; } }
  };
  const create = () => {
    if (!canCreate() || busy() || serverState() !== 'online') return;
    const dipole=props.dipole!;
    void request({dipole:{length_mm:dipole.lengthMm,radius_mm:number(radius()),segments:number(segments()),
      frequency_ghz:[dipole.frequencyGHz],reference_ohm:number(reference())}});
  };
  const importFile = async (file: File | undefined) => {
    if (!file || !referenceValid() || serverState() !== 'online') return;
    invalidate();const token=generation, referenceOhm=number(reference());setError('');setMessage('');
    if (file.size > 1024*1024) { setError(t('necTransfer.tooLarge'));return; }
    setBusy(true);
    try {
      // Preserve the original UTF-8 BOM and reject malformed bytes: the report
      // hashes the selected file, not a browser-decoded replacement string.
      const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer());
      if (token === generation) await request({source,reference_ohm:referenceOhm},token);
    } catch { if (token===generation) { setError(t('necTransfer.readFailed'));setBusy(false); } }
  };
  const download = async (kind: 'deck' | 'model' | 'record') => {
    const value=result();if (!value || saving() || busy() || editing() !== null) return;
    setSaving(true);setMessage('');
    const name=kind==='deck'?'wire-antenna.nec':kind==='model'?'wire-antenna.json':'wire-antenna-record.json';
    const content=kind==='deck'?value.deck:JSON.stringify(kind==='model'?value.model:value,null,2)+'\n';
    try { setMessage(downloadMessage(await saveDownload(name,content,kind==='deck'?'text/plain':'application/json'))); }
    catch { setError(t('necTransfer.downloadFailed')); }
    finally { setSaving(false); }
  };
  const edit = (index: number) => {
    const wire=result()!.model.wires[index];setEditing(index);setFields([wire.segments,...wire.start_mm,...wire.end_mm,wire.radius_mm].map(String));setError('');
  };
  const apply = () => {
    const index=editing(), current=result();if(index===null || !current || busy()) return;
    const values=fields().map(number);
    if(values.some(v=>!Number.isFinite(v))) {setError(t('necTransfer.invalidFields'));return;}
    const model=structuredClone(current.model);
    model.wires[index]={...model.wires[index],segments:values[0],start_mm:values.slice(1,4),end_mm:values.slice(4,7),radius_mm:values[7]};
    void request({model,pattern:current.pattern});
  };
  return <details class="nec-transfer" data-testid="nec-transfer">
    <summary>{t('necTransfer.title')}</summary>
    <p class="note">{t('necTransfer.scope')}</p>
    <div class="antenna-calc-inputs nec-transfer-inputs">
      <label>{t('necTransfer.reference')}<NumberField class="rp-input" value={reference()} disabled={busy()} onInput={e=>setReference(e.currentTarget.value)} /></label>
      <Show when={props.dipole}>
        <label>{t('necTransfer.radius')}<NumberField class="rp-input" value={radius()} disabled={busy()} onInput={e=>setRadius(e.currentTarget.value)} /></label>
        <label>{t('necTransfer.segments')}<NumberField class="rp-input" value={segments()} disabled={busy()} onInput={e=>setSegments(e.currentTarget.value)} /></label>
      </Show>
    </div>
    <div class="antenna-calc-actions">
      <Show when={props.dipole}><button type="button" class="btn" data-testid="nec-create" disabled={!canCreate() || busy() || editing() !== null || serverState() !== 'online'} onClick={create}>{t('necTransfer.create')}</button></Show>
      <button type="button" class="btn" data-testid="nec-import" disabled={!referenceValid() || busy() || editing() !== null || serverState() !== 'online'} onClick={()=>picker.click()}>{t('necTransfer.import')}</button>
      <input ref={picker} type="file" accept=".nec,.txt" hidden onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';void importFile(file);}} />
    </div>
    <Show when={serverState() !== 'online'}><p class="note">{t('necTransfer.needsServer')}</p></Show>
    <Show when={busy()}><p role="status">{t('necTransfer.checking')}</p></Show>
    <Show when={error()}><p class="note" role="alert">{error()}</p></Show>
    <Show when={result()}>{value=><>
      <p class="note" data-testid="nec-summary">{t('necTransfer.summary',{wires:value().model.wires.length,segments:value().model.wires.reduce((s,w)=>s+w.segments,0),frequencies:value().model.frequency_ghz.length,reference:value().model.reference_ohm})}</p>
      <p class="note">{t('necTransfer.feed',{tag:value().model.feed.tag,segment:value().model.feed.segment})}</p>
      <details><summary>{t('necTransfer.frequencies')}</summary><p class="nec-frequency-list">{value().model.frequency_ghz.map(f=>String(f)).join(', ')} GHz</p></details>
      <div class="nec-wire-scroll" tabIndex={0} role="region" aria-label={t('necTransfer.wires')}><table class="nec-wire-table">
        <thead><tr><th>{t('necTransfer.tag')}</th><th>{t('necTransfer.segments')}</th><th>{t('necTransfer.start')}</th><th>{t('necTransfer.end')}</th><th>{t('necTransfer.radius')}</th><th>{t('necTransfer.edit')}</th></tr></thead>
        <tbody><For each={visible()}>{(wire,index)=><tr><td>{wire.tag}</td><td>{wire.segments}</td><td>{wire.start_mm.join(', ')}</td><td>{wire.end_mm.join(', ')}</td><td>{wire.radius_mm}</td><td><button class="btn btn-sm" disabled={busy() || editing() !== null} onClick={()=>edit(page()*25+index())}>{t('necTransfer.editWire',{tag:wire.tag})}</button></td></tr>}</For></tbody>
      </table></div>
      <Show when={value().model.wires.length>25}><div class="antenna-calc-actions">
        <button class="btn" disabled={page()===0 || editing()!==null} onClick={()=>setPage(p=>p-1)}>{t('necTransfer.previous')}</button>
        <span role="status">{t('necTransfer.page',{current:page()+1,total:Math.ceil(value().model.wires.length/25)})}</span>
        <button class="btn" disabled={(page()+1)*25>=value().model.wires.length || editing()!==null} onClick={()=>setPage(p=>p+1)}>{t('necTransfer.next')}</button>
      </div></Show>
      <Show when={editing() !== null}><fieldset class="nec-wire-editor"><legend>{t('necTransfer.editWire',{tag:value().model.wires[editing()!].tag})}</legend>
        <div class="nec-edit-grid"><For each={wireLabels}>{(key,index)=><label>{t(key)}<NumberField class="rp-input" value={fields()[index()]} disabled={busy()} onInput={e=>setFields(old=>old.map((v,i)=>i===index()?e.currentTarget.value:v))}/></label>}</For></div>
        <div class="antenna-calc-actions"><button class="btn" disabled={busy() || serverState()!=='online'} onClick={apply}>{t('necTransfer.apply')}</button><button class="btn" onClick={()=>{invalidate();setEditing(null);setError('');}}>{t('necTransfer.cancel')}</button></div>
      </fieldset></Show>
      <div class="antenna-calc-actions"><For each={['deck','model','record'] as const}>{kind=><button class="btn" data-testid={'nec-export-'+kind} disabled={busy() || saving() || editing()!==null} onClick={()=>void download(kind)}>{t(exportLabels[kind])}</button>}</For></div>
      <p class="note">{t('necTransfer.unsolved')}</p>
    </>}</Show>
    <p class="note" role="status">{message()}</p>
  </details>;
}
