import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { serve } from '@hono/node-server';
import {
  deriveSealingKeyId,
  deviceProofSigningInput,
  parseDeviceProofEnvelope,
  sealingKeyClaimCanonicalBytes,
  type SealingPublicJwk,
} from '@byok-sdk/core';
import { PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it } from 'vitest';
// Sibling source by relative path, test-only (see fixtures/real-cloud.ts): the
// client package gains no dependency on the hosted surface.
import {
  authenticateDeviceProof,
  createInMemoryByokCloud,
  DEVICE_IDENTITY_PROOF_KEY_EPOCH,
  DEVICE_IDENTITY_PROOF_KEY_ID,
  tenantId,
  type InMemoryByokCloud,
} from '../../../cloud/src/index';
import {
  createStoredDeviceProofSigner,
  DeviceProofSignerError,
  readDeviceEnrollmentIdentity,
  readDeviceEnrollmentStatus,
  type DeviceEnrollmentIdentity,
  type DeviceProofRequest,
} from '../index';
import { AuthManager } from '../daemon/auth-manager';
import { exportPrivateKeyPem } from '../daemon/device-keys';
import {
  DEVICE_ENROLLMENT_PROOF_KEY_EPOCH,
  DEVICE_ENROLLMENT_PROOF_KEY_ID,
  DeviceStore,
  type DeviceRecord,
} from '../daemon/store';
import { clearDeviceEnrollment, seedDeviceEnrollment } from './fixtures/device-enrollment';

const TENANT = 'tenant-host-surface';
const PRODUCT = 'host-surface-product';
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  // OS credentials belong to the product, not to each removed temp directory.
  await new DeviceStore(os.tmpdir(), undefined, PRODUCT).credentials.clear();
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

interface HostedCloud {
  readonly hosted: InMemoryByokCloud;
  readonly url: string;
}

async function startCloud(): Promise<HostedCloud> {
  const hosted = createInMemoryByokCloud({ longPollHoldMs: 50, longPollIntervalMs: 10 });
  const server = await new Promise<{ http: HttpServer; url: string }>((resolve) => {
    const http = serve({ fetch: (request: Request) => hosted.cloud.fetch(request), port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({ http: http as unknown as HttpServer, url: `http://127.0.0.1:${info.port}` });
    });
  });
  cleanups.push(() => new Promise<void>((resolve) => {
    server.http.close(() => resolve());
    server.http.closeAllConnections?.();
  }));
  return { hosted, url: server.url };
}

async function pairAgainst(cloud: HostedCloud, storeDir: string): Promise<DeviceRecord> {
  const code = await cloud.hosted.cloud.createPairingCode(tenantId(TENANT), { productId: PRODUCT });
  const auth = new AuthManager({ serverUrl: cloud.url, store: new DeviceStore(storeDir, undefined, PRODUCT) });
  const record = await auth.pair(code.code);
  await auth.stop();
  return record;
}

async function sealingClaimBody(): Promise<Uint8Array> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk: SealingPublicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x as string, y: jwk.y as string };
  return sealingKeyClaimCanonicalBytes({ version: 1, keyId: await deriveSealingKeyId(publicJwk), epoch: 1, publicJwk });
}

function pairedIdentity(status: Awaited<ReturnType<typeof readDeviceEnrollmentIdentity>>): DeviceEnrollmentIdentity {
  if (status.state !== 'paired') throw new Error(`expected a paired enrollment, got ${status.state}`);
  const { state: _state, ...identity } = status;
  return identity;
}

async function seedLocal(storeDir: string, overrides: Partial<DeviceRecord> = {}): Promise<{ record: DeviceRecord; publicKey: ReturnType<typeof createPublicKey> }> {
  const keys = generateKeyPairSync('ed25519');
  const x = keys.publicKey.export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('test key has no public x coordinate');
  const record: DeviceRecord = {
    deviceId: 'device-local',
    tenantId: TENANT,
    accessToken: 'secret-access-token-value',
    expiresAt: '2030-01-01T00:00:00.000Z',
    devicePrivateKeyPem: exportPrivateKeyPem(keys.privateKey),
    devicePublicKey: x,
    ...overrides,
  };
  await seedDeviceEnrollment(new DeviceStore(storeDir, undefined, PRODUCT), record);
  return { record, publicKey: keys.publicKey };
}

