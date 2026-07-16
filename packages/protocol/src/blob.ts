import { z } from 'zod';

/**
 * Reference to a large payload that was pushed out-of-band (presigned PUT) or
 * is fetchable out-of-band (presigned GET), rather than inlined in an envelope.
 */
export const BlobRefSchema = z.object({
  blobId: z.string(),
  contentHash: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  url: z.string().optional(),
});

export type BlobRef = z.infer<typeof BlobRefSchema>;
