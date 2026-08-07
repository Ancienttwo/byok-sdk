/**
 * In-memory {@link NonceStore}: single-use challenge nonces, ~5min TTL
 * (docs/protocol.md §6.2).
 *
 * A nonce is bound to the (tenant, device) it was issued for, so a nonce
 * issued to one tenant's device is not validatable by another's even if the
 * value leaks.
 */
import { tenantKey, type Clock, type TenantId } from '@byok/core';
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
    // A long-lived deployment never calls a sweep on a timer, so issue sweeps
    // inline — same posture as the reference server's `NonceStore`.
    for (const [nonce, record] of this.#nonces) {
      if (record.used || record.expiresAtMs <= nowMs) this.#nonces.delete(nonce);
    }
    const nonce = this.#crypto.randomToken(NONCE_BYTES);
    this.#nonces.set(nonce, {
      owner: tenantKey(tenant, deviceId),
      expiresAtMs: nowMs + this.#ttlMs,
      used: false,
    });
    return nonce;
  }

  async validate(tenant: TenantId, deviceId: string, nonce: string): Promise<boolean> {
    const record = this.#nonces.get(nonce);
    if (record === undefined) return false;
    if (record.used) return false;
    if (record.owner !== tenantKey(tenant, deviceId)) return false;
    return this.#clock.now().getTime() <= record.expiresAtMs;
  }

  async markUsed(tenant: TenantId, nonce: string): Promise<void> {
    const record = this.#nonces.get(nonce);
    if (record === undefined) return;
    if (!record.owner.startsWith(tenantKey(tenant, ''))) return;
    record.used = true;
  }
}
