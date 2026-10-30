import { z } from 'zod';
import { PROTOCOL_VERSION } from './version';
import { CONTENT_HASH_RE } from './blob';
import {
  AgentRefSchema,
  ConfiguredToolsetsSchema,
  ProtocolVersionNumberSchema,
  RuntimeCapabilitiesSchema,
  RuntimeIdSchema,
  AgentHomeProjectionAgentRefSchema,
} from './messages';
import {
  InputPreparationProfileIdSchema,
  InputPreparationPolicyRevisionSchema,
  InputPreparationReceiptSummarySchema,
  InputPreparationRejectionReasonSchema,
} from './input-preparation';
import {
  AgentHomeProjectionHashSchema,
  AgentHomeProjectionOutcomeSchema,
} from './agent-home-projection';
import {
  AgentMemoryProjectionMutationSchema,
  AgentMemoryProjectionReceiptSchema,
} from './agent-memory-projection';

/**
 * HTTP-side request/response shapes for the reference server's auth and blob
 * endpoints (M1 Part B). These are plain HTTP bodies, not wire envelopes —
 * kept in a separate module from `envelope.ts`/`messages.ts` because they
 * are HTTP request/response bodies rather than mailbox envelopes. Documented
 * in full in docs/protocol.md ("Auth flows", "Blob flows", "Long-poll").
 *
 * The wire protocol version (`v:1`) is unaffected by any of this: pairing,
 * token renewal, and blob transfer are separate HTTP calls around the
 * long-poll mailbox lifecycle, not envelope types.
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
  /**
   * Optional client-hashed physical machine identity: lowercase hex SHA-256 of
   * the product id and an OS-provided machine identifier, never the raw
   * identifier itself. It names no tenant and no product — those still come
   * only from the redeemed pairing code's claims — so it can only ever
   * supersede the SAME tenant/product's prior active device rows carrying this
   * exact digest. A client that cannot resolve one omits the field entirely.
   */
  machineId: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

/**
 * The authenticated tenant projection is opaque to the wire protocol. It is
 * bounded so a malformed control-plane value cannot become an unbounded local
 * key prefix, while deliberately imposing no product-specific format.
 *
 * Keep these runtime checks aligned with `@byok-sdk/core`'s TenantId mint
 * point: trimming or normalizing here would make the response disagree with
 * the authenticated device row that authored it.
 */
export const PAIR_RESPONSE_TENANT_ID_MAX_LENGTH = 200;
export const PairResponseTenantIdSchema = z
  .string()
  .min(1)
  .max(PAIR_RESPONSE_TENANT_ID_MAX_LENGTH)
  .refine((value) => value.trim() === value, {
    message: 'tenantId must not have leading or trailing whitespace',
  })
  .refine((value) => !value.includes('\u0000'), {
    message: 'tenantId must not contain a NUL character',
  });

