/**
 * In-memory {@link QuotaStore} reference (§12.7.6-12.7.7).
 *
 * The invariant this file exists to hold is
 * `committed + reserved + expected <= hardLimitBytes`, checked inside
 * {@link InMemoryQuotaStore.reserve} before any bytes are handed out. A
 * Postgres composition does the same check inside a row-locked transaction;
 * both must reject the same set of concurrent reservations, which is what the
 * conformance suite asserts.
 *
 * Per-tenant hash deduplication lives here rather than in the object manifest
 * because usage accounting is what deduplication is *for* (§12.7.6: same
 * tenant, same hash, counted once). In SQL this set is a join against
 * `object_manifest`; here it is an explicit set, and the observable behavior is
 * identical: finalizing an already-committed hash releases the reservation and
 * adds nothing.
 */
import { ByokCoreError, CoreConflictError } from '../errors';
import type {
  MailboxUsageDeltaInput,
  StorageFinalizeInput,
  StorageFinalizeResult,
  StorageReservation,
  StorageReservationInput,
  StorageStatus,
  StorageWritePosture,
  QuotaStore,
  TenantStorageEntitlement,
  TenantStorageEntitlementInput,
  TenantStorageUsage,
} from '../quota';
import type { Clock } from '../stores';
import { tenantKey, type TenantId } from '../tenant';

/** Warning threshold from §12.7.8: 80% of the hard limit. */
const WARNING_NUMERATOR = 80n;
const WARNING_DENOMINATOR = 100n;

interface ReservationRecord {
  reservation: StorageReservation;
  deduplicated: boolean;
}

