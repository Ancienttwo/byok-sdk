/**
 * In-memory {@link TruthStore} reference (§12.3, §12.6.4).
 *
 * Two write models, one storage shape. The terminal path is first-write-wins
 * with hash-equality replay; the snapshot path is `expectedRev` CAS. Neither
 * ever merges bodies — a conflict hands back the record it lost to and stops,
 * because the device holding the context is the only party that can decide what
 * the merged truth should be.
 */
import { CoreConflictError } from '../errors';
import type { Clock } from '../stores';
import { tenantKey, type TenantId } from '../tenant';
import type {
  SnapshotWriteInput,
  TerminalWriteInput,
  TruthManifestEntry,
  TruthManifestQuery,
  TruthRecord,
  TruthRecordSelector,
  TruthStore,
} from '../truth';

const DEFAULT_MANIFEST_LIMIT = 100;

export class InMemoryTruthStore implements TruthStore {
  readonly #records = new Map<string, TruthRecord>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async writeTerminal(tenant: TenantId, input: TerminalWriteInput): Promise<TruthRecord> {
    const key = tenantKey(tenant, 'task.terminal', input.taskId);
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (existing.contentHash === input.contentHash) {
        // Exact replay of a committed fact: return the original, unchanged.
        return existing;
      }
      throw new CoreConflictError(
        'terminal_conflict',
        `Task ${input.taskId} already has an immutable terminal record with a different hash.`,
        existing,
        this.#now(),
      );
    }
    const record: TruthRecord = {
      tenantId: tenant,
      kind: 'task.terminal',
      recordKey: input.taskId,
      rev: 1,
      contentHash: input.contentHash,
      byteSize: input.byteSize,
      body: input.body,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      writtenAt: this.#now(),
    };
    this.#records.set(key, record);
    return record;
  }

  async writeSnapshot(tenant: TenantId, input: SnapshotWriteInput): Promise<TruthRecord> {
    const key = tenantKey(tenant, input.kind, input.recordKey);
    const existing = this.#records.get(key);
    const currentRev = existing?.rev ?? 0;
    if (input.expectedRev !== currentRev) {
      throw new CoreConflictError<TruthRecord | undefined>(
        'truth_revision_conflict',
        `Record ${input.kind}/${input.recordKey} is at rev ${currentRev}, not ${input.expectedRev}.`,
        existing,
        this.#now(),
      );
    }
    const record: TruthRecord = {
      tenantId: tenant,
      kind: input.kind,
      recordKey: input.recordKey,
      rev: currentRev + 1,
      contentHash: input.contentHash,
      byteSize: input.byteSize,
      body: input.body,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      writtenAt: this.#now(),
    };
    this.#records.set(key, record);
    return record;
  }

  async getRecord(
    tenant: TenantId,
    selector: TruthRecordSelector,
  ): Promise<TruthRecord | undefined> {
    return this.#records.get(tenantKey(tenant, selector.kind, selector.recordKey));
  }

  async listManifest(
    tenant: TenantId,
    query: TruthManifestQuery,
  ): Promise<readonly TruthManifestEntry[]> {
    const prefix = tenantKey(tenant, '');
    const entries: TruthManifestEntry[] = [];
    for (const [key, record] of this.#records.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (query.kind !== undefined && record.kind !== query.kind) continue;
      if (query.keyPrefix !== undefined && !record.recordKey.startsWith(query.keyPrefix)) {
        continue;
      }
      entries.push({
        kind: record.kind,
        recordKey: record.recordKey,
        rev: record.rev,
        contentHash: record.contentHash,
        byteSize: record.byteSize,
        ...(record.label === undefined ? {} : { label: record.label }),
        updatedAt: record.writtenAt,
      });
    }
    entries.sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) || left.recordKey.localeCompare(right.recordKey),
    );
    return entries.slice(0, query.limit ?? DEFAULT_MANIFEST_LIMIT);
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