export const PairResponseSchema = z.object({
  deviceId: z.string(),
  /** JWT, ~1h lifetime. */
  accessToken: z.string(),
  /** Opaque hint for when/how to renew (e.g. an ISO timestamp); not itself a credential. */
  refreshHint: z.string().optional(),
  /**
   * Lifetime of `accessToken` in seconds, relative to when the device receives
   * this response. The device-side lifetime authority (#1114): a device never
   * compares a server timestamp with its own clock. Optional on the wire
   * because published v4 hosts omit it; the client requires it.
   */
  expiresIn: z.number().int().positive().optional(),
  /** Exact opaque, non-secret tenant binding from the authenticated device row. */
  tenantId: PairResponseTenantIdSchema,
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
  /** Absolute server-clock expiry. Kept for published devices; current devices derive lifetime from `expiresIn`. */
  expiresAt: z.iso.datetime({ offset: true }),
  /**
   * Lifetime of `accessToken` in seconds, relative to when the device receives
   * this response (#1114). Optional on the wire because published v4 hosts
   * omit it; the client requires it.
   */
  expiresIn: z.number().int().positive().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

/**
 * The one typed `401` body of `/byok/challenge` and `/byok/token`: the device
 * id resolves to no registration (§6.3). Revocation deletes the registration,
 * so an unknown device and a revoked one answer with this same body and stay
 * indistinguishable. Every other `401` on these routes (bad signature, used
 * or expired nonce) stays untyped, and a client must not read it as
 * revocation.
 */
export const DEVICE_NOT_REGISTERED_CODE = 'device_not_registered';
export const DeviceNotRegisteredResponseSchema = z.object({
  error: z.string(),
  code: z.literal(DEVICE_NOT_REGISTERED_CODE),
});
export type DeviceNotRegisteredResponse = z.infer<typeof DeviceNotRegisteredResponseSchema>;

// ---------------------------------------------------------------------------
// PUT /byok/presence — first-hop daemon observation. The body carries only
// facts captured by the daemon's frozen start snapshot; omitted release,
// runtime, and auth fields remain unknown rather than guessed.
// ---------------------------------------------------------------------------

/** The hosted default is byte-bounded independently; this caps protocol input before it reaches a handler. */
export const PRESENCE_DETAIL_MAX_LENGTH = 512;
export const PRESENCE_RUNTIME_VERSION_MAX_LENGTH = 128;

/**
 * Presence is a readiness observation. It retains only the facts the cloud
 * persists and bounds every string/array/numeric input at this public request
 * boundary. `capabilities` is the same capability matrix `conn.hello` reports
 * for the runtime (#1103), so a Host can read it before dispatch.
 */
const PresenceRuntimeFactSchema = z.object({
  id: RuntimeIdSchema,
  version: z.string().min(1).max(PRESENCE_RUNTIME_VERSION_MAX_LENGTH).optional(),
  authPresent: z.boolean().optional(),
  capabilities: RuntimeCapabilitiesSchema.optional(),
});

export const PresencePublishRequestSchema = z.object({
  level: z.enum(['online', 'thinking', 'working', 'error', 'offline']),
  detail: z.string().max(PRESENCE_DETAIL_MAX_LENGTH).optional(),
  configuredToolsets: ConfiguredToolsetsSchema.optional(),
  /** U4a Local Agent release version; never inferred from a host package. */
  clientVersion: z.string().min(1).max(128).optional(),
  protocolVersions: z.array(ProtocolVersionNumberSchema).max(16).optional(),
  /** Runtime version/auth facts from the same real probe as conn.hello. */
  runtimes: z.array(PresenceRuntimeFactSchema).max(16).optional(),
});
export type PresencePublishRequest = z.infer<typeof PresencePublishRequestSchema>;

/**
 * Revocation is server-side only (dashboard/API call on the SaaS's own
 * device registry) — there is no wire message for it. A revoked device's
 * next `/byok/challenge`, `/byok/token`, or authenticated mailbox call gets a 401;
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
// GET /byok/events?cursor=N — the daemon's authenticated receive transport.
// Holds the request open ~50s waiting for new events and uses the mailbox's
// at-least-once/cursor semantics (see docs/protocol.md "At-least-once delivery").
// ---------------------------------------------------------------------------

export const EventsPollQuerySchema = z.object({
  /** Volatile navigation within the advertised read-ahead window; never acknowledges work. */
  afterSeq: z.number().int().nonnegative().optional(),
  /** Last reliably processed seq; the only acknowledgement. Omitted on the first poll. */
  cursor: z.number().int().nonnegative().optional(),
});
export type EventsPollQuery = z.infer<typeof EventsPollQuerySchema>;

/**
 * Deployment-owned activity limits. A v3 responder advertises them on every
 * events page and on every answer whose `conn.hello` it accepted; there is no
 * client-side default.
 */
export const ActivityIngressSchema = z.object({
  activityMaxEvents: z.number().int().positive(),
  activityMaxBytes: z.number().int().min(2),
});
export type ActivityIngress = z.infer<typeof ActivityIngressSchema>;
export const OUTBOUND_REFUSAL_REASONS = ['payload_invalid', 'not_permitted', 'limit_exceeded', 'state_conflict', 'unsupported'] as const;
/** `unknown` is an unrecognized wire reason string, kept as an observation. */
export type OutboundRefusalReason = typeof OUTBOUND_REFUSAL_REASONS[number] | 'unknown';
function isOutboundRefusalCode(value: string): value is typeof OUTBOUND_REFUSAL_REASONS[number] {
  return (OUTBOUND_REFUSAL_REASONS as readonly string[]).includes(value);
}
export const MessageSendOutcomeSchema = z.object({
  id: z.uuid(),
  outcome: z.enum(['accepted', 'duplicate', 'rejected']),
  /** Decodes to an {@link OutboundRefusalReason}; an unrecognized string becomes `unknown`. */
  reason: z.string().max(64).transform((value): OutboundRefusalReason => (isOutboundRefusalCode(value) ? value : 'unknown')).optional(),
});
export type MessageSendOutcome = z.infer<typeof MessageSendOutcomeSchema>;

