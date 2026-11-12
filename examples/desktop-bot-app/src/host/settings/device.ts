import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  diagnoseDevice, exportDeviceSupportBundle,
  type Daemon, type DaemonConfig, type DaemonLifecycle, type DiagnoseDeviceOptions, type DiagnosticCheck,
  type DiagnosticsSnapshot, type DiagnosticStatus, type RuntimeObservation,
} from '@byok-sdk/client';

export interface RuntimeView {
  readonly id: string;
  readonly present: boolean;
  readonly outcome: RuntimeObservation['outcome'];
  readonly reason?: string;
  readonly version?: string;
  /** The effective version policy's verdict; absent when the SDK reported none, never inferred as `allow`. */
  readonly verdict?: 'allow' | 'warn' | 'block';
}

/** What the device page shows: the daemon's own status and the SDK doctor's checks, projected without reinterpretation. */
export interface DeviceView {
  readonly paired: boolean;
  readonly deviceId?: string;
  readonly lifecycle: DaemonLifecycle;
  readonly activeTaskCount: number;
  readonly pendingTerminalCommits: number;
  readonly runtimes: readonly RuntimeView[];
  readonly clockSkew: DiagnosticsSnapshot['clockSkew'];
  readonly doctor: { readonly generatedAt: string; readonly worst: DiagnosticStatus; readonly checks: readonly DiagnosticCheck[] };
}

const SEVERITY: Record<DiagnosticStatus, number> = { pass: 0, warn: 1, fail: 2 };

export function deviceView(status: ReturnType<Daemon['status']>, doctor: DiagnosticsSnapshot): DeviceView {
  const worst = doctor.checks.reduce<DiagnosticStatus>((acc, check) => (SEVERITY[check.status] > SEVERITY[acc] ? check.status : acc), 'pass');
  return {
    paired: status.paired,
    ...(status.deviceId === undefined ? {} : { deviceId: status.deviceId }),
    lifecycle: status.lifecycle,
    activeTaskCount: status.activeTaskCount,
    pendingTerminalCommits: status.pendingTerminalCommits,
    runtimes: status.runtimes.map(runtime => ({
      id: runtime.id,
      present: runtime.present,
      outcome: runtime.outcome,
      ...(runtime.reason === undefined ? {} : { reason: runtime.reason }),
      ...(runtime.version === undefined ? {} : { version: runtime.version }),
      ...(runtime.versionVerdict === undefined ? {} : { verdict: runtime.versionVerdict.state }),
    })),
    clockSkew: doctor.clockSkew,
    doctor: { generatedAt: doctor.generatedAt, worst, checks: doctor.checks },
  };
}

/** The Host's device-page read. `config` is the DaemonConfig the Host composed its daemon from. */
export interface DeviceSettings {
  device(): Promise<DeviceView>;
}

export function deviceSettings(daemon: Daemon, config: DaemonConfig, options?: DiagnoseDeviceOptions): DeviceSettings {
  return { device: async () => deviceView(daemon.status(), await diagnoseDevice(config, options)) };
}

/**
 * Writes the SDK's allowlisted support bundle for `config` to a new file under
 * `<hostStorageRoot>/host/diagnostics` and returns its path; the renderer never
 * names the path. A running Host passes its daemon's config, a stopped one the
 * config it would have run with.
 */
export async function exportDiagnostics(hostStorageRoot: string, config: DaemonConfig): Promise<{ path: string }> {
  const directory = path.join(hostStorageRoot, 'host', 'diagnostics');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `support-bundle-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await exportDeviceSupportBundle(config, { outputPath: file });
  return { path: file };
}
