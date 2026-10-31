import type { RuntimeDetectResult, RuntimeDetectionRefusalReason, RuntimeVersionVerdict } from '../types';
import type { ControlStatusResult } from '../daemon/control-protocol';
import type { OperationalHealthFileInspection } from '../daemon/operational-health';
import type { DaemonLifecycle } from '../daemon/daemon-lifecycle';
import type { ServiceEnvironmentRecord, ServiceEnvironmentUnavailableCode } from '../login-shell-environment';

export type DiagnosticStatus = 'pass' | 'warn' | 'fail';

export interface DiagnosticCheck {
  id: 'config' | 'device' | 'runtimes' | 'environment' | 'control' | 'lifecycle' | 'clock-skew' | 'health' | 'journal' | 'quarantine';
  status: DiagnosticStatus;
  summary: string;
}

export interface DiagnosticsSnapshot {
  version: 1;
  generatedAt: string;
  product: { nameHash: string; idHash: string };
  system: { node: string; platform: NodeJS.Platform; arch: string; sqliteAvailable: boolean };
  config: {
    serverProtocol: 'http' | 'https' | 'ws' | 'wss' | 'invalid' | 'unsupported';
    customStoreDir: boolean;
    runtimeAllowlistCount?: number;
  };
  device: { status: 'paired' | 'unpaired' | 'unavailable'; deviceIdHash?: string };
  runtimes: Array<{
    idHash: string;
    present: boolean;
    outcome: RuntimeDetectResult['kind'];
    reason?: RuntimeDetectionRefusalReason;
    versionPresent: boolean;
    /** #1103: the effective version policy's verdict. Absent from an older daemon, or a custom adapter with no policy. */
    versionVerdict?: RuntimeVersionVerdict;
    authPresent?: boolean;
    steer: boolean;
    resume: boolean;
  }>;
  runtimeSource: 'daemon' | 'local-shell' | 'unknown';
  environment: ServiceEnvironmentRecord | { status: 'unknown' };
  control:
    | { status: 'offline'; reason: string }
    | {
        status: 'online';
        pid: number;
        uptimeMs: number;
        activeTaskCount: number;
        pendingApprovalCount: number;
        operationalHealth: ControlStatusResult['operationalHealth'];
        outbound?: ControlStatusResult['outbound'];
        storage: ControlStatusResult['storage'];
      };
  /**
   * Issue #394: the running daemon's lifecycle (`live`), else the last
   * `lifecycle` event in `audit.jsonl` (`audit`), else `unknown`.
   */
  lifecycle: { status: 'unknown' } | { status: 'known'; source: 'live' | 'audit'; lifecycle: DaemonLifecycle };
  /**
   * #1114: the device clock against the server's HTTP `Date` header at the
   * running daemon's last pair or renewal. Unknown while the daemon is
   * offline: doctor stays network-free and keeps no state file of its own.
   */
  clockSkew:
    | { status: 'unknown'; reason: 'daemon-offline' | 'not-observed' }
    | { status: 'measured'; deviceAheadMs: number; uncertaintyMs: number; observedAt: string };
  health: OperationalHealthFileInspection;
  journal: {
    status: 'missing' | 'present' | 'corrupt' | 'unavailable';
    sizeBytes?: number;
    walBytes?: number;
    integrity?: 'ok' | 'not-checked';
    failedTerminalCount?: number;
    reason?: string;
  };
  quarantine: {
    status: 'available' | 'missing' | 'unavailable';
    count: number;
    scannedCount: number;
    truncated: boolean;
    entries: Array<{ nameHash: string; sizeBytes: number; modifiedAt: string }>;
    reason?: string;
  };
  /** #1097: the daemon log and the service manager's redirect files under `serviceLogDir(storeDir)`. */
  logs: {
    status: 'present' | 'missing' | 'unavailable';
    totalBytes: number;
    files: Array<{ kind: 'daemon' | 'service-manager'; sizeBytes: number }>;
    truncated: boolean;
  };
  /**
   * #1095: the running daemon's runtime environments as counts. Names stay
   * out of the snapshot and the support bundle: only `doctor` prints them.
   */
  runtimeEnvironment:
    | { status: 'unknown'; reason: 'daemon-offline' | 'request-failed' }
    | {
        status: 'known';
        runtimes: Array<
          | { idHash: string; status: 'built'; names: number; removed: number }
          | { idHash: string; status: 'unavailable'; code: ServiceEnvironmentUnavailableCode }
          | { idHash: string; status: 'failed' }
        >;
      };
  checks: DiagnosticCheck[];
}

export type OperationalHealthFixResult =
  | { status: 'not-needed'; reason: 'missing' | 'valid' }
  | { status: 'quarantined'; evidenceName: string; manifestName: string; sha256: string; sizeBytes: number };
