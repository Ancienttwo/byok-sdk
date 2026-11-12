import { useEffect, useState } from 'react';
import type { ShellView } from '../../bridge/domains/shell.ts';
import type { SupervisedHostState } from '../../bridge/protocol.ts';
import { DiagnosticsExport } from '../settings/settings-section.tsx';

/** Main's view of the Host, read at mount and after every state hint; a refused read shows its error, never a guessed state. */
export function useShellView(): { view?: ShellView; error?: string } {
  const [read, setRead] = useState<{ view?: ShellView; error?: string }>({});
  useEffect(() => {
    let latest = 0;
    const load = () => {
      const call = ++latest;
      window.byok.call('shell.state', undefined).then(
        view => { if (call === latest) setRead({ view }); },
        (error: Error) => { if (call === latest) setRead({ error: error.message }); },
      );
    };
    load();
    return window.byok.onStateChanged(load);
  }, []);
  return read;
}

function describe(host: SupervisedHostState | null): string {
  if (host === null) return 'Host starting';
  switch (host.state) {
    case 'starting': return 'Host starting';
    case 'running': return 'Host running';
    case 'restarting': return `Host restarting in ${Math.ceil(host.inMs / 1000)} s: ${host.reason}`;
    case 'stopped': return `Host stopped: ${host.reason}`;
    case 'failed': return `Host failed: ${host.reason}`;
  }
}

export function HostStatus(props: { view?: ShellView; error?: string }) {
  if (props.error !== undefined) return <p className="shell-host" data-error>Host unavailable: {props.error}</p>;
  const state = props.view?.host?.state;
  return <p className="shell-host" data-error={state === 'stopped' || state === 'failed' || undefined}>{props.view ? describe(props.view.host) : 'Host …'}</p>;
}

/** One recovery action at a time in the panel: while one runs, every action button is disabled. */
interface ActionProps { readonly busy: boolean; readonly setBusy: (busy: boolean) => void }

/** An action that asks first, runs one bridge call, and shows its failure; on success the app restarts. */
function ConfirmedAction(props: ActionProps & { label: string; confirm: string; explanation: string; method: 'shell.restore' | 'shell.startFresh'; failure: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    props.setBusy(true);
    try {
      await window.byok.call(props.method, undefined);
    } catch (failure) {
      setError((failure as Error).message);
      props.setBusy(false);
    }
  };
  return (
    <div className="shell-action">
      {!confirming && <button type="button" disabled={props.busy} onClick={() => setConfirming(true)}>{props.label}</button>}
      {confirming && (
        <>
          <p>{props.explanation}</p>
          <button type="button" disabled={props.busy} onClick={() => void run()}>{props.confirm}</button>
          <button type="button" disabled={props.busy} onClick={() => setConfirming(false)}>Cancel</button>
        </>
      )}
      {error !== undefined && <p className="shell-error" role="alert">{props.failure}: {error}</p>}
    </div>
  );
}

/** Shown while the Host is stopped: its reason and what the user can do from here (#1499 D3, D4). */
export function RecoveryPanel(props: { view: ShellView }) {
  const [busy, setBusy] = useState(false);
  const { host, restore, restoreError } = props.view;
  if (host?.state !== 'stopped') return null;
  return (
    <section className="shell-recovery" role="alert">
      <h2>The Host stopped</h2>
      <p>{host.reason}</p>
      <DiagnosticsExport />
      {restoreError !== null && <p className="shell-error">Restore unavailable: {restoreError}</p>}
      {restore && (
        <ConfirmedAction busy={busy} setBusy={setBusy} method="shell.restore" label={`Restore data of version ${restore.version}`}
          confirm="Restore and restart" failure="Restore failed"
          explanation={`The app stops, renames the current data to *.aside-<time> next to where it was (nothing is deleted), puts back the copy version ${restore.version} kept before its update, and restarts.`} />
      )}
      {host.storeRefused && (
        <ConfirmedAction busy={busy} setBusy={setBusy} method="shell.startFresh" label="Start fresh"
          confirm="Move the data aside and start fresh" failure="Start fresh failed"
          explanation={
            'The app stops and renames its data folders to *.aside-<time> next to where they were; nothing is deleted. It removes '
            + 'this device\'s enrollment and restarts as a new device with no Bots and no provider profiles. The app never opens the '
            + 'moved data again by itself. Provider keys stay in the OS credential store; a new profile still needs its key entered.'
          } />
      )}
    </section>
  );
}
