/**
 * Postgres {@link NonceStore}: single-use challenge nonces bound to the
 * (tenant, device) they were issued for, expiring after `NONCE_TTL_MS`
 * (docs/protocol.md §6.2).
 *
 * Expiry is compared against the INJECTED clock, never the database's `now()`.
 * A store that asked the server for the time would be unassertable under a test
 * clock, and the conformance suite's TTL dimension would have to sleep — which
 * is how a replay-window regression ships unnoticed.
 *
 * `issue` sweeps this device's spent and expired rows inline, same posture as
 * the in-memory reference and the reference server: a long-lived deployment
 * never calls a sweep on a timer, and the sweep is bounded to one (tenant,
 * device) so it stays proportional to the caller that triggered it.
 */
import { NONCE_TTL_MS, type NonceStore } from '@byok/cloud';
import type { Clock, TenantId } from '@byok/core';
import type { CloudCrypto } from '@byok/cloud';
import type { Pool } from 'pg';

const NONCE_BYTES = 24;

export class PostgresNonceStore implements NonceStore {
  readonly #pool: Pool;
  readonly #clock: Clock;
  readonly #crypto: CloudCrypto;
  readonly #ttlMs: number;

  constructor(pool: Pool, clock: Clock, crypto: CloudCrypto, ttlMs: number = NONCE_TTL_MS) {
    this.#pool = pool;
    this.#clock = clock;
    this.#crypto = crypto;
    this.#ttlMs = ttlMs;
  }

  async issue(tenant: TenantId, deviceId: string): Promise<string> {
    const nowMs = this.#clock.now().getTime();
    const now = new Date(nowMs).toISOString();

    await this.#pool.query(
      'DELETE FROM auth_nonce WHERE tenant_id = $1 AND device_id = $2 AND (used OR expires_at < $3)',
      [tenant, deviceId, now],
    );

    const nonce = this.#crypto.randomToken(NONCE_BYTES);
    await this.#pool.query(
      `INSERT INTO auth_nonce (tenant_id, device_id, nonce, expires_at, used)
       VALUES ($1, $2, $3, $4, false)`,
      [tenant, deviceId, nonce, new Date(nowMs + this.#ttlMs).toISOString()],
    );
    return nonce;
  }

  async validate(tenant: TenantId, deviceId: string, nonce: string): Promise<boolean> {
    // Never mutates: the gate calls `markUsed` only after every other check on
    // the request has passed, so validation and consumption are separate steps.
    const result = await this.#pool.query(
      `SELECT 1 FROM auth_nonce
        WHERE tenant_id = $1 AND device_id = $2 AND nonce = $3
          AND used = false AND expires_at >= $4`,
      [tenant, deviceId, nonce, this.#clock.now().toISOString()],
    );
    return result.rowCount === 1;
  }

  async markUsed(tenant: TenantId, nonce: string): Promise<void> {
    // Tenant-first even though the signature carries no device: a nonce
    // belonging to another tenant is not addressable here, so a cross-tenant
    // consume cannot burn the real owner's nonce.
    await this.#pool.query('UPDATE auth_nonce SET used = true WHERE tenant_id = $1 AND nonce = $2', [
      tenant,
      nonce,
    ]);
  }
}
