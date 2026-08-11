/**
 * Truth records: attested metadata with two different write models (§12.3, §12.6.4).
 *
 * | kind            | write model                    | conflict model                          |
 * | --------------- | ------------------------------ | --------------------------------------- |
 * | `task.terminal` | first write per task, immutable | different hash → `terminal_conflict`    |
 * | `profile`       | per-key snapshot                | `expectedRev` CAS                       |
 * | `memory`        | per-key snapshot                | `expectedRev` CAS                       |
 *
 * The store is deliberately dumb about content. It can match, sort, and return
 * by tenant/kind/key/rev/hash, and that is the whole of its authority: no
 * summarizing, no merging, no relevance ranking (§12.3). Merge decisions belong
 * to the device that holds the context, which is why a conflict hands back the
 * current snapshot and stops.
 *
 * The manifest listing returns metadata only — never bodies. Selecting which
 * bodies to fetch is a local decision (§S6.4), so shipping bodies in the list
 * response would both defeat that and make the response unbounded.
 */
import type { ContentHash } from './blob';
import type { TenantId } from './tenant';

export const TRUTH_RECORD_KINDS = ['task.terminal', 'profile', 'memory'] as const;
export type TruthRecordKind = (typeof TRUTH_RECORD_KINDS)[number];

/**
 * Where the record body lives. Small payloads may be inline and still count
 * against tenant usage (§12.7.6); larger ones are an object reference.
 */
export type TruthBodyRef =
  | { readonly kind: 'inline'; readonly body: string }
  | { readonly kind: 'object'; readonly hash: ContentHash };

export interface TruthRecord {
  readonly tenantId: TenantId;
  readonly kind: TruthRecordKind;
  /** For `task.terminal` this is the task id; for snapshots, the host's key. */
  readonly recordKey: string;
  /** `1` for the first write. Terminal records never advance past `1`. */
  readonly rev: number;
  readonly contentHash: ContentHash;
  readonly byteSize: bigint;
  readonly body: TruthBodyRef;
  readonly label?: string;
  /** Idempotency key of the accepted write, for replay detection. */
  readonly requestId?: string;
  readonly writtenAt: string;
}

/** Manifest projection: everything needed to decide *whether* to fetch a body. */
export interface TruthManifestEntry {
  readonly kind: TruthRecordKind;
  readonly recordKey: string;
  readonly rev: number;
  readonly contentHash: ContentHash;
  readonly byteSize: bigint;
  readonly label?: string;
  readonly updatedAt: string;
}

export interface TerminalWriteInput {
  readonly taskId: string;
  readonly contentHash: ContentHash;
  readonly byteSize: bigint;
  readonly body: TruthBodyRef;
  readonly label?: string;
  readonly requestId?: string;
}

export interface SnapshotWriteInput {
  readonly kind: 'profile' | 'memory';
  readonly recordKey: string;
  /** `0` asserts "no record yet". Any other value must equal the stored `rev`. */
  readonly expectedRev: number;
  readonly contentHash: ContentHash;
  readonly byteSize: bigint;
  readonly body: TruthBodyRef;
  readonly label?: string;
  readonly requestId?: string;
}

export interface TruthRecordSelector {
  readonly kind: TruthRecordKind;
  readonly recordKey: string;
}

export interface TruthManifestQuery {
  readonly kind?: TruthRecordKind;
  readonly keyPrefix?: string;
  readonly limit?: number;
}

/**
 * Truth port. Tenant-first, async.
 *
 * Raises: `terminal_conflict` (same task, different hash — carries the record
 * already committed), `truth_revision_conflict` (`expectedRev` missed — carries
 * the current record), `truth_record_not_found`.
 */
export interface TruthStore {
  /**
   * Writes the first terminal record for a task.
   *
   * Replaying the identical hash returns the original record unchanged, so a
   * retry after a lost response is safe. A different hash for the same task is
   * a conflict: the first fact is never overwritten.
   */
  writeTerminal(tenant: TenantId, input: TerminalWriteInput): Promise<TruthRecord>;
  /** Per-key snapshot write under `expectedRev` CAS. The store never merges bodies. */
  writeSnapshot(tenant: TenantId, input: SnapshotWriteInput): Promise<TruthRecord>;
  getRecord(tenant: TenantId, selector: TruthRecordSelector): Promise<TruthRecord | undefined>;
  /** Metadata only — key/rev/hash/size/label, no bodies. */
  listManifest(
    tenant: TenantId,
    query: TruthManifestQuery,
  ): Promise<readonly TruthManifestEntry[]>;
}
