/**
 * Blob flows (§7).
 *
 * Two route classes on purpose: `POST /byok/blobs` and `GET
 * /byok/blobs/:id/url` are bearer-authed and therefore tenant-closed (a
 * download URL is minted only for a blob the caller's own tenant owns, and a
 * foreign blob is indistinguishable from a missing one); the two `/content`
 * routes are presigned, because they are meant to be hit directly — by a
 * browser, by a `PUT` from a daemon that holds only the signed URL — with no
 * JWT in scope at all. The HMAC signature over the blob id plus its expiry IS
 * the credential there, which is why those two carry the `presigned` class in
 * the route inventory rather than being lumped in with the device routes.
 *
 * The split runs all the way down: the bearer-authed pair reaches blobs only
 * through the tenant facade and never holds a naked store, and the presigned
 * pair holds only a {@link BlobContentProxy} and no bearer deps. A composition
 * without a proxy does not mount them (`cloud.ts`).
 */
import type { Context } from 'hono';
import { z } from 'zod';
import {
  CreateBlobRequestSchema,
  type BlobDownloadUrlResponse,
  type CreateBlobResponse,
} from '@byok-sdk/protocol';
import {
  STORAGE_ERROR_CODES,
  STORAGE_ERROR_HTTP_STATUS,
  contentHash,
  isCoreError,
  type StorageErrorCode,
} from '@byok-sdk/core';
import type { BlobContentProxy, BlobReadErrorCode } from '../stores/ports';
import { authenticateDevice, readJsonBody, type DeviceRouteDeps } from './shared';

/** The three bearer-authed routes: everything they touch goes through the tenant facade. */
export interface BlobRouteDeps extends DeviceRouteDeps {
  readonly maxBlobSizeBytes: number;
}

/** Reservation and presign grants deliberately share one expiry horizon. */
export const BLOB_RESERVATION_TTL_MS = 15 * 60 * 1000;

/**
 * The two presigned routes. No bearer deps at all — there is no principal to
 * build a facade from, and the proxy is the only thing they need.
 */
export interface BlobContentRouteDeps {
  readonly contentProxy: BlobContentProxy;
}

/**
 * The presigned query contract. Cloud-owned (the wire DTO package covers
 * request/response BODIES, not URL signing), and validated rather than
 * hand-parsed so a non-numeric `exp` is a failed verification instead of a
 * `NaN` comparison that quietly answers `false` for the wrong reason.
 */
const SignedUrlQuerySchema = z.object({
  sig: z.string().min(1),
  exp: z.coerce.number().finite(),
});

export function createBlobHandler(deps: BlobRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);

    const parsed = CreateBlobRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'size, contentType, and contentHash are required' }, 400);
    if (parsed.data.size > deps.maxBlobSizeBytes) {
      return c.json({ error: `blob exceeds max size of ${deps.maxBlobSizeBytes} bytes` }, 413);
    }

    const reservationId = idempotencyKey(c);
    if (reservationId === undefined) {
      return c.json({ error: 'Idempotency-Key header is required' }, 400);
    }

    try {
      const reservation = await authenticated.stores.quota.reserve({
        reservationId,
        kind: 'object',
        expectedBytes: BigInt(parsed.data.size),
        contentHash: contentHash(parsed.data.contentHash),
        contentType: parsed.data.contentType,
        ttlMs: BLOB_RESERVATION_TTL_MS,
      });
      try {
        const { blobId, uploadUrl } = await authenticated.stores.blobs.createUpload(reservation);
        const response: CreateBlobResponse = { blobId, uploadUrl };
        return c.json(response, 200);
      } catch (error) {
        // Preserve the grant failure as the client-facing authority. Cleanup
        // is best-effort here; admission reaps an abandoned hold after TTL if
        // the store is concurrently unavailable.
        await authenticated.stores.quota.abortReservation(reservationId).catch(() => undefined);
        const rendered = renderStorageError(c, error);
        if (rendered !== undefined) return rendered;
        throw error;
      }
    } catch (error) {
      const rendered = renderStorageError(c, error);
      if (rendered !== undefined) return rendered;
      throw error;
    }
  };
}

