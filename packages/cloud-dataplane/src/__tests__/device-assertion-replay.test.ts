import { generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEVICE_ASSERTION_SCHEMA_ID,
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

function replayInput(jti: string, expiresAt = '2026-08-12T04:47:00.000Z'): DeviceAssertionReplayConsumeInput {
  return {
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
});
