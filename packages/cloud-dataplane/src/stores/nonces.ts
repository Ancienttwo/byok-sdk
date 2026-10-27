import { assertCollectExpiredInput, type CollectExpiredInput, type CollectExpiredResult } from '@byok-sdk/core';
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
import { NONCE_TTL_MS, type NonceStore } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { CloudCrypto } from '@byok-sdk/cloud';
import type { Pool } from 'pg';
import type { ByokPool } from '../pool';

const NONCE_BYTES = 24;

export class PostgresNonceStore implements NonceStore {
  readonly #pool: Pool;
  readonly #clock: Clock;
  readonly #crypto: CloudCrypto;
  readonly #ttlMs: number;

  constructor(pool: ByokPool, clock: Clock, crypto: CloudCrypto, ttlMs: number = NONCE_TTL_MS) {
    this.#pool = pool;
    this.#clock = clock;
    this.#crypto = crypto;
    this.#ttlMs = ttlMs;
  }

  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    const result = await this.#pool.query<{removed: string; more: boolean}>(
      `WITH candidates AS MATERIALIZED (
         SELECT ctid FROM auth_nonce WHERE tenant_id = $1 AND (used OR expires_at < $2)
         ORDER BY expires_at LIMIT $3 + 1 FOR UPDATE SKIP LOCKED
       ), deleted AS (
         DELETE FROM auth_nonce WHERE ctid IN (SELECT ctid FROM candidates LIMIT $3) RETURNING 1
       ) SELECT (SELECT count(*) FROM deleted)::text AS removed,
                EXISTS(SELECT 1 FROM candidates OFFSET $3) AS more`,
      [tenant, input.now, input.limit],
    );
    return { removed: Number(result.rows[0]!.removed), expired: 0, releasedBytes: 0n, more: result.rows[0]!.more };
  }

  async issue(tenant: TenantId, deviceId: string): Promise<string> {
    const nowMs = this.#clock.now().getTime();
    const nonce = this.#crypto.randomToken(NONCE_BYTES);
    await this.#pool.query(
      `INSERT INTO auth_nonce (tenant_id, device_id, nonce, expires_at, used)
       VALUES ($1, $2, $3, $4, false)`,
      [tenant, deviceId, nonce, new Date(nowMs + this.#ttlMs).toISOString()],
    );
    return nonce;
  }

  async consumeIfValid(tenant: TenantId, deviceId: string, nonce: string): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE auth_nonce
         SET used = true
       WHERE tenant_id = $1 AND device_id = $2 AND nonce = $3
         AND used = false AND expires_at >= $4
       RETURNING nonce`,
      [tenant, deviceId, nonce, this.#clock.now().toISOString()],
    );
    return result.rowCount === 1;
  }
}
