import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  DEVICE_PROOF_SCHEMA_ID,
  InMemoryTruthStore,
  contentHash,
  createMutableClock,
  deviceProofSigningInput,
  tenantId,
  type ContentHash,
  type DeviceProofProtectedClaims,
  type TenantId,
  type TruthRecord,
} from '@byok/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLOUD_CAPABILITIES, fullCapabilityDeclaration } from '../capabilities';
import { createByokCloud } from '../cloud';
import { createInMemoryByokCloud, type InMemoryByokCloud } from '../composition/in-memory';
import { createWebCrypto } from '../crypto/web-crypto';
import { TruthCommitError } from '../truth/errors';
import {
  truthRecordMetadata,
  type TruthCommitInput,
  type TruthCommitResponse,
  type TruthCommitResult,
  type TruthCommitter,
  type TruthObjectDownloads,
} from '../truth/contract';
import type { CloudBlobStore } from '../stores/ports';

const TENANT = tenantId('tenant-truth');
const NOW = '2026-08-09T00:00:00.000Z';

interface Receipt {
  readonly operation: string;
  readonly resource: string;
  readonly bodySha256: string;
  readonly bodySize: bigint;
  readonly response: TruthCommitResponse;
}

/** Route behavior fake only. Production atomicity is proved by PostgresTruthCommitter tests. */
class RouteTruthCommitter implements TruthCommitter {
  readonly truth: InMemoryTruthStore;
  readonly #receipts = new Map<string, Receipt>();

  constructor(clock: ReturnType<typeof createMutableClock>) {
    this.truth = new InMemoryTruthStore(clock);
  }

  getRecord(...args: Parameters<TruthCommitter['getRecord']>) {
    return this.truth.getRecord(...args);
  }

  listManifest(...args: Parameters<TruthCommitter['listManifest']>) {
    return this.truth.listManifest(...args);
  }

  async commit(tenant: TenantId, input: TruthCommitInput): Promise<TruthCommitResult> {
    const receiptKey = `${tenant}\u0000${input.deviceId}\u0000${input.requestId}`;
    const existing = this.#receipts.get(receiptKey);
    if (existing !== undefined) {
      if (
        existing.operation !== input.operation ||
        existing.resource !== input.resource ||
        existing.bodySha256 !== input.proofBodySha256 ||
        existing.bodySize !== input.proofBodySize
      ) {
        throw new TruthCommitError('proof_request_conflict', 'request binding changed');
      }
      return { response: existing.response, replayed: true };
    }

    const records: TruthRecord[] = [];
    for (const write of input.writes) {
      records.push(
        write.kind === 'task.terminal'
          ? await this.truth.writeTerminal(tenant, {
              taskId: write.recordKey,
              contentHash: write.contentHash,
              byteSize: write.byteSize,
              body: write.body,
              ...(write.label === undefined ? {} : { label: write.label }),
              requestId: input.requestId,
            })
          : await this.truth.writeSnapshot(tenant, {
              kind: write.kind,
              recordKey: write.recordKey,
              expectedRev: write.expectedRev,
              contentHash: write.contentHash,
              byteSize: write.byteSize,
              body: write.body,
              ...(write.label === undefined ? {} : { label: write.label }),
              requestId: input.requestId,
            }),
      );
    }
    const response = {
      primary: truthRecordMetadata(records[0]!),
      snapshots: records.slice(1).map(truthRecordMetadata),
    };
    this.#receipts.set(receiptKey, {
      operation: input.operation,
      resource: input.resource,
      bodySha256: input.proofBodySha256,
      bodySize: input.proofBodySize,
      response,
    });
    return { response, replayed: false };
  }
}

class RouteTruthDownloads implements TruthObjectDownloads {
  readonly #blobIds = new Map<string, string>();
  blobs: CloudBlobStore | undefined;

  bind(hash: string, blobId: string): void {
    this.#blobIds.set(hash, blobId);
  }

  getDownloadUrl(tenant: TenantId, hash: ContentHash): Promise<string | undefined> {
    const blobId = this.#blobIds.get(hash);
    if (this.blobs === undefined || blobId === undefined) return Promise.resolve(undefined);
    return this.blobs.getDownloadUrl(tenant, blobId);
  }
}

