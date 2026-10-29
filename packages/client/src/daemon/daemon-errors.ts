import { PROTOCOL_VERSION } from '@byok-sdk/protocol';

/**
 * A `DaemonConfig` field that no longer exists was supplied. Construction
 * refuses it rather than ignoring it, so a host upgrading across a removal
 * learns at startup which seam is gone instead of silently losing behavior.
 */
export class DaemonConfigFieldRemovedError extends Error {
  readonly code = 'daemon_config_field_removed' as const;

  constructor(
    /** The removed path, e.g. `resultDocument` or `agentEgress.sanitizer`. */
    readonly field: string,
    message: string,
    /** Repo-relative `.md#anchor` of the migration note (#1094). */
    readonly migration: string,
  ) {
    super(message);
    this.name = 'DaemonConfigFieldRemovedError';
  }
}

/**
 * `resolveHostLayout` got an input it cannot build a layout from: a product
 * identifier that is not one portable path segment, a home directory that is
 * not absolute, or a platform without a layout. Fix the named `field` and
 * call it again; the call has no side effects.
 */
export class HostLayoutInputError extends Error {
  readonly code = 'host_layout_input_invalid' as const;

  constructor(
    /** The `HostLayoutOptions` field: `productId`, `productName`, `homeDir` or `platform`. */
    readonly field: 'productId' | 'productName' | 'homeDir' | 'platform',
    message: string,
  ) {
    super(message);
    this.name = 'HostLayoutInputError';
  }
}

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
