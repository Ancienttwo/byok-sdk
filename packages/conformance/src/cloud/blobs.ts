/**
 * The blobs dimension: the two-method grant port, certified across
 * compositions that disagree about almost everything else.
 *
 * What every composition here owes is narrow on purpose. The in-memory
 * reference mints an opaque `blob_<uuid>` and keeps the bytes in a `Map`; the
 * Postgres+R2 composition mints the content hash itself and the bytes live in
 * an object store it never reads. Nothing about ids, URL shapes, or storage is
 * assertable in common — so nothing about them is asserted. What IS common is
 * the contract that matters: a grant is minted for a declaration, a download
 * URL exists only once bytes are actually there, no second write grant is
 * issued for an object whose bytes already landed, and every miss looks like
 * every other miss.
 *
 * Anything sharper belongs to a composition, not here. SigV4 acceptance, HEAD
 * re-verification, and transient-error behavior are Postgres+R2 facts and live
 * in that package's own suite — the same placement the concurrency assertions
 * got. A dimension that needed `if (composition === ...)` would be evidence the
 * port contract is wrong; escalate, do not branch.
 */
import { describe, expect, it } from 'vitest';
import type { BlobDeclaration, BlobObservation } from '@byok/cloud';
import type { StorageReservation, TenantId } from '@byok/core';
import { TENANT_A, TENANT_B } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

/**
 * A declaration whose `contentHash` is the real digest of `text`.
 *
 * Real rather than a literal because a composition is entitled to derive its
 * key from the hash, and a made-up digest would then address bytes that can
 * never exist under it.
 */
async function declarationFor(text: string, contentType = 'text/plain'): Promise<BlobDeclaration> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { size: bytes.length, contentType, contentHash: `sha256:${hex}` };
}

function reservationFor(
  tenant: TenantId,
  declaration: BlobDeclaration,
  reservationId: string,
): StorageReservation {
  return {
    tenantId: tenant,
    reservationId,
    state: 'reserved',
    kind: 'object',
    expectedBytes: BigInt(declaration.size),
    contentHash: declaration.contentHash as StorageReservation['contentHash'],
    contentType: declaration.contentType,
    createdAt: '2026-08-08T00:00:00.000Z',
    expiresAt: '2026-08-08T01:00:00.000Z',
  };
}

function requireObservation(value: BlobObservation | undefined): BlobObservation {
  if (value === undefined) throw new Error('uploaded blob was not observable');
  return value;
}

