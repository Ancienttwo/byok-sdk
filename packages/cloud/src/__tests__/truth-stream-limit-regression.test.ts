import { generateKeyPairSync, sign } from 'node:crypto';
import { DEVICE_PROOF_SCHEMA_ID, createMutableClock, deviceProofSigningInput, tenantId, type DeviceProofProtectedClaims } from '@byok-sdk/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fullCapabilityDeclaration } from '../capabilities';
import { createInMemoryByokCloud, type InMemoryByokCloud } from '../composition/in-memory';
import { createWebCrypto } from '../crypto/web-crypto';
import type { TruthCommitter } from '../truth/contract';

const MAXIMUM = 512;
const PATH = '/byok/records/memory/profile';
const NOW = '2026-08-09T00:00:00.000Z';
const TENANT = tenantId('tenant-stream-limit');
const encoder = new TextEncoder();

async function promptly<T>(operation: T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('truth response waited for EOF or cancellation')), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function streamedRequest(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
  options: { close?: boolean; cancel?: () => void | Promise<void> } = {},
) {
  let index = 0;
  const cancel = vi.fn(options.cancel ?? (() => {}));
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index < chunks.length) controller.enqueue(chunks[index++]!);
    else if (options.close) controller.close();
  });
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  const request = new Request(`http://local${PATH}`, {
    method: 'PUT', body, duplex: 'half',
    headers: { 'content-type': 'application/json', ...headers },
  });
  return { request, body, cancel, pull };
}

