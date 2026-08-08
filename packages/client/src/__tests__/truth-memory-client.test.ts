import { createHash, generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEVICE_PROOF_SCHEMA_ID,
  InMemoryTruthStore,
  contentHash,
  createMutableClock,
  tenantId,
  type DeviceProofEnvelopeV1,
  type TenantId,
  type TruthRecord,
} from '@byok/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fullCapabilityDeclaration,
  createInMemoryByokCloud,
  truthRecordMetadata,
  type TruthCommitInput,
  type TruthCommitResult,
  type TruthCommitter,
  type TruthObjectDownloads,
} from '../../../cloud/src/index';
import { StoredDeviceProofSigner, type DeviceProofRequest, type DeviceProofSigner } from '../daemon/device-proof-signer';
import { exportPrivateKeyPem } from '../daemon/device-keys';
import { DeviceStore } from '../daemon/store';
import {
  TruthMemoryClient,
  TruthMemoryClientError,
  type TruthManifestRecord,
  type VerifiedTruthRecord,
} from '../daemon/truth-memory-client';

const NOW = '2026-08-09T04:00:00.000Z';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

class RecordingSigner implements DeviceProofSigner {
  readonly requests: DeviceProofRequest[] = [];

  sign(request: DeviceProofRequest): Promise<DeviceProofEnvelopeV1> {
    this.requests.push(request);
    return Promise.resolve({
      schema: DEVICE_PROOF_SCHEMA_ID,
      algorithm: 'ed25519',
      protected: {
        version: 1,
        tenantId: 'tenant-a',
        productId: 'product-a',
        deviceId: 'device-a',
        keyId: 'identity',
        keyEpoch: 0,
        requestId: request.requestId,
        operation: request.operation,
        resource: request.resource,
        method: request.method,
        path: request.path,
        bodySha256: hash(request.body),
        bodySize: request.body.byteLength,
        issuedAt: NOW,
      },
      signature: 'AA',
    });
  }
}

