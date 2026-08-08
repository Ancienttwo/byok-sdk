/**
 * The nine S4A.4 object assertions, against a real S3 implementation.
 *
 * Why MinIO and not a fake: seven of the nine are about a presigned URL's
 * BINDING — to a tenant, to a key, to a length, to an expiry — and a binding
 * asserted against our own verifier is self-certifying. We sign, we check our
 * own signature, we pass, and a signature that bound nothing would pass too.
 * MinIO is an independent SigV4 implementation: when it accepts a URL the
 * binding held, and when it answers 403 the binding held against something we
 * did not write. Nothing here stubs a signature check.
 *
 * The two that are NOT about the protocol — retry and backoff — go through a
 * fault injector wrapped around `fetch` instead, because "503 twice then 200"
 * is not something a correct object store can be asked to do.
 *
 * Everything runs against a fresh Postgres schema and a fresh bucket per test:
 * the manifest state machine and the objects it describes have to start empty
 * together, or a leftover object makes a `pending` row look uploaded.
 */
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ByokCoreError,
  contentHash,
  createMutableClock,
  tenantId,
  tenantObjectKey,
  type Clock,
  type ContentHash,
  type TenantId,
} from '@byok/core';
import type { BlobDeclaration } from '@byok/cloud';
import { migrate } from '../migrate';
import { PostgresObjectStore } from '../stores/core/objects';
import {
  ObjectStoreRequestError,
  R2BlobStoreError,
  R2CloudBlobStore,
  type ObjectStoreFetch,
} from '../stores/r2-blobs';
import {
  createDataplaneScope,
  createObjectStorageScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
  type DataplaneScope,
  type ObjectStorageScope,
} from './support/dataplane';
import { injectFaults, recordCalls, type FaultStep } from './support/fault-injection';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

const TENANT_A: TenantId = tenantId('tenant-a');
const TENANT_B: TenantId = tenantId('tenant-b');

/** Wall time, for the same reason the composition passes one: MinIO judges freshness by its own clock. */
const wallClock: Clock = { now: () => new Date() };

interface ObjectHarness {
  readonly scope: DataplaneScope;
  readonly storage: ObjectStorageScope;
  readonly objects: PostgresObjectStore;
  readonly blobs: R2CloudBlobStore;
  dispose(): Promise<void>;
}

interface HarnessOptions {
  readonly signingClock?: Clock;
  readonly presignTtlSeconds?: number;
  readonly fetch?: ObjectStoreFetch;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
}

async function createObjectHarness(options: HarnessOptions = {}): Promise<ObjectHarness> {
  const scope = await createDataplaneScope();
  await migrate(scope.pool, DEPLOY_SQL);
  const storage = await createObjectStorageScope();

  // The manifest's own clock stays logical, exactly as every other store's
  // does. Only the signature reads wall time.
  const objects = new PostgresObjectStore(scope.pool, createMutableClock());
  const blobs = new R2CloudBlobStore({
    ...storage.config,
    ...options,
    objects,
  });

  return { scope, storage, objects, blobs, dispose: () => scope.dispose() };
}

async function withObjects(
  body: (harness: ObjectHarness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> {
  const harness = await createObjectHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.dispose();
  }
}

function hexDigest(bytes: Uint8Array): Promise<string> {
  return globalThis.crypto.subtle
    .digest('SHA-256', bytes)
    .then((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
}

interface Content {
  readonly bytes: Uint8Array;
  readonly declaration: BlobDeclaration;
  readonly hash: ContentHash;
}

async function content(text: string | Uint8Array, contentType = 'text/plain'): Promise<Content> {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const hash = contentHash(`sha256:${await hexDigest(bytes)}`);
  return { bytes, hash, declaration: { size: bytes.length, contentType, contentHash: hash } };
}

/** Redeem a grant exactly as a device would: the signed headers must be sent verbatim. */
function putViaGrant(uploadUrl: string, item: Content): Promise<Response> {
  return globalThis.fetch(uploadUrl, {
    method: 'PUT',
    body: item.bytes,
    headers: { 'content-type': item.declaration.contentType },
  });
}

/** The object's absolute URL, derived through core's key function — the same single point the store uses. */
function objectUrl(storage: ObjectStorageScope, tenant: TenantId, hash: ContentHash): string {
  return `${storage.config.endpoint}/${storage.bucket}/${tenantObjectKey(tenant, hash)}`;
}

/** Write bytes straight to a key with root credentials, bypassing every grant. */
async function plantBytes(
  storage: ObjectStorageScope,
  tenant: TenantId,
  hash: ContentHash,
  item: Content,
): Promise<void> {
  const response = await storage.client.fetch(objectUrl(storage, tenant, hash), {
    method: 'PUT',
    body: item.bytes,
    headers: { 'content-type': item.declaration.contentType },
  });
  expect(response.status, await response.text()).toBe(200);
}

async function expectCoreError(promise: Promise<unknown>, code: string): Promise<ByokCoreError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ByokCoreError);
  expect((error as ByokCoreError).code).toBe(code);
  return error as ByokCoreError;
}

/** The adapter's own refusals, which are deliberately not core codes. */
async function expectAdapterError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(R2BlobStoreError);
  expect((error as R2BlobStoreError).code).toBe(code);
}

