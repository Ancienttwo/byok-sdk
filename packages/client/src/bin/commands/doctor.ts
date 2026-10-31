import type { DaemonConfig } from '../../index';
import {
  collectDoctorDiagnostics,
  quarantineCorruptOperationalHealth,
  type CollectDiagnosticsOptions,
  type DoctorDiagnostics,
  type OperationalHealthFixResult,
} from '../../diagnostics/diagnostics';
import { resolveStoreDir } from '../config';
import { serviceLogDir } from '../../daemon/host-layout';
import type { ServiceEnvironmentRecord } from '../../login-shell-environment';
import { formatRuntimeEnvironmentLines, formatServiceEnvironment } from '../../diagnostics/format';
import { repairDeviceEnrollmentMetadata, DeviceMetadataRepairError, resetDeviceCursor, DeviceCursorResetError } from '../../diagnostics/device-doctor';

export interface DoctorOptions extends CollectDiagnosticsOptions {
  json?: boolean;
  fix?: boolean;
  repair?: string;
  expectedDeviceId?: string;
  expectedTenantId?: string;
  confirmed?: boolean;
  log?: (line: string) => void;
}

export class DoctorConfirmationRequiredError extends Error {
  constructor() {
    super('doctor --fix requires explicit --yes confirmation');
    this.name = 'DoctorConfirmationRequiredError';
  }
}

export class DoctorDaemonRunningError extends Error {
  constructor() {
    super('doctor --fix refuses while the daemon control socket is reachable; stop the daemon first');
    this.name = 'DoctorDaemonRunningError';
  }
}

function formatDoctorLines(diagnostics: DoctorDiagnostics, logDir: string, environment: ServiceEnvironmentRecord | undefined, fixResult?: OperationalHealthFixResult): string[] {
  const { snapshot } = diagnostics;
  const lines = [
    `doctor: productHash=${snapshot.product.nameHash} generatedAt=${snapshot.generatedAt}`,
    `system: node=${snapshot.system.node} platform=${snapshot.system.platform} arch=${snapshot.system.arch} sqlite=${snapshot.system.sqliteAvailable ? 'available' : 'unavailable'}`,
    // Issue #392: the environment the last `start` resolved (closed values only).
    environment ? `environment: ${formatServiceEnvironment(environment.status)} at=${environment.ts}` : 'environment: unknown',
    // #1095: the running daemon's runtime environment names and sources, never values.
    ...formatRuntimeEnvironmentLines(diagnostics.runtimeEnvironment),
    // #1103: the effective version policy's verdict per runtime. A block is
    // the one verdict an operator must act on, so the line names its local
    // cause; allow/warn stay one compact line. Older daemons and custom
    // adapters without a policy simply omit the line.
    ...snapshot.runtimes.flatMap((runtime) => {
      const verdict = runtime.versionVerdict;
      if (verdict === undefined) return [];
      const details = [
        `runtime-version: ${runtime.idHash}`,
        `state=${verdict.state}`,
        `qualifiedVersion=${verdict.qualifiedVersion}`,
        ...(verdict.matched === undefined ? [] : [`matched=${verdict.matched}`]),
      ];
      if (verdict.state === 'block') details.push('blocked by the device version policy');
      return [details.join(' ')];
    }),
    // #1103 §2.6: a restart comparison is local-only evidence. Both upgrade
    // and downgrade are reported; a downgrade says why it matters.
    ...snapshot.runtimes.flatMap((runtime) => {
      const change = runtime.versionChange;
      if (change === undefined) return [];
      const details = [
        `runtime-version-change: ${runtime.idHash}`,
        `direction=${change.direction}`,
        `from=${change.fromVersion}`,
        `to=${change.toVersion}`,
        `observedAt=${change.observedAt}`,
      ];
      if (change.direction === 'downgrade') details.push('the installed CLI may have been replaced');
      return [details.join(' ')];
    }),
  ];
  for (const check of snapshot.checks) lines.push(`check ${check.id}: ${check.status} (${check.summary})`);
  // #1097: where the daemon log and the service manager's redirect files are, and how large.
  lines.push(`logs: ${logDir} ${snapshot.logs.status} totalBytes=${snapshot.logs.totalBytes} files=${snapshot.logs.files.length}${snapshot.logs.truncated ? '+' : ''}`);
  if (snapshot.health.status === 'corrupt' || snapshot.health.status === 'unavailable') {
    lines.push(`health-detail: ${snapshot.health.reason}; bytes=${snapshot.health.sizeBytes ?? 'unknown'}`);
  }
  if (snapshot.quarantine.truncated) {
    lines.push(`quarantine-detail: inventory truncated after ${snapshot.quarantine.scannedCount} scanned entries`);
  }
  if (fixResult?.status === 'quarantined') {
    lines.push(
      `fix: quarantined ${fixResult.sizeBytes} bytes as ${fixResult.evidenceName}; manifest=${fixResult.manifestName}; sha256=${fixResult.sha256}`,
    );
  } else if (fixResult) {
    lines.push(`fix: no change (${fixResult.reason})`);
  }
  return lines;
}

