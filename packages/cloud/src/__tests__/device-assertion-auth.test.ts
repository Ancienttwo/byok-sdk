import { generateKeyPairSync, sign } from 'node:crypto';
import {
  DEVICE_ASSERTION_SCHEMA_ID,
  InMemoryDeviceAssertionReplayAuthority,
  createMutableClock,
  deviceAssertionSigningInput,
  tenantId,
  type DeviceAssertionClaims,
} from '@byok-sdk/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { authenticateHostedDeviceAssertion } from '../auth/device-assertion';
import { createWebCrypto } from '../crypto/web-crypto';
import { InMemoryDeviceDirectory } from '../stores/in-memory/device-directory';

const TENANT = tenantId('tenant-a');
const ISSUER = 'https://api.example.com';
const NOW = '2026-08-12T04:45:01.000Z';

describe('hosted device assertion authentication', () => {
  const keys = generateKeyPairSync('ed25519');
  const publicJwk = keys.publicKey.export({ format: 'jwk' });
  if (publicJwk.x === undefined) throw new Error('Ed25519 JWK has no x');
  const crypto = createWebCrypto();
  const clock = createMutableClock(new Date(NOW));
  let devices: InMemoryDeviceDirectory;

  beforeEach(async () => {
    clock.set(new Date(NOW));
    devices = new InMemoryDeviceDirectory();
    await devices.register(TENANT, {
      productId: 'product-a',
      deviceId: 'device-a',
      deviceName: 'connector host',
      devicePublicKey: publicJwk.x!,
      proofKeyId: 'identity',
      proofKeyEpoch: 0,
    });
  });

  function envelope(overrides: Partial<DeviceAssertionClaims> = {}) {
    const claims: DeviceAssertionClaims = {
      version: 1,
      issuer: ISSUER,
      productId: 'product-a',
      deviceId: 'device-a',
      audience: 'connector-binding',
      jti: 'AAAAAAAAAAAAAAAAAAAAAA',
      issuedAt: '2026-08-12T04:45:00.000Z',
      expiresAt: '2026-08-12T04:47:00.000Z',
      ...overrides,
    };
    return {
      schema: DEVICE_ASSERTION_SCHEMA_ID,
      algorithm: 'ed25519' as const,
      protected: claims,
      signature: sign(null, deviceAssertionSigningInput(claims), keys.privateKey).toString('base64url'),
    };
  }

  function authenticate(input: unknown, replay = new InMemoryDeviceAssertionReplayAuthority()) {
    return authenticateHostedDeviceAssertion(input, {
      devices,
      crypto,
      replay,
      clock,
      expected: {
        issuer: ISSUER,
        productId: 'product-a',
        audience: 'connector-binding',
      },
    });
  }

  it('adapts the current directory row and burns the assertion before returning success', async () => {
    const assertion = envelope();
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    await expect(authenticate(assertion, replay)).resolves.toMatchObject({
      device: {
        kind: 'device',
        tenantId: TENANT,
        productId: 'product-a',
        deviceId: 'device-a',
      },
    });
    await expect(authenticate(assertion, replay)).resolves.toBeUndefined();
  });

  it('rejects revoked devices and binding mismatches without minting host state', async () => {
    const assertion = envelope();
    await devices.revoke(TENANT, 'device-a');
    await expect(authenticate(assertion)).resolves.toBeUndefined();

    devices = new InMemoryDeviceDirectory();
    await devices.register(TENANT, {
      productId: 'product-b',
      deviceId: 'device-a',
      deviceName: 'wrong product',
      devicePublicKey: publicJwk.x!,
      proofKeyId: 'identity',
      proofKeyEpoch: 0,
    });
    await expect(authenticate(assertion)).resolves.toBeUndefined();
  });

  it('never calls the connector binding side effect when authentication fails', async () => {
    let binds = 0;
    const authenticated = await authenticate(envelope({ audience: 'other-audience' }));
    if (authenticated !== undefined) binds += 1;
    expect(authenticated).toBeUndefined();
    expect(binds).toBe(0);
  });

  it('spends the assertion before a host-owned binding callback can fail', async () => {
    const assertion = envelope();
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    const bind = async () => {
      throw new Error('provider login failed');
    };

    const authenticated = await authenticate(assertion, replay);
    expect(authenticated).toBeDefined();
    await expect(bind()).rejects.toThrow('provider login failed');
    await expect(authenticate(assertion, replay)).resolves.toBeUndefined();
  });
});
