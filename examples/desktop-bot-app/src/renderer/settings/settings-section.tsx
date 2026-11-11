import { useCallback, useEffect, useState } from 'react';
import type { LoginItemView } from '../../bridge/domains/settings.ts';
import type { ModelChoice } from '../../host/conversation/catalog.ts';
import type { DeviceView } from '../../host/settings/device.ts';
import type { DreamingSetting } from '../../host/settings/store.ts';
import { DevicePanel } from './device-panel.tsx';
import './settings.css';

type Read<T> = { readonly value: T; readonly error?: undefined } | { readonly value?: undefined; readonly error: string };
const read = <T,>(call: Promise<T>): Promise<Read<T>> => call.then(value => ({ value }), (error: Error) => ({ error: error.message }));

/**
 * Device, runtimes, clock skew and doctor, then dreaming, login item and diagnostics export. The doctor runs on open
 * and on Refresh only, not on every Host hint. Each read and command shows its own error; nothing is guessed.
 */
export function SettingsSection() {
  const [device, setDevice] = useState<Read<DeviceView>>();
  const [dreaming, setDreaming] = useState<Read<DreamingSetting>>();
  const [models, setModels] = useState<Read<readonly ModelChoice[]>>();
  const [loginItem, setLoginItem] = useState<Read<LoginItemView>>();
  // Each refresh starts the dreaming form again from the saved setting; a save keeps the form and its message.
  const [loaded, setLoaded] = useState(0);
  const refresh = useCallback(() => {
    setLoaded(count => count + 1);
    void read(window.byok.call('settings.device', undefined)).then(setDevice);
    void read(window.byok.call('settings.get', undefined).then(settings => settings.dreaming)).then(setDreaming);
    void read(window.byok.call('k8.view', { botId: null }).then(view => view.models)).then(setModels);
    void read(window.byok.call('settings.loginItem', undefined)).then(setLoginItem);
  }, []);
  useEffect(refresh, [refresh]);
  return (
    <section className="settings">
      <h1>Settings <button type="button" onClick={refresh}>Refresh</button></h1>
      {device?.error !== undefined && <p className="settings-error" role="alert">Device unavailable: {device.error}</p>}
      {device?.value && <DevicePanel device={device.value} />}
      <h2>Dreaming</h2>
      {dreaming?.error !== undefined && <p className="settings-error" role="alert">Settings unavailable: {dreaming.error}</p>}
      {models?.error !== undefined && <p className="settings-error" role="alert">Models unavailable: {models.error}</p>}
      {dreaming?.value && models?.value && <DreamingForm key={loaded} saved={dreaming.value} models={models.value}
        onSaved={value => setDreaming({ value })} />}
      <h2>Login item</h2>
      <LoginItemSwitch state={loginItem} onChanged={setLoginItem} />
      <h2>Diagnostics</h2>
      <DiagnosticsExport />
    </section>
  );
}

/** The global switch and the preferred models, in the order picked; K8 reads them when the Host next starts. */
function DreamingForm(props: { saved: DreamingSetting; models: readonly ModelChoice[]; onSaved: (value: DreamingSetting) => void }) {
  const [draft, setDraft] = useState(props.saved);
  const [result, setResult] = useState<string>();
  const [busy, setBusy] = useState(false);
  const known = new Set(props.models.map(model => model.id));
  const toggle = (id: string) => setDraft({ ...draft, models: draft.models.includes(id) ? draft.models.filter(model => model !== id) : [...draft.models, id] });
  const save = async () => {
    setBusy(true);
    const saved = await read(window.byok.call('settings.setDreaming', draft));
    setBusy(false);
    if (saved.value) props.onSaved(saved.value.dreaming);
    setResult(saved.error ?? 'Saved. Applies when the Host next starts.');
  };
  return (
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /> Dreaming on</label>
      <fieldset disabled={!draft.enabled}>
        <legend>Models, preferred first</legend>
        {props.models.map(model => (
          <label key={model.id}>
            <input type="checkbox" checked={draft.models.includes(model.id)} onChange={() => toggle(model.id)} />
            {' '}{model.label}{draft.models.includes(model.id) ? ` (#${draft.models.indexOf(model.id) + 1})` : ''}
          </label>
        ))}
        {draft.models.filter(id => !known.has(id)).map(id => (
          <label key={id}><input type="checkbox" checked onChange={() => toggle(id)} /> {id} (no longer in the catalog)</label>
        ))}
      </fieldset>
      <button type="submit" disabled={busy}>Save dreaming</button>
      {result !== undefined && <p className="settings-muted" role="status">{result}</p>}
    </form>
  );
}

/** The OS holds the login item; the switch shows what the OS reports after each change. */
function LoginItemSwitch(props: { state: Read<LoginItemView> | undefined; onChanged: (state: Read<LoginItemView>) => void }) {
  const [busy, setBusy] = useState(false);
  if (props.state?.error !== undefined) return <p className="settings-error" role="alert">Login item unavailable: {props.state.error}</p>;
  if (!props.state?.value) return null;
  if (!props.state.value.supported) return <p className="settings-muted">Not available on this platform.</p>;
  const set = async (enabled: boolean) => {
    setBusy(true);
    props.onChanged(await read(window.byok.call('settings.setLoginItem', { enabled })));
    setBusy(false);
  };
  return (
    <label>
      <input type="checkbox" disabled={busy} checked={props.state.value.enabled} onChange={event => void set(event.target.checked)} /> Open at login
    </label>
  );
}

/** Writes the SDK's support bundle; the Host names the file and the renderer only shows where it went. */
function DiagnosticsExport() {
  const [result, setResult] = useState<Read<{ path: string }>>();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setResult(await read(window.byok.call('settings.exportDiagnostics', undefined)));
    setBusy(false);
  };
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void run()}>Export diagnostics</button>
      {result?.value && <p className="settings-muted" role="status">Written to {result.value.path}</p>}
      {result?.error !== undefined && <p className="settings-error" role="alert">Export failed: {result.error}</p>}
    </>
  );
}
