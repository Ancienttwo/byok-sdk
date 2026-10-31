import { isTenantId } from '@byok-sdk/core';
import type { DaemonConfig } from '../daemon/create-daemon';
import type { RuntimeAdapter } from '../types';
import { DeviceStore } from '../daemon/store';
import { createDeviceCredentialStore } from '../daemon/device-credential-provider';
import { acquireDaemonOwner, DaemonOwnerActiveError } from '../util/daemon-owner';
import { connectControlClient } from '../daemon/control-client';
import { CursorStore } from '../daemon/cursor-store';
import { collectDiagnostics } from './diagnostics';
import type { DiagnosticsSnapshot } from './types';

export type { DiagnosticsSnapshot, DiagnosticCheck, DiagnosticStatus } from './types';

export interface DiagnoseDeviceOptions {
  /** The same adapters used by an embedded host; omitted uses bundled adapters. */
  adapters?: RuntimeAdapter[];
  runtimeProbeTimeoutMs?: number;
}

/** Read-only device observation; does not read OS credentials or prove Agent readiness. */
export function diagnoseDevice(config: DaemonConfig, options: DiagnoseDeviceOptions = {}): Promise<DiagnosticsSnapshot> {
  // Do not forward private collector DI seams supplied by untyped callers.
  return collectDiagnostics(config, DeviceStore.resolveDir(config.productId, config.storeDir), {
    adapters: options.adapters,
    runtimeProbeTimeoutMs: options.runtimeProbeTimeoutMs,
  });
}

export interface RepairDeviceEnrollmentMetadataInput {
  confirmed: true;
  /** Obtain both from the host's authorized enrollment target, never from a guessed default. */
  expectedDeviceId: string;
  expectedTenantId: string;
}

export interface DeviceMetadataRepairResult {
  action: 'restore-enrollment-metadata';
  scope: 'device';
  /** Metadata readback only; does not imply renewed credentials or a running daemon. */
  status: 'repaired' | 'not-needed';
}

const MESSAGES = {
  'confirmation-required': 'Explicit confirmation is required for enrollment metadata repair.',
  'invalid-target': 'An explicit expected tenant and device are required.',
  'daemon-running': 'Stop the daemon before enrollment metadata repair.',
  'store-busy': 'The store is owned by another operation; enrollment metadata repair refused.',
  'authority-unavailable': 'The OS enrollment authority could not be read.',
  'authority-missing': 'No complete OS enrollment exists; use explicit authenticated pairing.',
  'target-mismatch': 'The OS enrollment does not match the expected tenant and device.',
  'projection-unavailable': 'The enrollment metadata could not be read safely; repair refused.',
  'repair-failed': 'Enrollment metadata repair did not complete; inspect the state before retrying.',
} as const;

export type DeviceMetadataRepairErrorCode = keyof typeof MESSAGES;

/** Closed diagnostics only: no OS stderr, local paths, authority bytes or nested cause. */
export class DeviceMetadataRepairError extends Error {
  constructor(readonly code: DeviceMetadataRepairErrorCode) {
    super(MESSAGES[code]);
    this.name = 'DeviceMetadataRepairError';
  }
}

/**
 * Explicitly restore missing/valid-stale device.json from its existing OS authority.
 * Does not instantiate AuthManager, renew credentials, pair, or start a runtime.
 * Ordinary doctor remains credential-blind; only this confirmed action opens the OS store.
 */