export function finalizeBlobHandler(deps: BlobRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);

    const reservationId = idempotencyKey(c);
    if (reservationId === undefined) {
      return c.json({ error: 'Idempotency-Key header is required' }, 400);
    }

    try {
      const reservation = await authenticated.stores.quota.readReservation(reservationId);
      if (reservation === undefined) {
        return c.json({ error: 'storage_reservation_not_found' }, 404);
      }
      const blobId = c.req.param('id') ?? '';
      const observed = await authenticated.stores.blobs.observeUpload(
        blobId,
        reservation,
      );
      if (observed === undefined) {
        await authenticated.stores.quota.abortReservation(reservationId);
        return c.json({ error: 'storage_integrity_mismatch' }, 422);
      }

      await authenticated.stores.quota.finalizeReservation({
        reservationId,
        ...observed,
      });
      return c.body(null, 204);
    } catch (error) {
      const rendered = renderStorageError(c, error);
      if (rendered !== undefined) return rendered;
      throw error;
    }
  };
}

export function blobDownloadUrlHandler(deps: BlobRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);

    const downloadUrl = await authenticated.stores.blobs.getDownloadUrl(c.req.param('id') ?? '');
    if (downloadUrl === undefined) return c.json({ error: 'blob not found' }, 404);

    const response: BlobDownloadUrlResponse = { downloadUrl };
    return c.json(response, 200);
  };
}

export function blobUploadContentHandler(deps: BlobContentRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const blobId = c.req.param('id') ?? '';
    const query = SignedUrlQuerySchema.safeParse({ sig: c.req.query('sig'), exp: c.req.query('exp') });
    if (!query.success || !(await deps.contentProxy.verifySignedUrl(blobId, 'put', query.data.sig, query.data.exp))) {
      return c.json({ error: 'invalid or expired signature' }, 401);
    }

    const result = await deps.contentProxy.writeContent(blobId, new Uint8Array(await c.req.arrayBuffer()));
    if (!result.ok) return c.json({ error: result.reason }, 422);
    return c.body(null, 204);
  };
}

export function blobDownloadContentHandler(deps: BlobContentRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const blobId = c.req.param('id') ?? '';
    const query = SignedUrlQuerySchema.safeParse({ sig: c.req.query('sig'), exp: c.req.query('exp') });
    if (!query.success || !(await deps.contentProxy.verifySignedUrl(blobId, 'get', query.data.sig, query.data.exp))) {
      return c.json({ error: 'invalid or expired signature' }, 401);
    }

    const result = await deps.contentProxy.readContent(blobId);
    if (result === undefined) return c.json({ error: 'blob not found' }, 404);
    if (!result.ok) return c.json({ error: result.code }, BLOB_READ_ERROR_HTTP_STATUS[result.code]);
    return c.body(new Uint8Array(result.content.data), 200, { 'content-type': result.content.contentType });
  };
}

/**
 * Both read failures are 502: from the wire's point of view an upstream that
 * never answered and one that died mid-response are the same class of fault —
 * this gateway could not deliver bytes it does not own. The distinction lives
 * in the response body's `error` code (a truncated transfer is not a retry-safe
 * no-op), not in the status, so a client's status-based handling stays a
 * two-way split — 404 missing / 502 upstream — while an operator reading the
 * body still learns which half failed.
 */
const BLOB_READ_ERROR_HTTP_STATUS: Record<BlobReadErrorCode, 502> = {
  blob_upstream_unavailable: 502,
  blob_upstream_stream_interrupted: 502,
};

function idempotencyKey(c: Context): string | undefined {
  const value = c.req.header('Idempotency-Key');
  if (value === undefined || value.length === 0 || value.length > 200) return undefined;
  return value;
}

function renderStorageError(c: Context, error: unknown): Response | undefined {
  if (!isCoreError(error)) return undefined;
  if ((STORAGE_ERROR_CODES as readonly string[]).includes(error.code)) {
    const code = error.code as StorageErrorCode;
    return c.json({ error: code }, STORAGE_ERROR_HTTP_STATUS[code]);
  }
  if (error.code === 'storage_reservation_not_found' || error.code === 'object_not_found') {
    return c.json({ error: error.code }, 404);
  }
  if (error.code === 'storage_entitlement_missing' || error.code === 'object_state_invalid') {
    return c.json({ error: error.code }, 409);
  }
  if (error.code === 'content_hash_invalid') {
    return c.json({ error: error.code }, 400);
  }
  return undefined;
}
