/**
 * In-memory {@link InboundDedupStore} (N3).
 *
 * A bounded ring per (tenant, device), not an unbounded set: the wire is
 * at-least-once (§9), so this makes processing at-most-once without letting a
 * chatty device grow memory without limit. Check-and-record is one call, so a
 * composition cannot accidentally split it into a racy read-then-write.
 */
import { tenantKey, type TenantId } from '@byok-sdk/core';
import type { InboundDedupStore } from '../ports';

/** Ids retained per device. Same order of magnitude as the reference server's ring. */
export const DEDUP_RING_CAPACITY = 1024;

export class InMemoryInboundDedupStore implements InboundDedupStore {
  readonly #rings = new Map<string, Set<string>>();
  readonly #capacity: number;

  constructor(capacity: number = DEDUP_RING_CAPACITY) {
    this.#capacity = capacity;
  }

  async checkAndRecord(tenant: TenantId, deviceId: string, envelopeId: string): Promise<boolean> {
    const key = tenantKey(tenant, deviceId);
    let ring = this.#rings.get(key);
    if (ring === undefined) {
      ring = new Set<string>();
      this.#rings.set(key, ring);
    }
    if (ring.has(envelopeId)) return true;
    ring.add(envelopeId);
    if (ring.size > this.#capacity) {
      const oldest = ring.values().next().value;
      if (oldest !== undefined) ring.delete(oldest);
    }
    return false;
  }
}
