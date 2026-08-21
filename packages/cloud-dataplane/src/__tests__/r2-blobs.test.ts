/**
 * The adapter's construction-time refusals.
 *
 * Ungated, unlike `object-suite.test.ts`: a presign lifetime R2 would never
 * honor is a configuration fault, and catching it needs neither a database nor
 * an object store. It also must not need one — the whole point of refusing at
 * construction is that a deployment dies at wiring time instead of minting a
 * URL that is rejected at upload time, in production, by a remote whose error
 * says nothing about which option was wrong.
 */
import { describe, expect, it } from 'vitest';
import { contentHash, tenantId, type Clock, type ObjectStore } from '@byok-sdk/core';
import {
  MAX_PRESIGN_TTL_SECONDS,
  MIN_PRESIGN_TTL_SECONDS,
  R2BlobStoreError,
  R2CloudBlobStore,
  R2ObjectMaintenanceStore,
  ObjectStoreRequestError,
  type R2BlobStoreOptions,
} from '../stores/r2-blobs';

const signingClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };

/**
 * The constructor never touches the manifest store, so a stub is the honest
 * fixture: supplying a real one would imply this assertion depends on it.
 */
const NO_OBJECTS = {} as unknown as ObjectStore;

function optionsWith(presignTtlSeconds?: number): R2BlobStoreOptions {
  return {
    objects: NO_OBJECTS,
    signingClock,
    endpoint: 'https://account.r2.cloudflarestorage.com',
    bucket: 'byok',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    region: 'auto',
    ...(presignTtlSeconds !== undefined ? { presignTtlSeconds } : {}),
  };
}

function constructing(presignTtlSeconds: number): unknown {
  try {
    return new R2CloudBlobStore(optionsWith(presignTtlSeconds));
  } catch (caught: unknown) {
    return caught;
  }
}

describe('presign lifetime', () => {
  it('refuses a lifetime outside the range SigV4 can express', () => {
    // Zero and negatives are not short grants, they are grants that were never
    // valid; a fraction is not a count of seconds; `NaN` is not a count of
    // anything. Each of them would otherwise reach `X-Amz-Expires` verbatim.
    const rejected = [
      0,
      -1,
      -604_800,
      1.5,
      Number.NaN,
      MAX_PRESIGN_TTL_SECONDS + 1,
      Number.POSITIVE_INFINITY,
    ];

    for (const presignTtlSeconds of rejected) {
      const failure = constructing(presignTtlSeconds);
      expect(failure, `expected ${String(presignTtlSeconds)} to be refused`).toBeInstanceOf(R2BlobStoreError);
      expect((failure as R2BlobStoreError).code).toBe('storage_presign_ttl_invalid');
    }
  });

  it('accepts both ends of the range, and the default', () => {
    // The control: "every option throws" is not how the assertion above passes.
    for (const presignTtlSeconds of [MIN_PRESIGN_TTL_SECONDS, 900, MAX_PRESIGN_TTL_SECONDS, undefined]) {
      expect(new R2CloudBlobStore(optionsWith(presignTtlSeconds))).toBeInstanceOf(R2CloudBlobStore);
    }
  });
});

describe('R2 maintenance surface', () => {
  const tenant = tenantId('tenant-a');
  const hashA = contentHash(`sha256:${'a'.repeat(64)}`);
  const hashB = contentHash(`sha256:${'b'.repeat(64)}`);

  it('parses one bounded ListObjectsV2 page and round-trips the opaque cursor', async () => {
    const requests: Request[] = [];
    const store = new R2ObjectMaintenanceStore({
      ...optionsWith(),
      fetch: async (request) => {
        requests.push(request);
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
           <ListBucketResult>
             <IsTruncated>true</IsTruncated>
             <NextContinuationToken>opaque+/=token</NextContinuationToken>
             <Contents><Key>tenants/tenant-a/objects/sha256/${hashA.slice('sha256:'.length)}</Key><Size>7</Size></Contents>
             <Contents><Key>tenants/tenant-a/objects/sha256/not-a-hash</Key><Size>9</Size></Contents>
           </ListBucketResult>`,
          { status: 200 },
        );
      },
    });

    const page = await store.listTenantObjects(tenant, 'before+/=token', 2);
    expect(page).toEqual({
      objects: [
        { key: `tenants/tenant-a/objects/sha256/${hashA.slice('sha256:'.length)}`, hash: hashA, byteSize: 7n },
        { key: 'tenants/tenant-a/objects/sha256/not-a-hash', byteSize: 9n },
      ],
      nextContinuationToken: 'opaque+/=token',
    });
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get('prefix')).toBe('tenants/tenant-a/objects/sha256/');
    expect(url.searchParams.get('max-keys')).toBe('2');
    expect(url.searchParams.get('continuation-token')).toBe('before+/=token');
  });

  it('fails closed when a truncated page has no continuation token', async () => {
    const store = new R2ObjectMaintenanceStore({
      ...optionsWith(),
      fetch: async () =>
        new Response(
          '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>',
          { status: 200 },
        ),
    });
    await expect(store.listTenantObjects(tenant)).rejects.toBeInstanceOf(ObjectStoreRequestError);
  });

  it('treats DELETE absence as an idempotent success outcome', async () => {
    const statuses = [204, 404];
    const methods: string[] = [];
    const store = new R2ObjectMaintenanceStore({
      ...optionsWith(),
      fetch: async (request) => {
        methods.push(request.method);
        return new Response(null, { status: statuses.shift()! });
      },
    });
    await expect(store.deleteObject(tenant, hashB)).resolves.toBe('deleted');
    await expect(store.deleteObject(tenant, hashB)).resolves.toBe('absent');
    expect(methods).toEqual(['DELETE', 'DELETE']);
  });
});