export const EventsPollResponseSchema = z.object({
  /**
   * Not-yet-decoded entries (#386). This schema decodes the page only; each
   * entry is decoded on its own with `parseMessage`, so one unknown or invalid
   * entry stalls its own sequence instead of failing every entry in the page.
   */
  events: z.array(z.unknown()),
  cursor: z.number().int(),
  /**
   * Required: the server capabilities for THIS long-poll response. Each page
   * replaces the daemon's advertisement; an empty list advertises nothing.
   */
  capabilities: z.array(z.string()),
  /** Required in v3: the activity limits that apply to new progress pushes. */
  ingress: ActivityIngressSchema,
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

/**
 * Batch size ceiling for a single `POST /byok/messages` call — generous for
 * normal redelivery-catchup bursts, but bounded so one request can't force
 * the server to process an unbounded batch. Exported (not just a local
 * const) so the client's own outbound drain (`ConnectionManager.drainOutbox`,
 * finding P1) can chunk against the exact same number instead of a
 * hard-coded, driftable copy of it.
 */
export const MAX_MESSAGES_PER_BATCH = 256;

/** Request body ceiling for `POST /byok/messages`; the cloud answers 413 above it, so the client chunks its drain by it. */
export const MESSAGES_SEND_MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The batch frame only (#1121). Each entry must speak this wire major and
 * carry the UUID its outcome is correlated by; everything else is decoded per
 * entry with `parseMessage`, so one invalid envelope is answered
 * `rejected: payload_invalid` on its own instead of failing every envelope in
 * the batch — the same split as `EventsPollResponseSchema.events` (#386) on
 * the receive side. A different `v` still fails the whole request: the wire
 * major belongs to the sender, which could not read this version's outcomes.
 */
export const MessagesSendRequestSchema = z.object({
  messages: z.array(z.looseObject({ v: z.literal(PROTOCOL_VERSION), id: z.uuid() })).max(MAX_MESSAGES_PER_BATCH),
});
export type MessagesSendRequest = z.infer<typeof MessagesSendRequestSchema>;

/**
 * `accepted` counts every envelope the inbound gate (`@byok-sdk/cloud`'s
 * `handleInboundEnvelope`) answered `'accepted'` *or* `'duplicate'` for — a deduped replay is a wire-level
 * success even though the business mutation did not run a second time.
 * `rejected` is omitted when zero. `outcomes` is required and correlates
 * exactly one result with each posted envelope; a rejected outcome carries its
 * reason. `ingress` is required on an answer whose `conn.hello` was accepted
 * (or deduplicated). The client enforces the per-envelope rules against the
 * posted batch and treats a violation as an unusable response.
 *
 * `capabilities` (additive) is the same server capability advertisement a
 * `GET /byok/events` response carries. A server includes it when the batch
 * carries `conn.hello`: the daemon's handshake is a lone `conn.hello` POST,
 * so its answer carries readiness and capabilities in one round trip.
 * Absence means "no update" — the daemon keeps the advertisement it already
 * holds — never an empty list.
 */
export const MessagesSendResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative().optional(),
  capabilities: z.array(z.string()).optional(),
  ingress: ActivityIngressSchema.optional(),
  outcomes: z.array(MessageSendOutcomeSchema).max(MAX_MESSAGES_PER_BATCH),
});
export type MessagesSendResponse = z.infer<typeof MessagesSendResponseSchema>;

// ---------------------------------------------------------------------------
// Task-free Agent-home projection completion/readback. These are authenticated
// HTTP bodies, not daemon/server envelope messages. The completion request is
// terminal and binds the exact request, AgentRef and projection hash; the
// readback additionally carries the tenant/device routing identity and allows
// `pending` before a daemon completion is durably recorded.
// ---------------------------------------------------------------------------

export const AgentHomeProjectionCompletionRequestSchema = z
  .object({
    requestId: z.uuid(),
    agentRef: AgentHomeProjectionAgentRefSchema,
    projectionHash: AgentHomeProjectionHashSchema,
    outcome: AgentHomeProjectionOutcomeSchema,
  })
  .strict();
export type AgentHomeProjectionCompletionRequest = z.infer<typeof AgentHomeProjectionCompletionRequestSchema>;

export const AgentHomeProjectionStatusSchema = z.enum([
  'pending',
  'applied',
  'idempotent',
  'stale',
  'conflict',
]);
export type AgentHomeProjectionStatus = z.infer<typeof AgentHomeProjectionStatusSchema>;

export const AgentHomeProjectionReadbackSchema = z
  .object({
    tenantId: z.string().min(1),
    deviceId: z.string().min(1),
    requestId: z.uuid(),
    agentRef: AgentHomeProjectionAgentRefSchema,
    projectionHash: AgentHomeProjectionHashSchema,
    status: AgentHomeProjectionStatusSchema,
    completedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type AgentHomeProjectionReadback = z.infer<typeof AgentHomeProjectionReadbackSchema>;

// ---------------------------------------------------------------------------
// Remote input preparation completion/readback. Same shape as the Agent-home
// pair above and for the same reason: the device -> cloud leg of a task-free
// control request is a direct AUTHENTICATED HTTP call, not a mailbox envelope,
// because the daemon may advance its server -> daemon cursor only once the
// terminal fact is durably recorded — and an outbox envelope gives it nothing
// to wait on.
//
// The completion is a discriminated union rather than an outcome enum plus
// optional siblings: `prepared` without a receipt, or `rejected` carrying one,
// must both be unrepresentable rather than merely discouraged.
// ---------------------------------------------------------------------------

export const InputPreparationCompletionRequestSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('prepared'),
      requestId: z.uuid(),
      agentRef: AgentRefSchema,
      profileId: InputPreparationProfileIdSchema,
      policyRevision: InputPreparationPolicyRevisionSchema,
      receipt: InputPreparationReceiptSummarySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('rejected'),
      requestId: z.uuid(),
      agentRef: AgentRefSchema,
      profileId: InputPreparationProfileIdSchema,
      policyRevision: InputPreparationPolicyRevisionSchema,
      reason: InputPreparationRejectionReasonSchema,
    })
    .strict(),
]);
export type InputPreparationCompletionRequest = z.infer<typeof InputPreparationCompletionRequestSchema>;

