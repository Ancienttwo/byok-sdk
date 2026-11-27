import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from 'node:timers';
import {
  diagnoseDevice, exportDeviceSupportBundle,
  type Daemon, type DaemonConfig, type DiagnoseDeviceOptions,
  type DiagnosticsSnapshot, type DiagnosticStatus, type RuntimeAdapter, type RuntimeDetectResult, type RuntimeObservation,
} from '@byok-sdk/client';
import { observeRuntimeDetection, projectRuntimeObservation } from '@byok-sdk/client/adapters';
import type { DeviceParams, DeviceView, RuntimeView } from './types.ts';

export type { DeviceParams, DeviceView, RuntimeView };

const SEVERITY: Record<DiagnosticStatus, number> = { pass: 0, warn: 1, fail: 2 };
/** Covers Claude's worst case (10 s version + 25 s auth status), matching the SDK's runtime probe budget. */
const RUNTIME_PROBE_TIMEOUT_MS = 35_000;

function projectRuntime(runtime: RuntimeObservation): RuntimeView {
  return {
    id: runtime.id,
    present: runtime.present,
    outcome: runtime.outcome,
    ...(runtime.reason === undefined ? {} : { reason: runtime.reason }),
    ...(runtime.version === undefined ? {} : { version: runtime.version }),
    ...(runtime.versionVerdict === undefined ? {} : { verdict: runtime.versionVerdict.state }),
    ...(runtime.qualifiedVersion === undefined ? {} : { qualifiedVersion: runtime.qualifiedVersion }),
    ...(runtime.upgrade === undefined ? {} : { upgrade: { ...runtime.upgrade } }),
    ...(runtime.authPresent === undefined ? {} : { authPresent: runtime.authPresent }),
    ...(runtime.executablePath === undefined ? {} : { executablePath: runtime.executablePath }),
    ...(runtime.executableSource === undefined ? {} : { executableSource: runtime.executableSource }),
  };
}

export function deviceView(
  status: ReturnType<Daemon['status']>,
  doctor: DiagnosticsSnapshot,
  runtimes: readonly RuntimeObservation[] = status.runtimes,
): DeviceView {
  const worst = doctor.checks.reduce<DiagnosticStatus>((acc, check) => (SEVERITY[check.status] > SEVERITY[acc] ? check.status : acc), 'pass');
  return {
    paired: status.paired,
    ...(status.deviceId === undefined ? {} : { deviceId: status.deviceId }),
    lifecycle: status.lifecycle,
    activeTaskCount: status.activeTaskCount,
    pendingTerminalCommits: status.pendingTerminalCommits,
    runtimes: runtimes.map(projectRuntime),
    clockSkew: doctor.clockSkew,
    doctor: { generatedAt: doctor.generatedAt, worst, checks: doctor.checks },
  };
}

async function detectWithTimeout(adapter: RuntimeAdapter, timeoutMs: number): Promise<RuntimeDetectResult> {
  let timer: ReturnType<typeof scheduleTimeout> | undefined;
  const controller = new AbortController();
  const detection = observeRuntimeDetection(adapter, controller.signal).catch(
    (): RuntimeDetectResult => ({ kind: controller.signal.aborted ? 'timeout' : 'probe-failed' }),
  );
  try {
    return await Promise.race([
      detection,
      new Promise<RuntimeDetectResult>((resolve) => {
        timer = scheduleTimeout(() => {
          controller.abort();
          resolve({ kind: 'timeout' });
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) cancelTimeout(timer);
  }
}

async function probeAdapters(adapters: readonly RuntimeAdapter[], timeoutMs: number): Promise<RuntimeObservation[]> {
  return Promise.all(
    adapters.map(async (adapter): Promise<RuntimeObservation> => {
      const detected = await detectWithTimeout(adapter, timeoutMs);
      return projectRuntimeObservation(adapter.descriptor, detected);
    }),
  );
}

/** The Host's device-page read. `config` is the DaemonConfig the Host composed its daemon from. */
export interface DeviceSettings {
  device(params?: DeviceParams): Promise<DeviceView>;
}

export function deviceSettings(
  daemon: Daemon,
  config: DaemonConfig,
  adapters: readonly RuntimeAdapter[],
  options?: DiagnoseDeviceOptions,
): DeviceSettings {
  const timeoutMs = options?.runtimeProbeTimeoutMs ?? RUNTIME_PROBE_TIMEOUT_MS;
  return {
    device: async (params?: DeviceParams) => {
      if (params?.checkAuth === true) {
        const [doctor, runtimes] = await Promise.all([
          diagnoseDevice(config, options),
          probeAdapters(adapters, timeoutMs),
        ]);
        return deviceView(daemon.status(), doctor, runtimes);
      }
      return deviceView(daemon.status(), await diagnoseDevice(config, options));
    },
  };
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