const REGISTER_PATH = '/api/agent/devices/device-local/provider-sealing-key';

function registerRequest(body: Uint8Array, overrides: Partial<DeviceProofRequest> = {}): DeviceProofRequest {
  return {
    method: 'PUT',
    path: REGISTER_PATH,
    operation: PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION,
    resource: 'provider-sealing-key',
    requestId: 'register-1',
    body,
    ...overrides,
  };
}

async function signerFailure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DeviceProofSignerError);
  return (error as DeviceProofSignerError).code;
}

describe('readDeviceEnrollmentIdentity', () => {
  it('projects the local proof key from the same contract the cloud writes into the device row', () => {
    expect(DEVICE_ENROLLMENT_PROOF_KEY_ID).toBe(DEVICE_IDENTITY_PROOF_KEY_ID);
    expect(DEVICE_ENROLLMENT_PROOF_KEY_EPOCH).toBe(DEVICE_IDENTITY_PROOF_KEY_EPOCH);
  });

  it('matches the real cloud device row after pairing; enrollmentRevision is the decimal proof key epoch', async () => {
    const cloud = await startCloud();
    const storeDir = await tmpDir('byok-host-identity-pair-');
    const record = await pairAgainst(cloud, storeDir);

    const identity = pairedIdentity(await readDeviceEnrollmentIdentity({ productId: PRODUCT, storeDir }));
    const row = await cloud.hosted.stores.devices.get(tenantId(TENANT), record.deviceId);
    if (row === undefined) throw new Error('paired device row is missing');

    expect(identity).toEqual({
      tenantId: row.tenantId,
      deviceId: row.deviceId,
      proofKeyId: row.proofKeyId,
      proofKeyEpoch: row.proofKeyEpoch,
      enrollmentRevision: String(row.proofKeyEpoch),
    });
    expect(identity.enrollmentRevision).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(await readDeviceEnrollmentStatus({ productId: PRODUCT, storeDir })).toEqual({ state: 'paired', deviceId: row.deviceId });

    // Re-pair on the same machine mints a new device id, so the identity tuple changes.
    const repaired = await pairAgainst(cloud, storeDir);
    const next = pairedIdentity(await readDeviceEnrollmentIdentity({ productId: PRODUCT, storeDir }));
    expect(next.deviceId).toBe(repaired.deviceId);
    expect(next.deviceId).not.toBe(identity.deviceId);
  });

  it('returns only non-secret identity and the same non-paired states as the status read, writing nothing', async () => {
    const storeDir = await tmpDir('byok-host-identity-states-');
    const options = { productId: PRODUCT, storeDir };
    expect(await readDeviceEnrollmentIdentity(options)).toEqual({ state: 'unpaired' });

    const { record } = await seedLocal(storeDir);
    const before = await fs.readFile(path.join(storeDir, 'device.json'), 'utf8');
    const paired = await readDeviceEnrollmentIdentity(options);
    expect(paired).toEqual({
      state: 'paired',
      tenantId: TENANT,
      deviceId: 'device-local',
      proofKeyId: 'identity',
      proofKeyEpoch: 0,
      enrollmentRevision: '0',
    });
    const serialized = JSON.stringify(paired);
    expect(serialized).not.toContain(record.accessToken);
    expect(serialized).not.toContain(record.devicePrivateKeyPem);
    expect(serialized).not.toContain(record.devicePublicKey);
    expect(await fs.readFile(path.join(storeDir, 'device.json'), 'utf8')).toBe(before);

    // Projection without OS authority, and a legacy secret-bearing file: explicit re-pair.
    await new DeviceStore(storeDir, undefined, PRODUCT).credentials.clear();
    expect(await readDeviceEnrollmentIdentity(options)).toEqual({ state: 're_pair_required' });
    await fs.writeFile(path.join(storeDir, 'device.json'), JSON.stringify({
      deviceId: 'legacy', accessToken: 't', expiresAt: '2030-01-01T00:00:00.000Z', devicePrivateKeyPem: 'p', devicePublicKey: 'k',
    }));
    expect(await readDeviceEnrollmentIdentity(options)).toEqual({ state: 're_pair_required' });
  });
});

