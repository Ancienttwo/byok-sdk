import type { RuntimeDetectResult, RuntimeDetectionRefusalReason } from '../types';
import type { ControlStatusResult } from '../daemon/control-protocol';
import type { OperationalHealthFileInspection } from '../daemon/operational-health';
import type { DaemonLifecycle } from '../daemon/daemon-lifecycle';
import type { ServiceEnvironmentStatus } from '../lifecycle/service-environment';

export type DiagnosticStatus = 'pass' | 'warn' | 'fail';

export interface DiagnosticCheck {
  id: 'config' | 'device' | 'runtimes' | 'control' | 'lifecycle' | 'environment' | 'health' | 'journal' | 'workspace' | 'quarantine';
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
    hostedJournal: boolean;
    runtimeAllowlistCount?: number;
  };
  device: { status: 'paired' | 'unpaired' | 'unavailable'; deviceIdHash?: string };
  /**
   * Issue #392: where {@link DiagnosticsSnapshot.runtimes} came from. `daemon`:
   * the running daemon's own startup detection, in its environment.
   * `local-shell`: no daemon answered, so this process probed in ITS
   * environment, which need not be the service's. `unknown`: a daemon from
   * before #392 answered without runtimes (transition only; removed in the
   * next minor), and `runtimes` is empty.
   */
  runtimesSource: 'daemon' | 'local-shell' | 'unknown';
  runtimes: Array<{
    idHash: string;
    present: boolean;
    outcome: RuntimeDetectResult['kind'];
    /** `local-shell` only: the daemon reports no refusal reason. */
    reason?: RuntimeDetectionRefusalReason;
    versionPresent: boolean;
    authPresent?: boolean;
    /** `local-shell` only: adapter capabilities, which the daemon does not report. */
    steer?: boolean;
    resume?: boolean;
  }>;
  control:
    | { status: 'offline'; reason: string }
    | {
        status: 'online';
        pid: number;
        uptimeMs: number;
        activeTaskCount: number;
        pendingApprovalCount: number;
        operationalHealth: ControlStatusResult['operationalHealth'];
        storage?: ControlStatusResult['storage'];
      };
  /**
   * Issue #394: the running daemon's lifecycle (`live`), else the last
   * `lifecycle` event in `audit.jsonl` (`audit`), else `unknown`.
   */
  lifecycle: { status: 'unknown' } | { status: 'known'; source: 'live' | 'audit'; lifecycle: DaemonLifecycle };
  /**
   * Issue #392: where the daemon's environment came from — the running
   * daemon's (`live`), else the last `environment-resolved` event in
   * `audit.jsonl` (`audit`, with its time), else `unknown`. Closed values and
   * a shell basename only.
   */
  environment:
    | { status: 'unknown' }
    | { status: 'known'; source: 'live'; environment: ServiceEnvironmentStatus }
    | { status: 'known'; source: 'audit'; ts: string; environment: ServiceEnvironmentStatus };
  health: OperationalHealthFileInspection;
  journal: {
    status: 'missing' | 'present' | 'corrupt' | 'unavailable';
    sizeBytes?: number;
    walBytes?: number;
    integrity?: 'ok' | 'not-checked';
    reason?: string;
  };
  /** `not-configured`: a strict Agent daemon has no `workspaceRoot`; each Agent offer runs in its SDK-owned home. */
  workspace: { status: 'available' | 'missing' | 'unavailable' | 'not-configured'; writable?: boolean; reason?: string };
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