/** `pending` until the device records a terminal fact; the other two are terminal. */
export const InputPreparationStatusSchema = z.enum(['pending', 'prepared', 'rejected']);
export type InputPreparationStatus = z.infer<typeof InputPreparationStatusSchema>;

/**
 * Tenant/device/request-bound durable readback. `receipt` and `reason` are
 * present only on their own terminal status, never together and never on
 * `pending`.
 */
export const InputPreparationReadbackSchema = z
  .object({
    tenantId: z.string().min(1),
    deviceId: z.string().min(1),
    requestId: z.uuid(),
    agentRef: AgentRefSchema,
    profileId: InputPreparationProfileIdSchema,
    policyRevision: InputPreparationPolicyRevisionSchema,
    status: InputPreparationStatusSchema,
    receipt: InputPreparationReceiptSummarySchema.optional(),
    reason: InputPreparationRejectionReasonSchema.optional(),
    completedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectsReceipt = value.status === 'prepared';
    const expectsReason = value.status === 'rejected';
    if (expectsReceipt !== (value.receipt !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['receipt'], message: 'receipt is present exactly when status is "prepared"' });
    }
    if (expectsReason !== (value.reason !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'reason is present exactly when status is "rejected"' });
    }
    if ((value.status !== 'pending') !== (value.completedAt !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['completedAt'], message: 'completedAt is present exactly when the status is terminal' });
    }
  });
export type InputPreparationReadback = z.infer<typeof InputPreparationReadbackSchema>;

/**
 * Query identity for the status GET. The request key is
 * `(deviceId, agentRef, requestId)`; `deviceId` comes from bearer auth, the
 * path carries `requestId`, so only the AgentRef halves travel as query
 * parameters.
 */
export const InputPreparationStatusQuerySchema = z
  .object({
    agentId: z.string().min(1),
    profileRevision: z.string().min(1),
  })
  .strict();
