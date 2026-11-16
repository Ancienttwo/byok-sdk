import { z } from 'zod';

/**
 * Canonical `contentHash` format (finding F9): `sha256:` followed by exactly
 * 64 lowercase hex characters (a SHA-256 digest). Pinned here — the single
 * source of truth both `BlobRefSchema` and `CreateBlobRequestSchema`
 * (`http-api.ts`) validate against. Hashes have exactly one transport form;
 * receivers never normalize another prefix or casing.
 */
export const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Reference to a large payload that was pushed out-of-band (presigned PUT) or
 * is fetchable out-of-band (presigned GET), rather than inlined in an envelope.
 */
export const BlobRefSchema = z.object({
  blobId: z.string(),
  contentHash: z.string().regex(CONTENT_HASH_RE, 'contentHash must be "sha256:<64 lowercase hex>"'),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  url: z.string().optional(),
});

export type BlobRef = z.infer<typeof BlobRefSchema>;
