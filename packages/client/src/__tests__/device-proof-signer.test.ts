import { generateKeyPairSync, verify } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deviceProofSigningInput, parseDeviceProofEnvelope } from '@byok/core';
import { afterEach, describe, expect, it } from 'vitest';
import { StoredDeviceProofSigner } from '../daemon/device-proof-signer';
import { exportPrivateKeyPem } from '../daemon/device-keys';
import { DeviceStore } from '../daemon/store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('stored device proof signer', () => {
  it('uses core canonical bytes and binds explicit identity, request line and body', async () => {
    const directory = await temporaryDirectory();
    const store = new DeviceStore(directory);
    const keys = generateKeyPairSync('ed25519');
    const publicJwk = keys.publicKey.export({ format: 'jwk' });
    if (publicJwk.x === undefined) throw new Error('test key has no public x coordinate');
    await store.save({
      deviceId: 'device-a',
      accessToken: 'not-used-by-proof',
      expiresAt: '2026-08-10T00:00:00.000Z',
      devicePrivateKeyPem: exportPrivateKeyPem(keys.privateKey),
      devicePublicKey: publicJwk.x,
    });
    const signer = new StoredDeviceProofSigner({
      store,
      tenantId: 'tenant-a',
      productId: 'product-a',
      keyId: 'identity',
      keyEpoch: 0,
      clock: () => new Date('2026-08-09T04:00:00.000Z'),
    });
    const body = new TextEncoder().encode('{"remember":true}');
    const envelope = parseDeviceProofEnvelope(
      await signer.sign({
        method: 'PUT',
        path: '/byok/records/memory/profile?mode=exact',
        operation: 'truth.write',
        resource: 'memory/profile',
        requestId: 'request-1',
        body,
      }),
    );

    expect(envelope.protected).toMatchObject({
      tenantId: 'tenant-a',
      productId: 'product-a',
      deviceId: 'device-a',
      keyId: 'identity',
      keyEpoch: 0,
      requestId: 'request-1',
      method: 'PUT',
      path: '/byok/records/memory/profile?mode=exact',
      operation: 'truth.write',
      resource: 'memory/profile',
      bodySize: body.byteLength,
      issuedAt: '2026-08-09T04:00:00.000Z',
    });
    expect(envelope.protected.bodySha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      verify(
        null,
        deviceProofSigningInput(envelope.protected),
        keys.publicKey,
        Buffer.from(envelope.signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('reads the paired record for every signature so unpair removes local authority', async () => {
    const directory = await temporaryDirectory();
    const store = new DeviceStore(directory);
    const keys = generateKeyPairSync('ed25519');
    const publicJwk = keys.publicKey.export({ format: 'jwk' });
    if (publicJwk.x === undefined) throw new Error('test key has no public x coordinate');
    await store.save({
      deviceId: 'device-a',
      accessToken: 'unused',
      expiresAt: '2026-08-10T00:00:00.000Z',
      devicePrivateKeyPem: exportPrivateKeyPem(keys.privateKey),
      devicePublicKey: publicJwk.x,
    });
    const signer = new StoredDeviceProofSigner({
      store,
      tenantId: 'tenant-a',
      productId: 'product-a',
      keyId: 'identity',
      keyEpoch: 0,
    });
    const request = {
      method: 'GET',
      path: '/byok/records',
      operation: 'truth.list',
      resource: 'records',
      requestId: 'request-1',
      body: new Uint8Array(),
    } as const;
    await expect(signer.sign(request)).resolves.toMatchObject({ algorithm: 'ed25519' });
    await store.clear();
    await expect(signer.sign(request)).rejects.toThrow('device is not paired');
  });

  it('has no implicit tenant or key epoch defaults', async () => {
    const store = { load: async () => undefined };
    expect(
      () =>
        new StoredDeviceProofSigner({
          store,
          tenantId: '',
          productId: 'product-a',
          keyId: 'identity',
          keyEpoch: 0,
        }),
    ).toThrow();
    expect(
      () =>
        new StoredDeviceProofSigner({
          store,
          tenantId: 'tenant-a',
          productId: 'product-a',
          keyId: 'identity',
          keyEpoch: -1,
        }),
    ).toThrow('keyEpoch');
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-proof-signer-'));
  temporaryDirectories.push(directory);
  return directory;
}
