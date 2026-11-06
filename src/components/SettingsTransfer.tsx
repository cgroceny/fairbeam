import { createSignal, onCleanup } from 'solid-js';
import { t } from '../i18n';
import { saveDownload, downloadMessage } from '../lib/download';
import { SETTINGS_FILE_LIMIT } from '../lib/settingsFile';

/** Import is explicit and atomic. Callers validate against the current document before applying. */
export default function SettingsTransfer(props: {
  name: string; hint: string; identity: () => unknown; export: () => string; import: (text: string) => void;
}) {
  let input: HTMLInputElement | undefined;
  let alive = true;
  onCleanup(() => { alive = false; });
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const fail = (error: unknown) => setMessage(t(error instanceof Error &&
    ['settingsFile.invalid', 'settingsFile.incompatible', 'settingsFile.changed'].includes(error.message)
    ? error.message : 'settingsFile.failed'));
  const save = async () => {
    setBusy(true); setMessage('');
    try { const result = await saveDownload(props.name, props.export(), 'application/json'); if (alive) setMessage(downloadMessage(result)); }
    catch (error) { if (alive) fail(error); }
    finally { if (alive) setBusy(false); }
  };
  const load = async (file?: File) => {
    if (!file || busy()) return;
    const identity = props.identity();
    setBusy(true); setMessage('');
    try {
      if (file.size > SETTINGS_FILE_LIMIT) throw new Error('settingsFile.invalid');
      const text = await file.text();
      if (!alive) return;
      if (props.identity() !== identity) throw new Error('settingsFile.changed');
      props.import(text);
      setMessage(t('settingsFile.applied'));
    } catch (error) { if (alive) fail(error); }
    finally { if (alive) { setBusy(false); if (input) input.value = ''; } }
  };
  return <div class="stack-sm" data-settings-transfer={props.name}>
    <p class="note">{t(props.hint)}</p>
    <div class="cluster">
      <button type="button" class="btn btn-ghost btn-sm" disabled={busy()} onClick={() => void save()}>{t('settingsFile.export')}</button>
      <button type="button" class="btn btn-ghost btn-sm" disabled={busy()} onClick={() => input?.click()}>{t('settingsFile.import')}</button>
      <input ref={input} type="file" accept=".json,application/json" hidden aria-label={t('settingsFile.import')}
        onChange={e => void load(e.currentTarget.files?.[0])} />
    </div>
    <p class="note" role="status">{message()}</p>
  </div>;
}
