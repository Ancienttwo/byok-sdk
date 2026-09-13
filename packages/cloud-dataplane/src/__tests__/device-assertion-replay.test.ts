import { generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEVICE_ASSERTION_SCHEMA_ID,
  TASK_ASSERTION_SCHEMA_ID,
  createMutableClock,
  deviceAssertionSigningInput,
  tenantId,
  type DeviceAssertionClaims,
  type DeviceAssertionReplayConsumeInput,
} from '@byok-sdk/core';
import { authenticateHostedDeviceAssertion, createWebCrypto } from '@byok-sdk/cloud';
import { runDeviceAssertionReplayConformance } from '@byok-sdk/conformance';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresDeviceAssertionReplayAuthority } from '../stores/device-assertion-replay';
import { PostgresDeviceDirectory } from '../stores/devices';
import { createDataplaneScope, SKIP_DATAPLANE } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

runDeviceAssertionReplayConformance('postgres', {
  async create() {
    const scope = await createDataplaneScope(16);
    await migrate(scope.pool, DEPLOY_SQL);
    return {
      replay: new PostgresDeviceAssertionReplayAuthority(scope.pool),
      dispose: scope.dispose,
    };
  },
}, { skip: SKIP_DATAPLANE });

function replayInput(
  jti: string,
  expiresAt = '2026-08-12T04:47:00.000Z',
  schema: DeviceAssertionReplayConsumeInput['schema'] = DEVICE_ASSERTION_SCHEMA_ID,
): DeviceAssertionReplayConsumeInput {
  return {
    schema,
    tenantId: tenantId('assertion-replay-a'),
    issuer: 'https://api.example.com',
    productId: 'product-a',
    deviceId: 'device-a',
    audience: 'connector-binding',
    jti,
    expiresAt,
  };
}

