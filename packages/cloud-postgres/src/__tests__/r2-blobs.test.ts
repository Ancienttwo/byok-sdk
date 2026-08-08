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
import type { Clock, ObjectStore } from '@byok/core';
import {
  MAX_PRESIGN_TTL_SECONDS,
  MIN_PRESIGN_TTL_SECONDS,
  R2BlobStoreError,
  R2CloudBlobStore,
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
