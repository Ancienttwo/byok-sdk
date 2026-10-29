import type { RuntimeDetectResult, RuntimeDetectionRefusalReason } from '../types';
import type { ControlStatusResult } from '../daemon/control-protocol';
import type { OperationalHealthFileInspection } from '../daemon/operational-health';
import type { DaemonLifecycle } from '../daemon/daemon-lifecycle';
import type { ServiceEnvironmentRecord } from '../login-shell-environment';

export type DiagnosticStatus = 'pass' | 'warn' | 'fail';

export interface DiagnosticCheck {
  id: 'config' | 'device' | 'runtimes' | 'environment' | 'control' | 'lifecycle' | 'health' | 'journal' | 'quarantine';
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
  checks: DiagnosticCheck[];
}

export type OperationalHealthFixResult =
  | { status: 'not-needed'; reason: 'missing' | 'valid' }
  | { status: 'quarantined'; evidenceName: string; manifestName: string; sha256: string; sizeBytes: number };
