/**
 * Revocation deletes — asserted against the tables, because the whole point is
 * what is NOT there afterwards.
 *
 * Two boundaries are pinned here and neither is visible through the port:
 *
 * 1. Which dependent rows go. Device-scoped state (presence, challenge nonces,
 *    inbound dedup, assertion replay) is deleted with the row it hung off; the
 *    history keyed by the device_id STRING (task, agent_egress_event,
 *    proof_request_receipt) survives, because what a device did stays true
 *    after the grant that let it is gone.
 * 2. That the delete never leaves a stranger's row short. `device_id` is
 *    globally unique but the DELETEs are tenant-first, and a tenant-blind
 *    dependent delete would be invisible to every port-level assertion.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { migrate } from '../migrate';
import { PostgresDeviceDirectory } from '../stores/devices';
import { PostgresNonceStore } from '../stores/nonces';
import { PostgresInboundDedupStore } from '../stores/dedup';
import { PostgresDeviceAssertionReplayAuthority } from '../stores/device-assertion-replay';
import { createPostgresCoreStores } from '../stores/core/index';
import { createDataplaneScope, SKIP_DATAPLANE } from './support/dataplane';
import type { Pool } from 'pg';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT_A = tenantId('device-revocation-a');
const TENANT_B = tenantId('device-revocation-b');
const PRODUCT = 'test-product';
const MACHINE = 'a'.repeat(64);

/** Every table this module claims an opinion about, counted for one device. */
async function rowCounts(
  pool: Pool,
  tenant: string,
  deviceId: string,
): Promise<Record<string, number>> {
  const tables = [
    'device',
    'device_presence',
    'auth_nonce',
    'inbound_dedup',
    'device_assertion_replay',
    'task',
    'agent_egress_event',
    'proof_request_receipt',
  ] as const;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1 AND device_id = $2`,
      [tenant, deviceId],
    );
    counts[table] = Number(result.rows[0]!.count);
  }
  return counts;
}

interface Fixture {
  readonly devices: PostgresDeviceDirectory;
  seed(tenant: string, deviceId: string, machineId?: string): Promise<void>;
}

async function fixture(pool: Pool): Promise<Fixture> {
  const clock = createMutableClock();
  const crypto = createWebCrypto();
  const core = createPostgresCoreStores({ pool, clock });
  const devices = new PostgresDeviceDirectory(pool, clock);
  const nonces = new PostgresNonceStore(pool, clock, crypto);
  const dedup = new PostgresInboundDedupStore(pool);
  const replay = new PostgresDeviceAssertionReplayAuthority(pool);

  return {
    devices,
    async seed(tenant, deviceId, machineId) {
      const tenantBrand = tenantId(tenant);
      await devices.register(tenantBrand, {
        productId: PRODUCT,
        deviceId,
        deviceName: deviceId,
        devicePublicKey: `${deviceId}-public-key`,
        proofKeyId: 'identity',
        proofKeyEpoch: 0,
        ...(machineId === undefined ? {} : { machineId }),
      });
      await core.presence.publish(tenantBrand, {
        deviceId,
        level: 'online',
        ttlMs: 600_000,
        minimumIntervalMs: 0,
      });
      await nonces.issue(tenantBrand, deviceId);
      await dedup.checkAndRecord(tenantBrand, deviceId, `${deviceId}-envelope`);
      await replay.consume({
        tenantId: tenantBrand,
        issuer: 'https://api.example.com',
        productId: PRODUCT,
        deviceId,
        audience: 'connector-binding',
        jti: `${deviceId}-jti`,
        expiresAt: '2026-08-12T04:47:00.000Z',
      });
      // History, planted directly: these three tables are the ones revocation
      // must NOT touch, and reaching them through their own stores would only
      // add setup that the assertion does not depend on.
      await pool.query(
        `INSERT INTO task (tenant_id, task_id, device_id, status, updated_at)
         VALUES ($1, $2, $3, 'offered', now())`,
        [tenant, `${deviceId}-task`, deviceId],
      );
      await pool.query(
        `INSERT INTO agent_egress_event (
           tenant_id, device_id, event_id, agent_id, agent_profile_revision, session_ref,
           policy_revision, cursor, payload_json, content_hash, byte_count, receipt_id, recorded_at
         )
         VALUES ($1, $2, $3, 'agent-a', 'rev-1', 'session-1', 'policy-1', 1, $4::jsonb, $5, 2, $6, now())`,
        [
          tenant,
          deviceId,
          randomUUID(),
          JSON.stringify({ text: 'hi' }),
          `sha256:${'0'.repeat(64)}`,
          randomUUID(),
        ],
      );
      await pool.query(
        `INSERT INTO proof_request_receipt (
           tenant_id, device_id, request_id, operation, resource, body_sha256, body_size,
           response_status, response_body, recorded_at
         )
         VALUES ($1, $2, $3, 'read', 'memory/x', $4, 0, 200, '{}', now())`,
        [tenant, deviceId, `${deviceId}-request`, `sha256:${'0'.repeat(64)}`],
      );
    },
  };
}

describe.skipIf(SKIP_DATAPLANE)('Postgres device revocation deletes the registration', () => {
  it('removes the device row and its device-scoped state, and keeps its history', async () => {
    const scope = await createDataplaneScope(4);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const { devices, seed } = await fixture(scope.pool);
      await seed(TENANT_A, 'revoked-device');
      await seed(TENANT_A, 'kept-device');
      await seed(TENANT_B, 'other-tenant-device');

      await expect(rowCounts(scope.pool, TENANT_A, 'revoked-device')).resolves.toEqual({
        device: 1,
        device_presence: 1,
        auth_nonce: 1,
        inbound_dedup: 1,
        device_assertion_replay: 1,
        task: 1,
        agent_egress_event: 1,
        proof_request_receipt: 1,
      });

      await devices.revoke(TENANT_A, 'revoked-device');

      await expect(rowCounts(scope.pool, TENANT_A, 'revoked-device')).resolves.toEqual({
        device: 0,
        device_presence: 0,
        auth_nonce: 0,
        inbound_dedup: 0,
        device_assertion_replay: 0,
        // History keyed by the device_id string, with no foreign key: what the
        // device did stays true after its grant is gone.
        task: 1,
        agent_egress_event: 1,
        proof_request_receipt: 1,
      });
      // Neither the tenant's other device nor another tenant's lost anything.
      await expect(rowCounts(scope.pool, TENANT_A, 'kept-device')).resolves.toMatchObject({
        device: 1,
        device_presence: 1,
        auth_nonce: 1,
        inbound_dedup: 1,
        device_assertion_replay: 1,
      });
      await expect(rowCounts(scope.pool, TENANT_B, 'other-tenant-device')).resolves.toMatchObject({
        device: 1,
        device_presence: 1,
        auth_nonce: 1,
        inbound_dedup: 1,
        device_assertion_replay: 1,
      });
      await expect(devices.get(TENANT_A, 'revoked-device')).resolves.toBeUndefined();
      await expect(devices.resolveByDeviceId('revoked-device')).resolves.toBeUndefined();
      await expect(devices.list(TENANT_A)).resolves.toHaveLength(1);
    } finally {
      await scope.dispose();
    }
  });

  it('is a no-op when the tenant cannot address the device', async () => {
    const scope = await createDataplaneScope(4);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const { devices, seed } = await fixture(scope.pool);
      await seed(TENANT_A, 'revoked-device');

      // device_id is globally unique, so a tenant-blind dependent delete would
      // strip TENANT_A's state from under TENANT_B's request and still leave
      // the device row intact — invisible to any port-level assertion.
      await devices.revoke(TENANT_B, 'revoked-device');

      await expect(rowCounts(scope.pool, TENANT_A, 'revoked-device')).resolves.toMatchObject({
        device: 1,
        device_presence: 1,
        auth_nonce: 1,
        inbound_dedup: 1,
        device_assertion_replay: 1,
      });
    } finally {
      await scope.dispose();
    }
  });

  it('deletes the predecessor and its state when a machine re-pairs', async () => {
    const scope = await createDataplaneScope(4);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const { devices, seed } = await fixture(scope.pool);
      await seed(TENANT_A, 'first-device', MACHINE);
      await seed(TENANT_B, 'stranger-device', MACHINE);

      await devices.register(TENANT_A, {
        productId: PRODUCT,
        deviceId: 'second-device',
        deviceName: 'second-device',
        devicePublicKey: 'second-device-public-key',
        proofKeyId: 'identity',
        proofKeyEpoch: 0,
        machineId: MACHINE,
      });

      await expect(rowCounts(scope.pool, TENANT_A, 'first-device')).resolves.toEqual({
        device: 0,
        device_presence: 0,
        auth_nonce: 0,
        inbound_dedup: 0,
        device_assertion_replay: 0,
        task: 1,
        agent_egress_event: 1,
        proof_request_receipt: 1,
      });
      await expect(devices.list(TENANT_A)).resolves.toHaveLength(1);
      await expect(devices.resolveByDeviceId('first-device')).resolves.toBeUndefined();
      // The same physical machine legitimately holds a row in another tenant.
      await expect(rowCounts(scope.pool, TENANT_B, 'stranger-device')).resolves.toMatchObject({
        device: 1,
        device_presence: 1,
        auth_nonce: 1,
        inbound_dedup: 1,
        device_assertion_replay: 1,
      });
    } finally {
      await scope.dispose();
    }
  });

  it('keeps its own state when the SAME device id re-pairs from the same machine', async () => {
    const scope = await createDataplaneScope(4);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const { devices, seed } = await fixture(scope.pool);
      await seed(TENANT_A, 'stable-device', MACHINE);

      // Re-pairing the same id is the in-place ON CONFLICT replacement, not a
      // supersession of itself: the row is replaced, nothing is superseded.
      await devices.register(TENANT_A, {
        productId: PRODUCT,
        deviceId: 'stable-device',
        deviceName: 'stable-device',
        devicePublicKey: 'stable-device-rotated-key',
        proofKeyId: 'identity',
        proofKeyEpoch: 1,
        machineId: MACHINE,
      });

      await expect(rowCounts(scope.pool, TENANT_A, 'stable-device')).resolves.toMatchObject({
        device: 1,
        device_presence: 1,
      });
      await expect(devices.get(TENANT_A, 'stable-device')).resolves.toMatchObject({
        devicePublicKey: 'stable-device-rotated-key',
        proofKeyEpoch: 1,
        revoked: false,
      });
    } finally {
      await scope.dispose();
    }
  });
});
