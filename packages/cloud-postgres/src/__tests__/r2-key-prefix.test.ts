/**
 * `R2BlobStoreOptions.keyPrefix` — the per-deployment key namespace.
 *
 * Two things are being pinned here, and only one of them is the new feature.
 *
 * The first is that the DEFAULT is unchanged. Every object an existing
 * deployment already stores is reachable only through the key this adapter
 * builds, so "absent prefix produces the pre-existing key, byte for byte" is
 * not a nicety — it is the whole precondition for shipping the option at all.
 * The expected keys below are literals for that reason: re-deriving them from
 * the code under test would assert only that the code agrees with itself.
 *
 * The second is that an unusable prefix dies at construction. A deployment
 * wired with a prefix R2 cannot address should fail while it is being wired,
 * not later, as a 403 or a silent write into a key nobody will look for.
 */
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  tenantId,
  type Clock,
  type ContentHash,
  type ObjectManifestEntry,
  type ObjectStore,
} from '@byok-sdk/core';
import {
  R2CloudBlobStore,
  R2ObjectMaintenanceStore,
  type R2BlobStoreOptions,
} from '../stores/r2-blobs';

const signingClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };

const TENANT = tenantId('acme');
const HEX = 'ab'.repeat(32);
const HASH = contentHash(`sha256:${HEX}`);

/** The default layout, written out rather than derived. */
const DEFAULT_KEY = `tenants/acme/objects/sha256/${HEX}`;

/**
 * `getDownloadUrl` is the cheapest read of the constructed key: it signs and
 * returns, touching neither the network nor the manifest beyond one `get`.
 */
const committedObjects = {
  get: async (): Promise<ObjectManifestEntry> =>
    ({
      tenantId: TENANT,
      hash: HASH,
      byteSize: 3n,
      contentType: 'application/octet-stream',
      state: 'committed',
      refCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }) satisfies ObjectManifestEntry,
} as unknown as ObjectStore;

function optionsWith(keyPrefix?: string): R2BlobStoreOptions {
  return {
    objects: committedObjects,
    signingClock,
    endpoint: 'https://account.r2.cloudflarestorage.com',
    bucket: 'byok',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    region: 'auto',
    ...(keyPrefix !== undefined ? { keyPrefix } : {}),
  };
}

async function downloadKey(keyPrefix?: string): Promise<string> {
  const store = new R2CloudBlobStore(optionsWith(keyPrefix));
  const url = await store.getDownloadUrl(TENANT, HASH);
  if (url === undefined) throw new Error('expected a download grant');
  return new URL(url).pathname.replace('/byok/', '');
}

/** `HEAD`'s key, read off the request the maintenance store would have sent. */
async function maintenanceKey(keyPrefix?: string): Promise<string> {
  let seen: string | undefined;
  const store = new R2ObjectMaintenanceStore({
    ...optionsWith(keyPrefix),
    fetch: async (request) => {
      seen = new URL(request.url).pathname.replace('/byok/', '');
      return new Response(null, {
        status: 200,
        headers: { 'content-length': '3', 'content-type': 'application/octet-stream' },
      });
    },
  });
  await store.inspectObject(TENANT, HASH);
  if (seen === undefined) throw new Error('expected a HEAD request');
  return seen;
}

describe('default (no keyPrefix)', () => {
  it('signs the pre-existing key, byte for byte', async () => {
    await expect(downloadKey()).resolves.toBe(DEFAULT_KEY);
    await expect(maintenanceKey()).resolves.toBe(DEFAULT_KEY);
  });

  it('treats an explicitly undefined prefix as no prefix', async () => {
    await expect(downloadKey(undefined)).resolves.toBe(DEFAULT_KEY);
  });
});

describe('with a keyPrefix', () => {
  it('namespaces the whole key, leaving the tenant layout under it untouched', async () => {
    await expect(downloadKey('acme/prod')).resolves.toBe(`acme/prod/${DEFAULT_KEY}`);
    await expect(maintenanceKey('acme/prod')).resolves.toBe(`acme/prod/${DEFAULT_KEY}`);
  });

  it('accepts a single-segment prefix and the full legal character set', async () => {
    await expect(downloadKey('salesko')).resolves.toBe(`salesko/${DEFAULT_KEY}`);
    await expect(downloadKey('a.b-c_d/9')).resolves.toBe(`a.b-c_d/9/${DEFAULT_KEY}`);
  });
});

describe('an unusable keyPrefix dies at construction', () => {
  /**
   * Each of these is refused for the same reason: it either does not survive
   * being spliced into a key unchanged, or it produces an empty path segment,
   * and both make the stored key something other than what the deployment
   * believes it configured.
   */
  const rejected: readonly (readonly [string, string])[] = [
    ['leading slash', '/acme'],
    ['trailing slash', 'acme/'],
    ['empty segment', 'acme//prod'],
    ['uppercase', 'Acme'],
    ['space', 'acme prod'],
    ['empty string', ''],
    ['slash only', '/'],
    ['leading dot', '.acme'],
    ['percent-encodable', 'acme%2fprod'],
  ];

  for (const [label, keyPrefix] of rejected) {
    it(`refuses ${label}`, () => {
      expect(() => new R2CloudBlobStore(optionsWith(keyPrefix))).toThrowError(
        /object key prefix/i,
      );
      expect(() => new R2ObjectMaintenanceStore(optionsWith(keyPrefix))).toThrowError(
        /object key prefix/i,
      );
    });
  }

  it('does not refuse the prefixes it is supposed to accept', () => {
    for (const keyPrefix of ['acme', 'acme/prod', 'a', '0', 'a.b-c_d/9']) {
      expect(new R2CloudBlobStore(optionsWith(keyPrefix))).toBeInstanceOf(R2CloudBlobStore);
    }
  });
});
