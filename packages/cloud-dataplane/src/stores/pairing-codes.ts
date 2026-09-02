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
  PairingEnrollmentInput,
} from '@byok-sdk/cloud';
import type { Pool } from 'pg';
import { getDeviceOnClient, registerDeviceOnClient } from './devices';

interface PairingCodeRow {
  readonly tenant_id: string;
  readonly product_id: string;
  readonly expires_at: Date;
  readonly redeemed_at: Date | null;
}

type PairingBinding = Omit<PairingEnrollmentInput, 'pairingCode' | 'deviceId'>;

interface PairingCompletion {
  readonly deviceId: string;
  readonly binding: PairingBinding;
}

function bindingOf(input: PairingEnrollmentInput): PairingBinding {
  return {
    deviceName: input.deviceName,
    devicePublicKey: input.devicePublicKey,
    proofKeyId: input.proofKeyId,
    proofKeyEpoch: input.proofKeyEpoch,
    ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
  };
}

async function completionKey(pairingCode: string): Promise<string> {
  // The pairing code is a bearer credential. Persist only a one-way,
  // domain-separated lookup key so receipt metadata and operator queries do
  // not become another credential disclosure surface.
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`byok-pairing-completion-v1\0${pairingCode}`),
  ));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `pairing-completion:v1:sha256:${hex}`;
}

function sameBinding(left: PairingBinding, right: PairingBinding): boolean {
  return left.deviceName === right.deviceName &&
    left.devicePublicKey === right.devicePublicKey &&
    left.proofKeyId === right.proofKeyId &&
    left.proofKeyEpoch === right.proofKeyEpoch &&
    left.machineId === right.machineId;
}

function sameDevice(device: DeviceRecord, claims: PairingCodeRow, binding: PairingBinding): boolean {
  return device.tenantId === claims.tenant_id as TenantId &&
    device.productId === claims.product_id &&
    device.deviceName === binding.deviceName &&
    device.devicePublicKey === binding.devicePublicKey &&
    device.proofKeyId === binding.proofKeyId &&
    device.proofKeyEpoch === binding.proofKeyEpoch &&
    device.machineId === binding.machineId;
}

function parseCompletion(body: string): PairingCompletion | undefined {
  try {
    const parsed = JSON.parse(body) as Partial<PairingCompletion>;
    if (
      typeof parsed.deviceId !== 'string' ||
      parsed.binding === undefined ||
      typeof parsed.binding.deviceName !== 'string' ||
      typeof parsed.binding.devicePublicKey !== 'string' ||
      typeof parsed.binding.proofKeyId !== 'string' ||
      typeof parsed.binding.proofKeyEpoch !== 'number' ||
      (parsed.binding.machineId !== undefined && typeof parsed.binding.machineId !== 'string')
    ) return undefined;
    return parsed as PairingCompletion;
  } catch {
    return undefined;
  }
}

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
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const previous = await client.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM pairing_code WHERE code = $1 FOR UPDATE',
        [input.code],
      );
      const key = await completionKey(input.code);
      const previousTenant = previous.rows[0]?.tenant_id;
      if (previousTenant !== undefined) {
        // The old receipt is scoped by the old tenant. Deleting only from the
        // newly requested tenant would leave a cross-tenant replay authority.
        await client.query(
          'DELETE FROM device_request_receipts WHERE tenant_id = $1 AND key = $2',
          [previousTenant, key],
        );
      }
      await client.query(
        `INSERT INTO pairing_code (code, tenant_id, product_id, expires_at, redeemed_at)
         VALUES ($1, $2, $3, $4, NULL)
         ON CONFLICT (code) DO UPDATE
           SET tenant_id = EXCLUDED.tenant_id,
               product_id = EXCLUDED.product_id,
               expires_at = EXCLUDED.expires_at,
               redeemed_at = NULL`,
        [input.code, tenant, input.productId, input.expiresAt],
      );
      await client.query('COMMIT');
    } catch (cause) {
      await rollback(client);
      throw cause;
    } finally {
      client.release();
    }
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
    const now = this.#clock.now();
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<PairingCodeRow>(
        `SELECT tenant_id, product_id, expires_at, redeemed_at
           FROM pairing_code WHERE code = $1 FOR UPDATE`,
        [input.pairingCode],
      );
      const claims = selected.rows[0];
      if (claims === undefined) {
        await client.query('COMMIT');
        return undefined;
      }
      const tenant = claims.tenant_id as TenantId;
      const binding = bindingOf(input);
      if (claims.redeemed_at !== null) {
        const stored = await client.query<{ body: string }>(
          'SELECT body FROM device_request_receipts WHERE tenant_id = $1 AND key = $2',
          [tenant, await completionKey(input.pairingCode)],
        );
        const completion = stored.rows[0] === undefined ? undefined : parseCompletion(stored.rows[0].body);
        if (completion === undefined || !sameBinding(completion.binding, binding)) {
          await client.query('COMMIT');
          return undefined;
        }
        const device = await getDeviceOnClient(client, tenant, completion.deviceId);
        await client.query('COMMIT');
        return device === undefined || !sameDevice(device, claims, binding) ? undefined : device;
      }
      if (claims.expires_at.getTime() < now.getTime()) {
        await client.query('COMMIT');
        return undefined;
      }
      await client.query(
        'UPDATE pairing_code SET redeemed_at = $2 WHERE code = $1 AND redeemed_at IS NULL',
        [input.pairingCode, now.toISOString()],
      );
      const device = await registerDeviceOnClient(client, tenant, {
        productId: claims.product_id,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        devicePublicKey: input.devicePublicKey,
        proofKeyId: input.proofKeyId,
        proofKeyEpoch: input.proofKeyEpoch,
        ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      });
      const completion: PairingCompletion = { deviceId: device.deviceId, binding };
      await client.query(
        `INSERT INTO device_request_receipts (tenant_id, key, body, recorded_at)
         VALUES ($1, $2, $3, $4)`,
        [tenant, await completionKey(input.pairingCode), JSON.stringify(completion), now.toISOString()],
      );
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