describe.skipIf(SKIP_DATAPLANE)(`object suite [postgres + minio]${SKIP_DATAPLANE ? ` — ${SKIP_REASON}` : ''}`, () => {
  beforeAll(() => {
    // Every assertion below leans on MinIO answering for itself. If the
    // substrate were absent the suite would skip, not pass.
    expect(SKIP_DATAPLANE).toBe(false);
  });

  // 1 ------------------------------------------------------------------
  it('makes a re-declared upload a retry of the same pending object, never a second one', async () => {
    await withObjects(async ({ blobs, objects, storage }) => {
      const item = await content('duplicate me');

      const first = await blobs.createUpload(TENANT_A, item.declaration);
      const second = await blobs.createUpload(TENANT_A, item.declaration);

      // Same object, not a second one: the id IS the content hash, so a client
      // that re-declares the same bytes cannot create a parallel manifest row.
      // The grant is re-issued because `pending` is the interrupted-upload
      // state — that is what upload idempotence is for, and the only state it
      // is for.
      expect(second.blobId).toBe(first.blobId);
      expect(second.uploadUrl.startsWith(objectUrl(storage, TENANT_A, item.hash))).toBe(true);
      expect(await objects.list(TENANT_A, {})).toHaveLength(1);

      expect((await putViaGrant(first.uploadUrl, item)).status).toBe(200);
      expect(await blobs.getDownloadUrl(TENANT_A, first.blobId)).toBeDefined();
      expect((await objects.get(TENANT_A, item.hash))?.state).toBe('committed');

      // Re-declaring AFTER the commit is refused instead. Not because the row
      // would move — `putManifest` leaves a committed row exactly where it is —
      // but because the grant itself would be a fresh licence to write over
      // bytes a truth record is entitled to reference.
      await expectCoreError(blobs.createUpload(TENANT_A, item.declaration), 'object_state_invalid');
      expect((await objects.get(TENANT_A, item.hash))?.state).toBe('committed');
      expect(await objects.list(TENANT_A, {})).toHaveLength(1);
      // Refusing to re-authorize a WRITE is not withdrawing the object.
      expect(await blobs.getDownloadUrl(TENANT_A, first.blobId)).toBeDefined();
    });
  });

  it('keeps a committed object immutable against a same-shaped replacement', async () => {
    // Why the refusal above is a property and not bookkeeping: `Content-Length`
    // and `Content-Type` are what a grant binds, the digest is recomputed
    // nowhere, and so ANY body of the declared shape satisfies a PUT signed for
    // that key. A grant issued after the commit would make `sha256/<hex>` stop
    // meaning "the bytes here hash to <hex>" — §12.7.4's whole premise.
    await withObjects(async ({ blobs, objects, storage }) => {
      const item = await content('the vouched bytes');
      const grant = await blobs.createUpload(TENANT_A, item.declaration);
      expect((await putViaGrant(grant.uploadUrl, item)).status).toBe(200);
      expect(await blobs.getDownloadUrl(TENANT_A, grant.blobId)).toBeDefined();
      expect((await objects.get(TENANT_A, item.hash))?.state).toBe('committed');

      // Same length, same type, different bytes — a grant cannot tell them apart.
      const impostor = await content('the swapped bytes');
      expect(impostor.bytes.length).toBe(item.bytes.length);
      expect(impostor.declaration.contentType).toBe(item.declaration.contentType);
      expect(impostor.hash).not.toBe(item.hash);

      await expectCoreError(blobs.createUpload(TENANT_A, item.declaration), 'object_state_invalid');

      // Read back out of band: the claim is about the object store's contents,
      // not about the row this process wrote.
      const head = await storage.client.fetch(objectUrl(storage, TENANT_A, item.hash), { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(String(item.declaration.size));
      const body = await storage.client.fetch(objectUrl(storage, TENANT_A, item.hash));
      expect(await body.text()).toBe('the vouched bytes');
    });
  });

  // 2 ------------------------------------------------------------------
  it('rejects a declaration or an object whose size, hash, or type disagrees', async () => {
    await withObjects(async ({ blobs, objects, storage }) => {
      const item = await content('honest bytes');

      // (a) A digest that is not a canonical content address never becomes one.
      await expectCoreError(
        blobs.createUpload(TENANT_A, { ...item.declaration, contentHash: 'sha256:not-hex' }),
        'content_hash_invalid',
      );
      await expectCoreError(
        blobs.createUpload(TENANT_A, { ...item.declaration, contentHash: item.hash.toUpperCase() }),
        'content_hash_invalid',
      );

      // (b) A size that is not a byte count.
      await expectCoreError(
        blobs.createUpload(TENANT_A, { ...item.declaration, size: -1 }),
        'storage_integrity_mismatch',
      );

      // (c) The same hash re-declared under a different shape. Refused here,
      // rather than silently handed a URL signed for the FIRST declaration.
      await blobs.createUpload(TENANT_A, item.declaration);
      await expectCoreError(
        blobs.createUpload(TENANT_A, { ...item.declaration, size: item.declaration.size + 1 }),
        'storage_integrity_mismatch',
      );
      await expectCoreError(
        blobs.createUpload(TENANT_A, { ...item.declaration, contentType: 'application/json' }),
        'storage_integrity_mismatch',
      );

      // (d) What is actually AT the key disagrees with what was declared. The
      // bytes are planted with root credentials, so this is the case a signed
      // Content-Length cannot catch: it proves what one client sent, not what
      // is there now. HEAD re-verification is what catches it.
      const impostor = await content('a different length entirely', 'application/json');
      await plantBytes(storage, TENANT_A, item.hash, impostor);

      await expectCoreError(
        blobs.getDownloadUrl(TENANT_A, item.hash),
        'storage_integrity_mismatch',
      );
      // Still `pending`, so the GC worker can reclaim it. A `committed` row
      // here would be a truth record's licence to point at unvouched bytes.
      expect((await objects.get(TENANT_A, item.hash))?.state).toBe('pending');
    });
  });

  it('lets the object store refuse a body that is not the declared length or type', async () => {
    await withObjects(async ({ blobs }) => {
      const item = await content('exactly this');
      const grant = await blobs.createUpload(TENANT_A, item.declaration);

      // Both are in the signed headers, so MinIO — not this process — is what
      // rejects them, before a byte is stored.
      const longer = await content('exactly this, plus some more');
      expect((await putViaGrant(grant.uploadUrl, longer)).status).toBe(403);

      const retyped = await globalThis.fetch(grant.uploadUrl, {
        method: 'PUT',
        body: item.bytes,
        headers: { 'content-type': 'application/json' },
      });
      expect(retyped.status).toBe(403);
    });
  });

  // 3 ------------------------------------------------------------------
  it('binds a presign to one tenant and one key, adjudicated by MinIO', async () => {
    await withObjects(async ({ blobs, storage }) => {
      const item = await content('bound bytes');
      const grant = await blobs.createUpload(TENANT_A, item.declaration);

      // Re-point the same signed URL at another tenant's prefix. The path is
      // part of the canonical request, so the signature no longer covers it.
      const crossTenant = grant.uploadUrl.replace(
        tenantObjectKey(TENANT_A, item.hash),
        tenantObjectKey(TENANT_B, item.hash),
      );
      expect(crossTenant).not.toBe(grant.uploadUrl);
      const rejectedTenant = await putViaGrant(crossTenant, item);
      expect(rejectedTenant.status).toBe(403);
      expect(await rejectedTenant.text()).toContain('SignatureDoesNotMatch');

      // Same tenant, different object.
      const other = await content('some other bytes');
      const crossKey = grant.uploadUrl.replace(item.hash.slice('sha256:'.length), other.hash.slice('sha256:'.length));
      expect(crossKey).not.toBe(grant.uploadUrl);
      expect((await putViaGrant(crossKey, item)).status).toBe(403);

      // The grant still works for what it was minted for, so "everything 403s"
      // is not how this passes.
      expect((await putViaGrant(grant.uploadUrl, item)).status).toBe(200);
      expect(await storage.client.fetch(objectUrl(storage, TENANT_B, item.hash), { method: 'HEAD' })).toHaveProperty(
        'status',
        404,
      );
    });
  });

  // 4 ------------------------------------------------------------------
  it('lets MinIO refuse an expired presign', async () => {
    const anHourAgo: Clock = { now: () => new Date(Date.now() - 60 * 60 * 1000) };

    await withObjects(
      async ({ blobs }) => {
        const item = await content('too late');
        const grant = await blobs.createUpload(TENANT_A, item.declaration);

        const response = await putViaGrant(grant.uploadUrl, item);
        // Expiry is `X-Amz-Date + X-Amz-Expires`, evaluated by MinIO against
        // MinIO's clock. Backdating the signing clock is what makes this
        // deterministic instead of a sleep.
        expect(response.status).toBe(403);
        expect(await response.text()).toContain('Request has expired');
      },
      { signingClock: anHourAgo, presignTtlSeconds: 60 },
    );
  });

  it('mints an unexpired presign from the same store under a live clock', async () => {
    // The control for the assertion above: 60 seconds is not itself too short.
    await withObjects(
      async ({ blobs }) => {
        const item = await content('in time');
        const grant = await blobs.createUpload(TENANT_A, item.declaration);
        expect((await putViaGrant(grant.uploadUrl, item)).status).toBe(200);
      },
      { signingClock: wallClock, presignTtlSeconds: 60 },
    );
  });

  // 5 ------------------------------------------------------------------
  it('requires the object to exist before a truth record may reference it', async () => {
    await withObjects(async ({ blobs, objects }) => {
      const item = await content('referenced later');
      const grant = await blobs.createUpload(TENANT_A, item.declaration);

      // Declared, not uploaded: the manifest is `pending` and a reference is
      // refused transactionally, by the state machine and not by a probe.
      await expectCoreError(
        objects.addReference(TENANT_A, { hash: item.hash, refKind: 'truth', refId: 'record-1' }),
        'object_state_invalid',
      );

      expect((await putViaGrant(grant.uploadUrl, item)).status).toBe(200);
      // First download is what drives `pending -> committed`.
      expect(await blobs.getDownloadUrl(TENANT_A, grant.blobId)).toBeDefined();

      const referenced = await objects.addReference(TENANT_A, {
        hash: item.hash,
        refKind: 'truth',
        refId: 'record-1',
      });
      expect(referenced.state).toBe('committed');
      expect(referenced.refCount).toBe(1);
    });
  });

  // 6 ------------------------------------------------------------------
  it('never reads an object body: verification is HEAD, delivery is a redirect', async () => {
    const large = new Uint8Array(1024 * 1024);
    large.fill(7);
    const recorder = recordCalls();

    await withObjects(
      async ({ blobs, storage }) => {
        const item = await content(large, 'application/octet-stream');
        const grant = await blobs.createUpload(TENANT_A, item.declaration);
        expect((await putViaGrant(grant.uploadUrl, item)).status).toBe(200);

        const downloadUrl = await blobs.getDownloadUrl(TENANT_A, grant.blobId);
        expect(downloadUrl).toBeDefined();

        // A megabyte committed, and this process asked for exactly one HEAD.
        // There is no response size that can exhaust an adapter that never
        // reads a body — the limit is structural, not a configured ceiling.
        expect(recorder.attempts.map((attempt) => attempt.method)).toEqual(['HEAD']);

        // Range is the object store's to serve, straight to the caller.
        const ranged = await globalThis.fetch(downloadUrl as string, { headers: { range: 'bytes=0-1023' } });
        expect(ranged.status).toBe(206);
        expect((await ranged.arrayBuffer()).byteLength).toBe(1024);
        expect(ranged.headers.get('content-range')).toBe(`bytes 0-1023/${large.length}`);

        // And the whole object is still reachable at its own key, so the range
        // above narrowed a real object rather than describing a truncated one.
        const head = await storage.client.fetch(objectUrl(storage, TENANT_A, item.hash), { method: 'HEAD' });
        expect(head.headers.get('content-length')).toBe(String(large.length));
      },
      { fetch: recorder.fetch },
    );
  });

  // 7 ------------------------------------------------------------------
  it('cannot construct a key from anything that is not a content address', async () => {
    const recorder = recordCalls();

    await withObjects(
      async ({ blobs }) => {
        const traversals = [
          'sha256:../../../etc/passwd',
          'sha256:' + '../'.repeat(21) + 'x',
          '../../etc/passwd',
          `sha256:${'a'.repeat(63)}/`,
          'sha256:' + 'A'.repeat(64),
          `tenants/${TENANT_B}/objects/sha256/${'b'.repeat(64)}`,
        ];

        for (const candidate of traversals) {
          const item = await content('traversal attempt');
          // On the way in: a declaration carrying one dies at the mint, which
          // is upstream of every path to key construction.
          await expectCoreError(
            blobs.createUpload(TENANT_A, { ...item.declaration, contentHash: candidate }),
            'content_hash_invalid',
          );
          // On the way out: the same value is simply not a blob anyone has.
          expect(await blobs.getDownloadUrl(TENANT_A, candidate)).toBeUndefined();
        }

        // And not one of them produced a request. A traversal cannot be
        // refused by the object store if it never reaches the object store,
        // and it never does, because it cannot become a `ContentHash`.
        expect(recorder.attempts).toEqual([]);
      },
      { fetch: recorder.fetch },
    );
  });

  it('cannot construct a key from a tenant id that is not one safe segment', async () => {
    const recorder = recordCalls();

    await withObjects(
      async ({ blobs, objects, storage }) => {
        const item = await content('alias attempt');

        // The alias this guard exists for. `tenantId()` accepts `a/../b` — it
        // fails closed on empty, padded, over-long, and NUL-bearing ids and
        // deliberately normalizes nothing else, because normalizing would put
        // the SDK and the control plane in disagreement about an id's canonical
        // form. URL resolution then collapses the traversal, so unguarded these
        // two DIFFERENT tenants address ONE key.
        const aliased = tenantId(`${TENANT_A}/../${TENANT_B}`);
        expect(tenantObjectKey(aliased, item.hash)).not.toBe(tenantObjectKey(TENANT_B, item.hash));
        expect(new URL(objectUrl(storage, aliased, item.hash)).pathname).toBe(
          new URL(objectUrl(storage, TENANT_B, item.hash)).pathname,
        );

        const unsafe = [
          aliased,
          tenantId('..'),
          tenantId('.hidden'),
          tenantId('a/b'),
          tenantId('back\\slash'),
          tenantId('%2e%2e'),
          tenantId('a b'),
        ];

        for (const tenant of unsafe) {
          await expectAdapterError(blobs.createUpload(tenant, item.declaration), 'storage_tenant_key_unsafe');
          // Refused BEFORE the manifest: an id that can never address a key
          // does not get to reserve a row on the way to being told so.
          expect(await objects.get(tenant, item.hash)).toBeUndefined();
          // On the way out it is a stranger like any other.
          expect(await blobs.getDownloadUrl(tenant, item.hash)).toBeUndefined();
        }

        // And not one of them produced a request. A cross-tenant alias the
        // object store never hears about is one it cannot be talked into
        // serving, whatever its own path handling does.
        expect(recorder.attempts).toEqual([]);

        // The control: the tenant the alias was aiming at is unaffected, so
        // this passes by refusing the alias rather than by refusing everything.
        const grant = await blobs.createUpload(TENANT_B, item.declaration);
        expect((await putViaGrant(grant.uploadUrl, item)).status).toBe(200);
        expect(await blobs.getDownloadUrl(TENANT_B, grant.blobId)).toBeDefined();
      },
      { fetch: recorder.fetch },
    );
  });

  // 8 ------------------------------------------------------------------
  it('gives one tenant no way to learn another holds the same content', async () => {
    await withObjects(async ({ blobs, objects, storage }) => {
      const item = await content('shared bytes');

      const forA = await blobs.createUpload(TENANT_A, item.declaration);
      expect((await putViaGrant(forA.uploadUrl, item)).status).toBe(200);
      expect(await blobs.getDownloadUrl(TENANT_A, forA.blobId)).toBeDefined();

      // B declares the identical content. No dedupe: a separate manifest row
      // and a separate key, because the key embeds the tenant.
      const forB = await blobs.createUpload(TENANT_B, item.declaration);
      expect(forB.blobId).toBe(forA.blobId);
      expect(forB.uploadUrl).not.toBe(forA.uploadUrl);
      expect((await objects.get(TENANT_B, item.hash))?.state).toBe('pending');
      expect((await objects.get(TENANT_A, item.hash))?.state).toBe('committed');

      // B asks for a download of content A has already committed. The answer
      // is the same nothing B gets for content nobody ever declared.
      const neverDeclared = await content('nothing like it');
      const forSharedHash = await blobs.getDownloadUrl(TENANT_B, item.hash);
      const forUnknownHash = await blobs.getDownloadUrl(TENANT_B, neverDeclared.hash);
      expect(forSharedHash).toBeUndefined();
      expect(forSharedHash).toEqual(forUnknownHash);

      // Even holding B's grant, A's object is not reachable through it.
      const stolen = forB.uploadUrl.replace(
        tenantObjectKey(TENANT_B, item.hash),
        tenantObjectKey(TENANT_A, item.hash),
      );
      expect((await putViaGrant(stolen, item)).status).toBe(403);

      // A's object is byte-identical to before B ever appeared.
      const head = await storage.client.fetch(objectUrl(storage, TENANT_A, item.hash), { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(String(item.declaration.size));
    });
  });

  // 9 ------------------------------------------------------------------
  it('absorbs a transient object-store fault and commits exactly once', async () => {
    const script: FaultStep[] = [503, 'timeout'];
    const injector = injectFaults(script);

    await withObjects(
      async ({ blobs, objects }) => {
        const item = await content('flaky path');
        const grant = await blobs.createUpload(TENANT_A, item.declaration);
        expect((await putViaGrant(grant.uploadUrl, item)).status).toBe(200);

        const url = await blobs.getDownloadUrl(TENANT_A, grant.blobId);
        expect(url).toBeDefined();

        // Three attempts, in the scripted order, all HEAD. Retrying is only
        // safe because HEAD is idempotent — nothing that writes is retried.
        expect(injector.attempts.map((attempt) => attempt.outcome)).toEqual([503, 'timeout', 'pass']);
        expect(new Set(injector.attempts.map((attempt) => attempt.method))).toEqual(new Set(['HEAD']));

        const committed = await objects.get(TENANT_A, item.hash);
        expect(committed?.state).toBe('committed');
        expect(committed?.refCount).toBe(0);

        // A second call re-reads the committed row and issues no further HEAD:
        // the retries did not leave the state machine mid-transition.
        const attemptsBefore = injector.attempts.length;
        expect(await blobs.getDownloadUrl(TENANT_A, grant.blobId)).toBeDefined();
        expect(injector.attempts).toHaveLength(attemptsBefore);
        expect((await objects.get(TENANT_A, item.hash))?.updatedAt).toBe(committed?.updatedAt);
      },
      { fetch: injector.fetch, retryDelayMs: 1 },
    );
  });

  it('reports how many attempts a refusal actually cost', async () => {
    // `attempts` is the only field this error carries that separates a flapping
    // remote from a hard refusal, and the refusal is raised at the far end of
    // the retry loop — so the count has to come FROM the loop. Two transient
    // faults and then a 403: three attempts were spent, and an error saying
    // "1" would describe a request this adapter never made.
    const injector = injectFaults([503, 'timeout', 403]);

    await withObjects(
      async ({ blobs, objects }) => {
        const item = await content('refused after retrying');
        const grant = await blobs.createUpload(TENANT_A, item.declaration);
        expect((await putViaGrant(grant.uploadUrl, item)).status).toBe(200);

        const failure = await blobs.getDownloadUrl(TENANT_A, grant.blobId).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(failure).toBeInstanceOf(ObjectStoreRequestError);
        expect((failure as ObjectStoreRequestError).status).toBe(403);
        expect((failure as ObjectStoreRequestError).attempts).toBe(injector.attempts.length);
        expect(injector.attempts).toHaveLength(3);

        expect((await objects.get(TENANT_A, item.hash))?.state).toBe('pending');
      },
      { fetch: injector.fetch, retryDelayMs: 1 },
    );
  });

  it('gives up loudly when the fault outlives the retries, leaving the manifest pending', async () => {
    const injector = injectFaults([503, 503, 503]);

    await withObjects(
      async ({ blobs, objects }) => {
        const item = await content('never reachable');
        const grant = await blobs.createUpload(TENANT_A, item.declaration);
        expect((await putViaGrant(grant.uploadUrl, item)).status).toBe(200);

        const failure = await blobs.getDownloadUrl(TENANT_A, grant.blobId).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(failure).toBeInstanceOf(ObjectStoreRequestError);
        expect((failure as ObjectStoreRequestError).attempts).toBe(3);
        expect(injector.attempts).toHaveLength(3);

        // Fail closed: no URL, and the row is exactly where it was.
        expect((await objects.get(TENANT_A, item.hash))?.state).toBe('pending');
      },
      { fetch: injector.fetch, retryDelayMs: 1 },
    );
  });
});
