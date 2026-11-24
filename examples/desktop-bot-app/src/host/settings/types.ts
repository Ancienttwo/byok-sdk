import type { DaemonLifecycle, DiagnosticCheck, DiagnosticStatus, DiagnosticsSnapshot, RuntimeObservation } from '@byok-sdk/client';

/** Pure-type runtime status projection for desktop settings views and the bridge contract. */
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

/** The global dreaming switch and the `models` list K8's `dreaming` option takes (#1499 D6: on by default). */
export interface DreamingSetting {
  readonly enabled: boolean;
  /** Host model template names, preferred first. */
  readonly models: readonly string[];
}

export interface HostSettings { readonly dreaming: DreamingSetting }