describe('truth PUT raw streaming byte ceiling (F03-1)', () => {
  const crypto = createWebCrypto();
  const keys = generateKeyPairSync('ed25519');
  const clock = createMutableClock(new Date(NOW));
  const commit = vi.fn<TruthCommitter['commit']>();
  let composition: InMemoryByokCloud;

  beforeEach(async () => {
    commit.mockReset();
    commit.mockImplementation(async (_tenant, input) => ({
      replayed: false,
      response: {
        primary: {
          kind: 'memory', recordKey: 'profile', rev: 1,
          contentHash: input.writes[0].contentHash,
          byteSize: Number(input.writes[0].byteSize), updatedAt: NOW,
        },
        snapshots: [],
      },
    }));
    composition = createInMemoryByokCloud({
      clock, crypto, maxTruthRequestBytes: MAXIMUM,
      capabilities: fullCapabilityDeclaration(1, { includeTruthRecords: true }),
      truthCommitter: { commit, getRecord: async () => undefined, listManifest: async () => [] },
      truthObjectDownloads: { getDownloadUrl: async () => undefined },
    });
    await composition.stores.devices.register(TENANT, {
      productId: 'product-a', deviceId: 'device-a', deviceName: 'test',
      devicePublicKey: keys.publicKey.export({ format: 'jwk' }).x!,
      proofKeyId: 'identity', proofKeyEpoch: 0,
    });
  });

  it.each([undefined, '1'])('rejects at the first excess byte without EOF (Content-Length %s)', async (length) => {
    const source = streamedRequest(
      [new Uint8Array(200), new Uint8Array(MAXIMUM - 200), new Uint8Array(1), new Uint8Array(4096)],
      length === undefined ? {} : { 'content-length': length },
    );
    const response = await promptly(composition.cloud.fetch(source.request));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'truth request body too large' });
    expect(source.pull).toHaveBeenCalledTimes(3);
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(source.body.locked).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(['throws', 'rejects', 'never settles'] as const)('does not wait when stream cancellation %s', async (mode) => {
    const source = streamedRequest([new Uint8Array(MAXIMUM + 1)], {}, {
      cancel: () => {
        if (mode === 'throws') throw new Error('cancel failed');
        if (mode === 'rejects') return Promise.reject(new Error('cancel rejected'));
        return new Promise<void>(() => {});
      },
    });
    const response = await promptly(composition.cloud.fetch(source.request));
    expect(response.status).toBe(413);
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(source.body.locked).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects a declared oversized body without pulling or awaiting cancellation', async () => {
    const source = streamedRequest([], { 'content-length': String(MAXIMUM + 1) }, {
      cancel: () => new Promise<void>(() => {}),
    });
    expect((await promptly(composition.cloud.fetch(source.request))).status).toBe(413);
    expect(source.pull).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(['invalid', '-1', '1.5', '9007199254740992'])('preserves invalid Content-Length rejection: %s', async (length) => {
    const source = streamedRequest([], { 'content-length': length });
    const response = await promptly(composition.cloud.fetch(source.request));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid truth request body' });
    expect(source.pull).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([undefined, '1', String(MAXIMUM)])('accepts exact-limit valid JSON and proof over original bytes (Content-Length %s)', async (length) => {
    const bytes = await exactBody();
    const proof = await proofHeader(bytes);
    const split = bytes.indexOf(0xc3) + 1; // Split the UTF-8 encoding of é across reads.
    const source = streamedRequest(
      [bytes.subarray(0, 1), new Uint8Array(), bytes.subarray(1, split), bytes.subarray(split)],
      { 'x-byok-device-proof': proof, ...(length === undefined ? {} : { 'content-length': length }) },
      { close: true },
    );
    expect((await promptly(composition.cloud.fetch(source.request))).status).toBe(200);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![1]).toMatchObject({ proofBodySize: BigInt(MAXIMUM), proofBodySha256: await crypto.sha256(bytes) });
    expect(source.cancel).not.toHaveBeenCalled();
    expect(source.body.locked).toBe(false);
  });

  it('rejects an exact-length body whose raw bytes differ from its signed proof', async () => {
    const bytes = await exactBody();
    const proof = await proofHeader(bytes);
    bytes[0] = 32; // Replace leading LF with space: same valid JSON, different raw hash.
    const source = streamedRequest([bytes], { 'x-byok-device-proof': proof }, { close: true });
    expect((await composition.cloud.fetch(source.request)).status).toBe(401);
    expect(commit).not.toHaveBeenCalled();
  });

  it('counts raw UTF-8 bytes rather than decoded characters', async () => {
    const bytes = encoder.encode('é'.repeat(MAXIMUM / 2) + 'x');
    expect(bytes.byteLength).toBe(MAXIMUM + 1);
    const source = streamedRequest([bytes]);
    expect((await promptly(composition.cloud.fetch(source.request))).status).toBe(413);
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([encoder.encode('{'), new Uint8Array([0xff])])('rejects proof-bound malformed JSON or UTF-8', async (bytes) => {
    const source = streamedRequest([bytes], { 'x-byok-device-proof': await proofHeader(bytes) }, { close: true });
    const response = await composition.cloud.fetch(source.request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid truth write request' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('returns 400 on a failed body stream and releases the reader', async () => {
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('read failed')); } });
    const response = await composition.cloud.fetch(new Request(`http://local${PATH}`, { method: 'PUT', body, duplex: 'half' }));
    expect(response.status).toBe(400);
    expect(body.locked).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  async function exactBody(): Promise<Uint8Array> {
    const content = 'remember café ☕';
    const json = '\n' + JSON.stringify({ body: { kind: 'inline', content, contentHash: await crypto.sha256(encoder.encode(content)) }, expectedRev: 0 }, null, 2);
    return encoder.encode(json + ' '.repeat(MAXIMUM - encoder.encode(json).byteLength));
  }

  async function proofHeader(bytes: Uint8Array): Promise<string> {
    const claims: DeviceProofProtectedClaims = {
      version: 1, tenantId: TENANT, productId: 'product-a', deviceId: 'device-a',
      keyId: 'identity', keyEpoch: 0, requestId: 'stream-limit-write',
      operation: 'truth.write', resource: 'memory/profile', method: 'PUT', path: PATH,
      bodySha256: await crypto.sha256(bytes), bodySize: bytes.byteLength, issuedAt: NOW,
    };
    return Buffer.from(JSON.stringify({ schema: DEVICE_PROOF_SCHEMA_ID, algorithm: 'ed25519', protected: claims, signature: sign(null, deviceProofSigningInput(claims), keys.privateKey).toString('base64url') })).toString('base64url');
  }
});
