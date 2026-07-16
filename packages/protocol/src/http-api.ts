import { z } from 'zod';
import { CONTENT_HASH_RE } from './blob';
import { EnvelopeSchema } from './envelope';

/**
 * HTTP-side request/response shapes for the reference server's auth and blob
 * endpoints (M1 Part B). These are plain HTTP bodies, not wire envelopes —
 * kept in a separate module from `envelope.ts`/`messages.ts` because they
 * never travel over the WSS connection. Documented in full in
 * docs/protocol.md ("Auth flows", "Blob flows", "Long-poll fallback").
 *
 * The wire protocol version (`v:1`) is unaffected by any of this: pairing,
 * token renewal, and blob transfer are out-of-band HTTP calls that happen
 * before/alongside the WSS connection, not envelope types.
 */

// ---------------------------------------------------------------------------
// POST /byok/pair (v2) — one-time device pairing. An out-of-band pairing
// code (minted by the SaaS's own auth/device-flow UI) plus a freshly
// generated Ed25519 device keypair (private key never leaves the device)
// register the device and mint its first access token.
// ---------------------------------------------------------------------------

export const PairRequestSchema = z.object({
  pairingCode: z.string(),
  deviceName: z.string(),
  /** Ed25519 public key, base64url-encoded. Private key stays device-local (OS keychain or 0600 file). */
  devicePublicKey: z.string(),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.object({
  deviceId: z.string(),
  /** JWT, ~1h lifetime. */
  accessToken: z.string(),
  /** Opaque hint for when/how to renew (e.g. an ISO timestamp); not itself a credential. */
  refreshHint: z.string().optional(),
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

// ---------------------------------------------------------------------------
// POST /byok/challenge + POST /byok/token — token renewal without re-pairing.
// Two-step challenge/response proves possession of the device private key
// without ever transmitting it: the server hands out a one-time nonce, the
// client signs it locally with the device key, and trades the signature for
// a fresh access token.
// ---------------------------------------------------------------------------

export const ChallengeRequestSchema = z.object({
  deviceId: z.string(),
});
export type ChallengeRequest = z.infer<typeof ChallengeRequestSchema>;

export const ChallengeResponseSchema = z.object({
  /** One-time value the client must sign with its device private key. */
  nonce: z.string(),
});
export type ChallengeResponse = z.infer<typeof ChallengeResponseSchema>;

export const TokenRequestSchema = z.object({
  deviceId: z.string(),
  nonce: z.string(),
  /** Ed25519 signature over `nonce`, base64url-encoded. */
  signature: z.string(),
});
export type TokenRequest = z.infer<typeof TokenRequestSchema>;

export const TokenResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

/**
 * Revocation is server-side only (dashboard/API call on the SaaS's own
 * device registry) — there is no wire message for it. A revoked device's
 * next `/byok/challenge` or `/byok/token` call (or WSS connect) gets a 401;
 * the daemon's only recourse is to re-run `/byok/pair` from scratch.
 */

// ---------------------------------------------------------------------------
// Blob endpoints — presigned upload/download. Authed (bearer access token).
// `BlobRef` (`blob.ts`) is unchanged; these are the HTTP calls that produce
// the presigned URLs a `BlobRef` points at.
// ---------------------------------------------------------------------------

/** POST /byok/blobs request: declare a blob before uploading it. `contentHash` must be the canonical `sha256:<64 lowercase hex>` form (finding F9) — the server rejects anything else outright, no normalization. */
export const CreateBlobRequestSchema = z.object({
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  contentHash: z.string().regex(CONTENT_HASH_RE, 'contentHash must be "sha256:<64 lowercase hex>"'),
});
export type CreateBlobRequest = z.infer<typeof CreateBlobRequestSchema>;

/** POST /byok/blobs response: presigned PUT target for the declared blob. */
export const CreateBlobResponseSchema = z.object({
  blobId: z.string(),
  uploadUrl: z.string(),
});
export type CreateBlobResponse = z.infer<typeof CreateBlobResponseSchema>;

/** GET /byok/blobs/:id/url response: presigned GET target for an existing blob. */
export const BlobDownloadUrlResponseSchema = z.object({
  downloadUrl: z.string(),
});
export type BlobDownloadUrlResponse = z.infer<typeof BlobDownloadUrlResponseSchema>;

// ---------------------------------------------------------------------------
// GET /byok/events?cursor=N — long-poll fallback for environments where WSS
// is unavailable. Authed; holds the request open ~50s waiting for new
// events, same at-least-once/cursor semantics as the WSS redelivery path
// (see docs/protocol.md "At-least-once delivery").
// ---------------------------------------------------------------------------

export const EventsPollQuerySchema = z.object({
  /** Last `seq` this client has seen; omitted on a client's first-ever poll. Never negative — `seq` is a monotonically increasing counter starting at 1. */
  cursor: z.number().int().nonnegative().optional(),
});
export type EventsPollQuery = z.infer<typeof EventsPollQuerySchema>;

export const EventsPollResponseSchema = z.object({
  events: z.array(EnvelopeSchema),
  cursor: z.number().int(),
});
export type EventsPollResponse = z.infer<typeof EventsPollResponseSchema>;

// ---------------------------------------------------------------------------
// POST /byok/messages — finding F6: long-poll is now a full transport, not
// receive-only. While a device is long-polling for S->D traffic (§8), it has
// no live WS to carry its own D->S envelopes (task.claim, task.progress,
// task.complete, etc.) — this endpoint is that path: a batch of envelopes,
// authed the same way as every other bearer-authed route, routed through the
// identical inbound handling a WS connection's messages get. See
// docs/protocol.md §8.
// ---------------------------------------------------------------------------

/** Batch size ceiling for a single `POST /byok/messages` call — generous for normal redelivery-catchup bursts, but bounded so one request can't force the server to process an unbounded batch. */
const MAX_MESSAGES_PER_BATCH = 256;

export const MessagesSendRequestSchema = z.object({
  messages: z.array(EnvelopeSchema).max(MAX_MESSAGES_PER_BATCH),
});
export type MessagesSendRequest = z.infer<typeof MessagesSendRequestSchema>;

/**
 * `accepted` counts every envelope `ConnectionHub.handleInbound` returned
 * `'accepted'` *or* `'duplicate'` for (finding P2) — a dedup'd replay is a
 * wire-level success (§9's idempotency window), even though no handler ran
 * for it a second time. `rejected` (a type outside `DAEMON_TO_SERVER_TYPES`,
 * or an ownership mismatch — N2) is a separate, additive count: omitted
 * entirely when zero, so a batch with nothing rejected keeps the pre-P2
 * `{ accepted }` shape callers already depend on.
 */
export const MessagesSendResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative().optional(),
});
export type MessagesSendResponse = z.infer<typeof MessagesSendResponseSchema>;
