import { tenantKey, type Clock, type TenantId } from '@byok-sdk/core';
import type {
  ProofRequestReceipt,
  ProofRequestReceiptInput,
  ProofRequestReceiptStore,
} from '../ports';

export class InMemoryProofRequestReceiptStore implements ProofRequestReceiptStore {
  readonly #receipts = new Map<string, ProofRequestReceipt>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
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