export type InputPreparationStatusQuery = z.infer<typeof InputPreparationStatusQuerySchema>;

// ---------------------------------------------------------------------------
// POST /byok/agent-memory-projections — optional hosted, redacted, one-way
// snapshots. Tenant and device identity come only from bearer authentication.
// ---------------------------------------------------------------------------

export const AgentMemoryProjectionCommitRequestSchema = AgentMemoryProjectionMutationSchema;
export type AgentMemoryProjectionCommitRequest = z.infer<typeof AgentMemoryProjectionCommitRequestSchema>;

export const AgentMemoryProjectionCommitResponseSchema = AgentMemoryProjectionReceiptSchema;
export type AgentMemoryProjectionCommitResponse = z.infer<typeof AgentMemoryProjectionCommitResponseSchema>;

// ---------------------------------------------------------------------------
// Route paths — the single source of truth for the `/byok/*` HTTP surface.
//
// These literals were previously hand-copied across client, cloud, server, and
// testkit; the doc comments above already named every one of them but exported
// no constant. They ARE the wire contract (unlike the host-owned, opaque
// capability vocabulary of ADR-010, which stays out of protocol), so they live
// here and every package imports them — a route change is now one edit.
//
// Two shapes:
//   - Static paths (`BYOK_*_PATH`) — used identically by routers and clients.
//   - Parameterized routes: a router template (`BYOK_*_ROUTE`, with `:param`
//     placeholders) for mounting, plus a builder (`byok*Path(...)`) that fills
//     the params for a client request. Each builder reproduces its call site
//     byte-for-byte, including whether a segment is `encodeURIComponent`-encoded.
// ---------------------------------------------------------------------------

/** `POST /byok/pair` — one-time device pairing (§6). */
export const BYOK_PAIR_PATH = '/byok/pair';
/** `POST /byok/challenge` — token-renewal challenge (§6.3). */
export const BYOK_CHALLENGE_PATH = '/byok/challenge';
/** `POST /byok/token` — token-renewal exchange (§6.3). */
export const BYOK_TOKEN_PATH = '/byok/token';

/** `GET /byok/capabilities` — ADR-010 declaration route. */
export const BYOK_CAPABILITIES_PATH = '/byok/capabilities';

/** `GET /byok/events` — long-poll receive (§8). */
export const BYOK_EVENTS_PATH = '/byok/events';
/** `POST /byok/messages` — long-poll batched send (§8.2). */
export const BYOK_MESSAGES_PATH = '/byok/messages';

/** `PUT /byok/agent-home-projections/:requestId/completion`. */
export const BYOK_AGENT_HOME_PROJECTIONS_PATH = '/byok/agent-home-projections';
export const BYOK_AGENT_HOME_PROJECTION_COMPLETION_ROUTE =
  '/byok/agent-home-projections/:requestId/completion';
export function byokAgentHomeProjectionCompletionPath(requestId: string): string {
  return `${BYOK_AGENT_HOME_PROJECTIONS_PATH}/${encodeURIComponent(requestId)}/completion`;
}

/** `PUT /byok/input-preparations/:requestId/completion` and `GET /byok/input-preparations/:requestId`. */
export const BYOK_INPUT_PREPARATIONS_PATH = '/byok/input-preparations';
export const BYOK_INPUT_PREPARATION_COMPLETION_ROUTE = '/byok/input-preparations/:requestId/completion';
export const BYOK_INPUT_PREPARATION_STATUS_ROUTE = '/byok/input-preparations/:requestId';
export function byokInputPreparationCompletionPath(requestId: string): string {
  return `${BYOK_INPUT_PREPARATIONS_PATH}/${encodeURIComponent(requestId)}/completion`;
}
export function byokInputPreparationStatusPath(requestId: string): string {
  return `${BYOK_INPUT_PREPARATIONS_PATH}/${encodeURIComponent(requestId)}`;
}

/** `POST /byok/agent-memory-projections` — optional local-to-hosted redacted snapshot commit. */
export const BYOK_AGENT_MEMORY_PROJECTIONS_PATH = '/byok/agent-memory-projections';

/** `PUT /byok/presence` — presence heartbeat. */
export const BYOK_PRESENCE_PATH = '/byok/presence';
/** `POST /byok/activity` — activity-tail append. */
export const BYOK_ACTIVITY_PATH = '/byok/activity';

