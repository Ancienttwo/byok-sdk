import { assertCollectExpiredInput, assertCanonicalTimestamp, type CollectExpiredResult } from '@byok-sdk/core';
import { REQUEST_RECEIPT_PREFIXES } from '../../receipt-retention';
import type { ReceiptCollectExpiredInput } from '../ports';
/**
 * In-memory {@link RequestReceiptStore}: first write wins.
 *
 * The terminal a device reports is a fact, and a retry of the same terminal
 * (the wire is at-least-once) must not overwrite the first one — `created:
 * false` is how the caller learns it was a replay rather than a new fact.
 */
import { tenantKey, type Clock, type TenantId } from '@byok-sdk/core';
import type { RequestReceipt, RequestReceiptStore } from '../ports';

const INTERNALS = new WeakMap<InMemoryRequestReceiptStore, { readonly receipts: Map<string, RequestReceipt>; readonly clock: Clock }>();

/**
 * The stored body, read for the Host task archive (#1120). A module function
 * over a private registry, so the port class gains no method.
 */
export function receiptBodyOf(store: InMemoryRequestReceiptStore, tenant: TenantId, key: string): string | undefined {
  return INTERNALS.get(store)!.receipts.get(tenantKey(tenant, key))?.body;
}

/** Replaces a stored body in place, or inserts the receipt when absent. The archive is the caller. */
export function setReceiptBody(store: InMemoryRequestReceiptStore, tenant: TenantId, key: string, body: string): void {
  const { receipts, clock } = INTERNALS.get(store)!;
  const stored = tenantKey(tenant, key);
  const existing = receipts.get(stored);
  receipts.set(stored, existing === undefined
    ? { tenantId: tenant, key, body, recordedAt: clock.now().toISOString() }
    : { ...existing, body });
}

export class InMemoryRequestReceiptStore implements RequestReceiptStore {
  readonly #receipts = new Map<string, RequestReceipt>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
    INTERNALS.set(this, { receipts: this.#receipts, clock });
  }

  async record(
    tenant: TenantId,
    input: { key: string; body: string },
  ): Promise<{ receipt: RequestReceipt; created: boolean }> {
    const key = tenantKey(tenant, input.key);
    const existing = this.#receipts.get(key);
    if (existing !== undefined) return { receipt: existing, created: false };
    const receipt: RequestReceipt = {
      tenantId: tenant,
      key: input.key,
      body: input.body,
      recordedAt: this.#clock.now().toISOString(),
    };
    this.#receipts.set(key, receipt);
    return { receipt, created: true };
  }

  async get(tenant: TenantId, key: string): Promise<RequestReceipt | undefined> {
    return this.#receipts.get(tenantKey(tenant, key));
  }
  async collectExpired(tenant: TenantId, input: ReceiptCollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    assertCanonicalTimestamp(input.requestBefore, 'requestBefore');
    let removed = 0, more = false;
    for (const [key, receipt] of this.#receipts) {
      if (receipt.tenantId !== tenant || receipt.recordedAt >= input.requestBefore
        || !REQUEST_RECEIPT_PREFIXES.some(prefix => receipt.key.startsWith(prefix))) continue;
      if (removed === input.limit) { more = true; break; }
      this.#receipts.delete(key); removed++;
    }
    return { removed, expired: 0, releasedBytes: 0n, more };
  }

}
