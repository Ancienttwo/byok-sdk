import { ByokCoreError } from '../errors';
import type { Clock } from '../stores';
import type { ContentHash } from '../blob';
import type { StorageReservation, TenantStorageUsage } from '../quota';
import type { TenantId } from '../tenant';

export interface ReservationRecord {
  readonly reservation: StorageReservation;
  readonly deduplicated: boolean;
}
/** Shared authority for reservations, object accounting and quota reads. */
export class InMemoryStorageLedger {
  readonly #usage = new Map<TenantId, TenantStorageUsage>();
  readonly #reservations = new Map<string, ReservationRecord>();
  readonly #committed = new Map<TenantId, Map<string, { kind: 'object' | 'inline'; bytes: bigint }>>();
  constructor(private readonly clock: Clock) {}
  readReservation(key: string): ReservationRecord | undefined { return this.#reservations.get(key); }
  writeReservation(key: string, record: ReservationRecord): void { this.#reservations.set(key, record); }
  deleteReservation(key: string): void { this.#reservations.delete(key); }
  reservations(): IterableIterator<[string, ReservationRecord]> { return this.#reservations.entries(); }
  readUsage(tenant: TenantId): TenantStorageUsage {
    let usage = this.#usage.get(tenant);
    if (usage === undefined) {
      usage = { committedObjectBytes: 0n, committedInlineBytes: 0n, reservedBytes: 0n, objectCount: 0n, updatedAt: this.clock.now().toISOString() };
      this.#usage.set(tenant, usage);
    }
    return usage;
  }
  writeUsage(tenant: TenantId, usage: TenantStorageUsage): void { this.#usage.set(tenant, usage); }
  isCounted(tenant: TenantId, hash: string): boolean { return this.#committed.get(tenant)?.has(hash) === true; }
  recordCommitted(tenant: TenantId, reservation: StorageReservation): void {
    let hashes = this.#committed.get(tenant);
    if (hashes === undefined) { hashes = new Map(); this.#committed.set(tenant, hashes); }
    hashes.set(reservation.contentHash, { kind: reservation.kind, bytes: reservation.expectedBytes });
  }
  hasReservedObject(tenant: TenantId, hash: ContentHash): boolean {
    for (const { reservation } of this.#reservations.values()) {
      if (reservation.tenantId === tenant && reservation.kind === 'object'
        && reservation.contentHash === hash && reservation.state === 'reserved') return true;
    }
    return false;
  }
  reservedObjectHashes(tenant: TenantId): readonly string[] {
    return [...this.#reservations.values()].filter(({ reservation }) => reservation.tenantId === tenant && reservation.kind === 'object' && reservation.state === 'reserved').map(({ reservation }) => reservation.contentHash);
  }
  prepareCollectedObjectRelease(tenant: TenantId, hash: ContentHash, byteSize: bigint, now: string): { readonly releasedBytes: bigint; readonly commit: () => void } {
    const hashes = this.#committed.get(tenant);
    const accounted = hashes?.get(hash);
    // Direct metadata commits and rows retained across a SQLite restart have
    // no charge in this process-local authority.
    if (accounted === undefined || accounted.kind === 'inline') return { releasedBytes: 0n, commit: () => {} };
    const usage = this.#usage.get(tenant);
    if (usage === undefined || accounted.bytes !== byteSize || usage.committedObjectBytes < accounted.bytes || usage.objectCount < 1n) {
      throw new ByokCoreError('storage_integrity_mismatch', 'Collected object accounting does not match the storage ledger.');
    }
    return { releasedBytes: accounted.bytes, commit: () => {
      hashes!.delete(hash);
      this.writeUsage(tenant, { ...usage, committedObjectBytes: usage.committedObjectBytes - accounted.bytes, objectCount: usage.objectCount - 1n, updatedAt: now });
    } };
  }
  releaseCollectedObject(tenant: TenantId, hash: ContentHash, byteSize: bigint, now: string): bigint {
    const release = this.prepareCollectedObjectRelease(tenant, hash, byteSize, now);
    release.commit();
    return release.releasedBytes;
  }
}