describe('proof-only truth routes', () => {
  const clock = createMutableClock(new Date(NOW));
  const crypto = createWebCrypto();
  const keys = generateKeyPairSync('ed25519');
  const publicJwk = keys.publicKey.export({ format: 'jwk' });
  if (publicJwk.x === undefined) throw new Error('Ed25519 JWK has no x');
  const publicKey = publicJwk.x;
  let truth: RouteTruthCommitter;
  let downloads: RouteTruthDownloads;
  let composition: InMemoryByokCloud;

  beforeEach(async () => {
    clock.set(new Date(NOW));
    truth = new RouteTruthCommitter(clock);
    downloads = new RouteTruthDownloads();
    composition = createInMemoryByokCloud({
      clock,
      crypto,
      truthCommitter: truth,
      truthObjectDownloads: downloads,
      capabilities: fullCapabilityDeclaration(1, { includeTruthRecords: true }),
    });
    downloads.blobs = composition.stores.blobs;
    await composition.stores.devices.register(TENANT, {
      productId: 'product-a',
      deviceId: 'device-a',
      deviceName: 'daemon',
      devicePublicKey: publicKey,
      proofKeyId: 'identity',
      proofKeyEpoch: 0,
    });
    await composition.core.quota.writeEntitlement(TENANT, {
      version: 1n,
      hardLimitBytes: 10_000_000n,
      maxObjectBytes: 5_000_000n,
      maxInlineBytes: 1_000_000n,
      mailboxLimitBytes: 1_000_000n,
      retentionPolicyId: 'default',
    });
  });

  it('mounts exactly three proof-class routes only under an explicit atomic authority', () => {
    expect(
      composition.cloud.routes.filter((route) => route.class === 'proof').map((route) => `${route.method} ${route.path}`),
    ).toEqual([
      'GET /byok/records',
      'GET /byok/records/:kind/:key',
      'PUT /byok/records/:kind/:key',
    ]);

    expect(() =>
      createByokCloud({
        core: composition.core,
        cloud: composition.stores,
        blobContentProxy: composition.blobContentProxy,
        crypto,
        tokenSigner: { sign: async () => '', verify: async () => undefined },
        clock,
        capabilities: fullCapabilityDeclaration(1, { includeTruthRecords: true }),
      }),
    ).toThrowError(expect.objectContaining({ code: 'capability_over_declared' }));
    expect(() =>
      createInMemoryByokCloud({
        clock,
        crypto,
        truthCommitter: truth,
        capabilities: fullCapabilityDeclaration(1, { includeTruthRecords: true }),
      }),
    ).toThrowError(expect.objectContaining({ code: 'capability_over_declared' }));
    expect(fullCapabilityDeclaration().capabilities).not.toContain(CLOUD_CAPABILITIES.truthRecords);
  });

  it('writes, lists metadata without bodies, and fetches inline content', async () => {
    const writeBody = jsonBytes({
      expectedRev: 0,
      body: {
        kind: 'inline',
        content: 'remember this',
        contentHash: await sha256Text('remember this'),
      },
      label: 'profile',
    });
    const write = await requestWithProof(
      'PUT',
      '/byok/records/memory/profile',
      'truth.write',
      'memory/profile',
      writeBody,
      'write-1',
    );
    expect(write.status).toBe(200);
    expect(write.headers.get('x-byok-replayed')).toBe('false');

    const list = await requestWithProof(
      'GET',
      '/byok/records?kind=memory&prefix=pro&limit=10',
      'truth.list',
      'records',
      new Uint8Array(),
      'list-1',
    );
    expect(list.status).toBe(200);
    const manifest = (await list.json()) as { records: unknown[] };
    expect(manifest.records).toHaveLength(1);
    expect(manifest.records[0]).not.toHaveProperty('body');
    expect(manifest.records[0]).not.toHaveProperty('content');

    const get = await requestWithProof(
      'GET',
      '/byok/records/memory/profile',
      'truth.read',
      'memory/profile',
      new Uint8Array(),
      'get-1',
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      kind: 'memory',
      recordKey: 'profile',
      rev: 1,
      body: { kind: 'inline', content: 'remember this' },
    });
  });

  it('rejects bearer-only, query tamper, body tamper and invalid snapshot write models', async () => {
    const bearerOnly = await composition.cloud.fetch(
      new Request('http://local/byok/records', { headers: { authorization: 'Bearer anything' } }),
    );
    expect(bearerOnly.status).toBe(401);
    expect(await bearerOnly.json()).toEqual({ error: 'unauthorized' });
    const invalidSelectorWithoutProof = await composition.cloud.fetch(
      new Request('http://local/byok/records/not-a-kind/invalid'),
    );
    expect(invalidSelectorWithoutProof.status).toBe(401);
    expect(await invalidSelectorWithoutProof.json()).toEqual({ error: 'unauthorized' });

    const queryProof = await proofHeader(
      'GET',
      '/byok/records?kind=memory',
      'truth.list',
      'records',
      new Uint8Array(),
      'list-tamper',
    );
    const queryTamper = await composition.cloud.fetch(
      new Request('http://local/byok/records?kind=profile', {
        headers: { 'x-byok-device-proof': queryProof },
      }),
    );
    expect(queryTamper.status).toBe(401);

    const validBody = jsonBytes({
      expectedRev: 0,
      body: { kind: 'inline', content: 'a', contentHash: await sha256Text('a') },
    });
    const bodyProof = await proofHeader(
      'PUT',
      '/byok/records/memory/tamper',
      'truth.write',
      'memory/tamper',
      validBody,
      'body-tamper',
    );
    const bodyTamper = await composition.cloud.fetch(
      new Request('http://local/byok/records/memory/tamper', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-byok-device-proof': bodyProof },
        body: JSON.stringify({ expectedRev: 0 }),
      }),
    );
    expect(bodyTamper.status).toBe(401);

    const invalidModel = jsonBytes({
      body: { kind: 'inline', content: 'a', contentHash: await sha256Text('a') },
    });
    const invalid = await requestWithProof(
      'PUT',
      '/byok/records/memory/missing-rev',
      'truth.write',
      'memory/missing-rev',
      invalidModel,
      'invalid-model',
    );
    expect(invalid.status).toBe(400);
  });

  it('returns exact replay and conflicts when one request id is rebound', async () => {
    const firstBody = jsonBytes({
      expectedRev: 0,
      body: { kind: 'inline', content: 'first', contentHash: await sha256Text('first') },
    });
    const first = await requestWithProof(
      'PUT',
      '/byok/records/profile/replay',
      'truth.write',
      'profile/replay',
      firstBody,
      'same-id',
    );
    const replay = await requestWithProof(
      'PUT',
      '/byok/records/profile/replay',
      'truth.write',
      'profile/replay',
      firstBody,
      'same-id',
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-byok-replayed')).toBe('true');
    expect(await replay.json()).toEqual(await first.json());

    const reboundBody = jsonBytes({
      expectedRev: 1,
      body: { kind: 'inline', content: 'second', contentHash: await sha256Text('second') },
    });
    const rebound = await requestWithProof(
      'PUT',
      '/byok/records/profile/replay',
      'truth.write',
      'profile/replay',
      reboundBody,
      'same-id',
    );
    expect(rebound.status).toBe(409);
    expect(await rebound.json()).toEqual({ error: 'proof_request_conflict' });
  });

  it('returns a committed object grant without proxying object bytes through the record route', async () => {
    const bytes = new TextEncoder().encode('object-backed truth');
    const hash = contentHash(await crypto.sha256(bytes));
    const reservation = await composition.core.quota.reserve(TENANT, {
      reservationId: 'truth-object',
      kind: 'object',
      expectedBytes: BigInt(bytes.byteLength),
      contentHash: hash,
      contentType: 'application/octet-stream',
      ttlMs: 60_000,
    });
    const upload = await composition.stores.blobs.createUpload(TENANT, reservation);
    downloads.bind(hash, upload.blobId);
    await composition.blobContentProxy.writeContent(upload.blobId, bytes);
    const observed = await composition.stores.blobs.observeUpload(TENANT, upload.blobId, reservation);
    if (observed === undefined) throw new Error('object upload was not observable');
    await composition.core.quota.finalizeReservation(TENANT, {
      reservationId: reservation.reservationId,
      ...observed,
    });

    const writeBody = jsonBytes({
      expectedRev: 0,
      body: { kind: 'object', contentHash: hash, byteSize: bytes.byteLength },
    });
    expect(
      (
        await requestWithProof(
          'PUT',
          '/byok/records/memory/object',
          'truth.write',
          'memory/object',
          writeBody,
          'object-write',
        )
      ).status,
    ).toBe(200);

    const get = await requestWithProof(
      'GET',
      '/byok/records/memory/object',
      'truth.read',
      'memory/object',
      new Uint8Array(),
      'object-get',
    );
    expect(get.status).toBe(200);
    const response = (await get.json()) as { body: { kind: string; downloadUrl: string } };
    expect(response.body.kind).toBe('object');
    expect(response.body.downloadUrl).toContain('/byok/blobs/');
    expect(response).not.toHaveProperty('content');
  });

  async function requestWithProof(
    method: string,
    path: string,
    operation: string,
    resource: string,
    body: Uint8Array,
    requestId: string,
  ): Promise<Response> {
    const header = await proofHeader(method, path, operation, resource, body, requestId);
    return composition.cloud.fetch(
      new Request(`http://local${path}`, {
        method,
        headers: { 'x-byok-device-proof': header, 'content-type': 'application/json' },
        ...(method === 'PUT' ? { body } : {}),
      }),
    );
  }

  async function proofHeader(
    method: string,
    path: string,
    operation: string,
    resource: string,
    body: Uint8Array,
    requestId: string,
  ): Promise<string> {
    const claims: DeviceProofProtectedClaims = {
      version: 1,
      tenantId: TENANT,
      productId: 'product-a',
      deviceId: 'device-a',
      keyId: 'identity',
      keyEpoch: 0,
      requestId,
      operation,
      resource,
      method,
      path,
      bodySha256: await crypto.sha256(body),
      bodySize: body.byteLength,
      issuedAt: NOW,
    };
    const envelope = {
      schema: DEVICE_PROOF_SCHEMA_ID,
      algorithm: 'ed25519' as const,
      protected: claims,
      signature: signClaims(claims, keys.privateKey),
    };
    return Buffer.from(JSON.stringify(envelope)).toString('base64url');
  }

  async function sha256Text(value: string): Promise<string> {
    return crypto.sha256(new TextEncoder().encode(value));
  }
});

function signClaims(claims: DeviceProofProtectedClaims, privateKey: KeyObject): string {
  return sign(null, deviceProofSigningInput(claims), privateKey).toString('base64url');
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
