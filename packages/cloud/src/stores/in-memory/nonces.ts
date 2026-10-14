import { assertCollectExpiredInput, type CollectExpiredInput, type CollectExpiredResult } from '@byok-sdk/core';
/**
 * In-memory {@link NonceStore}: single-use challenge nonces, ~5min TTL
 * (docs/protocol.md §6.2).
 *
 * A nonce is bound to the (tenant, device) it was issued for, so a nonce
 * issued to one tenant's device is not validatable by another's even if the
 * value leaks.
 */
import { tenantKey, type Clock, type TenantId } from '@byok-sdk/core';
import type { CloudCrypto } from '../../crypto/port';
import type { NonceStore } from '../ports';

/** ~5min, matching the reference server (docs/protocol.md §6.2). */
export const NONCE_TTL_MS = 5 * 60 * 1000;

const NONCE_BYTES = 24;

interface NonceRecord {
  readonly owner: string;
  readonly expiresAtMs: number;
  used: boolean;
}

export class InMemoryNonceStore implements NonceStore {
  readonly #nonces = new Map<string, NonceRecord>();
  readonly #clock: Clock;
  readonly #crypto: CloudCrypto;
  readonly #ttlMs: number;

  constructor(clock: Clock, crypto: CloudCrypto, ttlMs: number = NONCE_TTL_MS) {
    this.#clock = clock;
    this.#crypto = crypto;
    this.#ttlMs = ttlMs;
  }

  /** Number of records currently held (post-sweep). Test-facing only. */
  get size(): number {
    return this.#nonces.size;
  }

  async issue(tenant: TenantId, deviceId: string): Promise<string> {
    const nowMs = this.#clock.now().getTime();
    const nonce = this.#crypto.randomToken(NONCE_BYTES);
    this.#nonces.set(nonce, {
      owner: tenantKey(tenant, deviceId),
      expiresAtMs: nowMs + this.#ttlMs,
      used: false,
    });
    return nonce;
  }

  async consumeIfValid(tenant: TenantId, deviceId: string, nonce: string): Promise<boolean> {
    const record = this.#nonces.get(nonce);
    if (record === undefined) return false;
    if (record.used) return false;
    if (record.owner !== tenantKey(tenant, deviceId)) return false;
    if (this.#clock.now().getTime() > record.expiresAtMs) return false;
    // An async function runs synchronously until its first await. Keep the
    // predicate and mutation together before returning so concurrent callers
    // cannot both observe this record as unused.
    record.used = true;
    return true;
  }
  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    const prefix = tenantKey(tenant, '');
    let removed = 0, more = false;
    for (const [key, record] of this.#nonces) {
      if (!record.owner.startsWith(prefix) || (!record.used && record.expiresAtMs >= Date.parse(input.now))) continue;
      if (removed === input.limit) { more = true; break; }
      this.#nonces.delete(key); removed++;
    }
    return { removed, expired: 0, releasedBytes: 0n, more };
  }

}
