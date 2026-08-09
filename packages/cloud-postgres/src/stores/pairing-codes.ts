/**
 * Postgres {@link PairingCodeStore}: single-use codes bound to the tenant and
 * product they were minted for.
 *
 * Redemption is one guarded statement. `UPDATE ... WHERE redeemed_at IS NULL
 * AND expires_at >= $now RETURNING ...` consumes and reports in the same
 * round trip, and zero rows is the typed rejection. A read-then-write would let
 * two concurrent redemptions both observe an unused code, and single-use is
 * exactly what makes the caller's "redeem, then register the device" sequence
 * exclusive.
 *
 * Unknown, expired, and already-used all answer `undefined`. The reference
 * server distinguishes them in its 401 text; a hosted multi-tenant surface
 * deliberately does not — the code is a bearer credential addressable across
 * every tenant, and "already used" versus "never existed" is precisely the
 * difference an attacker enumerating codes would pay for.
 */
import type { Clock, TenantId } from '@byok-sdk/core';
import type {
  PairingCodeClaims,
  PairingCodeInfo,
  PairingCodeIssueInput,
  PairingCodeStore,
} from '@byok-sdk/cloud';
import type { Pool } from 'pg';

export class PostgresPairingCodeStore implements PairingCodeStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async issue(tenant: TenantId, input: PairingCodeIssueInput): Promise<PairingCodeInfo> {
    // Re-issuing a code the host's control plane already minted replaces it,
    // deadline and consumption state included: a mint is the control plane
    // speaking, and it is the only party that could have chosen this code.
    await this.#pool.query(
      `INSERT INTO pairing_code (code, tenant_id, product_id, expires_at, redeemed_at)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (code) DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id,
             product_id = EXCLUDED.product_id,
             expires_at = EXCLUDED.expires_at,
             redeemed_at = NULL`,
      [input.code, tenant, input.productId, input.expiresAt],
    );
    // `expiresAt` is echoed from the input rather than read back: the caller
    // supplied a canonical instant and must get that exact string, not this
    // driver's rendering of a timestamptz round trip.
    return { code: input.code, expiresAt: input.expiresAt };
  }

  async redeem(code: string): Promise<PairingCodeClaims | undefined> {
    const now = this.#clock.now().toISOString();
    const result = await this.#pool.query<{ tenant_id: string; product_id: string }>(
      `UPDATE pairing_code
          SET redeemed_at = $2
        WHERE code = $1 AND redeemed_at IS NULL AND expires_at >= $2
      RETURNING tenant_id, product_id`,
      [code, now],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { tenantId: row.tenant_id as TenantId, productId: row.product_id };
  }
}