describe('truth memory client', () => {
  it('lists metadata, fetches only the local selection, verifies bytes, then calls the filter', async () => {
    const signer = new RecordingSigner();
    const first = metadata('memory', 'first', 'do not fetch');
    const second = metadata('memory', 'second', 'selected bytes');
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/byok/records') return json({ records: [first.record, second.record] });
      if (url.pathname.endsWith('/memory/second')) {
        return json({ ...second.record, body: { kind: 'inline', content: second.content } });
      }
      throw new Error(`unexpected fetch ${url.pathname} ${init?.method ?? 'GET'}`);
    });
    const filter = vi.fn((records: readonly VerifiedTruthRecord[]) =>
      records.map((record) => new TextDecoder().decode(record.bytes)).join('\n'),
    );
    const client = new TruthMemoryClient({
      serverUrl: 'https://cloud.example',
      signer,
      fetch: fetcher as typeof fetch,
      requestId: () => 'read-id',
    });

    await expect(
      client.loadSelected(
        { select: () => [{ kind: 'memory', recordKey: 'second' }] },
        { filter },
        { kind: 'memory', keyPrefix: 'sec', limit: 10 },
      ),
    ).resolves.toBe('selected bytes');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(filter).toHaveBeenCalledTimes(1);
    expect(signer.requests.map((request) => request.path)).toEqual([
      '/byok/records?kind=memory&prefix=sec&limit=10',
      '/byok/records/memory/second',
    ]);
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-byok-device-proof']).toBeTruthy();
  });

  it('rejects unknown and duplicate local selections before fetching bodies', async () => {
    const signer = new RecordingSigner();
    const one = metadata('memory', 'one', 'one');
    const fetcher = vi.fn(async () => json({ records: [one.record] }));
    const client = new TruthMemoryClient({ serverUrl: 'https://cloud.example', signer, fetch: fetcher as typeof fetch });
    await expect(
      client.loadSelected(
        { select: () => [{ kind: 'memory', recordKey: 'missing' }] },
        { filter: () => 'never' },
      ),
    ).rejects.toMatchObject({ code: 'truth_selection_invalid' });
    await expect(
      client.loadSelected(
        {
          select: () => [
            { kind: 'memory', recordKey: 'one' },
            { kind: 'memory', recordKey: 'one' },
          ],
        },
        { filter: () => 'never' },
      ),
    ).rejects.toMatchObject({ code: 'truth_selection_invalid' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fails closed on same-size byte replacement and never calls the filter', async () => {
    const signer = new RecordingSigner();
    const listed = metadata('memory', 'profile', 'good');
    const filter = vi.fn(() => 'must not run');
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/byok/records'
        ? json({ records: [listed.record] })
        : json({ ...listed.record, body: { kind: 'inline', content: 'evil' } });
    });
    const client = new TruthMemoryClient({ serverUrl: 'https://cloud.example', signer, fetch: fetcher as typeof fetch });
    await expect(
      client.loadSelected(
        { select: () => [{ kind: 'memory', recordKey: 'profile' }] },
        { filter },
      ),
    ).rejects.toMatchObject({ code: 'truth_content_hash_mismatch' });
    expect(filter).not.toHaveBeenCalled();
  });

  it('fails closed when the record changes between manifest selection and GET', async () => {
    const signer = new RecordingSigner();
    const listed = metadata('memory', 'profile', 'version one');
    const changed = metadata('memory', 'profile', 'version two', 2);
    const filter = vi.fn(() => 'must not run');
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/byok/records'
        ? json({ records: [listed.record] })
        : json({ ...changed.record, body: { kind: 'inline', content: changed.content } });
    });
    const client = new TruthMemoryClient({ serverUrl: 'https://cloud.example', signer, fetch: fetcher as typeof fetch });
    await expect(
      client.loadSelected(
        { select: () => [{ kind: 'memory', recordKey: 'profile' }] },
        { filter },
      ),
    ).rejects.toMatchObject({ code: 'truth_manifest_changed' });
    expect(filter).not.toHaveBeenCalled();
  });

  it('rejects a manifest that smuggles body content into the metadata response', async () => {
    const signer = new RecordingSigner();
    const listed = metadata('memory', 'profile', 'secret');
    const client = new TruthMemoryClient({
      serverUrl: 'https://cloud.example',
      signer,
      fetch: (async () =>
        json({ records: [{ ...listed.record, body: { kind: 'inline', content: listed.content } }] })) as typeof fetch,
    });
    await expect(client.listManifest()).rejects.toMatchObject({ code: 'truth_response_invalid' });
  });

  it('downloads an object by grant, rehashes it locally, and emits the >1 MiB snapshot metric', async () => {
    const signer = new RecordingSigner();
    const content = new Uint8Array(1024 * 1024 + 1).fill(97);
    const record: TruthManifestRecord = {
      kind: 'profile',
      recordKey: 'large',
      rev: 1,
      contentHash: contentHash(hash(content)),
      byteSize: content.byteLength,
      updatedAt: NOW,
    };
    const metric = vi.fn();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/byok/records') return json({ records: [record] });
      if (url.pathname.endsWith('/profile/large')) {
        return json({ ...record, body: { kind: 'object', downloadUrl: 'https://objects.example/large' } });
      }
      if (url.hostname === 'objects.example') return new Response(content);
      throw new Error(`unexpected fetch ${url}`);
    });
    const client = new TruthMemoryClient({
      serverUrl: 'https://cloud.example',
      signer,
      fetch: fetcher as typeof fetch,
      onMetric: metric,
    });
    await expect(
      client.loadSelected(
        { select: () => [{ kind: 'profile', recordKey: 'large' }] },
        { filter: (records) => records[0]?.bytes.byteLength },
      ),
    ).resolves.toBe(content.byteLength);
    expect(metric).toHaveBeenCalledWith({
      kind: 'truth.snapshot.large',
      selector: { kind: 'profile', recordKey: 'large' },
      byteSize: content.byteLength,
      thresholdBytes: 1024 * 1024,
    });
  });

  it('does not turn a broken metric sink into a >1 MiB rejection threshold', async () => {
    const signer = new RecordingSigner();
    const content = new Uint8Array(1024 * 1024 + 1).fill(98);
    const record: TruthManifestRecord = {
      kind: 'memory',
      recordKey: 'large',
      rev: 1,
      contentHash: contentHash(hash(content)),
      byteSize: content.byteLength,
      updatedAt: NOW,
    };
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/byok/records') return json({ records: [record] });
      if (url.pathname.endsWith('/memory/large')) {
        return json({ ...record, body: { kind: 'object', downloadUrl: 'https://objects.example/large-b' } });
      }
      return new Response(content);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new TruthMemoryClient({
      serverUrl: 'https://cloud.example',
      signer,
      fetch: fetcher as typeof fetch,
      onMetric: () => {
        throw new Error('metrics offline');
      },
    });
    await expect(
      client.loadSelected(
        { select: () => [{ kind: 'memory', recordKey: 'large' }] },
        { filter: (records) => records[0]?.byteSize },
      ),
    ).resolves.toBe(content.byteLength);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('computes inline hashes, binds the exact write bytes and preserves caller request ids for replay', async () => {
    const signer = new RecordingSigner();
    const responseRecord = metadata('memory', 'profile', 'remember').record;
    let observedBody: Uint8Array | undefined;
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observedBody = new Uint8Array(init?.body as Uint8Array);
      return json({ primary: responseRecord, snapshots: [] }, { headers: { 'x-byok-replayed': 'true' } });
    });
    const client = new TruthMemoryClient({ serverUrl: 'https://cloud.example', signer, fetch: fetcher as typeof fetch });
    const result = await client.writeSnapshot({
      kind: 'memory',
      recordKey: 'profile',
      expectedRev: 0,
      requestId: 'stable-write-id',
      body: { kind: 'inline', content: 'remember' },
    });
    expect(result.replayed).toBe(true);
    const parsed = JSON.parse(new TextDecoder().decode(observedBody)) as {
      body: { contentHash: string; content: string };
    };
    expect(parsed.body).toEqual({ kind: 'inline', content: 'remember', contentHash: hashString('remember') });
    expect(signer.requests[0]).toMatchObject({
      requestId: 'stable-write-id',
      operation: 'truth.write',
      resource: 'memory/profile',
      path: '/byok/records/memory/profile',
    });
    expect(signer.requests[0]?.body).toEqual(observedBody);
  });

  it('runs a real stored-key signer through the real cloud verifier and truth routes', async () => {
    const tenant = tenantId('tenant-e2e');
    const clock = createMutableClock(new Date(NOW));
    const truth = new RouteTruthCommitter(clock);
    const downloads: TruthObjectDownloads = { getDownloadUrl: async () => undefined };
    const composition = createInMemoryByokCloud({
      clock,
      truthCommitter: truth,
      truthObjectDownloads: downloads,
      capabilities: fullCapabilityDeclaration(1, { includeTruthRecords: true }),
    });
    const directory = await temporaryDirectory();
    const store = new DeviceStore(directory);
    const keys = generateKeyPairSync('ed25519');
    const publicJwk = keys.publicKey.export({ format: 'jwk' });
    if (publicJwk.x === undefined) throw new Error('test key has no public x coordinate');
    await store.save({
      deviceId: 'device-e2e',
      accessToken: 'not-used',
      expiresAt: '2026-08-10T00:00:00.000Z',
      devicePrivateKeyPem: exportPrivateKeyPem(keys.privateKey),
      devicePublicKey: publicJwk.x,
    });
    await composition.stores.devices.register(tenant, {
      productId: 'product-e2e',
      deviceId: 'device-e2e',
      deviceName: 'daemon',
      devicePublicKey: publicJwk.x,
      proofKeyId: 'identity',
      proofKeyEpoch: 0,
    });
    const signer = new StoredDeviceProofSigner({
      store,
      tenantId: tenant,
      productId: 'product-e2e',
      keyId: 'identity',
      keyEpoch: 0,
      clock: () => new Date(NOW),
    });
    const client = new TruthMemoryClient({
      serverUrl: 'http://local',
      signer,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        composition.cloud.fetch(new Request(input, init))) as typeof fetch,
      requestId: () => 'read-e2e',
    });

    await expect(
      client.writeSnapshot({
        kind: 'memory',
        recordKey: 'profile',
        expectedRev: 0,
        requestId: 'write-e2e',
        body: { kind: 'inline', content: 'verified local memory' },
      }),
    ).resolves.toMatchObject({ primary: { kind: 'memory', recordKey: 'profile', rev: 1 } });
    await expect(
      client.loadSelected(
        { select: (manifest) => manifest.map(({ kind, recordKey }) => ({ kind, recordKey })) },
        { filter: (records) => records.map((record) => new TextDecoder().decode(record.bytes)) },
        { kind: 'memory' },
      ),
    ).resolves.toEqual(['verified local memory']);
  });

  it('surfaces proof-route conflicts as typed HTTP failures without a bearer retry', async () => {
    const signer = new RecordingSigner();
    const client = new TruthMemoryClient({
      serverUrl: 'https://cloud.example',
      signer,
      fetch: (async () => json({ error: 'proof_request_conflict' }, { status: 409 })) as typeof fetch,
    });
    const failure = await client
      .writeSnapshot({
        kind: 'memory',
        recordKey: 'profile',
        expectedRev: 0,
        requestId: 'conflict',
        body: { kind: 'inline', content: 'x' },
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TruthMemoryClientError);
    expect(failure).toMatchObject({ code: 'truth_http_failed', status: 409 });
    expect(signer.requests).toHaveLength(1);
  });
});