export async function repairDeviceEnrollmentMetadata(
  config: DaemonConfig,
  input: RepairDeviceEnrollmentMetadataInput,
): Promise<DeviceMetadataRepairResult> {
  if (input?.confirmed !== true) throw new DeviceMetadataRepairError('confirmation-required');
  if (typeof input.expectedDeviceId !== 'string' || input.expectedDeviceId.trim().length === 0 ||
      !isTenantId(input.expectedTenantId)) {
    throw new DeviceMetadataRepairError('invalid-target');
  }
  const { expectedDeviceId, expectedTenantId } = input;
  const productId = config.productId;
  let failureCode: DeviceMetadataRepairErrorCode = 'repair-failed';
  try {
    const storeDir = DeviceStore.resolveDir(productId, config.storeDir);
    const control = await connectControlClient({ storeDir, productId });
    if (control.ok) {
      control.client.close();
      throw new DeviceMetadataRepairError('daemon-running');
    }
    // Offline is only an observation. The same owner lease used by start/pair
    // is the mutation gate, including when control is unreachable on a live daemon.
    const owner = await acquireDaemonOwner(storeDir, 'doctor');
    try {
      const store = new DeviceStore(storeDir, createDeviceCredentialStore({ productId, storeDir, deviceCredentials: config.deviceCredentials }));
      failureCode = 'projection-unavailable';
      await store.load();
      failureCode = 'authority-unavailable';
      const authority = await store.credentials.read();
      if (authority === undefined) throw new DeviceMetadataRepairError('authority-missing');
      if (authority.deviceId !== expectedDeviceId || authority.tenantId !== expectedTenantId) {
        throw new DeviceMetadataRepairError('target-mismatch');
      }
      failureCode = 'repair-failed';
      const changed = await store.reconcileMetadata(authority);
      const readback = await store.load();
      if (readback === undefined || readback.deviceId !== authority.deviceId ||
          readback.tenantId !== authority.tenantId || readback.devicePublicKey !== authority.devicePublicKey) {
        throw new DeviceMetadataRepairError('repair-failed');
      }
      return { action: 'restore-enrollment-metadata', scope: 'device', status: changed ? 'repaired' : 'not-needed' };
    } catch (error) {
      if (error instanceof DeviceMetadataRepairError) throw error;
      throw new DeviceMetadataRepairError(failureCode);
    } finally {
      // Even cleanup errors must not expose arbitrary OS/path diagnostics.
      failureCode = 'repair-failed';
      await owner.release();
    }
  } catch (error) {
    if (error instanceof DeviceMetadataRepairError) throw error;
    if (error instanceof DaemonOwnerActiveError) throw new DeviceMetadataRepairError('store-busy');
    throw new DeviceMetadataRepairError(failureCode);
  }
}

export interface ResetDeviceCursorInput {
  confirmed: true;
}

export interface DeviceCursorResetResult {
  action: 'reset-cursor';
  scope: 'device';
  /** The cursor file now holds 0; nothing was replayed yet. */
  status: 'reset';
}

const CURSOR_RESET_MESSAGES = {
  'confirmation-required': 'Explicit confirmation is required to reset the delivery cursor.',
  'daemon-running': 'Stop the daemon before resetting the delivery cursor.',
  'store-busy': 'The store is owned by another operation; cursor reset refused.',
  'unpaired': 'No readable device record exists; pair this device instead of resetting its cursor.',
  'reset-failed': 'The delivery cursor could not be reset; inspect the store before retrying.',
} as const;

export type DeviceCursorResetErrorCode = keyof typeof CURSOR_RESET_MESSAGES;

/** Closed diagnostics only, like {@link DeviceMetadataRepairError}. */
export class DeviceCursorResetError extends Error {
  constructor(readonly code: DeviceCursorResetErrorCode) {
    super(CURSOR_RESET_MESSAGES[code]);
    this.name = 'DeviceCursorResetError';
  }
}

/**
 * #1121: the operator recovery for the `cursor_unreadable` halt. Rewrites the
 * paired device's delivery cursor as 0, so the next start asks the server to
 * replay everything it still retains for this device. Replay is safe: a
 * redelivered offer this device journaled is matched by its id, and the
 * server suppresses offers whose task already ended. If the server no longer
 * retains seq 1, the next start halts `replay_cursor_too_old` as for any
 * expired cursor. Refused while the daemon runs; takes the store's owner lease.
 */
export async function resetDeviceCursor(config: DaemonConfig, input: ResetDeviceCursorInput): Promise<DeviceCursorResetResult> {
  if (input?.confirmed !== true) throw new DeviceCursorResetError('confirmation-required');
  const productId = config.productId;
  try {
    const storeDir = DeviceStore.resolveDir(productId, config.storeDir);
    const control = await connectControlClient({ storeDir, productId });
    if (control.ok) {
      control.client.close();
      throw new DeviceCursorResetError('daemon-running');
    }
    const owner = await acquireDaemonOwner(storeDir, 'doctor');
    try {
      const store = new DeviceStore(storeDir, createDeviceCredentialStore({ productId, storeDir, deviceCredentials: config.deviceCredentials }));
      const record = await store.load().catch(() => undefined);
      if (record === undefined) throw new DeviceCursorResetError('unpaired');
      const cursors = new CursorStore(storeDir);
      await cursors.save(config.serverUrl, record.deviceId, 0);
      if (await cursors.load(config.serverUrl, record.deviceId) !== 0) throw new DeviceCursorResetError('reset-failed');
      return { action: 'reset-cursor', scope: 'device', status: 'reset' };
    } finally {
      await owner.release();
    }
  } catch (error) {
    if (error instanceof DeviceCursorResetError) throw error;
    if (error instanceof DaemonOwnerActiveError) throw new DeviceCursorResetError('store-busy');
    throw new DeviceCursorResetError('reset-failed');
  }
}