describe('createStoredDeviceProofSigner', () => {
  it('signs a sealing-key registration that the real cloud verifier accepts against the paired device row', async () => {
    const cloud = await startCloud();
    const storeDir = await tmpDir('byok-host-signer-cloud-');
    const record = await pairAgainst(cloud, storeDir);
    const identity = pairedIdentity(await readDeviceEnrollmentIdentity({ productId: PRODUCT, storeDir }));
    const signer = createStoredDeviceProofSigner({
      productId: PRODUCT,
      storeDir,
      identity,
      operations: [PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION],
    });
    const body = await sealingClaimBody();
    const request = registerRequest(body, { path: `/api/agent/devices/${record.deviceId}/provider-sealing-key` });
    const envelope = await signer.sign(request);

    const deps = { devices: cloud.hosted.stores.devices, crypto: cloud.hosted.crypto, clock: cloud.hosted.clock };
    const binding = { method: request.method, path: request.path, operation: request.operation, resource: request.resource, body };
    const authenticated = await authenticateDeviceProof(envelope, binding, deps);
    expect(authenticated).toMatchObject({
      device: { tenantId: TENANT, productId: PRODUCT, deviceId: record.deviceId },
      operation: PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION,
      keyId: identity.proofKeyId,
      keyEpoch: identity.proofKeyEpoch,
    });

    // Any change to the bound body or request line is rejected by the verifier.
    const tampered = new Uint8Array(body);
    tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 1;
    expect(await authenticateDeviceProof(envelope, { ...binding, body: tampered }, deps)).toBeUndefined();
    expect(await authenticateDeviceProof(envelope, { ...binding, path: `${binding.path}x` }, deps)).toBeUndefined();
    expect(await authenticateDeviceProof(envelope, { ...binding, operation: 'truth.write' }, deps)).toBeUndefined();
  });

  it('verifies with the device public key and never exposes the private key', async () => {
    const storeDir = await tmpDir('byok-host-signer-local-');
    const { record, publicKey } = await seedLocal(storeDir);
    const identity = pairedIdentity(await readDeviceEnrollmentIdentity({ productId: PRODUCT, storeDir }));
    const signer = createStoredDeviceProofSigner({
      productId: PRODUCT,
      storeDir,
      identity,
      operations: [PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION],
      clock: () => new Date('2026-09-28T08:00:00.000Z'),
    });
    const body = await sealingClaimBody();
    const envelope = parseDeviceProofEnvelope(await signer.sign(registerRequest(body)));

    expect(envelope.protected).toMatchObject({
      tenantId: TENANT,
      productId: PRODUCT,
      deviceId: 'device-local',
      keyId: 'identity',
      keyEpoch: 0,
      method: 'PUT',
      path: REGISTER_PATH,
      operation: PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION,
      resource: 'provider-sealing-key',
      bodySize: body.byteLength,
      issuedAt: '2026-09-28T08:00:00.000Z',
    });
    expect(verify(null, deviceProofSigningInput(envelope.protected), publicKey, Buffer.from(envelope.signature, 'base64url'))).toBe(true);
    const devicePublicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: record.devicePublicKey }, format: 'jwk' });
    expect(verify(null, deviceProofSigningInput(envelope.protected), devicePublicKey, Buffer.from(envelope.signature, 'base64url'))).toBe(true);

    // The signer object is only its frozen allowlist and a sign function.
    expect(Object.isFrozen(signer)).toBe(true);
    expect(Object.keys(signer).sort()).toEqual(['operations', 'sign']);
    expect(signer.operations).toEqual([PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION]);
    expect(Object.isFrozen(signer.operations)).toBe(true);
    const pemBody = record.devicePrivateKeyPem.split('\n').filter((line) => line.length > 0 && !line.startsWith('-----')).join('');
    for (const surface of [
      JSON.stringify(signer),
      inspect(signer, { depth: Infinity, showHidden: true }),
      JSON.stringify(envelope),
    ]) {
      expect(surface).not.toContain(pemBody);
      expect(surface).not.toContain(record.accessToken);
    }
  });

  it('refuses an operation outside the allowlist before reading the enrollment', async () => {
    const storeDir = await tmpDir('byok-host-signer-allowlist-');
    await seedLocal(storeDir);
    const identity = pairedIdentity(await readDeviceEnrollmentIdentity({ productId: PRODUCT, storeDir }));
    const signer = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations: [PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION] });
    const body = new TextEncoder().encode('{}');

    expect(await signerFailure(signer.sign(registerRequest(body, { operation: 'truth.write' })))).toBe('operation_not_allowed');
    // Even with the enrollment gone the answer stays the allowlist refusal: the key is never consulted.
    await clearDeviceEnrollment(new DeviceStore(storeDir, undefined, PRODUCT));
    expect(await signerFailure(signer.sign(registerRequest(body, { operation: 'truth.write' })))).toBe('operation_not_allowed');
    expect(await signerFailure(signer.sign(registerRequest(body)))).toBe('unpaired');
  });

  it('refuses when the stored enrollment no longer equals the identity it was created for', async () => {
    const storeDir = await tmpDir('byok-host-signer-fence-');
    await seedLocal(storeDir);
    const identity = pairedIdentity(await readDeviceEnrollmentIdentity({ productId: PRODUCT, storeDir }));
    const operations = [PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION];
    const body = new TextEncoder().encode('{}');

    const stale = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations });
    for (const mismatch of [
      { ...identity, tenantId: 'tenant-other' },
      { ...identity, deviceId: 'device-other' },
      { ...identity, proofKeyId: 'rotated' },
      { ...identity, proofKeyEpoch: 1 },
    ]) {
      const signer = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity: mismatch, operations });
      expect(await signerFailure(signer.sign(registerRequest(body)))).toBe('enrollment_changed');
    }

    // Re-pair between identity read and sign: a new device id replaces the record.
    await seedLocal(storeDir, { deviceId: 'device-repaired' });
    expect(await signerFailure(stale.sign(registerRequest(body)))).toBe('enrollment_changed');

    await fs.writeFile(path.join(storeDir, 'device.json'), JSON.stringify({
      deviceId: 'legacy', accessToken: 't', expiresAt: '2030-01-01T00:00:00.000Z', devicePrivateKeyPem: 'p', devicePublicKey: 'k',
    }));
    expect(await signerFailure(stale.sign(registerRequest(body)))).toBe('re_pair_required');
  });

  it('rejects invalid options and request bindings with closed codes', async () => {
    const storeDir = await tmpDir('byok-host-signer-invalid-');
    await seedLocal(storeDir);
    const identity = pairedIdentity(await readDeviceEnrollmentIdentity({ productId: PRODUCT, storeDir }));
    const operations = [PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION];
    const invalid = (build: () => unknown): string => {
      try {
        build();
      } catch (error) {
        expect(error).toBeInstanceOf(DeviceProofSignerError);
        return (error as DeviceProofSignerError).code;
      }
      throw new Error('expected invalid_options');
    };
    expect(invalid(() => createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations: [] }))).toBe('invalid_options');
    expect(invalid(() => createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations: [''] }))).toBe('invalid_options');
    expect(invalid(() => createStoredDeviceProofSigner({ productId: '', storeDir, identity, operations }))).toBe('invalid_options');
    expect(invalid(() => createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity: { ...identity, tenantId: '' }, operations }))).toBe('invalid_options');
    expect(invalid(() => createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity: { ...identity, proofKeyEpoch: -1 }, operations }))).toBe('invalid_options');

    const signer = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations });
    const body = new TextEncoder().encode('{}');
    expect(await signerFailure(signer.sign(registerRequest(body, { method: 'put' })))).toBe('invalid_request');
    expect(await signerFailure(signer.sign(registerRequest(body, { path: 'relative' })))).toBe('invalid_request');
    expect(await signerFailure(signer.sign(registerRequest(body, { requestId: '' })))).toBe('invalid_request');
    expect(await signerFailure(signer.sign({ ...registerRequest(body), body: 'not-bytes' as unknown as Uint8Array }))).toBe('invalid_request');
  });
});
