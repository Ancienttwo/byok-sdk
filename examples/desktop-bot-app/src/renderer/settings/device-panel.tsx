import type { DeviceView } from '../../host/settings/device.ts';

const lifecycleText = (lifecycle: DeviceView['lifecycle']): string => {
  switch (lifecycle.phase) {
    case 'running': return lifecycle.connection === 'open' ? 'Running, connected' : 'Running, connecting';
    case 'halted': return `Halted: ${lifecycle.reason} (${lifecycle.at})`;
    case 'crashed': return `Crashed (${lifecycle.at})`;
    case 'awaiting-enrollment': return 'Awaiting enrollment';
    case 'stopped': return 'Stopped';
  }
};

const clockSkewText = (skew: DeviceView['clockSkew']): string => skew.status === 'measured'
  ? `Device clock ahead by ${skew.deviceAheadMs} ms (±${skew.uncertaintyMs} ms), observed ${skew.observedAt}`
  : `Not measured: ${skew.reason}`;

/** The daemon's status and the SDK doctor, shown as the Host projected them (`host/settings/device.ts`). */
export function DevicePanel({ device }: { device: DeviceView }) {
  return (
    <>
      <h2>Device</h2>
      <dl className="settings-facts">
        <dt>Paired</dt><dd>{device.paired ? `Yes, ${device.deviceId ?? 'no device id'}` : 'No'}</dd>
        <dt>Daemon</dt><dd>{lifecycleText(device.lifecycle)}</dd>
        <dt>Active tasks</dt><dd>{device.activeTaskCount}</dd>
        <dt>Pending terminal commits</dt><dd>{device.pendingTerminalCommits}</dd>
        <dt>Clock skew</dt><dd>{clockSkewText(device.clockSkew)}</dd>
      </dl>
      <h2>Runtimes</h2>
      <table className="settings-table">
        <thead><tr><th>Runtime</th><th>Found</th><th>Outcome</th><th>Version</th><th>Version policy</th></tr></thead>
        <tbody>
          {device.runtimes.map(runtime => (
            <tr key={runtime.id}>
              <td>{runtime.id}</td>
              <td>{runtime.present ? 'Yes' : 'No'}</td>
              <td>{runtime.outcome}{runtime.reason === undefined ? '' : `: ${runtime.reason}`}</td>
              <td>{runtime.version ?? '—'}</td>
              <td data-verdict={runtime.verdict}>{runtime.verdict ?? 'none reported'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Doctor <span className="settings-status" data-status={device.doctor.worst}>{device.doctor.worst}</span></h2>
      <ul className="settings-checks">
        {device.doctor.checks.map(check => (
          <li key={check.id}><span className="settings-status" data-status={check.status}>{check.status}</span> {check.id}: {check.summary}</li>
        ))}
      </ul>
      <p className="settings-muted">Checked {device.doctor.generatedAt}</p>
    </>
  );
}