class RouteTruthCommitter implements TruthCommitter {
  readonly #truth: InMemoryTruthStore;

  constructor(clock: ReturnType<typeof createMutableClock>) {
    this.#truth = new InMemoryTruthStore(clock);
  }

  getRecord(...args: Parameters<TruthCommitter['getRecord']>) {
    return this.#truth.getRecord(args[0], args[1]);
  }

  listManifest(...args: Parameters<TruthCommitter['listManifest']>) {
    return this.#truth.listManifest(args[0], args[1]);
  }

  async commit(tenant: TenantId, input: TruthCommitInput): Promise<TruthCommitResult> {
    const records: TruthRecord[] = [];
    for (const write of input.writes) {
      records.push(
        write.kind === 'task.terminal'
          ? await this.#truth.writeTerminal(tenant, {
              taskId: write.recordKey,
              contentHash: write.contentHash,
              byteSize: write.byteSize,
              body: write.body,
              ...(write.label === undefined ? {} : { label: write.label }),
              requestId: input.requestId,
            })
          : await this.#truth.writeSnapshot(tenant, {
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
    return {
      response: { primary: truthRecordMetadata(records[0]!), snapshots: records.slice(1).map(truthRecordMetadata) },
      replayed: false,
    };
  }
}

function metadata(kind: 'task.terminal' | 'profile' | 'memory', recordKey: string, content: string, rev = 1) {
  const bytes = new TextEncoder().encode(content);
  return {
    content,
    record: {
      kind,
      recordKey,
      rev,
      contentHash: contentHash(hash(bytes)),
      byteSize: bytes.byteLength,
      updatedAt: NOW,
    } satisfies TruthManifestRecord,
  };
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function hashString(value: string): string {
  return hash(new TextEncoder().encode(value));
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-truth-client-'));
  temporaryDirectories.push(directory);
  return directory;
}
