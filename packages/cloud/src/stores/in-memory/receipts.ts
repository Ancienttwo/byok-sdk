/**
 * In-memory {@link RequestReceiptStore}: first write wins.
 *
 * The terminal a device reports is a fact, and a retry of the same terminal
 * (the wire is at-least-once) must not overwrite the first one — `created:
 * false` is how the caller learns it was a replay rather than a new fact.
 */
import { tenantKey, type Clock, type TenantId } from '@byok-sdk/core';
import type { RequestReceipt, RequestReceiptStore } from '../ports';

export class InMemoryRequestReceiptStore implements RequestReceiptStore {
  readonly #receipts = new Map<string, RequestReceipt>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
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
}
