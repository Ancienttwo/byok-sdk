// ==== @byok-sdk/protocol dist/agent-egress.d.ts ====
import { z } from 'zod';
/** Additive daemon capability names. Server/cloud admission consumes these exactly. */
export declare const AGENT_EGRESS_POLICY_CAPABILITY: 'agent-egress-policy';
export declare const AGENT_EGRESS_RELIABLE_ACK_CAPABILITY: 'agent-egress-reliable-ack';
/** Admits the distinct offer whose runtime mints its session only after start. */
export declare const AGENT_EGRESS_FRESH_SESSION_CAPABILITY: 'agent-egress-fresh-session';
/** Admits the distinct Agent-authored message lane; activity policy remains independent. */
export declare const AGENT_MESSAGE_EGRESS_CAPABILITY: 'agent-message-egress';
export declare const AGENT_CONTENT_WORKSPACE_READ_CAPABILITY: 'agent-content-workspace-read';
export declare const AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY: 'agent-content-transcript-read';
export declare const AGENT_CONTENT_ARTIFACT_READ_CAPABILITY: 'agent-content-artifact-read';
export declare const AGENT_MESSAGE_MAX_BYTES: number;
export declare const AgentMessageContractSchema: z.ZodString;
export declare const AgentMessageContentTypeSchema: z.ZodEnum<{
    "text/markdown": "text/markdown";
    "text/plain": "text/plain";
}>;
export declare const AgentMessageDestinationBindingSchema: z.ZodString;
export declare const AgentMessageFreshnessCursorSchema: z.ZodString;
/** Host-only product authority. It is never serialized into an Agent offer or message envelope. */
export declare const AgentMessageServerContextSchema: z.ZodObject<{
    destinationBinding: z.ZodString;
    freshnessCursor: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const AgentMessageEgressRequirementSchema: z.ZodObject<{
    mode: z.ZodLiteral<"required">;
    contract: z.ZodString;
    contentType: z.ZodEnum<{
        "text/markdown": "text/markdown";
        "text/plain": "text/plain";
    }>;
    maxBytes: z.ZodNumber;
}, z.core.$strict>;
export type AgentMessageEgressRequirement = z.infer<typeof AgentMessageEgressRequirementSchema>;
export type AgentMessageContentType = z.infer<typeof AgentMessageContentTypeSchema>;
export type AgentMessageServerContext = z.infer<typeof AgentMessageServerContextSchema>;
export declare const AgentContentMimeTypeSchema: z.ZodString;
/** Explicit MIME and byte policy for one independently-authorized content surface. */
export declare const ContentReadPolicySchema: z.ZodObject<{
    maxBytes: z.ZodNumber;
    allowedMimeTypes: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type ContentReadPolicy = z.infer<typeof ContentReadPolicySchema>;
export declare const AgentEgressActivityPolicySchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    mode: z.ZodLiteral<"metadata-status">;
    delivery: z.ZodLiteral<"latest-value">;
}, z.core.$strict>, z.ZodObject<{
    mode: z.ZodLiteral<"contentful-trajectory">;
    delivery: z.ZodLiteral<"latest-value">;
    maxCoalesceMs: z.ZodNumber;
    maxEventBytes: z.ZodNumber;
}, z.core.$strict>], "mode">;
export type AgentEgressActivityPolicy = z.infer<typeof AgentEgressActivityPolicySchema>;
export declare const AgentReliableQuotaPolicySchema: z.ZodObject<{
    maxPendingEventsPerAgent: z.ZodNumber;
    maxPendingBytesPerAgent: z.ZodNumber;
    maxPendingBytesPerTenant: z.ZodNumber;
}, z.core.$strict>;
export type AgentReliableQuotaPolicy = z.infer<typeof AgentReliableQuotaPolicySchema>;
/**
 * The only consumable policy shape for Agent egress.  Missing/unknown policy
 * is intentionally not represented as a default: callers must select a
 * revision and all three content surfaces independently.
 */
export declare const AgentEgressPolicySchema: z.ZodObject<{
    policyRevision: z.ZodString;
    activity: z.ZodDiscriminatedUnion<[z.ZodObject<{
        mode: z.ZodLiteral<"metadata-status">;
        delivery: z.ZodLiteral<"latest-value">;
    }, z.core.$strict>, z.ZodObject<{
        mode: z.ZodLiteral<"contentful-trajectory">;
        delivery: z.ZodLiteral<"latest-value">;
        maxCoalesceMs: z.ZodNumber;
        maxEventBytes: z.ZodNumber;
    }, z.core.$strict>], "mode">;
    reliable: z.ZodObject<{
        maxPendingEventsPerAgent: z.ZodNumber;
        maxPendingBytesPerAgent: z.ZodNumber;
        maxPendingBytesPerTenant: z.ZodNumber;
    }, z.core.$strict>;
    transfers: z.ZodObject<{
        workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
            maxBytes: z.ZodNumber;
            allowedMimeTypes: z.ZodArray<z.ZodString>;
        }, z.core.$strict>]>;
        transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
            maxBytes: z.ZodNumber;
            allowedMimeTypes: z.ZodArray<z.ZodString>;
        }, z.core.$strict>]>;
        artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
            maxBytes: z.ZodNumber;
            allowedMimeTypes: z.ZodArray<z.ZodString>;
        }, z.core.$strict>]>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type AgentEgressPolicy = z.infer<typeof AgentEgressPolicySchema>;
/** Delivery stores are semantically distinct; this enum is never a durable boolean. */
export declare const AgentEgressLaneSchema: z.ZodEnum<{
    "latest-value": "latest-value";
    reliable: "reliable";
}>;
export type AgentEgressLane = z.infer<typeof AgentEgressLaneSchema>;
/** Every refusal/replacement is observable rather than silently degrading to another lane. */
export declare const AgentEgressDropReasonSchema: z.ZodEnum<{
    ack_mismatch: "ack_mismatch";
    backpressure: "backpressure";
    capability_missing: "capability_missing";
    coalesced: "coalesced";
    disconnected: "disconnected";
    invalid_envelope: "invalid_envelope";
    policy_denied: "policy_denied";
    quota_exceeded: "quota_exceeded";
    sanitizer_rejected: "sanitizer_rejected";
}>;
export type AgentEgressDropReason = z.infer<typeof AgentEgressDropReasonSchema>;
export declare const AgentContentReadSurfaceSchema: z.ZodEnum<{
    artifact: "artifact";
    transcript: "transcript";
    workspace: "workspace";
}>;
export type AgentContentReadSurface = z.infer<typeof AgentContentReadSurfaceSchema>;
/** The product-selected actor is explicit; tenant/device are bound by the authenticated transport. */
export declare const AgentContentActorKindSchema: z.ZodEnum<{
    agent: "agent";
    system: "system";
    user: "user";
}>;
export type AgentContentActorKind = z.infer<typeof AgentContentActorKindSchema>;
export declare const AgentContentActorSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        agent: "agent";
        system: "system";
        user: "user";
    }>;
    id: z.ZodString;
}, z.core.$strict>;
export type AgentContentActor = z.infer<typeof AgentContentActorSchema>;
/** No byte/text interpretation is inferred from a target name or MIME declaration. */
export declare const AgentContentDecodeAsSchema: z.ZodEnum<{
    bytes: "bytes";
    utf8: "utf8";
}>;
export type AgentContentDecodeAs = z.infer<typeof AgentContentDecodeAsSchema>;
export declare const AgentContentReadDecisionSchema: z.ZodEnum<{
    allowed: "allowed";
    denied: "denied";
}>;
export type AgentContentReadDecision = z.infer<typeof AgentContentReadDecisionSchema>;
export declare const AgentContentReadDenialReasonSchema: z.ZodEnum<{
    "absolute-target": "absolute-target";
    "byte-limit": "byte-limit";
    "capability-missing": "capability-missing";
    "dot-segment": "dot-segment";
    "identity-mismatch": "identity-mismatch";
    "invalid-request": "invalid-request";
    "mime-not-allowlisted": "mime-not-allowlisted";
    "non-relative-target": "non-relative-target";
    "not-regular-file": "not-regular-file";
    "path-escape": "path-escape";
    "policy-disabled": "policy-disabled";
    "policy-revision-mismatch": "policy-revision-mismatch";
    "root-invalid": "root-invalid";
    "root-not-allowlisted": "root-not-allowlisted";
    "sensitive-name": "sensitive-name";
    symlink: "symlink";
    "target-missing": "target-missing";
    "text-decode-failed": "text-decode-failed";
    "text-not-allowlisted": "text-not-allowlisted";
}>;
export type AgentContentReadDenialReason = z.infer<typeof AgentContentReadDenialReasonSchema>;
/** SHA-256 transport receipt hash, never a content byte projection. */
export declare const AgentEgressContentHashSchema: z.ZodString;
export declare const AgentEgressPolicyRevisionSchema: z.ZodString;
// ==== @byok-sdk/protocol dist/agent-event.d.ts ====
import { z } from 'zod';
/**
 * Normalized event shape that every runtime adapter (pi / claude / codex)
 * translates its native JSONL output into. This is the interior of a
 * `task.progress` payload's `events` array.
 */
export declare const AgentEventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"progress">;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_use">;
    tool: z.ZodString;
    input: z.ZodOptional<z.ZodUnknown>;
    toolCallId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    tool: z.ZodString;
    output: z.ZodOptional<z.ZodUnknown>;
    toolCallId: z.ZodOptional<z.ZodString>;
    isError: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"artifact">;
    name: z.ZodString;
    contentType: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"needs_approval">;
    summary: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"turn_end">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"error">;
    message: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"usage">;
    inputTokens: z.ZodOptional<z.ZodNumber>;
    cachedInputTokens: z.ZodOptional<z.ZodNumber>;
    outputTokens: z.ZodOptional<z.ZodNumber>;
    reasoningTokens: z.ZodOptional<z.ZodNumber>;
    totalTokens: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>], "type">;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
/**
 * Known AgentEvent variant type discriminators — DERIVED directly from
 * {@link AgentEventSchema}'s own discriminated-union variants via
 * `z.toJSONSchema`, rather than hand-maintained as a second literal list.
 * This used to be a standalone array kept in sync with the schema above by
 * hand (dual authority); the freeze guard
 * (`__tests__/freeze-guard.test.ts`'s "dual-authority cross-check") already
 * asserted the two matched using this EXACT SAME `z.toJSONSchema` extraction
 * mechanism, which is why deriving it this way is safe: the guard already
 * proved this extraction produces the identical set the hand-written list
 * held. With the derivation below, the two can no longer drift apart at
 * all — there is only one authority now, {@link AgentEventSchema} itself.
 * The freeze guard test is kept anyway (now definitionally true rather than
 * a live check) as a regression net in case a future refactor reintroduces a
 * hand-written list.
 *
 * Exported (not module-private) so {@link isKnownAgentEvent} /
 * {@link partitionAgentEvents} (and the freeze guard) can check against the
 * exact same set without each reaching into zod's discriminated-union
 * internals directly. `z.toJSONSchema`'s output shape here (`.oneOf[].
 * properties.type.const`) is a public, documented zod v4 API — not
 * reaching into `._def`/internal fields — same as the freeze guard already
 * relies on.
 */
export declare const KNOWN_AGENT_EVENT_TYPES: readonly string[];
/**
 * Pre-freeze compatibility widening (the freeze blocker this schema fixes):
 * an unknown-type event — one a future runtime/protocol minor version
 * introduces — parses as an opaque passthrough placeholder instead of
 * hard-failing the entire `task.progress` batch it arrived in. Without this,
 * `TaskProgressPayloadSchema.events: z.array(AgentEventSchema)` would throw
 * on the whole array the moment one event had an unrecognized `type`, which
 * made the wire's "additive new variants are non-breaking" promise false for
 * the installed base — and unfixable post-freeze.
 *
 * The `.refine` guard is load-bearing, not decorative: it excludes every
 * KNOWN type literal, so a *malformed* known variant (e.g. `progress`
 * missing `text`) still fails validation instead of silently matching this
 * fallback. Tolerance is only for unknown TYPES, never for malformed known
 * ones — see {@link AgentEventOrUnknownSchema}, which is what actually
 * combines this with {@link AgentEventSchema} for real use.
 *
 * Deliberately asymmetric with envelope-level control/security fields
 * (`instruction`, `policy` — see `messages.ts`/`permission.ts`), which stay
 * fail-closed on unknown shapes with no equivalent widening: this tolerance
 * applies only to observability data (agent progress events), never to
 * control/security surfaces. That asymmetry is the freeze rule.
 */
export declare const UnknownAgentEventSchema: z.ZodObject<{
    type: z.ZodString;
}, z.core.$loose>;
export type UnknownAgentEvent = z.infer<typeof UnknownAgentEventSchema>;
/**
 * The actual element schema for `TaskProgressPayloadSchema.events`
 * (`messages.ts`): a known, fully-typed {@link AgentEvent} OR an opaque
 * unknown-type placeholder. `z.union` (not `discriminatedUnion`) is required
 * here because the fallback branch matches on "not one of the known
 * literals", which a discriminated union can't express directly.
 */
export declare const AgentEventOrUnknownSchema: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"progress">;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_use">;
    tool: z.ZodString;
    input: z.ZodOptional<z.ZodUnknown>;
    toolCallId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    tool: z.ZodString;
    output: z.ZodOptional<z.ZodUnknown>;
    toolCallId: z.ZodOptional<z.ZodString>;
    isError: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"artifact">;
    name: z.ZodString;
    contentType: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"needs_approval">;
    summary: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"turn_end">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"error">;
    message: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"usage">;
    inputTokens: z.ZodOptional<z.ZodNumber>;
    cachedInputTokens: z.ZodOptional<z.ZodNumber>;
    outputTokens: z.ZodOptional<z.ZodNumber>;
    reasoningTokens: z.ZodOptional<z.ZodNumber>;
    totalTokens: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>], "type">, z.ZodObject<{
    type: z.ZodString;
}, z.core.$loose>]>;
export type AgentEventOrUnknown = z.infer<typeof AgentEventOrUnknownSchema>;
/**
 * Type guard distinguishing a known, fully-typed {@link AgentEvent} from an
 * {@link UnknownAgentEvent} passthrough placeholder.
 */
export declare function isKnownAgentEvent(event: AgentEventOrUnknown): event is AgentEvent;
/**
 * Split a `task.progress` events array into known (typed, actionable) and
 * unknown (opaque, safe-to-skip) events. Consumers should process `known`
 * and skip `unknown` rather than throwing on it — that's the point of the
 * pre-freeze tolerance above.
 */
export declare function partitionAgentEvents(events: readonly AgentEventOrUnknown[]): {
    known: AgentEvent[];
    unknown: UnknownAgentEvent[];
};
// ==== @byok-sdk/protocol dist/agent-home-projection.d.ts ====
import { z } from 'zod';
/** Capability required before a task-free Agent-home projection is admitted. */
export declare const AGENT_HOME_PROJECTION_CAPABILITY: 'agent-home-projection';
/** Maximum UTF-8 encoded JSON bytes carried by one projection payload. */
export declare const AGENT_HOME_PROJECTION_MAX_BYTES: number;
/** PostgreSQL BIGINT maximum, kept as decimal text to avoid JavaScript precision loss. */
export declare const AGENT_HOME_PROJECTION_PROFILE_REVISION_MAXIMUM: '9223372036854775807';
/**
 * Canonical positive decimal Profile revision for this projection contract.
 *
 * This deliberately stays local to the projection contract: the generic
 * AgentRef used by existing task and egress messages remains opaque. Values
 * cross the JavaScript/PostgreSQL boundary as text and are compared
 * lexically after canonical syntax validation.
 */
export declare const AgentHomeProjectionProfileRevisionSchema: z.ZodString;
export type AgentHomeProjectionProfileRevision = z.infer<typeof AgentHomeProjectionProfileRevisionSchema>;
/** The projection hash uses the package-wide lowercase SHA-256 transport form. */
export declare const AgentHomeProjectionHashSchema: z.ZodString;
export type AgentHomeProjectionHash = z.infer<typeof AgentHomeProjectionHashSchema>;
/** Terminal local-apply outcome carried by the exact completion request. */
export declare const AgentHomeProjectionOutcomeSchema: z.ZodEnum<{
    applied: "applied";
    conflict: "conflict";
    idempotent: "idempotent";
    stale: "stale";
}>;
export type AgentHomeProjectionOutcome = z.infer<typeof AgentHomeProjectionOutcomeSchema>;
/**
 * Bounded opaque JSON. The SDK enforces only byte size and does not interpret
 * Salesko or any other product's fields. Credential custody remains outside
 * this protocol surface; this schema intentionally defines no credential
 * fields and is not a DLP scanner.
 */
export type AgentHomeProjectionValue = string | number | boolean | null | AgentHomeProjectionValue[] | {
    [key: string]: AgentHomeProjectionValue;
};
export declare const AgentHomeProjectionValueSchema: z.ZodType<AgentHomeProjectionValue>;
// ==== @byok-sdk/protocol dist/agent-memory-projection.d.ts ====
import { z } from 'zod';
/** Capability required before the optional hosted Agent-memory projection can be used. */
export declare const AGENT_MEMORY_PROJECTION_CAPABILITY: 'agent.memory.projection';
/** One hosted projection is bounded before it enters the redaction or storage seam. */
export declare const AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES: number;
/** PostgreSQL `integer` ceiling shared by writer epochs and source sequences. */
export declare const AGENT_MEMORY_PROJECTION_MAX_ORDERING_VALUE = 2147483647;
/** Opaque, embedder-issued authorization grant. It is never interpreted as a consent boolean. */
export declare const AgentMemoryProjectionGrantRefSchema: z.ZodString;
export type AgentMemoryProjectionGrantRef = z.infer<typeof AgentMemoryProjectionGrantRefSchema>;
/** Exact local runtime session identity. No cwd or local source path is portable. */
export declare const AgentMemoryProjectionSessionRefSchema: z.ZodString;
export type AgentMemoryProjectionSessionRef = z.infer<typeof AgentMemoryProjectionSessionRefSchema>;
/** Positive epoch that changes only when the local single-writer authority changes. */
export declare const AgentMemoryProjectionWriterEpochSchema: z.ZodNumber;
export type AgentMemoryProjectionWriterEpoch = z.infer<typeof AgentMemoryProjectionWriterEpochSchema>;
/** Positive sequence within one writer epoch. A new epoch starts at one. */
export declare const AgentMemoryProjectionSourceSeqSchema: z.ZodNumber;
export type AgentMemoryProjectionSourceSeq = z.infer<typeof AgentMemoryProjectionSourceSeqSchema>;
/** Byte length implied by the unpadded base64url transport string. */
export declare function agentMemoryProjectionBase64UrlByteLength(value: string): number | undefined;
/**
 * The only body-bearing field in the hosted contract. It is already redacted
 * by the embedder; source bytes, raw-source hashes, cwd, and local paths never
 * cross this boundary. The hosted store re-hashes these bytes before commit.
 */
export declare const AgentMemoryProjectionSnapshotSchema: z.ZodObject<{
    redactedHash: z.ZodString;
    redactedByteCount: z.ZodNumber;
    redactedBytes: z.ZodString;
}, z.core.$strict>;
export type AgentMemoryProjectionSnapshot = z.infer<typeof AgentMemoryProjectionSnapshotSchema>;
/**
 * Device -> hosted mutation for one redacted full snapshot. It intentionally
 * contains no tenant/device identity: authenticated transport supplies both.
 * The snapshot is a one-way copy of local `MEMORY.md` plus local `notes/`, not
 * a remote authoring, merge, import, history, or RAG contract.
 */
