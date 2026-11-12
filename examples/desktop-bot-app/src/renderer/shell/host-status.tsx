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

/** Puts the snapshot this version wrote before an update back; the app restarts afterwards. */
function RestoreAction(props: { version: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    setBusy(true);
    try {
      await window.byok.call('shell.restore', undefined);
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="shell-action">
      {!confirming && <button type="button" onClick={() => setConfirming(true)}>Restore data of version {props.version}</button>}
      {confirming && (
        <>
          <p>The app stops, moves the current data aside (nothing is deleted), puts back the copy version {props.version} kept before its update, and restarts.</p>
          <button type="button" disabled={busy} onClick={() => void run()}>Restore and restart</button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        </>
      )}
      {error !== undefined && <p className="shell-error" role="alert">Restore failed: {error}</p>}
    </div>
  );
}

/** Start fresh after a refused store: the stores move aside, the old device enrollment is cleared, the app restarts as a new device. */
function StartFreshAction() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    setBusy(true);
    try {
      await window.byok.call('shell.startFresh', undefined);
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="shell-action">
      {!confirming && <button type="button" onClick={() => setConfirming(true)}>Start fresh</button>}
      {confirming && (
        <>
          <p>
            The app stops and moves its data aside, next to where it was (nothing is deleted). It removes this device&apos;s
            enrollment and restarts as a new device with no Bots and no provider profiles. The moved data stays on disk, but it
            cannot run again as this device.
          </p>
          <button type="button" disabled={busy} onClick={() => void run()}>Move the data aside and start fresh</button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        </>
      )}
      {error !== undefined && <p className="shell-error" role="alert">Start fresh failed: {error}</p>}
    </div>
  );
}

/**
 * While the Host is stopped: its reason and what the user can do from here (#1499 D4). While it runs on data
 * this version can restore from, the restore offer alone (#1499 D3: the build was reinstalled after an update).
 */
export function RecoveryPanel(props: { view: ShellView }) {
  const { host, restore } = props.view;
  if (host?.state === 'stopped') {
    return (
      <section className="shell-recovery" role="alert">
        <h2>The Host stopped</h2>
        <p>{host.reason}</p>
        <DiagnosticsExport />
        {restore && <RestoreAction version={restore.version} />}
        {host.storeRefused && <StartFreshAction />}
      </section>
    );
  }
  if (host?.state !== 'running' || !restore) return null;
  return (
    <section className="shell-recovery">
      <p>Version {restore.version} kept a copy of its data before it was updated.</p>
      <RestoreAction version={restore.version} />
    </section>
  );
}