describe.skipIf(SKIP_DATAPLANE)('Postgres device assertion replay authority', () => {
  it('admits exactly one winner under concurrent consumption', async () => {
    const scope = await createDataplaneScope(16);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const replay = new PostgresDeviceAssertionReplayAuthority(scope.pool);
      const devices = new PostgresDeviceDirectory(scope.pool);
      const keys = generateKeyPairSync('ed25519');
      const publicJwk = keys.publicKey.export({ format: 'jwk' });
      if (publicJwk.x === undefined) throw new Error('Ed25519 JWK has no x');
      await devices.register(tenantId('assertion-replay-a'), {
        productId: 'product-a',
        deviceId: 'device-a',
        deviceName: 'connector host',
        devicePublicKey: publicJwk.x,
        proofKeyId: 'identity',
        proofKeyEpoch: 0,
      });
      const claims: DeviceAssertionClaims = {
        version: 1,
        issuer: 'https://api.example.com',
        productId: 'product-a',
        deviceId: 'device-a',
        audience: 'connector-binding',
        jti: 'AAAAAAAAAAAAAAAAAAAAAA',
        issuedAt: '2026-08-12T04:45:00.000Z',
        expiresAt: '2026-08-12T04:47:00.000Z',
      };
      const envelope = {
        schema: DEVICE_ASSERTION_SCHEMA_ID,
        algorithm: 'ed25519' as const,
        protected: claims,
        signature: sign(null, deviceAssertionSigningInput(claims), keys.privateKey).toString('base64url'),
      };
      const results = await Promise.all(
        Array.from({ length: 64 }, () => authenticateHostedDeviceAssertion(envelope, {
          devices,
          crypto: createWebCrypto(),
          replay,
          clock: createMutableClock(new Date('2026-08-12T04:45:01.000Z')),
          expected: {
            issuer: 'https://api.example.com',
            productId: 'product-a',
            audience: 'connector-binding',
          },
        })),
      );
      expect(results.filter((result) => result !== undefined)).toHaveLength(1);
      expect(results.find((result) => result !== undefined)?.device).toEqual({
        kind: 'device',
        tenantId: 'assertion-replay-a',
        productId: 'product-a',
        deviceId: 'device-a',
      });
    } finally {
      await scope.dispose();
    }
  });

  it('cleans expired entries in bounded batches without deleting live entries', async () => {
    const scope = await createDataplaneScope(8);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const replay = new PostgresDeviceAssertionReplayAuthority(scope.pool);
      await replay.consume(replayInput('AAAAAAAAAAAAAAAAAAAAAA'));
      await replay.consume(replayInput('BBBBBBBBBBBBBBBBBBBBBB'));
      await replay.consume(replayInput('CCCCCCCCCCCCCCCCCCCCCC', '2026-08-12T05:00:00.000Z'));

      await expect(replay.deleteExpired(new Date('2026-08-12T04:47:00.000Z'), 1)).resolves.toBe(1);
      await expect(replay.deleteExpired(new Date('2026-08-12T04:47:00.000Z'), 1)).resolves.toBe(1);
      await expect(replay.deleteExpired(new Date('2026-08-12T04:47:00.000Z'), 1)).resolves.toBe(0);
      await expect(replay.consume(replayInput('CCCCCCCCCCCCCCCCCCCCCC', '2026-08-12T05:00:00.000Z'))).resolves.toBe(false);
    } finally {
      await scope.dispose();
    }
  });

  /**
   * The migration artifact itself (`0022_task_assertion_replay_schema.sql`),
   * asserted against the migrated catalogue rather than against the file's
   * text: contract §8.2(2) names the exact key, and a store whose INSERT
   * carried `schema` while the table's key did not would still pass every
   * behavioural test above — right up to the moment two lanes collided.
   */
  it('migrates the durable primary key to carry the schema discriminator segment', async () => {
    const scope = await createDataplaneScope(8);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const key = await scope.pool.query<{ attname: string; ord: number }>(
        `SELECT a.attname, k.ord
           FROM pg_constraint c
           JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          WHERE c.conrelid = 'device_assertion_replay'::regclass
            AND c.contype = 'p'
          ORDER BY k.ord`,
      );
      expect(key.rows.map((row) => row.attname)).toEqual([
        'tenant_id',
        'issuer',
        'product_id',
        'device_id',
        'audience',
        'schema',
        'jti',
      ]);

      // The column is closed to exactly the two envelope kinds, and the
      // backfill default is gone: a writer that omits its lane fails.
      const replay = new PostgresDeviceAssertionReplayAuthority(scope.pool);
      await expect(replay.consume(replayInput('EEEEEEEEEEEEEEEEEEEEEE'))).resolves.toBe(true);
      await expect(
        replay.consume(replayInput('EEEEEEEEEEEEEEEEEEEEEE', '2026-08-12T04:47:00.000Z', TASK_ASSERTION_SCHEMA_ID)),
      ).resolves.toBe(true);
      await expect(replay.consume(replayInput('EEEEEEEEEEEEEEEEEEEEEE'))).resolves.toBe(false);
      await expect(
        replay.consume(replayInput('EEEEEEEEEEEEEEEEEEEEEE', '2026-08-12T04:47:00.000Z', TASK_ASSERTION_SCHEMA_ID)),
      ).resolves.toBe(false);

      await expect(
        scope.pool.query(
          `INSERT INTO device_assertion_replay
             (tenant_id, issuer, product_id, device_id, audience, schema, jti, expires_at)
           VALUES ('assertion-replay-a', 'https://api.example.com', 'product-a', 'device-a', 'connector-binding',
                   'byok-unknown-assertion-v1', 'FFFFFFFFFFFFFFFFFFFFFF', '2026-08-12T04:47:00.000Z')`,
        ),
      ).rejects.toThrow(/device_assertion_replay_schema_shape/);
      await expect(
        scope.pool.query(
          `INSERT INTO device_assertion_replay
             (tenant_id, issuer, product_id, device_id, audience, jti, expires_at)
           VALUES ('assertion-replay-a', 'https://api.example.com', 'product-a', 'device-a', 'connector-binding',
                   'GGGGGGGGGGGGGGGGGGGGGG', '2026-08-12T04:47:00.000Z')`,
        ),
      ).rejects.toThrow(/schema/);
    } finally {
      await scope.dispose();
    }
  });
});