export declare const AgentMemoryProjectionMutationSchema: z.ZodObject<{
    taskId: z.ZodString;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    sessionRef: z.ZodString;
    runtimeId: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>;
    grantRef: z.ZodString;
    writerEpoch: z.ZodNumber;
    sourceSeq: z.ZodNumber;
    mutationId: z.ZodUUID;
    policyRevision: z.ZodString;
    snapshot: z.ZodObject<{
        redactedHash: z.ZodString;
        redactedByteCount: z.ZodNumber;
        redactedBytes: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type AgentMemoryProjectionMutation = z.infer<typeof AgentMemoryProjectionMutationSchema>;
/** Stable meter receipt for one accepted redacted snapshot; it never carries the snapshot body. */
export declare const AgentMemoryProjectionMeteringReceiptSchema: z.ZodObject<{
    meteringReceiptId: z.ZodUUID;
    acceptedRedactedBytes: z.ZodNumber;
    recordedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type AgentMemoryProjectionMeteringReceipt = z.infer<typeof AgentMemoryProjectionMeteringReceiptSchema>;
/** Immutable commit readback. It repeats identity and redacted metadata, never redacted bytes. */
export declare const AgentMemoryProjectionReceiptSchema: z.ZodObject<{
    outcome: z.ZodEnum<{
        accepted: "accepted";
        idempotent: "idempotent";
    }>;
    tenantId: z.ZodString;
    deviceId: z.ZodString;
    taskId: z.ZodString;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    sessionRef: z.ZodString;
    runtimeId: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>;
    grantRef: z.ZodString;
    writerEpoch: z.ZodNumber;
    sourceSeq: z.ZodNumber;
    mutationId: z.ZodUUID;
    policyRevision: z.ZodString;
    redactedHash: z.ZodString;
    redactedByteCount: z.ZodNumber;
    metering: z.ZodObject<{
        meteringReceiptId: z.ZodUUID;
        acceptedRedactedBytes: z.ZodNumber;
        recordedAt: z.ZodISODateTime;
    }, z.core.$strict>;
}, z.core.$strict>;
export type AgentMemoryProjectionReceipt = z.infer<typeof AgentMemoryProjectionReceiptSchema>;
/**
 * Server-side erase result. The returned epoch is the minimum legal epoch for
 * a later host-issued writer grant; erased source epochs can never re-enter.
 */
export declare const AgentMemoryProjectionEraseResultSchema: z.ZodObject<{
    nextWriterEpoch: z.ZodNumber;
}, z.core.$strict>;
export type AgentMemoryProjectionEraseResult = z.infer<typeof AgentMemoryProjectionEraseResultSchema>;
// ==== @byok-sdk/protocol dist/blob.d.ts ====
import { z } from 'zod';
/**
 * Canonical `contentHash` format (finding F9): `sha256:` followed by exactly
 * 64 lowercase hex characters (a SHA-256 digest). Pinned here — the single
 * source of truth both `BlobRefSchema` and `CreateBlobRequestSchema`
 * (`http-api.ts`) validate against — rather than left as a bare `z.string()`
 * that silently accepted any prefix (or none) and left the server to
 * reconcile the mismatch with an ad hoc normalization step. No compat shim:
 * the wire is pre-freeze (`v` stays `1`), so this is a straight tightening,
 * not a migration.
 */
export declare const CONTENT_HASH_RE: RegExp;
/**
 * Reference to a large payload that was pushed out-of-band (presigned PUT) or
 * is fetchable out-of-band (presigned GET), rather than inlined in an envelope.
 */
export declare const BlobRefSchema: z.ZodObject<{
    blobId: z.ZodString;
    contentHash: z.ZodString;
    size: z.ZodNumber;
    contentType: z.ZodString;
    url: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type BlobRef = z.infer<typeof BlobRefSchema>;
// ==== @byok-sdk/protocol dist/codec.d.ts ====
import type { z } from 'zod';
import { type Envelope } from './envelope';
import { MESSAGE_PAYLOAD_SCHEMAS, type MessageType } from './messages';
/**
 * Validate an already-parsed JS value as an {@link Envelope}, narrowing
 * `payload` by `type`. Throws {@link UnknownMessageTypeError} when `type`
 * isn't a recognized message type (safe for the caller to skip/ignore), or
 * {@link EnvelopeValidationError} when a recognized type fails schema
 * validation.
 */
export declare function parseMessage(data: unknown): Envelope;
/**
 * Decode a single NDJSON line into a validated {@link Envelope}. Accepts a
 * string or raw bytes (e.g. a WebSocket binary frame) — isomorphic, no
 * stream handling required of the caller.
 */
export declare function decodeEnvelope(line: string | Uint8Array): Envelope;
/** Encode an {@link Envelope} as a single-line NDJSON string (trailing `\n` included). */
export declare function encodeEnvelope(env: Envelope): string;
interface EnvelopeShapeOptions {
    'conn.hello': {
        taskId?: string;
        seq?: number;
    };
    'conn.ack': {
        taskId?: string;
        seq: number;
    };
    'task.offer': {
        taskId: string;
        seq: number;
    };
    'task.offer_with_toolsets': {
        taskId: string;
        seq: number;
    };
    'task.offer_for_agent': {
        taskId: string;
        seq: number;
    };
    'task.offer_for_agent_with_egress': {
        taskId: string;
        seq: number;
    };
    'task.offer_for_agent_with_egress_fresh': {
        taskId: string;
        seq: number;
    };
    'agent.egress.reliable': {
        taskId?: string;
        seq?: number;
    };
    'agent.egress.ack': {
        taskId?: string;
        seq: number;
    };
    'agent.message.publish': {
        taskId: string;
        seq?: number;
    };
    'agent.message.disposition': {
        taskId: string;
        seq: number;
    };
    'agent.content.read': {
        taskId?: string;
        seq: number;
    };
    'agent.home.projection': {
        taskId?: never;
        seq: number;
    };
    'agent.content.receipt': {
        taskId?: string;
        seq?: number;
    };
    'task.approve': {
        taskId: string;
        seq: number;
    };
    'task.reject': {
        taskId: string;
        seq: number;
    };
    'task.cancel': {
        taskId: string;
        seq: number;
    };
    'task.steer': {
        taskId: string;
        seq: number;
    };
    'task.claim': {
        taskId: string;
        seq?: number;
    };
    'task.started': {
        taskId: string;
        seq?: number;
    };
    'task.decline': {
        taskId: string;
        seq?: number;
    };
    'task.progress': {
        taskId: string;
        seq?: number;
    };
    'task.artifact': {
        taskId: string;
        seq?: number;
    };
    'task.await_approval': {
        taskId: string;
        seq?: number;
    };
    'task.complete': {
        taskId: string;
        seq?: number;
    };
    'task.fail': {
        taskId: string;
        seq?: number;
    };
    'task.cancelled': {
        taskId: string;
        seq?: number;
    };
    'task.approval_resolved': {
        taskId: string;
        seq?: number;
    };
}
interface EnvelopeCommonOptions {
    id?: string;
    ts?: string;
    v?: number;
    /** Always optional regardless of `type` (docs/protocol.md §1.3). */
    sessionRef?: string;
}
/** Public options shape for `createEnvelope<T>` — conditionally required `taskId`/`seq` per `EnvelopeShapeOptions[T]`, plus the always-optional common fields. Defaults to the full `MessageType` union (a loose, all-optional-ish shape) when `T` isn't pinned, which is also what `createEnvelope`'s own implementation uses internally to read `opts` without fighting the per-call-site conditional. */
export type CreateEnvelopeOptions<T extends MessageType = MessageType> = EnvelopeCommonOptions & EnvelopeShapeOptions[T];
/** `never` unless every key of `T` is optional — i.e. whether `createEnvelope`'s `opts` argument can be omitted entirely for a given message type. */
type RequiredKeys<T> = {
    [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];
/** The rest-parameter shape for `createEnvelope`'s 3rd argument: present-and-optional when `T` needs nothing, present-and-required when it needs `taskId` and/or `seq`. */
type CreateEnvelopeArgs<T extends MessageType> = RequiredKeys<EnvelopeShapeOptions[T]> extends never ? [opts?: CreateEnvelopeOptions<T>] : [opts: CreateEnvelopeOptions<T>];
type PayloadOf<T extends MessageType> = z.infer<(typeof MESSAGE_PAYLOAD_SCHEMAS)[T]>;
/**
 * Build a well-formed {@link Envelope}, filling `v`/`id`/`ts` with defaults.
 * `opts` (`taskId`/`seq`) is required or optional depending on `type` — see
 * the module doc above — and the constructed envelope is validated against
 * {@link EnvelopeSchema} before being returned, throwing
 * {@link EnvelopeValidationError} if it doesn't satisfy the schema.
 */
export declare function createEnvelope<T extends MessageType>(type: T, payload: PayloadOf<T>, ...rest: CreateEnvelopeArgs<T>): Extract<Envelope, {
    type: T;
}>;
export {};
// ==== @byok-sdk/protocol dist/envelope.d.ts ====
import { z } from 'zod';
import { type MessageType } from './messages';
/**
 * The wire envelope: common transport fields plus a `payload` whose shape is
 * determined by `type`. Unknown top-level fields are tolerated (stripped) for
 * forward-compat; unknown `type` values do not match any branch below and are
 * handled explicitly by {@link parseMessage} in `codec.ts`.
 *
 * Two cross-cutting requiredness rules, fixed at M1 (see docs/protocol.md
 * "M0 -> M1 breaking changes"):
 *
 * - `task_id` is REQUIRED for every `task.*` type (they all route by task id)
 *   and stays optional for `conn.*` (M1 gap #1).
 * - `seq` is REQUIRED for every type the *server* sends to the daemon — a
 *   per-device monotonic counter used as a redelivery cursor — and stays
 *   optional for daemon -> server types (M1 redelivery cursor; see
 *   `conn.hello.cursor` in `messages.ts`).
 */
export declare const EnvelopeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"conn.hello">;
    task_id: z.ZodOptional<z.ZodString>;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{
        protocolVersions: z.ZodArray<z.ZodNumber>;
        capabilities: z.ZodArray<z.ZodString>;
        deviceId: z.ZodString;
        productId: z.ZodString;
        clientVersion: z.ZodOptional<z.ZodString>;
        runtimes: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            version: z.ZodOptional<z.ZodString>;
            authPresent: z.ZodOptional<z.ZodBoolean>;
            capabilities: z.ZodOptional<z.ZodObject<{
                steer: z.ZodOptional<z.ZodBoolean>;
                resume: z.ZodOptional<z.ZodBoolean>;
                approvalInteractive: z.ZodOptional<z.ZodBoolean>;
                mcpToolsets: z.ZodOptional<z.ZodBoolean>;
                permissionModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>;
        }, z.core.$strip>>>;
        configuredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        cursor: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"conn.ack">;
    task_id: z.ZodOptional<z.ZodString>;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        protocolVersion: z.ZodNumber;
        capabilities: z.ZodArray<z.ZodString>;
        serverTime: z.ZodISODateTime;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.offer">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>]>;
        policy: z.ZodObject<{
            mode: z.ZodEnum<{
                auto: "auto";
                confirm: "confirm";
                plan: "plan";
                readonly: "readonly";
            }>;
            allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            workspaceRoot: z.ZodOptional<z.ZodString>;
            network: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            lane: z.ZodLiteral<"subscription">;
            runtimeId: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
            }>;
            providerId: z.ZodNull;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok">;
            runtimeId: z.ZodLiteral<"pi">;
            providerId: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok-profile">;
            runtimeId: z.ZodLiteral<"pi">;
            providerProfile: z.ZodObject<{
                profileRef: z.ZodString;
                profileRevision: z.ZodString;
                profileHash: z.ZodString;
                modelId: z.ZodString;
                requiredCapabilities: z.ZodArray<z.ZodEnum<{
                    "image-input": "image-input";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>], "lane">>;
        sessionRef: z.ZodOptional<z.ZodString>;
        workspaceHint: z.ZodOptional<z.ZodString>;
        limits: z.ZodOptional<z.ZodObject<{
            maxDurationMs: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.offer_with_toolsets">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>]>;
        policy: z.ZodObject<{
            mode: z.ZodEnum<{
                auto: "auto";
                confirm: "confirm";
                plan: "plan";
                readonly: "readonly";
            }>;
            allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            workspaceRoot: z.ZodOptional<z.ZodString>;
            network: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            lane: z.ZodLiteral<"subscription">;
            runtimeId: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
            }>;
            providerId: z.ZodNull;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok">;
            runtimeId: z.ZodLiteral<"pi">;
            providerId: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok-profile">;
            runtimeId: z.ZodLiteral<"pi">;
            providerProfile: z.ZodObject<{
                profileRef: z.ZodString;
                profileRevision: z.ZodString;
                profileHash: z.ZodString;
                modelId: z.ZodString;
                requiredCapabilities: z.ZodArray<z.ZodEnum<{
                    "image-input": "image-input";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>], "lane">>;
        sessionRef: z.ZodOptional<z.ZodString>;
        workspaceHint: z.ZodOptional<z.ZodString>;
        limits: z.ZodOptional<z.ZodObject<{
            maxDurationMs: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        requiredToolsets: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.offer_for_agent">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>]>;
        policy: z.ZodObject<{
            mode: z.ZodEnum<{
                auto: "auto";
                confirm: "confirm";
                plan: "plan";
                readonly: "readonly";
            }>;
            allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            workspaceRoot: z.ZodOptional<z.ZodString>;
            network: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            lane: z.ZodLiteral<"subscription">;
            runtimeId: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
            }>;
            providerId: z.ZodNull;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok">;
            runtimeId: z.ZodLiteral<"pi">;
            providerId: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok-profile">;
            runtimeId: z.ZodLiteral<"pi">;
            providerProfile: z.ZodObject<{
                profileRef: z.ZodString;
                profileRevision: z.ZodString;
                profileHash: z.ZodString;
                modelId: z.ZodString;
                requiredCapabilities: z.ZodArray<z.ZodEnum<{
                    "image-input": "image-input";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>], "lane">>;
        terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"none">;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"result-document">;
            contract: z.ZodString;
        }, z.core.$strict>], "mode">>;
        sessionRef: z.ZodOptional<z.ZodString>;
        limits: z.ZodOptional<z.ZodObject<{
            maxDurationMs: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strict>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.offer_for_agent_with_egress">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>]>;
        policy: z.ZodObject<{
            mode: z.ZodEnum<{
                auto: "auto";
                confirm: "confirm";
                plan: "plan";
                readonly: "readonly";
            }>;
            allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            workspaceRoot: z.ZodOptional<z.ZodString>;
            network: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            lane: z.ZodLiteral<"subscription">;
            runtimeId: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
            }>;
            providerId: z.ZodNull;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok">;
            runtimeId: z.ZodLiteral<"pi">;
            providerId: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok-profile">;
            runtimeId: z.ZodLiteral<"pi">;
            providerProfile: z.ZodObject<{
                profileRef: z.ZodString;
                profileRevision: z.ZodString;
                profileHash: z.ZodString;
                modelId: z.ZodString;
                requiredCapabilities: z.ZodArray<z.ZodEnum<{
                    "image-input": "image-input";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>], "lane">>;
        terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"none">;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"result-document">;
            contract: z.ZodString;
        }, z.core.$strict>], "mode">>;
        limits: z.ZodOptional<z.ZodObject<{
            maxDurationMs: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        sessionRef: z.ZodString;
        egressPolicy: z.ZodObject<{
            policyRevision: z.ZodString;
            activity: z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"metadata-status">;
                delivery: z.ZodLiteral<"latest-value">;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"contentful-trajectory">;
                delivery: z.ZodLiteral<"latest-value">;
                maxCoalesceMs: z.ZodNumber;
                maxEventBytes: z.ZodNumber;
            }, z.core.$strict>], "mode">;
            reliable: z.ZodObject<{
                maxPendingEventsPerAgent: z.ZodNumber;
                maxPendingBytesPerAgent: z.ZodNumber;
                maxPendingBytesPerTenant: z.ZodNumber;
            }, z.core.$strict>;
            transfers: z.ZodObject<{
                workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
                transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
                artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        messageEgress: z.ZodOptional<z.ZodObject<{
            mode: z.ZodLiteral<"required">;
            contract: z.ZodString;
            contentType: z.ZodEnum<{
                "text/markdown": "text/markdown";
                "text/plain": "text/plain";
            }>;
            maxBytes: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.offer_for_agent_with_egress_fresh">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>]>;
        policy: z.ZodObject<{
            mode: z.ZodEnum<{
                auto: "auto";
                confirm: "confirm";
                plan: "plan";
                readonly: "readonly";
            }>;
            allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            workspaceRoot: z.ZodOptional<z.ZodString>;
            network: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            lane: z.ZodLiteral<"subscription">;
            runtimeId: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
            }>;
            providerId: z.ZodNull;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok">;
            runtimeId: z.ZodLiteral<"pi">;
            providerId: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok-profile">;
            runtimeId: z.ZodLiteral<"pi">;
            providerProfile: z.ZodObject<{
                profileRef: z.ZodString;
                profileRevision: z.ZodString;
                profileHash: z.ZodString;
                modelId: z.ZodString;
                requiredCapabilities: z.ZodArray<z.ZodEnum<{
                    "image-input": "image-input";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>], "lane">>;
        terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"none">;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"result-document">;
            contract: z.ZodString;
        }, z.core.$strict>], "mode">>;
        limits: z.ZodOptional<z.ZodObject<{
            maxDurationMs: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        egressPolicy: z.ZodObject<{
            policyRevision: z.ZodString;
            activity: z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"metadata-status">;
                delivery: z.ZodLiteral<"latest-value">;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"contentful-trajectory">;
                delivery: z.ZodLiteral<"latest-value">;
                maxCoalesceMs: z.ZodNumber;
                maxEventBytes: z.ZodNumber;
            }, z.core.$strict>], "mode">;
            reliable: z.ZodObject<{
                maxPendingEventsPerAgent: z.ZodNumber;
                maxPendingBytesPerAgent: z.ZodNumber;
                maxPendingBytesPerTenant: z.ZodNumber;
            }, z.core.$strict>;
            transfers: z.ZodObject<{
                workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
                transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
                artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        messageEgress: z.ZodOptional<z.ZodObject<{
            mode: z.ZodLiteral<"required">;
            contract: z.ZodString;
            contentType: z.ZodEnum<{
                "text/markdown": "text/markdown";
                "text/plain": "text/plain";
            }>;
            maxBytes: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"agent.egress.ack">;
    task_id: z.ZodOptional<z.ZodString>;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        policyRevision: z.ZodString;
        eventId: z.ZodUUID;
        cursor: z.ZodNumber;
        receiptId: z.ZodUUID;
    }, z.core.$strict>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"agent.message.disposition">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        contract: z.ZodString;
        messageId: z.ZodUUID;
        cursor: z.ZodNumber;
        contentHash: z.ZodString;
        outcome: z.ZodEnum<{
            accepted: "accepted";
            held: "held";
            refused: "refused";
        }>;
        receiptId: z.ZodUUID;
        reasonCode: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"agent.content.read">;
    task_id: z.ZodOptional<z.ZodString>;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        requestId: z.ZodUUID;
        surface: z.ZodEnum<{
            artifact: "artifact";
            transcript: "transcript";
            workspace: "workspace";
        }>;
        actor: z.ZodObject<{
            kind: z.ZodEnum<{
                agent: "agent";
                system: "system";
                user: "user";
            }>;
            id: z.ZodString;
        }, z.core.$strict>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        runtime: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>;
        cwd: z.ZodString;
        policyRevision: z.ZodString;
        target: z.ZodString;
        mimeType: z.ZodString;
        decodeAs: z.ZodEnum<{
            bytes: "bytes";
            utf8: "utf8";
        }>;
        policy: z.ZodObject<{
            maxBytes: z.ZodNumber;
            allowedMimeTypes: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"agent.home.projection">;
    task_id: z.ZodOptional<z.ZodNever>;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        requestId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        projectionHash: z.ZodString;
        projection: z.ZodType<import("./agent-home-projection").AgentHomeProjectionValue, unknown, z.core.$ZodTypeInternals<import("./agent-home-projection").AgentHomeProjectionValue, unknown>>;
    }, z.core.$strict>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.approve">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        approvalId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.reject">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        reason: z.ZodOptional<z.ZodString>;
        approvalId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.cancel">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.steer">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
    payload: z.ZodObject<{
        text: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.claim">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{
        deviceId: z.ZodString;
        agentId: z.ZodOptional<z.ZodString>;
        agentRef: z.ZodOptional<z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        capabilities: z.ZodOptional<z.ZodObject<{
            steer: z.ZodOptional<z.ZodBoolean>;
            resume: z.ZodOptional<z.ZodBoolean>;
            approvalInteractive: z.ZodOptional<z.ZodBoolean>;
            mcpToolsets: z.ZodOptional<z.ZodBoolean>;
            permissionModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.started">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{}, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.decline">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{
        reason: z.ZodString;
        retryable: z.ZodOptional<z.ZodBoolean>;
        agentRef: z.ZodOptional<z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.progress">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{
        seq: z.ZodNumber;
        events: z.ZodArray<z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"progress">;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"tool_use">;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodUnknown>;
            toolCallId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"tool_result">;
            tool: z.ZodString;
            output: z.ZodOptional<z.ZodUnknown>;
            toolCallId: z.ZodOptional<z.ZodString>;
            isError: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"artifact">;
            name: z.ZodString;
            contentType: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"needs_approval">;
            summary: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"turn_end">;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"error">;
            message: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"usage">;
            inputTokens: z.ZodOptional<z.ZodNumber>;
            cachedInputTokens: z.ZodOptional<z.ZodNumber>;
            outputTokens: z.ZodOptional<z.ZodNumber>;
            reasoningTokens: z.ZodOptional<z.ZodNumber>;
            totalTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>], "type">, z.ZodObject<{
            type: z.ZodString;
        }, z.core.$loose>]>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.artifact">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{
        name: z.ZodString;
        contentType: z.ZodString;
        inline: z.ZodOptional<z.ZodString>;
        blobRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.await_approval">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{
        summary: z.ZodString;
        approvalId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.complete">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{
        summary: z.ZodString;
        sessionRef: z.ZodString;
        artifactRefs: z.ZodOptional<z.ZodArray<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        document: z.ZodOptional<z.ZodUnknown>;
        usage: z.ZodOptional<z.ZodObject<{
            runtime: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            provider: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            promptTokens: z.ZodOptional<z.ZodNumber>;
            completionTokens: z.ZodOptional<z.ZodNumber>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            clientVersion: z.ZodString;
            reportedAt: z.ZodISODateTime;
        }, z.core.$strip>>;
        agentRef: z.ZodOptional<z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.fail">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{
        reason: z.ZodString;
        retryable: z.ZodOptional<z.ZodBoolean>;
        usage: z.ZodOptional<z.ZodObject<{
            runtime: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            provider: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            promptTokens: z.ZodOptional<z.ZodNumber>;
            completionTokens: z.ZodOptional<z.ZodNumber>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            clientVersion: z.ZodString;
            reportedAt: z.ZodISODateTime;
        }, z.core.$strip>>;
        agentRef: z.ZodOptional<z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.cancelled">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{
        reason: z.ZodOptional<z.ZodString>;
        usage: z.ZodOptional<z.ZodObject<{
            runtime: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            provider: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            promptTokens: z.ZodOptional<z.ZodNumber>;
            completionTokens: z.ZodOptional<z.ZodNumber>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            clientVersion: z.ZodString;
            reportedAt: z.ZodISODateTime;
        }, z.core.$strip>>;
        agentRef: z.ZodOptional<z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"task.approval_resolved">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{
        approvalId: z.ZodString;
        decision: z.ZodEnum<{
            approve: "approve";
            reject: "reject";
        }>;
        resolvedBy: z.ZodEnum<{
            local: "local";
        }>;
        at: z.ZodISODateTime;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"agent.egress.reliable">;
    task_id: z.ZodOptional<z.ZodString>;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        policyRevision: z.ZodString;
        eventId: z.ZodUUID;
        cursor: z.ZodNumber;
        payload: z.ZodJSONSchema;
        contentHash: z.ZodString;
        byteCount: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"agent.message.publish">;
    task_id: z.ZodString;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodObject<{
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        contract: z.ZodString;
        messageId: z.ZodUUID;
        cursor: z.ZodNumber;
        contentType: z.ZodEnum<{
            "text/markdown": "text/markdown";
            "text/plain": "text/plain";
        }>;
        body: z.ZodString;
        contentHash: z.ZodString;
        byteCount: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strip>, z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<"agent.content.receipt">;
    task_id: z.ZodOptional<z.ZodString>;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
        requestId: z.ZodUUID;
        eventId: z.ZodUUID;
        cursor: z.ZodNumber;
        surface: z.ZodEnum<{
            artifact: "artifact";
            transcript: "transcript";
            workspace: "workspace";
        }>;
        actor: z.ZodObject<{
            kind: z.ZodEnum<{
                agent: "agent";
                system: "system";
                user: "user";
            }>;
            id: z.ZodString;
        }, z.core.$strict>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        runtime: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>;
        cwd: z.ZodString;
        policyRevision: z.ZodString;
        target: z.ZodString;
        mimeType: z.ZodString;
        decodeAs: z.ZodEnum<{
            bytes: "bytes";
            utf8: "utf8";
        }>;
        decision: z.ZodLiteral<"allowed">;
        byteCount: z.ZodNumber;
        contentHash: z.ZodString;
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>, z.ZodObject<{
        requestId: z.ZodUUID;
        eventId: z.ZodUUID;
        cursor: z.ZodNumber;
        surface: z.ZodEnum<{
            artifact: "artifact";
            transcript: "transcript";
            workspace: "workspace";
        }>;
        actor: z.ZodObject<{
            kind: z.ZodEnum<{
                agent: "agent";
                system: "system";
                user: "user";
            }>;
            id: z.ZodString;
        }, z.core.$strict>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        runtime: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>;
        cwd: z.ZodString;
        policyRevision: z.ZodString;
        target: z.ZodString;
        mimeType: z.ZodString;
        decodeAs: z.ZodEnum<{
            bytes: "bytes";
            utf8: "utf8";
        }>;
        decision: z.ZodLiteral<"denied">;
        byteCount: z.ZodLiteral<0>;
        reason: z.ZodEnum<{
            "absolute-target": "absolute-target";
            "byte-limit": "byte-limit";
            "capability-missing": "capability-missing";
            "dot-segment": "dot-segment";
            "identity-mismatch": "identity-mismatch";
            "invalid-request": "invalid-request";
            "mime-not-allowlisted": "mime-not-allowlisted";
            "non-relative-target": "non-relative-target";
            "not-regular-file": "not-regular-file";
            "path-escape": "path-escape";
            "policy-disabled": "policy-disabled";
            "policy-revision-mismatch": "policy-revision-mismatch";
            "root-invalid": "root-invalid";
            "root-not-allowlisted": "root-not-allowlisted";
            "sensitive-name": "sensitive-name";
            symlink: "symlink";
            "target-missing": "target-missing";
            "text-decode-failed": "text-decode-failed";
            "text-not-allowlisted": "text-not-allowlisted";
        }>;
    }, z.core.$strict>], "decision">;
}, z.core.$strip>], "type">;
export type Envelope = z.infer<typeof EnvelopeSchema>;
/** `true` for every message type the server sends to the daemon (envelope `seq` is required for these). */
export declare function isServerToDaemonType(type: MessageType): boolean;
// ==== @byok-sdk/protocol dist/errors.d.ts ====
import type { ZodError } from 'zod';
/** Base class for all protocol decode/validation errors. */
export declare class ProtocolError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/** The input was not valid JSON at all (only thrown by `decodeEnvelope`). */
export declare class EnvelopeParseError extends ProtocolError {
    constructor(message: string, cause?: unknown);
}
/**
 * The `type` field did not match any known message type. This is distinct
 * from {@link EnvelopeValidationError} on purpose: a daemon/server on an
 * older minor version should catch this specifically and skip the message
 * instead of treating it as a bug, since a newer peer may have introduced an
 * additive message type it doesn't understand yet.
 */
export declare class UnknownMessageTypeError extends ProtocolError {
    readonly type: unknown;
    constructor(type: unknown);
}
/** The `type` field was recognized but the envelope/payload failed schema validation. */
export declare class EnvelopeValidationError extends ProtocolError {
    readonly issues: ZodError;
    constructor(message: string, issues: ZodError);
}
// ==== @byok-sdk/protocol dist/http-api.d.ts ====
import { z } from 'zod';
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
export declare const PairRequestSchema: z.ZodObject<{
    pairingCode: z.ZodString;
    deviceName: z.ZodString;
    devicePublicKey: z.ZodString;
    machineId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
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
export declare const PAIR_RESPONSE_TENANT_ID_MAX_LENGTH = 200;
export declare const PairResponseTenantIdSchema: z.ZodString;
export declare const PairResponseSchema: z.ZodObject<{
    deviceId: z.ZodString;
    accessToken: z.ZodString;
    refreshHint: z.ZodOptional<z.ZodString>;
    tenantId: z.ZodString;
}, z.core.$strip>;
export type PairResponse = z.infer<typeof PairResponseSchema>;
export declare const ChallengeRequestSchema: z.ZodObject<{
    deviceId: z.ZodString;
}, z.core.$strip>;
export type ChallengeRequest = z.infer<typeof ChallengeRequestSchema>;
export declare const ChallengeResponseSchema: z.ZodObject<{
    nonce: z.ZodString;
}, z.core.$strip>;
export type ChallengeResponse = z.infer<typeof ChallengeResponseSchema>;
export declare const TokenRequestSchema: z.ZodObject<{
    deviceId: z.ZodString;
    nonce: z.ZodString;
    signature: z.ZodString;
}, z.core.$strip>;
export type TokenRequest = z.infer<typeof TokenRequestSchema>;
export declare const TokenResponseSchema: z.ZodObject<{
    accessToken: z.ZodString;
    expiresAt: z.ZodISODateTime;
}, z.core.$strip>;
export type TokenResponse = z.infer<typeof TokenResponseSchema>;
/** The hosted default is byte-bounded independently; this caps protocol input before it reaches a handler. */
export declare const PRESENCE_DETAIL_MAX_LENGTH = 512;
export declare const PRESENCE_RUNTIME_VERSION_MAX_LENGTH = 128;
export declare const PresencePublishRequestSchema: z.ZodObject<{
    level: z.ZodEnum<{
        error: "error";
        offline: "offline";
        online: "online";
        thinking: "thinking";
        working: "working";
    }>;
    detail: z.ZodOptional<z.ZodString>;
    configuredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    clientVersion: z.ZodOptional<z.ZodString>;
    protocolVersions: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
    runtimes: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>;
        version: z.ZodOptional<z.ZodString>;
        authPresent: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type PresencePublishRequest = z.infer<typeof PresencePublishRequestSchema>;
/**
 * Revocation is server-side only (dashboard/API call on the SaaS's own
 * device registry) — there is no wire message for it. A revoked device's
 * next `/byok/challenge` or `/byok/token` call (or WSS connect) gets a 401;
 * the daemon's only recourse is to re-run `/byok/pair` from scratch.
 */
/** POST /byok/blobs request: declare a blob before uploading it. `contentHash` must be the canonical `sha256:<64 lowercase hex>` form (finding F9) — the server rejects anything else outright, no normalization. */
export declare const CreateBlobRequestSchema: z.ZodObject<{
    size: z.ZodNumber;
    contentType: z.ZodString;
    contentHash: z.ZodString;
}, z.core.$strip>;
export type CreateBlobRequest = z.infer<typeof CreateBlobRequestSchema>;
/** POST /byok/blobs response: presigned PUT target for the declared blob. */
export declare const CreateBlobResponseSchema: z.ZodObject<{
    blobId: z.ZodString;
    uploadUrl: z.ZodString;
}, z.core.$strip>;
export type CreateBlobResponse = z.infer<typeof CreateBlobResponseSchema>;
/** GET /byok/blobs/:id/url response: presigned GET target for an existing blob. */
export declare const BlobDownloadUrlResponseSchema: z.ZodObject<{
    downloadUrl: z.ZodString;
}, z.core.$strip>;
export type BlobDownloadUrlResponse = z.infer<typeof BlobDownloadUrlResponseSchema>;
export declare const EventsPollQuerySchema: z.ZodObject<{
    cursor: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type EventsPollQuery = z.infer<typeof EventsPollQuerySchema>;
export declare const EventsPollResponseSchema: z.ZodObject<{
    events: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"conn.hello">;
        task_id: z.ZodOptional<z.ZodString>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            protocolVersions: z.ZodArray<z.ZodNumber>;
            capabilities: z.ZodArray<z.ZodString>;
            deviceId: z.ZodString;
            productId: z.ZodString;
            clientVersion: z.ZodOptional<z.ZodString>;
            runtimes: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                    pi: "pi";
                }>;
                version: z.ZodOptional<z.ZodString>;
                authPresent: z.ZodOptional<z.ZodBoolean>;
                capabilities: z.ZodOptional<z.ZodObject<{
                    steer: z.ZodOptional<z.ZodBoolean>;
                    resume: z.ZodOptional<z.ZodBoolean>;
                    approvalInteractive: z.ZodOptional<z.ZodBoolean>;
                    mcpToolsets: z.ZodOptional<z.ZodBoolean>;
                    permissionModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strip>>;
            }, z.core.$strip>>>;
            configuredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
            cursor: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"conn.ack">;
        task_id: z.ZodOptional<z.ZodString>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            protocolVersion: z.ZodNumber;
            capabilities: z.ZodArray<z.ZodString>;
            serverTime: z.ZodISODateTime;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.offer">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                blobRef: z.ZodObject<{
                    blobId: z.ZodString;
                    contentHash: z.ZodString;
                    size: z.ZodNumber;
                    contentType: z.ZodString;
                    url: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strict>]>;
            policy: z.ZodObject<{
                mode: z.ZodEnum<{
                    auto: "auto";
                    confirm: "confirm";
                    plan: "plan";
                    readonly: "readonly";
                }>;
                allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                network: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
            runtime: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>>;
            dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                lane: z.ZodLiteral<"subscription">;
                runtimeId: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                }>;
                providerId: z.ZodNull;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok">;
                runtimeId: z.ZodLiteral<"pi">;
                providerId: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok-profile">;
                runtimeId: z.ZodLiteral<"pi">;
                providerProfile: z.ZodObject<{
                    profileRef: z.ZodString;
                    profileRevision: z.ZodString;
                    profileHash: z.ZodString;
                    modelId: z.ZodString;
                    requiredCapabilities: z.ZodArray<z.ZodEnum<{
                        "image-input": "image-input";
                    }>>;
                }, z.core.$strict>;
            }, z.core.$strict>], "lane">>;
            sessionRef: z.ZodOptional<z.ZodString>;
            workspaceHint: z.ZodOptional<z.ZodString>;
            limits: z.ZodOptional<z.ZodObject<{
                maxDurationMs: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.offer_with_toolsets">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                blobRef: z.ZodObject<{
                    blobId: z.ZodString;
                    contentHash: z.ZodString;
                    size: z.ZodNumber;
                    contentType: z.ZodString;
                    url: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strict>]>;
            policy: z.ZodObject<{
                mode: z.ZodEnum<{
                    auto: "auto";
                    confirm: "confirm";
                    plan: "plan";
                    readonly: "readonly";
                }>;
                allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                network: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
            runtime: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>>;
            dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                lane: z.ZodLiteral<"subscription">;
                runtimeId: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                }>;
                providerId: z.ZodNull;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok">;
                runtimeId: z.ZodLiteral<"pi">;
                providerId: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok-profile">;
                runtimeId: z.ZodLiteral<"pi">;
                providerProfile: z.ZodObject<{
                    profileRef: z.ZodString;
                    profileRevision: z.ZodString;
                    profileHash: z.ZodString;
                    modelId: z.ZodString;
                    requiredCapabilities: z.ZodArray<z.ZodEnum<{
                        "image-input": "image-input";
                    }>>;
                }, z.core.$strict>;
            }, z.core.$strict>], "lane">>;
            sessionRef: z.ZodOptional<z.ZodString>;
            workspaceHint: z.ZodOptional<z.ZodString>;
            limits: z.ZodOptional<z.ZodObject<{
                maxDurationMs: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            requiredToolsets: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.offer_for_agent">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                blobRef: z.ZodObject<{
                    blobId: z.ZodString;
                    contentHash: z.ZodString;
                    size: z.ZodNumber;
                    contentType: z.ZodString;
                    url: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strict>]>;
            policy: z.ZodObject<{
                mode: z.ZodEnum<{
                    auto: "auto";
                    confirm: "confirm";
                    plan: "plan";
                    readonly: "readonly";
                }>;
                allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                network: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
            runtime: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>>;
            dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                lane: z.ZodLiteral<"subscription">;
                runtimeId: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                }>;
                providerId: z.ZodNull;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok">;
                runtimeId: z.ZodLiteral<"pi">;
                providerId: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok-profile">;
                runtimeId: z.ZodLiteral<"pi">;
                providerProfile: z.ZodObject<{
                    profileRef: z.ZodString;
                    profileRevision: z.ZodString;
                    profileHash: z.ZodString;
                    modelId: z.ZodString;
                    requiredCapabilities: z.ZodArray<z.ZodEnum<{
                        "image-input": "image-input";
                    }>>;
                }, z.core.$strict>;
            }, z.core.$strict>], "lane">>;
            terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"none">;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"result-document">;
                contract: z.ZodString;
            }, z.core.$strict>], "mode">>;
            sessionRef: z.ZodOptional<z.ZodString>;
            limits: z.ZodOptional<z.ZodObject<{
                maxDurationMs: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.offer_for_agent_with_egress">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                blobRef: z.ZodObject<{
                    blobId: z.ZodString;
                    contentHash: z.ZodString;
                    size: z.ZodNumber;
                    contentType: z.ZodString;
                    url: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strict>]>;
            policy: z.ZodObject<{
                mode: z.ZodEnum<{
                    auto: "auto";
                    confirm: "confirm";
                    plan: "plan";
                    readonly: "readonly";
                }>;
                allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                network: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
            runtime: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>>;
            dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                lane: z.ZodLiteral<"subscription">;
                runtimeId: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                }>;
                providerId: z.ZodNull;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok">;
                runtimeId: z.ZodLiteral<"pi">;
                providerId: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok-profile">;
                runtimeId: z.ZodLiteral<"pi">;
                providerProfile: z.ZodObject<{
                    profileRef: z.ZodString;
                    profileRevision: z.ZodString;
                    profileHash: z.ZodString;
                    modelId: z.ZodString;
                    requiredCapabilities: z.ZodArray<z.ZodEnum<{
                        "image-input": "image-input";
                    }>>;
                }, z.core.$strict>;
            }, z.core.$strict>], "lane">>;
            terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"none">;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"result-document">;
                contract: z.ZodString;
            }, z.core.$strict>], "mode">>;
            limits: z.ZodOptional<z.ZodObject<{
                maxDurationMs: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            sessionRef: z.ZodString;
            egressPolicy: z.ZodObject<{
                policyRevision: z.ZodString;
                activity: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    mode: z.ZodLiteral<"metadata-status">;
                    delivery: z.ZodLiteral<"latest-value">;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"contentful-trajectory">;
                    delivery: z.ZodLiteral<"latest-value">;
                    maxCoalesceMs: z.ZodNumber;
                    maxEventBytes: z.ZodNumber;
                }, z.core.$strict>], "mode">;
                reliable: z.ZodObject<{
                    maxPendingEventsPerAgent: z.ZodNumber;
                    maxPendingBytesPerAgent: z.ZodNumber;
                    maxPendingBytesPerTenant: z.ZodNumber;
                }, z.core.$strict>;
                transfers: z.ZodObject<{
                    workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                        maxBytes: z.ZodNumber;
                        allowedMimeTypes: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>]>;
                    transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                        maxBytes: z.ZodNumber;
                        allowedMimeTypes: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>]>;
                    artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                        maxBytes: z.ZodNumber;
                        allowedMimeTypes: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>]>;
                }, z.core.$strict>;
            }, z.core.$strict>;
            messageEgress: z.ZodOptional<z.ZodObject<{
                mode: z.ZodLiteral<"required">;
                contract: z.ZodString;
                contentType: z.ZodEnum<{
                    "text/markdown": "text/markdown";
                    "text/plain": "text/plain";
                }>;
                maxBytes: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.offer_for_agent_with_egress_fresh">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                blobRef: z.ZodObject<{
                    blobId: z.ZodString;
                    contentHash: z.ZodString;
                    size: z.ZodNumber;
                    contentType: z.ZodString;
                    url: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strict>]>;
            policy: z.ZodObject<{
                mode: z.ZodEnum<{
                    auto: "auto";
                    confirm: "confirm";
                    plan: "plan";
                    readonly: "readonly";
                }>;
                allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                network: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
            runtime: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>>;
            dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                lane: z.ZodLiteral<"subscription">;
                runtimeId: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                }>;
                providerId: z.ZodNull;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok">;
                runtimeId: z.ZodLiteral<"pi">;
                providerId: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok-profile">;
                runtimeId: z.ZodLiteral<"pi">;
                providerProfile: z.ZodObject<{
                    profileRef: z.ZodString;
                    profileRevision: z.ZodString;
                    profileHash: z.ZodString;
                    modelId: z.ZodString;
                    requiredCapabilities: z.ZodArray<z.ZodEnum<{
                        "image-input": "image-input";
                    }>>;
                }, z.core.$strict>;
            }, z.core.$strict>], "lane">>;
            terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"none">;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"result-document">;
                contract: z.ZodString;
            }, z.core.$strict>], "mode">>;
            limits: z.ZodOptional<z.ZodObject<{
                maxDurationMs: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            egressPolicy: z.ZodObject<{
                policyRevision: z.ZodString;
                activity: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    mode: z.ZodLiteral<"metadata-status">;
                    delivery: z.ZodLiteral<"latest-value">;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"contentful-trajectory">;
                    delivery: z.ZodLiteral<"latest-value">;
                    maxCoalesceMs: z.ZodNumber;
                    maxEventBytes: z.ZodNumber;
                }, z.core.$strict>], "mode">;
                reliable: z.ZodObject<{
                    maxPendingEventsPerAgent: z.ZodNumber;
                    maxPendingBytesPerAgent: z.ZodNumber;
                    maxPendingBytesPerTenant: z.ZodNumber;
                }, z.core.$strict>;
                transfers: z.ZodObject<{
                    workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                        maxBytes: z.ZodNumber;
                        allowedMimeTypes: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>]>;
                    transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                        maxBytes: z.ZodNumber;
                        allowedMimeTypes: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>]>;
                    artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                        maxBytes: z.ZodNumber;
                        allowedMimeTypes: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>]>;
                }, z.core.$strict>;
            }, z.core.$strict>;
            messageEgress: z.ZodOptional<z.ZodObject<{
                mode: z.ZodLiteral<"required">;
                contract: z.ZodString;
                contentType: z.ZodEnum<{
                    "text/markdown": "text/markdown";
                    "text/plain": "text/plain";
                }>;
                maxBytes: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.egress.ack">;
        task_id: z.ZodOptional<z.ZodString>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            policyRevision: z.ZodString;
            eventId: z.ZodUUID;
            cursor: z.ZodNumber;
            receiptId: z.ZodUUID;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.message.disposition">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            contract: z.ZodString;
            messageId: z.ZodUUID;
            cursor: z.ZodNumber;
            contentHash: z.ZodString;
            outcome: z.ZodEnum<{
                accepted: "accepted";
                held: "held";
                refused: "refused";
            }>;
            receiptId: z.ZodUUID;
            reasonCode: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.content.read">;
        task_id: z.ZodOptional<z.ZodString>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            requestId: z.ZodUUID;
            surface: z.ZodEnum<{
                artifact: "artifact";
                transcript: "transcript";
                workspace: "workspace";
            }>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    agent: "agent";
                    system: "system";
                    user: "user";
                }>;
                id: z.ZodString;
            }, z.core.$strict>;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            runtime: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            cwd: z.ZodString;
            policyRevision: z.ZodString;
            target: z.ZodString;
            mimeType: z.ZodString;
            decodeAs: z.ZodEnum<{
                bytes: "bytes";
                utf8: "utf8";
            }>;
            policy: z.ZodObject<{
                maxBytes: z.ZodNumber;
                allowedMimeTypes: z.ZodArray<z.ZodString>;
            }, z.core.$strict>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.home.projection">;
        task_id: z.ZodOptional<z.ZodNever>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            requestId: z.ZodUUID;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            projectionHash: z.ZodString;
            projection: z.ZodType<import("./agent-home-projection").AgentHomeProjectionValue, unknown, z.core.$ZodTypeInternals<import("./agent-home-projection").AgentHomeProjectionValue, unknown>>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.approve">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            approvalId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.reject">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            reason: z.ZodOptional<z.ZodString>;
            approvalId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.cancel">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            reason: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.steer">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            text: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.claim">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            deviceId: z.ZodString;
            agentId: z.ZodOptional<z.ZodString>;
            agentRef: z.ZodOptional<z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>>;
            runtime: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>>;
            capabilities: z.ZodOptional<z.ZodObject<{
                steer: z.ZodOptional<z.ZodBoolean>;
                resume: z.ZodOptional<z.ZodBoolean>;
                approvalInteractive: z.ZodOptional<z.ZodBoolean>;
                mcpToolsets: z.ZodOptional<z.ZodBoolean>;
                permissionModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.started">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{}, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.decline">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            reason: z.ZodString;
            retryable: z.ZodOptional<z.ZodBoolean>;
            agentRef: z.ZodOptional<z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.progress">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            seq: z.ZodNumber;
            events: z.ZodArray<z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"progress">;
                text: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"tool_use">;
                tool: z.ZodString;
                input: z.ZodOptional<z.ZodUnknown>;
                toolCallId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"tool_result">;
                tool: z.ZodString;
                output: z.ZodOptional<z.ZodUnknown>;
                toolCallId: z.ZodOptional<z.ZodString>;
                isError: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"artifact">;
                name: z.ZodString;
                contentType: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"needs_approval">;
                summary: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"turn_end">;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"error">;
                message: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"usage">;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                cachedInputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
                reasoningTokens: z.ZodOptional<z.ZodNumber>;
                totalTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>], "type">, z.ZodObject<{
                type: z.ZodString;
            }, z.core.$loose>]>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.artifact">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            name: z.ZodString;
            contentType: z.ZodString;
            inline: z.ZodOptional<z.ZodString>;
            blobRef: z.ZodOptional<z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.await_approval">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            summary: z.ZodString;
            approvalId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.complete">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            summary: z.ZodString;
            sessionRef: z.ZodString;
            artifactRefs: z.ZodOptional<z.ZodArray<z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            document: z.ZodOptional<z.ZodUnknown>;
            usage: z.ZodOptional<z.ZodObject<{
                runtime: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                    pi: "pi";
                }>;
                provider: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                promptTokens: z.ZodOptional<z.ZodNumber>;
                completionTokens: z.ZodOptional<z.ZodNumber>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                clientVersion: z.ZodString;
                reportedAt: z.ZodISODateTime;
            }, z.core.$strip>>;
            agentRef: z.ZodOptional<z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.fail">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            reason: z.ZodString;
            retryable: z.ZodOptional<z.ZodBoolean>;
            usage: z.ZodOptional<z.ZodObject<{
                runtime: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                    pi: "pi";
                }>;
                provider: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                promptTokens: z.ZodOptional<z.ZodNumber>;
                completionTokens: z.ZodOptional<z.ZodNumber>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                clientVersion: z.ZodString;
                reportedAt: z.ZodISODateTime;
            }, z.core.$strip>>;
            agentRef: z.ZodOptional<z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.cancelled">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            reason: z.ZodOptional<z.ZodString>;
            usage: z.ZodOptional<z.ZodObject<{
                runtime: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                    pi: "pi";
                }>;
                provider: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                promptTokens: z.ZodOptional<z.ZodNumber>;
                completionTokens: z.ZodOptional<z.ZodNumber>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                clientVersion: z.ZodString;
                reportedAt: z.ZodISODateTime;
            }, z.core.$strip>>;
            agentRef: z.ZodOptional<z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.approval_resolved">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            approvalId: z.ZodString;
            decision: z.ZodEnum<{
                approve: "approve";
                reject: "reject";
            }>;
            resolvedBy: z.ZodEnum<{
                local: "local";
            }>;
            at: z.ZodISODateTime;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.egress.reliable">;
        task_id: z.ZodOptional<z.ZodString>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            policyRevision: z.ZodString;
            eventId: z.ZodUUID;
            cursor: z.ZodNumber;
            payload: z.ZodJSONSchema;
            contentHash: z.ZodString;
            byteCount: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.message.publish">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            contract: z.ZodString;
            messageId: z.ZodUUID;
            cursor: z.ZodNumber;
            contentType: z.ZodEnum<{
                "text/markdown": "text/markdown";
                "text/plain": "text/plain";
            }>;
            body: z.ZodString;
            contentHash: z.ZodString;
            byteCount: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.content.receipt">;
        task_id: z.ZodOptional<z.ZodString>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
            requestId: z.ZodUUID;
            eventId: z.ZodUUID;
            cursor: z.ZodNumber;
            surface: z.ZodEnum<{
                artifact: "artifact";
                transcript: "transcript";
                workspace: "workspace";
            }>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    agent: "agent";
                    system: "system";
                    user: "user";
                }>;
                id: z.ZodString;
            }, z.core.$strict>;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            runtime: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            cwd: z.ZodString;
            policyRevision: z.ZodString;
            target: z.ZodString;
            mimeType: z.ZodString;
            decodeAs: z.ZodEnum<{
                bytes: "bytes";
                utf8: "utf8";
            }>;
            decision: z.ZodLiteral<"allowed">;
            byteCount: z.ZodNumber;
            contentHash: z.ZodString;
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>, z.ZodObject<{
            requestId: z.ZodUUID;
            eventId: z.ZodUUID;
            cursor: z.ZodNumber;
            surface: z.ZodEnum<{
                artifact: "artifact";
                transcript: "transcript";
                workspace: "workspace";
            }>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    agent: "agent";
                    system: "system";
                    user: "user";
                }>;
                id: z.ZodString;
            }, z.core.$strict>;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            runtime: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            cwd: z.ZodString;
            policyRevision: z.ZodString;
            target: z.ZodString;
            mimeType: z.ZodString;
            decodeAs: z.ZodEnum<{
                bytes: "bytes";
                utf8: "utf8";
            }>;
            decision: z.ZodLiteral<"denied">;
            byteCount: z.ZodLiteral<0>;
            reason: z.ZodEnum<{
                "absolute-target": "absolute-target";
                "byte-limit": "byte-limit";
                "capability-missing": "capability-missing";
                "dot-segment": "dot-segment";
                "identity-mismatch": "identity-mismatch";
                "invalid-request": "invalid-request";
                "mime-not-allowlisted": "mime-not-allowlisted";
                "non-relative-target": "non-relative-target";
                "not-regular-file": "not-regular-file";
                "path-escape": "path-escape";
                "policy-disabled": "policy-disabled";
                "policy-revision-mismatch": "policy-revision-mismatch";
                "root-invalid": "root-invalid";
                "root-not-allowlisted": "root-not-allowlisted";
                "sensitive-name": "sensitive-name";
                symlink: "symlink";
                "target-missing": "target-missing";
                "text-decode-failed": "text-decode-failed";
                "text-not-allowlisted": "text-not-allowlisted";
            }>;
        }, z.core.$strict>], "decision">;
    }, z.core.$strip>], "type">>;
    cursor: z.ZodNumber;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type EventsPollResponse = z.infer<typeof EventsPollResponseSchema>;