export class InMemoryQuotaStore implements QuotaStore {
  readonly #entitlements = new Map<string, TenantStorageEntitlement>();
  readonly #usage = new Map<string, TenantStorageUsage>();
  readonly #reservations = new Map<string, ReservationRecord>();
  readonly #committedHashes = new Map<string, Set<string>>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async readEntitlement(tenant: TenantId): Promise<TenantStorageEntitlement | undefined> {
    return this.#entitlements.get(tenant);
  }

  async writeEntitlement(
    tenant: TenantId,
    input: TenantStorageEntitlementInput,
  ): Promise<TenantStorageEntitlement> {
    const existing = this.#entitlements.get(tenant);
    if (existing !== undefined && input.version <= existing.version) {
      throw new CoreConflictError(
        'storage_entitlement_version_conflict',
        `Entitlement is at version ${String(existing.version)}; refusing to apply version ${String(input.version)}.`,
        existing,
        this.#now(),
      );
    }
    const entitlement: TenantStorageEntitlement = {
      tenantId: tenant,
      version: input.version,
      hardLimitBytes: input.hardLimitBytes,
      maxObjectBytes: input.maxObjectBytes,
      maxInlineBytes: input.maxInlineBytes,
      mailboxLimitBytes: input.mailboxLimitBytes,
      retentionPolicyId: input.retentionPolicyId,
      ...(input.downgradeGraceUntil === undefined
        ? {}
        : { downgradeGraceUntil: input.downgradeGraceUntil }),
    };
    this.#entitlements.set(tenant, entitlement);
    return entitlement;
  }

  async readUsage(tenant: TenantId): Promise<TenantStorageUsage> {
    return this.#usageOf(tenant);
  }

  async readStatus(tenant: TenantId): Promise<StorageStatus> {
    const entitlement = this.#requireEntitlement(tenant);
    const usage = this.#usageOf(tenant);
    const used = this.#usedBytes(usage);
    const graceActive =
      entitlement.downgradeGraceUntil !== undefined &&
      this.#now() < entitlement.downgradeGraceUntil;
    return {
      entitlement,
      usage,
      posture: this.#posture(entitlement, usage, graceActive),
      availableBytes:
        used >= entitlement.hardLimitBytes ? 0n : entitlement.hardLimitBytes - used,
      graceActive,
    };
  }

  async reserve(
    tenant: TenantId,
    input: StorageReservationInput,
  ): Promise<StorageReservation> {
    const entitlement = this.#requireEntitlement(tenant);
    const key = tenantKey(tenant, input.reservationId);
    const existing = this.#reservations.get(key);
    if (existing !== undefined) {
      if (existing.reservation.state === 'reserved') return existing.reservation;
      throw new ByokCoreError(
        'storage_reservation_expired',
        `Reservation ${input.reservationId} is already ${existing.reservation.state}.`,
      );
    }

    const usage = this.#usageOf(tenant);
    const graceActive =
      entitlement.downgradeGraceUntil !== undefined &&
      this.#now() < entitlement.downgradeGraceUntil;
    if (this.#posture(entitlement, usage, graceActive) === 'suspended') {
      throw new ByokCoreError(
        'storage_write_suspended',
        'Tenant is over its hard limit and its downgrade grace has ended; durable writes are suspended.',
      );
    }

    const perObjectLimit =
      input.kind === 'object' ? entitlement.maxObjectBytes : entitlement.maxInlineBytes;
    if (input.expectedBytes > perObjectLimit) {
      throw new ByokCoreError(
        'storage_object_too_large',
        `${String(input.expectedBytes)} bytes exceeds the ${input.kind} limit of ${String(perObjectLimit)} bytes.`,
      );
    }
    if (this.#usedBytes(usage) + input.expectedBytes > entitlement.hardLimitBytes) {
      throw new ByokCoreError(
        'storage_quota_exceeded',
        `Reserving ${String(input.expectedBytes)} bytes would exceed the hard limit of ${String(entitlement.hardLimitBytes)} bytes.`,
      );
    }

    const now = this.#now();
    const reservation: StorageReservation = {
      tenantId: tenant,
      reservationId: input.reservationId,
      state: 'reserved',
      kind: input.kind,
      expectedBytes: input.expectedBytes,
      contentHash: input.contentHash,
      contentType: input.contentType,
      createdAt: now,
      expiresAt: new Date(this.#clock.now().getTime() + input.ttlMs).toISOString(),
    };
    this.#reservations.set(key, { reservation, deduplicated: false });
    this.#setUsage(tenant, { ...usage, reservedBytes: usage.reservedBytes + input.expectedBytes });
    return reservation;
  }

  async finalizeReservation(
    tenant: TenantId,
    input: StorageFinalizeInput,
  ): Promise<StorageFinalizeResult> {
    const key = tenantKey(tenant, input.reservationId);
    const record = this.#requireReservation(tenant, input.reservationId);
    const reservation = record.reservation;

    if (reservation.state === 'committed') {
      return {
        reservation,
        usage: this.#usageOf(tenant),
        deduplicated: record.deduplicated,
      };
    }
    if (reservation.state !== 'reserved') {
      throw new ByokCoreError(
        'storage_reservation_expired',
        `Reservation ${input.reservationId} is ${reservation.state}.`,
      );
    }
    if (this.#now() >= reservation.expiresAt) {
      this.#settle(tenant, key, record, 'expired');
      throw new ByokCoreError(
        'storage_reservation_expired',
        `Reservation ${input.reservationId} expired at ${reservation.expiresAt}.`,
      );
    }
    if (
      input.observedContentHash !== reservation.contentHash ||
      input.observedByteSize !== reservation.expectedBytes ||
      input.observedContentType !== reservation.contentType
    ) {
      // §12.7.7 step 6: a failed finalize releases the bytes; the uploaded
      // object becomes an orphan candidate for the GC worker.
      this.#settle(tenant, key, record, 'aborted');
      throw new ByokCoreError(
        'storage_integrity_mismatch',
        `Observed object does not match reservation ${input.reservationId}.`,
      );
    }

    const hashes = this.#hashesOf(tenant);
    // Same tenant, same hash, counted once (§12.7.6). `#settle` has already
    // released the reserved bytes, so a deduplicated finalize adds nothing.
    const deduplicated = hashes.has(input.observedContentHash);
    const settled = this.#settle(tenant, key, record, 'committed', deduplicated);

    if (!deduplicated) {
      hashes.add(input.observedContentHash);
      const current = this.#usageOf(tenant);
      this.#setUsage(tenant, {
        ...current,
        committedObjectBytes:
          reservation.kind === 'object'
            ? current.committedObjectBytes + reservation.expectedBytes
            : current.committedObjectBytes,
        committedInlineBytes:
          reservation.kind === 'inline'
            ? current.committedInlineBytes + reservation.expectedBytes
            : current.committedInlineBytes,
        objectCount:
          reservation.kind === 'object' ? current.objectCount + 1n : current.objectCount,
      });
    }

    return { reservation: settled, usage: this.#usageOf(tenant), deduplicated };
  }

  async abortReservation(
    tenant: TenantId,
    reservationId: string,
  ): Promise<StorageReservation> {
    const key = tenantKey(tenant, reservationId);
    const record = this.#requireReservation(tenant, reservationId);
    if (record.reservation.state !== 'reserved') return record.reservation;
    return this.#settle(tenant, key, record, 'aborted');
  }

  async expireReservations(tenant: TenantId): Promise<readonly StorageReservation[]> {
    const prefix = tenantKey(tenant, '');
    const now = this.#now();
    const expired: StorageReservation[] = [];
    for (const [key, record] of [...this.#reservations.entries()]) {
      if (!key.startsWith(prefix)) continue;
      if (record.reservation.state !== 'reserved') continue;
      if (now < record.reservation.expiresAt) continue;
      expired.push(this.#settle(tenant, key, record, 'expired'));
    }
    return expired;
  }

  async applyMailboxDelta(
    tenant: TenantId,
    input: MailboxUsageDeltaInput,
  ): Promise<TenantStorageUsage> {
    const entitlement = this.#requireEntitlement(tenant);
    const usage = this.#usageOf(tenant);
    const next = usage.mailboxBytes + input.deltaBytes;
    if (input.deltaBytes > 0n && next > entitlement.mailboxLimitBytes) {
      throw new ByokCoreError(
        'storage_quota_exceeded',
        `Mailbox would reach ${String(next)} bytes, over the limit of ${String(entitlement.mailboxLimitBytes)} bytes.`,
      );
    }
    this.#setUsage(tenant, { ...usage, mailboxBytes: next < 0n ? 0n : next });
    return this.#usageOf(tenant);
  }

  #settle(
    tenant: TenantId,
    key: string,
    record: ReservationRecord,
    state: Exclude<StorageReservation['state'], 'reserved'>,
    deduplicated = false,
  ): StorageReservation {
    const settled: StorageReservation = {
      ...record.reservation,
      state,
      settledAt: this.#now(),
    };
    this.#reservations.set(key, { reservation: settled, deduplicated });
    const usage = this.#usageOf(tenant);
    const released = usage.reservedBytes - record.reservation.expectedBytes;
    this.#setUsage(tenant, { ...usage, reservedBytes: released < 0n ? 0n : released });
    return settled;
  }

  #posture(
    entitlement: TenantStorageEntitlement,
    usage: TenantStorageUsage,
    graceActive: boolean,
  ): StorageWritePosture {
    const used = this.#usedBytes(usage);
    if (used >= entitlement.hardLimitBytes) {
      // A tenant that was downgraded gets its configured grace window; once it
      // ends and usage is still over the limit, the tenant is read-only (423)
      // rather than merely unable to add bytes (507).
      const graceConfigured = entitlement.downgradeGraceUntil !== undefined;
      return graceConfigured && !graceActive ? 'suspended' : 'blocked';
    }
    if (
      entitlement.hardLimitBytes > 0n &&
      used * WARNING_DENOMINATOR >= entitlement.hardLimitBytes * WARNING_NUMERATOR
    ) {
      return 'warning';
    }
    return 'normal';
  }

  #usedBytes(usage: TenantStorageUsage): bigint {
    return usage.committedObjectBytes + usage.committedInlineBytes + usage.reservedBytes;
  }

  #usageOf(tenant: TenantId): TenantStorageUsage {
    const existing = this.#usage.get(tenant);
    if (existing !== undefined) return existing;
    const empty: TenantStorageUsage = {
      committedObjectBytes: 0n,
      committedInlineBytes: 0n,
      reservedBytes: 0n,
      mailboxBytes: 0n,
      objectCount: 0n,
      updatedAt: this.#now(),
    };
    this.#usage.set(tenant, empty);
    return empty;
  }

  #setUsage(tenant: TenantId, usage: TenantStorageUsage): void {
    this.#usage.set(tenant, { ...usage, updatedAt: this.#now() });
  }

  #hashesOf(tenant: TenantId): Set<string> {
    const existing = this.#committedHashes.get(tenant);
    if (existing !== undefined) return existing;
    const created = new Set<string>();
    this.#committedHashes.set(tenant, created);
    return created;
  }

  #requireEntitlement(tenant: TenantId): TenantStorageEntitlement {
    const entitlement = this.#entitlements.get(tenant);
    if (entitlement === undefined) {
      throw new ByokCoreError(
        'storage_entitlement_missing',
        'No storage entitlement has been issued for this tenant.',
      );
    }
    return entitlement;
  }

  #requireReservation(tenant: TenantId, reservationId: string): ReservationRecord {
    const record = this.#reservations.get(tenantKey(tenant, reservationId));
    if (record === undefined) {
      throw new ByokCoreError(
        'storage_reservation_not_found',
        `Reservation ${reservationId} does not exist in this tenant.`,
      );
    }
    return record;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
