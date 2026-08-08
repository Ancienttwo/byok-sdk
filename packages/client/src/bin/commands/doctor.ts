import type { DaemonConfig } from '../../index';
import {
  collectDiagnostics,
  quarantineCorruptOperationalHealth,
  type CollectDiagnosticsOptions,
  type DiagnosticsSnapshot,
  type OperationalHealthFixResult,
} from '../../diagnostics/diagnostics';
import { resolveStoreDir } from '../config';

export interface DoctorOptions extends CollectDiagnosticsOptions {
  json?: boolean;
  fix?: boolean;
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

function formatDoctorLines(snapshot: DiagnosticsSnapshot, fixResult?: OperationalHealthFixResult): string[] {
  const lines = [
    `doctor: productHash=${snapshot.product.nameHash} generatedAt=${snapshot.generatedAt}`,
    `system: node=${snapshot.system.node} platform=${snapshot.system.platform} arch=${snapshot.system.arch} sqlite=${snapshot.system.sqliteAvailable ? 'available' : 'unavailable'}`,
  ];
  for (const check of snapshot.checks) lines.push(`check ${check.id}: ${check.status} (${check.summary})`);
  if (snapshot.health.status === 'corrupt') lines.push(`health-detail: ${snapshot.health.reason}; bytes=${snapshot.health.sizeBytes}`);
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
  if (options.fix && !options.confirmed) throw new DoctorConfirmationRequiredError();
  const storeDir = resolveStoreDir(config);
  let snapshot = await collectDiagnostics(config, storeDir, options);
  let fixResult: OperationalHealthFixResult | undefined;
  if (options.fix) {
    if (snapshot.control.status === 'online') throw new DoctorDaemonRunningError();
    fixResult = await quarantineCorruptOperationalHealth(storeDir, { clock: options.clock });
    snapshot = await collectDiagnostics(config, storeDir, options);
  }
  const log = options.log ?? ((line: string) => console.log(line));
  if (options.json) {
    log(JSON.stringify({ diagnostics: snapshot, ...(fixResult ? { fix: fixResult } : {}) }, null, 2));
    return;
  }
  for (const line of formatDoctorLines(snapshot, fixResult)) log(line);
}