/**
 * Batch size ceiling for a single `POST /byok/messages` call — generous for
 * normal redelivery-catchup bursts, but bounded so one request can't force
 * the server to process an unbounded batch. Exported (not just a local
 * const) so the client's own outbound drain (`ConnectionManager.drainOutbox`,
 * finding P1) can chunk against the exact same number instead of a
 * hard-coded, driftable copy of it.
 */
export declare const MAX_MESSAGES_PER_BATCH = 256;
export declare const MessagesSendRequestSchema: z.ZodObject<{
    messages: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"conn.hello">;
        task_id: z.ZodOptional<z.ZodString>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            protocolVersions: z.ZodArray<z.ZodNumber>;
            capabilities: z.ZodArray<z.ZodString>;
            deviceId: z.ZodString;
            productId: z.ZodString;
            clientVersion: z.ZodOptional<z.ZodString>;
            runtimes: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                    pi: "pi";
                }>;
                version: z.ZodOptional<z.ZodString>;
                authPresent: z.ZodOptional<z.ZodBoolean>;
                capabilities: z.ZodOptional<z.ZodObject<{
                    steer: z.ZodOptional<z.ZodBoolean>;
                    resume: z.ZodOptional<z.ZodBoolean>;
                    approvalInteractive: z.ZodOptional<z.ZodBoolean>;
                    mcpToolsets: z.ZodOptional<z.ZodBoolean>;
                    permissionModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strip>>;
            }, z.core.$strip>>>;
            configuredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
            cursor: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"conn.ack">;
        task_id: z.ZodOptional<z.ZodString>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            protocolVersion: z.ZodNumber;
            capabilities: z.ZodArray<z.ZodString>;
            serverTime: z.ZodISODateTime;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.offer">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                blobRef: z.ZodObject<{
                    blobId: z.ZodString;
                    contentHash: z.ZodString;
                    size: z.ZodNumber;
                    contentType: z.ZodString;
                    url: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strict>]>;
            policy: z.ZodObject<{
                mode: z.ZodEnum<{
                    auto: "auto";
                    confirm: "confirm";
                    plan: "plan";
                    readonly: "readonly";
                }>;
                allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                network: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
            runtime: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>>;
            dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                lane: z.ZodLiteral<"subscription">;
                runtimeId: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                }>;
                providerId: z.ZodNull;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok">;
                runtimeId: z.ZodLiteral<"pi">;
                providerId: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok-profile">;
                runtimeId: z.ZodLiteral<"pi">;
                providerProfile: z.ZodObject<{
                    profileRef: z.ZodString;
                    profileRevision: z.ZodString;
                    profileHash: z.ZodString;
                    modelId: z.ZodString;
                    requiredCapabilities: z.ZodArray<z.ZodEnum<{
                        "image-input": "image-input";
                    }>>;
                }, z.core.$strict>;
            }, z.core.$strict>], "lane">>;
            sessionRef: z.ZodOptional<z.ZodString>;
            workspaceHint: z.ZodOptional<z.ZodString>;
            limits: z.ZodOptional<z.ZodObject<{
                maxDurationMs: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.offer_with_toolsets">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                blobRef: z.ZodObject<{
                    blobId: z.ZodString;
                    contentHash: z.ZodString;
                    size: z.ZodNumber;
                    contentType: z.ZodString;
                    url: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strict>]>;
            policy: z.ZodObject<{
                mode: z.ZodEnum<{
                    auto: "auto";
                    confirm: "confirm";
                    plan: "plan";
                    readonly: "readonly";
                }>;
                allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                network: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
            runtime: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>>;
            dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                lane: z.ZodLiteral<"subscription">;
                runtimeId: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                }>;
                providerId: z.ZodNull;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok">;
                runtimeId: z.ZodLiteral<"pi">;
                providerId: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok-profile">;
                runtimeId: z.ZodLiteral<"pi">;
                providerProfile: z.ZodObject<{
                    profileRef: z.ZodString;
                    profileRevision: z.ZodString;
                    profileHash: z.ZodString;
                    modelId: z.ZodString;
                    requiredCapabilities: z.ZodArray<z.ZodEnum<{
                        "image-input": "image-input";
                    }>>;
                }, z.core.$strict>;
            }, z.core.$strict>], "lane">>;
            sessionRef: z.ZodOptional<z.ZodString>;
            workspaceHint: z.ZodOptional<z.ZodString>;
            limits: z.ZodOptional<z.ZodObject<{
                maxDurationMs: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            requiredToolsets: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.offer_for_agent">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                blobRef: z.ZodObject<{
                    blobId: z.ZodString;
                    contentHash: z.ZodString;
                    size: z.ZodNumber;
                    contentType: z.ZodString;
                    url: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strict>]>;
            policy: z.ZodObject<{
                mode: z.ZodEnum<{
                    auto: "auto";
                    confirm: "confirm";
                    plan: "plan";
                    readonly: "readonly";
                }>;
                allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                network: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
            runtime: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>>;
            dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                lane: z.ZodLiteral<"subscription">;
                runtimeId: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                }>;
                providerId: z.ZodNull;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok">;
                runtimeId: z.ZodLiteral<"pi">;
                providerId: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok-profile">;
                runtimeId: z.ZodLiteral<"pi">;
                providerProfile: z.ZodObject<{
                    profileRef: z.ZodString;
                    profileRevision: z.ZodString;
                    profileHash: z.ZodString;
                    modelId: z.ZodString;
                    requiredCapabilities: z.ZodArray<z.ZodEnum<{
                        "image-input": "image-input";
                    }>>;
                }, z.core.$strict>;
            }, z.core.$strict>], "lane">>;
            terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"none">;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"result-document">;
                contract: z.ZodString;
            }, z.core.$strict>], "mode">>;
            sessionRef: z.ZodOptional<z.ZodString>;
            limits: z.ZodOptional<z.ZodObject<{
                maxDurationMs: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.offer_for_agent_with_egress">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                blobRef: z.ZodObject<{
                    blobId: z.ZodString;
                    contentHash: z.ZodString;
                    size: z.ZodNumber;
                    contentType: z.ZodString;
                    url: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strict>]>;
            policy: z.ZodObject<{
                mode: z.ZodEnum<{
                    auto: "auto";
                    confirm: "confirm";
                    plan: "plan";
                    readonly: "readonly";
                }>;
                allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                network: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
            runtime: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>>;
            dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                lane: z.ZodLiteral<"subscription">;
                runtimeId: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                }>;
                providerId: z.ZodNull;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok">;
                runtimeId: z.ZodLiteral<"pi">;
                providerId: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok-profile">;
                runtimeId: z.ZodLiteral<"pi">;
                providerProfile: z.ZodObject<{
                    profileRef: z.ZodString;
                    profileRevision: z.ZodString;
                    profileHash: z.ZodString;
                    modelId: z.ZodString;
                    requiredCapabilities: z.ZodArray<z.ZodEnum<{
                        "image-input": "image-input";
                    }>>;
                }, z.core.$strict>;
            }, z.core.$strict>], "lane">>;
            terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"none">;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"result-document">;
                contract: z.ZodString;
            }, z.core.$strict>], "mode">>;
            limits: z.ZodOptional<z.ZodObject<{
                maxDurationMs: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            sessionRef: z.ZodString;
            egressPolicy: z.ZodObject<{
                policyRevision: z.ZodString;
                activity: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    mode: z.ZodLiteral<"metadata-status">;
                    delivery: z.ZodLiteral<"latest-value">;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"contentful-trajectory">;
                    delivery: z.ZodLiteral<"latest-value">;
                    maxCoalesceMs: z.ZodNumber;
                    maxEventBytes: z.ZodNumber;
                }, z.core.$strict>], "mode">;
                reliable: z.ZodObject<{
                    maxPendingEventsPerAgent: z.ZodNumber;
                    maxPendingBytesPerAgent: z.ZodNumber;
                    maxPendingBytesPerTenant: z.ZodNumber;
                }, z.core.$strict>;
                transfers: z.ZodObject<{
                    workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                        maxBytes: z.ZodNumber;
                        allowedMimeTypes: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>]>;
                    transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                        maxBytes: z.ZodNumber;
                        allowedMimeTypes: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>]>;
                    artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                        maxBytes: z.ZodNumber;
                        allowedMimeTypes: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>]>;
                }, z.core.$strict>;
            }, z.core.$strict>;
            messageEgress: z.ZodOptional<z.ZodObject<{
                mode: z.ZodLiteral<"required">;
                contract: z.ZodString;
                contentType: z.ZodEnum<{
                    "text/markdown": "text/markdown";
                    "text/plain": "text/plain";
                }>;
                maxBytes: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.offer_for_agent_with_egress_fresh">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                blobRef: z.ZodObject<{
                    blobId: z.ZodString;
                    contentHash: z.ZodString;
                    size: z.ZodNumber;
                    contentType: z.ZodString;
                    url: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strict>]>;
            policy: z.ZodObject<{
                mode: z.ZodEnum<{
                    auto: "auto";
                    confirm: "confirm";
                    plan: "plan";
                    readonly: "readonly";
                }>;
                allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                network: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
            runtime: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>>;
            dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                lane: z.ZodLiteral<"subscription">;
                runtimeId: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                }>;
                providerId: z.ZodNull;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok">;
                runtimeId: z.ZodLiteral<"pi">;
                providerId: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                lane: z.ZodLiteral<"byok-profile">;
                runtimeId: z.ZodLiteral<"pi">;
                providerProfile: z.ZodObject<{
                    profileRef: z.ZodString;
                    profileRevision: z.ZodString;
                    profileHash: z.ZodString;
                    modelId: z.ZodString;
                    requiredCapabilities: z.ZodArray<z.ZodEnum<{
                        "image-input": "image-input";
                    }>>;
                }, z.core.$strict>;
            }, z.core.$strict>], "lane">>;
            terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"none">;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"result-document">;
                contract: z.ZodString;
            }, z.core.$strict>], "mode">>;
            limits: z.ZodOptional<z.ZodObject<{
                maxDurationMs: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            egressPolicy: z.ZodObject<{
                policyRevision: z.ZodString;
                activity: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    mode: z.ZodLiteral<"metadata-status">;
                    delivery: z.ZodLiteral<"latest-value">;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"contentful-trajectory">;
                    delivery: z.ZodLiteral<"latest-value">;
                    maxCoalesceMs: z.ZodNumber;
                    maxEventBytes: z.ZodNumber;
                }, z.core.$strict>], "mode">;
                reliable: z.ZodObject<{
                    maxPendingEventsPerAgent: z.ZodNumber;
                    maxPendingBytesPerAgent: z.ZodNumber;
                    maxPendingBytesPerTenant: z.ZodNumber;
                }, z.core.$strict>;
                transfers: z.ZodObject<{
                    workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                        maxBytes: z.ZodNumber;
                        allowedMimeTypes: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>]>;
                    transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                        maxBytes: z.ZodNumber;
                        allowedMimeTypes: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>]>;
                    artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                        maxBytes: z.ZodNumber;
                        allowedMimeTypes: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>]>;
                }, z.core.$strict>;
            }, z.core.$strict>;
            messageEgress: z.ZodOptional<z.ZodObject<{
                mode: z.ZodLiteral<"required">;
                contract: z.ZodString;
                contentType: z.ZodEnum<{
                    "text/markdown": "text/markdown";
                    "text/plain": "text/plain";
                }>;
                maxBytes: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.egress.ack">;
        task_id: z.ZodOptional<z.ZodString>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            policyRevision: z.ZodString;
            eventId: z.ZodUUID;
            cursor: z.ZodNumber;
            receiptId: z.ZodUUID;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.message.disposition">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            contract: z.ZodString;
            messageId: z.ZodUUID;
            cursor: z.ZodNumber;
            contentHash: z.ZodString;
            outcome: z.ZodEnum<{
                accepted: "accepted";
                held: "held";
                refused: "refused";
            }>;
            receiptId: z.ZodUUID;
            reasonCode: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.content.read">;
        task_id: z.ZodOptional<z.ZodString>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            requestId: z.ZodUUID;
            surface: z.ZodEnum<{
                artifact: "artifact";
                transcript: "transcript";
                workspace: "workspace";
            }>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    agent: "agent";
                    system: "system";
                    user: "user";
                }>;
                id: z.ZodString;
            }, z.core.$strict>;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            runtime: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            cwd: z.ZodString;
            policyRevision: z.ZodString;
            target: z.ZodString;
            mimeType: z.ZodString;
            decodeAs: z.ZodEnum<{
                bytes: "bytes";
                utf8: "utf8";
            }>;
            policy: z.ZodObject<{
                maxBytes: z.ZodNumber;
                allowedMimeTypes: z.ZodArray<z.ZodString>;
            }, z.core.$strict>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.home.projection">;
        task_id: z.ZodOptional<z.ZodNever>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            requestId: z.ZodUUID;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            projectionHash: z.ZodString;
            projection: z.ZodType<import("./agent-home-projection").AgentHomeProjectionValue, unknown, z.core.$ZodTypeInternals<import("./agent-home-projection").AgentHomeProjectionValue, unknown>>;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.approve">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            approvalId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.reject">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            reason: z.ZodOptional<z.ZodString>;
            approvalId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.cancel">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            reason: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.steer">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
        payload: z.ZodObject<{
            text: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.claim">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            deviceId: z.ZodString;
            agentId: z.ZodOptional<z.ZodString>;
            agentRef: z.ZodOptional<z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>>;
            runtime: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>>;
            capabilities: z.ZodOptional<z.ZodObject<{
                steer: z.ZodOptional<z.ZodBoolean>;
                resume: z.ZodOptional<z.ZodBoolean>;
                approvalInteractive: z.ZodOptional<z.ZodBoolean>;
                mcpToolsets: z.ZodOptional<z.ZodBoolean>;
                permissionModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.started">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{}, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.decline">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            reason: z.ZodString;
            retryable: z.ZodOptional<z.ZodBoolean>;
            agentRef: z.ZodOptional<z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.progress">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            seq: z.ZodNumber;
            events: z.ZodArray<z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"progress">;
                text: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"tool_use">;
                tool: z.ZodString;
                input: z.ZodOptional<z.ZodUnknown>;
                toolCallId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"tool_result">;
                tool: z.ZodString;
                output: z.ZodOptional<z.ZodUnknown>;
                toolCallId: z.ZodOptional<z.ZodString>;
                isError: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"artifact">;
                name: z.ZodString;
                contentType: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"needs_approval">;
                summary: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"turn_end">;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"error">;
                message: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"usage">;
                inputTokens: z.ZodOptional<z.ZodNumber>;
                cachedInputTokens: z.ZodOptional<z.ZodNumber>;
                outputTokens: z.ZodOptional<z.ZodNumber>;
                reasoningTokens: z.ZodOptional<z.ZodNumber>;
                totalTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>], "type">, z.ZodObject<{
                type: z.ZodString;
            }, z.core.$loose>]>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.artifact">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            name: z.ZodString;
            contentType: z.ZodString;
            inline: z.ZodOptional<z.ZodString>;
            blobRef: z.ZodOptional<z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.await_approval">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            summary: z.ZodString;
            approvalId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.complete">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            summary: z.ZodString;
            sessionRef: z.ZodString;
            artifactRefs: z.ZodOptional<z.ZodArray<z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            document: z.ZodOptional<z.ZodUnknown>;
            usage: z.ZodOptional<z.ZodObject<{
                runtime: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                    pi: "pi";
                }>;
                provider: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                promptTokens: z.ZodOptional<z.ZodNumber>;
                completionTokens: z.ZodOptional<z.ZodNumber>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                clientVersion: z.ZodString;
                reportedAt: z.ZodISODateTime;
            }, z.core.$strip>>;
            agentRef: z.ZodOptional<z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.fail">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            reason: z.ZodString;
            retryable: z.ZodOptional<z.ZodBoolean>;
            usage: z.ZodOptional<z.ZodObject<{
                runtime: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                    pi: "pi";
                }>;
                provider: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                promptTokens: z.ZodOptional<z.ZodNumber>;
                completionTokens: z.ZodOptional<z.ZodNumber>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                clientVersion: z.ZodString;
                reportedAt: z.ZodISODateTime;
            }, z.core.$strip>>;
            agentRef: z.ZodOptional<z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.cancelled">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            reason: z.ZodOptional<z.ZodString>;
            usage: z.ZodOptional<z.ZodObject<{
                runtime: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                    pi: "pi";
                }>;
                provider: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                promptTokens: z.ZodOptional<z.ZodNumber>;
                completionTokens: z.ZodOptional<z.ZodNumber>;
                durationMs: z.ZodOptional<z.ZodNumber>;
                clientVersion: z.ZodString;
                reportedAt: z.ZodISODateTime;
            }, z.core.$strip>>;
            agentRef: z.ZodOptional<z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"task.approval_resolved">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            approvalId: z.ZodString;
            decision: z.ZodEnum<{
                approve: "approve";
                reject: "reject";
            }>;
            resolvedBy: z.ZodEnum<{
                local: "local";
            }>;
            at: z.ZodISODateTime;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.egress.reliable">;
        task_id: z.ZodOptional<z.ZodString>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            policyRevision: z.ZodString;
            eventId: z.ZodUUID;
            cursor: z.ZodNumber;
            payload: z.ZodJSONSchema;
            contentHash: z.ZodString;
            byteCount: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.message.publish">;
        task_id: z.ZodString;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodObject<{
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            contract: z.ZodString;
            messageId: z.ZodUUID;
            cursor: z.ZodNumber;
            contentType: z.ZodEnum<{
                "text/markdown": "text/markdown";
                "text/plain": "text/plain";
            }>;
            body: z.ZodString;
            contentHash: z.ZodString;
            byteCount: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strip>, z.ZodObject<{
        v: z.ZodNumber;
        id: z.ZodUUID;
        ts: z.ZodISODateTime;
        type: z.ZodLiteral<"agent.content.receipt">;
        task_id: z.ZodOptional<z.ZodString>;
        session_ref: z.ZodOptional<z.ZodString>;
        seq: z.ZodOptional<z.ZodNumber>;
        payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
            requestId: z.ZodUUID;
            eventId: z.ZodUUID;
            cursor: z.ZodNumber;
            surface: z.ZodEnum<{
                artifact: "artifact";
                transcript: "transcript";
                workspace: "workspace";
            }>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    agent: "agent";
                    system: "system";
                    user: "user";
                }>;
                id: z.ZodString;
            }, z.core.$strict>;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            runtime: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            cwd: z.ZodString;
            policyRevision: z.ZodString;
            target: z.ZodString;
            mimeType: z.ZodString;
            decodeAs: z.ZodEnum<{
                bytes: "bytes";
                utf8: "utf8";
            }>;
            decision: z.ZodLiteral<"allowed">;
            byteCount: z.ZodNumber;
            contentHash: z.ZodString;
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>, z.ZodObject<{
            requestId: z.ZodUUID;
            eventId: z.ZodUUID;
            cursor: z.ZodNumber;
            surface: z.ZodEnum<{
                artifact: "artifact";
                transcript: "transcript";
                workspace: "workspace";
            }>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    agent: "agent";
                    system: "system";
                    user: "user";
                }>;
                id: z.ZodString;
            }, z.core.$strict>;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            sessionRef: z.ZodString;
            runtime: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            cwd: z.ZodString;
            policyRevision: z.ZodString;
            target: z.ZodString;
            mimeType: z.ZodString;
            decodeAs: z.ZodEnum<{
                bytes: "bytes";
                utf8: "utf8";
            }>;
            decision: z.ZodLiteral<"denied">;
            byteCount: z.ZodLiteral<0>;
            reason: z.ZodEnum<{
                "absolute-target": "absolute-target";
                "byte-limit": "byte-limit";
                "capability-missing": "capability-missing";
                "dot-segment": "dot-segment";
                "identity-mismatch": "identity-mismatch";
                "invalid-request": "invalid-request";
                "mime-not-allowlisted": "mime-not-allowlisted";
                "non-relative-target": "non-relative-target";
                "not-regular-file": "not-regular-file";
                "path-escape": "path-escape";
                "policy-disabled": "policy-disabled";
                "policy-revision-mismatch": "policy-revision-mismatch";
                "root-invalid": "root-invalid";
                "root-not-allowlisted": "root-not-allowlisted";
                "sensitive-name": "sensitive-name";
                symlink: "symlink";
                "target-missing": "target-missing";
                "text-decode-failed": "text-decode-failed";
                "text-not-allowlisted": "text-not-allowlisted";
            }>;
        }, z.core.$strict>], "decision">;
    }, z.core.$strip>], "type">>;
}, z.core.$strip>;
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
export declare const MessagesSendResponseSchema: z.ZodObject<{
    accepted: z.ZodNumber;
    rejected: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type MessagesSendResponse = z.infer<typeof MessagesSendResponseSchema>;
export declare const AgentHomeProjectionCompletionRequestSchema: z.ZodObject<{
    requestId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    projectionHash: z.ZodString;
    outcome: z.ZodEnum<{
        applied: "applied";
        conflict: "conflict";
        idempotent: "idempotent";
        stale: "stale";
    }>;
}, z.core.$strict>;
export type AgentHomeProjectionCompletionRequest = z.infer<typeof AgentHomeProjectionCompletionRequestSchema>;
export declare const AgentHomeProjectionStatusSchema: z.ZodEnum<{
    applied: "applied";
    conflict: "conflict";
    idempotent: "idempotent";
    pending: "pending";
    stale: "stale";
}>;
export type AgentHomeProjectionStatus = z.infer<typeof AgentHomeProjectionStatusSchema>;
export declare const AgentHomeProjectionReadbackSchema: z.ZodObject<{
    tenantId: z.ZodString;
    deviceId: z.ZodString;
    requestId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    projectionHash: z.ZodString;
    status: z.ZodEnum<{
        applied: "applied";
        conflict: "conflict";
        idempotent: "idempotent";
        pending: "pending";
        stale: "stale";
    }>;
    completedAt: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strict>;
export type AgentHomeProjectionReadback = z.infer<typeof AgentHomeProjectionReadbackSchema>;
export declare const AgentMemoryProjectionCommitRequestSchema: z.ZodObject<{
    taskId: z.ZodString;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    sessionRef: z.ZodString;
    runtimeId: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>;
    grantRef: z.ZodString;
    writerEpoch: z.ZodNumber;
    sourceSeq: z.ZodNumber;
    mutationId: z.ZodUUID;
    policyRevision: z.ZodString;
    snapshot: z.ZodObject<{
        redactedHash: z.ZodString;
        redactedByteCount: z.ZodNumber;
        redactedBytes: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type AgentMemoryProjectionCommitRequest = z.infer<typeof AgentMemoryProjectionCommitRequestSchema>;
export declare const AgentMemoryProjectionCommitResponseSchema: z.ZodObject<{
    outcome: z.ZodEnum<{
        accepted: "accepted";
        idempotent: "idempotent";
    }>;
    tenantId: z.ZodString;
    deviceId: z.ZodString;
    taskId: z.ZodString;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    sessionRef: z.ZodString;
    runtimeId: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>;
    grantRef: z.ZodString;
    writerEpoch: z.ZodNumber;
    sourceSeq: z.ZodNumber;
    mutationId: z.ZodUUID;
    policyRevision: z.ZodString;
    redactedHash: z.ZodString;
    redactedByteCount: z.ZodNumber;
    metering: z.ZodObject<{
        meteringReceiptId: z.ZodUUID;
        acceptedRedactedBytes: z.ZodNumber;
        recordedAt: z.ZodISODateTime;
    }, z.core.$strict>;
}, z.core.$strict>;
export type AgentMemoryProjectionCommitResponse = z.infer<typeof AgentMemoryProjectionCommitResponseSchema>;
/** `GET /byok/ws` — WebSocket upgrade path. */
export declare const BYOK_WS_PATH = "/byok/ws";
/** `POST /byok/pair` — one-time device pairing (§6). */
export declare const BYOK_PAIR_PATH = "/byok/pair";
/** `POST /byok/challenge` — token-renewal challenge (§6.3). */
export declare const BYOK_CHALLENGE_PATH = "/byok/challenge";
/** `POST /byok/token` — token-renewal exchange (§6.3). */
export declare const BYOK_TOKEN_PATH = "/byok/token";
/** `GET /byok/capabilities` — ADR-010 declaration route. */
export declare const BYOK_CAPABILITIES_PATH = "/byok/capabilities";
/** `GET /byok/events` — long-poll receive (§8). */
export declare const BYOK_EVENTS_PATH = "/byok/events";
/** `POST /byok/messages` — long-poll batched send (§8.2). */
export declare const BYOK_MESSAGES_PATH = "/byok/messages";
/** `PUT /byok/agent-home-projections/:requestId/completion`. */
export declare const BYOK_AGENT_HOME_PROJECTIONS_PATH = "/byok/agent-home-projections";
export declare const BYOK_AGENT_HOME_PROJECTION_COMPLETION_ROUTE = "/byok/agent-home-projections/:requestId/completion";
export declare function byokAgentHomeProjectionCompletionPath(requestId: string): string;
/** `POST /byok/agent-memory-projections` — optional local-to-hosted redacted snapshot commit. */
export declare const BYOK_AGENT_MEMORY_PROJECTIONS_PATH = "/byok/agent-memory-projections";
/** `PUT /byok/presence` — presence heartbeat. */
export declare const BYOK_PRESENCE_PATH = "/byok/presence";
/** `POST /byok/activity` — activity-tail append. */
export declare const BYOK_ACTIVITY_PATH = "/byok/activity";
/** `GET /byok/board` — coordination board list/poll. */
export declare const BYOK_BOARD_PATH = "/byok/board";
/** `GET /byok/board/stream` — coordination board SSE. */
export declare const BYOK_BOARD_STREAM_PATH = "/byok/board/stream";
/** Router template — `POST /byok/board/:id/claim`. */
export declare const BYOK_BOARD_CLAIM_ROUTE = "/byok/board/:id/claim";
/** Router template — `POST /byok/board/:id/unclaim`. */
export declare const BYOK_BOARD_UNCLAIM_ROUTE = "/byok/board/:id/unclaim";
/** Router template — `POST /byok/board/:id/status`. */
export declare const BYOK_BOARD_STATUS_ROUTE = "/byok/board/:id/status";
/** `GET /byok/records` — truth manifest list (§12.3). */
export declare const BYOK_RECORDS_PATH = "/byok/records";
/** Router template for a single truth record — `GET`/`PUT /byok/records/:kind/:key`. */
export declare const BYOK_RECORD_ROUTE = "/byok/records/:kind/:key";
/** Client builder for a truth record path. Mirrors the `:kind/:key` template, each segment URL-encoded. */
export declare function byokRecordPath(kind: string, key: string): string;
/** `GET /byok/skill-packs` — skill-pack manifest catalogue. */
export declare const BYOK_SKILL_PACKS_PATH = "/byok/skill-packs";
/** Router template for a skill-pack file — `GET /byok/skill-packs/:name/files/:path`. */
export declare const BYOK_SKILL_PACK_FILE_ROUTE = "/byok/skill-packs/:name/files/:path";
/** Client builder for a skill-pack file path. Mirrors the `:name`/`:path` template, each segment URL-encoded. */
export declare function byokSkillPackFilePath(name: string, path: string): string;
/** `POST /byok/blobs` — declare a blob upload (§7). */
export declare const BYOK_BLOBS_PATH = "/byok/blobs";
/** Router template — `POST /byok/blobs/:id/finalize`. */
export declare const BYOK_BLOB_FINALIZE_ROUTE = "/byok/blobs/:id/finalize";
/** Router template — `GET /byok/blobs/:id/url`. */
export declare const BYOK_BLOB_URL_ROUTE = "/byok/blobs/:id/url";
/** Router template for the two presigned byte routes — `PUT`/`GET /byok/blobs/:id/content`. */
export declare const BYOK_BLOB_CONTENT_ROUTE = "/byok/blobs/:id/content";
/** Client builder — `POST /byok/blobs/:id/finalize`, blob id URL-encoded (client-supplied). */
export declare function byokBlobFinalizePath(blobId: string): string;
/** Client builder — `GET /byok/blobs/:id/url`, blob id URL-encoded (client-supplied). */
export declare function byokBlobUrlPath(blobId: string): string;
/**
 * Path portion of a presigned `/byok/blobs/:id/content` URL. The blob id here
 * is a server-minted token (NOT URL-encoded, matching the reference stores that
 * mint these signed URLs); callers append the `?sig=&exp=` query themselves.
 */
export declare function byokBlobContentPath(blobId: string): string;
// ==== @byok-sdk/protocol dist/index.d.ts ====
export { PROTOCOL_VERSION, CAPABILITY_FLAGS, STRICT_AGENT_ONLY_CAPABILITY } from './version';
export type { CapabilityFlag } from './version';
export { BlobRefSchema, CONTENT_HASH_RE } from './blob';
export type { BlobRef } from './blob';
export { PermissionPolicySchema, PERMISSION_MODES } from './permission';
export type { PermissionPolicy, PermissionMode } from './permission';
export { PROVIDER_PROFILE_BINDING_CAPABILITY, PROVIDER_MODEL_CAPABILITIES, ProviderProfileRefSchema, ProviderProfileRevisionSchema, ProviderProfileHashSchema, ProviderModelCapabilitySchema, ProviderProfileBindingSchema, } from './provider-profile-binding';
export type { ProviderProfileRef, ProviderProfileRevision, ProviderProfileHash, ProviderModelCapability, ProviderProfileBinding, } from './provider-profile-binding';
export { AgentEventSchema, UnknownAgentEventSchema, AgentEventOrUnknownSchema, KNOWN_AGENT_EVENT_TYPES, isKnownAgentEvent, partitionAgentEvents, } from './agent-event';
export type { AgentEvent, UnknownAgentEvent, AgentEventOrUnknown } from './agent-event';
export { AgentEgressPolicySchema, AgentEgressActivityPolicySchema, AgentReliableQuotaPolicySchema, ContentReadPolicySchema, AgentEgressLaneSchema, AgentEgressDropReasonSchema, AgentContentReadSurfaceSchema, AgentContentActorKindSchema, AgentContentActorSchema, AgentContentDecodeAsSchema, AgentContentMimeTypeSchema, AgentContentReadDecisionSchema, AgentContentReadDenialReasonSchema, AgentEgressContentHashSchema, AgentEgressPolicyRevisionSchema, AgentMessageContractSchema, AgentMessageContentTypeSchema, AgentMessageDestinationBindingSchema, AgentMessageFreshnessCursorSchema, AgentMessageServerContextSchema, AgentMessageEgressRequirementSchema, AGENT_MESSAGE_MAX_BYTES, AGENT_MESSAGE_EGRESS_CAPABILITY, AGENT_EGRESS_POLICY_CAPABILITY, AGENT_EGRESS_RELIABLE_ACK_CAPABILITY, AGENT_EGRESS_FRESH_SESSION_CAPABILITY, AGENT_CONTENT_WORKSPACE_READ_CAPABILITY, AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY, AGENT_CONTENT_ARTIFACT_READ_CAPABILITY, } from './agent-egress';
export type { AgentEgressPolicy, AgentEgressActivityPolicy, AgentReliableQuotaPolicy, ContentReadPolicy, AgentEgressLane, AgentEgressDropReason, AgentMessageContentType, AgentMessageEgressRequirement, AgentMessageServerContext, AgentContentReadSurface, AgentContentActorKind, AgentContentActor, AgentContentDecodeAs, AgentContentReadDecision, AgentContentReadDenialReason, } from './agent-egress';
export { AGENT_HOME_PROJECTION_CAPABILITY, AGENT_HOME_PROJECTION_MAX_BYTES, AGENT_HOME_PROJECTION_PROFILE_REVISION_MAXIMUM, AgentHomeProjectionProfileRevisionSchema, AgentHomeProjectionHashSchema, AgentHomeProjectionOutcomeSchema, AgentHomeProjectionValueSchema, } from './agent-home-projection';
export type { AgentHomeProjectionProfileRevision, AgentHomeProjectionHash, AgentHomeProjectionOutcome, AgentHomeProjectionValue, } from './agent-home-projection';
export { AGENT_MEMORY_PROJECTION_CAPABILITY, AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES, AGENT_MEMORY_PROJECTION_MAX_ORDERING_VALUE, AgentMemoryProjectionGrantRefSchema, AgentMemoryProjectionSessionRefSchema, AgentMemoryProjectionWriterEpochSchema, AgentMemoryProjectionSourceSeqSchema, AgentMemoryProjectionSnapshotSchema, AgentMemoryProjectionMeteringReceiptSchema, AgentMemoryProjectionMutationSchema, AgentMemoryProjectionReceiptSchema, AgentMemoryProjectionEraseResultSchema, agentMemoryProjectionBase64UrlByteLength, } from './agent-memory-projection';
export type { AgentMemoryProjectionGrantRef, AgentMemoryProjectionSessionRef, AgentMemoryProjectionWriterEpoch, AgentMemoryProjectionSourceSeq, AgentMemoryProjectionSnapshot, AgentMemoryProjectionMeteringReceipt, AgentMemoryProjectionMutation, AgentMemoryProjectionReceipt, AgentMemoryProjectionEraseResult, } from './agent-memory-projection';
export { TERMINAL_PROJECTION_SELECTION_CAPABILITY, TerminalProjectionContractSchema, TerminalProjectionSelectionSchema, } from './terminal-projection';
export type { TerminalProjectionSelection } from './terminal-projection';
export { TASK_STATES, TASK_TRANSITIONS, canTransition } from './task-state';
export type { TaskState } from './task-state';
export { MESSAGE_TYPES, MESSAGE_PAYLOAD_SCHEMAS, SERVER_TO_DAEMON_TYPES, DAEMON_TO_SERVER_TYPES, RuntimeIdSchema, ProtocolVersionNumberSchema, RuntimeInfoSchema, RuntimeCapabilitiesSchema, AgentRefSchema, AgentHomeProjectionAgentRefSchema, AGENT_REF_MAX_BYTES, DispatchSelectionSchema, ToolsetIdSchema, ConfiguredToolsetsSchema, RequiredToolsetsSchema, CONFIGURED_TOOLSETS_MAX_ITEMS, ConnHelloPayloadSchema, ConnAckPayloadSchema, TaskOfferPayloadSchema, TaskOfferWithToolsetsPayloadSchema, TaskOfferForAgentPayloadSchema, TaskOfferForAgentWithEgressPayloadSchema, TaskOfferForAgentWithEgressFreshPayloadSchema, AgentEgressReliablePayloadSchema, AgentEgressAckPayloadSchema, AgentMessagePublishPayloadSchema, AgentMessageDispositionPayloadSchema, AgentContentReadPayloadSchema, AgentContentReceiptPayloadSchema, AgentHomeProjectionPayloadSchema, TaskApprovePayloadSchema, TaskRejectPayloadSchema, TaskCancelPayloadSchema, TaskSteerPayloadSchema, TaskClaimPayloadSchema, TaskStartedPayloadSchema, TaskDeclinePayloadSchema, TaskProgressPayloadSchema, TaskArtifactPayloadSchema, TaskAwaitApprovalPayloadSchema, TaskCompletePayloadSchema, TaskFailPayloadSchema, TaskCancelledPayloadSchema, TaskApprovalResolvedPayloadSchema, RESULT_DOCUMENT_MAX_BYTES, checkResultDocument, TerminalInferenceUsageSchema, TERMINAL_INFERENCE_USAGE_MAX_TOKENS, TERMINAL_INFERENCE_USAGE_MAX_DURATION_MS, TERMINAL_INFERENCE_USAGE_PROVIDER_MAX_LENGTH, TERMINAL_INFERENCE_USAGE_MODEL_MAX_LENGTH, TERMINAL_INFERENCE_USAGE_CLIENT_VERSION_MAX_LENGTH, } from './messages';
export type { ResultDocumentCheck, MessageType, RuntimeId, RuntimeInfo, RuntimeCapabilities, AgentRef, AgentHomeProjectionAgentRef, DispatchSelection, ToolsetId, ConnHelloPayload, ConnAckPayload, TaskOfferPayload, TaskOfferWithToolsetsPayload, TaskOfferForAgentPayload, TaskOfferForAgentWithEgressPayload, TaskOfferForAgentWithEgressFreshPayload, AgentEgressReliablePayload, AgentEgressAckPayload, AgentMessagePublishPayload, AgentMessageDispositionPayload, AgentContentReadPayload, AgentContentReceiptPayload, AgentHomeProjectionPayload, TaskApprovePayload, TaskRejectPayload, TaskCancelPayload, TaskSteerPayload, TaskClaimPayload, TaskStartedPayload, TaskDeclinePayload, TaskProgressPayload, TaskArtifactPayload, TaskAwaitApprovalPayload, TaskCompletePayload, TaskFailPayload, TaskCancelledPayload, TaskApprovalResolvedPayload, TerminalInferenceUsage, } from './messages';
export { EnvelopeSchema, isServerToDaemonType } from './envelope';
export type { Envelope } from './envelope';
export { ProtocolError, EnvelopeParseError, UnknownMessageTypeError, EnvelopeValidationError, } from './errors';
export { encodeEnvelope, decodeEnvelope, createEnvelope, parseMessage } from './codec';
export type { CreateEnvelopeOptions } from './codec';
export { PairRequestSchema, PairResponseTenantIdSchema, PAIR_RESPONSE_TENANT_ID_MAX_LENGTH, PairResponseSchema, ChallengeRequestSchema, ChallengeResponseSchema, TokenRequestSchema, TokenResponseSchema, PresencePublishRequestSchema, CreateBlobRequestSchema, CreateBlobResponseSchema, BlobDownloadUrlResponseSchema, EventsPollQuerySchema, EventsPollResponseSchema, MessagesSendRequestSchema, MessagesSendResponseSchema, AgentHomeProjectionCompletionRequestSchema, AgentHomeProjectionStatusSchema, AgentHomeProjectionReadbackSchema, AgentMemoryProjectionCommitRequestSchema, AgentMemoryProjectionCommitResponseSchema, MAX_MESSAGES_PER_BATCH, BYOK_WS_PATH, BYOK_PAIR_PATH, BYOK_CHALLENGE_PATH, BYOK_TOKEN_PATH, BYOK_CAPABILITIES_PATH, BYOK_EVENTS_PATH, BYOK_MESSAGES_PATH, BYOK_AGENT_HOME_PROJECTIONS_PATH, BYOK_AGENT_HOME_PROJECTION_COMPLETION_ROUTE, byokAgentHomeProjectionCompletionPath, BYOK_AGENT_MEMORY_PROJECTIONS_PATH, BYOK_PRESENCE_PATH, BYOK_ACTIVITY_PATH, BYOK_BOARD_PATH, BYOK_BOARD_STREAM_PATH, BYOK_BOARD_CLAIM_ROUTE, BYOK_BOARD_UNCLAIM_ROUTE, BYOK_BOARD_STATUS_ROUTE, BYOK_RECORDS_PATH, BYOK_RECORD_ROUTE, byokRecordPath, BYOK_SKILL_PACKS_PATH, BYOK_SKILL_PACK_FILE_ROUTE, byokSkillPackFilePath, BYOK_BLOBS_PATH, BYOK_BLOB_FINALIZE_ROUTE, BYOK_BLOB_URL_ROUTE, BYOK_BLOB_CONTENT_ROUTE, byokBlobFinalizePath, byokBlobUrlPath, byokBlobContentPath, } from './http-api';
export type { PairRequest, PairResponse, ChallengeRequest, ChallengeResponse, TokenRequest, TokenResponse, PresencePublishRequest, CreateBlobRequest, CreateBlobResponse, BlobDownloadUrlResponse, EventsPollQuery, EventsPollResponse, MessagesSendRequest, MessagesSendResponse, AgentHomeProjectionCompletionRequest, AgentHomeProjectionStatus, AgentHomeProjectionReadback, AgentMemoryProjectionCommitRequest, AgentMemoryProjectionCommitResponse, } from './http-api';
// ==== @byok-sdk/protocol dist/messages.d.ts ====
import { z } from 'zod';
export declare const RuntimeIdSchema: z.ZodEnum<{
    claude: "claude";
    codex: "codex";
    pi: "pi";
}>;
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;
/** Wire-safe protocol version number: bounded before JSON reaches a store or comparison. */
export declare const ProtocolVersionNumberSchema: z.ZodNumber;
/**
 * Per-runtime feature flags reported in `conn.hello.runtimes[].capabilities`
 * (pre-freeze addition). Distinct from the connection-level `CAPABILITY_FLAGS`
 * (`version.ts`) / `conn.hello.capabilities` array: those are protocol-level
 * flags negotiated for the whole connection, while this is what one specific
 * detected runtime (pi/claude/codex) supports. The whole field is optional
 * end-to-end — older daemons omit `capabilities` entirely — and every field
 * inside it is itself optional, since detection can be partial.
 *
 * Per-tool allow/deny lists are deliberately NOT included here (noise).
 * `permissionModes` mirrors `PERMISSION_MODES` (`permission.ts`) but is kept
 * as a bare `string[]` rather than `z.enum(PERMISSION_MODES)`: this is a
 * runtime's self-reported observability data, not a control/security field,
 * so — per the freeze rule (tolerate unknown for observability, fail closed
 * for control/security; see `agent-event.ts`'s unknown-variant tolerance for
 * the same asymmetry applied to `task.progress` events) — it stays tolerant
 * of a mode string a newer runtime might report that this schema doesn't
 * enumerate yet, rather than rejecting the whole `conn.hello`.
 *
 * Unrecognized keys inside `capabilities` itself, by contrast, are silently
 * stripped (zod's default object behavior — same as every other payload
 * schema in this file) rather than passed through: this is a closed, typed
 * shape consumers can rely on, and a genuinely new capability flag gets added
 * here explicitly rather than round-tripped opaquely.
 */
export declare const RuntimeCapabilitiesSchema: z.ZodObject<{
    steer: z.ZodOptional<z.ZodBoolean>;
    resume: z.ZodOptional<z.ZodBoolean>;
    approvalInteractive: z.ZodOptional<z.ZodBoolean>;
    mcpToolsets: z.ZodOptional<z.ZodBoolean>;
    permissionModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;
/**
 * Runtime detection info reported in `conn.hello`. Supersedes the M0
 * `agents: unknown` field (M1 gap #4): typed, so the server no longer has to
 * best-effort-normalize an untyped blob.
 */
export declare const RuntimeInfoSchema: z.ZodObject<{
    id: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>;
    version: z.ZodOptional<z.ZodString>;
    authPresent: z.ZodOptional<z.ZodBoolean>;
    capabilities: z.ZodOptional<z.ZodObject<{
        steer: z.ZodOptional<z.ZodBoolean>;
        resume: z.ZodOptional<z.ZodBoolean>;
        approvalInteractive: z.ZodOptional<z.ZodBoolean>;
        mcpToolsets: z.ZodOptional<z.ZodBoolean>;
        permissionModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;
/** Maximum logical toolsets one daemon may advertise as locally configured. */
export declare const CONFIGURED_TOOLSETS_MAX_ITEMS = 64;
/**
 * Logical, host-owned MCP toolset identifier. A task may request this name,
 * but the executable/server definition behind it exists only in the daemon's
 * local configuration and never crosses the SaaS wire.
 */
export declare const ToolsetIdSchema: z.ZodString;
export type ToolsetId = z.infer<typeof ToolsetIdSchema>;
/** Stable Agent identity carried across transport and storage. */
export declare const AGENT_REF_MAX_BYTES = 160;
/**
 * Agent ids are opaque to the SDK but must remain one safe pathname segment;
 * the SDK owns the deterministic `<hostStorageRoot>/agents/<agentId>` mapping.
 */
export declare const AgentRefSchema: z.ZodObject<{
    agentId: z.ZodString;
    profileRevision: z.ZodString;
}, z.core.$strict>;
export type AgentRef = z.infer<typeof AgentRefSchema>;
/** AgentRef constrained to the canonical Profile revision required by projection control. */
export declare const AgentHomeProjectionAgentRefSchema: z.ZodObject<{
    agentId: z.ZodString;
    profileRevision: z.ZodString;
}, z.core.$strict>;
export type AgentHomeProjectionAgentRef = z.infer<typeof AgentHomeProjectionAgentRefSchema>;
/**
 * Device-local inventory projected for discovery. IDs only: executable MCP
 * definitions, arguments, environment and credentials never enter this shape.
 * Empty means known-none; omission on the containing message means unknown.
 */
export declare const ConfiguredToolsetsSchema: z.ZodArray<z.ZodString>;
/** daemon -> server: opening handshake. */
export declare const ConnHelloPayloadSchema: z.ZodObject<{
    protocolVersions: z.ZodArray<z.ZodNumber>;
    capabilities: z.ZodArray<z.ZodString>;
    deviceId: z.ZodString;
    productId: z.ZodString;
    clientVersion: z.ZodOptional<z.ZodString>;
    runtimes: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>;
        version: z.ZodOptional<z.ZodString>;
        authPresent: z.ZodOptional<z.ZodBoolean>;
        capabilities: z.ZodOptional<z.ZodObject<{
            steer: z.ZodOptional<z.ZodBoolean>;
            resume: z.ZodOptional<z.ZodBoolean>;
            approvalInteractive: z.ZodOptional<z.ZodBoolean>;
            mcpToolsets: z.ZodOptional<z.ZodBoolean>;
            permissionModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
    configuredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    cursor: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type ConnHelloPayload = z.infer<typeof ConnHelloPayloadSchema>;
/** server -> daemon: handshake acknowledgement. */
export declare const ConnAckPayloadSchema: z.ZodObject<{
    protocolVersion: z.ZodNumber;
    capabilities: z.ZodArray<z.ZodString>;
    serverTime: z.ZodISODateTime;
}, z.core.$strip>;
export type ConnAckPayload = z.infer<typeof ConnAckPayloadSchema>;
/**
 * The web-selected runtime/model target carried end to end with a task.
 *
 * This is an additive v1 field. The discriminated union makes lane ownership
 * fail closed at decode time: subscription credentials can only belong to the
 * vendor CLIs, while a BYOK provider can only be executed through Pi.
 */
export declare const DispatchSelectionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    lane: z.ZodLiteral<"subscription">;
    runtimeId: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
    }>;
    providerId: z.ZodNull;
    modelId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    lane: z.ZodLiteral<"byok">;
    runtimeId: z.ZodLiteral<"pi">;
    providerId: z.ZodString;
    modelId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    lane: z.ZodLiteral<"byok-profile">;
    runtimeId: z.ZodLiteral<"pi">;
    providerProfile: z.ZodObject<{
        profileRef: z.ZodString;
        profileRevision: z.ZodString;
        profileHash: z.ZodString;
        modelId: z.ZodString;
        requiredCapabilities: z.ZodArray<z.ZodEnum<{
            "image-input": "image-input";
        }>>;
    }, z.core.$strict>;
}, z.core.$strict>], "lane">;
export type DispatchSelection = z.infer<typeof DispatchSelectionSchema>;
/**
 * server -> daemon: offer a task for a device to claim.
 *
 * `taskId` used to be duplicated here; it is now carried only by the
 * envelope's `task_id` (M1 gap #7 — single source of truth for routing).
 */
export declare const TaskOfferPayloadSchema: z.ZodObject<{
    instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>]>;
    policy: z.ZodObject<{
        mode: z.ZodEnum<{
            auto: "auto";
            confirm: "confirm";
            plan: "plan";
            readonly: "readonly";
        }>;
        allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        workspaceRoot: z.ZodOptional<z.ZodString>;
        network: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        lane: z.ZodLiteral<"subscription">;
        runtimeId: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
        }>;
        providerId: z.ZodNull;
        modelId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        lane: z.ZodLiteral<"byok">;
        runtimeId: z.ZodLiteral<"pi">;
        providerId: z.ZodString;
        modelId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        lane: z.ZodLiteral<"byok-profile">;
        runtimeId: z.ZodLiteral<"pi">;
        providerProfile: z.ZodObject<{
            profileRef: z.ZodString;
            profileRevision: z.ZodString;
            profileHash: z.ZodString;
            modelId: z.ZodString;
            requiredCapabilities: z.ZodArray<z.ZodEnum<{
                "image-input": "image-input";
            }>>;
        }, z.core.$strict>;
    }, z.core.$strict>], "lane">>;
    sessionRef: z.ZodOptional<z.ZodString>;
    workspaceHint: z.ZodOptional<z.ZodString>;
    limits: z.ZodOptional<z.ZodObject<{
        maxDurationMs: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type TaskOfferPayload = z.infer<typeof TaskOfferPayloadSchema>;
/** Every named toolset is required; duplicates are rejected instead of silently de-duplicated. */
export declare const RequiredToolsetsSchema: z.ZodArray<z.ZodString>;
/**
 * Additive v1 offer variant for tasks whose semantics require local MCP
 * tools. This is a distinct message type rather than an optional field on
 * `task.offer`: an older v1 daemon skips an unknown message type, whereas it
 * would legally strip an unknown optional control field and run the task
 * without its required tools. The whole payload is strict because every
 * field here affects execution authority.
 */
export declare const TaskOfferWithToolsetsPayloadSchema: z.ZodObject<{
    instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>]>;
    policy: z.ZodObject<{
        mode: z.ZodEnum<{
            auto: "auto";
            confirm: "confirm";
            plan: "plan";
            readonly: "readonly";
        }>;
        allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        workspaceRoot: z.ZodOptional<z.ZodString>;
        network: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        lane: z.ZodLiteral<"subscription">;
        runtimeId: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
        }>;
        providerId: z.ZodNull;
        modelId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        lane: z.ZodLiteral<"byok">;
        runtimeId: z.ZodLiteral<"pi">;
        providerId: z.ZodString;
        modelId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        lane: z.ZodLiteral<"byok-profile">;
        runtimeId: z.ZodLiteral<"pi">;
        providerProfile: z.ZodObject<{
            profileRef: z.ZodString;
            profileRevision: z.ZodString;
            profileHash: z.ZodString;
            modelId: z.ZodString;
            requiredCapabilities: z.ZodArray<z.ZodEnum<{
                "image-input": "image-input";
            }>>;
        }, z.core.$strict>;
    }, z.core.$strict>], "lane">>;
    sessionRef: z.ZodOptional<z.ZodString>;
    workspaceHint: z.ZodOptional<z.ZodString>;
    limits: z.ZodOptional<z.ZodObject<{
        maxDurationMs: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    requiredToolsets: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type TaskOfferWithToolsetsPayload = z.infer<typeof TaskOfferWithToolsetsPayloadSchema>;
/**
 * Strict additive offer for a durable host-owned Agent. An older daemon that
 * does not advertise `agent-home-contract` skips this distinct message type
 * instead of stripping identity and applying legacy workspace semantics.
 */
export declare const TaskOfferForAgentPayloadSchema: z.ZodObject<{
    instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>]>;
    policy: z.ZodObject<{
        mode: z.ZodEnum<{
            auto: "auto";
            confirm: "confirm";
            plan: "plan";
            readonly: "readonly";
        }>;
        allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        workspaceRoot: z.ZodOptional<z.ZodString>;
        network: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        lane: z.ZodLiteral<"subscription">;
        runtimeId: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
        }>;
        providerId: z.ZodNull;
        modelId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        lane: z.ZodLiteral<"byok">;
        runtimeId: z.ZodLiteral<"pi">;
        providerId: z.ZodString;
        modelId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        lane: z.ZodLiteral<"byok-profile">;
        runtimeId: z.ZodLiteral<"pi">;
        providerProfile: z.ZodObject<{
            profileRef: z.ZodString;
            profileRevision: z.ZodString;
            profileHash: z.ZodString;
            modelId: z.ZodString;
            requiredCapabilities: z.ZodArray<z.ZodEnum<{
                "image-input": "image-input";
            }>>;
        }, z.core.$strict>;
    }, z.core.$strict>], "lane">>;
    terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        mode: z.ZodLiteral<"none">;
    }, z.core.$strict>, z.ZodObject<{
        mode: z.ZodLiteral<"result-document">;
        contract: z.ZodString;
    }, z.core.$strict>], "mode">>;
    sessionRef: z.ZodOptional<z.ZodString>;
    limits: z.ZodOptional<z.ZodObject<{
        maxDurationMs: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strict>;
export type TaskOfferForAgentPayload = z.infer<typeof TaskOfferForAgentPayloadSchema>;
/**
 * Strict Agent offer which consumes the typed egress policy. It is a distinct
 * message so an older Agent-home daemon cannot strip control data and proceed
 * with an unconsumed egress declaration.
 */
export declare const TaskOfferForAgentWithEgressPayloadSchema: z.ZodObject<{
    instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>]>;
    policy: z.ZodObject<{
        mode: z.ZodEnum<{
            auto: "auto";
            confirm: "confirm";
            plan: "plan";
            readonly: "readonly";
        }>;
        allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        workspaceRoot: z.ZodOptional<z.ZodString>;
        network: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        lane: z.ZodLiteral<"subscription">;
        runtimeId: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
        }>;
        providerId: z.ZodNull;
        modelId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        lane: z.ZodLiteral<"byok">;
        runtimeId: z.ZodLiteral<"pi">;
        providerId: z.ZodString;
        modelId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        lane: z.ZodLiteral<"byok-profile">;
        runtimeId: z.ZodLiteral<"pi">;
        providerProfile: z.ZodObject<{
            profileRef: z.ZodString;
            profileRevision: z.ZodString;
            profileHash: z.ZodString;
            modelId: z.ZodString;
            requiredCapabilities: z.ZodArray<z.ZodEnum<{
                "image-input": "image-input";
            }>>;
        }, z.core.$strict>;
    }, z.core.$strict>], "lane">>;
    terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        mode: z.ZodLiteral<"none">;
    }, z.core.$strict>, z.ZodObject<{
        mode: z.ZodLiteral<"result-document">;
        contract: z.ZodString;
    }, z.core.$strict>], "mode">>;
    limits: z.ZodOptional<z.ZodObject<{
        maxDurationMs: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    sessionRef: z.ZodString;
    egressPolicy: z.ZodObject<{
        policyRevision: z.ZodString;
        activity: z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"metadata-status">;
            delivery: z.ZodLiteral<"latest-value">;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"contentful-trajectory">;
            delivery: z.ZodLiteral<"latest-value">;
            maxCoalesceMs: z.ZodNumber;
            maxEventBytes: z.ZodNumber;
        }, z.core.$strict>], "mode">;
        reliable: z.ZodObject<{
            maxPendingEventsPerAgent: z.ZodNumber;
            maxPendingBytesPerAgent: z.ZodNumber;
            maxPendingBytesPerTenant: z.ZodNumber;
        }, z.core.$strict>;
        transfers: z.ZodObject<{
            workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                maxBytes: z.ZodNumber;
                allowedMimeTypes: z.ZodArray<z.ZodString>;
            }, z.core.$strict>]>;
            transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                maxBytes: z.ZodNumber;
                allowedMimeTypes: z.ZodArray<z.ZodString>;
            }, z.core.$strict>]>;
            artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                maxBytes: z.ZodNumber;
                allowedMimeTypes: z.ZodArray<z.ZodString>;
            }, z.core.$strict>]>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    messageEgress: z.ZodOptional<z.ZodObject<{
        mode: z.ZodLiteral<"required">;
        contract: z.ZodString;
        contentType: z.ZodEnum<{
            "text/markdown": "text/markdown";
            "text/plain": "text/plain";
        }>;
        maxBytes: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type TaskOfferForAgentWithEgressPayload = z.infer<typeof TaskOfferForAgentWithEgressPayloadSchema>;
/**
 * Strict fresh-session Agent egress offer. It deliberately omits `sessionRef`:
 * the selected runtime is the sole authority that can mint that identity after
 * start. This distinct message prevents a missing resume reference from being
 * interpreted as a fresh execution by an older daemon.
 */
export declare const TaskOfferForAgentWithEgressFreshPayloadSchema: z.ZodObject<{
    instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>]>;
    policy: z.ZodObject<{
        mode: z.ZodEnum<{
            auto: "auto";
            confirm: "confirm";
            plan: "plan";
            readonly: "readonly";
        }>;
        allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        workspaceRoot: z.ZodOptional<z.ZodString>;
        network: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        lane: z.ZodLiteral<"subscription">;
        runtimeId: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
        }>;
        providerId: z.ZodNull;
        modelId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        lane: z.ZodLiteral<"byok">;
        runtimeId: z.ZodLiteral<"pi">;
        providerId: z.ZodString;
        modelId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        lane: z.ZodLiteral<"byok-profile">;
        runtimeId: z.ZodLiteral<"pi">;
        providerProfile: z.ZodObject<{
            profileRef: z.ZodString;
            profileRevision: z.ZodString;
            profileHash: z.ZodString;
            modelId: z.ZodString;
            requiredCapabilities: z.ZodArray<z.ZodEnum<{
                "image-input": "image-input";
            }>>;
        }, z.core.$strict>;
    }, z.core.$strict>], "lane">>;
    terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        mode: z.ZodLiteral<"none">;
    }, z.core.$strict>, z.ZodObject<{
        mode: z.ZodLiteral<"result-document">;
        contract: z.ZodString;
    }, z.core.$strict>], "mode">>;
    limits: z.ZodOptional<z.ZodObject<{
        maxDurationMs: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    egressPolicy: z.ZodObject<{
        policyRevision: z.ZodString;
        activity: z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"metadata-status">;
            delivery: z.ZodLiteral<"latest-value">;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"contentful-trajectory">;
            delivery: z.ZodLiteral<"latest-value">;
            maxCoalesceMs: z.ZodNumber;
            maxEventBytes: z.ZodNumber;
        }, z.core.$strict>], "mode">;
        reliable: z.ZodObject<{
            maxPendingEventsPerAgent: z.ZodNumber;
            maxPendingBytesPerAgent: z.ZodNumber;
            maxPendingBytesPerTenant: z.ZodNumber;
        }, z.core.$strict>;
        transfers: z.ZodObject<{
            workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                maxBytes: z.ZodNumber;
                allowedMimeTypes: z.ZodArray<z.ZodString>;
            }, z.core.$strict>]>;
            transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                maxBytes: z.ZodNumber;
                allowedMimeTypes: z.ZodArray<z.ZodString>;
            }, z.core.$strict>]>;
            artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                maxBytes: z.ZodNumber;
                allowedMimeTypes: z.ZodArray<z.ZodString>;
            }, z.core.$strict>]>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    messageEgress: z.ZodOptional<z.ZodObject<{
        mode: z.ZodLiteral<"required">;
        contract: z.ZodString;
        contentType: z.ZodEnum<{
            "text/markdown": "text/markdown";
            "text/plain": "text/plain";
        }>;
        maxBytes: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type TaskOfferForAgentWithEgressFreshPayload = z.infer<typeof TaskOfferForAgentWithEgressFreshPayloadSchema>;
/** Daemon -> cloud: one durable reliable-lane item after local sanitization. */
export declare const AgentEgressReliablePayloadSchema: z.ZodObject<{
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    sessionRef: z.ZodString;
    policyRevision: z.ZodString;
    eventId: z.ZodUUID;
    cursor: z.ZodNumber;
    payload: z.ZodJSONSchema;
    contentHash: z.ZodString;
    byteCount: z.ZodNumber;
}, z.core.$strict>;
export type AgentEgressReliablePayload = z.infer<typeof AgentEgressReliablePayloadSchema>;
/** Cloud -> daemon: exact acknowledgement for one reliable egress record. */
export declare const AgentEgressAckPayloadSchema: z.ZodObject<{
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    sessionRef: z.ZodString;
    policyRevision: z.ZodString;
    eventId: z.ZodUUID;
    cursor: z.ZodNumber;
    receiptId: z.ZodUUID;
}, z.core.$strict>;
export type AgentEgressAckPayload = z.infer<typeof AgentEgressAckPayloadSchema>;
/** Daemon -> server: one Agent-authored message, independent from task activity. */
export declare const AgentMessagePublishPayloadSchema: z.ZodObject<{
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    sessionRef: z.ZodString;
    contract: z.ZodString;
    messageId: z.ZodUUID;
    cursor: z.ZodNumber;
    contentType: z.ZodEnum<{
        "text/markdown": "text/markdown";
        "text/plain": "text/plain";
    }>;
    body: z.ZodString;
    contentHash: z.ZodString;
    byteCount: z.ZodNumber;
}, z.core.$strict>;
export type AgentMessagePublishPayload = z.infer<typeof AgentMessagePublishPayloadSchema>;
export declare const AgentMessageDispositionPayloadSchema: z.ZodObject<{
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    sessionRef: z.ZodString;
    contract: z.ZodString;
    messageId: z.ZodUUID;
    cursor: z.ZodNumber;
    contentHash: z.ZodString;
    outcome: z.ZodEnum<{
        accepted: "accepted";
        held: "held";
        refused: "refused";
    }>;
    receiptId: z.ZodUUID;
    reasonCode: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type AgentMessageDispositionPayload = z.infer<typeof AgentMessageDispositionPayloadSchema>;
/** Server -> daemon: one exact, independently-capability-gated content read. */
export declare const AgentContentReadPayloadSchema: z.ZodObject<{
    requestId: z.ZodUUID;
    surface: z.ZodEnum<{
        artifact: "artifact";
        transcript: "transcript";
        workspace: "workspace";
    }>;
    actor: z.ZodObject<{
        kind: z.ZodEnum<{
            agent: "agent";
            system: "system";
            user: "user";
        }>;
        id: z.ZodString;
    }, z.core.$strict>;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    sessionRef: z.ZodString;
    runtime: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>;
    cwd: z.ZodString;
    policyRevision: z.ZodString;
    target: z.ZodString;
    mimeType: z.ZodString;
    decodeAs: z.ZodEnum<{
        bytes: "bytes";
        utf8: "utf8";
    }>;
    policy: z.ZodObject<{
        maxBytes: z.ZodNumber;
        allowedMimeTypes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type AgentContentReadPayload = z.infer<typeof AgentContentReadPayloadSchema>;
/** Daemon -> cloud: durable, content-free content-read audit fact. */
export declare const AgentContentReceiptPayloadSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    requestId: z.ZodUUID;
    eventId: z.ZodUUID;
    cursor: z.ZodNumber;
    surface: z.ZodEnum<{
        artifact: "artifact";
        transcript: "transcript";
        workspace: "workspace";
    }>;
    actor: z.ZodObject<{
        kind: z.ZodEnum<{
            agent: "agent";
            system: "system";
            user: "user";
        }>;
        id: z.ZodString;
    }, z.core.$strict>;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    sessionRef: z.ZodString;
    runtime: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>;
    cwd: z.ZodString;
    policyRevision: z.ZodString;
    target: z.ZodString;
    mimeType: z.ZodString;
    decodeAs: z.ZodEnum<{
        bytes: "bytes";
        utf8: "utf8";
    }>;
    decision: z.ZodLiteral<"allowed">;
    byteCount: z.ZodNumber;
    contentHash: z.ZodString;
    blobRef: z.ZodObject<{
        blobId: z.ZodString;
        contentHash: z.ZodString;
        size: z.ZodNumber;
        contentType: z.ZodString;
        url: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strict>, z.ZodObject<{
    requestId: z.ZodUUID;
    eventId: z.ZodUUID;
    cursor: z.ZodNumber;
    surface: z.ZodEnum<{
        artifact: "artifact";
        transcript: "transcript";
        workspace: "workspace";
    }>;
    actor: z.ZodObject<{
        kind: z.ZodEnum<{
            agent: "agent";
            system: "system";
            user: "user";
        }>;
        id: z.ZodString;
    }, z.core.$strict>;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    sessionRef: z.ZodString;
    runtime: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>;
    cwd: z.ZodString;
    policyRevision: z.ZodString;
    target: z.ZodString;
    mimeType: z.ZodString;
    decodeAs: z.ZodEnum<{
        bytes: "bytes";
        utf8: "utf8";
    }>;
    decision: z.ZodLiteral<"denied">;
    byteCount: z.ZodLiteral<0>;
    reason: z.ZodEnum<{
        "absolute-target": "absolute-target";
        "byte-limit": "byte-limit";
        "capability-missing": "capability-missing";
        "dot-segment": "dot-segment";
        "identity-mismatch": "identity-mismatch";
        "invalid-request": "invalid-request";
        "mime-not-allowlisted": "mime-not-allowlisted";
        "non-relative-target": "non-relative-target";
        "not-regular-file": "not-regular-file";
        "path-escape": "path-escape";
        "policy-disabled": "policy-disabled";
        "policy-revision-mismatch": "policy-revision-mismatch";
        "root-invalid": "root-invalid";
        "root-not-allowlisted": "root-not-allowlisted";
        "sensitive-name": "sensitive-name";
        symlink: "symlink";
        "target-missing": "target-missing";
        "text-decode-failed": "text-decode-failed";
        "text-not-allowlisted": "text-not-allowlisted";
    }>;
}, z.core.$strict>], "decision">;
export type AgentContentReceiptPayload = z.infer<typeof AgentContentReceiptPayloadSchema>;
/**
 * Server -> daemon: one task-free exact-device Agent-home projection.
 *
 * `agentRef.profileRevision` is the projection contract's canonical comparable
 * revision. It is validated without interpreting the opaque product
 * projection, whose fields are never inspected for product semantics.
 */
export declare const AgentHomeProjectionPayloadSchema: z.ZodObject<{
    requestId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    projectionHash: z.ZodString;
    projection: z.ZodType<import("./agent-home-projection").AgentHomeProjectionValue, unknown, z.core.$ZodTypeInternals<import("./agent-home-projection").AgentHomeProjectionValue, unknown>>;
}, z.core.$strict>;
export type AgentHomeProjectionPayload = z.infer<typeof AgentHomeProjectionPayloadSchema>;
/**
 * server -> daemon: approve a pending `task.await_approval` request.
 *
 * Semantics (M1 gap #3): the server's own state is authoritative on its own
 * action — calling the server-side `approve()` API moves the task record
 * `AwaitApproval -> Running` immediately. This wire message is a best-effort
 * *notification* telling the daemon to resume the paused runtime session; the
 * daemon does not send a dedicated ack. Its outcome is observable through the
 * task's existing message stream (e.g. `task.progress` resuming, or
 * `task.fail`/`task.cancelled` if resuming turns out to be impossible) — no
 * new ack message type is introduced. See docs/protocol.md "Approval flow".
 *
 * `approvalId` (M5, additive-minor — docs/protocol.md §5.3): OPTIONAL target
 * identity for the SPECIFIC pending approval this decision resolves, rather
 * than "whichever one is currently pending" (the pre-M5 behavior, and still
 * what happens when this field is absent — a legacy server that never
 * learned an id, or one talking to a legacy daemon). When present, the
 * daemon compares it against its own currently-dispatched approval id
 * (`ActiveTask.pendingApprovalId`, `packages/client`'s `task-runner.ts`) and
 * treats a mismatch as a stale, audit-only no-op instead of resolving
 * whatever happens to be pending right now — see `TaskRunner.handleApprove`.
 */
export declare const TaskApprovePayloadSchema: z.ZodObject<{
    approvalId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type TaskApprovePayload = z.infer<typeof TaskApprovePayloadSchema>;
/**
 * server -> daemon: reject a pending `task.await_approval` request.
 *
 * Same best-effort-notification semantics as `task.approve` (M1 gap #3): the
 * server moves its own record `AwaitApproval -> Failed` immediately; this
 * message just tells the daemon to stop, and the daemon reports the outcome
 * via its existing `task.fail` terminal message.
 *
 * `approvalId` (M5, additive-minor — docs/protocol.md §5.3): same optional
 * targeting semantics as `TaskApprovePayloadSchema.approvalId` above, applied
 * to the reject path (`TaskRunner.handleReject`).
 */
export declare const TaskRejectPayloadSchema: z.ZodObject<{
    reason: z.ZodOptional<z.ZodString>;
    approvalId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type TaskRejectPayload = z.infer<typeof TaskRejectPayloadSchema>;
/**
 * server -> daemon: cancel a task in any non-terminal state.
 *
 * Same best-effort-notification semantics (M1 gap #3): the server moves its
 * own record to `Cancelled` immediately on its own action and does not wait
 * for a daemon ack; this message just tells the daemon to stop local work.
 * The daemon reports the outcome via the explicit `task.cancelled` terminal
 * message (M1 gap #6) — not `task.fail`.
 */
export declare const TaskCancelPayloadSchema: z.ZodObject<{
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type TaskCancelPayload = z.infer<typeof TaskCancelPayloadSchema>;
/** server -> daemon: inject steering text into a running task. */
export declare const TaskSteerPayloadSchema: z.ZodObject<{
    text: z.ZodString;
}, z.core.$strip>;
export type TaskSteerPayload = z.infer<typeof TaskSteerPayloadSchema>;
/**
 * daemon -> server: claim an offered task (idempotent CAS on the server
 * side). `taskId` used to be duplicated here; it is now carried only by the
 * envelope's `task_id` (M1 gap #7).
 *
 * Claiming no longer implies the task is `Running` (M1 gap #2) — see
 * `task.started`.
 *
 * `runtime` (M5, additive-minor — docs/protocol.md §3.1): the ACTUAL
 * adapter this device selected for the task, distinct from `task.offer`'s
 * own `runtime` (the merely REQUESTED one, `TaskOfferPayloadSchema.runtime`
 * above). When an offer names no runtime the daemon auto-selects (pi-first —
 * `TaskRunner.pickAdapter`, `packages/client`'s `task-runner.ts`), and before
 * this field existed the server had no way to learn which adapter actually
 * ran — `TaskSnapshot.runtime` (`packages/server`'s `types.ts`) only ever
 * recorded what was requested. Plain optional property on this already-
 * tolerant `z.object()`: an old server simply never reads it, so this needed
 * no version bump and no emission gating (same shape as `approvalId` on
 * `task.await_approval`/`task.approve`/`task.reject`, §5.3) — a new daemon
 * sends it unconditionally, regardless of whether the connected server is
 * new enough to store it.
 *
 * `capabilities` (S0/D-4, additive-minor — docs/protocol.md §2.4): the
 * TASK-level capability authority — what the claiming adapter reported about
 * itself at the moment it took this task, reusing `RuntimeCapabilitiesSchema`
 * (above) rather than introducing a second capability shape. Same source of
 * truth as `conn.hello.runtimes[].capabilities`, different scope: `conn.hello`
 * is CONNECTION-level discovery ("what could this device run"), which no
 * server-side task control decision may read, because it describes a device,
 * not the adapter that claimed this task. This field is task-shaped: it shares a lifecycle with
 * the task↔runtime binding the claim itself establishes, so a control gate
 * (`steerTask()`, `packages/server`'s `hub.ts`) can key off it and stay
 * correct across reconnects, adapter-set changes, and transports. Plain
 * optional property on this already-tolerant `z.object()`, exactly like
 * `runtime` above: an old daemon simply omits it, and a consumer that gates on
 * it must fail closed on absence rather than assume a default.
 */
export declare const TaskClaimPayloadSchema: z.ZodObject<{
    deviceId: z.ZodString;
    agentId: z.ZodOptional<z.ZodString>;
    agentRef: z.ZodOptional<z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    capabilities: z.ZodOptional<z.ZodObject<{
        steer: z.ZodOptional<z.ZodBoolean>;
        resume: z.ZodOptional<z.ZodBoolean>;
        approvalInteractive: z.ZodOptional<z.ZodBoolean>;
        mcpToolsets: z.ZodOptional<z.ZodBoolean>;
        permissionModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type TaskClaimPayload = z.infer<typeof TaskClaimPayloadSchema>;
/**
 * daemon -> server: explicit `Claimed -> Running` transition (M1 gap #2).
 * A `task.claim` no longer implies the task started running; the daemon
 * sends this once it has actually started the runtime session for the task.
 */
export declare const TaskStartedPayloadSchema: z.ZodObject<{}, z.core.$strip>;
export type TaskStartedPayload = z.infer<typeof TaskStartedPayloadSchema>;
/**
 * daemon -> server: decline an offer *before* claiming it (M1 gap #5) — e.g.
 * no compatible/available runtime, or the offered policy exceeds this
 * device's ceiling. Fail-closed rejections must use this instead of silently
 * dropping the offer.
 *
 * Decision (see docs/protocol.md "Declined vs. Failed" for the full
 * writeup): declining does *not* introduce a new `Declined` terminal state.
 * It maps onto the existing `Failed` state via a new `Offered -> Failed`
 * transition. `reason`/`retryable` intentionally mirror `TaskFailPayload`
 * exactly, because a pre-claim decline and a post-claim failure are the same
 * outcome from the dispatcher's point of view (this attempt produced no
 * result; here's whether retrying — e.g. offering to a different device —
 * makes sense), and keeping the state machine minimal avoids forking every
 * terminal-state consumer into "Failed or Declined, handle both".
 */
export declare const TaskDeclinePayloadSchema: z.ZodObject<{
    reason: z.ZodString;
    retryable: z.ZodOptional<z.ZodBoolean>;
    agentRef: z.ZodOptional<z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type TaskDeclinePayload = z.infer<typeof TaskDeclinePayloadSchema>;
/**
 * daemon -> server: batch of normalized agent events.
 *
 * `events` elements are known-or-unknown (`AgentEventOrUnknownSchema` —
 * `agent-event.ts`), not bare `AgentEventSchema`: pre-freeze, an unrecognized
 * event `type` must not fail the whole batch, since a peer running a newer
 * minor version may have emitted an additive event variant this schema
 * doesn't know about yet. See `agent-event.ts` for the full rationale and
 * `partitionAgentEvents`/`isKnownAgentEvent` for how consumers should skip
 * unknowns instead of choking on them.
 */
export declare const TaskProgressPayloadSchema: z.ZodObject<{
    seq: z.ZodNumber;
    events: z.ZodArray<z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"progress">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        tool: z.ZodString;
        input: z.ZodOptional<z.ZodUnknown>;
        toolCallId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        tool: z.ZodString;
        output: z.ZodOptional<z.ZodUnknown>;
        toolCallId: z.ZodOptional<z.ZodString>;
        isError: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"artifact">;
        name: z.ZodString;
        contentType: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"needs_approval">;
        summary: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"turn_end">;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"error">;
        message: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"usage">;
        inputTokens: z.ZodOptional<z.ZodNumber>;
        cachedInputTokens: z.ZodOptional<z.ZodNumber>;
        outputTokens: z.ZodOptional<z.ZodNumber>;
        reasoningTokens: z.ZodOptional<z.ZodNumber>;
        totalTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>], "type">, z.ZodObject<{
        type: z.ZodString;
    }, z.core.$loose>]>>;
}, z.core.$strip>;
export type TaskProgressPayload = z.infer<typeof TaskProgressPayloadSchema>;
/** daemon -> server: an artifact produced by the task, inline or by blob ref. */
export declare const TaskArtifactPayloadSchema: z.ZodObject<{
    name: z.ZodString;
    contentType: z.ZodString;
    inline: z.ZodOptional<z.ZodString>;
    blobRef: z.ZodOptional<z.ZodObject<{
        blobId: z.ZodString;
        contentHash: z.ZodString;
        size: z.ZodNumber;
        contentType: z.ZodString;
        url: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type TaskArtifactPayload = z.infer<typeof TaskArtifactPayloadSchema>;
/**
 * daemon -> server: task is blocked on an out-of-band approval.
 *
 * `approvalId` (M5, additive-minor — docs/protocol.md §5.3): the daemon's own
 * locally-generated identity for THIS SPECIFIC pending approval
 * (`ApprovalRegistry`, `packages/client`'s `approvals.ts`) — included
 * unconditionally by an M5+ daemon, regardless of whether the connected
 * server has advertised the `approval-targeting` capability flag
 * (`version.ts`; see that flag's own doc comment for why no emission gating
 * is needed here — it's a tolerant `z.object()` field, so an older server
 * simply ignores it). Optional purely for wire tolerance with a pre-M5
 * daemon build that never set it at all: a server that never learns an id
 * for a task's current approval can't target a later `approve`/`reject`
 * decision and falls back to resolving "whichever approval is currently
 * pending" — the same behavior every server had before this field existed.
 */
export declare const TaskAwaitApprovalPayloadSchema: z.ZodObject<{
    summary: z.ZodString;
    approvalId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type TaskAwaitApprovalPayload = z.infer<typeof TaskAwaitApprovalPayloadSchema>;
/**
 * Hard cap (1 MiB) on a single `task.complete.document` (see
 * {@link TaskCompletePayloadSchema}), measured as the UTF-8 byte length of
 * its canonical JSON encoding — NOT as a node/key count, since a document is
 * schema-neutral and its object shape is unbounded by design.
 *
 * The cap is a REJECT-AT-BOUNDARY limit on both sides: a daemon that
 * produces an over-cap document reports `task.fail` instead of sending it,
 * and a server rejects an over-cap document at schema validation. It is
 * never truncated — a truncated JSON document is not valid JSON, so
 * "shrinking to fit" can only hand the consumer garbage.
 *
 * 1 MiB is the conservative ceiling declared by the first real consumer
 * (`docs/researches/2026-08-12-salesko-consumption-evidence.md` §1/§2:
 * smallest real frame 8.4 KiB, typical 48-96 KiB, 512 KiB comfortable).
 * Producers should stay at or under ~512 KiB (docs/protocol.md); the extra
 * headroom exists because raising a protocol cap later is additive while
 * lowering one is breaking. A result too big for this channel belongs in
 * `artifactRefs` (the multi-file/binary/oversized channel), not here.
 */
export declare const RESULT_DOCUMENT_MAX_BYTES = 1048576;
/**
 * Outcome of {@link checkResultDocument}.
 *
 * `bytes` is the measured canonical JSON UTF-8 byte length, present on both
 * the accept and the over-cap rejection so a caller can name the actual size
 * in a failure reason. `canonical` is the CANONICAL SNAPSHOT — the value a
 * sender must actually put on the wire; see {@link checkResultDocument}.
 */
export type ResultDocumentCheck = {
    readonly ok: true;
    readonly bytes: number;
    readonly canonical: unknown;
} | {
    readonly ok: false;
    readonly reason: 'not-serializable';
} | {
    readonly ok: false;
    readonly reason: 'over-cap';
    readonly bytes: number;
} | {
    readonly ok: false;
    readonly reason: 'not-plain-json';
};
/**
 * THE single authority for "is this a legal `task.complete.document`", and
 * the one place its canonical form is produced. `TaskCompletePayloadSchema`'s
 * own refinement calls it, and the daemon-side pre-send gate
 * (`packages/client`'s `task-runner.ts`) imports and calls the exact same
 * function rather than re-deriving any part of it: a daemon that measured or
 * judged a document even slightly differently from the server that validates
 * it would either reject documents the wire would have accepted, or hand the
 * server a payload it is about to reject after the runtime session already
 * ended.
 *
 * **The contract is: a document must be PLAIN JSON DATA.** Not "an object
 * that happens to survive `JSON.stringify`" — that bar is far too low, and
 * two concrete attacks/mistakes live under it:
 *
 *   1. `JSON.stringify` succeeding does not mean the value was preserved. An
 *      `undefined`-valued key, a `NaN`, a function-valued property, or a
 *      `Date` all serialize "successfully" while silently becoming something
 *      else (dropped, `null`, or a string). The result is a well-formed,
 *      under-cap document that is not what the producer had — a confidently
 *      wrong terminal result, the worst outcome this channel has.
 *   2. `toJSON(key)` receives the property key it is being serialized under,
 *      so an object can legally answer one way at the root (`key === ''`,
 *      where this function measures it) and a completely different way when
 *      nested inside the envelope payload (`key === 'document'`, where the
 *      codec actually serializes it). A root-only measurement is therefore
 *      not a bound on what goes on the wire at all. The same hole exists for
 *      any getter that answers differently on a second read.
 *
 * Both die together via the same mechanism. The steps:
 *
 *   1. `JSON.stringify` must succeed and not return `undefined`.
 *   2. Its UTF-8 byte length must be within {@link RESULT_DOCUMENT_MAX_BYTES}.
 *   3. `JSON.parse` that string — the CANONICAL SNAPSHOT. It is pure data:
 *      no `toJSON`, no getters, no prototype, nothing left that can answer
 *      differently a second time.
 *   4. The original must be structurally equal to the snapshot
 *      ({@link isSameJsonData}). Any mismatch means the value was not plain
 *      JSON data, and it is rejected rather than silently transformed.
 *
 * On success the snapshot is returned as `canonical`, and **every sender
 * must put THAT on the wire, never the original reference** — which is what
 * closes the contextual-`toJSON`/unstable-getter hole for good: pure data
 * serializes identically at the root and nested, so what was measured is
 * necessarily what is sent. The check is idempotent on pure data, so the
 * server re-running it on an already-parsed payload is a no-op that always
 * agrees.
 */
export declare function checkResultDocument(document: unknown): ResultDocumentCheck;
/** Maximum provider-reported prompt or completion token count retained in one terminal observation. */
export declare const TERMINAL_INFERENCE_USAGE_MAX_TOKENS = 1000000000;
/** Maximum device-observed elapsed duration retained in one terminal observation (seven days). */
export declare const TERMINAL_INFERENCE_USAGE_MAX_DURATION_MS = 604800000;
export declare const TERMINAL_INFERENCE_USAGE_PROVIDER_MAX_LENGTH = 160;
export declare const TERMINAL_INFERENCE_USAGE_MODEL_MAX_LENGTH = 160;
export declare const TERMINAL_INFERENCE_USAGE_CLIENT_VERSION_MAX_LENGTH = 128;
/**
 * A bounded, non-billing observation associated with one terminal runtime
 * outcome. It is optional on every terminal payload so a pre-U2 daemon remains
 * a legal v1 peer. `promptTokens` and `completionTokens` are values a runtime
 * reported for its final observed turn; they are not a storage-accounting or
 * invoice authority.
 */
export declare const TerminalInferenceUsageSchema: z.ZodObject<{
    runtime: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>;
    provider: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    promptTokens: z.ZodOptional<z.ZodNumber>;
    completionTokens: z.ZodOptional<z.ZodNumber>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    clientVersion: z.ZodString;
    reportedAt: z.ZodISODateTime;
}, z.core.$strip>;
export type TerminalInferenceUsage = z.infer<typeof TerminalInferenceUsageSchema>;
/**
 * daemon -> server: task finished successfully.
 *
 * `document` (additive-minor, docs/protocol.md "Freeze rule"): the OPTIONAL
 * structured terminal result of the task — one JSON value the product on the
 * other side consumes as the task's actual output, as opposed to `summary`
 * (human-readable prose) or `artifactRefs` (files). Deliberately
 * `z.unknown()`: this SDK never understands, validates, or transforms the
 * product's own document schema — that validation belongs to the consumer.
 * The only constraints the wire imposes are the ones
 * {@link checkResultDocument} enforces: it must be PLAIN JSON DATA (equal to
 * its own JSON round trip — see that function for why "stringify succeeded"
 * is not enough), and its canonical JSON UTF-8 encoding must be at most
 * {@link RESULT_DOCUMENT_MAX_BYTES}. An over-cap document is REJECTED here,
 * never truncated (see that constant's own doc comment). A sender puts the
 * check's `canonical` snapshot on the wire, never the original object.
 *
 * Unlike `approvalId` on `task.await_approval` above, emitting this field IS
 * gated on a capability flag (`result-document`, `version.ts`): a pre-
 * `result-document` server strips it silently as an unknown key (the
 * tolerant `z.object()` behavior §1 mandates), and silently losing the
 * task's primary structured result is not a tolerable degradation the way
 * losing an observability hint is. So a daemon sends `document` only to a
 * server that advertised the flag, and fails the task loudly otherwise —
 * see `packages/client`'s `task-runner.ts`.
 */
export declare const TaskCompletePayloadSchema: z.ZodObject<{
    summary: z.ZodString;
    sessionRef: z.ZodString;
    artifactRefs: z.ZodOptional<z.ZodArray<z.ZodObject<{
        blobId: z.ZodString;
        contentHash: z.ZodString;
        size: z.ZodNumber;
        contentType: z.ZodString;
        url: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    document: z.ZodOptional<z.ZodUnknown>;
    usage: z.ZodOptional<z.ZodObject<{
        runtime: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>;
        provider: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        promptTokens: z.ZodOptional<z.ZodNumber>;
        completionTokens: z.ZodOptional<z.ZodNumber>;
        durationMs: z.ZodOptional<z.ZodNumber>;
        clientVersion: z.ZodString;
        reportedAt: z.ZodISODateTime;
    }, z.core.$strip>>;
    agentRef: z.ZodOptional<z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type TaskCompletePayload = z.infer<typeof TaskCompletePayloadSchema>;
/** daemon -> server: task failed. */
export declare const TaskFailPayloadSchema: z.ZodObject<{
    reason: z.ZodString;
    retryable: z.ZodOptional<z.ZodBoolean>;
    usage: z.ZodOptional<z.ZodObject<{
        runtime: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>;
        provider: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        promptTokens: z.ZodOptional<z.ZodNumber>;
        completionTokens: z.ZodOptional<z.ZodNumber>;
        durationMs: z.ZodOptional<z.ZodNumber>;
        clientVersion: z.ZodString;
        reportedAt: z.ZodISODateTime;
    }, z.core.$strip>>;
    agentRef: z.ZodOptional<z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type TaskFailPayload = z.infer<typeof TaskFailPayloadSchema>;
/**
 * daemon -> server: task ended in the `Cancelled` state (M1 gap #6) — either
 * in response to a server-sent `task.cancel`, or a cancellation the daemon
 * observed/decided locally (e.g. a local stop action) that the server didn't
 * initiate. This is the canonical way to report a `Cancelled` outcome; it
 * supersedes the M0 convention of `task.fail({ reason: 'cancelled' })`.
 *
 * This is deliberately its own message rather than folded into `task.fail`
 * (decision: prefer the explicit message — see docs/protocol.md) because
 * `Cancelled` is semantically distinct from `Failed`: one is an intentional
 * stop, the other an error. Overloading `task.fail` with a magic
 * `reason: 'cancelled'` string convention hid that distinction on the wire.
 *
 * Dual-purpose on receipt: if the server already moved its own record to
 * `Cancelled` (it initiated the cancel — M1 gap #3's "server state is
 * authoritative" rule), this is an idempotent no-op ack. If the server
 * hasn't yet (a locally-observed cancellation), this is the authoritative
 * trigger that moves `Claimed`/`Running`/`AwaitApproval -> Cancelled`.
 */
export declare const TaskCancelledPayloadSchema: z.ZodObject<{
    reason: z.ZodOptional<z.ZodString>;
    usage: z.ZodOptional<z.ZodObject<{
        runtime: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>;
        provider: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        promptTokens: z.ZodOptional<z.ZodNumber>;
        completionTokens: z.ZodOptional<z.ZodNumber>;
        durationMs: z.ZodOptional<z.ZodNumber>;
        clientVersion: z.ZodString;
        reportedAt: z.ZodISODateTime;
    }, z.core.$strip>>;
    agentRef: z.ZodOptional<z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type TaskCancelledPayload = z.infer<typeof TaskCancelledPayloadSchema>;
/**
 * daemon -> server: a pending `task.await_approval` was resolved entirely
 * LOCALLY on the device — the local control-socket `approvals.resolve` RPC,
 * a fail-closed `requestApproval` timeout, or a fail-closed eviction/finish
 * rejection (see `packages/client`'s `task-runner.ts`/`approvals.ts`) —
 * *without* a wire `task.approve`/`task.reject` ever having been exchanged
 * for it. This is the additive-minor answer to a gap the M4 Phase 3 approval
 * work left open (see the "Deferred additive candidate" note this schema
 * resolves, `docs/protocol.md`): today the server only learns of a local
 * resolution IMPLICITLY, after the fact, once the daemon's next
 * `task.progress`/`task.artifact`/`task.complete` proves the task already
 * moved on (`ConnectionHub.resumeIfImplicitlyApproved`,
 * `packages/server/src/hub.ts`) — a window in which a SaaS-side
 * `TaskHandle.approve()`/`.reject()` can independently decide (and win) the
 * server's own authoritative record before that evidence ever arrives. This
 * message lets the daemon report the local resolution explicitly and
 * immediately, narrowing that window from "until the next progress message"
 * down to ordinary network latency; the implicit-inference path stays as-is,
 * unconditionally, as the compatibility fallback for an old server that
 * never advertises the `approval_resolved` capability flag (`version.ts`) or
 * an old daemon that predates this message entirely.
 *
 * Observability-class tolerance applies (not control/security — see the
 * freeze rule's asymmetry, `docs/protocol.md`): this is a daemon reporting
 * what it already did locally, not a payload that grants/denies anything on
 * its own — the receiving server's own state machine (`TASK_TRANSITIONS`,
 * `task-state.ts`) is still what decides whether the reported resolution is
 * legal to apply. Plain `z.object()` (not `.strict()`), same as every other
 * non-control payload in this file.
 *
 * `resolvedBy` is a single-value enum (`'local'`) rather than a bare string:
 * deliberately future-proof (a later wave could add e.g. `'operator-cli'` as
 * a DISTINCT value without a version bump — a new enum member is additive,
 * same as a new message type or capability flag), while still being a closed,
 * typed shape today rather than an open string a typo could silently widen.
 */
export declare const TaskApprovalResolvedPayloadSchema: z.ZodObject<{
    approvalId: z.ZodString;
    decision: z.ZodEnum<{
        approve: "approve";
        reject: "reject";
    }>;
    resolvedBy: z.ZodEnum<{
        local: "local";
    }>;
    at: z.ZodISODateTime;
}, z.core.$strip>;
export type TaskApprovalResolvedPayload = z.infer<typeof TaskApprovalResolvedPayloadSchema>;
export declare const MESSAGE_PAYLOAD_SCHEMAS: {
    readonly 'conn.hello': z.ZodObject<{
        protocolVersions: z.ZodArray<z.ZodNumber>;
        capabilities: z.ZodArray<z.ZodString>;
        deviceId: z.ZodString;
        productId: z.ZodString;
        clientVersion: z.ZodOptional<z.ZodString>;
        runtimes: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            version: z.ZodOptional<z.ZodString>;
            authPresent: z.ZodOptional<z.ZodBoolean>;
            capabilities: z.ZodOptional<z.ZodObject<{
                steer: z.ZodOptional<z.ZodBoolean>;
                resume: z.ZodOptional<z.ZodBoolean>;
                approvalInteractive: z.ZodOptional<z.ZodBoolean>;
                mcpToolsets: z.ZodOptional<z.ZodBoolean>;
                permissionModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>>;
        }, z.core.$strip>>>;
        configuredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        cursor: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    readonly 'conn.ack': z.ZodObject<{
        protocolVersion: z.ZodNumber;
        capabilities: z.ZodArray<z.ZodString>;
        serverTime: z.ZodISODateTime;
    }, z.core.$strip>;
    readonly 'task.offer': z.ZodObject<{
        instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>]>;
        policy: z.ZodObject<{
            mode: z.ZodEnum<{
                auto: "auto";
                confirm: "confirm";
                plan: "plan";
                readonly: "readonly";
            }>;
            allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            workspaceRoot: z.ZodOptional<z.ZodString>;
            network: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            lane: z.ZodLiteral<"subscription">;
            runtimeId: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
            }>;
            providerId: z.ZodNull;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok">;
            runtimeId: z.ZodLiteral<"pi">;
            providerId: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok-profile">;
            runtimeId: z.ZodLiteral<"pi">;
            providerProfile: z.ZodObject<{
                profileRef: z.ZodString;
                profileRevision: z.ZodString;
                profileHash: z.ZodString;
                modelId: z.ZodString;
                requiredCapabilities: z.ZodArray<z.ZodEnum<{
                    "image-input": "image-input";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>], "lane">>;
        sessionRef: z.ZodOptional<z.ZodString>;
        workspaceHint: z.ZodOptional<z.ZodString>;
        limits: z.ZodOptional<z.ZodObject<{
            maxDurationMs: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    readonly 'task.offer_with_toolsets': z.ZodObject<{
        instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>]>;
        policy: z.ZodObject<{
            mode: z.ZodEnum<{
                auto: "auto";
                confirm: "confirm";
                plan: "plan";
                readonly: "readonly";
            }>;
            allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            workspaceRoot: z.ZodOptional<z.ZodString>;
            network: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            lane: z.ZodLiteral<"subscription">;
            runtimeId: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
            }>;
            providerId: z.ZodNull;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok">;
            runtimeId: z.ZodLiteral<"pi">;
            providerId: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok-profile">;
            runtimeId: z.ZodLiteral<"pi">;
            providerProfile: z.ZodObject<{
                profileRef: z.ZodString;
                profileRevision: z.ZodString;
                profileHash: z.ZodString;
                modelId: z.ZodString;
                requiredCapabilities: z.ZodArray<z.ZodEnum<{
                    "image-input": "image-input";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>], "lane">>;
        sessionRef: z.ZodOptional<z.ZodString>;
        workspaceHint: z.ZodOptional<z.ZodString>;
        limits: z.ZodOptional<z.ZodObject<{
            maxDurationMs: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        requiredToolsets: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    readonly 'task.offer_for_agent': z.ZodObject<{
        instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>]>;
        policy: z.ZodObject<{
            mode: z.ZodEnum<{
                auto: "auto";
                confirm: "confirm";
                plan: "plan";
                readonly: "readonly";
            }>;
            allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            workspaceRoot: z.ZodOptional<z.ZodString>;
            network: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            lane: z.ZodLiteral<"subscription">;
            runtimeId: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
            }>;
            providerId: z.ZodNull;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok">;
            runtimeId: z.ZodLiteral<"pi">;
            providerId: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok-profile">;
            runtimeId: z.ZodLiteral<"pi">;
            providerProfile: z.ZodObject<{
                profileRef: z.ZodString;
                profileRevision: z.ZodString;
                profileHash: z.ZodString;
                modelId: z.ZodString;
                requiredCapabilities: z.ZodArray<z.ZodEnum<{
                    "image-input": "image-input";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>], "lane">>;
        terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"none">;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"result-document">;
            contract: z.ZodString;
        }, z.core.$strict>], "mode">>;
        sessionRef: z.ZodOptional<z.ZodString>;
        limits: z.ZodOptional<z.ZodObject<{
            maxDurationMs: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strict>;
    readonly 'task.offer_for_agent_with_egress': z.ZodObject<{
        instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>]>;
        policy: z.ZodObject<{
            mode: z.ZodEnum<{
                auto: "auto";
                confirm: "confirm";
                plan: "plan";
                readonly: "readonly";
            }>;
            allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            workspaceRoot: z.ZodOptional<z.ZodString>;
            network: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            lane: z.ZodLiteral<"subscription">;
            runtimeId: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
            }>;
            providerId: z.ZodNull;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok">;
            runtimeId: z.ZodLiteral<"pi">;
            providerId: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok-profile">;
            runtimeId: z.ZodLiteral<"pi">;
            providerProfile: z.ZodObject<{
                profileRef: z.ZodString;
                profileRevision: z.ZodString;
                profileHash: z.ZodString;
                modelId: z.ZodString;
                requiredCapabilities: z.ZodArray<z.ZodEnum<{
                    "image-input": "image-input";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>], "lane">>;
        terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"none">;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"result-document">;
            contract: z.ZodString;
        }, z.core.$strict>], "mode">>;
        limits: z.ZodOptional<z.ZodObject<{
            maxDurationMs: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        sessionRef: z.ZodString;
        egressPolicy: z.ZodObject<{
            policyRevision: z.ZodString;
            activity: z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"metadata-status">;
                delivery: z.ZodLiteral<"latest-value">;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"contentful-trajectory">;
                delivery: z.ZodLiteral<"latest-value">;
                maxCoalesceMs: z.ZodNumber;
                maxEventBytes: z.ZodNumber;
            }, z.core.$strict>], "mode">;
            reliable: z.ZodObject<{
                maxPendingEventsPerAgent: z.ZodNumber;
                maxPendingBytesPerAgent: z.ZodNumber;
                maxPendingBytesPerTenant: z.ZodNumber;
            }, z.core.$strict>;
            transfers: z.ZodObject<{
                workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
                transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
                artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        messageEgress: z.ZodOptional<z.ZodObject<{
            mode: z.ZodLiteral<"required">;
            contract: z.ZodString;
            contentType: z.ZodEnum<{
                "text/markdown": "text/markdown";
                "text/plain": "text/plain";
            }>;
            maxBytes: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'task.offer_for_agent_with_egress_fresh': z.ZodObject<{
        instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            blobRef: z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>]>;
        policy: z.ZodObject<{
            mode: z.ZodEnum<{
                auto: "auto";
                confirm: "confirm";
                plan: "plan";
                readonly: "readonly";
            }>;
            allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            workspaceRoot: z.ZodOptional<z.ZodString>;
            network: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        dispatchSelection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            lane: z.ZodLiteral<"subscription">;
            runtimeId: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
            }>;
            providerId: z.ZodNull;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok">;
            runtimeId: z.ZodLiteral<"pi">;
            providerId: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            lane: z.ZodLiteral<"byok-profile">;
            runtimeId: z.ZodLiteral<"pi">;
            providerProfile: z.ZodObject<{
                profileRef: z.ZodString;
                profileRevision: z.ZodString;
                profileHash: z.ZodString;
                modelId: z.ZodString;
                requiredCapabilities: z.ZodArray<z.ZodEnum<{
                    "image-input": "image-input";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>], "lane">>;
        terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"none">;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"result-document">;
            contract: z.ZodString;
        }, z.core.$strict>], "mode">>;
        limits: z.ZodOptional<z.ZodObject<{
            maxDurationMs: z.ZodOptional<z.ZodNumber>;
            maxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        egressPolicy: z.ZodObject<{
            policyRevision: z.ZodString;
            activity: z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"metadata-status">;
                delivery: z.ZodLiteral<"latest-value">;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"contentful-trajectory">;
                delivery: z.ZodLiteral<"latest-value">;
                maxCoalesceMs: z.ZodNumber;
                maxEventBytes: z.ZodNumber;
            }, z.core.$strict>], "mode">;
            reliable: z.ZodObject<{
                maxPendingEventsPerAgent: z.ZodNumber;
                maxPendingBytesPerAgent: z.ZodNumber;
                maxPendingBytesPerTenant: z.ZodNumber;
            }, z.core.$strict>;
            transfers: z.ZodObject<{
                workspace: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
                transcript: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
                artifact: z.ZodUnion<readonly [z.ZodLiteral<"disabled">, z.ZodObject<{
                    maxBytes: z.ZodNumber;
                    allowedMimeTypes: z.ZodArray<z.ZodString>;
                }, z.core.$strict>]>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        messageEgress: z.ZodOptional<z.ZodObject<{
            mode: z.ZodLiteral<"required">;
            contract: z.ZodString;
            contentType: z.ZodEnum<{
                "text/markdown": "text/markdown";
                "text/plain": "text/plain";
            }>;
            maxBytes: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'agent.egress.reliable': z.ZodObject<{
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        policyRevision: z.ZodString;
        eventId: z.ZodUUID;
        cursor: z.ZodNumber;
        payload: z.ZodJSONSchema;
        contentHash: z.ZodString;
        byteCount: z.ZodNumber;
    }, z.core.$strict>;
    readonly 'agent.egress.ack': z.ZodObject<{
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        policyRevision: z.ZodString;
        eventId: z.ZodUUID;
        cursor: z.ZodNumber;
        receiptId: z.ZodUUID;
    }, z.core.$strict>;
    readonly 'agent.message.publish': z.ZodObject<{
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        contract: z.ZodString;
        messageId: z.ZodUUID;
        cursor: z.ZodNumber;
        contentType: z.ZodEnum<{
            "text/markdown": "text/markdown";
            "text/plain": "text/plain";
        }>;
        body: z.ZodString;
        contentHash: z.ZodString;
        byteCount: z.ZodNumber;
    }, z.core.$strict>;
    readonly 'agent.message.disposition': z.ZodObject<{
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        contract: z.ZodString;
        messageId: z.ZodUUID;
        cursor: z.ZodNumber;
        contentHash: z.ZodString;
        outcome: z.ZodEnum<{
            accepted: "accepted";
            held: "held";
            refused: "refused";
        }>;
        receiptId: z.ZodUUID;
        reasonCode: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    readonly 'agent.content.read': z.ZodObject<{
        requestId: z.ZodUUID;
        surface: z.ZodEnum<{
            artifact: "artifact";
            transcript: "transcript";
            workspace: "workspace";
        }>;
        actor: z.ZodObject<{
            kind: z.ZodEnum<{
                agent: "agent";
                system: "system";
                user: "user";
            }>;
            id: z.ZodString;
        }, z.core.$strict>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        runtime: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>;
        cwd: z.ZodString;
        policyRevision: z.ZodString;
        target: z.ZodString;
        mimeType: z.ZodString;
        decodeAs: z.ZodEnum<{
            bytes: "bytes";
            utf8: "utf8";
        }>;
        policy: z.ZodObject<{
            maxBytes: z.ZodNumber;
            allowedMimeTypes: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    readonly 'agent.content.receipt': z.ZodDiscriminatedUnion<[z.ZodObject<{
        requestId: z.ZodUUID;
        eventId: z.ZodUUID;
        cursor: z.ZodNumber;
        surface: z.ZodEnum<{
            artifact: "artifact";
            transcript: "transcript";
            workspace: "workspace";
        }>;
        actor: z.ZodObject<{
            kind: z.ZodEnum<{
                agent: "agent";
                system: "system";
                user: "user";
            }>;
            id: z.ZodString;
        }, z.core.$strict>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        runtime: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>;
        cwd: z.ZodString;
        policyRevision: z.ZodString;
        target: z.ZodString;
        mimeType: z.ZodString;
        decodeAs: z.ZodEnum<{
            bytes: "bytes";
            utf8: "utf8";
        }>;
        decision: z.ZodLiteral<"allowed">;
        byteCount: z.ZodNumber;
        contentHash: z.ZodString;
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>, z.ZodObject<{
        requestId: z.ZodUUID;
        eventId: z.ZodUUID;
        cursor: z.ZodNumber;
        surface: z.ZodEnum<{
            artifact: "artifact";
            transcript: "transcript";
            workspace: "workspace";
        }>;
        actor: z.ZodObject<{
            kind: z.ZodEnum<{
                agent: "agent";
                system: "system";
                user: "user";
            }>;
            id: z.ZodString;
        }, z.core.$strict>;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        sessionRef: z.ZodString;
        runtime: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>;
        cwd: z.ZodString;
        policyRevision: z.ZodString;
        target: z.ZodString;
        mimeType: z.ZodString;
        decodeAs: z.ZodEnum<{
            bytes: "bytes";
            utf8: "utf8";
        }>;
        decision: z.ZodLiteral<"denied">;
        byteCount: z.ZodLiteral<0>;
        reason: z.ZodEnum<{
            "absolute-target": "absolute-target";
            "byte-limit": "byte-limit";
            "capability-missing": "capability-missing";
            "dot-segment": "dot-segment";
            "identity-mismatch": "identity-mismatch";
            "invalid-request": "invalid-request";
            "mime-not-allowlisted": "mime-not-allowlisted";
            "non-relative-target": "non-relative-target";
            "not-regular-file": "not-regular-file";
            "path-escape": "path-escape";
            "policy-disabled": "policy-disabled";
            "policy-revision-mismatch": "policy-revision-mismatch";
            "root-invalid": "root-invalid";
            "root-not-allowlisted": "root-not-allowlisted";
            "sensitive-name": "sensitive-name";
            symlink: "symlink";
            "target-missing": "target-missing";
            "text-decode-failed": "text-decode-failed";
            "text-not-allowlisted": "text-not-allowlisted";
        }>;
    }, z.core.$strict>], "decision">;
    readonly 'agent.home.projection': z.ZodObject<{
        requestId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        projectionHash: z.ZodString;
        projection: z.ZodType<import("./agent-home-projection").AgentHomeProjectionValue, unknown, z.core.$ZodTypeInternals<import("./agent-home-projection").AgentHomeProjectionValue, unknown>>;
    }, z.core.$strict>;
    readonly 'task.approve': z.ZodObject<{
        approvalId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly 'task.reject': z.ZodObject<{
        reason: z.ZodOptional<z.ZodString>;
        approvalId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly 'task.cancel': z.ZodObject<{
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly 'task.steer': z.ZodObject<{
        text: z.ZodString;
    }, z.core.$strip>;
    readonly 'task.claim': z.ZodObject<{
        deviceId: z.ZodString;
        agentId: z.ZodOptional<z.ZodString>;
        agentRef: z.ZodOptional<z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>>;
        runtime: z.ZodOptional<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
        }>>;
        capabilities: z.ZodOptional<z.ZodObject<{
            steer: z.ZodOptional<z.ZodBoolean>;
            resume: z.ZodOptional<z.ZodBoolean>;
            approvalInteractive: z.ZodOptional<z.ZodBoolean>;
            mcpToolsets: z.ZodOptional<z.ZodBoolean>;
            permissionModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    readonly 'task.started': z.ZodObject<{}, z.core.$strip>;
    readonly 'task.decline': z.ZodObject<{
        reason: z.ZodString;
        retryable: z.ZodOptional<z.ZodBoolean>;
        agentRef: z.ZodOptional<z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strip>;
    readonly 'task.progress': z.ZodObject<{
        seq: z.ZodNumber;
        events: z.ZodArray<z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"progress">;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"tool_use">;
            tool: z.ZodString;
            input: z.ZodOptional<z.ZodUnknown>;
            toolCallId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"tool_result">;
            tool: z.ZodString;
            output: z.ZodOptional<z.ZodUnknown>;
            toolCallId: z.ZodOptional<z.ZodString>;
            isError: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"artifact">;
            name: z.ZodString;
            contentType: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"needs_approval">;
            summary: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"turn_end">;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"error">;
            message: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"usage">;
            inputTokens: z.ZodOptional<z.ZodNumber>;
            cachedInputTokens: z.ZodOptional<z.ZodNumber>;
            outputTokens: z.ZodOptional<z.ZodNumber>;
            reasoningTokens: z.ZodOptional<z.ZodNumber>;
            totalTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>], "type">, z.ZodObject<{
            type: z.ZodString;
        }, z.core.$loose>]>>;
    }, z.core.$strip>;
    readonly 'task.artifact': z.ZodObject<{
        name: z.ZodString;
        contentType: z.ZodString;
        inline: z.ZodOptional<z.ZodString>;
        blobRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    readonly 'task.await_approval': z.ZodObject<{
        summary: z.ZodString;
        approvalId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly 'task.complete': z.ZodObject<{
        summary: z.ZodString;
        sessionRef: z.ZodString;
        artifactRefs: z.ZodOptional<z.ZodArray<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        document: z.ZodOptional<z.ZodUnknown>;
        usage: z.ZodOptional<z.ZodObject<{
            runtime: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            provider: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            promptTokens: z.ZodOptional<z.ZodNumber>;
            completionTokens: z.ZodOptional<z.ZodNumber>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            clientVersion: z.ZodString;
            reportedAt: z.ZodISODateTime;
        }, z.core.$strip>>;
        agentRef: z.ZodOptional<z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strip>;
    readonly 'task.fail': z.ZodObject<{
        reason: z.ZodString;
        retryable: z.ZodOptional<z.ZodBoolean>;
        usage: z.ZodOptional<z.ZodObject<{
            runtime: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            provider: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            promptTokens: z.ZodOptional<z.ZodNumber>;
            completionTokens: z.ZodOptional<z.ZodNumber>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            clientVersion: z.ZodString;
            reportedAt: z.ZodISODateTime;
        }, z.core.$strip>>;
        agentRef: z.ZodOptional<z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strip>;
    readonly 'task.cancelled': z.ZodObject<{
        reason: z.ZodOptional<z.ZodString>;
        usage: z.ZodOptional<z.ZodObject<{
            runtime: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                pi: "pi";
            }>;
            provider: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            promptTokens: z.ZodOptional<z.ZodNumber>;
            completionTokens: z.ZodOptional<z.ZodNumber>;
            durationMs: z.ZodOptional<z.ZodNumber>;
            clientVersion: z.ZodString;
            reportedAt: z.ZodISODateTime;
        }, z.core.$strip>>;
        agentRef: z.ZodOptional<z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strip>;
    readonly 'task.approval_resolved': z.ZodObject<{
        approvalId: z.ZodString;
        decision: z.ZodEnum<{
            approve: "approve";
            reject: "reject";
        }>;
        resolvedBy: z.ZodEnum<{
            local: "local";
        }>;
        at: z.ZodISODateTime;
    }, z.core.$strip>;
};
export type MessageType = keyof typeof MESSAGE_PAYLOAD_SCHEMAS;
export declare const MESSAGE_TYPES: MessageType[];
/**
 * Message types the server sends to the daemon. Used by {@link EnvelopeSchema}
 * (`envelope.ts`) to decide which branches require envelope `seq` (M1
 * redelivery cursor).
 */
export declare const SERVER_TO_DAEMON_TYPES: readonly ["conn.ack", "task.offer", "task.offer_with_toolsets", "task.offer_for_agent", "task.offer_for_agent_with_egress", "task.offer_for_agent_with_egress_fresh", "agent.egress.ack", "agent.message.disposition", "agent.content.read", "agent.home.projection", "task.approve", "task.reject", "task.cancel", "task.steer"];
/**
 * Message types the daemon sends to the server — the flip side of
 * {@link SERVER_TO_DAEMON_TYPES}. `conn.hello` is deliberately excluded: it's
 * only ever valid as the first frame of a WS handshake (`ws-server.ts`), not
 * as ongoing inbound traffic through `ConnectionHub.handleInbound`.
 *
 * Used by `handleInbound` (`@byok-sdk/server`'s `hub.ts`) as the type-allow gate
 * for every inbound envelope, WS and `POST /byok/messages` alike (finding
 * P2): a `type` outside this set — a server -> daemon type arriving inbound,
 * or anything unrecognized — is rejected before it's dispatched to any
 * handler or counted `accepted` on the `/byok/messages` wire.
 */
export declare const DAEMON_TO_SERVER_TYPES: readonly ["task.claim", "task.started", "task.decline", "task.progress", "task.artifact", "task.await_approval", "task.complete", "task.fail", "task.cancelled", "task.approval_resolved", "agent.egress.reliable", "agent.message.publish", "agent.content.receipt"];
// ==== @byok-sdk/protocol dist/permission.d.ts ====
import { z } from 'zod';
export declare const PERMISSION_MODES: readonly ['auto', 'confirm', 'readonly', 'plan'];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/**
 * Policy the server proposes for a task. The daemon/runtime adapter maps this
 * onto the concrete runtime's flags; anything that can't be expressed exactly
 * must fail closed (deny) rather than silently widen the grant.
 *
 * `.strict()`: this is control/security data, so per the freeze rule's
 * observability-vs-control asymmetry (docs/protocol.md "Freeze rule") an
 * unrecognized field must be REJECTED, not silently stripped-and-ignored the
 * way an ordinary payload's unknown field is (plain `z.object()`'s default
 * behavior). Without `.strict()`, a policy carrying a future constraint this
 * schema doesn't know about yet would parse successfully with that
 * constraint silently discarded — exactly the silent-widening failure mode
 * this type's own doc comment above warns against, since a stripped
 * constraint is indistinguishable from a constraint that was never sent.
 *
 * Consequence: adding a new field to this schema post-freeze is therefore a
 * BREAKING change requiring a `PROTOCOL_VERSION` bump — unlike the general
 * "a new optional field on an existing payload is non-breaking" rule the
 * freeze rule grants every other schema. That's intentional: a new
 * security/control constraint must force a conscious version bump so an
 * unupgraded peer can never silently ignore it, rather than being added the
 * same low-friction way a harmless observability field would be.
 */
export declare const PermissionPolicySchema: z.ZodObject<{
    mode: z.ZodEnum<{
        auto: "auto";
        confirm: "confirm";
        plan: "plan";
        readonly: "readonly";
    }>;
    allowTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    denyTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    workspaceRoot: z.ZodOptional<z.ZodString>;
    network: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;
// ==== @byok-sdk/protocol dist/provider-profile-binding.d.ts ====
import { z } from 'zod';
/** Daemon capability required before an exact local provider profile may be offered. */
export declare const PROVIDER_PROFILE_BINDING_CAPABILITY: 'provider-profile-binding';
/** Opaque, portable local profile identity. It is one logical id, never a path. */
export declare const ProviderProfileRefSchema: z.ZodString;
export type ProviderProfileRef = z.infer<typeof ProviderProfileRefSchema>;
/** Monotonic local profile revision represented canonically on the wire. */
export declare const ProviderProfileRevisionSchema: z.ZodString;
export type ProviderProfileRevision = z.infer<typeof ProviderProfileRevisionSchema>;
/** Hash of the normalized, non-secret local profile projection. */
export declare const ProviderProfileHashSchema: z.ZodString;
export type ProviderProfileHash = z.infer<typeof ProviderProfileHashSchema>;
export declare const PROVIDER_MODEL_CAPABILITIES: readonly ['image-input'];
export declare const ProviderModelCapabilitySchema: z.ZodEnum<{
    "image-input": "image-input";
}>;
export type ProviderModelCapability = z.infer<typeof ProviderModelCapabilitySchema>;
/** Credential-free exact desired binding. Endpoint and auth material stay device-local. */
export declare const ProviderProfileBindingSchema: z.ZodObject<{
    profileRef: z.ZodString;
    profileRevision: z.ZodString;
    profileHash: z.ZodString;
    modelId: z.ZodString;
    requiredCapabilities: z.ZodArray<z.ZodEnum<{
        "image-input": "image-input";
    }>>;
}, z.core.$strict>;
export type ProviderProfileBinding = z.infer<typeof ProviderProfileBindingSchema>;
// ==== @byok-sdk/protocol dist/task-state.d.ts ====
export declare const TASK_STATES: readonly ['Offered', 'Claimed', 'Running', 'AwaitApproval', 'Complete', 'Failed', 'Cancelled'];
export type TaskState = (typeof TASK_STATES)[number];
/**
 * Legal state transitions for a task. `Complete` / `Failed` / `Cancelled` are
 * terminal (no outgoing edges). `Running` and `AwaitApproval` form a loop:
 * the daemon can request approval mid-run and resume once the server
 * approves (or fail/cancel out of the approval wait).
 *
 * `Offered -> Failed` (M1 gap #5, "Declined vs. Failed"): a daemon that
 * declines an offer pre-claim (`task.decline`) reports it through the
 * existing `Failed` state rather than a new `Declined` state. A decline and
 * a post-claim failure are the same outcome from the dispatcher's point of
 * view — this attempt produced no result, `reason`/`retryable` say why and
 * whether retrying elsewhere makes sense — so reusing `Failed` keeps the
 * state machine minimal instead of forking every terminal-state consumer
 * into "Failed or Declined, handle both". See docs/protocol.md for the full
 * writeup.
 */
export declare const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>>;
/** Whether `from -> to` is a legal transition per {@link TASK_TRANSITIONS}. */
export declare function canTransition(from: TaskState, to: TaskState): boolean;
// ==== @byok-sdk/protocol dist/terminal-projection.d.ts ====
import { z } from 'zod';
/** Capability required before an offer may select terminal projection behavior. */
export declare const TERMINAL_PROJECTION_SELECTION_CAPABILITY: 'terminal-projection-selection';
export declare const TerminalProjectionContractSchema: z.ZodString;
/** Offer-scoped authority: explicit bypass or one required structured result. */
export declare const TerminalProjectionSelectionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    mode: z.ZodLiteral<"none">;
}, z.core.$strict>, z.ZodObject<{
    mode: z.ZodLiteral<"result-document">;
    contract: z.ZodString;
}, z.core.$strict>], "mode">;
export type TerminalProjectionSelection = z.infer<typeof TerminalProjectionSelectionSchema>;
// ==== @byok-sdk/protocol dist/version.d.ts ====
/**
 * Wire protocol version. Bump on breaking (non-additive) changes to the envelope
 * or message shapes. Additive changes (new optional fields, new message types)
 * do not require a bump — servers negotiate the highest common version and
 * daemons/servers must ignore unknown fields and unknown message types.
 *
 * FROZEN v1 (end of M2 — see docs/protocol.md "Freeze rule"): the pi, claude,
 * and codex runtime adapters have all exercised the wire, and every M1/M2
 * protocol gap has been closed. `PROTOCOL_VERSION` stays `1` from here
 * forward; it does not bump for additive changes (new optional fields, new
 * message types, new `AgentEvent` variants, new capability flags) — only for
 * a breaking one (changing, removing, or retyping anything that already
 * exists).
 *
 * IMPORTANT: changing this constant, or changing/removing/retyping any
 * already-frozen schema in this package, requires a DELIBERATE update to the
 * committed golden fixtures in `src/__tests__/golden/` (`v1.frozen.json`,
 * `v1.envelopes.ndjson`) — see `src/__tests__/freeze-guard.test.ts`, which
 * fails loudly on exactly that kind of drift. A passing freeze-guard run
 * after such a change means either (a) the change was genuinely additive and
 * the golden was regenerated with justification, or (b) this constant was
 * bumped alongside a new golden generation for the new version — never a
 * silent edit to either file to make the test pass.
 */
export declare const PROTOCOL_VERSION = 1;
/** Host declares that this device accepts only Agent-bound offer variants. */
export declare const STRICT_AGENT_ONLY_CAPABILITY: 'strict-agent-only';
/**
 * Capability flags exchanged during the connection handshake (`conn.hello` /
 * `conn.ack`). Additional flags may be introduced without a protocol version
 * bump; unrecognized flags must be ignored by both sides.
 *
 * `interactive-approval` is RESERVED as of this addition: it gates the
 * (currently unexercised) approval seam — a server must not route an
 * approval-requiring policy to a daemon that hasn't advertised this flag. No
 * bundled runtime adapter emits it yet; that's expected until interactive
 * approval is actually wired up in a later wave.
 *
 * `approval_resolved` (additive-minor): a SERVER-advertised flag meaning
 * "I understand the `task.approval_resolved` message" (`messages.ts`). This
 * is the N/N-1 answer for that new daemon -> server message: an old server's
 * `CAPABILITY_FLAGS`/`conn.ack.capabilities` never includes it, so a new
 * daemon talking to an old server never sends `task.approval_resolved` at
 * all (see `packages/client`'s `task-runner.ts`) and falls back to the
 * pre-existing implicit-resume inference
 * (`ConnectionHub.resumeIfImplicitlyApproved`, `packages/server/src/hub.ts`)
 * unconditionally, exactly as before this flag existed. Unlike
 * `interactive-approval`, this one IS exercised the moment both sides
 * support it — there is no reserved/dormant period for it.
 */
/**
 * `approval-targeting` (M5, additive-minor): unlike `approval_resolved`
 * above, this flag is purely INFORMATIONAL/semantic, not a functional gate.
 * `task.await_approval`/`task.approve`/`task.reject` all carry their new
 * `approvalId` field UNCONDITIONALLY on both sides once each peer is
 * upgraded -- the wire is tolerant (a plain, non-`.strict()` `z.object()`
 * field, `messages.ts`), so no version/capability negotiation is needed just
 * to send it safely; an older peer that doesn't recognize the field simply
 * never reads it. Receivers decide whether to apply exact-match targeting
 * by FIELD PRESENCE on the specific message at hand (does this particular
 * `task.approve`/`task.reject`/`onApprovalResolved` payload carry an
 * `approvalId`, and does a stored one exist to compare it against?), never
 * by checking this flag -- see `ConnectionHub.approveTask`/`rejectTask`/
 * `onApprovalResolved` and `TaskRunner.handleApprove`/`handleReject`
 * (`packages/client`'s `task-runner.ts`). This flag exists only so each side
 * can advertise, and an embedder/operator can observe (`ConnectionHub.
 * getDeviceCapabilities`), whether the OTHER side is new enough to
 * participate in targeting at all -- the same N/N-1-safe shape as every
 * other flag here, just consumed for observability instead of gating.
 */
/**
 * `result-document` (additive-minor): a SERVER-advertised flag meaning "I
 * understand the optional `task.complete.document` field" (`messages.ts`).
 * Functionally gating, like `approval_resolved` and unlike
 * `approval-targeting`.
 *
 * This is the N/N-1 answer for that new daemon -> server FIELD. An old
 * server's transport advertisement (`conn.ack.capabilities` on WS or
 * `EventsPollResponse.capabilities` on long-poll) never includes it, and
 * its `TaskCompletePayloadSchema` is a tolerant (non-`.strict()`)
 * `z.object()`, so a `document` sent to it would be silently STRIPPED on
 * parse and vanish without a trace. That is exactly why emission is gated
 * here rather than sent unconditionally the way `approvalId` is: `document`
 * carries the task's primary structured RESULT, so losing it silently is
 * data loss, not a missed observability hint. A new daemon talking to an old
 * server therefore never sends `document` at all, and — if its configured
 * extractor did produce one — reports `task.fail` (retryable: false; the
 * same server will strip it on every retry too) instead of completing the
 * task with its main result quietly deleted (`packages/client`'s
 * `task-runner.ts`). A new server talking to an old daemon is unaffected:
 * the field is optional, and an old daemon simply never sets it.
 *
 * `dispatch-selection` (additive-minor) is a correctness gate for the
 * optional `task.offer.dispatchSelection` control field. An older v1 daemon
 * legally strips unknown optional fields, so a server must never send an
 * authoritative provider/model selection unless the target connection
 * advertises this flag. Absence means reject before task creation, not send
 * a legacy runtime-only offer that could reach a different provider.
 *
 * `toolset-selection` (additive-minor) means the daemon understands
 * `task.offer_with_toolsets` and can resolve its logical ids against local
 * MCP configuration. The distinct message type is also the N/N-1 safety
 * boundary for long-poll: an older daemon skips it as unknown and therefore
 * cannot accidentally execute the instruction without the required tools.
 */
export declare const CAPABILITY_FLAGS: readonly ['steer', 'blob-upload', 'interactive-approval', 'approval_resolved', 'approval-targeting', 'result-document', 'dispatch-selection', "provider-profile-binding", 'toolset-selection', 'agent-home-contract', "strict-agent-only", "agent-egress-policy", "agent-egress-reliable-ack", "agent-message-egress", "agent-egress-fresh-session", "agent-content-workspace-read", "agent-content-transcript-read", "agent-content-artifact-read", "agent-home-projection", "terminal-projection-selection"];
export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];
