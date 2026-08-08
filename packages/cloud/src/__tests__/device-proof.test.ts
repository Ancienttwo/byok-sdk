import { generateKeyPairSync, sign } from 'node:crypto';
import {
  DEVICE_PROOF_SCHEMA_ID,
  createMutableClock,
  deviceProofSigningInput,
  tenantId,
  type DeviceProofProtectedClaims,
} from '@byok/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DEVICE_PROOF_CLOCK_SKEW_MS,
  authenticateDeviceProof,
} from '../auth/device-proof';
import { createWebCrypto } from '../crypto/web-crypto';
import { InMemoryDeviceDirectory } from '../stores/in-memory/device-directory';

const TENANT = tenantId('tenant-a');
const BODY = new TextEncoder().encode('{"value":"truth"}');
const PATH = '/byok/records/memory/profile';
const NOW = '2026-08-09T00:00:00.000Z';

function keyPair() {
  const pair = generateKeyPairSync('ed25519');
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  if (publicJwk.x === undefined) throw new Error('Ed25519 JWK has no x');
  return { privateKey: pair.privateKey, publicKey: publicJwk.x };
}

describe('device proof authentication (I3)', () => {
  const crypto = createWebCrypto();
  const clock = createMutableClock(new Date(NOW));
  const keys = keyPair();
  let devices: InMemoryDeviceDirectory;
  let bodyHash = '';

  beforeEach(async () => {
    clock.set(new Date(NOW));
    bodyHash = await crypto.sha256(BODY);
    devices = new InMemoryDeviceDirectory();
    await devices.register(TENANT, {
      productId: 'product-a',
      deviceId: 'device-a',
      deviceName: 'daemon',
      devicePublicKey: keys.publicKey,
      proofKeyId: 'identity',
      proofKeyEpoch: 0,
    });
  });

  function claims(
    overrides: Partial<DeviceProofProtectedClaims> = {},
  ): DeviceProofProtectedClaims {
    return {
      version: 1,
      tenantId: TENANT,
      productId: 'product-a',
      deviceId: 'device-a',
      keyId: 'identity',
      keyEpoch: 0,
      requestId: 'request-a',
      operation: 'truth.write',
      resource: 'memory/profile',
      method: 'PUT',
      path: PATH,
      bodySha256: bodyHash,
      bodySize: BODY.byteLength,
      issuedAt: NOW,
      ...overrides,
    };
  }

  function envelope(protectedClaims: DeviceProofProtectedClaims = claims()) {
    return {
      schema: DEVICE_PROOF_SCHEMA_ID,
      algorithm: 'ed25519' as const,
      protected: protectedClaims,
      signature: sign(null, deviceProofSigningInput(protectedClaims), keys.privateKey).toString(
        'base64url',
      ),
    };
  }

  function verify(
    proof: unknown,
    requestOverrides: Partial<{
      method: string;
      path: string;
      operation: string;
      resource: string;
      body: Uint8Array;
    }> = {},
  ) {
    return authenticateDeviceProof(
      proof,
      {
        method: 'PUT',
        path: PATH,
        operation: 'truth.write',
        resource: 'memory/profile',
        body: BODY,
        ...requestOverrides,
      },
      { devices, crypto, clock },
    );
  }

  it('verifies Node-signed canonical bytes through the Workers-safe WebCrypto path', async () => {
    await expect(verify(envelope())).resolves.toEqual({
      device: {
        kind: 'device',
        tenantId: TENANT,
        productId: 'product-a',
        deviceId: 'device-a',
      },
      requestId: 'request-a',
      operation: 'truth.write',
      resource: 'memory/profile',
      bodySha256: bodyHash,
      bodySize: BigInt(BODY.byteLength),
      keyId: 'identity',
      keyEpoch: 0,
    });
  });

  it.each([
    ['wrong tenant', () => envelope(claims({ tenantId: 'tenant-b' })), {}],
    ['wrong product', () => envelope(claims({ productId: 'product-b' })), {}],
    ['old key epoch', () => envelope(claims({ keyEpoch: 1 })), {}],
    ['key not found', () => envelope(claims({ keyId: 'rotated' })), {}],
    ['resource altered', () => envelope(), { resource: 'memory/other' }],
    ['path altered', () => envelope(), { path: '/byok/records/memory/other' }],
    ['method altered', () => envelope(), { method: 'POST' }],
    ['body altered', () => envelope(), { body: new TextEncoder().encode('{"value":"evil"}') }],
  ] as const)('rejects a valid signature with %s', async (_name, proof, binding) => {
    await expect(verify(proof(), binding)).resolves.toBeUndefined();
  });

  it('rejects a revoked row and a bad signature identically', async () => {
    const valid = envelope();
    await devices.revoke(TENANT, 'device-a');
    await expect(verify(valid)).resolves.toBeUndefined();

    devices = new InMemoryDeviceDirectory();
    await devices.register(TENANT, {
      productId: 'product-a',
      deviceId: 'device-a',
      deviceName: 'daemon',
      devicePublicKey: keys.publicKey,
      proofKeyId: 'identity',
      proofKeyEpoch: 0,
    });
    const corrupted = `${valid.signature[0] === 'A' ? 'B' : 'A'}${valid.signature.slice(1)}`;
    await expect(verify({ ...valid, signature: corrupted })).resolves.toBeUndefined();
  });

  it('rejects clock skew, invalid expiry ordering and excessive proof lifetime', async () => {
    const outsideSkew = new Date(
      Date.parse(NOW) - DEFAULT_DEVICE_PROOF_CLOCK_SKEW_MS - 1,
    ).toISOString();
    await expect(verify(envelope(claims({ issuedAt: outsideSkew })))).resolves.toBeUndefined();
    await expect(
      verify(envelope(claims({ expiresAt: '2026-08-08T23:59:59.000Z' }))),
    ).resolves.toBeUndefined();
    await expect(
      verify(envelope(claims({ expiresAt: '2026-08-09T00:05:00.001Z' }))),
    ).resolves.toBeUndefined();
  });

  it('rejects malformed canonical values before row lookup or verification', async () => {
    const proof = envelope();
    await expect(
      verify({ ...proof, protected: { ...proof.protected, bodySize: 1.5 } }),
    ).resolves.toBeUndefined();
    await expect(
      verify({ ...proof, protected: { ...proof.protected, tenantId: ' tenant-a' } }),
    ).resolves.toBeUndefined();
  });

  it('rejects operationId proofs on an HTTP request instead of accepting two request forms', async () => {
    const { method: _method, path: _path, ...withoutRequestLine } = claims();
    const operationBound = {
      ...withoutRequestLine,
      operationId: 'truth.writeMemory',
    } as DeviceProofProtectedClaims;
    await expect(verify(envelope(operationBound))).resolves.toBeUndefined();
  });

  it('verifies a body larger than 1 MiB without changing the proof contract', async () => {
    const large = new Uint8Array(1024 * 1024 + 1);
    large.fill(7);
    const largeHash = await crypto.sha256(large);
    const proof = envelope(claims({ bodySha256: largeHash, bodySize: large.byteLength }));
    await expect(verify(proof, { body: large })).resolves.toBeDefined();
  });

  it('accepts insertion-order permutations because verification rebuilds canonical bytes', async () => {
    const base = claims();
    const reversed = Object.fromEntries(Object.entries(base).reverse()) as DeviceProofProtectedClaims;
    await expect(verify(envelope(reversed))).resolves.toBeDefined();
  });
});
