import type { RuntimeDetectResult } from '../types';
import type { ControlStatusResult } from '../daemon/control-protocol';
import type { OperationalHealthFileInspection } from '../daemon/operational-health';

export type DiagnosticStatus = 'pass' | 'warn' | 'fail';

export interface DiagnosticCheck {
  id: 'config' | 'device' | 'runtimes' | 'control' | 'health' | 'journal' | 'workspace' | 'quarantine';
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
  runtimes: Array<{
    idHash: string;
    present: boolean;
    outcome: RuntimeDetectResult['kind'];
    versionPresent: boolean;
    authPresent?: boolean;
    steer: boolean;
    resume: boolean;
    permissionModeCount: number;
  }>;
  control:
    | { status: 'offline'; reason: string }
    | {
        status: 'online';
        pid: number;
        uptimeMs: number;
        transport: string;
        activeTaskCount: number;
        pendingApprovalCount: number;
        operationalHealth: ControlStatusResult['operationalHealth'];
        storage?: ControlStatusResult['storage'];
      };
  health: OperationalHealthFileInspection;
  journal: {
    status: 'missing' | 'present' | 'corrupt' | 'unavailable';
    sizeBytes?: number;
    walBytes?: number;
    integrity?: 'ok' | 'not-checked';
    reason?: string;
  };
  workspace: { status: 'available' | 'missing' | 'unavailable'; writable?: boolean; reason?: string };
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
