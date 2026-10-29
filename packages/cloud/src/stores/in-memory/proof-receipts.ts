import {
  assertCanonicalTimestamp,
  assertCollectExpiredInput,
  tenantKey,
  type Clock,
  type CollectExpiredResult,
  type TenantId,
} from '@byok-sdk/core';
import type {
  ProofRequestReceipt,
  ProofRequestReceiptInput,
  ProofRequestReceiptStore,
} from '../ports';
import type { ProofReceiptCollectExpiredInput, ProofReceiptRetentionAuthority } from '../../maintenance';

const RECEIPTS = new WeakMap<InMemoryProofRequestReceiptStore, Map<string, ProofRequestReceipt>>();

export class InMemoryProofRequestReceiptStore implements ProofRequestReceiptStore {
  readonly #receipts = new Map<string, ProofRequestReceipt>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
    RECEIPTS.set(this, this.#receipts);
  }

  async record(
    tenant: TenantId,
    input: ProofRequestReceiptInput,
  ): Promise<{ readonly receipt: ProofRequestReceipt; readonly created: boolean }> {
    const key = tenantKey(tenant, input.deviceId, input.requestId);
    const existing = this.#receipts.get(key);
    if (existing !== undefined) return { receipt: existing, created: false };
    const receipt: ProofRequestReceipt = {
      tenantId: tenant,
      ...input,
      recordedAt: this.#clock.now().toISOString(),
    };
    this.#receipts.set(key, receipt);
    return { receipt, created: true };
  }

  async get(
    tenant: TenantId,
    deviceId: string,
    requestId: string,
  ): Promise<ProofRequestReceipt | undefined> {
    return this.#receipts.get(tenantKey(tenant, deviceId, requestId));
  }
}

/** Prunes the used request ids that an {@link InMemoryProofRequestReceiptStore} records. */
export class InMemoryProofReceiptRetentionAuthority implements ProofReceiptRetentionAuthority {
  readonly #receipts: Map<string, ProofRequestReceipt>;

  constructor(store: InMemoryProofRequestReceiptStore) {
    const receipts = RECEIPTS.get(store);
    if (receipts === undefined) throw new TypeError('InMemoryProofReceiptRetentionAuthority needs an InMemoryProofRequestReceiptStore.');
    this.#receipts = receipts;
  }

  async collectExpired(tenant: TenantId, input: ProofReceiptCollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    assertCanonicalTimestamp(input.recordedBefore, 'recordedBefore');
    const eligible = [...this.#receipts]
      .filter(([, receipt]) => receipt.tenantId === tenant && receipt.recordedAt < input.recordedBefore)
      .sort(([, left], [, right]) => (left.recordedAt < right.recordedAt ? -1 : left.recordedAt > right.recordedAt ? 1 : 0));
    const batch = eligible.slice(0, input.limit);
    for (const [key] of batch) this.#receipts.delete(key);
    return { removed: batch.length, expired: 0, releasedBytes: 0n, more: eligible.length > batch.length };
  }
}
