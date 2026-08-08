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
} from '@byok/protocol';
import type { BlobContentProxy } from '../stores/ports';
import { authenticateDevice, readJsonBody, type DeviceRouteDeps } from './shared';

/** The two bearer-authed routes: everything they touch goes through the tenant facade. */
export interface BlobRouteDeps extends DeviceRouteDeps {
  readonly maxBlobSizeBytes: number;
}

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

    const { blobId, uploadUrl } = await authenticated.stores.blobs.createUpload(parsed.data);
    const response: CreateBlobResponse = { blobId, uploadUrl };
    return c.json(response, 200);
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

    const content = await deps.contentProxy.readContent(blobId);
    if (content === undefined) return c.json({ error: 'blob not found' }, 404);
    return c.body(new Uint8Array(content.data), 200, { 'content-type': content.contentType });
  };
}
