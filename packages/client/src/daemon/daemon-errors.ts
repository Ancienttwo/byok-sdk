import { PAIR_REQUEST_DEVICE_NAME_MAX_LENGTH, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import type { DeviceMetadata } from './device-credential-store.js';

export type DaemonJournalProtocolRecord = 'recovery-offer' | 'pending-terminal';

/**
 * The local journal holds envelope bytes of another wire major. This daemon
 * has no reader for them, so startup stops before it writes, rewrites or
 * deletes any journal row: an operator drains or removes the old journal
 * with the release that wrote it (drain-then-upgrade).
 */
export class DaemonJournalProtocolUnsupportedError extends Error {
  readonly code = 'daemon_journal_protocol_unsupported' as const;

  constructor(
    readonly taskId: string,
    readonly record: DaemonJournalProtocolRecord,
    // The envelope's `v`, as stored (absent when the row has none).
    readonly found: unknown,
    readonly expected: number = PROTOCOL_VERSION,
  ) {
    super(`journal ${record} for task ${taskId} carries wire protocol v=${JSON.stringify(found) ?? 'absent'}, but this daemon reads only v=${expected}; drain the journal with the release that wrote it before upgrading`);
    this.name = 'DaemonJournalProtocolUnsupportedError';
  }
}

/**
 * Classify stored envelope bytes by wire major only. Bytes that are not a
 * JSON object are left to the regular decoder, which reports them as it
 * always did; this check never repairs or reinterprets a row.
 */
export function assertJournalEnvelopeProtocol(bytes: string, taskId: string, record: DaemonJournalProtocolRecord): void {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes); } catch { return; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const found = (parsed as { v?: unknown }).v;
  if (found !== PROTOCOL_VERSION) throw new DaemonJournalProtocolUnsupportedError(taskId, record, found);
}

/**
 * The OS credential entry, keyed by productId alone, holds an enrollment
 * that this storeDir's `device.json` does not name: another storeDir of the
 * same productId paired it, or this store's projection is missing or from a
 * different pairing. Nothing adopts it. Recovery is an explicit operator act:
 * the doctor `restore-enrollment-metadata` action when this store owns the
 * enrollment, or a pair of this store under its own productId (#1094).
 */
export class DeviceStoreBindingMismatchError extends Error {
  readonly code = 'device_store_not_bound' as const;
  /** The enrollment the OS entry holds. Identifiers only, never credential bytes. */
  readonly stored: { readonly deviceId: string; readonly tenantId: string };
  /** The enrollment this storeDir's `device.json` names, if any. */
  readonly bound: { readonly deviceId: string; readonly tenantId: string } | undefined;

  constructor(stored: DeviceMetadata, bound: DeviceMetadata | undefined) {
    const held = `device ${stored.deviceId} (tenant ${stored.tenantId})`;
    super(
      `device_store_not_bound: the OS credential entry for this productId holds ${held}, but this storeDir ` +
        (bound === undefined ? 'did not pair it' : `is bound to device ${bound.deviceId} (tenant ${bound.tenantId})`) +
        `. If this store owns that enrollment, run \`byok-agent doctor --repair restore-enrollment-metadata --expected-device-id ${stored.deviceId} --expected-tenant-id ${stored.tenantId} --yes\`; ` +
        'otherwise pair this store under its own productId',
    );
    this.name = 'DeviceStoreBindingMismatchError';
    this.stored = { deviceId: stored.deviceId, tenantId: stored.tenantId };
    this.bound = bound === undefined ? undefined : { deviceId: bound.deviceId, tenantId: bound.tenantId };
  }
}

/**
 * A pairing refused to reuse a staged pairing attempt another storeDir of
 * this productId staged (#1964, #2033), by the same rule as an enrollment
 * clear. Nothing was written; pairing with `replaceOtherStore`
 * (`--replace-other-store`) discards that attempt.
 */
export class PairingAttemptRefusedError extends Error {
  constructor() {
    super('another storeDir staged the pairing attempt of this productId; nothing was written. Pair with replaceOtherStore (--replace-other-store) to discard it');
    this.name = 'PairingAttemptRefusedError';
  }
}

/**
 * Another pairing of this productId replaced this pairing's attempt while its
 * request was in flight (#2045). This pairing wrote nothing and does not
 * retry; the slot belongs to the pairing that replaced it. Pair again to take
 * it back.
 */
export class PairingSupersededError extends Error {
  constructor() {
    super('another pairing of this productId replaced this pairing while its request was in flight; nothing was written');
    this.name = 'PairingSupersededError';
  }
}

/**
 * The server refused the pairing code: unknown, expired or already used,
 * which it does not tell apart (`pairing_code_invalid`, protocol §6.1).
 * The current enrollment is unchanged. Pair with a new code.
 */
export class PairingCodeRejectedError extends Error {
  constructor() {
    super('the server rejected the pairing code: it is unknown, expired or already used');
    this.name = 'PairingCodeRejectedError';
  }
}

/**
 * The server refused this pairing twice because another pairing of the same
 * machine registered in between (#2045). It happens only while two pairings
 * of one machine run at once. Nothing was written and the staged attempt is
 * kept, so retrying with the same code resumes it.
 */
export class PairingBusyError extends Error {
  readonly retryable = true;
  constructor() {
    super('another pairing of this machine registered at the same time; retry the pairing');
    this.name = 'PairingBusyError';
  }
}

/**
 * A pairing input is out of its wire bound, checked before anything is staged
 * or sent (#2045): `deviceName` is not `isPairingText` within
 * `PAIR_REQUEST_DEVICE_NAME_MAX_LENGTH` UTF-16 code units (set `deviceName`
 * when the hostname is not), or `machineId` is not lowercase hex SHA-256.
 */
export class PairingInputInvalidError extends Error {
  constructor(readonly field: 'deviceName' | 'machineId') {
    super(field === 'deviceName'
      ? `deviceName must be 1 to ${PAIR_REQUEST_DEVICE_NAME_MAX_LENGTH} UTF-16 code units of text without control characters; set deviceName when the hostname is not`
      : 'machineId must be a lowercase hex SHA-256');
    this.name = 'PairingInputInvalidError';
  }
}

/**
 * Why `Daemon.pairEmbedded` refused. Each reason leaves the local
 * enrollment and the server unchanged:
 * - `enrollment_missing`: this store is unpaired but the server already lists devices.
 * - `device_unknown`: this store's device is not in the server's machine list.
 * - `re_pair_required`: the device record has no OS credential entry.
 * - `store_not_bound`: the OS entry holds an enrollment another storeDir paired.
 */
export class EmbeddedPairingError extends Error {
  constructor(
    readonly reason: 'enrollment_missing' | 'device_unknown' | 're_pair_required' | 'store_not_bound',
    options?: { cause?: unknown },
  ) {
    super(`embedded pairing refused: ${reason}`, options);
    this.name = 'EmbeddedPairingError';
  }
}
