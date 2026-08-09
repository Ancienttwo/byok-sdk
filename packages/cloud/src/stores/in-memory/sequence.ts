/**
 * In-memory {@link DeviceSequenceStore}: a monotonic per-(tenant, device)
 * delivery counter starting at 1, matching what a mailbox numbers its first
 * row.
 */
import { tenantKey, type TenantId } from '@byok-sdk/core';
import type { DeviceSequenceStore } from '../ports';

export class InMemoryDeviceSequenceStore implements DeviceSequenceStore {
  readonly #next = new Map<string, number>();

  async next(tenant: TenantId, deviceId: string): Promise<number> {
    const key = tenantKey(tenant, deviceId);
    const seq = this.#next.get(key) ?? 1;
    this.#next.set(key, seq + 1);
    return seq;
  }
}