export async function runDoctorCommand(config: DaemonConfig, options: DoctorOptions = {}): Promise<void> {
  if (options.repair !== undefined) {
    if (options.fix || (options.repair !== 'restore-enrollment-metadata' && options.repair !== 'reset-cursor')) {
      throw new Error('doctor requires one supported repair action; --fix cannot be combined with --repair');
    }
    const log = options.log ?? ((line: string) => console.log(line));
    if (options.repair === 'reset-cursor') {
      if (options.expectedDeviceId !== undefined || options.expectedTenantId !== undefined) {
        throw new Error('expected identity flags require --repair restore-enrollment-metadata');
      }
      try {
        const repair = await resetDeviceCursor(config, { confirmed: options.confirmed as true });
        log(options.json ? JSON.stringify({ repair }, null, 2) : `repair ${repair.action}: ${repair.status} (${repair.scope})`);
        return;
      } catch (error) {
        if (options.json && error instanceof DeviceCursorResetError) {
          log(JSON.stringify({ repair: { action: 'reset-cursor', scope: 'device', status: 'failed', code: error.code } }, null, 2));
        }
        throw error;
      }
    }
    try {
      const repair = await repairDeviceEnrollmentMetadata(config, {
        confirmed: options.confirmed as true,
        expectedDeviceId: options.expectedDeviceId as string,
        expectedTenantId: options.expectedTenantId as string,
      });
      log(options.json ? JSON.stringify({ repair }, null, 2) : `repair ${repair.action}: ${repair.status} (${repair.scope})`);
      return;
    } catch (error) {
      if (options.json && error instanceof DeviceMetadataRepairError) {
        log(JSON.stringify({ repair: { action: 'restore-enrollment-metadata', scope: 'device', status: 'failed', code: error.code } }, null, 2));
      }
      throw error;
    }
  }
  if (options.expectedDeviceId !== undefined || options.expectedTenantId !== undefined) {
    throw new Error('expected identity flags require --repair restore-enrollment-metadata');
  }
  if (options.fix && !options.confirmed) throw new DoctorConfirmationRequiredError();
  const storeDir = resolveStoreDir(config);
  let diagnostics = await collectDoctorDiagnostics(config, storeDir, options);
  let fixResult: OperationalHealthFixResult | undefined;
  if (options.fix) {
    if (diagnostics.snapshot.control.status === 'online') throw new DoctorDaemonRunningError();
    fixResult = await quarantineCorruptOperationalHealth(storeDir, { clock: options.clock });
    diagnostics = await collectDoctorDiagnostics(config, storeDir, options);
  }
  const { snapshot } = diagnostics;
  const log = options.log ?? ((line: string) => console.log(line));
  const logDir = serviceLogDir(storeDir);
  const environment = snapshot.environment.status === 'unknown' ? undefined : snapshot.environment;
  if (options.json) {
    log(JSON.stringify({ diagnostics: snapshot, logDir, environment: environment ?? { status: 'unknown' }, runtimeEnvironment: diagnostics.runtimeEnvironment, ...(fixResult ? { fix: fixResult } : {}) }, null, 2));
    return;
  }
  for (const line of formatDoctorLines(diagnostics, logDir, environment, fixResult)) log(line);
}
