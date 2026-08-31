/**
 * Postgres {@link PairingCodeStore}: single-use codes bound to the tenant and
 * product they were minted for.
 *
 * Enrollment is one transaction. `UPDATE ... WHERE redeemed_at IS NULL AND
 * expires_at >= $now RETURNING ...` claims the code only inside the same client
 * transaction that applies machine supersession/state cleanup and inserts the
 * device. A read-then-write would let two callers observe an unused code; an
 * autocommitted redemption would strand a code when registration fails.
 *
 * Unknown, expired, and already-used all answer `undefined`. The reference
 * server distinguishes them in its 401 text; a hosted multi-tenant surface
 * deliberately does not — the code is a bearer credential addressable across
 * every tenant, and "already used" versus "never existed" is precisely the
 * difference an attacker enumerating codes would pay for.
 */
import type { Clock, TenantId } from '@byok-sdk/core';
import type {
  DeviceRecord,
  PairingCodeInfo,
  PairingCodeIssueInput,
  PairingCodeStore,
} from '@byok-sdk/cloud';
import type { Pool } from 'pg';
import { registerDeviceOnClient } from './devices';

/** Best-effort unwind — the enrollment failure, not a rollback failure, is authoritative. */
async function rollback(client: import('pg').PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {}
}

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

  async redeemAndRegister(input: {
    readonly pairingCode: string;
    readonly deviceId: string;
    readonly deviceName: string;
    readonly devicePublicKey: string;
    readonly proofKeyId: string;
    readonly proofKeyEpoch: number;
    readonly machineId?: string;
  }): Promise<DeviceRecord | undefined> {
    const now = this.#clock.now().toISOString();
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ tenant_id: string; product_id: string }>(
        `UPDATE pairing_code
            SET redeemed_at = $2
          WHERE code = $1 AND redeemed_at IS NULL AND expires_at >= $2
        RETURNING tenant_id, product_id`,
        [input.pairingCode, now],
      );
      const claims = result.rows[0];
      if (claims === undefined) {
        await client.query('COMMIT');
        return undefined;
      }
      const device = await registerDeviceOnClient(client, claims.tenant_id as TenantId, {
        productId: claims.product_id,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        devicePublicKey: input.devicePublicKey,
        proofKeyId: input.proofKeyId,
        proofKeyEpoch: input.proofKeyEpoch,
        ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      });
      await client.query('COMMIT');
      return device;
    } catch (cause) {
      await rollback(client);
      throw cause;
    } finally {
      client.release();
    }
  }
}