/** `GET /byok/board` — coordination board list/poll. */
export const BYOK_BOARD_PATH = '/byok/board';
/** `GET /byok/board/stream` — coordination board SSE. */
export const BYOK_BOARD_STREAM_PATH = '/byok/board/stream';
/** Router template — `POST /byok/board/:id/claim`. */
export const BYOK_BOARD_CLAIM_ROUTE = '/byok/board/:id/claim';
/** Router template — `POST /byok/board/:id/unclaim`. */
export const BYOK_BOARD_UNCLAIM_ROUTE = '/byok/board/:id/unclaim';
/** Router template — `POST /byok/board/:id/status`. */
export const BYOK_BOARD_STATUS_ROUTE = '/byok/board/:id/status';

/** `GET /byok/records` — truth manifest list (§12.3). */
export const BYOK_RECORDS_PATH = '/byok/records';
/** Router template for a single truth record — `GET`/`PUT /byok/records/:kind/:key`. */
export const BYOK_RECORD_ROUTE = '/byok/records/:kind/:key';
/** Client builder for a truth record path. Mirrors the `:kind/:key` template, each segment URL-encoded. */
export function byokRecordPath(kind: string, key: string): string {
  return `/byok/records/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`;
}

/** `POST /byok/e2ee/member-key` — device proof: register the device's member key bundle and pairing MAC (#654). */
export const BYOK_E2EE_MEMBER_KEY_PATH = '/byok/e2ee/member-key';
/** `POST /byok/e2ee/chain` (device proof: append) and `GET` (device: read) — the member chain. */
export const BYOK_E2EE_CHAIN_PATH = '/byok/e2ee/chain';
/** `POST /byok/e2ee/key-packages` (device proof: put) and `GET` (device: this device's packages). */
export const BYOK_E2EE_KEY_PACKAGES_PATH = '/byok/e2ee/key-packages';
/** `GET /byok/e2ee/pairing-mac` — device: the client pairing MAC relayed to this device. */
export const BYOK_E2EE_PAIRING_MAC_PATH = '/byok/e2ee/pairing-mac';

/** `GET /byok/skill-packs` — skill-pack manifest catalogue. */
export const BYOK_SKILL_PACKS_PATH = '/byok/skill-packs';
/** Router template for a skill-pack file — `GET /byok/skill-packs/:name/files/:path`. */
export const BYOK_SKILL_PACK_FILE_ROUTE = '/byok/skill-packs/:name/files/:path';
/** Client builder for a skill-pack file path. Mirrors the `:name`/`:path` template, each segment URL-encoded. */
export function byokSkillPackFilePath(name: string, path: string): string {
  return `/byok/skill-packs/${encodeURIComponent(name)}/files/${encodeURIComponent(path)}`;
}

/** `POST /byok/blobs` — declare a blob upload (§7). */
export const BYOK_BLOBS_PATH = '/byok/blobs';
/** Router template — `POST /byok/blobs/:id/finalize`. */
export const BYOK_BLOB_FINALIZE_ROUTE = '/byok/blobs/:id/finalize';
/** Router template — `GET /byok/blobs/:id/url`. */
export const BYOK_BLOB_URL_ROUTE = '/byok/blobs/:id/url';
/** Router template for the two presigned byte routes — `PUT`/`GET /byok/blobs/:id/content`. */
export const BYOK_BLOB_CONTENT_ROUTE = '/byok/blobs/:id/content';
/** Client builder — `POST /byok/blobs/:id/finalize`, blob id URL-encoded (client-supplied). */
export function byokBlobFinalizePath(blobId: string): string {
  return `/byok/blobs/${encodeURIComponent(blobId)}/finalize`;
}
/** Client builder — `GET /byok/blobs/:id/url`, blob id URL-encoded (client-supplied). */
export function byokBlobUrlPath(blobId: string): string {
  return `/byok/blobs/${encodeURIComponent(blobId)}/url`;
}
/**
 * Path portion of a presigned `/byok/blobs/:id/content` URL. The blob id here
 * is a server-minted token (NOT URL-encoded, matching the reference stores that
 * mint these signed URLs); callers append the `?sig=&exp=` query themselves.
 */
export function byokBlobContentPath(blobId: string): string {
  return `/byok/blobs/${blobId}/content`;
}