export function runBlobConformance(factory: CloudCompositionFactory): void {
  describe('blobs', () => {
    it('mints an upload grant for a declaration', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const declaration = await declarationFor('one');
        const grant = await stores.blobs.createUpload(
          TENANT_A,
          reservationFor(TENANT_A, declaration, 'res-one'),
        );

        expect(typeof grant.blobId).toBe('string');
        expect(grant.blobId.length).toBeGreaterThan(0);
        expect(typeof grant.uploadUrl).toBe('string');
        expect(grant.uploadUrl.length).toBeGreaterThan(0);
      });
    });

    it('has no download URL for a declaration whose bytes never landed', async () => {
      // The committed-only rule, in the only form both compositions can state
      // it: declaring an object is not the same as having one. A composition
      // that handed out a GET here would be promising bytes nobody uploaded.
      await withCloudComposition(factory, async ({ stores }) => {
        const declaration = await declarationFor('declared only');
        const grant = await stores.blobs.createUpload(
          TENANT_A,
          reservationFor(TENANT_A, declaration, 'res-declared'),
        );

        expect(await stores.blobs.getDownloadUrl(TENANT_A, grant.blobId)).toBeUndefined();
      });
    });

    it('answers a foreign id exactly as it answers an unknown one', async () => {
      // Not "returns undefined for both" — IDENTICALLY. A difference of any
      // kind between the two would let one tenant test another's contents by
      // guessing ids, which is the existence oracle §12.7.4 forbids.
      await withCloudComposition(factory, async ({ stores }) => {
        const declaration = await declarationFor('a only');
        const grant = await stores.blobs.createUpload(
          TENANT_A,
          reservationFor(TENANT_A, declaration, 'res-a'),
        );

        const foreign = await stores.blobs.getDownloadUrl(TENANT_B, grant.blobId);
        const unknown = await stores.blobs.getDownloadUrl(TENANT_B, 'sha256:' + 'f'.repeat(64));
        const malformed = await stores.blobs.getDownloadUrl(TENANT_B, 'not-a-blob-id');

        expect(foreign).toBeUndefined();
        expect(foreign).toEqual(unknown);
        expect(foreign).toEqual(malformed);
      });
    });

    it('gives two declarations in one tenant two grants', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const firstDeclaration = await declarationFor('first');
        const secondDeclaration = await declarationFor('second');
        const first = await stores.blobs.createUpload(
          TENANT_A,
          reservationFor(TENANT_A, firstDeclaration, 'res-first'),
        );
        const second = await stores.blobs.createUpload(
          TENANT_A,
          reservationFor(TENANT_A, secondDeclaration, 'res-second'),
        );

        expect(first.blobId).not.toEqual(second.blobId);
        expect(first.uploadUrl).not.toEqual(second.uploadUrl);
      });
    });

    it('stops authorizing writes to an object once its bytes are there', async () => {
      // Immutability, in the form both compositions can state it. Bytes that
      // are downloadable are bytes something is entitled to reference, and a
      // write grant binds a length and a type while recomputing no digest — so
      // a grant re-issued for THAT object is a licence to replace them with
      // any same-shaped body, and the content address stops being one.
      //
      // How a composition satisfies it is its own business, and the two differ:
      // one mints an opaque id per declaration and simply never re-addresses a
      // landed object, the other addresses objects BY content hash and must
      // therefore refuse. Both outcomes are "no second write grant for this
      // object", which is the contract; neither shape is asserted.
      await withCloudComposition(factory, async ({ stores, landBlobBytes, commitBlob }) => {
        const text = 'vouched for';
        const declaration = await declarationFor(text);
        const reservation = reservationFor(TENANT_A, declaration, 'res-vouched');
        const grant = await stores.blobs.createUpload(TENANT_A, reservation);
        await landBlobBytes({
          grant,
          declaration,
          reservation,
          bytes: new TextEncoder().encode(text),
        });

        const observation = requireObservation(
          await stores.blobs.observeUpload(TENANT_A, grant.blobId, reservation),
        );
        expect(observation).toEqual({
          observedByteSize: BigInt(declaration.size),
          observedContentType: declaration.contentType,
        });
        // Landing bytes is not a hidden commit. Only explicit finalization may
        // make the object downloadable.
        expect(await stores.blobs.getDownloadUrl(TENANT_A, grant.blobId)).toBeUndefined();
        await commitBlob(TENANT_A, reservation, observation);

        expect(await stores.blobs.getDownloadUrl(TENANT_A, grant.blobId)).toBeDefined();

        const reissued = await stores.blobs
          .createUpload(TENANT_A, reservationFor(TENANT_A, declaration, 'res-reissue'))
          .then(
            (second) => second.blobId,
            () => undefined,
          );
        expect(reissued).toBeUndefined();

        // And the object stayed readable throughout: withholding a write grant
        // is not the same as withdrawing the object.
        expect(await stores.blobs.getDownloadUrl(TENANT_A, grant.blobId)).toBeDefined();
      });
    });

    it('scopes the upload destination to the tenant, even for identical content', async () => {
      // Two tenants declaring byte-identical content get two independent
      // destinations. Deduplicating across tenants would store one copy whose
      // presence either tenant could infer — better compression, and a
      // cross-tenant oracle.
      await withCloudComposition(factory, async ({ stores }) => {
        const declaration = await declarationFor('the same bytes');
        const forA = await stores.blobs.createUpload(
          TENANT_A,
          reservationFor(TENANT_A, declaration, 'res-a'),
        );
        const forB = await stores.blobs.createUpload(
          TENANT_B,
          reservationFor(TENANT_B, declaration, 'res-b'),
        );

        expect(forA.uploadUrl).not.toEqual(forB.uploadUrl);
      });
    });
  });
}
