// ==== @byok-sdk/protocol dist/agent-egress.d.ts ====
import { z } from 'zod';
export declare const AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES: number;
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
/**
 * The latest-value activity lane. Agent events go to the Host as the runtime
 * produced them; these limits only bound transport (coalesce window and one
 * event's byte size).
 */
export declare const AgentEgressActivityPolicySchema: z.ZodObject<{
    delivery: z.ZodLiteral<"latest-value">;
    maxCoalesceMs: z.ZodNumber;
    maxEventBytes: z.ZodNumber;
}, z.core.$strict>;
export type AgentEgressActivityPolicy = z.infer<typeof AgentEgressActivityPolicySchema>;
export declare const AgentReliableQuotaPolicySchema: z.ZodObject<{
    maxPendingEventsPerAgent: z.ZodNumber;
    maxPendingBytesPerAgent: z.ZodNumber;
    maxPendingBytesPerTenant: z.ZodNumber;
}, z.core.$strict>;
export type AgentReliableQuotaPolicy = z.infer<typeof AgentReliableQuotaPolicySchema>;
/**
 * The only consumable policy shape for Agent egress. It selects transport
 * limits and the Host content-read surfaces. It does not filter, redact or
 * omit Agent egress content. Callers must select a revision and all three
 * content-read surfaces independently.
 */
export declare const AgentEgressPolicySchema: z.ZodObject<{
    policyRevision: z.ZodString;
    activity: z.ZodObject<{
        delivery: z.ZodLiteral<"latest-value">;
        maxCoalesceMs: z.ZodNumber;
        maxEventBytes: z.ZodNumber;
    }, z.core.$strict>;
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
 * Maximum UTF-16 length of {@link AgentEventSpillSchema}'s `unstoredReason`.
 * The reason is a bounded diagnostic string, not a place to inline the
 * content that failed to store: the whole point of a spill descriptor is
 * that the event stays under the daemon's inline-event cap even when the
 * blob upload failed.
 */
export declare const AGENT_EVENT_SPILL_UNSTORED_REASON_MAX_LENGTH = 512;
/**
 * Additive descriptor attached to a `tool_use` / `tool_result` event whose
 * `input` / `output` was too large to travel inline and was therefore
 * REPLACED, at the daemon's ingestion boundary, by a bounded head/tail
 * preview (`{ preview: { head, tail } }`). See
 * `packages/client/src/daemon/event-spill.ts` for the producer and
 * `DaemonConfig.maxInlineEventBytes` for the cap.
 *
 * Presence of this field is the ONLY signal that the inline field is a
 * projection rather than the whole value — a consumer that reads
 * `tool_result.output` (or `tool_use.input`) without checking `spill` is
 * reading a preview and calling it the result.
 *
 * Exactly one of `blob` / `unstoredReason` is present, and the union is
 * closed on purpose:
 *
 *  - `blob` — the full `JSON.stringify(<field>)` bytes are readable from the
 *    blob plane (protocol §7) under that `BlobRef`; `contentHash` is the
 *    sha256 of exactly those bytes, so a consumer can verify what it read
 *    back is what was omitted.
 *  - `unstoredReason` — the omitted bytes are not readable from this event:
 *    either the upload failed, or it succeeded but the returned locator did
 *    not fit the daemon's inline cap. Either way the content is not reachable
 *    through this event; the reason says which. This exists so an unreadable
 *    omission is observable rather than silently indistinguishable from a
 *    small output.
 *
 * `.strict()` because this is an SDK-authored descriptor with a closed
 * shape, not free-form runtime data: an unrecognized key here means a
 * producer and a consumer disagree about what the omission means, which is
 * exactly the case that must fail loudly.
 */
export declare const AgentEventSpillSchema: z.ZodObject<{
    field: z.ZodEnum<{
        input: "input";
        output: "output";
    }>;
    totalBytes: z.ZodNumber;
    omittedBytes: z.ZodNumber;
    contentType: z.ZodLiteral<"application/json">;
    blob: z.ZodOptional<z.ZodObject<{
        blobId: z.ZodString;
        contentHash: z.ZodString;
        size: z.ZodNumber;
        contentType: z.ZodString;
        url: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    unstoredReason: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type AgentEventSpill = z.infer<typeof AgentEventSpillSchema>;
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
    mcp: z.ZodOptional<z.ZodObject<{
        server: z.ZodString;
        tool: z.ZodString;
    }, z.core.$strict>>;
    input: z.ZodOptional<z.ZodUnknown>;
    toolCallId: z.ZodOptional<z.ZodString>;
    spill: z.ZodOptional<z.ZodObject<{
        field: z.ZodEnum<{
            input: "input";
            output: "output";
        }>;
        totalBytes: z.ZodNumber;
        omittedBytes: z.ZodNumber;
        contentType: z.ZodLiteral<"application/json">;
        blob: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        unstoredReason: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    tool: z.ZodString;
    mcp: z.ZodOptional<z.ZodObject<{
        server: z.ZodString;
        tool: z.ZodString;
    }, z.core.$strict>>;
    output: z.ZodOptional<z.ZodUnknown>;
    toolCallId: z.ZodOptional<z.ZodString>;
    isError: z.ZodOptional<z.ZodBoolean>;
    spill: z.ZodOptional<z.ZodObject<{
        field: z.ZodEnum<{
            input: "input";
            output: "output";
        }>;
        totalBytes: z.ZodNumber;
        omittedBytes: z.ZodNumber;
        contentType: z.ZodLiteral<"application/json">;
        blob: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        unstoredReason: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
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
    contextTokens: z.ZodOptional<z.ZodNumber>;
    contextWindow: z.ZodOptional<z.ZodNumber>;
    contextSource: z.ZodOptional<z.ZodEnum<{
        estimate: "estimate";
        provider: "provider";
    }>>;
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
 * (`instruction` — see `messages.ts`), which stay
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
    mcp: z.ZodOptional<z.ZodObject<{
        server: z.ZodString;
        tool: z.ZodString;
    }, z.core.$strict>>;
    input: z.ZodOptional<z.ZodUnknown>;
    toolCallId: z.ZodOptional<z.ZodString>;
    spill: z.ZodOptional<z.ZodObject<{
        field: z.ZodEnum<{
            input: "input";
            output: "output";
        }>;
        totalBytes: z.ZodNumber;
        omittedBytes: z.ZodNumber;
        contentType: z.ZodLiteral<"application/json">;
        blob: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        unstoredReason: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    tool: z.ZodString;
    mcp: z.ZodOptional<z.ZodObject<{
        server: z.ZodString;
        tool: z.ZodString;
    }, z.core.$strict>>;
    output: z.ZodOptional<z.ZodUnknown>;
    toolCallId: z.ZodOptional<z.ZodString>;
    isError: z.ZodOptional<z.ZodBoolean>;
    spill: z.ZodOptional<z.ZodObject<{
        field: z.ZodEnum<{
            input: "input";
            output: "output";
        }>;
        totalBytes: z.ZodNumber;
        omittedBytes: z.ZodNumber;
        contentType: z.ZodLiteral<"application/json">;
        blob: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        unstoredReason: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
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
    contextTokens: z.ZodOptional<z.ZodNumber>;
    contextWindow: z.ZodOptional<z.ZodNumber>;
    contextSource: z.ZodOptional<z.ZodEnum<{
        estimate: "estimate";
        provider: "provider";
    }>>;
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
// ==== @byok-sdk/protocol dist/agent-memory-intent.d.ts ====
import { z } from 'zod';
/**
 * Host-approved Agent memory intents — the wire half.
 *
 * A Host (the only approval authority) approves one exact memory operation on
 * one device-local Agent home. The device (the only memory content authority)
 * applies it with its existing sha256 CAS at most once and reports a terminal,
 * content-free completion. This package defines only:
 *
 * - the device capability that gates the task-free server -> daemon notice
 *   `agent.memory.intent.available`, whose strict payload is exactly
 *   `{ intentId, agentRef }` (see `messages.ts`);
 * - the immutable intent a Host releases over its own device routes;
 * - the fetch request/response a device exchanges with those routes;
 * - the terminal completion a device reports and the durable readback a Host
 *   returns for it.
 *
 * Notice-and-fetch is the point: memory content never rides the mailbox or the
 * device journal. The only field that carries content is `content` on a
 * `release` of a `replace` intent.
 *
 * Path authority stays with the device. This schema applies only the syntactic
 * bounds the device ledger relies on (at most 1024 ASCII bytes that need no
 * JSON escaping); the exact memory path rule (`MEMORY.md` or
 * `notes/<safe>/…md`) and the `MEMORY.md` delete ban are evaluated by the
 * device and reported as `path_invalid` / `memory_md_not_deletable`. Host-only
 * path policy is Host vocabulary and stays out of this package, as do
 * audiences, route paths and product names.
 *
 * `operationDigest` is pinned to `@byok-sdk/core`
 * `agentMemoryIntentOperationDigest(...)`, which a device recomputes with its
 * own enrolled tenant and device ids.
 */
/** Maximum UTF-8 byte length of a released `replace` body (one memory file): 256 KiB. */
export declare const AGENT_MEMORY_INTENT_CONTENT_MAX_BYTES = 262144;
/** Maximum byte length of an intent `path` (ASCII, so bytes = characters). */
export declare const AGENT_MEMORY_INTENT_PATH_MAX_BYTES = 1024;
/** Maximum byte length of an opaque `approvalRef` (ASCII, so bytes = characters). */
export declare const AGENT_MEMORY_INTENT_APPROVAL_REF_MAX_BYTES = 128;
/** A memory file revision: `sha256:` over the file bytes (a missing file is the empty-bytes digest). */
export declare const AgentMemoryIntentRevisionSchema: z.ZodString;
export type AgentMemoryIntentRevision = z.infer<typeof AgentMemoryIntentRevisionSchema>;
/** The identity-and-operation binding; see `@byok-sdk/core` `agentMemoryIntentOperationDigest`. */
export declare const AgentMemoryIntentOperationDigestSchema: z.ZodString;
export type AgentMemoryIntentOperationDigest = z.infer<typeof AgentMemoryIntentOperationDigestSchema>;
/**
 * Syntactic bound only: 1..1024 printable ASCII characters that need no JSON
 * escaping (no `"`, no `\`, no control characters). The device applies the
 * exact memory path rule.
 */
export declare const AgentMemoryIntentPathSchema: z.ZodString;
export type AgentMemoryIntentPath = z.infer<typeof AgentMemoryIntentPathSchema>;
/** Opaque audit correlation. The device records it and never evaluates it. */
export declare const AgentMemoryIntentApprovalRefSchema: z.ZodString;
export type AgentMemoryIntentApprovalRef = z.infer<typeof AgentMemoryIntentApprovalRefSchema>;
/** A `replace` body: well-formed Unicode whose UTF-8 encoding is at most 256 KiB. */
export declare const AgentMemoryIntentContentSchema: z.ZodString;
export type AgentMemoryIntentContent = z.infer<typeof AgentMemoryIntentContentSchema>;
export declare const AGENT_MEMORY_INTENT_OPERATIONS: readonly ['replace', 'delete'];
export declare const AgentMemoryIntentOperationSchema: z.ZodEnum<{
    delete: "delete";
    replace: "replace";
}>;
export type AgentMemoryIntentOperation = z.infer<typeof AgentMemoryIntentOperationSchema>;
/**
 * The immutable Host-approved intent.
 *
 * - `replace`: `targetRevision` is the digest of the approved body and must
 *   differ from `baseRevision`; `content` appears only inside a `release`.
 * - `delete`: `targetRevision` is `null` and there is never `content`.
 */
export declare const AgentMemoryIntentV1Schema: z.ZodObject<{
    intentId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    path: z.ZodString;
    operation: z.ZodEnum<{
        delete: "delete";
        replace: "replace";
    }>;
    baseRevision: z.ZodString;
    targetRevision: z.ZodNullable<z.ZodString>;
    content: z.ZodOptional<z.ZodString>;
    approvalRef: z.ZodString;
    operationDigest: z.ZodString;
}, z.core.$strict>;
export type AgentMemoryIntentV1 = z.infer<typeof AgentMemoryIntentV1Schema>;
/**
 * Codes a Host decides on its own authority. They are the only `withheld`
 * codes and the only codes a `host_terminal` readback may carry.
 */
export declare const AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES: readonly ['intent_revoked', 'intent_expired', 'placement_changed', 'profile_revision_changed'];
export declare const AgentMemoryIntentHostTerminalCodeSchema: z.ZodEnum<{
    intent_expired: "intent_expired";
    intent_revoked: "intent_revoked";
    placement_changed: "placement_changed";
    profile_revision_changed: "profile_revision_changed";
}>;
export type AgentMemoryIntentHostTerminalCode = z.infer<typeof AgentMemoryIntentHostTerminalCodeSchema>;
/**
 * Closed rejection set. A code names the failed check, never a value. Every
 * `rejected` completion means the device wrote no `applying` record and made
 * zero memory writes.
 */
export declare const AGENT_MEMORY_INTENT_REJECTION_CODES: readonly ["intent_invalid", "path_invalid", "memory_md_not_deletable", "content_invalid", "intent_digest_mismatch", "agent_ref_mismatch", "agent_home_unavailable", "intent_revoked", "intent_expired", "placement_changed", "profile_revision_changed"];
export declare const AgentMemoryIntentRejectionCodeSchema: z.ZodEnum<{
    agent_home_unavailable: "agent_home_unavailable";
    agent_ref_mismatch: "agent_ref_mismatch";
    content_invalid: "content_invalid";
    intent_digest_mismatch: "intent_digest_mismatch";
    intent_expired: "intent_expired";
    intent_invalid: "intent_invalid";
    intent_revoked: "intent_revoked";
    memory_md_not_deletable: "memory_md_not_deletable";
    path_invalid: "path_invalid";
    placement_changed: "placement_changed";
    profile_revision_changed: "profile_revision_changed";
}>;
export type AgentMemoryIntentRejectionCode = z.infer<typeof AgentMemoryIntentRejectionCodeSchema>;
/** One device observation of the target file. The observation instant is not on the wire. */
export declare const AgentMemoryIntentFileObservationSchema: z.ZodObject<{
    exists: z.ZodBoolean;
    revision: z.ZodString;
}, z.core.$strict>;
export type AgentMemoryIntentFileObservation = z.infer<typeof AgentMemoryIntentFileObservationSchema>;
/**
 * The terminal, content-free result of one intent, reported by the device.
 *
 * - `applied`: the live-path CAS returned success; `result` is the file after it.
 * - `conflict`: the live-path CAS refused on revision; this attempt wrote nothing.
 * - `rejected`: no `applying` record was written; zero writes.
 * - `uncertain`: whether this intent wrote is unknown; `observed` is only the
 *   current file, never provenance.
 *
 * There is no non-terminal outcome.
 */
export declare const AgentMemoryIntentCompletionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    intentId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    path: z.ZodString;
    operation: z.ZodEnum<{
        delete: "delete";
        replace: "replace";
    }>;
    operationDigest: z.ZodString;
    outcome: z.ZodLiteral<"applied">;
    result: z.ZodObject<{
        exists: z.ZodBoolean;
        revision: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    intentId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    path: z.ZodString;
    operation: z.ZodEnum<{
        delete: "delete";
        replace: "replace";
    }>;
    operationDigest: z.ZodString;
    outcome: z.ZodLiteral<"conflict">;
    observed: z.ZodObject<{
        exists: z.ZodBoolean;
        revision: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    intentId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    path: z.ZodString;
    operation: z.ZodEnum<{
        delete: "delete";
        replace: "replace";
    }>;
    operationDigest: z.ZodString;
    outcome: z.ZodLiteral<"rejected">;
    code: z.ZodEnum<{
        agent_home_unavailable: "agent_home_unavailable";
        agent_ref_mismatch: "agent_ref_mismatch";
        content_invalid: "content_invalid";
        intent_digest_mismatch: "intent_digest_mismatch";
        intent_expired: "intent_expired";
        intent_invalid: "intent_invalid";
        intent_revoked: "intent_revoked";
        memory_md_not_deletable: "memory_md_not_deletable";
        path_invalid: "path_invalid";
        placement_changed: "placement_changed";
        profile_revision_changed: "profile_revision_changed";
    }>;
}, z.core.$strict>, z.ZodObject<{
    intentId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    path: z.ZodString;
    operation: z.ZodEnum<{
        delete: "delete";
        replace: "replace";
    }>;
    operationDigest: z.ZodString;
    outcome: z.ZodLiteral<"uncertain">;
    observed: z.ZodObject<{
        exists: z.ZodBoolean;
        revision: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>], "outcome">;
export type AgentMemoryIntentCompletion = z.infer<typeof AgentMemoryIntentCompletionSchema>;
/**
 * How the Host's durable record relates to the completion it was handed:
 *
 * - `recorded`: this completion became the intent's first terminal fact.
 * - `idempotent`: an identical completion was already recorded.
 * - `conflict`: a different completion is already recorded; it is returned.
 * - `host_terminal`: the Host had already terminated the intent on its own
 *   authority ({@link AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES}).
 */
export declare const AGENT_MEMORY_INTENT_READBACK_DISPOSITIONS: readonly ['recorded', 'idempotent', 'conflict', 'host_terminal'];
export declare const AgentMemoryIntentReadbackDispositionSchema: z.ZodEnum<{
    conflict: "conflict";
    host_terminal: "host_terminal";
    idempotent: "idempotent";
    recorded: "recorded";
}>;
export type AgentMemoryIntentReadbackDisposition = z.infer<typeof AgentMemoryIntentReadbackDispositionSchema>;
/**
 * The Host's durable terminal readback for one intent. `completion` is the
 * terminal fact the Host has STORED; on `host_terminal` it is always a
 * `rejected` completion carrying a Host code. `recordedAt` is the Host record
 * time, never a device observation time.
 */
export declare const AgentMemoryIntentReadbackSchema: z.ZodObject<{
    tenantId: z.ZodString;
    deviceId: z.ZodString;
    intentId: z.ZodUUID;
    disposition: z.ZodEnum<{
        conflict: "conflict";
        host_terminal: "host_terminal";
        idempotent: "idempotent";
        recorded: "recorded";
    }>;
    completion: z.ZodDiscriminatedUnion<[z.ZodObject<{
        intentId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        path: z.ZodString;
        operation: z.ZodEnum<{
            delete: "delete";
            replace: "replace";
        }>;
        operationDigest: z.ZodString;
        outcome: z.ZodLiteral<"applied">;
        result: z.ZodObject<{
            exists: z.ZodBoolean;
            revision: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        intentId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        path: z.ZodString;
        operation: z.ZodEnum<{
            delete: "delete";
            replace: "replace";
        }>;
        operationDigest: z.ZodString;
        outcome: z.ZodLiteral<"conflict">;
        observed: z.ZodObject<{
            exists: z.ZodBoolean;
            revision: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        intentId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        path: z.ZodString;
        operation: z.ZodEnum<{
            delete: "delete";
            replace: "replace";
        }>;
        operationDigest: z.ZodString;
        outcome: z.ZodLiteral<"rejected">;
        code: z.ZodEnum<{
            agent_home_unavailable: "agent_home_unavailable";
            agent_ref_mismatch: "agent_ref_mismatch";
            content_invalid: "content_invalid";
            intent_digest_mismatch: "intent_digest_mismatch";
            intent_expired: "intent_expired";
            intent_invalid: "intent_invalid";
            intent_revoked: "intent_revoked";
            memory_md_not_deletable: "memory_md_not_deletable";
            path_invalid: "path_invalid";
            placement_changed: "placement_changed";
            profile_revision_changed: "profile_revision_changed";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        intentId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        path: z.ZodString;
        operation: z.ZodEnum<{
            delete: "delete";
            replace: "replace";
        }>;
        operationDigest: z.ZodString;
        outcome: z.ZodLiteral<"uncertain">;
        observed: z.ZodObject<{
            exists: z.ZodBoolean;
            revision: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>], "outcome">;
    recordedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type AgentMemoryIntentReadback = z.infer<typeof AgentMemoryIntentReadbackSchema>;
/**
 * `held`: the device reserved a ledger slot and may receive a release.
 * `none`: the device could not reserve; the Host must not change intent state
 * or release content.
 */
export declare const AGENT_MEMORY_INTENT_RESERVATIONS: readonly ['held', 'none'];
export declare const AgentMemoryIntentReservationSchema: z.ZodEnum<{
    held: "held";
    none: "none";
}>;
export type AgentMemoryIntentReservation = z.infer<typeof AgentMemoryIntentReservationSchema>;
/**
 * The SDK half of a fetch. Device authentication (the tenant and device a Host
 * trusts) is Host transport vocabulary and is not part of this schema.
 */
export declare const AgentMemoryIntentFetchRequestSchema: z.ZodObject<{
    intentId: z.ZodUUID;
    reservation: z.ZodEnum<{
        held: "held";
        none: "none";
    }>;
}, z.core.$strict>;
export type AgentMemoryIntentFetchRequest = z.infer<typeof AgentMemoryIntentFetchRequestSchema>;
export declare const AGENT_MEMORY_INTENT_FETCH_DISPOSITIONS: readonly ['release', 'withheld', 'terminal', 'deferred'];
export type AgentMemoryIntentFetchDisposition = (typeof AGENT_MEMORY_INTENT_FETCH_DISPOSITIONS)[number];
/** Which fetch dispositions a Host may answer for each request reservation. */
export declare const AGENT_MEMORY_INTENT_FETCH_DISPOSITIONS_BY_RESERVATION: {
    readonly held: readonly ["release", "withheld", "terminal"];
    readonly none: readonly ["terminal", "deferred"];
};
/**
 * A Host fetch answer, independent of the request reservation. A device must
 * parse with {@link agentMemoryIntentFetchResponseSchemaFor} so a `release` or
 * `withheld` answer to a `none` request (or a `deferred` answer to a `held`
 * request) is refused.
 */
export declare const AgentMemoryIntentFetchResponseSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    disposition: z.ZodLiteral<"release">;
    intent: z.ZodObject<{
        intentId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        path: z.ZodString;
        operation: z.ZodEnum<{
            delete: "delete";
            replace: "replace";
        }>;
        baseRevision: z.ZodString;
        targetRevision: z.ZodNullable<z.ZodString>;
        content: z.ZodOptional<z.ZodString>;
        approvalRef: z.ZodString;
        operationDigest: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    disposition: z.ZodLiteral<"withheld">;
    intent: z.ZodObject<{
        intentId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        path: z.ZodString;
        operation: z.ZodEnum<{
            delete: "delete";
            replace: "replace";
        }>;
        baseRevision: z.ZodString;
        targetRevision: z.ZodNullable<z.ZodString>;
        content: z.ZodOptional<z.ZodString>;
        approvalRef: z.ZodString;
        operationDigest: z.ZodString;
    }, z.core.$strict>;
    code: z.ZodEnum<{
        intent_expired: "intent_expired";
        intent_revoked: "intent_revoked";
        placement_changed: "placement_changed";
        profile_revision_changed: "profile_revision_changed";
    }>;
}, z.core.$strict>, z.ZodObject<{
    disposition: z.ZodLiteral<"terminal">;
    intent: z.ZodObject<{
        intentId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        path: z.ZodString;
        operation: z.ZodEnum<{
            delete: "delete";
            replace: "replace";
        }>;
        baseRevision: z.ZodString;
        targetRevision: z.ZodNullable<z.ZodString>;
        content: z.ZodOptional<z.ZodString>;
        approvalRef: z.ZodString;
        operationDigest: z.ZodString;
    }, z.core.$strict>;
    readback: z.ZodObject<{
        tenantId: z.ZodString;
        deviceId: z.ZodString;
        intentId: z.ZodUUID;
        disposition: z.ZodEnum<{
            conflict: "conflict";
            host_terminal: "host_terminal";
            idempotent: "idempotent";
            recorded: "recorded";
        }>;
        completion: z.ZodDiscriminatedUnion<[z.ZodObject<{
            intentId: z.ZodUUID;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            path: z.ZodString;
            operation: z.ZodEnum<{
                delete: "delete";
                replace: "replace";
            }>;
            operationDigest: z.ZodString;
            outcome: z.ZodLiteral<"applied">;
            result: z.ZodObject<{
                exists: z.ZodBoolean;
                revision: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            intentId: z.ZodUUID;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            path: z.ZodString;
            operation: z.ZodEnum<{
                delete: "delete";
                replace: "replace";
            }>;
            operationDigest: z.ZodString;
            outcome: z.ZodLiteral<"conflict">;
            observed: z.ZodObject<{
                exists: z.ZodBoolean;
                revision: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            intentId: z.ZodUUID;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            path: z.ZodString;
            operation: z.ZodEnum<{
                delete: "delete";
                replace: "replace";
            }>;
            operationDigest: z.ZodString;
            outcome: z.ZodLiteral<"rejected">;
            code: z.ZodEnum<{
                agent_home_unavailable: "agent_home_unavailable";
                agent_ref_mismatch: "agent_ref_mismatch";
                content_invalid: "content_invalid";
                intent_digest_mismatch: "intent_digest_mismatch";
                intent_expired: "intent_expired";
                intent_invalid: "intent_invalid";
                intent_revoked: "intent_revoked";
                memory_md_not_deletable: "memory_md_not_deletable";
                path_invalid: "path_invalid";
                placement_changed: "placement_changed";
                profile_revision_changed: "profile_revision_changed";
            }>;
        }, z.core.$strict>, z.ZodObject<{
            intentId: z.ZodUUID;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            path: z.ZodString;
            operation: z.ZodEnum<{
                delete: "delete";
                replace: "replace";
            }>;
            operationDigest: z.ZodString;
            outcome: z.ZodLiteral<"uncertain">;
            observed: z.ZodObject<{
                exists: z.ZodBoolean;
                revision: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>], "outcome">;
        recordedAt: z.ZodISODateTime;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    disposition: z.ZodLiteral<"deferred">;
    intent: z.ZodObject<{
        intentId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        path: z.ZodString;
        operation: z.ZodEnum<{
            delete: "delete";
            replace: "replace";
        }>;
        baseRevision: z.ZodString;
        targetRevision: z.ZodNullable<z.ZodString>;
        content: z.ZodOptional<z.ZodString>;
        approvalRef: z.ZodString;
        operationDigest: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>], "disposition">;
export type AgentMemoryIntentFetchResponse = z.infer<typeof AgentMemoryIntentFetchResponseSchema>;
/** The fetch answer schema bound to the reservation the device sent. */
export declare function agentMemoryIntentFetchResponseSchemaFor(reservation: AgentMemoryIntentReservation): z.ZodDiscriminatedUnion<[z.ZodObject<{
    disposition: z.ZodLiteral<"release">;
    intent: z.ZodObject<{
        intentId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        path: z.ZodString;
        operation: z.ZodEnum<{
            delete: "delete";
            replace: "replace";
        }>;
        baseRevision: z.ZodString;
        targetRevision: z.ZodNullable<z.ZodString>;
        content: z.ZodOptional<z.ZodString>;
        approvalRef: z.ZodString;
        operationDigest: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    disposition: z.ZodLiteral<"withheld">;
    intent: z.ZodObject<{
        intentId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        path: z.ZodString;
        operation: z.ZodEnum<{
            delete: "delete";
            replace: "replace";
        }>;
        baseRevision: z.ZodString;
        targetRevision: z.ZodNullable<z.ZodString>;
        content: z.ZodOptional<z.ZodString>;
        approvalRef: z.ZodString;
        operationDigest: z.ZodString;
    }, z.core.$strict>;
    code: z.ZodEnum<{
        intent_expired: "intent_expired";
        intent_revoked: "intent_revoked";
        placement_changed: "placement_changed";
        profile_revision_changed: "profile_revision_changed";
    }>;
}, z.core.$strict>, z.ZodObject<{
    disposition: z.ZodLiteral<"terminal">;
    intent: z.ZodObject<{
        intentId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        path: z.ZodString;
        operation: z.ZodEnum<{
            delete: "delete";
            replace: "replace";
        }>;
        baseRevision: z.ZodString;
        targetRevision: z.ZodNullable<z.ZodString>;
        content: z.ZodOptional<z.ZodString>;
        approvalRef: z.ZodString;
        operationDigest: z.ZodString;
    }, z.core.$strict>;
    readback: z.ZodObject<{
        tenantId: z.ZodString;
        deviceId: z.ZodString;
        intentId: z.ZodUUID;
        disposition: z.ZodEnum<{
            conflict: "conflict";
            host_terminal: "host_terminal";
            idempotent: "idempotent";
            recorded: "recorded";
        }>;
        completion: z.ZodDiscriminatedUnion<[z.ZodObject<{
            intentId: z.ZodUUID;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            path: z.ZodString;
            operation: z.ZodEnum<{
                delete: "delete";
                replace: "replace";
            }>;
            operationDigest: z.ZodString;
            outcome: z.ZodLiteral<"applied">;
            result: z.ZodObject<{
                exists: z.ZodBoolean;
                revision: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            intentId: z.ZodUUID;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            path: z.ZodString;
            operation: z.ZodEnum<{
                delete: "delete";
                replace: "replace";
            }>;
            operationDigest: z.ZodString;
            outcome: z.ZodLiteral<"conflict">;
            observed: z.ZodObject<{
                exists: z.ZodBoolean;
                revision: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            intentId: z.ZodUUID;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            path: z.ZodString;
            operation: z.ZodEnum<{
                delete: "delete";
                replace: "replace";
            }>;
            operationDigest: z.ZodString;
            outcome: z.ZodLiteral<"rejected">;
            code: z.ZodEnum<{
                agent_home_unavailable: "agent_home_unavailable";
                agent_ref_mismatch: "agent_ref_mismatch";
                content_invalid: "content_invalid";
                intent_digest_mismatch: "intent_digest_mismatch";
                intent_expired: "intent_expired";
                intent_invalid: "intent_invalid";
                intent_revoked: "intent_revoked";
                memory_md_not_deletable: "memory_md_not_deletable";
                path_invalid: "path_invalid";
                placement_changed: "placement_changed";
                profile_revision_changed: "profile_revision_changed";
            }>;
        }, z.core.$strict>, z.ZodObject<{
            intentId: z.ZodUUID;
            agentRef: z.ZodObject<{
                agentId: z.ZodString;
                profileRevision: z.ZodString;
            }, z.core.$strict>;
            path: z.ZodString;
            operation: z.ZodEnum<{
                delete: "delete";
                replace: "replace";
            }>;
            operationDigest: z.ZodString;
            outcome: z.ZodLiteral<"uncertain">;
            observed: z.ZodObject<{
                exists: z.ZodBoolean;
                revision: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>], "outcome">;
        recordedAt: z.ZodISODateTime;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    disposition: z.ZodLiteral<"deferred">;
    intent: z.ZodObject<{
        intentId: z.ZodUUID;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        path: z.ZodString;
        operation: z.ZodEnum<{
            delete: "delete";
            replace: "replace";
        }>;
        baseRevision: z.ZodString;
        targetRevision: z.ZodNullable<z.ZodString>;
        content: z.ZodOptional<z.ZodString>;
        approvalRef: z.ZodString;
        operationDigest: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>], "disposition">;
// ==== @byok-sdk/protocol dist/agent-memory-projection.d.ts ====
import { z } from 'zod';
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
// ==== @byok-sdk/protocol dist/bot-turn-outcome.d.ts ====
import { type ResultSchema } from './result-schema';
export declare const BOT_TURN_OUTCOME_CONTRACT = "bot-turn-outcome.v1";
/** Code-point and item caps for Bot turn outcomes. */
export declare const BOT_TURN_OUTCOME_LIMITS: Readonly<{
    delegateMaxItems: 2;
    delegateRequestMaxLength: 1000;
    cancelDelegationMaxItems: 2;
    askUserQuestionMaxLength: 400;
    askUserOptionsMaxItems: 6;
    askUserOptionIdMaxLength: 24;
    askUserOptionLabelMaxLength: 80;
    confirmableActionMaxItems: 1;
    confirmableSummaryMaxLength: 300;
    confirmableDraftMaxBytes: 16384;
    createRoutineMaxItems: 1;
    updateRoutineMaxItems: 1;
    cancelRoutineMaxItems: 2;
    routinePromptMaxLength: 500;
    postTextMaxLength: 2730;
    roomCallMembersMaxItems: 4;
    createBotMaxItems: 3;
    updateBotMaxItems: 1;
    deleteBotMaxItems: 1;
    botNameMaxLength: 40;
    botRoleMaxLength: 80;
    botPersonaMaxLength: 300;
    createRoomMaxItems: 1;
    updateRoomMaxItems: 1;
    roomNameMaxLength: 40;
    roomMembersMaxItems: 12;
    roomAnnouncementMaxLength: 300;
    teamNoteMaxLength: 300;
}>;
export type NonEmptyIds = readonly [string, ...string[]];
/** ISO 8601 order, Monday first. Equal to core's list. A server test checks parity. */
export declare const ROUTINE_DAYS_OF_WEEK: readonly ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export type RoutineDayOfWeek = (typeof ROUTINE_DAYS_OF_WEEK)[number];
export type BotTurnOutcomeSchemaErrorCode = 'not-subset' | 'schema-over-budget' | 'over-budget' | 'draft-over-budget';
export declare class BotTurnOutcomeSchemaError extends Error {
    readonly code: BotTurnOutcomeSchemaErrorCode;
    constructor(code: BotTurnOutcomeSchemaErrorCode, message: string);
}
/**
 * `checked` (default): field types, ranges and enums sit once in the outer
 * properties; each oneOf branch lists only its allowed names and required
 * fields, with additionalProperties false. An instance matches exactly one
 * branch: daysOfWeek and dayOfMonth never appear together; month needs
 * dayOfMonth. `flat`: the same outer object without the oneOf; the Host then
 * refuses those two combinations at apply time. Use `flat` only under the
 * schema budget rule of composeBotTurnOutcomeSchema. Neither form sees
 * duplicate days, a day the month never has (Apr 31), or Feb 29.
 */
export type RoutineScheduleShape = 'checked' | 'flat';
/**
 * Every id is a Host-filled enum. New objects use Host-offered localId slots
 * (e.g. "new_bot_1"), so a same-outcome reference is also an enum member.
 */
export declare const botTurnOutcomeFragments: {
    /** `to` lists this Bot first: delegating to yourself is a continuation. */
    delegate(o: {
        to: NonEmptyIds;
    }): ResultSchema;
    /** Owner-authorized Main Bot turns only. The Host lists open delegations. */
    cancelDelegation(o: {
        delegationIds: NonEmptyIds;
    }): ResultSchema;
    askUser(): ResultSchema;
    /** One branch per Host action; each draft needs a finite bound of at most confirmableDraftMaxBytes. */
    confirmableAction(o: {
        actions: readonly [{
            action: string;
            draft: ResultSchema;
        }, ...{
            action: string;
            draft: ResultSchema;
        }[]];
    }): ResultSchema;
    /** `targets` only for a Main Bot: the Bot itself first, then team Bots. Omitted means the Bot itself. */
    createRoutine(o: {
        localIds: NonEmptyIds;
        timeZones: NonEmptyIds;
        targets?: NonEmptyIds;
        scheduleShape?: RoutineScheduleShape;
    }): ResultSchema;
    updateRoutine(o: {
        routineIds: NonEmptyIds;
        timeZones: NonEmptyIds;
        scheduleShape?: RoutineScheduleShape;
    }): ResultSchema;
    cancelRoutine(o: {
        routineIds: NonEmptyIds;
    }): ResultSchema;
    /** Room turns only. Exactly one of post or pass. */
    speech(): ResultSchema;
    roomCall(o: {
        members: NonEmptyIds;
    }): ResultSchema;
    createBot(o: {
        localIds: NonEmptyIds;
        models: NonEmptyIds;
    }): ResultSchema;
    updateBot(o: {
        botIds: NonEmptyIds;
        models: NonEmptyIds;
    }): ResultSchema;
    deleteBot(o: {
        botIds: NonEmptyIds;
    }): ResultSchema;
    /** `members`: team Bot ids plus the create_bot localId slots of this outcome. */
    createRoom(o: {
        localIds: NonEmptyIds;
        members: NonEmptyIds;
    }): ResultSchema;
    updateRoom(o: {
        roomIds: NonEmptyIds;
        members: NonEmptyIds;
    }): ResultSchema;
    teamNote(): ResultSchema;
};
export type BotTurnOutcomeKind = 'delegate' | 'cancel_delegation' | 'ask_user' | 'confirmable_action' | 'create_routine' | 'update_routine' | 'cancel_routine' | 'speech' | 'room_call' | 'create_bot' | 'update_bot' | 'delete_bot' | 'create_room' | 'update_room' | 'team_note';
/**
 * Host composition: pick fragments, freeze the result in the offer. Refuses a
 * schema outside the K7 subset ('not-subset'), a schema above
 * RESULT_SCHEMA_MAX_BYTES ('schema-over-budget'), or one whose largest
 * instance could exceed RESULT_OUTCOME_MAX_BYTES ('over-budget').
 *
 * Schema budget rule, before the offer is frozen: only 'schema-over-budget'
 * allows the Host to rebuild the routine fragments with scheduleShape 'flat'.
 * If the schema is still over, the Host blocks the turn with a visible reason
 * or runs its defined batch selection. It never drops authorized ids from an
 * enum silently.
 */
export declare function composeBotTurnOutcomeSchema(fragments: BotTurnOutcomeFragments, required?: readonly BotTurnOutcomeKind[]): ResultSchema;
export type BotTurnOutcomeFragments = Partial<Readonly<Record<BotTurnOutcomeKind, ResultSchema>>>;
export interface DelegateAction {
    readonly to: string;
    readonly request: string;
}
export interface CancelDelegationAction {
    readonly delegationId: string;
}
export type AskUserAction = {
    readonly question: string;
    readonly answerKind: 'text';
} | {
    readonly question: string;
    readonly answerKind: 'single_choice';
    readonly options: readonly {
        readonly id: string;
        readonly label: string;
    }[];
};
export interface ConfirmableAction<Draft = unknown> {
    readonly action: string;
    readonly summary: string;
    readonly draft: Draft;
}
/**
 * No day field: every day. daysOfWeek and dayOfMonth never appear together;
 * month needs dayOfMonth. Under the 'flat' shape the schema does not enforce
 * this; the Host narrows to this type only after checkRoutineSchedule passes.
 */
export type RoutineScheduleFields = {
    readonly minute: number;
    readonly hour: number;
    readonly tz: string;
} | {
    readonly minute: number;
    readonly hour: number;
    readonly daysOfWeek: readonly RoutineDayOfWeek[];
    readonly tz: string;
} | {
    readonly minute: number;
    readonly hour: number;
    readonly dayOfMonth: number;
    readonly month?: number;
    readonly tz: string;
};
export interface CreateRoutineAction {
    readonly localId: string;
    readonly schedule: RoutineScheduleFields;
    readonly prompt: string;
    readonly target?: string;
}
export interface UpdateRoutineAction {
    readonly routineId: string;
    readonly schedule?: RoutineScheduleFields;
    readonly prompt?: string;
}
export interface CancelRoutineAction {
    readonly routineId: string;
}
export type RoomSpeech = {
    readonly kind: 'post';
    readonly text: string;
} | {
    readonly kind: 'pass';
};
export interface RoomCallAction {
    readonly members: readonly string[];
}
export interface CreateBotAction {
    readonly localId: string;
    readonly name: string;
    readonly role: string;
    readonly persona: string;
    readonly model: string;
}
export interface UpdateBotAction {
    readonly botId: string;
    readonly name?: string;
    readonly role?: string;
    readonly persona?: string;
    readonly model?: string;
}
export interface DeleteBotAction {
    readonly botId: string;
}
export interface RoomFields {
    readonly name: string;
    readonly members: readonly string[];
    readonly admin?: string;
    readonly mode?: 'mention' | 'admin';
    readonly announcement?: string;
}
export interface CreateRoomAction extends RoomFields {
    readonly localId: string;
}
export interface UpdateRoomAction extends Partial<RoomFields> {
    readonly roomId: string;
}
export interface TeamNoteAction {
    readonly text: string;
}
/** Shape of a document that passed a schema composed from these fragments. */
export interface BotTurnOutcome {
    readonly delegate?: readonly DelegateAction[];
    readonly cancel_delegation?: readonly CancelDelegationAction[];
    readonly ask_user?: AskUserAction;
    readonly confirmable_action?: readonly ConfirmableAction[];
    readonly create_routine?: readonly CreateRoutineAction[];
    readonly update_routine?: readonly UpdateRoutineAction[];
    readonly cancel_routine?: readonly CancelRoutineAction[];
    readonly speech?: RoomSpeech;
    readonly room_call?: RoomCallAction;
    readonly create_bot?: readonly CreateBotAction[];
    readonly update_bot?: readonly UpdateBotAction[];
    readonly delete_bot?: readonly DeleteBotAction[];
    readonly create_room?: readonly CreateRoomAction[];
    readonly update_room?: readonly UpdateRoomAction[];
    readonly team_note?: TeamNoteAction;
}
// ==== @byok-sdk/protocol dist/capability-constants.d.ts ====
/**
 * The ONE version of the input-preparation contract, shared by this relay wire
 * (the `agent.input.preparation` payload and the completion receipt summary)
 * and by the device-local request, receipt and artifact
 * (`@byok-sdk/client`'s `INPUT_PREPARATION_VERSION`, which is this value).
 *
 * The relay wire carries no version field of its own, so a version change is
 * made visible where admission actually happens: in the capability token
 * below. See `INPUT_PREPARATION_VERSION` in the client for what each version
 * changed.
 */
export declare const INPUT_PREPARATION_WIRE_VERSION: 9;
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
/** Capability required before a task-free Agent-home projection is admitted. */
export declare const AGENT_HOME_PROJECTION_CAPABILITY: 'agent-home-projection';
/** Capability required before an offer may select terminal projection behavior. */
export declare const TERMINAL_PROJECTION_SELECTION_CAPABILITY: 'terminal-projection-selection';
/** Contract §8.1's capability gate for `byok-task-assertion-v1` tool authority. */
export declare const HOST_MCP_TASK_CONTEXT_CAPABILITY: 'host-mcp-task-context';
/** Daemon capability required before an exact local provider profile may be offered. */
export declare const PROVIDER_PROFILE_BINDING_CAPABILITY: 'provider-profile-binding';
/** Device capability required before a Host may enqueue `provider.provisioning.available`. */
export declare const PROVIDER_PROVISIONING_CAPABILITY: 'provider-provisioning.v1';
/** Device capability required before a Host may enqueue `agent.memory.intent.available`. */
export declare const AGENT_MEMORY_INTENT_CAPABILITY: 'agent-memory-intent.v1';
/** Capability required before the optional hosted Agent-memory projection can be used. */
export declare const AGENT_MEMORY_PROJECTION_CAPABILITY: 'agent.memory.projection';
/** Device capability required before an ordinary Agent offer may carry `agentMemory`. */
export declare const AGENT_MEMORY_SELECTION_CAPABILITY: 'agent-memory-selection';
/** Device capability required before an ordinary Agent offer may carry `agentMemory: 'read-if-admitted'`. */
export declare const AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY: 'agent-memory-read-if-admitted';
/** Device capability required before an ordinary Agent offer may carry `agentMemory: 'read-write-if-admitted'`. */
export declare const AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY: 'agent-memory-read-write-if-admitted';
/** Exact capability of the single input-preparation wire authority. */
export declare const AGENT_INPUT_PREPARATION_CAPABILITY: "agent-input-preparation-v9";
/**
 * Sealed payload v1 (#654). A device advertises it before a Host may send it
 * a sealed offer or steer; a server advertises it before a device may send it
 * sealed task output or a sealed decline code. Both gates read
 * `WIRE_ADDITIONS`.
 */
export declare const SEALED_PAYLOAD_CAPABILITY: 'sealed-payload-v1';
/**
 * A server advertises it before a device may send a sealed task output that
 * names its ciphertext blob (`sealed.ciphertextRef`) instead of carrying it
 * inline. The server then holds the blob for the life of the task.
 */
export declare const SEALED_OUTPUT_CIPHERTEXT_REF_CAPABILITY: 'sealed-output-ciphertext-ref';
/**
 * A server advertises it before a device may send `task.fail.failure`, the
 * machine-readable runtime failure class (#869).
 */
export declare const RUNTIME_FAILURE_CLASS_CAPABILITY: 'runtime-failure-class';
/**
 * The closed classes of `task.fail.failure.class`: the vendored OAR
 * `FailureClass` values. `unknown` means the runtime gave no structured
 * evidence. Single value authority shared by schema validation and
 * schema-free consumers.
 */
export declare const RUNTIME_FAILURE_CLASSES: readonly ['auth', 'quota', 'rate_limited', 'billing', 'model_unavailable', 'input_too_large', 'invalid_request', 'overloaded', 'provider', 'runtime_exited', 'limit_reached', 'output_schema', 'unknown'];
/** Single value authority shared by schema validation and schema-free consumers. */
export declare const PREPARED_AGENT_MEMORY_MODES: readonly ['none', 'read', 'read-write'];
export declare function isPreparedAgentMemoryMode(value: unknown): value is (typeof PREPARED_AGENT_MEMORY_MODES)[number];
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
 * string or raw bytes (e.g. a binary transport frame) — isomorphic, no
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
    'task.offer_prepared': {
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
    'agent.message.draft': {
        taskId: string;
        seq?: number;
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
    'agent.input.preparation': {
        taskId?: never;
        seq: number;
    };
    'provider.provisioning.available': {
        taskId?: never;
        seq: number;
    };
    'agent.memory.intent.available': {
        taskId?: never;
        seq: number;
    };
    'e2ee.key_package.available': {
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
    'task.offer_for_agent_sealed': {
        taskId: string;
        seq: number;
    };
    'task.offer_for_agent_with_egress_sealed': {
        taskId: string;
        seq: number;
    };
    'task.offer_for_agent_with_egress_fresh_sealed': {
        taskId: string;
        seq: number;
    };
    'task.steer_sealed': {
        taskId: string;
        seq: number;
    };
    'task.complete_sealed': {
        taskId: string;
        seq?: number;
    };
    'task.fail_sealed': {
        taskId: string;
        seq?: number;
    };
    'task.decline_sealed': {
        taskId: string;
        seq?: number;
    };
    'task.cancelled_sealed': {
        taskId: string;
        seq?: number;
    };
    'task.progress_sealed': {
        taskId: string;
        seq?: number;
    };
    'task.artifact_sealed': {
        taskId: string;
        seq?: number;
    };
    'task.await_approval_sealed': {
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
// ==== @byok-sdk/protocol dist/constants.d.ts ====
/** Schema-free protocol values. Import this entry when runtime schemas are unnecessary. */
export * from './version';
export * from './task-state';
export * from './capability-constants';
/** Maximum raw UTF-8 content bytes in one local Host Agent-memory export; no truncation. */
export declare const AGENT_MEMORY_MAX_SNAPSHOT_BYTES: number;
/** Maximum memory files in one local Host export, including MEMORY.md. */
export declare const AGENT_MEMORY_MAX_SNAPSHOT_FILES = 128;
/** The frozen wire runtime ids. Any other adapter id is a custom harness (`harnessId`). */
export declare const RUNTIME_IDS: readonly ["pi", "claude", "codex"];
// ==== @byok-sdk/protocol dist/e2ee-member.d.ts ====
/**
 * Member keys, the member chain and scope key packages as the Host stores
 * them (#654 design §7.2–§7.4, E2c).
 *
 * The Host checks shapes only. It never hashes an entry or verifies a
 * signature: members walk the chain themselves (§7.3), so a Host check adds
 * no trust. `@byok-sdk/core/sealed-payload` creates and verifies these values.
 * Protocol does not depend on core, so this module repeats core's shape
 * rules; a cross-package test in `@byok-sdk/cloud` keeps the two equal.
 */
import { z } from 'zod';
/** The most chain entries one append accepts. */
export declare const E2EE_MEMBER_CHAIN_APPEND_MAX_ENTRIES = 64;
/** The largest canonical JSON entry, in UTF-8 bytes. */
export declare const E2EE_MEMBER_CHAIN_ENTRY_MAX_BYTES = 65536;
/** The most chain entries one read returns. */
export declare const E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES = 256;
/** The most scope key packages one put accepts. */
export declare const E2EE_SCOPE_KEY_PACKAGE_PUT_MAX = 256;
/** The most packages one paged device read returns. */
export declare const E2EE_SCOPE_KEY_PACKAGE_PAGE_MAX = 16;
/**
 * The longest scope id, in UTF-16 code units, as for other opaque Host ids.
 * Core sets no maximum, so the scope key package shape (which the parity test
 * compares with core) leaves it out, and the Host checks it on every put and
 * read. The key package notice is Host-built wire, so its schema carries it.
 */
export declare const E2EE_SCOPE_ID_MAX_LENGTH = 512;
/** Register the device's member key bundle and its device pairing MAC (§7.2 step 3). */
export declare const E2EE_MEMBER_KEY_REGISTER_OPERATION: 'e2ee-member-key.register';
/** Append member chain entries. */
export declare const E2EE_MEMBER_CHAIN_APPEND_OPERATION: 'e2ee-member-chain.append';
/** Put scope key packages. */
export declare const E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION: 'e2ee-scope-key-package.put';
/** A member's public key bundle. A device member names its SDK device id; a client member has none. */
export declare const E2eeMemberKeyBundleSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    memberId: z.ZodString;
    signingPublicJwk: z.ZodObject<{
        kty: z.ZodLiteral<"EC">;
        crv: z.ZodLiteral<"P-256">;
        x: z.ZodString;
        y: z.ZodString;
    }, z.core.$strict>;
    kemPublicJwk: z.ZodObject<{
        kty: z.ZodLiteral<"EC">;
        crv: z.ZodLiteral<"P-256">;
        x: z.ZodString;
        y: z.ZodString;
    }, z.core.$strict>;
    kemEpoch: z.ZodNumber;
    kemSig: z.ZodString;
    deviceId: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type E2eeMemberKeyBundle = z.infer<typeof E2eeMemberKeyBundleSchema>;
export declare const E2EE_MEMBER_CHAIN_OPS: readonly ['add', 'remove', 'rotate', 'scope-policy', 'shred'];
/**
 * One signed member chain entry. `subject` must be a JSON object; the Host
 * stores the entry as canonical JSON, which refuses any value outside JSON.
 * A `shred` subject must also be exactly `{ scopeId }`.
 */
export declare const E2eeMemberChainEntrySchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    tenantId: z.ZodString;
    seq: z.ZodNumber;
    prev: z.ZodUnion<readonly [z.ZodNull, z.ZodString]>;
    op: z.ZodEnum<{
        add: "add";
        remove: "remove";
        rotate: "rotate";
        "scope-policy": "scope-policy";
        shred: "shred";
    }>;
    subject: z.ZodCustom<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>>;
    signer: z.ZodString;
    sig: z.ZodString;
}, z.core.$strict>;
export type E2eeMemberChainEntry = z.infer<typeof E2eeMemberChainEntrySchema>;
/** One scope key wrapped to one member's KEM key of `recipientKemEpoch` (§7.4, §77a). A put takes version 2 only. */
export declare const E2eeScopeKeyPackageV2Schema: z.ZodObject<{
    tenantId: z.ZodString;
    scopeId: z.ZodString;
    epoch: z.ZodNumber;
    keyId: z.ZodString;
    recipient: z.ZodString;
    sender: z.ZodString;
    enc: z.ZodString;
    ciphertext: z.ZodString;
    sig: z.ZodString;
    v: z.ZodLiteral<2>;
    recipientKemEpoch: z.ZodNumber;
}, z.core.$strict>;
/** A stored package as a read returns it: version 1 from before `e2ee.member.kem-epoch`, version 2 after. */
export declare const E2eeScopeKeyPackageSchema: z.ZodUnion<readonly [z.ZodObject<{
    v: z.ZodLiteral<1>;
    tenantId: z.ZodString;
    scopeId: z.ZodString;
    epoch: z.ZodNumber;
    keyId: z.ZodString;
    recipient: z.ZodString;
    sender: z.ZodString;
    enc: z.ZodString;
    ciphertext: z.ZodString;
    sig: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    tenantId: z.ZodString;
    scopeId: z.ZodString;
    epoch: z.ZodNumber;
    keyId: z.ZodString;
    recipient: z.ZodString;
    sender: z.ZodString;
    enc: z.ZodString;
    ciphertext: z.ZodString;
    sig: z.ZodString;
    v: z.ZodLiteral<2>;
    recipientKemEpoch: z.ZodNumber;
}, z.core.$strict>]>;
export type E2eeScopeKeyPackage = z.infer<typeof E2eeScopeKeyPackageSchema>;
/** A pairing MAC (§7.2 steps 3 and 4): HMAC-SHA-256 under `pv`, which the Host never holds. */
export declare const E2eePairingMacSchema: z.ZodString;
/**
 * The device registration body. `member` is the device's own bundle, so it
 * names the device id; `mac` is the device pairing MAC over it under `pv`.
 */
export declare const E2eeMemberKeyRegisterRequestSchema: z.ZodObject<{
    member: z.ZodObject<{
        v: z.ZodLiteral<1>;
        memberId: z.ZodString;
        signingPublicJwk: z.ZodObject<{
            kty: z.ZodLiteral<"EC">;
            crv: z.ZodLiteral<"P-256">;
            x: z.ZodString;
            y: z.ZodString;
        }, z.core.$strict>;
        kemPublicJwk: z.ZodObject<{
            kty: z.ZodLiteral<"EC">;
            crv: z.ZodLiteral<"P-256">;
            x: z.ZodString;
            y: z.ZodString;
        }, z.core.$strict>;
        kemEpoch: z.ZodNumber;
        kemSig: z.ZodString;
        deviceId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    mac: z.ZodString;
}, z.core.$strict>;
export type E2eeMemberKeyRegisterRequest = z.infer<typeof E2eeMemberKeyRegisterRequestSchema>;
/** What the client relays to the device in pairing step 4. The client member has no device id. */
export declare const E2eeClientPairingMacSchema: z.ZodObject<{
    mac: z.ZodString;
    member: z.ZodObject<{
        v: z.ZodLiteral<1>;
        memberId: z.ZodString;
        signingPublicJwk: z.ZodObject<{
            kty: z.ZodLiteral<"EC">;
            crv: z.ZodLiteral<"P-256">;
            x: z.ZodString;
            y: z.ZodString;
        }, z.core.$strict>;
        kemPublicJwk: z.ZodObject<{
            kty: z.ZodLiteral<"EC">;
            crv: z.ZodLiteral<"P-256">;
            x: z.ZodString;
            y: z.ZodString;
        }, z.core.$strict>;
        kemEpoch: z.ZodNumber;
        kemSig: z.ZodString;
        deviceId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    chainHead: z.ZodObject<{
        seq: z.ZodNumber;
        hash: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type E2eeClientPairingMac = z.infer<typeof E2eeClientPairingMacSchema>;
/**
 * Server -> daemon `e2ee.key_package.available` (E2c-3): the Host stored a
 * scope key package for this device's member. The payload names only the
 * scope epoch; the device fetches the package from its device route (§7.4,
 * notice-and-fetch), so a mailbox row never holds key material. Gated by
 * `sealed-payload-v1`.
 */
export declare const E2eeKeyPackageAvailablePayloadSchema: z.ZodObject<{
    scopeId: z.ZodString;
    epoch: z.ZodNumber;
}, z.core.$strict>;
export type E2eeKeyPackageAvailablePayload = z.infer<typeof E2eeKeyPackageAvailablePayloadSchema>;
// ==== @byok-sdk/protocol dist/envelope.d.ts ====
import { z } from 'zod';
import { MESSAGE_PAYLOAD_SCHEMAS, type MessageType } from './messages';
/**
 * The schema `envelopeShape` returns, written out so declaration emit names
 * each branch of `EnvelopeSchema` instead of copying every payload type.
 * Type-only: it must stay equal to the inferred `z.object` type below.
 */
type EnvelopeShape<T extends MessageType, TaskId extends z.ZodTypeAny, Seq extends z.ZodTypeAny> = z.ZodObject<{
    v: z.ZodNumber;
    id: z.ZodUUID;
    ts: z.ZodISODateTime;
    type: z.ZodLiteral<T>;
    task_id: TaskId;
    session_ref: z.ZodOptional<z.ZodString>;
    seq: Seq;
    payload: (typeof MESSAGE_PAYLOAD_SCHEMAS)[T];
}, z.core.$strip>;
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
export declare const EnvelopeSchema: z.ZodDiscriminatedUnion<[EnvelopeShape<"conn.hello", z.ZodOptional<z.ZodString>, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.offer_for_agent", z.ZodString, z.ZodNumber>, EnvelopeShape<"task.offer_for_agent_with_egress", z.ZodString, z.ZodNumber>, EnvelopeShape<"task.offer_for_agent_with_egress_fresh", z.ZodString, z.ZodNumber>, EnvelopeShape<"task.offer_prepared", z.ZodString, z.ZodNumber>, EnvelopeShape<"agent.egress.ack", z.ZodOptional<z.ZodString>, z.ZodNumber>, EnvelopeShape<"agent.message.disposition", z.ZodString, z.ZodNumber>, EnvelopeShape<"agent.content.read", z.ZodOptional<z.ZodString>, z.ZodNumber>, EnvelopeShape<"agent.home.projection", z.ZodOptional<z.ZodNever>, z.ZodNumber>, EnvelopeShape<"agent.input.preparation", z.ZodOptional<z.ZodNever>, z.ZodNumber>, EnvelopeShape<"provider.provisioning.available", z.ZodOptional<z.ZodNever>, z.ZodNumber>, EnvelopeShape<"agent.memory.intent.available", z.ZodOptional<z.ZodNever>, z.ZodNumber>, EnvelopeShape<"task.approve", z.ZodString, z.ZodNumber>, EnvelopeShape<"task.reject", z.ZodString, z.ZodNumber>, EnvelopeShape<"task.cancel", z.ZodString, z.ZodNumber>, EnvelopeShape<"task.steer", z.ZodString, z.ZodNumber>, EnvelopeShape<"task.claim", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.started", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.decline", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.progress", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.artifact", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.await_approval", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.complete", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.fail", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.cancelled", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.approval_resolved", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"agent.egress.reliable", z.ZodOptional<z.ZodString>, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"agent.message.draft", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"agent.message.publish", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"agent.content.receipt", z.ZodOptional<z.ZodString>, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.offer_for_agent_sealed", z.ZodString, z.ZodNumber>, EnvelopeShape<"task.offer_for_agent_with_egress_sealed", z.ZodString, z.ZodNumber>, EnvelopeShape<"task.offer_for_agent_with_egress_fresh_sealed", z.ZodString, z.ZodNumber>, EnvelopeShape<"task.steer_sealed", z.ZodString, z.ZodNumber>, EnvelopeShape<"task.complete_sealed", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.fail_sealed", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.decline_sealed", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.cancelled_sealed", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.progress_sealed", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.artifact_sealed", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"task.await_approval_sealed", z.ZodString, z.ZodOptional<z.ZodNumber>>, EnvelopeShape<"e2ee.key_package.available", z.ZodOptional<z.ZodNever>, z.ZodNumber>], "type">;
export type Envelope = z.infer<typeof EnvelopeSchema>;
/** `true` for every message type the server sends to the daemon (envelope `seq` is required for these). */
export declare function isServerToDaemonType(type: MessageType): boolean;
export {};
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
import { EnvelopeSchema } from './envelope';
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
 * next `/byok/challenge`, `/byok/token`, or authenticated mailbox call gets a 401;
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
    afterSeq: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type EventsPollQuery = z.infer<typeof EventsPollQuerySchema>;
/**
 * Deployment-owned activity limits. A v3 responder advertises them on every
 * events page and on every answer whose `conn.hello` it accepted; there is no
 * client-side default.
 */
export declare const ActivityIngressSchema: z.ZodObject<{
    activityMaxEvents: z.ZodNumber;
    activityMaxBytes: z.ZodNumber;
}, z.core.$strip>;
export type ActivityIngress = z.infer<typeof ActivityIngressSchema>;
export declare const OUTBOUND_REFUSAL_REASONS: readonly ['payload_invalid', 'not_permitted', 'limit_exceeded', 'state_conflict', 'unsupported'];
/** `unknown` is an unrecognized wire reason string, kept as an observation. */
export type OutboundRefusalReason = typeof OUTBOUND_REFUSAL_REASONS[number] | 'unknown';
export declare const MessageSendOutcomeSchema: z.ZodObject<{
    id: z.ZodUUID;
    outcome: z.ZodEnum<{
        accepted: "accepted";
        duplicate: "duplicate";
        rejected: "rejected";
    }>;
    reason: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<"limit_exceeded" | "not_permitted" | "payload_invalid" | "state_conflict" | "unknown" | "unsupported", string>>>;
}, z.core.$strip>;
export type MessageSendOutcome = z.infer<typeof MessageSendOutcomeSchema>;
export declare const EventsPollResponseSchema: z.ZodObject<{
    events: z.ZodArray<z.ZodUnknown>;
    cursor: z.ZodNumber;
    capabilities: z.ZodArray<z.ZodString>;
    ingress: z.ZodObject<{
        activityMaxEvents: z.ZodNumber;
        activityMaxBytes: z.ZodNumber;
    }, z.core.$strip>;
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
/** Request body ceiling for `POST /byok/messages`; the cloud answers 413 above it, so the client chunks its drain by it. */
export declare const MESSAGES_SEND_MAX_BODY_BYTES: number;
/** Annotated so declaration emit names `EnvelopeSchema` instead of copying it. Type-only. */
export declare const MessagesSendRequestSchema: z.ZodObject<{
    messages: z.ZodArray<typeof EnvelopeSchema>;
}, z.core.$strip>;
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
export declare const MessagesSendResponseSchema: z.ZodObject<{
    accepted: z.ZodNumber;
    rejected: z.ZodOptional<z.ZodNumber>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    ingress: z.ZodOptional<z.ZodObject<{
        activityMaxEvents: z.ZodNumber;
        activityMaxBytes: z.ZodNumber;
    }, z.core.$strip>>;
    outcomes: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        outcome: z.ZodEnum<{
            accepted: "accepted";
            duplicate: "duplicate";
            rejected: "rejected";
        }>;
        reason: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<"limit_exceeded" | "not_permitted" | "payload_invalid" | "state_conflict" | "unknown" | "unsupported", string>>>;
    }, z.core.$strip>>;
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
export declare const InputPreparationCompletionRequestSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    outcome: z.ZodLiteral<"prepared">;
    requestId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    profileId: z.ZodString;
    policyRevision: z.ZodString;
    receipt: z.ZodObject<{
        reference: z.ZodString;
        state: z.ZodEnum<{
            cancelled: "cancelled";
            counter_interrupted: "counter_interrupted";
            counting: "counting";
            failed: "failed";
            prepared: "prepared";
            reserved: "reserved";
        }>;
        binding: z.ZodObject<{
            terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"none">;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"result-document">;
                contract: z.ZodString;
                schema: z.ZodCustom<import("./result-schema").ResultSchema, import("./result-schema").ResultSchema>;
            }, z.core.$strict>], "mode">>;
            agentMemory: z.ZodEnum<{
                none: "none";
                read: "read";
                "read-write": "read-write";
            }>;
            scopeId: z.ZodString;
            deviceId: z.ZodString;
            agentRef: z.ZodString;
            profileId: z.ZodString;
            profileRevision: z.ZodString;
            source: z.ZodObject<{
                revision: z.ZodString;
                digest: z.ZodString;
            }, z.core.$strict>;
            target: z.ZodObject<{
                endpoint: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>;
            policyRevision: z.ZodString;
            runtime: z.ZodObject<{
                packageName: z.ZodString;
                packageVersion: z.ZodString;
                tarballIntegrity: z.ZodString;
                provenanceDigest: z.ZodString;
                closureDigest: z.ZodString;
                upstreamCommit: z.ZodString;
                envelopeFormat: z.ZodString;
                requestFormat: z.ZodString;
                compilerVersion: z.ZodNumber;
            }, z.core.$strict>;
            requestDigest: z.ZodString;
            accountingPolicyRef: z.ZodOptional<z.ZodObject<{
                revision: z.ZodString;
                ruledRuntime: z.ZodString;
                ruledTarget: z.ZodObject<{
                    endpoint: z.ZodString;
                    modelId: z.ZodString;
                }, z.core.$strict>;
                ruledResidualKeys: z.ZodArray<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        artifact: z.ZodOptional<z.ZodObject<{
            requestDigest: z.ZodString;
            envelopeDigest: z.ZodString;
            toolManifestDigest: z.ZodString;
            requestBytes: z.ZodNumber;
            projectionBytes: z.ZodNumber;
            projection: z.ZodObject<{
                version: z.ZodLiteral<3>;
                kind: z.ZodEnum<{
                    content_complete: "content_complete";
                    unknown: "unknown";
                }>;
                digest: z.ZodString;
            }, z.core.$strict>;
            residual: z.ZodArray<z.ZodObject<{
                key: z.ZodString;
                valueClass: z.ZodEnum<{
                    boolean: "boolean";
                    bounded_integer: "bounded_integer";
                    bounded_number: "bounded_number";
                    closed_enum: "closed_enum";
                    constant: "constant";
                    finite_number: "finite_number";
                    nonempty_string: "nonempty_string";
                    object_shape: "object_shape";
                }>;
            }, z.core.$strict>>;
            observationDigest: z.ZodString;
            toolBindingDigest: z.ZodString;
            toolNames: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        counter: z.ZodOptional<z.ZodObject<{
            method: z.ZodString;
            methodVersion: z.ZodString;
            authority: z.ZodEnum<{
                provider: "provider";
                test_fixture: "test_fixture";
            }>;
            value: z.ZodNumber;
            coverage: z.ZodObject<{
                covered: z.ZodBoolean;
                reason: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
            providerEvidence: z.ZodObject<{
                projectionDigest: z.ZodString;
                endpoint: z.ZodString;
                modelId: z.ZodString;
                asserted: z.ZodObject<{
                    httpStatus: z.ZodNumber;
                    usageFields: z.ZodRecord<z.ZodString, z.ZodNumber>;
                    responseDigest: z.ZodString;
                }, z.core.$strict>;
            }, z.core.$strict>;
            target: z.ZodObject<{
                endpoint: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>;
            calledAt: z.ZodISODateTime;
            completedAt: z.ZodISODateTime;
        }, z.core.$strict>>;
        ready: z.ZodBoolean;
        readinessReasons: z.ZodArray<z.ZodEnum<{
            accounting_policy_inapplicable: "accounting_policy_inapplicable";
            accounting_policy_missing: "accounting_policy_missing";
            artifact_expired: "artifact_expired";
            cancelled: "cancelled";
            counter_authority_not_production: "counter_authority_not_production";
            counter_coverage_incomplete: "counter_coverage_incomplete";
            counter_interrupted: "counter_interrupted";
            failed: "failed";
            not_prepared: "not_prepared";
            projection_unknown: "projection_unknown";
            request_content_not_text: "request_content_not_text";
            residual_not_ruled: "residual_not_ruled";
            runtime_contract_superseded: "runtime_contract_superseded";
        }>>;
        detail: z.ZodOptional<z.ZodString>;
        artifactExpiresAt: z.ZodISODateTime;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    outcome: z.ZodLiteral<"rejected">;
    requestId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    profileId: z.ZodString;
    policyRevision: z.ZodString;
    reason: z.ZodEnum<{
        authority_unavailable: "authority_unavailable";
        bad_request: "bad_request";
        cancelled: "cancelled";
        context_hash_mismatch: "context_hash_mismatch";
        context_unresolvable: "context_unresolvable";
        counter_interrupted: "counter_interrupted";
        counter_unavailable: "counter_unavailable";
        deadline_elapsed: "deadline_elapsed";
        durable_write_failed: "durable_write_failed";
        input_preparation_record_log_unsupported: "input_preparation_record_log_unsupported";
        input_preparation_unconfigured: "input_preparation_unconfigured";
        limit_exceeded: "limit_exceeded";
        not_found: "not_found";
        observation_drift: "observation_drift";
        policy_revision_mismatch: "policy_revision_mismatch";
        request_conflict: "request_conflict";
        rpc_frame_too_large: "rpc_frame_too_large";
        runtime_identity_unavailable: "runtime_identity_unavailable";
        scope_denied: "scope_denied";
        toolsets_unobservable: "toolsets_unobservable";
        unsupported_input: "unsupported_input";
    }>;
}, z.core.$strict>], "outcome">;
export type InputPreparationCompletionRequest = z.infer<typeof InputPreparationCompletionRequestSchema>;
/** `pending` until the device records a terminal fact; the other two are terminal. */
export declare const InputPreparationStatusSchema: z.ZodEnum<{
    pending: "pending";
    prepared: "prepared";
    rejected: "rejected";
}>;
export type InputPreparationStatus = z.infer<typeof InputPreparationStatusSchema>;
/**
 * Tenant/device/request-bound durable readback. `receipt` and `reason` are
 * present only on their own terminal status, never together and never on
 * `pending`.
 */
export declare const InputPreparationReadbackSchema: z.ZodObject<{
    tenantId: z.ZodString;
    deviceId: z.ZodString;
    requestId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    profileId: z.ZodString;
    policyRevision: z.ZodString;
    status: z.ZodEnum<{
        pending: "pending";
        prepared: "prepared";
        rejected: "rejected";
    }>;
    receipt: z.ZodOptional<z.ZodObject<{
        reference: z.ZodString;
        state: z.ZodEnum<{
            cancelled: "cancelled";
            counter_interrupted: "counter_interrupted";
            counting: "counting";
            failed: "failed";
            prepared: "prepared";
            reserved: "reserved";
        }>;
        binding: z.ZodObject<{
            terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"none">;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"result-document">;
                contract: z.ZodString;
                schema: z.ZodCustom<import("./result-schema").ResultSchema, import("./result-schema").ResultSchema>;
            }, z.core.$strict>], "mode">>;
            agentMemory: z.ZodEnum<{
                none: "none";
                read: "read";
                "read-write": "read-write";
            }>;
            scopeId: z.ZodString;
            deviceId: z.ZodString;
            agentRef: z.ZodString;
            profileId: z.ZodString;
            profileRevision: z.ZodString;
            source: z.ZodObject<{
                revision: z.ZodString;
                digest: z.ZodString;
            }, z.core.$strict>;
            target: z.ZodObject<{
                endpoint: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>;
            policyRevision: z.ZodString;
            runtime: z.ZodObject<{
                packageName: z.ZodString;
                packageVersion: z.ZodString;
                tarballIntegrity: z.ZodString;
                provenanceDigest: z.ZodString;
                closureDigest: z.ZodString;
                upstreamCommit: z.ZodString;
                envelopeFormat: z.ZodString;
                requestFormat: z.ZodString;
                compilerVersion: z.ZodNumber;
            }, z.core.$strict>;
            requestDigest: z.ZodString;
            accountingPolicyRef: z.ZodOptional<z.ZodObject<{
                revision: z.ZodString;
                ruledRuntime: z.ZodString;
                ruledTarget: z.ZodObject<{
                    endpoint: z.ZodString;
                    modelId: z.ZodString;
                }, z.core.$strict>;
                ruledResidualKeys: z.ZodArray<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        artifact: z.ZodOptional<z.ZodObject<{
            requestDigest: z.ZodString;
            envelopeDigest: z.ZodString;
            toolManifestDigest: z.ZodString;
            requestBytes: z.ZodNumber;
            projectionBytes: z.ZodNumber;
            projection: z.ZodObject<{
                version: z.ZodLiteral<3>;
                kind: z.ZodEnum<{
                    content_complete: "content_complete";
                    unknown: "unknown";
                }>;
                digest: z.ZodString;
            }, z.core.$strict>;
            residual: z.ZodArray<z.ZodObject<{
                key: z.ZodString;
                valueClass: z.ZodEnum<{
                    boolean: "boolean";
                    bounded_integer: "bounded_integer";
                    bounded_number: "bounded_number";
                    closed_enum: "closed_enum";
                    constant: "constant";
                    finite_number: "finite_number";
                    nonempty_string: "nonempty_string";
                    object_shape: "object_shape";
                }>;
            }, z.core.$strict>>;
            observationDigest: z.ZodString;
            toolBindingDigest: z.ZodString;
            toolNames: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        counter: z.ZodOptional<z.ZodObject<{
            method: z.ZodString;
            methodVersion: z.ZodString;
            authority: z.ZodEnum<{
                provider: "provider";
                test_fixture: "test_fixture";
            }>;
            value: z.ZodNumber;
            coverage: z.ZodObject<{
                covered: z.ZodBoolean;
                reason: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
            providerEvidence: z.ZodObject<{
                projectionDigest: z.ZodString;
                endpoint: z.ZodString;
                modelId: z.ZodString;
                asserted: z.ZodObject<{
                    httpStatus: z.ZodNumber;
                    usageFields: z.ZodRecord<z.ZodString, z.ZodNumber>;
                    responseDigest: z.ZodString;
                }, z.core.$strict>;
            }, z.core.$strict>;
            target: z.ZodObject<{
                endpoint: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>;
            calledAt: z.ZodISODateTime;
            completedAt: z.ZodISODateTime;
        }, z.core.$strict>>;
        ready: z.ZodBoolean;
        readinessReasons: z.ZodArray<z.ZodEnum<{
            accounting_policy_inapplicable: "accounting_policy_inapplicable";
            accounting_policy_missing: "accounting_policy_missing";
            artifact_expired: "artifact_expired";
            cancelled: "cancelled";
            counter_authority_not_production: "counter_authority_not_production";
            counter_coverage_incomplete: "counter_coverage_incomplete";
            counter_interrupted: "counter_interrupted";
            failed: "failed";
            not_prepared: "not_prepared";
            projection_unknown: "projection_unknown";
            request_content_not_text: "request_content_not_text";
            residual_not_ruled: "residual_not_ruled";
            runtime_contract_superseded: "runtime_contract_superseded";
        }>>;
        detail: z.ZodOptional<z.ZodString>;
        artifactExpiresAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    reason: z.ZodOptional<z.ZodEnum<{
        authority_unavailable: "authority_unavailable";
        bad_request: "bad_request";
        cancelled: "cancelled";
        context_hash_mismatch: "context_hash_mismatch";
        context_unresolvable: "context_unresolvable";
        counter_interrupted: "counter_interrupted";
        counter_unavailable: "counter_unavailable";
        deadline_elapsed: "deadline_elapsed";
        durable_write_failed: "durable_write_failed";
        input_preparation_record_log_unsupported: "input_preparation_record_log_unsupported";
        input_preparation_unconfigured: "input_preparation_unconfigured";
        limit_exceeded: "limit_exceeded";
        not_found: "not_found";
        observation_drift: "observation_drift";
        policy_revision_mismatch: "policy_revision_mismatch";
        request_conflict: "request_conflict";
        rpc_frame_too_large: "rpc_frame_too_large";
        runtime_identity_unavailable: "runtime_identity_unavailable";
        scope_denied: "scope_denied";
        toolsets_unobservable: "toolsets_unobservable";
        unsupported_input: "unsupported_input";
    }>>;
    completedAt: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strict>;
export type InputPreparationReadback = z.infer<typeof InputPreparationReadbackSchema>;
/**
 * Query identity for the status GET. The request key is
 * `(deviceId, agentRef, requestId)`; `deviceId` comes from bearer auth, the
 * path carries `requestId`, so only the AgentRef halves travel as query
 * parameters.
 */
export declare const InputPreparationStatusQuerySchema: z.ZodObject<{
    agentId: z.ZodString;
    profileRevision: z.ZodString;
}, z.core.$strict>;
export type InputPreparationStatusQuery = z.infer<typeof InputPreparationStatusQuerySchema>;
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
/** `PUT /byok/input-preparations/:requestId/completion` and `GET /byok/input-preparations/:requestId`. */
export declare const BYOK_INPUT_PREPARATIONS_PATH = "/byok/input-preparations";
export declare const BYOK_INPUT_PREPARATION_COMPLETION_ROUTE = "/byok/input-preparations/:requestId/completion";
export declare const BYOK_INPUT_PREPARATION_STATUS_ROUTE = "/byok/input-preparations/:requestId";
export declare function byokInputPreparationCompletionPath(requestId: string): string;
export declare function byokInputPreparationStatusPath(requestId: string): string;
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
/** `POST /byok/e2ee/member-key` — device proof: register the device's member key bundle and pairing MAC (#654). */
export declare const BYOK_E2EE_MEMBER_KEY_PATH = "/byok/e2ee/member-key";
/** `POST /byok/e2ee/chain` (device proof: append) and `GET` (device: read) — the member chain. */
export declare const BYOK_E2EE_CHAIN_PATH = "/byok/e2ee/chain";
/** `POST /byok/e2ee/key-packages` (device proof: put) and `GET` (device: this device's packages). */
export declare const BYOK_E2EE_KEY_PACKAGES_PATH = "/byok/e2ee/key-packages";
/** `GET /byok/e2ee/pairing-mac` — device: the client pairing MAC relayed to this device. */
export declare const BYOK_E2EE_PAIRING_MAC_PATH = "/byok/e2ee/pairing-mac";
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
export * from './constants';
export { MAILBOX_READ_AHEAD_MAX_SEQS, MAILBOX_READ_AHEAD_CAPABILITY } from './version';
export { PROTOCOL_VERSION, CAPABILITY_FLAGS, AGENT_HOME_READERS_CAPABILITY } from './version';
export type { CapabilityFlag } from './version';
export { WIRE_ADDITIONS, requiredReceiverCapabilities } from './wire-additions';
export type { WireAddition } from './wire-additions';
export { BlobRefSchema, CONTENT_HASH_RE } from './blob';
export type { BlobRef } from './blob';
export { SEALED_DECLINE_CODES, SEALED_INLINE_MAX_PADDED_LENGTH, SEALED_PAYLOAD_CATEGORIES, SEALED_PAYLOAD_MAX_CONTENT_LENGTH, SEALED_PAYLOAD_MAX_PADDED_LENGTH, SEALED_PAYLOAD_SUITE, SEALED_PAYLOAD_V1_CATEGORIES, SEALED_PAYLOAD_VERSION, SEALED_SPLIT_TABLE, SEALED_TASK_PLAIN_CODES, SealedPayloadSchema, SealedTaskInputSchema, SealedTaskOutputSchema, TaskSealingSchema, isSealedMessageType, isSealedTaskPlainOutput, sealedBase64UrlByteLength, sealedPayloadPaddedLength, } from './sealed-payload';
export type { SealedDeclineCode, SealedDigestRule, SealedMessageType, SealedPayload, SealedPayloadCategory, SealedPayloadV1Category, SealedSplitEntry, TaskSealing, } from './sealed-payload';
export { PROVIDER_MODEL_CAPABILITIES, ProviderProfileRefSchema, ProviderProfileRevisionSchema, ProviderProfileHashSchema, ProviderModelCapabilitySchema, ProviderProfileBindingSchema, } from './provider-profile-binding';
export type { ProviderProfileRef, ProviderProfileRevision, ProviderProfileHash, ProviderModelCapability, ProviderProfileBinding, } from './provider-profile-binding';
export { PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION, PROVIDER_PROVISIONING_OPERATIONS, PROVIDER_PROVISIONING_OPERATION_GENERATION_MAXIMUM, PROVIDER_PROVISIONING_REJECTION_CODES, PROVIDER_PROVISIONING_HOST_TERMINAL_CODES, PROVIDER_PROVISIONING_DISPOSITIONS, PROVIDER_PROVISIONING_KEY_CHECK_RESULTS, ProviderProvisioningAvailablePayloadSchema, ProviderProvisioningKeyCheckResultSchema, ProviderProvisioningKeyCheckSchema, ProviderProvisioningOperationSchema, ProviderProvisioningOperationGenerationSchema, ProviderProvisioningOperationDigestSchema, ProviderProvisioningRejectionCodeSchema, ProviderProvisioningProviderStatusSchema, ProviderProvisioningCompletionSchema, ProviderProvisioningDispositionSchema, ProviderProvisioningReadbackSchema, } from './provider-provisioning';
export type { ProviderProvisioningAvailablePayload, ProviderProvisioningOperation, ProviderProvisioningOperationGeneration, ProviderProvisioningOperationDigest, ProviderProvisioningRejectionCode, ProviderProvisioningProviderStatus, ProviderProvisioningCompletion, ProviderProvisioningDisposition, ProviderProvisioningReadback, ProviderProvisioningKeyCheckResult, ProviderProvisioningKeyCheck, } from './provider-provisioning';
export { AGENT_MEMORY_INTENT_CONTENT_MAX_BYTES, AGENT_MEMORY_INTENT_PATH_MAX_BYTES, AGENT_MEMORY_INTENT_APPROVAL_REF_MAX_BYTES, AGENT_MEMORY_INTENT_OPERATIONS, AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES, AGENT_MEMORY_INTENT_REJECTION_CODES, AGENT_MEMORY_INTENT_READBACK_DISPOSITIONS, AGENT_MEMORY_INTENT_RESERVATIONS, AGENT_MEMORY_INTENT_FETCH_DISPOSITIONS, AGENT_MEMORY_INTENT_FETCH_DISPOSITIONS_BY_RESERVATION, AgentMemoryIntentRevisionSchema, AgentMemoryIntentOperationDigestSchema, AgentMemoryIntentPathSchema, AgentMemoryIntentApprovalRefSchema, AgentMemoryIntentContentSchema, AgentMemoryIntentOperationSchema, AgentMemoryIntentV1Schema, AgentMemoryIntentHostTerminalCodeSchema, AgentMemoryIntentRejectionCodeSchema, AgentMemoryIntentFileObservationSchema, AgentMemoryIntentCompletionSchema, AgentMemoryIntentReadbackDispositionSchema, AgentMemoryIntentReadbackSchema, AgentMemoryIntentReservationSchema, AgentMemoryIntentFetchRequestSchema, AgentMemoryIntentFetchResponseSchema, agentMemoryIntentFetchResponseSchemaFor, } from './agent-memory-intent';
export type { AgentMemoryIntentRevision, AgentMemoryIntentOperationDigest, AgentMemoryIntentPath, AgentMemoryIntentApprovalRef, AgentMemoryIntentContent, AgentMemoryIntentOperation, AgentMemoryIntentV1, AgentMemoryIntentHostTerminalCode, AgentMemoryIntentRejectionCode, AgentMemoryIntentFileObservation, AgentMemoryIntentCompletion, AgentMemoryIntentReadbackDisposition, AgentMemoryIntentReadback, AgentMemoryIntentReservation, AgentMemoryIntentFetchRequest, AgentMemoryIntentFetchDisposition, AgentMemoryIntentFetchResponse, } from './agent-memory-intent';
export { AgentEventSchema, AgentEventSpillSchema, AGENT_EVENT_SPILL_UNSTORED_REASON_MAX_LENGTH, UnknownAgentEventSchema, AgentEventOrUnknownSchema, KNOWN_AGENT_EVENT_TYPES, isKnownAgentEvent, partitionAgentEvents, } from './agent-event';
export type { AgentEvent, AgentEventSpill, UnknownAgentEvent, AgentEventOrUnknown } from './agent-event';
export { AgentEgressPolicySchema, AgentEgressActivityPolicySchema, AgentReliableQuotaPolicySchema, ContentReadPolicySchema, AgentEgressLaneSchema, AgentEgressDropReasonSchema, AgentContentReadSurfaceSchema, AgentContentActorKindSchema, AgentContentActorSchema, AgentContentDecodeAsSchema, AgentContentMimeTypeSchema, AgentContentReadDecisionSchema, AgentContentReadDenialReasonSchema, AgentEgressContentHashSchema, AgentEgressPolicyRevisionSchema, AgentMessageContractSchema, AgentMessageContentTypeSchema, AgentMessageDestinationBindingSchema, AgentMessageFreshnessCursorSchema, AgentMessageServerContextSchema, AgentMessageEgressRequirementSchema, AGENT_MESSAGE_MAX_BYTES, AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES, } from './agent-egress';
export type { AgentEgressPolicy, AgentEgressActivityPolicy, AgentReliableQuotaPolicy, ContentReadPolicy, AgentEgressLane, AgentEgressDropReason, AgentMessageContentType, AgentMessageEgressRequirement, AgentMessageServerContext, AgentContentReadSurface, AgentContentActorKind, AgentContentActor, AgentContentDecodeAs, AgentContentReadDecision, AgentContentReadDenialReason, } from './agent-egress';
export { AGENT_HOME_PROJECTION_MAX_BYTES, AGENT_HOME_PROJECTION_PROFILE_REVISION_MAXIMUM, AgentHomeProjectionProfileRevisionSchema, AgentHomeProjectionHashSchema, AgentHomeProjectionOutcomeSchema, AgentHomeProjectionValueSchema, } from './agent-home-projection';
export type { AgentHomeProjectionProfileRevision, AgentHomeProjectionHash, AgentHomeProjectionOutcome, AgentHomeProjectionValue, } from './agent-home-projection';
export { InputPreparationContentHashSchema, InputPreparationPolicyRevisionSchema, InputPreparationProfileIdSchema, InputPreparationSourceSchema, InputPreparationModelCostSchema, InputPreparationModelSchema, InputPreparationOptionsSchema, InputPreparationSelectionSchema, InputPreparationPromptSnapshotSchema, InputPreparationUserMessageSchema, InputPreparationHostCanonicalAssistantMessageSchema, InputPreparationMessageSchema, InputPreparationContextDocumentSchema, InputPreparationStateSchema, InputPreparationReadinessReasonSchema, InputPreparationRuntimeIdentitySchema, InputPreparationCounterTargetSchema, InputPreparationAccountingPolicyRefSchema, InputPreparationCounterProviderEvidenceSchema, InputPreparationCounterEvidenceSchema, InputPreparationResidualValueClassSchema, InputPreparationResidualKeySchema, InputPreparationProjectionSchema, InputPreparationArtifactSummarySchema, InputPreparationBindingSchema, InputPreparationReceiptSummarySchema, InputPreparationReferenceSchema, InputPreparationOfferBindingSchema, InputPreparationRejectionReasonSchema, } from './input-preparation';
export type { InputPreparationSource, InputPreparationModel, InputPreparationOptions, InputPreparationSelection, InputPreparationMessage, InputPreparationContextDocument, InputPreparationState, InputPreparationReadinessReason, InputPreparationAccountingPolicyRef, InputPreparationResidualValueClass, InputPreparationRuntimeIdentity, InputPreparationReceiptSummary, InputPreparationOfferBinding, InputPreparationRejectionReason, } from './input-preparation';
export { AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES, AGENT_MEMORY_PROJECTION_MAX_ORDERING_VALUE, AgentMemoryProjectionGrantRefSchema, AgentMemoryProjectionSessionRefSchema, AgentMemoryProjectionWriterEpochSchema, AgentMemoryProjectionSourceSeqSchema, AgentMemoryProjectionSnapshotSchema, AgentMemoryProjectionMeteringReceiptSchema, AgentMemoryProjectionMutationSchema, AgentMemoryProjectionReceiptSchema, AgentMemoryProjectionEraseResultSchema, agentMemoryProjectionBase64UrlByteLength, } from './agent-memory-projection';
export type { AgentMemoryProjectionGrantRef, AgentMemoryProjectionSessionRef, AgentMemoryProjectionWriterEpoch, AgentMemoryProjectionSourceSeq, AgentMemoryProjectionSnapshot, AgentMemoryProjectionMeteringReceipt, AgentMemoryProjectionMutation, AgentMemoryProjectionReceipt, AgentMemoryProjectionEraseResult, } from './agent-memory-projection';
export { TerminalProjectionContractSchema, TerminalProjectionSelectionSchema, ResultDocumentSchemaSchema, } from './terminal-projection';
export type { TerminalProjectionSelection } from './terminal-projection';
export { RESULT_SCHEMA_MAX_BYTES, RESULT_OUTCOME_MAX_BYTES, RESULT_SCHEMA_MAX_DEPTH, RESULT_JSON_MAX_DEPTH, RESULT_ISSUES_MAX_COUNT, RESULT_ISSUES_MAX_BYTES, RESULT_SCHEMA_KEYWORDS, RESULT_SCHEMA_INSTANCE_TYPES, checkResultSchema, validateResultOutcome, } from './result-schema';
export type { ResultSchema, ResultSchemaKeyword, ResultSchemaInstanceType, ResultIssue, ResultDocumentFailureReason, ResultSchemaCheck, ResultOutcomeCheck, } from './result-schema';
export { TASK_STATES, TASK_TRANSITIONS, canTransition } from './task-state';
export type { TaskState } from './task-state';
export { MESSAGE_TYPES, TASK_OFFER_TYPES, isTaskOfferType, MESSAGE_PAYLOAD_SCHEMAS, SERVER_TO_DAEMON_TYPES, DAEMON_TO_SERVER_TYPES, RuntimeIdSchema, ProtocolVersionNumberSchema, RuntimeInfoSchema, HarnessIdSchema, HarnessInfoSchema, HarnessInventorySchema, RuntimeCapabilitiesSchema, AgentRefSchema, AgentHomeProjectionAgentRefSchema, AGENT_REF_MAX_BYTES, DispatchSelectionSchema, ToolsetIdSchema, ConfiguredToolsetsSchema, RequiredToolsetsSchema, CONFIGURED_TOOLSETS_MAX_ITEMS, ConnHelloPayloadSchema, AgentHomeAccessSchema, AgentMemorySelectionSchema, TaskOfferForAgentPayloadSchema, TaskOfferForAgentWithEgressPayloadSchema, TaskOfferForAgentWithEgressFreshPayloadSchema, TaskOfferPreparedPayloadSchema, AgentEgressReliablePayloadSchema, AgentEgressAckPayloadSchema, AgentMessagePublishPayloadSchema, AgentMessageDraftPayloadSchema, AgentMessageDispositionPayloadSchema, AgentContentReadPayloadSchema, AgentContentReceiptPayloadSchema, AgentHomeProjectionPayloadSchema, AgentMemoryIntentAvailablePayloadSchema, AgentInputPreparationPayloadSchema, TaskApprovePayloadSchema, TaskRejectPayloadSchema, TaskCancelPayloadSchema, TaskSteerPayloadSchema, TaskClaimPayloadSchema, TaskStartedPayloadSchema, TaskDeclinePayloadSchema, TaskProgressPayloadSchema, TaskArtifactPayloadSchema, TaskAwaitApprovalPayloadSchema, TaskCompletePayloadSchema, TaskFailPayloadSchema, RuntimeFailureClassSchema, TaskFailureSchema, TaskCancelledPayloadSchema, TaskApprovalResolvedPayloadSchema, RESULT_DOCUMENT_MAX_BYTES, checkResultDocument, TerminalInferenceUsageSchema, TerminalPreparedObservationSchema, TerminalAgentHomeProjectionSchema, TerminalAgentHomeMemoryChangeSchema, AGENT_HOME_MEMORY_DIGEST_MAX_FILES, AGENT_HOME_MEMORY_DIGEST_MAX_BYTES, AGENT_HOME_MEMORY_PATH_MAX_LENGTH, TERMINAL_INFERENCE_USAGE_MAX_TOKENS, TERMINAL_INFERENCE_USAGE_MAX_DURATION_MS, TERMINAL_INFERENCE_USAGE_PROVIDER_MAX_LENGTH, TERMINAL_INFERENCE_USAGE_MODEL_MAX_LENGTH, TERMINAL_INFERENCE_USAGE_CLIENT_VERSION_MAX_LENGTH, } from './messages';
export type { ResultDocumentCheck, MessageType, RuntimeId, RuntimeInfo, RuntimeCapabilities, AgentRef, AgentHomeProjectionAgentRef, DispatchSelection, ToolsetId, ConnHelloPayload, TaskOfferForAgentPayload, TaskOfferForAgentWithEgressPayload, TaskOfferForAgentWithEgressFreshPayload, TaskOfferPreparedPayload, TaskOfferForAgentSealedPayload, TaskOfferForAgentWithEgressSealedPayload, TaskOfferForAgentWithEgressFreshSealedPayload, TaskSteerSealedPayload, TaskCompleteSealedPayload, TaskFailSealedPayload, TaskDeclineSealedPayload, TaskCancelledSealedPayload, TaskProgressSealedPayload, TaskArtifactSealedPayload, TaskAwaitApprovalSealedPayload, AgentEgressReliablePayload, AgentEgressAckPayload, AgentMessagePublishPayload, AgentMessageDraftPayload, AgentMessageDispositionPayload, AgentContentReadPayload, AgentContentReceiptPayload, AgentHomeProjectionPayload, AgentMemoryIntentAvailablePayload, AgentInputPreparationPayload, TaskApprovePayload, TaskRejectPayload, TaskCancelPayload, TaskSteerPayload, TaskClaimPayload, TaskStartedPayload, TaskDeclinePayload, TaskProgressPayload, TaskArtifactPayload, TaskAwaitApprovalPayload, TaskCompletePayload, TaskFailPayload, RuntimeFailureClass, TaskFailure, TaskCancelledPayload, TaskApprovalResolvedPayload, TerminalInferenceUsage, TerminalPreparedObservation, TerminalAgentHomeProjection, TerminalAgentHomeMemoryChange, AgentHomeAccess, AgentMemorySelection, } from './messages';
export { EnvelopeSchema, isServerToDaemonType } from './envelope';
export type { Envelope } from './envelope';
export { ProtocolError, EnvelopeParseError, UnknownMessageTypeError, EnvelopeValidationError, } from './errors';
export { encodeEnvelope, decodeEnvelope, createEnvelope, parseMessage } from './codec';
export { WIRE_V3_TO_V4_TYPES, migrateWireV3Envelope, wireV4TypeOf } from './wire-v4-migration';
export type { WireV4MigrationRefusal, WireV4MigrationResult } from './wire-v4-migration';
export type { CreateEnvelopeOptions } from './codec';
export { PairRequestSchema, PairResponseTenantIdSchema, PAIR_RESPONSE_TENANT_ID_MAX_LENGTH, PairResponseSchema, ChallengeRequestSchema, ChallengeResponseSchema, TokenRequestSchema, TokenResponseSchema, PresencePublishRequestSchema, CreateBlobRequestSchema, CreateBlobResponseSchema, BlobDownloadUrlResponseSchema, EventsPollQuerySchema, ActivityIngressSchema, MessageSendOutcomeSchema, OUTBOUND_REFUSAL_REASONS, EventsPollResponseSchema, MessagesSendRequestSchema, MessagesSendResponseSchema, AgentHomeProjectionCompletionRequestSchema, AgentHomeProjectionStatusSchema, AgentHomeProjectionReadbackSchema, AgentMemoryProjectionCommitRequestSchema, AgentMemoryProjectionCommitResponseSchema, MAX_MESSAGES_PER_BATCH, MESSAGES_SEND_MAX_BODY_BYTES, BYOK_PAIR_PATH, BYOK_CHALLENGE_PATH, BYOK_TOKEN_PATH, BYOK_CAPABILITIES_PATH, BYOK_EVENTS_PATH, BYOK_MESSAGES_PATH, BYOK_AGENT_HOME_PROJECTIONS_PATH, BYOK_AGENT_HOME_PROJECTION_COMPLETION_ROUTE, byokAgentHomeProjectionCompletionPath, BYOK_AGENT_MEMORY_PROJECTIONS_PATH, BYOK_PRESENCE_PATH, BYOK_ACTIVITY_PATH, BYOK_BOARD_PATH, BYOK_BOARD_STREAM_PATH, BYOK_BOARD_CLAIM_ROUTE, BYOK_BOARD_UNCLAIM_ROUTE, BYOK_BOARD_STATUS_ROUTE, BYOK_RECORDS_PATH, BYOK_RECORD_ROUTE, byokRecordPath, BYOK_E2EE_MEMBER_KEY_PATH, BYOK_E2EE_CHAIN_PATH, BYOK_E2EE_KEY_PACKAGES_PATH, BYOK_E2EE_PAIRING_MAC_PATH, BYOK_SKILL_PACKS_PATH, BYOK_SKILL_PACK_FILE_ROUTE, byokSkillPackFilePath, BYOK_BLOBS_PATH, BYOK_BLOB_FINALIZE_ROUTE, BYOK_BLOB_URL_ROUTE, BYOK_BLOB_CONTENT_ROUTE, byokBlobFinalizePath, byokBlobUrlPath, byokBlobContentPath, BYOK_INPUT_PREPARATIONS_PATH, BYOK_INPUT_PREPARATION_COMPLETION_ROUTE, BYOK_INPUT_PREPARATION_STATUS_ROUTE, byokInputPreparationCompletionPath, byokInputPreparationStatusPath, InputPreparationCompletionRequestSchema, InputPreparationStatusSchema, InputPreparationReadbackSchema, InputPreparationStatusQuerySchema, } from './http-api';
export type { PairRequest, PairResponse, ChallengeRequest, ChallengeResponse, TokenRequest, TokenResponse, PresencePublishRequest, CreateBlobRequest, CreateBlobResponse, BlobDownloadUrlResponse, EventsPollQuery, ActivityIngress, MessageSendOutcome, OutboundRefusalReason, EventsPollResponse, MessagesSendRequest, MessagesSendResponse, AgentHomeProjectionCompletionRequest, AgentHomeProjectionStatus, AgentHomeProjectionReadback, AgentMemoryProjectionCommitRequest, AgentMemoryProjectionCommitResponse, InputPreparationCompletionRequest, InputPreparationStatus, InputPreparationReadback, InputPreparationStatusQuery, } from './http-api';
export type { TaskOfferType } from './messages';
export type { HarnessId, HarnessInfo } from './messages';
export { CUSTOM_HARNESS_CAPABILITY } from './version';
export { PreparedAgentMemoryModeSchema, type PreparedAgentMemoryMode } from './input-preparation';
export { E2EE_MEMBER_CHAIN_APPEND_MAX_ENTRIES, E2EE_MEMBER_CHAIN_APPEND_OPERATION, E2EE_MEMBER_CHAIN_ENTRY_MAX_BYTES, E2EE_MEMBER_CHAIN_OPS, E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES, E2EE_MEMBER_KEY_REGISTER_OPERATION, E2EE_SCOPE_ID_MAX_LENGTH, E2EE_SCOPE_KEY_PACKAGE_PAGE_MAX, E2EE_SCOPE_KEY_PACKAGE_PUT_MAX, E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION, E2eeClientPairingMacSchema, E2eeMemberChainEntrySchema, E2eeMemberKeyBundleSchema, E2eeMemberKeyRegisterRequestSchema, E2eeKeyPackageAvailablePayloadSchema, E2eePairingMacSchema, E2eeScopeKeyPackageSchema, E2eeScopeKeyPackageV2Schema, } from './e2ee-member';
export type { E2eeClientPairingMac, E2eeKeyPackageAvailablePayload, E2eeMemberChainEntry, E2eeMemberKeyBundle, E2eeMemberKeyRegisterRequest, E2eeScopeKeyPackage, } from './e2ee-member';
export * from './bot-turn-outcome';
export { resultOutcomeMaxBytes } from './result-schema';
// ==== @byok-sdk/protocol dist/input-preparation.d.ts ====
import { z } from 'zod';
/** The preparation surface uses the package-wide lowercase `sha256:<hex>` transport form. */
export declare const InputPreparationContentHashSchema: z.ZodString;
/**
 * The operator-assigned limits-policy revision a device must already hold. The
 * SDK compares it for exact equality and never negotiates it: a device whose
 * configured revision differs rejects rather than preparing under a policy the
 * caller believed was in force.
 */
export declare const InputPreparationPolicyRevisionSchema: z.ZodString;
/**
 * Host-owned Profile identity. It rides beside `agentRef` rather than inside
 * it because `AgentRefSchema` is the frozen generic Agent identity shared by
 * every other message, and widening that would be a breaking change to all of
 * them. The device never trusts this value directly — its configured local
 * authority resolver validates it against trusted local Profile records before
 * anything is compiled.
 */
export declare const InputPreparationProfileIdSchema: z.ZodString;
/** Explicit prepared SDK memory selection; never defaulted. */
export declare const PreparedAgentMemoryModeSchema: z.ZodEnum<{
    none: "none";
    read: "read";
    "read-write": "read-write";
}>;
export type PreparedAgentMemoryMode = z.infer<typeof PreparedAgentMemoryModeSchema>;
/**
 * The canonical Host source snapshot this input was assembled from. Both
 * values are Host authority carried verbatim so the receipt binds the exact
 * revision/digest a later consumer must re-present. The SDK interprets
 * neither.
 */
export declare const InputPreparationSourceSchema: z.ZodObject<{
    revision: z.ZodString;
    digest: z.ZodString;
}, z.core.$strict>;
export type InputPreparationSource = z.infer<typeof InputPreparationSourceSchema>;
export declare const InputPreparationModelCostSchema: z.ZodObject<{
    input: z.ZodNumber;
    output: z.ZodNumber;
    cacheRead: z.ZodNumber;
    cacheWrite: z.ZodNumber;
}, z.core.$strict>;
/**
 * The exact model identity the request compiles for.
 *
 * `api` is a single literal, not an open enum: `openai-completions` is the one
 * API the frozen B-P1 native validator admits, and widening it is a
 * registration, not a parser relaxation.
 *
 * `thinkingLevelMap` and `compat` are the two body-affecting declarations a
 * locally configured provider profile projects into the model entry the runtime
 * is launched with. They are OPTIONAL because a model configuration may declare
 * neither, and absent stays absent on every carrier: nothing here defaults,
 * coerces or infers one, since a preparation whose model gained a field on the
 * way through would no longer equal the session model it was counted for.
 */
export declare const InputPreparationModelSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    api: z.ZodLiteral<"openai-completions">;
    provider: z.ZodString;
    baseUrl: z.ZodString;
    reasoning: z.ZodBoolean;
    input: z.ZodArray<z.ZodEnum<{
        image: "image";
        text: "text";
    }>>;
    cost: z.ZodObject<{
        input: z.ZodNumber;
        output: z.ZodNumber;
        cacheRead: z.ZodNumber;
        cacheWrite: z.ZodNumber;
    }, z.core.$strict>;
    contextWindow: z.ZodNumber;
    maxTokens: z.ZodNumber;
    thinkingLevelMap: z.ZodOptional<z.ZodObject<{
        off: z.ZodNullable<z.ZodString>;
        minimal: z.ZodNullable<z.ZodString>;
        low: z.ZodNullable<z.ZodString>;
        medium: z.ZodNullable<z.ZodString>;
        high: z.ZodNullable<z.ZodString>;
        xhigh: z.ZodNullable<z.ZodString>;
        max: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    compat: z.ZodOptional<z.ZodObject<{
        supportsStore: z.ZodOptional<z.ZodBoolean>;
        supportsDeveloperRole: z.ZodOptional<z.ZodBoolean>;
        supportsReasoningEffort: z.ZodOptional<z.ZodBoolean>;
        supportsUsageInStreaming: z.ZodOptional<z.ZodBoolean>;
        maxTokensField: z.ZodOptional<z.ZodEnum<{
            max_completion_tokens: "max_completion_tokens";
            max_tokens: "max_tokens";
        }>>;
        thinkingFormat: z.ZodOptional<z.ZodEnum<{
            "ant-ling": "ant-ling";
            baseten: "baseten";
            "chat-template": "chat-template";
            deepseek: "deepseek";
            openai: "openai";
            openrouter: "openrouter";
            qwen: "qwen";
            "qwen-chat-template": "qwen-chat-template";
            "string-thinking": "string-thinking";
            together: "together";
            zai: "zai";
        }>>;
        zaiToolStream: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type InputPreparationModel = z.infer<typeof InputPreparationModelSchema>;
/**
 * Body-affecting options only. Transport options are deliberately not on this wire.
 *
 * `toolChoice` admits `auto` and `none` and nothing else: the native prepared
 * boundary compiles through the simple stream path, which cannot express
 * `required`, so a Host stating it would be stating an option no compiler on
 * the other side can produce. It is refused HERE, by the schema, rather than
 * surviving to a native refusal nobody can read.
 *
 * `reasoningEffort` names a requested thinking level. The native compiler maps
 * it through the launched model's own level map and clamps it exactly as the
 * live session does, so the effort token that reaches the body is the model's,
 * never this value verbatim.
 */
export declare const InputPreparationOptionsSchema: z.ZodObject<{
    cacheRetention: z.ZodEnum<{
        long: "long";
        none: "none";
        short: "short";
    }>;
    maxTokens: z.ZodNumber;
    temperature: z.ZodOptional<z.ZodNumber>;
    toolChoice: z.ZodOptional<z.ZodEnum<{
        auto: "auto";
        none: "none";
    }>>;
    reasoningEffort: z.ZodOptional<z.ZodEnum<{
        high: "high";
        low: "low";
        max: "max";
        medium: "medium";
        minimal: "minimal";
        xhigh: "xhigh";
    }>>;
}, z.core.$strict>;
export type InputPreparationOptions = z.infer<typeof InputPreparationOptionsSchema>;
export declare const InputPreparationSelectionSchema: z.ZodObject<{
    model: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        api: z.ZodLiteral<"openai-completions">;
        provider: z.ZodString;
        baseUrl: z.ZodString;
        reasoning: z.ZodBoolean;
        input: z.ZodArray<z.ZodEnum<{
            image: "image";
            text: "text";
        }>>;
        cost: z.ZodObject<{
            input: z.ZodNumber;
            output: z.ZodNumber;
            cacheRead: z.ZodNumber;
            cacheWrite: z.ZodNumber;
        }, z.core.$strict>;
        contextWindow: z.ZodNumber;
        maxTokens: z.ZodNumber;
        thinkingLevelMap: z.ZodOptional<z.ZodObject<{
            off: z.ZodNullable<z.ZodString>;
            minimal: z.ZodNullable<z.ZodString>;
            low: z.ZodNullable<z.ZodString>;
            medium: z.ZodNullable<z.ZodString>;
            high: z.ZodNullable<z.ZodString>;
            xhigh: z.ZodNullable<z.ZodString>;
            max: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        compat: z.ZodOptional<z.ZodObject<{
            supportsStore: z.ZodOptional<z.ZodBoolean>;
            supportsDeveloperRole: z.ZodOptional<z.ZodBoolean>;
            supportsReasoningEffort: z.ZodOptional<z.ZodBoolean>;
            supportsUsageInStreaming: z.ZodOptional<z.ZodBoolean>;
            maxTokensField: z.ZodOptional<z.ZodEnum<{
                max_completion_tokens: "max_completion_tokens";
                max_tokens: "max_tokens";
            }>>;
            thinkingFormat: z.ZodOptional<z.ZodEnum<{
                "ant-ling": "ant-ling";
                baseten: "baseten";
                "chat-template": "chat-template";
                deepseek: "deepseek";
                openai: "openai";
                openrouter: "openrouter";
                qwen: "qwen";
                "qwen-chat-template": "qwen-chat-template";
                "string-thinking": "string-thinking";
                together: "together";
                zai: "zai";
            }>>;
            zaiToolStream: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    options: z.ZodObject<{
        cacheRetention: z.ZodEnum<{
            long: "long";
            none: "none";
            short: "short";
        }>;
        maxTokens: z.ZodNumber;
        temperature: z.ZodOptional<z.ZodNumber>;
        toolChoice: z.ZodOptional<z.ZodEnum<{
            auto: "auto";
            none: "none";
        }>>;
        reasoningEffort: z.ZodOptional<z.ZodEnum<{
            high: "high";
            low: "low";
            max: "max";
            medium: "medium";
            minimal: "minimal";
            xhigh: "xhigh";
        }>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type InputPreparationSelection = z.infer<typeof InputPreparationSelectionSchema>;
/** Complete Host-authored prompt. No Pi renderer or device-local input is consulted. */
export declare const InputPreparationPromptSnapshotSchema: z.ZodObject<{
    systemPrompt: z.ZodString;
}, z.core.$strict>;
/**
 * One model-visible user message. Text-only: multimodal content and any extra
 * field are not inferred, they reject.
 */
export declare const InputPreparationUserMessageSchema: z.ZodObject<{
    role: z.ZodLiteral<"user">;
    content: z.ZodString;
    timestamp: z.ZodNumber;
}, z.core.$strict>;
/**
 * One host-canonical assistant text message.
 *
 * A different fact from a provider-generated assistant turn: the host asserts
 * this text was already said, and nothing generated it here. It carries no
 * `api`, `provider`, `model`, `usage` or `stopReason`, and `.strict()` is what
 * keeps one from being fabricated on the way in — an assistant message with
 * provenance fields, or without the `origin` discriminant, is a claim this
 * surface cannot check, so it rejects rather than being narrowed to one it can.
 */
export declare const InputPreparationHostCanonicalAssistantMessageSchema: z.ZodObject<{
    role: z.ZodLiteral<"assistant">;
    origin: z.ZodLiteral<"host_canonical">;
    content: z.ZodString;
    timestamp: z.ZodNumber;
}, z.core.$strict>;
/**
 * The whole support set a caller may state: text-only user history,
 * host-canonical assistant text history, and the current user message.
 *
 * A discriminated union on `role`, so an unsupported kind is refused by name
 * rather than by a shape error on whichever member happened to be tried first.
 * Provider-generated assistant turns, tool-result history and multimodal
 * content are not members and are not inferred; adding one is a registration
 * here AND in the device's hand-written parse, never a relaxation of either.
 */
export declare const InputPreparationMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    role: z.ZodLiteral<"user">;
    content: z.ZodString;
    timestamp: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    role: z.ZodLiteral<"assistant">;
    origin: z.ZodLiteral<"host_canonical">;
    content: z.ZodString;
    timestamp: z.ZodNumber;
}, z.core.$strict>], "role">;
export type InputPreparationMessage = z.infer<typeof InputPreparationMessageSchema>;
/**
 * What `context.inline` (or the referenced blob) decodes to.
 *
 * Deliberately NOT the whole compiled snapshot: `tools` is absent because the
 * device adds it from its own MCP observation. A Host that could send `tools`
 * could claim a toolset the device does not have.
 */
export declare const InputPreparationContextDocumentSchema: z.ZodObject<{
    prompt: z.ZodObject<{
        systemPrompt: z.ZodString;
    }, z.core.$strict>;
    messages: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        role: z.ZodLiteral<"user">;
        content: z.ZodString;
        timestamp: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        role: z.ZodLiteral<"assistant">;
        origin: z.ZodLiteral<"host_canonical">;
        content: z.ZodString;
        timestamp: z.ZodNumber;
    }, z.core.$strict>], "role">>;
}, z.core.$strict>;
export type InputPreparationContextDocument = z.infer<typeof InputPreparationContextDocumentSchema>;
/**
 * Durable lifecycle state of one local preparation record.
 *
 * `prepared` is the one successful terminal state: the artifact is compiled,
 * persisted, and — when the device has an optional counter configured — its
 * counter answered. A device with no counter reaches `prepared` without ever
 * entering `counting`.
 */
export declare const InputPreparationStateSchema: z.ZodEnum<{
    cancelled: "cancelled";
    counter_interrupted: "counter_interrupted";
    counting: "counting";
    failed: "failed";
    prepared: "prepared";
    reserved: "reserved";
}>;
export type InputPreparationState = z.infer<typeof InputPreparationStateSchema>;
/**
 * Why a receipt is not ready. An empty list is the only thing that makes
 * `ready` true.
 *
 * `ready` means the preparation CAN BE CONSUMED — the artifact is intact and
 * unexpired, the native compiler's projection is content-complete, every
 * residual key is ruled by an applicable Host accounting policy, D is text
 * only, and — only when the device has an
 * optional counter configured — that count is provider-authoritative and
 * covered. No count is required: the size evidence is
 * `artifact.requestBytes`, the exact byte length of the frozen D. It is
 * deliberately NOT Host budget admission: the device performs no budget
 * arithmetic, so a ready receipt says the evidence holds, never that the
 * spend fits a window.
 */
export declare const InputPreparationReadinessReasonSchema: z.ZodEnum<{
    accounting_policy_inapplicable: "accounting_policy_inapplicable";
    accounting_policy_missing: "accounting_policy_missing";
    artifact_expired: "artifact_expired";
    cancelled: "cancelled";
    counter_authority_not_production: "counter_authority_not_production";
    counter_coverage_incomplete: "counter_coverage_incomplete";
    counter_interrupted: "counter_interrupted";
    failed: "failed";
    not_prepared: "not_prepared";
    projection_unknown: "projection_unknown";
    request_content_not_text: "request_content_not_text";
    residual_not_ruled: "residual_not_ruled";
    runtime_contract_superseded: "runtime_contract_superseded";
}>;
export type InputPreparationReadinessReason = z.infer<typeof InputPreparationReadinessReasonSchema>;
/**
 * Runtime/compiler identity derived from the VERIFIED installed package
 * closure on the device. A Host never states it and cannot override it.
 */
export declare const InputPreparationRuntimeIdentitySchema: z.ZodObject<{
    packageName: z.ZodString;
    packageVersion: z.ZodString;
    tarballIntegrity: z.ZodString;
    provenanceDigest: z.ZodString;
    closureDigest: z.ZodString;
    upstreamCommit: z.ZodString;
    envelopeFormat: z.ZodString;
    requestFormat: z.ZodString;
    compilerVersion: z.ZodNumber;
}, z.core.$strict>;
export type InputPreparationRuntimeIdentity = z.infer<typeof InputPreparationRuntimeIdentitySchema>;
export declare const InputPreparationCounterTargetSchema: z.ZodObject<{
    endpoint: z.ZodString;
    modelId: z.ZodString;
}, z.core.$strict>;
/**
 * The Host's ruling about which residual keys of D its accounting already
 * accounts for.
 *
 * Host authority, carried verbatim. The device performs exactly one check
 * against it — APPLICABILITY — and never any budget arithmetic: every residual
 * key the artifact carries must be named here, and the ruling must have been
 * made for this preparation's own runtime identity and endpoint/model. There
 * is no default: a request that names none produces a receipt carrying
 * `accounting_policy_missing`, because "nobody ruled" and "everything is
 * ruled" are different facts.
 */
export declare const InputPreparationAccountingPolicyRefSchema: z.ZodObject<{
    revision: z.ZodString;
    ruledRuntime: z.ZodString;
    ruledTarget: z.ZodObject<{
        endpoint: z.ZodString;
        modelId: z.ZodString;
    }, z.core.$strict>;
    ruledResidualKeys: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type InputPreparationAccountingPolicyRef = z.infer<typeof InputPreparationAccountingPolicyRefSchema>;
/**
 * What the provider side of a count asserted, and which exact projection it
 * was asserted about.
 *
 * Required, fixture included: a number without the identity of the bytes it
 * was taken over is not evidence. The device compares `projectionDigest`
 * against the artifact's own projection digest and `endpoint`/`modelId`
 * against the counted target, and refuses the count outright on a mismatch.
 *
 * `asserted` is the provider's own answer, stored and never second-guessed —
 * re-deriving a usage number locally is the shadow accounting this surface
 * exists to avoid. It carries no output or whole-request field: the Host holds
 * its own request, and `binding.requestDigest` is the check that ties the two.
 */
export declare const InputPreparationCounterProviderEvidenceSchema: z.ZodObject<{
    projectionDigest: z.ZodString;
    endpoint: z.ZodString;
    modelId: z.ZodString;
    asserted: z.ZodObject<{
        httpStatus: z.ZodNumber;
        usageFields: z.ZodRecord<z.ZodString, z.ZodNumber>;
        responseDigest: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
/**
 * Counter evidence exactly as the device's OPTIONAL adapter reported it.
 * Absent when the device has no counter configured, which is a legal, ready-
 * capable state: the size evidence is `artifact.requestBytes`.
 *
 * `authority: 'test_fixture'` is a first-class value, not a debug flag: a
 * fixture result can never produce a ready receipt, which is what keeps an
 * offline suite from ever looking like production accounting evidence.
 */
export declare const InputPreparationCounterEvidenceSchema: z.ZodObject<{
    method: z.ZodString;
    methodVersion: z.ZodString;
    authority: z.ZodEnum<{
        provider: "provider";
        test_fixture: "test_fixture";
    }>;
    value: z.ZodNumber;
    coverage: z.ZodObject<{
        covered: z.ZodBoolean;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    providerEvidence: z.ZodObject<{
        projectionDigest: z.ZodString;
        endpoint: z.ZodString;
        modelId: z.ZodString;
        asserted: z.ZodObject<{
            httpStatus: z.ZodNumber;
            usageFields: z.ZodRecord<z.ZodString, z.ZodNumber>;
            responseDigest: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>;
    target: z.ZodObject<{
        endpoint: z.ZodString;
        modelId: z.ZodString;
    }, z.core.$strict>;
    calledAt: z.ZodISODateTime;
    completedAt: z.ZodISODateTime;
}, z.core.$strict>;
/**
 * What the native compiler proved about ONE top-level key of D that lies
 * outside P(D).
 *
 * These classes describe STRUCTURE and nothing else. No class states, implies
 * or denies that a key influences a provider's token count — that is an
 * external accounting fact the compiler cannot prove — which is exactly why
 * the device re-derives nothing from them and routes the question to the
 * Host's own {@link InputPreparationAccountingPolicyRefSchema}.
 */
export declare const InputPreparationResidualValueClassSchema: z.ZodEnum<{
    boolean: "boolean";
    bounded_integer: "bounded_integer";
    bounded_number: "bounded_number";
    closed_enum: "closed_enum";
    constant: "constant";
    finite_number: "finite_number";
    nonempty_string: "nonempty_string";
    object_shape: "object_shape";
}>;
export type InputPreparationResidualValueClass = z.infer<typeof InputPreparationResidualValueClassSchema>;
export declare const InputPreparationResidualKeySchema: z.ZodObject<{
    key: z.ZodString;
    valueClass: z.ZodEnum<{
        boolean: "boolean";
        bounded_integer: "bounded_integer";
        bounded_number: "bounded_number";
        closed_enum: "closed_enum";
        constant: "constant";
        finite_number: "finite_number";
        nonempty_string: "nonempty_string";
        object_shape: "object_shape";
    }>;
}, z.core.$strict>;
/**
 * What the native compiler proves about P(D), copied verbatim off the envelope.
 *
 * `content_complete` — every context-derived byte of D is byte-identically
 * inside P(D), and every remaining top-level key was classified. `unknown` —
 * the compiler failed closed, claims nothing, and leaves `residual` empty.
 *
 * `digest` is sha-256 over the exact counted-projection bytes. The device
 * recomputes it and refuses the artifact on a mismatch; it never recomputes
 * the KIND, because the classification table belongs to the compiler and a
 * local copy of it would be a shadow parser for the same semantic fact.
 */
export declare const InputPreparationProjectionSchema: z.ZodObject<{
    version: z.ZodLiteral<3>;
    kind: z.ZodEnum<{
        content_complete: "content_complete";
        unknown: "unknown";
    }>;
    digest: z.ZodString;
}, z.core.$strict>;
/**
 * Identities, sizes and the native compiler's structural projection contract.
 * Never D, never P(D), never the snapshot.
 *
 * The three tool-surface fields are what make drift between preparation and
 * launch checkable rather than assumed:
 *
 * - `observationDigest` binds everything the device OBSERVED — the projected
 *   tools and their executor fingerprints — so a launch whose live
 *   observation differs is a different manifest, whatever the schemas say.
 * - `toolBindingDigest` binds only the facts that can be re-derived WITHOUT
 *   spawning a server: the toolset definition revisions and the configured
 *   argv. It is what a replay of an already-recorded requestId compares
 *   against, because re-probing to detect drift would be the second executor
 *   fact the idempotency key exists to prevent.
 * - `toolNames` lists the counted model-visible tool names, sorted. A launch
 *   that registers a different set can name the tool that appeared or
 *   vanished.
 */
export declare const InputPreparationArtifactSummarySchema: z.ZodObject<{
    requestDigest: z.ZodString;
    envelopeDigest: z.ZodString;
    toolManifestDigest: z.ZodString;
    requestBytes: z.ZodNumber;
    projectionBytes: z.ZodNumber;
    projection: z.ZodObject<{
        version: z.ZodLiteral<3>;
        kind: z.ZodEnum<{
            content_complete: "content_complete";
            unknown: "unknown";
        }>;
        digest: z.ZodString;
    }, z.core.$strict>;
    residual: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        valueClass: z.ZodEnum<{
            boolean: "boolean";
            bounded_integer: "bounded_integer";
            bounded_number: "bounded_number";
            closed_enum: "closed_enum";
            constant: "constant";
            finite_number: "finite_number";
            nonempty_string: "nonempty_string";
            object_shape: "object_shape";
        }>;
    }, z.core.$strict>>;
    observationDigest: z.ZodString;
    toolBindingDigest: z.ZodString;
    toolNames: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
/** The immutable binding a receipt carries and a later consumer must re-present. */
export declare const InputPreparationBindingSchema: z.ZodObject<{
    terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        mode: z.ZodLiteral<"none">;
    }, z.core.$strict>, z.ZodObject<{
        mode: z.ZodLiteral<"result-document">;
        contract: z.ZodString;
        schema: z.ZodCustom<import("./result-schema").ResultSchema, import("./result-schema").ResultSchema>;
    }, z.core.$strict>], "mode">>;
    agentMemory: z.ZodEnum<{
        none: "none";
        read: "read";
        "read-write": "read-write";
    }>;
    scopeId: z.ZodString;
    deviceId: z.ZodString;
    agentRef: z.ZodString;
    profileId: z.ZodString;
    profileRevision: z.ZodString;
    source: z.ZodObject<{
        revision: z.ZodString;
        digest: z.ZodString;
    }, z.core.$strict>;
    target: z.ZodObject<{
        endpoint: z.ZodString;
        modelId: z.ZodString;
    }, z.core.$strict>;
    policyRevision: z.ZodString;
    runtime: z.ZodObject<{
        packageName: z.ZodString;
        packageVersion: z.ZodString;
        tarballIntegrity: z.ZodString;
        provenanceDigest: z.ZodString;
        closureDigest: z.ZodString;
        upstreamCommit: z.ZodString;
        envelopeFormat: z.ZodString;
        requestFormat: z.ZodString;
        compilerVersion: z.ZodNumber;
    }, z.core.$strict>;
    requestDigest: z.ZodString;
    accountingPolicyRef: z.ZodOptional<z.ZodObject<{
        revision: z.ZodString;
        ruledRuntime: z.ZodString;
        ruledTarget: z.ZodObject<{
            endpoint: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>;
        ruledResidualKeys: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/**
 * The exact receipt projection a device reports back.
 *
 * `reference` names the record inside the device-local authenticated scope
 * that created it. It is not a capability: local lookup re-resolves authority
 * on every call and derives the record key from the trusted grant.
 */
export declare const InputPreparationReceiptSummarySchema: z.ZodObject<{
    reference: z.ZodString;
    state: z.ZodEnum<{
        cancelled: "cancelled";
        counter_interrupted: "counter_interrupted";
        counting: "counting";
        failed: "failed";
        prepared: "prepared";
        reserved: "reserved";
    }>;
    binding: z.ZodObject<{
        terminalProjection: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"none">;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"result-document">;
            contract: z.ZodString;
            schema: z.ZodCustom<import("./result-schema").ResultSchema, import("./result-schema").ResultSchema>;
        }, z.core.$strict>], "mode">>;
        agentMemory: z.ZodEnum<{
            none: "none";
            read: "read";
            "read-write": "read-write";
        }>;
        scopeId: z.ZodString;
        deviceId: z.ZodString;
        agentRef: z.ZodString;
        profileId: z.ZodString;
        profileRevision: z.ZodString;
        source: z.ZodObject<{
            revision: z.ZodString;
            digest: z.ZodString;
        }, z.core.$strict>;
        target: z.ZodObject<{
            endpoint: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>;
        policyRevision: z.ZodString;
        runtime: z.ZodObject<{
            packageName: z.ZodString;
            packageVersion: z.ZodString;
            tarballIntegrity: z.ZodString;
            provenanceDigest: z.ZodString;
            closureDigest: z.ZodString;
            upstreamCommit: z.ZodString;
            envelopeFormat: z.ZodString;
            requestFormat: z.ZodString;
            compilerVersion: z.ZodNumber;
        }, z.core.$strict>;
        requestDigest: z.ZodString;
        accountingPolicyRef: z.ZodOptional<z.ZodObject<{
            revision: z.ZodString;
            ruledRuntime: z.ZodString;
            ruledTarget: z.ZodObject<{
                endpoint: z.ZodString;
                modelId: z.ZodString;
            }, z.core.$strict>;
            ruledResidualKeys: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    artifact: z.ZodOptional<z.ZodObject<{
        requestDigest: z.ZodString;
        envelopeDigest: z.ZodString;
        toolManifestDigest: z.ZodString;
        requestBytes: z.ZodNumber;
        projectionBytes: z.ZodNumber;
        projection: z.ZodObject<{
            version: z.ZodLiteral<3>;
            kind: z.ZodEnum<{
                content_complete: "content_complete";
                unknown: "unknown";
            }>;
            digest: z.ZodString;
        }, z.core.$strict>;
        residual: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            valueClass: z.ZodEnum<{
                boolean: "boolean";
                bounded_integer: "bounded_integer";
                bounded_number: "bounded_number";
                closed_enum: "closed_enum";
                constant: "constant";
                finite_number: "finite_number";
                nonempty_string: "nonempty_string";
                object_shape: "object_shape";
            }>;
        }, z.core.$strict>>;
        observationDigest: z.ZodString;
        toolBindingDigest: z.ZodString;
        toolNames: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    counter: z.ZodOptional<z.ZodObject<{
        method: z.ZodString;
        methodVersion: z.ZodString;
        authority: z.ZodEnum<{
            provider: "provider";
            test_fixture: "test_fixture";
        }>;
        value: z.ZodNumber;
        coverage: z.ZodObject<{
            covered: z.ZodBoolean;
            reason: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        providerEvidence: z.ZodObject<{
            projectionDigest: z.ZodString;
            endpoint: z.ZodString;
            modelId: z.ZodString;
            asserted: z.ZodObject<{
                httpStatus: z.ZodNumber;
                usageFields: z.ZodRecord<z.ZodString, z.ZodNumber>;
                responseDigest: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        target: z.ZodObject<{
            endpoint: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>;
        calledAt: z.ZodISODateTime;
        completedAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    ready: z.ZodBoolean;
    readinessReasons: z.ZodArray<z.ZodEnum<{
        accounting_policy_inapplicable: "accounting_policy_inapplicable";
        accounting_policy_missing: "accounting_policy_missing";
        artifact_expired: "artifact_expired";
        cancelled: "cancelled";
        counter_authority_not_production: "counter_authority_not_production";
        counter_coverage_incomplete: "counter_coverage_incomplete";
        counter_interrupted: "counter_interrupted";
        failed: "failed";
        not_prepared: "not_prepared";
        projection_unknown: "projection_unknown";
        request_content_not_text: "request_content_not_text";
        residual_not_ruled: "residual_not_ruled";
        runtime_contract_superseded: "runtime_contract_superseded";
    }>>;
    detail: z.ZodOptional<z.ZodString>;
    artifactExpiresAt: z.ZodISODateTime;
}, z.core.$strict>;
export type InputPreparationReceiptSummary = z.infer<typeof InputPreparationReceiptSummarySchema>;
/**
 * The device-local reference one receipt answered with
 * ({@link InputPreparationReceiptSummarySchema}'s `reference`).
 *
 * The same opaque identifier, spelled as its own schema so the offer wire and
 * the receipt wire cannot drift into two definitions of one value. It is NOT a
 * capability: the device re-resolves authority on every lookup and derives the
 * record key from its own trusted grant, so presenting another scope's
 * reference finds nothing.
 */
export declare const InputPreparationReferenceSchema: z.ZodString;
/**
 * The preparation a `task.offer_prepared` names, re-presented by the Host from
 * the receipt it was given.
 *
 * Nothing here is authority. Every value is COMPARED against the device's own
 * durable record before an Execution is admitted, and a difference declines the
 * offer non-retryably — a Host that could state a binding would be stating what
 * this device counted.
 *
 * `artifactDigest` is optional for one structural reason, not as a compatibility
 * seam: a receipt discloses `artifact` only once there is one
 * ({@link InputPreparationArtifactSummarySchema} is optional on the receipt), so
 * a Host holding a not-yet-prepared receipt has no envelope digest to re-present.
 * When it is present it is compared like everything else.
 */
export declare const InputPreparationOfferBindingSchema: z.ZodObject<{
    reference: z.ZodString;
    requestDigest: z.ZodString;
    artifactDigest: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type InputPreparationOfferBinding = z.infer<typeof InputPreparationOfferBindingSchema>;
/**
 * Why a device refused to prepare at all. These are the device-owned typed
 * rejections; none of them ever accompanies an artifact.
 *
 * `input_preparation_unconfigured` is the answer from a device that advertised
 * nothing: the whole surface is off there. It is reported rather than thrown so
 * one mis-targeted request cannot freeze the device's mailbox cursor behind it.
 */
export declare const InputPreparationRejectionReasonSchema: z.ZodEnum<{
    authority_unavailable: "authority_unavailable";
    bad_request: "bad_request";
    cancelled: "cancelled";
    context_hash_mismatch: "context_hash_mismatch";
    context_unresolvable: "context_unresolvable";
    counter_interrupted: "counter_interrupted";
    counter_unavailable: "counter_unavailable";
    deadline_elapsed: "deadline_elapsed";
    durable_write_failed: "durable_write_failed";
    input_preparation_record_log_unsupported: "input_preparation_record_log_unsupported";
    input_preparation_unconfigured: "input_preparation_unconfigured";
    limit_exceeded: "limit_exceeded";
    not_found: "not_found";
    observation_drift: "observation_drift";
    policy_revision_mismatch: "policy_revision_mismatch";
    request_conflict: "request_conflict";
    rpc_frame_too_large: "rpc_frame_too_large";
    runtime_identity_unavailable: "runtime_identity_unavailable";
    scope_denied: "scope_denied";
    toolsets_unobservable: "toolsets_unobservable";
    unsupported_input: "unsupported_input";
}>;
export type InputPreparationRejectionReason = z.infer<typeof InputPreparationRejectionReasonSchema>;
// ==== @byok-sdk/protocol dist/messages.d.ts ====
import { z } from 'zod';
import { ProviderProvisioningAvailablePayloadSchema } from './provider-provisioning';
import { E2eeKeyPackageAvailablePayloadSchema } from './e2ee-member';
import { type PlainJsonCheck } from './plain-json';
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
    messageDraft: z.ZodOptional<z.ZodBoolean>;
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
        messageDraft: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;
/** Custom identities are disjoint from the frozen built-in runtime enum. */
export declare const HarnessIdSchema: z.ZodString;
export type HarnessId = z.infer<typeof HarnessIdSchema>;
export declare const HarnessInfoSchema: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodObject<{
        steer: z.ZodOptional<z.ZodBoolean>;
        resume: z.ZodOptional<z.ZodBoolean>;
        approvalInteractive: z.ZodOptional<z.ZodBoolean>;
        mcpToolsets: z.ZodOptional<z.ZodBoolean>;
        messageDraft: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type HarnessInfo = z.infer<typeof HarnessInfoSchema>;
export declare const HarnessInventorySchema: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    version: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodObject<{
        steer: z.ZodOptional<z.ZodBoolean>;
        resume: z.ZodOptional<z.ZodBoolean>;
        approvalInteractive: z.ZodOptional<z.ZodBoolean>;
        mcpToolsets: z.ZodOptional<z.ZodBoolean>;
        messageDraft: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>>;
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
            messageDraft: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
    harnesses: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodOptional<z.ZodString>;
        capabilities: z.ZodObject<{
            steer: z.ZodOptional<z.ZodBoolean>;
            resume: z.ZodOptional<z.ZodBoolean>;
            approvalInteractive: z.ZodOptional<z.ZodBoolean>;
            mcpToolsets: z.ZodOptional<z.ZodBoolean>;
            messageDraft: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>;
    }, z.core.$strip>>>;
    configuredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    cursor: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type ConnHelloPayload = z.infer<typeof ConnHelloPayloadSchema>;
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
/** Every named toolset is required; duplicates are rejected instead of silently de-duplicated. */
export declare const RequiredToolsetsSchema: z.ZodArray<z.ZodString>;
/**
 * How an Agent Attempt uses its Agent home. `memory-reader` runs the Attempt
 * in its own run directory, `<home>/.byok/runs/<taskId>/`, beside other
 * reader Attempts and at most one writer Attempt. The home stays an ancestor
 * of that cwd, so the runtime still finds the persona and memory. Absent means
 * a writer: the Attempt runs in the canonical home, and one home has at most
 * one writer at a time. The SDK does not make memory read-only; a reader
 * terminal reports memory changes in `agentHomeMemoryChange`. A host sends this
 * field only to a device that advertises `agent-home-readers`: the Agent
 * offers are strict, so an older daemon cannot accept it.
 */
export declare const AgentHomeAccessSchema: z.ZodLiteral<"memory-reader">;
export type AgentHomeAccess = z.infer<typeof AgentHomeAccessSchema>;
/**
 * The `agentMemory` of an ordinary Agent offer: the prepared modes plus
 * `read-if-admitted` and `read-write-if-admitted`. When the daemon admits the
 * memory MCP they run as `read` and `read-write`; when it does not, both run as
 * `none`. A host sends each only to a device that advertises
 * `agent-memory-read-if-admitted` or `agent-memory-read-write-if-admitted`. A
 * `memory-reader` Attempt cannot select `read-write-if-admitted`. Prepared
 * offers refuse both.
 */
export declare const AgentMemorySelectionSchema: z.ZodEnum<{
    none: "none";
    read: "read";
    "read-if-admitted": "read-if-admitted";
    "read-write": "read-write";
    "read-write-if-admitted": "read-write-if-admitted";
}>;
export type AgentMemorySelection = z.infer<typeof AgentMemorySelectionSchema>;
/**
 * Strict additive offer for a durable host-owned Agent. An older daemon that
 * does not advertise `agent-home-contract` skips this distinct message type
 * instead of stripping identity and applying legacy workspace semantics.
 *
 * `agentMemory` selects the Agent memory of this one task (see
 * {@link AgentMemorySelectionSchema}). Absent keeps the daemon admission. A
 * host sends it only to a device that advertises `agent-memory-selection`. The
 * prepared offer replaces it with its own required selection.
 */
export declare const TaskOfferForAgentPayloadSchema: z.ZodObject<{
    sealed: z.ZodOptional<z.ZodNever>;
    sealing: z.ZodOptional<z.ZodNever>;
    instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>]>;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    homeAccess: z.ZodOptional<z.ZodLiteral<"memory-reader">>;
    agentMemory: z.ZodOptional<z.ZodEnum<{
        none: "none";
        read: "read";
        "read-if-admitted": "read-if-admitted";
        "read-write": "read-write";
        "read-write-if-admitted": "read-write-if-admitted";
    }>>;
    requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    harnessId: z.ZodOptional<z.ZodString>;
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
        schema: z.ZodCustom<import("./result-schema").ResultSchema, import("./result-schema").ResultSchema>;
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
    sealed: z.ZodOptional<z.ZodNever>;
    sealing: z.ZodOptional<z.ZodNever>;
    instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>]>;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    homeAccess: z.ZodOptional<z.ZodLiteral<"memory-reader">>;
    agentMemory: z.ZodOptional<z.ZodEnum<{
        none: "none";
        read: "read";
        "read-if-admitted": "read-if-admitted";
        "read-write": "read-write";
        "read-write-if-admitted": "read-write-if-admitted";
    }>>;
    requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    harnessId: z.ZodOptional<z.ZodString>;
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
        schema: z.ZodCustom<import("./result-schema").ResultSchema, import("./result-schema").ResultSchema>;
    }, z.core.$strict>], "mode">>;
    limits: z.ZodOptional<z.ZodObject<{
        maxDurationMs: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    sessionRef: z.ZodString;
    egressPolicy: z.ZodObject<{
        policyRevision: z.ZodString;
        activity: z.ZodObject<{
            delivery: z.ZodLiteral<"latest-value">;
            maxCoalesceMs: z.ZodNumber;
            maxEventBytes: z.ZodNumber;
        }, z.core.$strict>;
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
    sealed: z.ZodOptional<z.ZodNever>;
    sealing: z.ZodOptional<z.ZodNever>;
    instruction: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>]>;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    homeAccess: z.ZodOptional<z.ZodLiteral<"memory-reader">>;
    agentMemory: z.ZodOptional<z.ZodEnum<{
        none: "none";
        read: "read";
        "read-if-admitted": "read-if-admitted";
        "read-write": "read-write";
        "read-write-if-admitted": "read-write-if-admitted";
    }>>;
    requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    harnessId: z.ZodOptional<z.ZodString>;
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
        schema: z.ZodCustom<import("./result-schema").ResultSchema, import("./result-schema").ResultSchema>;
    }, z.core.$strict>], "mode">>;
    limits: z.ZodOptional<z.ZodObject<{
        maxDurationMs: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    egressPolicy: z.ZodObject<{
        policyRevision: z.ZodString;
        activity: z.ZodObject<{
            delivery: z.ZodLiteral<"latest-value">;
            maxCoalesceMs: z.ZodNumber;
            maxEventBytes: z.ZodNumber;
        }, z.core.$strict>;
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
/**
 * Strict offer for an already-counted prepared Execution.
 *
 * A DISTINCT message type, not a `preparation` field added to
 * `task.offer_for_agent`, for the same N/N-1 reason the toolset and egress
 * variants are distinct. On long-poll, both an unknown message type and an
 * unknown key on a strict payload freeze the cursor. The enqueue capability
 * gate is the compatibility boundary: v6 requires a drain and paired upgrade,
 * with no dual token or dual read.
 *
 * It carries no `instruction`: the user request is already inside the frozen
 * envelope the referenced record retained, and an offer that carried both would
 * have two answers to what the runtime is about to send. `sessionRef` is absent
 * for the same structural reason the adapter refuses the pair — a prepared
 * Execution never resumes.
 *
 * Every value under `preparation` is the Host RE-PRESENTING what the device
 * already told it. The device compares each one against its own durable record
 * and declines non-retryably on any difference; nothing here is authority.
 */
export declare const TaskOfferPreparedPayloadSchema: z.ZodObject<{
    sealed: z.ZodOptional<z.ZodNever>;
    sealing: z.ZodOptional<z.ZodNever>;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    homeAccess: z.ZodOptional<z.ZodLiteral<"memory-reader">>;
    requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    harnessId: z.ZodOptional<z.ZodString>;
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
        schema: z.ZodCustom<import("./result-schema").ResultSchema, import("./result-schema").ResultSchema>;
    }, z.core.$strict>], "mode">>;
    limits: z.ZodOptional<z.ZodObject<{
        maxDurationMs: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    preparation: z.ZodObject<{
        reference: z.ZodString;
        requestDigest: z.ZodString;
        artifactDigest: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    agentMemory: z.ZodEnum<{
        none: "none";
        read: "read";
        "read-write": "read-write";
    }>;
    egressPolicy: z.ZodObject<{
        policyRevision: z.ZodString;
        activity: z.ZodObject<{
            delivery: z.ZodLiteral<"latest-value">;
            maxCoalesceMs: z.ZodNumber;
            maxEventBytes: z.ZodNumber;
        }, z.core.$strict>;
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
export type TaskOfferPreparedPayload = z.infer<typeof TaskOfferPreparedPayloadSchema>;
/** Daemon -> cloud: one durable reliable-lane item, forwarded as the Agent produced it. */
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
/** Display-only text. Offsets count UTF-8 bytes within one revision. */
export declare const AgentMessageDraftPayloadSchema: z.ZodObject<{
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    revision: z.ZodNumber;
    offset: z.ZodNumber;
    text: z.ZodString;
    overflow: z.ZodOptional<z.ZodLiteral<true>>;
}, z.core.$strict>;
export type AgentMessageDraftPayload = z.infer<typeof AgentMessageDraftPayloadSchema>;
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
 * Server -> daemon: a Host-approved Agent memory intent is waiting for this
 * device (capability `agent-memory-intent.v1`, see `agent-memory-intent.ts`).
 *
 * `.strict()` and exactly two fields. There is deliberately no path, operation,
 * revision or content: the device fetches the immutable intent from the Host
 * under its own device authentication, so a mailbox row or journal line never
 * holds memory content. `agentRef` routes the home lease and the local ledger
 * and must equal the fetched intent's `agentRef`.
 */
export declare const AgentMemoryIntentAvailablePayloadSchema: z.ZodObject<{
    intentId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type AgentMemoryIntentAvailablePayload = z.infer<typeof AgentMemoryIntentAvailablePayloadSchema>;
/**
 * Server -> daemon: one task-free, exact-device remote input preparation.
 *
 * Distinct message type rather than an optional field on an existing one, for
 * the same N/N-1 reason the Agent offers are: an optional field could be
 * legally STRIPPED by a daemon that predates this contract, which would then
 * answer as though a preparation it never performed had somehow been handled.
 * An unknown type (`parseMessage` -> `UnknownMessageTypeError`) is not skipped
 * cleanly either: on long-poll it freezes the cursor, so the enqueue capability
 * gate is the compatibility boundary.
 *
 * What is deliberately NOT here (§17 B): `tools`, `toolExecutors`, runtime or
 * compiler identity, `tenantId` and `deviceId`. The first three are local
 * observations; the last two come from the device's own authenticated record,
 * never from the payload — a sender that could name them could redirect a
 * preparation's binding to a device it does not own.
 *
 * `deadlineAt` may only ever be TIGHTENED locally: the device clamps to
 * `min(deadlineAt - now, limits.preparationDeadlineMs)`, so a generous Host
 * deadline cannot enlarge a configured local bound.
 */
export declare const AgentInputPreparationPayloadSchema: z.ZodObject<{
    agentMemory: z.ZodEnum<{
        none: "none";
        read: "read";
        "read-write": "read-write";
    }>;
    requestId: z.ZodUUID;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    profileId: z.ZodString;
    policyRevision: z.ZodString;
    source: z.ZodObject<{
        revision: z.ZodString;
        digest: z.ZodString;
    }, z.core.$strict>;
    selection: z.ZodObject<{
        model: z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            api: z.ZodLiteral<"openai-completions">;
            provider: z.ZodString;
            baseUrl: z.ZodString;
            reasoning: z.ZodBoolean;
            input: z.ZodArray<z.ZodEnum<{
                image: "image";
                text: "text";
            }>>;
            cost: z.ZodObject<{
                input: z.ZodNumber;
                output: z.ZodNumber;
                cacheRead: z.ZodNumber;
                cacheWrite: z.ZodNumber;
            }, z.core.$strict>;
            contextWindow: z.ZodNumber;
            maxTokens: z.ZodNumber;
            thinkingLevelMap: z.ZodOptional<z.ZodObject<{
                off: z.ZodNullable<z.ZodString>;
                minimal: z.ZodNullable<z.ZodString>;
                low: z.ZodNullable<z.ZodString>;
                medium: z.ZodNullable<z.ZodString>;
                high: z.ZodNullable<z.ZodString>;
                xhigh: z.ZodNullable<z.ZodString>;
                max: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>>;
            compat: z.ZodOptional<z.ZodObject<{
                supportsStore: z.ZodOptional<z.ZodBoolean>;
                supportsDeveloperRole: z.ZodOptional<z.ZodBoolean>;
                supportsReasoningEffort: z.ZodOptional<z.ZodBoolean>;
                supportsUsageInStreaming: z.ZodOptional<z.ZodBoolean>;
                maxTokensField: z.ZodOptional<z.ZodEnum<{
                    max_completion_tokens: "max_completion_tokens";
                    max_tokens: "max_tokens";
                }>>;
                thinkingFormat: z.ZodOptional<z.ZodEnum<{
                    "ant-ling": "ant-ling";
                    baseten: "baseten";
                    "chat-template": "chat-template";
                    deepseek: "deepseek";
                    openai: "openai";
                    openrouter: "openrouter";
                    qwen: "qwen";
                    "qwen-chat-template": "qwen-chat-template";
                    "string-thinking": "string-thinking";
                    together: "together";
                    zai: "zai";
                }>>;
                zaiToolStream: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        options: z.ZodObject<{
            cacheRetention: z.ZodEnum<{
                long: "long";
                none: "none";
                short: "short";
            }>;
            maxTokens: z.ZodNumber;
            temperature: z.ZodOptional<z.ZodNumber>;
            toolChoice: z.ZodOptional<z.ZodEnum<{
                auto: "auto";
                none: "none";
            }>>;
            reasoningEffort: z.ZodOptional<z.ZodEnum<{
                high: "high";
                low: "low";
                max: "max";
                medium: "medium";
                minimal: "minimal";
                xhigh: "xhigh";
            }>>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    deadlineAt: z.ZodISODateTime;
    context: z.ZodUnion<readonly [z.ZodObject<{
        inline: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        contentHash: z.ZodString;
    }, z.core.$strict>]>;
    requiredToolsets: z.ZodArray<z.ZodString>;
    accountingPolicyRef: z.ZodOptional<z.ZodObject<{
        revision: z.ZodString;
        ruledRuntime: z.ZodString;
        ruledTarget: z.ZodObject<{
            endpoint: z.ZodString;
            modelId: z.ZodString;
        }, z.core.$strict>;
        ruledResidualKeys: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type AgentInputPreparationPayload = z.infer<typeof AgentInputPreparationPayloadSchema>;
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
 * `approvalId` (required since v4): the SPECIFIC pending approval this
 * decision resolves. The daemon compares it against its own
 * currently-dispatched approval id (`ActiveTask.pendingApprovalId`,
 * `packages/client`'s `task-runner.ts`) and treats a mismatch as a stale,
 * audit-only no-op, so a late decision never lands on the task's next
 * approval — see `TaskRunner.handleApprove`.
 */
export declare const TaskApprovePayloadSchema: z.ZodObject<{
    approvalId: z.ZodString;
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
 * `approvalId` (required since v4): same targeting as
 * `TaskApprovePayloadSchema.approvalId` above, applied to the reject path
 * (`TaskRunner.handleReject`).
 */
export declare const TaskRejectPayloadSchema: z.ZodObject<{
    reason: z.ZodOptional<z.ZodString>;
    approvalId: z.ZodString;
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
    sealed: z.ZodOptional<z.ZodNever>;
    sealing: z.ZodOptional<z.ZodNever>;
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
 * adapter this device selected for the task, distinct from the offer's
 * own `runtime` (the merely REQUESTED one, `TaskOfferForAgentPayloadSchema.runtime`
 * above). When an offer names no runtime the daemon auto-selects (pi-first —
 * `TaskRunner.pickAdapter`, `packages/client`'s `task-runner.ts`), and before
 * this field existed the server had no way to learn which adapter actually
 * ran — `TaskSnapshot.runtime` (`packages/server`'s `types.ts`) only ever
 * recorded what was requested. Plain optional property on this already-
 * tolerant `z.object()`: an old server simply never reads it, so this needed
 * no version bump and no emission gating — a new daemon sends it
 * unconditionally, regardless of whether the connected server is new enough
 * to store it.
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
    harnessId: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodObject<{
        steer: z.ZodOptional<z.ZodBoolean>;
        resume: z.ZodOptional<z.ZodBoolean>;
        approvalInteractive: z.ZodOptional<z.ZodBoolean>;
        mcpToolsets: z.ZodOptional<z.ZodBoolean>;
        messageDraft: z.ZodOptional<z.ZodBoolean>;
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
 * #654: a sealed decline code names a fixed, non-retryable outcome and
 * carries no content, so its `reason` is the code itself. A free-text reason
 * or `retryable: true` never goes with it.
 */
export declare const TaskDeclinePayloadSchema: z.ZodObject<{
    sealed: z.ZodOptional<z.ZodNever>;
    sealing: z.ZodOptional<z.ZodNever>;
    reason: z.ZodString;
    retryable: z.ZodOptional<z.ZodBoolean>;
    agentRef: z.ZodOptional<z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>>;
    code: z.ZodOptional<z.ZodEnum<{
        agent_home_reader_busy: "agent_home_reader_busy";
        agent_home_writer_busy: "agent_home_writer_busy";
        sealed_content_mac_mismatch: "sealed_content_mac_mismatch";
        sealed_key_unavailable: "sealed_key_unavailable";
        sealed_open_failed: "sealed_open_failed";
        sealing_policy_mismatch: "sealing_policy_mismatch";
    }>>;
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
    sealed: z.ZodOptional<z.ZodNever>;
    sealing: z.ZodOptional<z.ZodNever>;
    seq: z.ZodNumber;
    events: z.ZodArray<z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"progress">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        tool: z.ZodString;
        mcp: z.ZodOptional<z.ZodObject<{
            server: z.ZodString;
            tool: z.ZodString;
        }, z.core.$strict>>;
        input: z.ZodOptional<z.ZodUnknown>;
        toolCallId: z.ZodOptional<z.ZodString>;
        spill: z.ZodOptional<z.ZodObject<{
            field: z.ZodEnum<{
                input: "input";
                output: "output";
            }>;
            totalBytes: z.ZodNumber;
            omittedBytes: z.ZodNumber;
            contentType: z.ZodLiteral<"application/json">;
            blob: z.ZodOptional<z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            unstoredReason: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        tool: z.ZodString;
        mcp: z.ZodOptional<z.ZodObject<{
            server: z.ZodString;
            tool: z.ZodString;
        }, z.core.$strict>>;
        output: z.ZodOptional<z.ZodUnknown>;
        toolCallId: z.ZodOptional<z.ZodString>;
        isError: z.ZodOptional<z.ZodBoolean>;
        spill: z.ZodOptional<z.ZodObject<{
            field: z.ZodEnum<{
                input: "input";
                output: "output";
            }>;
            totalBytes: z.ZodNumber;
            omittedBytes: z.ZodNumber;
            contentType: z.ZodLiteral<"application/json">;
            blob: z.ZodOptional<z.ZodObject<{
                blobId: z.ZodString;
                contentHash: z.ZodString;
                size: z.ZodNumber;
                contentType: z.ZodString;
                url: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            unstoredReason: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
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
        contextTokens: z.ZodOptional<z.ZodNumber>;
        contextWindow: z.ZodOptional<z.ZodNumber>;
        contextSource: z.ZodOptional<z.ZodEnum<{
            estimate: "estimate";
            provider: "provider";
        }>>;
    }, z.core.$strip>], "type">, z.ZodObject<{
        type: z.ZodString;
    }, z.core.$loose>]>>;
}, z.core.$strip>;
export type TaskProgressPayload = z.infer<typeof TaskProgressPayloadSchema>;
/** daemon -> server: an artifact produced by the task, inline or by blob ref. */
export declare const TaskArtifactPayloadSchema: z.ZodObject<{
    sealed: z.ZodOptional<z.ZodNever>;
    sealing: z.ZodOptional<z.ZodNever>;
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
 * `approvalId` (required since v4): the daemon's own locally-generated
 * identity for THIS SPECIFIC pending approval (`ApprovalRegistry`,
 * `packages/client`'s `approvals.ts`). The server echoes it on the
 * `task.approve`/`task.reject` that decides this approval.
 */
export declare const TaskAwaitApprovalPayloadSchema: z.ZodObject<{
    sealed: z.ZodOptional<z.ZodNever>;
    sealing: z.ZodOptional<z.ZodNever>;
    summary: z.ZodString;
    approvalId: z.ZodString;
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
export type ResultDocumentCheck = PlainJsonCheck;
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
 *      (`isSameJsonData`, `plain-json.ts`). Any mismatch means the value was not plain
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
 * The prepared-only terminal observation: what the runtime reported about the
 * provider calls of ONE prepared Execution, bound to the frozen request it
 * launched.
 *
 * - `requestDigest` — the frozen artifact's own request digest
 *   (`InputPreparationArtifactSummarySchema.requestDigest`), so the Host
 *   compares these numbers against exactly the D whose `requestBytes` it
 *   ruled on.
 * - `initialPromptTokens` — the prompt tokens of the FIRST provider call. It
 *   is the only call whose request is D; every later call is an ordinary tool
 *   continuation. Prompt tokens are the provider's whole prompt, cache reads
 *   and writes included.
 * - `maxPromptTokens` — the largest prompt of any provider call of the
 *   Execution, so `maxPromptTokens >= initialPromptTokens`.
 *
 * A separate field, deliberately NOT {@link TerminalInferenceUsageSchema}:
 * that one is telemetry and never task-state authority, while this one is the
 * evidence a Host checks its own budget ruling against. The device performs no
 * budget arithmetic over it. Strict, like every other control shape: an
 * unrecognized field is rejected, not stripped.
 */
export declare const TerminalPreparedObservationSchema: z.ZodObject<{
    requestDigest: z.ZodString;
    initialPromptTokens: z.ZodNumber;
    maxPromptTokens: z.ZodNumber;
}, z.core.$strict>;
export type TerminalPreparedObservation = z.infer<typeof TerminalPreparedObservationSchema>;
/**
 * The task-free Agent-home projection (`agent.home_projection`) that the
 * device had already applied when an Agent Attempt started. The writer lease
 * keeps a new projection out of the home until the Attempt ends, so this is
 * the persona the Attempt ran with. The SDK does not compare it with the
 * offer's `agentRef.profileRevision`: the host decides whether a mismatch
 * matters. Absent when the task was not Agent-bound, or when the home had no
 * applied projection record.
 */
export declare const TerminalAgentHomeProjectionSchema: z.ZodObject<{
    profileRevision: z.ZodString;
    projectionHash: z.ZodString;
}, z.core.$strict>;
export type TerminalAgentHomeProjection = z.infer<typeof TerminalAgentHomeProjectionSchema>;
/** Maximum memory files one reader digest covers: `MEMORY.md` plus every entry under `notes/`. */
export declare const AGENT_HOME_MEMORY_DIGEST_MAX_FILES = 256;
/** Maximum bytes of memory files one reader digest reads. */
export declare const AGENT_HOME_MEMORY_DIGEST_MAX_BYTES: number;
/** Maximum length of one changed memory path, relative to the Agent home. */
export declare const AGENT_HOME_MEMORY_PATH_MAX_LENGTH = 1024;
/**
 * Memory-change evidence of one `memory-reader` Attempt. The device hashes
 * `MEMORY.md` and every file under `notes/` when the reader starts and again
 * at its terminal, and compares the two digests.
 *
 * - `unchanged`: the digests are equal.
 * - `reader-attributed`: the digests differ and no writer Attempt of the home
 *   overlapped this reader. A reader Attempt changed memory: this one, or
 *   another reader that overlapped it.
 * - `unattributed`: the digests differ and a writer Attempt overlapped this
 *   reader, so the change has no single source.
 * - `unmeasured`: the digest bound was exceeded, or a read failed.
 *
 * `paths` lists the changed files relative to the home, with `/` separators.
 * The device sees only Attempts it runs; a host that writes memory files
 * itself while readers run makes the attribution ambiguous. Absent on writer
 * terminals and on a claimed failure before the Attempt became active.
 */
export declare const TerminalAgentHomeMemoryChangeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    outcome: z.ZodLiteral<"unchanged">;
}, z.core.$strict>, z.ZodObject<{
    outcome: z.ZodLiteral<"reader-attributed">;
    paths: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    outcome: z.ZodLiteral<"unattributed">;
    paths: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    outcome: z.ZodLiteral<"unmeasured">;
}, z.core.$strict>], "outcome">;
export type TerminalAgentHomeMemoryChange = z.infer<typeof TerminalAgentHomeMemoryChangeSchema>;
/**
 * daemon -> server: task finished successfully.
 *
 * `document` (docs/protocol.md §7.2): the OPTIONAL
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
 * Wire v3: every v3 server keeps this field, so no capability flag gates it
 * (the v2 `result-document` flag is gone). For a
 * `terminalProjection.mode: 'result-document'` offer it carries the outcome
 * the daemon validated against the offer's frozen schema
 * (`validateResultOutcome`, `result-schema.ts`, at most
 * `RESULT_OUTCOME_MAX_BYTES`).
 */
export declare const TaskCompletePayloadSchema: z.ZodObject<{
    sealed: z.ZodOptional<z.ZodNever>;
    sealing: z.ZodOptional<z.ZodNever>;
    harnessId: z.ZodOptional<z.ZodString>;
    summary: z.ZodString;
    finalMessage: z.ZodOptional<z.ZodString>;
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
    preparedObservation: z.ZodOptional<z.ZodObject<{
        requestDigest: z.ZodString;
        initialPromptTokens: z.ZodNumber;
        maxPromptTokens: z.ZodNumber;
    }, z.core.$strict>>;
    agentRef: z.ZodOptional<z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>>;
    agentHomeProjection: z.ZodOptional<z.ZodObject<{
        profileRevision: z.ZodString;
        projectionHash: z.ZodString;
    }, z.core.$strict>>;
    agentHomeMemoryChange: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        outcome: z.ZodLiteral<"unchanged">;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"reader-attributed">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unattributed">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unmeasured">;
    }, z.core.$strict>], "outcome">>;
}, z.core.$strip>;
export type TaskCompletePayload = z.infer<typeof TaskCompletePayloadSchema>;
/** A closed runtime failure class (#869). `unknown` means the runtime gave no structured evidence. */
export declare const RuntimeFailureClassSchema: z.ZodEnum<{
    auth: "auth";
    billing: "billing";
    input_too_large: "input_too_large";
    invalid_request: "invalid_request";
    limit_reached: "limit_reached";
    model_unavailable: "model_unavailable";
    output_schema: "output_schema";
    overloaded: "overloaded";
    provider: "provider";
    quota: "quota";
    rate_limited: "rate_limited";
    runtime_exited: "runtime_exited";
    unknown: "unknown";
}>;
export type RuntimeFailureClass = z.infer<typeof RuntimeFailureClassSchema>;
/**
 * The machine-readable failure of a `task.fail` (#869); `reason` stays display
 * text. `resetsAt` (ISO 8601 UTC) exists only on `quota`, and only when the
 * runtime reported when the limit resets.
 */
export declare const TaskFailureSchema: z.ZodUnion<readonly [z.ZodObject<{
    class: z.ZodLiteral<"quota">;
    resetsAt: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strict>, z.ZodObject<{
    class: z.ZodEnum<{
        auth: "auth";
        billing: "billing";
        input_too_large: "input_too_large";
        invalid_request: "invalid_request";
        limit_reached: "limit_reached";
        model_unavailable: "model_unavailable";
        output_schema: "output_schema";
        overloaded: "overloaded";
        provider: "provider";
        rate_limited: "rate_limited";
        runtime_exited: "runtime_exited";
        unknown: "unknown";
    }>;
}, z.core.$strict>]>;
export type TaskFailure = z.infer<typeof TaskFailureSchema>;
/** daemon -> server: task failed. */
export declare const TaskFailPayloadSchema: z.ZodObject<{
    sealed: z.ZodOptional<z.ZodNever>;
    sealing: z.ZodOptional<z.ZodNever>;
    recovery: z.ZodOptional<z.ZodObject<{
        kind: z.ZodLiteral<"daemon_interrupted">;
        offerId: z.ZodUUID;
    }, z.core.$strict>>;
    harnessId: z.ZodOptional<z.ZodString>;
    reason: z.ZodString;
    retryable: z.ZodOptional<z.ZodBoolean>;
    failure: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
        class: z.ZodLiteral<"quota">;
        resetsAt: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strict>, z.ZodObject<{
        class: z.ZodEnum<{
            auth: "auth";
            billing: "billing";
            input_too_large: "input_too_large";
            invalid_request: "invalid_request";
            limit_reached: "limit_reached";
            model_unavailable: "model_unavailable";
            output_schema: "output_schema";
            overloaded: "overloaded";
            provider: "provider";
            rate_limited: "rate_limited";
            runtime_exited: "runtime_exited";
            unknown: "unknown";
        }>;
    }, z.core.$strict>]>>;
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
    preparedObservation: z.ZodOptional<z.ZodObject<{
        requestDigest: z.ZodString;
        initialPromptTokens: z.ZodNumber;
        maxPromptTokens: z.ZodNumber;
    }, z.core.$strict>>;
    agentRef: z.ZodOptional<z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>>;
    agentHomeProjection: z.ZodOptional<z.ZodObject<{
        profileRevision: z.ZodString;
        projectionHash: z.ZodString;
    }, z.core.$strict>>;
    agentHomeMemoryChange: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        outcome: z.ZodLiteral<"unchanged">;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"reader-attributed">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unattributed">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unmeasured">;
    }, z.core.$strict>], "outcome">>;
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
    sealed: z.ZodOptional<z.ZodNever>;
    sealing: z.ZodOptional<z.ZodNever>;
    harnessId: z.ZodOptional<z.ZodString>;
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
    agentHomeProjection: z.ZodOptional<z.ZodObject<{
        profileRevision: z.ZodString;
        projectionHash: z.ZodString;
    }, z.core.$strict>>;
    agentHomeMemoryChange: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        outcome: z.ZodLiteral<"unchanged">;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"reader-attributed">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unattributed">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unmeasured">;
    }, z.core.$strict>], "outcome">>;
}, z.core.$strip>;
export type TaskCancelledPayload = z.infer<typeof TaskCancelledPayloadSchema>;
/**
 * daemon -> server: a pending `task.await_approval` was resolved entirely
 * LOCALLY on the device — the local control-socket `approvals.resolve` RPC,
 * a fail-closed `requestApproval` timeout, or a fail-closed eviction/finish
 * rejection (see `packages/client`'s `task-runner.ts`/`approvals.ts`) —
 * *without* a wire `task.approve`/`task.reject` ever having been exchanged
 * for it. Baseline since v4: the daemon reports every local resolution, and
 * this report is the server's only source for one; the server does not infer
 * a resolution from later task activity.
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
 * a later wave could add a DISTINCT value as a gated addition, while the
 * shape stays closed and typed today.
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
/** server -> daemon: `task.offer_for_agent` of a sealed task. */
export declare const TaskOfferForAgentSealedPayloadSchema: z.ZodObject<{
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    homeAccess: z.ZodOptional<z.ZodLiteral<"memory-reader">>;
    agentMemory: z.ZodOptional<z.ZodEnum<{
        none: "none";
        read: "read";
        "read-if-admitted": "read-if-admitted";
        "read-write": "read-write";
        "read-write-if-admitted": "read-write-if-admitted";
    }>>;
    requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    harnessId: z.ZodOptional<z.ZodString>;
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
        schema: z.ZodCustom<import("./result-schema").ResultSchema, import("./result-schema").ResultSchema>;
    }, z.core.$strict>], "mode">>;
    sessionRef: z.ZodOptional<z.ZodString>;
    limits: z.ZodOptional<z.ZodObject<{
        maxDurationMs: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    instruction: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>]>>;
    sealing: z.ZodObject<{
        scopeId: z.ZodString;
        epoch: z.ZodNumber;
        categories: z.ZodArray<z.ZodEnum<{
            "task-input": "task-input";
            "task-output": "task-output";
        }>>;
    }, z.core.$strict>;
    sealed: z.ZodOptional<z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-input">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type TaskOfferForAgentSealedPayload = z.infer<typeof TaskOfferForAgentSealedPayloadSchema>;
/** server -> daemon: `task.offer_for_agent_with_egress` of a sealed task. */
export declare const TaskOfferForAgentWithEgressSealedPayloadSchema: z.ZodObject<{
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    homeAccess: z.ZodOptional<z.ZodLiteral<"memory-reader">>;
    agentMemory: z.ZodOptional<z.ZodEnum<{
        none: "none";
        read: "read";
        "read-if-admitted": "read-if-admitted";
        "read-write": "read-write";
        "read-write-if-admitted": "read-write-if-admitted";
    }>>;
    requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    harnessId: z.ZodOptional<z.ZodString>;
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
        schema: z.ZodCustom<import("./result-schema").ResultSchema, import("./result-schema").ResultSchema>;
    }, z.core.$strict>], "mode">>;
    limits: z.ZodOptional<z.ZodObject<{
        maxDurationMs: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    sessionRef: z.ZodString;
    egressPolicy: z.ZodObject<{
        policyRevision: z.ZodString;
        activity: z.ZodObject<{
            delivery: z.ZodLiteral<"latest-value">;
            maxCoalesceMs: z.ZodNumber;
            maxEventBytes: z.ZodNumber;
        }, z.core.$strict>;
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
    instruction: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>]>>;
    sealing: z.ZodObject<{
        scopeId: z.ZodString;
        epoch: z.ZodNumber;
        categories: z.ZodArray<z.ZodEnum<{
            "task-input": "task-input";
            "task-output": "task-output";
        }>>;
    }, z.core.$strict>;
    sealed: z.ZodOptional<z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-input">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type TaskOfferForAgentWithEgressSealedPayload = z.infer<typeof TaskOfferForAgentWithEgressSealedPayloadSchema>;
/**
 * server -> daemon: `task.offer_for_agent_with_egress_fresh` of a sealed task.
 * Only this type takes `routineRef`: a routine occurrence is an execution.
 */
export declare const TaskOfferForAgentWithEgressFreshSealedPayloadSchema: z.ZodObject<{
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    homeAccess: z.ZodOptional<z.ZodLiteral<"memory-reader">>;
    agentMemory: z.ZodOptional<z.ZodEnum<{
        none: "none";
        read: "read";
        "read-if-admitted": "read-if-admitted";
        "read-write": "read-write";
        "read-write-if-admitted": "read-write-if-admitted";
    }>>;
    requiredToolsets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    runtime: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        pi: "pi";
    }>>;
    harnessId: z.ZodOptional<z.ZodString>;
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
        schema: z.ZodCustom<import("./result-schema").ResultSchema, import("./result-schema").ResultSchema>;
    }, z.core.$strict>], "mode">>;
    limits: z.ZodOptional<z.ZodObject<{
        maxDurationMs: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    egressPolicy: z.ZodObject<{
        policyRevision: z.ZodString;
        activity: z.ZodObject<{
            delivery: z.ZodLiteral<"latest-value">;
            maxCoalesceMs: z.ZodNumber;
            maxEventBytes: z.ZodNumber;
        }, z.core.$strict>;
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
    instruction: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        blobRef: z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>]>>;
    sealing: z.ZodObject<{
        scopeId: z.ZodString;
        epoch: z.ZodNumber;
        categories: z.ZodArray<z.ZodEnum<{
            "task-input": "task-input";
            "task-output": "task-output";
        }>>;
    }, z.core.$strict>;
    sealed: z.ZodOptional<z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-input">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    routineRef: z.ZodOptional<z.ZodObject<{
        routineId: z.ZodString;
        definitionVersion: z.ZodNumber;
        notAfter: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type TaskOfferForAgentWithEgressFreshSealedPayload = z.infer<typeof TaskOfferForAgentWithEgressFreshSealedPayloadSchema>;
/**
 * server -> daemon: sealed steering text. `steerId` names this steer in the
 * AAD and the content MAC, so the Host cannot replay an earlier steer of the
 * same task as a new one.
 */
export declare const TaskSteerSealedPayloadSchema: z.ZodObject<{
    steerId: z.ZodUUID;
    sealed: z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-input">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type TaskSteerSealedPayload = z.infer<typeof TaskSteerSealedPayloadSchema>;
/**
 * daemon -> server: `task.complete` of a sealed task. `summary`,
 * `finalMessage` and `document` are sealed. `artifactRefs` and
 * `preparedObservation` are not carried in v1.
 */
export declare const TaskCompleteSealedPayloadSchema: z.ZodObject<{
    sealing: z.ZodOptional<z.ZodNever>;
    harnessId: z.ZodOptional<z.ZodString>;
    sessionRef: z.ZodString;
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
    agentHomeProjection: z.ZodOptional<z.ZodObject<{
        profileRevision: z.ZodString;
        projectionHash: z.ZodString;
    }, z.core.$strict>>;
    agentHomeMemoryChange: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        outcome: z.ZodLiteral<"unchanged">;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"reader-attributed">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unattributed">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unmeasured">;
    }, z.core.$strict>], "outcome">>;
    sealed: z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-output">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type TaskCompleteSealedPayload = z.infer<typeof TaskCompleteSealedPayloadSchema>;
/** daemon -> server: `task.fail` of a sealed task. `reason` is sealed; `preparedObservation` is not carried in v1. */
export declare const TaskFailSealedPayloadSchema: z.ZodObject<{
    sealing: z.ZodOptional<z.ZodNever>;
    recovery: z.ZodOptional<z.ZodObject<{
        kind: z.ZodLiteral<"daemon_interrupted">;
        offerId: z.ZodUUID;
    }, z.core.$strict>>;
    harnessId: z.ZodOptional<z.ZodString>;
    retryable: z.ZodOptional<z.ZodBoolean>;
    failure: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
        class: z.ZodLiteral<"quota">;
        resetsAt: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strict>, z.ZodObject<{
        class: z.ZodEnum<{
            auth: "auth";
            billing: "billing";
            input_too_large: "input_too_large";
            invalid_request: "invalid_request";
            limit_reached: "limit_reached";
            model_unavailable: "model_unavailable";
            output_schema: "output_schema";
            overloaded: "overloaded";
            provider: "provider";
            rate_limited: "rate_limited";
            runtime_exited: "runtime_exited";
            unknown: "unknown";
        }>;
    }, z.core.$strict>]>>;
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
    agentHomeProjection: z.ZodOptional<z.ZodObject<{
        profileRevision: z.ZodString;
        projectionHash: z.ZodString;
    }, z.core.$strict>>;
    agentHomeMemoryChange: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        outcome: z.ZodLiteral<"unchanged">;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"reader-attributed">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unattributed">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unmeasured">;
    }, z.core.$strict>], "outcome">>;
    sealed: z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-output">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type TaskFailSealedPayload = z.infer<typeof TaskFailSealedPayloadSchema>;
/**
 * daemon -> server: `task.decline` of a sealed task with a sealed `reason`.
 * The sealed decline codes go only on the plaintext `task.decline`: a device
 * that cannot open or use the scope key often cannot seal a reply either.
 */
export declare const TaskDeclineSealedPayloadSchema: z.ZodObject<{
    sealing: z.ZodOptional<z.ZodNever>;
    retryable: z.ZodOptional<z.ZodBoolean>;
    agentRef: z.ZodOptional<z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>>;
    code: z.ZodOptional<z.ZodEnum<{
        agent_home_reader_busy: "agent_home_reader_busy";
        agent_home_writer_busy: "agent_home_writer_busy";
    }>>;
    sealed: z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-output">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type TaskDeclineSealedPayload = z.infer<typeof TaskDeclineSealedPayloadSchema>;
/** daemon -> server: `task.cancelled` of a sealed task. `reason` is sealed. */
export declare const TaskCancelledSealedPayloadSchema: z.ZodObject<{
    sealing: z.ZodOptional<z.ZodNever>;
    harnessId: z.ZodOptional<z.ZodString>;
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
    agentHomeProjection: z.ZodOptional<z.ZodObject<{
        profileRevision: z.ZodString;
        projectionHash: z.ZodString;
    }, z.core.$strict>>;
    agentHomeMemoryChange: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        outcome: z.ZodLiteral<"unchanged">;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"reader-attributed">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unattributed">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unmeasured">;
    }, z.core.$strict>], "outcome">>;
    sealed: z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-output">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type TaskCancelledSealedPayload = z.infer<typeof TaskCancelledSealedPayloadSchema>;
/** daemon -> server: `task.progress` of a sealed task. `events` is sealed; `seq` names the batch. */
export declare const TaskProgressSealedPayloadSchema: z.ZodObject<{
    sealing: z.ZodOptional<z.ZodNever>;
    seq: z.ZodNumber;
    sealed: z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-output">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type TaskProgressSealedPayload = z.infer<typeof TaskProgressSealedPayloadSchema>;
/**
 * daemon -> server: an inline artifact of a sealed task. `inline` is sealed; a
 * blob artifact is not carried in v1. `artifactId` names the write in the AAD
 * and the content MAC, because two artifacts of one task may share a `name`.
 */
export declare const TaskArtifactSealedPayloadSchema: z.ZodObject<{
    sealing: z.ZodOptional<z.ZodNever>;
    name: z.ZodString;
    contentType: z.ZodString;
    artifactId: z.ZodUUID;
    sealed: z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-output">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type TaskArtifactSealedPayload = z.infer<typeof TaskArtifactSealedPayloadSchema>;
/** daemon -> server: `task.await_approval` of a sealed task. `summary` is sealed; `approvalId` is required. */
export declare const TaskAwaitApprovalSealedPayloadSchema: z.ZodObject<{
    sealing: z.ZodOptional<z.ZodNever>;
    approvalId: z.ZodString;
    sealed: z.ZodObject<{
        v: z.ZodLiteral<1>;
        suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
        category: z.ZodLiteral<"task-output">;
        scope: z.ZodObject<{
            id: z.ZodString;
            epoch: z.ZodNumber;
            keyId: z.ZodString;
        }, z.core.$strict>;
        chainHead: z.ZodObject<{
            seq: z.ZodNumber;
            hash: z.ZodString;
        }, z.core.$strict>;
        sender: z.ZodString;
        salt: z.ZodString;
        nonce: z.ZodString;
        paddedLength: z.ZodNumber;
        contentMac: z.ZodString;
        ciphertext: z.ZodOptional<z.ZodString>;
        ciphertextRef: z.ZodOptional<z.ZodObject<{
            blobId: z.ZodString;
            contentHash: z.ZodString;
            size: z.ZodNumber;
            contentType: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type TaskAwaitApprovalSealedPayload = z.infer<typeof TaskAwaitApprovalSealedPayloadSchema>;
/**
 * Protocol-owned task-opening family; the wire registry consumes these same entries.
 *
 * Each value is written `X as typeof X`, here and in `MESSAGE_PAYLOAD_SCHEMAS`.
 * The assertion is type-only (no runtime code). It makes declaration emit
 * name each schema (`typeof X`) instead of copying its full type, which keeps
 * the published `.d.ts` small. Every new entry follows this rule.
 */
declare const TASK_OFFER_PAYLOAD_SCHEMAS: {
    readonly 'task.offer_for_agent': typeof TaskOfferForAgentPayloadSchema;
    readonly 'task.offer_for_agent_with_egress': typeof TaskOfferForAgentWithEgressPayloadSchema;
    readonly 'task.offer_for_agent_with_egress_fresh': typeof TaskOfferForAgentWithEgressFreshPayloadSchema;
    readonly 'task.offer_prepared': typeof TaskOfferPreparedPayloadSchema;
    readonly 'task.offer_for_agent_sealed': typeof TaskOfferForAgentSealedPayloadSchema;
    readonly 'task.offer_for_agent_with_egress_sealed': typeof TaskOfferForAgentWithEgressSealedPayloadSchema;
    readonly 'task.offer_for_agent_with_egress_fresh_sealed': typeof TaskOfferForAgentWithEgressFreshSealedPayloadSchema;
};
export type TaskOfferType = keyof typeof TASK_OFFER_PAYLOAD_SCHEMAS;
export declare const TASK_OFFER_TYPES: readonly TaskOfferType[];
/** Classify task-opening offers without duplicating the protocol registry in consumers. */
export declare function isTaskOfferType(type: string): type is TaskOfferType;
export declare const MESSAGE_PAYLOAD_SCHEMAS: {
    readonly 'task.offer_for_agent': typeof TaskOfferForAgentPayloadSchema;
    readonly 'task.offer_for_agent_with_egress': typeof TaskOfferForAgentWithEgressPayloadSchema;
    readonly 'task.offer_for_agent_with_egress_fresh': typeof TaskOfferForAgentWithEgressFreshPayloadSchema;
    readonly 'task.offer_prepared': typeof TaskOfferPreparedPayloadSchema;
    readonly 'task.offer_for_agent_sealed': typeof TaskOfferForAgentSealedPayloadSchema;
    readonly 'task.offer_for_agent_with_egress_sealed': typeof TaskOfferForAgentWithEgressSealedPayloadSchema;
    readonly 'task.offer_for_agent_with_egress_fresh_sealed': typeof TaskOfferForAgentWithEgressFreshSealedPayloadSchema;
    readonly 'conn.hello': typeof ConnHelloPayloadSchema;
    readonly 'agent.egress.reliable': typeof AgentEgressReliablePayloadSchema;
    readonly 'agent.egress.ack': typeof AgentEgressAckPayloadSchema;
    readonly 'agent.message.draft': typeof AgentMessageDraftPayloadSchema;
    readonly 'agent.message.publish': typeof AgentMessagePublishPayloadSchema;
    readonly 'agent.message.disposition': typeof AgentMessageDispositionPayloadSchema;
    readonly 'agent.content.read': typeof AgentContentReadPayloadSchema;
    readonly 'agent.content.receipt': typeof AgentContentReceiptPayloadSchema;
    readonly 'agent.home.projection': typeof AgentHomeProjectionPayloadSchema;
    readonly 'agent.input.preparation': typeof AgentInputPreparationPayloadSchema;
    readonly 'provider.provisioning.available': typeof ProviderProvisioningAvailablePayloadSchema;
    readonly 'agent.memory.intent.available': typeof AgentMemoryIntentAvailablePayloadSchema;
    readonly 'task.approve': typeof TaskApprovePayloadSchema;
    readonly 'task.reject': typeof TaskRejectPayloadSchema;
    readonly 'task.cancel': typeof TaskCancelPayloadSchema;
    readonly 'task.steer': typeof TaskSteerPayloadSchema;
    readonly 'task.claim': typeof TaskClaimPayloadSchema;
    readonly 'task.started': typeof TaskStartedPayloadSchema;
    readonly 'task.decline': typeof TaskDeclinePayloadSchema;
    readonly 'task.progress': typeof TaskProgressPayloadSchema;
    readonly 'task.artifact': typeof TaskArtifactPayloadSchema;
    readonly 'task.await_approval': typeof TaskAwaitApprovalPayloadSchema;
    readonly 'task.complete': typeof TaskCompletePayloadSchema;
    readonly 'task.fail': typeof TaskFailPayloadSchema;
    readonly 'task.cancelled': typeof TaskCancelledPayloadSchema;
    readonly 'task.approval_resolved': typeof TaskApprovalResolvedPayloadSchema;
    readonly 'task.steer_sealed': typeof TaskSteerSealedPayloadSchema;
    readonly 'task.complete_sealed': typeof TaskCompleteSealedPayloadSchema;
    readonly 'task.fail_sealed': typeof TaskFailSealedPayloadSchema;
    readonly 'task.decline_sealed': typeof TaskDeclineSealedPayloadSchema;
    readonly 'task.cancelled_sealed': typeof TaskCancelledSealedPayloadSchema;
    readonly 'task.progress_sealed': typeof TaskProgressSealedPayloadSchema;
    readonly 'task.artifact_sealed': typeof TaskArtifactSealedPayloadSchema;
    readonly 'task.await_approval_sealed': typeof TaskAwaitApprovalSealedPayloadSchema;
    readonly 'e2ee.key_package.available': typeof E2eeKeyPackageAvailablePayloadSchema;
};
export type MessageType = keyof typeof MESSAGE_PAYLOAD_SCHEMAS;
export declare const MESSAGE_TYPES: MessageType[];
/**
 * Message types the server sends to the daemon. Used by {@link EnvelopeSchema}
 * (`envelope.ts`) to decide which branches require envelope `seq` (M1
 * redelivery cursor).
 */
export declare const SERVER_TO_DAEMON_TYPES: readonly ["task.offer_for_agent", "task.offer_for_agent_with_egress", "task.offer_for_agent_with_egress_fresh", "task.offer_prepared", "agent.egress.ack", "agent.message.disposition", "agent.content.read", "agent.home.projection", "agent.input.preparation", "provider.provisioning.available", "agent.memory.intent.available", "task.approve", "task.reject", "task.cancel", "task.steer", "task.offer_for_agent_sealed", "task.offer_for_agent_with_egress_sealed", "task.offer_for_agent_with_egress_fresh_sealed", "task.steer_sealed", "e2ee.key_package.available"];
/**
 * Message types the daemon sends to the server — the flip side of
 * {@link SERVER_TO_DAEMON_TYPES}. `conn.hello` is deliberately excluded: the
 * inbound gate handles a bearer-authenticated `conn.hello` as a capability
 * snapshot on its own, before the type-allow check.
 *
 * Used by `handleInboundEnvelope` (`@byok-sdk/cloud`'s `inbound.ts`) as the
 * type-allow gate for every inbound `POST /byok/messages` envelope (finding
 * P2): a `type` outside this set — a server -> daemon type arriving inbound,
 * or anything unrecognized — is rejected before it's dispatched to any
 * handler or counted `accepted` on the `/byok/messages` wire.
 */
export declare const DAEMON_TO_SERVER_TYPES: readonly ["task.claim", "task.started", "task.decline", "task.progress", "task.artifact", "task.await_approval", "task.complete", "task.fail", "task.cancelled", "task.approval_resolved", "agent.egress.reliable", "agent.message.draft", "agent.message.publish", "agent.content.receipt", "task.complete_sealed", "task.fail_sealed", "task.decline_sealed", "task.cancelled_sealed", "task.progress_sealed", "task.artifact_sealed", "task.await_approval_sealed"];
export {};
// ==== @byok-sdk/protocol dist/plain-json.d.ts ====
/**
 * Plain-JSON-data canonicalization shared by every bounded JSON channel of
 * the wire: `task.complete.document` (`checkResultDocument`, messages.ts) and
 * the result-document schema and outcome (`result-schema.ts`). One rule, one
 * implementation, so the channels cannot disagree about what "plain JSON
 * data" means or how its canonical UTF-8 size is measured.
 *
 * Zod-free and free of node builtins.
 */
/** Outcome of {@link canonicalizePlainJson} without a depth bound. */
export type PlainJsonCheck = {
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
/** Outcome of {@link canonicalizePlainJson} with a container-nesting bound. */
export type BoundedPlainJsonCheck = PlainJsonCheck | {
    readonly ok: false;
    readonly reason: 'too-deep';
    readonly bytes: number;
};
/**
 * Container nesting depth of pure JSON data (a `JSON.parse` output), computed
 * iteratively so no input can exhaust the call stack. A scalar is depth 0,
 * `{}` and `[]` are depth 1. Stops as soon as `limit` is exceeded.
 */
export declare function jsonDepthExceeds(value: unknown, limit: number): boolean;
/**
 * Canonicalize `value` as plain JSON data within `maxBytes` canonical UTF-8
 * bytes:
 *
 *   1. `JSON.stringify` must succeed and not return `undefined`.
 *   2. Its UTF-8 byte length must be at most `maxBytes`.
 *   3. `JSON.parse` that string: the CANONICAL SNAPSHOT (pure data).
 *   4. With `maxDepth`, the snapshot's container nesting must be at most
 *      `maxDepth`. This runs before step 5, so the recursive comparison
 *      below is bounded by it.
 *   5. The original must be structurally equal to the snapshot
 *      (`isSameJsonData`).
 *
 * On success a sender uses `canonical`, never the original reference.
 */
export declare function canonicalizePlainJson(value: unknown, maxBytes: number): PlainJsonCheck;
export declare function canonicalizePlainJson(value: unknown, maxBytes: number, maxDepth: number): BoundedPlainJsonCheck;
// ==== @byok-sdk/protocol dist/provider-profile-binding.d.ts ====
import { z } from 'zod';
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
// ==== @byok-sdk/protocol dist/provider-provisioning.d.ts ====
import { z } from 'zod';
/**
 * Sealed provider provisioning — the wire half.
 *
 * A Host provisions a device-local provider profile (and its API key) without
 * the key ever crossing this SDK's wire. The ciphertext, its configuration and
 * the device's pull of both travel over the HOST's own authenticated device
 * routes; this package defines only:
 *
 * - the task-free server -> daemon notice `provider.provisioning.available`,
 *   whose payload is exactly `{ requestId }` (see `messages.ts`);
 * - the device capability that gates that notice;
 * - the credential-free completion a device reports and the durable readback a
 *   Host returns for it;
 * - the device-proof operation name a device signs when it registers its
 *   provider-secret sealing key.
 *
 * Notice-and-fetch is the point: the daemon journals mailbox rows before they
 * are acknowledged and a mailbox never deletes an unacknowledged row, so a
 * ciphertext carried inside the envelope would outlive the provisioning window
 * in two places. The strict one-field payload makes that unrepresentable.
 *
 * Audiences, route paths and product names are Host vocabulary and stay out of
 * this package.
 */
/**
 * Device-proof `operation` for the signed claim that registers the device's
 * provider-secret sealing public key (`{ keyId, epoch, publicJwk }`).
 */
export declare const PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION: 'provider-secret-sealing-key.register';
/**
 * Server -> daemon: a provisioning request is waiting for this device.
 *
 * `.strict()` and exactly one field. There is deliberately no configuration,
 * no ciphertext, no provider identity and no Agent identity: the device fetches
 * all of that from the Host under its own device authentication, so a mailbox
 * row or journal line never holds more than an opaque request id.
 */
export declare const ProviderProvisioningAvailablePayloadSchema: z.ZodObject<{
    requestId: z.ZodUUID;
}, z.core.$strict>;
export type ProviderProvisioningAvailablePayload = z.infer<typeof ProviderProvisioningAvailablePayloadSchema>;
export declare const PROVIDER_PROVISIONING_OPERATIONS: readonly ['configure', 'update_model', 'replace_secret', 'delete'];
export declare const ProviderProvisioningOperationSchema: z.ZodEnum<{
    configure: "configure";
    delete: "delete";
    replace_secret: "replace_secret";
    update_model: "update_model";
}>;
export type ProviderProvisioningOperation = z.infer<typeof ProviderProvisioningOperationSchema>;
/** PostgreSQL BIGINT maximum, carried as decimal text to avoid JavaScript precision loss. */
export declare const PROVIDER_PROVISIONING_OPERATION_GENERATION_MAXIMUM: '9223372036854775807';
/**
 * Non-secret, monotonic per-profile operation generation. It is bound into the
 * sealed request's associated data and into the device's local state, so an
 * older generation is always refused. Canonical positive decimal text.
 */
export declare const ProviderProvisioningOperationGenerationSchema: z.ZodString;
export type ProviderProvisioningOperationGeneration = z.infer<typeof ProviderProvisioningOperationGenerationSchema>;
/**
 * SHA-256 of the canonical non-secret operation the device evaluated. Two
 * completions for one request id are the same result only when this digest
 * (and the rest of the completion) is identical. Pinned to `@byok-sdk/core`
 * `providerProvisioningRequestDigest(request)` (the value `@byok-sdk/keys`
 * returns as `result.requestDigest`); see docs/protocol.md §2.3.
 */
export declare const ProviderProvisioningOperationDigestSchema: z.ZodString;
export type ProviderProvisioningOperationDigest = z.infer<typeof ProviderProvisioningOperationDigestSchema>;
/**
 * Closed rejection set. Codes name a failed check, never a value: no plaintext,
 * no ciphertext, no OS error detail. `local_commit_interrupted` also covers a
 * request that finds the same or another operation still pending locally.
 *
 * `request_expired` and `sealing_key_rotated` may also be decided by the Host
 * before the device ever completes the request (see
 * {@link PROVIDER_PROVISIONING_HOST_TERMINAL_CODES}).
 */
export declare const PROVIDER_PROVISIONING_REJECTION_CODES: readonly ['request_invalid', 'request_conflict', 'request_expired', 'request_not_yet_valid', 'request_window_invalid', 'sealing_key_rotated', 'enrollment_mismatch', 'agent_not_placed', 'config_digest_mismatch', 'operation_generation_stale', 'profile_changed', 'profile_not_found', 'credential_scope_mismatch', 'provider_kind_unsupported', 'pi_model_invalid', 'capabilities_invalid', 'seal_open_failed', 'secret_invalid', 'local_commit_interrupted', 'secret_store_unavailable'];
export declare const ProviderProvisioningRejectionCodeSchema: z.ZodEnum<{
    agent_not_placed: "agent_not_placed";
    capabilities_invalid: "capabilities_invalid";
    config_digest_mismatch: "config_digest_mismatch";
    credential_scope_mismatch: "credential_scope_mismatch";
    enrollment_mismatch: "enrollment_mismatch";
    local_commit_interrupted: "local_commit_interrupted";
    operation_generation_stale: "operation_generation_stale";
    pi_model_invalid: "pi_model_invalid";
    profile_changed: "profile_changed";
    profile_not_found: "profile_not_found";
    provider_kind_unsupported: "provider_kind_unsupported";
    request_conflict: "request_conflict";
    request_expired: "request_expired";
    request_invalid: "request_invalid";
    request_not_yet_valid: "request_not_yet_valid";
    request_window_invalid: "request_window_invalid";
    seal_open_failed: "seal_open_failed";
    sealing_key_rotated: "sealing_key_rotated";
    secret_invalid: "secret_invalid";
    secret_store_unavailable: "secret_store_unavailable";
}>;
export type ProviderProvisioningRejectionCode = z.infer<typeof ProviderProvisioningRejectionCodeSchema>;
/** Rejections a Host may record on its own authority, without a device completion. */
export declare const PROVIDER_PROVISIONING_HOST_TERMINAL_CODES: readonly ["request_expired", "sealing_key_rotated"];
/**
 * Credential-free projection of the device's provider status after an applied
 * operation. It reports WHETHER a secret is configured, never the secret, and
 * carries no endpoint or auth material: those stay device-local.
 */
export declare const ProviderProvisioningProviderStatusSchema: z.ZodObject<{
    profileRef: z.ZodString;
    providerKind: z.ZodString;
    modelId: z.ZodString;
    capabilities: z.ZodArray<z.ZodEnum<{
        "image-input": "image-input";
    }>>;
    secretConfigured: z.ZodBoolean;
}, z.core.$strict>;
export type ProviderProvisioningProviderStatus = z.infer<typeof ProviderProvisioningProviderStatusSchema>;
/**
 * Closed outcome set of the device's one post-apply check of the stored key
 * against its vendor. It is a HINT for the Host UI, never a readiness input:
 * a saved key is not a validated key, and a network failure does not block
 * provisioning.
 *
 * - `credential_rejected`: the vendor explicitly refused the credential.
 * - `rate_limited`, `quota_or_billing`, `model_not_permitted`: the credential
 *   was accepted but the call could not be served for that reason.
 * - `provider_error`: the vendor answered with an error that is none of the
 *   classes above.
 * - `unreachable`, `timeout`: no vendor answer within the device's bounds.
 * - `not_run`: no check was made (for example `delete`, or an endpoint without
 *   credential auth).
 *
 * No vendor text, status body or error detail crosses this boundary.
 */
export declare const PROVIDER_PROVISIONING_KEY_CHECK_RESULTS: readonly ['ok', 'credential_rejected', 'rate_limited', 'quota_or_billing', 'model_not_permitted', 'provider_error', 'unreachable', 'timeout', 'not_run'];
export declare const ProviderProvisioningKeyCheckResultSchema: z.ZodEnum<{
    credential_rejected: "credential_rejected";
    model_not_permitted: "model_not_permitted";
    not_run: "not_run";
    ok: "ok";
    provider_error: "provider_error";
    quota_or_billing: "quota_or_billing";
    rate_limited: "rate_limited";
    timeout: "timeout";
    unreachable: "unreachable";
}>;
export type ProviderProvisioningKeyCheckResult = z.infer<typeof ProviderProvisioningKeyCheckResultSchema>;
export declare const ProviderProvisioningKeyCheckSchema: z.ZodObject<{
    result: z.ZodEnum<{
        credential_rejected: "credential_rejected";
        model_not_permitted: "model_not_permitted";
        not_run: "not_run";
        ok: "ok";
        provider_error: "provider_error";
        quota_or_billing: "quota_or_billing";
        rate_limited: "rate_limited";
        timeout: "timeout";
        unreachable: "unreachable";
    }>;
}, z.core.$strict>;
export type ProviderProvisioningKeyCheck = z.infer<typeof ProviderProvisioningKeyCheckSchema>;
/**
 * The terminal, credential-free result of one provisioning request, reported
 * by the device to the Host.
 *
 * `applied` carries the post-operation status and exact binding — both absent
 * (`null`) for `delete` and only for `delete`. `configure` and
 * `replace_secret` write a secret, so an applied result for either must report
 * `secretConfigured: true`. `replace_secret` leaves the profile revision and
 * hash unchanged; the binding it reports is the same exact binding as before.
 * Every applied result carries the required `keyCheck` hint; a `delete` has no
 * key left to check and must report `not_run`.
 */
export declare const ProviderProvisioningCompletionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    requestId: z.ZodUUID;
    operation: z.ZodEnum<{
        configure: "configure";
        delete: "delete";
        replace_secret: "replace_secret";
        update_model: "update_model";
    }>;
    operationGeneration: z.ZodString;
    operationDigest: z.ZodString;
    outcome: z.ZodLiteral<"applied">;
    providerStatus: z.ZodNullable<z.ZodObject<{
        profileRef: z.ZodString;
        providerKind: z.ZodString;
        modelId: z.ZodString;
        capabilities: z.ZodArray<z.ZodEnum<{
            "image-input": "image-input";
        }>>;
        secretConfigured: z.ZodBoolean;
    }, z.core.$strict>>;
    binding: z.ZodNullable<z.ZodObject<{
        profileRef: z.ZodString;
        profileRevision: z.ZodString;
        profileHash: z.ZodString;
        modelId: z.ZodString;
        requiredCapabilities: z.ZodArray<z.ZodEnum<{
            "image-input": "image-input";
        }>>;
    }, z.core.$strict>>;
    keyCheck: z.ZodObject<{
        result: z.ZodEnum<{
            credential_rejected: "credential_rejected";
            model_not_permitted: "model_not_permitted";
            not_run: "not_run";
            ok: "ok";
            provider_error: "provider_error";
            quota_or_billing: "quota_or_billing";
            rate_limited: "rate_limited";
            timeout: "timeout";
            unreachable: "unreachable";
        }>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    requestId: z.ZodUUID;
    operation: z.ZodEnum<{
        configure: "configure";
        delete: "delete";
        replace_secret: "replace_secret";
        update_model: "update_model";
    }>;
    operationGeneration: z.ZodString;
    operationDigest: z.ZodString;
    outcome: z.ZodLiteral<"rejected">;
    code: z.ZodEnum<{
        agent_not_placed: "agent_not_placed";
        capabilities_invalid: "capabilities_invalid";
        config_digest_mismatch: "config_digest_mismatch";
        credential_scope_mismatch: "credential_scope_mismatch";
        enrollment_mismatch: "enrollment_mismatch";
        local_commit_interrupted: "local_commit_interrupted";
        operation_generation_stale: "operation_generation_stale";
        pi_model_invalid: "pi_model_invalid";
        profile_changed: "profile_changed";
        profile_not_found: "profile_not_found";
        provider_kind_unsupported: "provider_kind_unsupported";
        request_conflict: "request_conflict";
        request_expired: "request_expired";
        request_invalid: "request_invalid";
        request_not_yet_valid: "request_not_yet_valid";
        request_window_invalid: "request_window_invalid";
        seal_open_failed: "seal_open_failed";
        sealing_key_rotated: "sealing_key_rotated";
        secret_invalid: "secret_invalid";
        secret_store_unavailable: "secret_store_unavailable";
    }>;
}, z.core.$strict>], "outcome">;
export type ProviderProvisioningCompletion = z.infer<typeof ProviderProvisioningCompletionSchema>;
/**
 * How the Host's durable record relates to the completion it was handed:
 *
 * - `recorded`: this completion became the request's first terminal fact.
 * - `idempotent`: an identical completion (same operation digest and result)
 *   was already recorded; the stored result is returned and nothing is
 *   rewritten.
 * - `conflict`: a different completion (different operation digest or result)
 *   is already recorded; the stored one is returned unchanged.
 * - `host_terminal`: the Host had already terminated the request on its own
 *   authority ({@link PROVIDER_PROVISIONING_HOST_TERMINAL_CODES}), for example
 *   because it expired before the device fetched it.
 */
export declare const PROVIDER_PROVISIONING_DISPOSITIONS: readonly ['recorded', 'idempotent', 'conflict', 'host_terminal'];
export declare const ProviderProvisioningDispositionSchema: z.ZodEnum<{
    conflict: "conflict";
    host_terminal: "host_terminal";
    idempotent: "idempotent";
    recorded: "recorded";
}>;
export type ProviderProvisioningDisposition = z.infer<typeof ProviderProvisioningDispositionSchema>;
/**
 * The Host's durable terminal readback for one provisioning request.
 *
 * `completion` is the terminal fact the Host has STORED, which on `conflict`
 * is not the one the device submitted. Every readback is terminal — there is
 * no `pending` — so a daemon that holds one may acknowledge the notice: an
 * expired, rotated, rejected or conflicting request is a deterministic end
 * state that no redelivery can change.
 */
export declare const ProviderProvisioningReadbackSchema: z.ZodObject<{
    tenantId: z.ZodString;
    deviceId: z.ZodString;
    requestId: z.ZodUUID;
    disposition: z.ZodEnum<{
        conflict: "conflict";
        host_terminal: "host_terminal";
        idempotent: "idempotent";
        recorded: "recorded";
    }>;
    completion: z.ZodDiscriminatedUnion<[z.ZodObject<{
        requestId: z.ZodUUID;
        operation: z.ZodEnum<{
            configure: "configure";
            delete: "delete";
            replace_secret: "replace_secret";
            update_model: "update_model";
        }>;
        operationGeneration: z.ZodString;
        operationDigest: z.ZodString;
        outcome: z.ZodLiteral<"applied">;
        providerStatus: z.ZodNullable<z.ZodObject<{
            profileRef: z.ZodString;
            providerKind: z.ZodString;
            modelId: z.ZodString;
            capabilities: z.ZodArray<z.ZodEnum<{
                "image-input": "image-input";
            }>>;
            secretConfigured: z.ZodBoolean;
        }, z.core.$strict>>;
        binding: z.ZodNullable<z.ZodObject<{
            profileRef: z.ZodString;
            profileRevision: z.ZodString;
            profileHash: z.ZodString;
            modelId: z.ZodString;
            requiredCapabilities: z.ZodArray<z.ZodEnum<{
                "image-input": "image-input";
            }>>;
        }, z.core.$strict>>;
        keyCheck: z.ZodObject<{
            result: z.ZodEnum<{
                credential_rejected: "credential_rejected";
                model_not_permitted: "model_not_permitted";
                not_run: "not_run";
                ok: "ok";
                provider_error: "provider_error";
                quota_or_billing: "quota_or_billing";
                rate_limited: "rate_limited";
                timeout: "timeout";
                unreachable: "unreachable";
            }>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        requestId: z.ZodUUID;
        operation: z.ZodEnum<{
            configure: "configure";
            delete: "delete";
            replace_secret: "replace_secret";
            update_model: "update_model";
        }>;
        operationGeneration: z.ZodString;
        operationDigest: z.ZodString;
        outcome: z.ZodLiteral<"rejected">;
        code: z.ZodEnum<{
            agent_not_placed: "agent_not_placed";
            capabilities_invalid: "capabilities_invalid";
            config_digest_mismatch: "config_digest_mismatch";
            credential_scope_mismatch: "credential_scope_mismatch";
            enrollment_mismatch: "enrollment_mismatch";
            local_commit_interrupted: "local_commit_interrupted";
            operation_generation_stale: "operation_generation_stale";
            pi_model_invalid: "pi_model_invalid";
            profile_changed: "profile_changed";
            profile_not_found: "profile_not_found";
            provider_kind_unsupported: "provider_kind_unsupported";
            request_conflict: "request_conflict";
            request_expired: "request_expired";
            request_invalid: "request_invalid";
            request_not_yet_valid: "request_not_yet_valid";
            request_window_invalid: "request_window_invalid";
            seal_open_failed: "seal_open_failed";
            sealing_key_rotated: "sealing_key_rotated";
            secret_invalid: "secret_invalid";
            secret_store_unavailable: "secret_store_unavailable";
        }>;
    }, z.core.$strict>], "outcome">;
    completedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type ProviderProvisioningReadback = z.infer<typeof ProviderProvisioningReadbackSchema>;
// ==== @byok-sdk/protocol dist/result-schema.d.ts ====
/** Maximum canonical JSON UTF-8 size of a result-document schema. */
export declare const RESULT_SCHEMA_MAX_BYTES = 16384;
/** Maximum canonical JSON UTF-8 size of a submitted outcome document. */
export declare const RESULT_OUTCOME_MAX_BYTES = 65536;
/**
 * Maximum subschema nesting below the root (each `properties` member, `items`
 * and `oneOf` branch is one level). With the 16 KiB cap this bounds how much
 * schema structure one validation walks.
 */
export declare const RESULT_SCHEMA_MAX_DEPTH = 32;
/**
 * Maximum JSON container nesting of a schema or outcome document, checked
 * iteratively before any recursive routine runs on it.
 */
export declare const RESULT_JSON_MAX_DEPTH = 128;
/** Maximum number of issues one failed check reports. */
export declare const RESULT_ISSUES_MAX_COUNT = 20;
/** Maximum UTF-8 size of the reported issue list, as JSON. */
export declare const RESULT_ISSUES_MAX_BYTES = 4096;
export declare const RESULT_SCHEMA_KEYWORDS: readonly ["type", "properties", "required", "additionalProperties", "items", "enum", "const", "oneOf", "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum", "description"];
export type ResultSchemaKeyword = (typeof RESULT_SCHEMA_KEYWORDS)[number];
export declare const RESULT_SCHEMA_INSTANCE_TYPES: readonly ["object", "array", "string", "number", "integer", "boolean", "null"];
export type ResultSchemaInstanceType = (typeof RESULT_SCHEMA_INSTANCE_TYPES)[number];
/** A schema inside the admitted subset. Only {@link checkResultSchema} proves a value is one. */
export interface ResultSchema {
    readonly type?: ResultSchemaInstanceType | readonly ResultSchemaInstanceType[];
    readonly properties?: {
        readonly [name: string]: ResultSchema;
    };
    readonly required?: readonly string[];
    readonly additionalProperties?: false;
    readonly items?: ResultSchema;
    readonly enum?: readonly unknown[];
    readonly const?: unknown;
    readonly oneOf?: readonly ResultSchema[];
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly minItems?: number;
    readonly maxItems?: number;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly description?: string;
}
/**
 * One bounded failure detail. `pointer` is an RFC 6901 JSON Pointer into the
 * checked document: the schema for admission issues, the outcome for
 * validation issues (`''` is the document root). `keyword` is the JSON Schema
 * keyword at fault, or a document-level code: `not-serializable`,
 * `not-plain-json`, `over-cap`, `too-deep` (JSON nesting), `schema` (a
 * subschema that is not an object) or `depth` (subschema nesting).
 */
export interface ResultIssue {
    readonly pointer: string;
    readonly keyword: string;
    readonly message: string;
}
/** Document-level failure shared by the schema and outcome checks. */
export type ResultDocumentFailureReason = 'not-serializable' | 'not-plain-json' | 'over-cap' | 'too-deep';
interface ResultFailure<Reason extends string> {
    readonly ok: false;
    readonly reason: Reason;
    /** Canonical UTF-8 size, when it was measured. */
    readonly bytes?: number;
    /** At least one issue; at most {@link RESULT_ISSUES_MAX_COUNT} and {@link RESULT_ISSUES_MAX_BYTES}. */
    readonly issues: readonly ResultIssue[];
    /** True when issues were dropped to respect the caps. */
    readonly truncated: boolean;
}
export type ResultSchemaCheck = {
    readonly ok: true;
    readonly bytes: number;
    readonly canonical: ResultSchema;
} | ResultFailure<ResultDocumentFailureReason | 'not-subset'>;
export type ResultOutcomeCheck = {
    readonly ok: true;
    readonly bytes: number;
    readonly canonical: unknown;
} | ResultFailure<'schema-not-admitted' | ResultDocumentFailureReason | 'schema-mismatch'>;
/**
 * The admission guard for a result-document schema. Accepts only plain JSON
 * data of at most {@link RESULT_SCHEMA_MAX_BYTES} canonical UTF-8 bytes that
 * lies inside the subset (module comment). On success, `canonical` is the
 * snapshot every party freezes and validates against.
 */
export declare function checkResultSchema(schema: unknown): ResultSchemaCheck;
/**
 * Validate one outcome document against a result schema. The guard
 * ({@link checkResultSchema}) always runs first; a schema it refuses is
 * `schema-not-admitted` and never reaches the library. The outcome must be
 * plain JSON data of at most {@link RESULT_OUTCOME_MAX_BYTES} canonical UTF-8
 * bytes, checked before validation. On success, `canonical` is the snapshot
 * a sender stages and puts on the wire.
 */
export declare function validateResultOutcome(schema: unknown, outcome: unknown): ResultOutcomeCheck;
/**
 * Conservative canonical UTF-8 bound, or null for an invalid or unbounded schema.
 * Strings cost at most 6 bytes per code point. Number costs 25; integer costs
 * 24, tightened only when both ends have magnitude below 1e21. A bound need
 * not be attainable when constraints intersect or oneOf branches overlap.
 */
export declare function resultOutcomeMaxBytes(schema: ResultSchema): number | null;
export {};
// ==== @byok-sdk/protocol dist/sealed-payload.d.ts ====
/**
 * Sealed payload v1 on the hosted wire (#654 design §8.1, §8.3, §8.6).
 *
 * Each sealed message type (`task.complete_sealed`, …) is its plaintext type
 * without the fields one data category moves into the ciphertext, plus a
 * sealed member. The type, not a field, is gated, so a decoder that does not
 * know `sealed-payload-v1` refuses the whole message. The Host reads only the
 * sealed member's outer fields. It checks the shape here:
 * version, suite, encodings, a legal padded length, and exactly one of inline
 * `ciphertext` and `ciphertextRef`. Inline is the only legal form up to
 * {@link SEALED_INLINE_MAX_PADDED_LENGTH}; above it, the ciphertext is a blob.
 * So one content has one legal wire form, and two submissions compare by
 * their outer fields only.
 *
 * `@byok-sdk/core/sealed-payload` seals and opens the bytes. Protocol does
 * not depend on core, so this module repeats the header rules and the padded
 * length function; a cross-package test keeps the two equal.
 */
import { z } from 'zod';
export { SEALED_SPLIT_TABLE, isSealedMessageType } from './sealed-split-table';
export type { SealedDigestRule, SealedMessageType, SealedSplitEntry } from './sealed-split-table';
export declare const SEALED_PAYLOAD_VERSION = 1;
/** The only suite v1 admits. A new suite is a new constant and a new capability, never a parser branch. */
export declare const SEALED_PAYLOAD_SUITE = "byok-sealed-v1.hkdf-sha256.aes-256-gcm";
/** C1–C4 in canonical order. A task lists its sealing categories in this order. */
export declare const SEALED_PAYLOAD_CATEGORIES: readonly ['task-input', 'agent-message', 'task-output', 'memory-projection'];
export type SealedPayloadCategory = (typeof SEALED_PAYLOAD_CATEGORIES)[number];
/**
 * The categories a v1 task may seal (D17): task input and task output. Agent
 * messages, memory projections, input preparation and drafts come later.
 */
export declare const SEALED_PAYLOAD_V1_CATEGORIES: readonly ['task-input', 'task-output'];
export type SealedPayloadV1Category = (typeof SEALED_PAYLOAD_V1_CATEGORIES)[number];
/**
 * Closed `task.decline` codes of a receiver that refuses sealed task input
 * (§8.3). They are plaintext: a device without the scope key cannot seal a
 * reason. A device sends them only to a server that advertised
 * `sealed-payload-v1`.
 */
export declare const SEALED_DECLINE_CODES: readonly ['sealed_key_unavailable', 'sealed_open_failed', 'sealed_content_mac_mismatch', 'sealing_policy_mismatch'];
export type SealedDeclineCode = (typeof SEALED_DECLINE_CODES)[number];
/**
 * The closed plaintext codes of a task whose output is sealed (#654 12d).
 * It lists each plaintext output type that has a plaintext form on such a
 * task, with the codes that each field moved or dropped by its sealed type
 * may hold. Such a field that is not listed here must be absent. An output
 * type with a sealed form that is not listed has no plaintext form. An
 * interrupted task reports `daemon_interrupted`; a device that cannot seal
 * reports `sealed_key_unavailable`. The Host check, the daemon and the member
 * display read this one list, and compare by exact match.
 */
export declare const SEALED_TASK_PLAIN_CODES: Readonly<{
    readonly 'task.fail': {
        readonly reason: readonly ["daemon_interrupted", "sealed_key_unavailable"];
    };
    readonly 'task.decline': {
        readonly reason: readonly ["sealed_key_unavailable", "sealed_open_failed", "sealed_content_mac_mismatch", "sealing_policy_mismatch"];
    };
    readonly 'task.cancelled': {
        readonly reason: readonly [];
    };
}>;
/**
 * True when `payload` is a legal plaintext `type` message of a task whose
 * output is sealed: each field that a `task-output` sealed type of `type`
 * moves or drops is absent or holds one of {@link SEALED_TASK_PLAIN_CODES}.
 * A type that has a sealed output form and is not listed there is never
 * legal. A plaintext decline also names its code as `code`. A type with no
 * sealed output form is always legal.
 */
export declare function isSealedTaskPlainOutput(type: string, payload: object): boolean;
/** Padded frames above this length travel as a ciphertext blob (§8.6). */
export declare const SEALED_INLINE_MAX_PADDED_LENGTH: number;
/** Plaintext limit of every v1 category, in UTF-8 bytes of canonical JSON (D8). */
export declare const SEALED_PAYLOAD_MAX_CONTENT_LENGTH: number;
/**
 * The one legal padded length of a frame of `frameLength` bytes
 * (`4 + contentLength`): the next multiple of 256 up to 16 KiB, Padmé above.
 */
export declare function sealedPayloadPaddedLength(frameLength: number): number;
/** The largest padded length a v1 content may have. */
export declare const SEALED_PAYLOAD_MAX_PADDED_LENGTH: number;
/**
 * The byte length of canonical unpadded base64url, or `undefined`. Canonical
 * means no padding, no impossible length, and zero unused bits in the last
 * character, so one byte string has exactly one encoding.
 */
export declare function sealedBase64UrlByteLength(value: string): number | undefined;
/** A sealed member of any v1 category. */
export declare const SealedPayloadSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
    category: z.ZodEnum<{
        "task-input": "task-input";
        "task-output": "task-output";
    }>;
    scope: z.ZodObject<{
        id: z.ZodString;
        epoch: z.ZodNumber;
        keyId: z.ZodString;
    }, z.core.$strict>;
    chainHead: z.ZodObject<{
        seq: z.ZodNumber;
        hash: z.ZodString;
    }, z.core.$strict>;
    sender: z.ZodString;
    salt: z.ZodString;
    nonce: z.ZodString;
    paddedLength: z.ZodNumber;
    contentMac: z.ZodString;
    ciphertext: z.ZodOptional<z.ZodString>;
    ciphertextRef: z.ZodOptional<z.ZodObject<{
        blobId: z.ZodString;
        contentHash: z.ZodString;
        size: z.ZodNumber;
        contentType: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type SealedPayload = z.infer<typeof SealedPayloadSchema>;
/** The sealed member of a task-input message (offers, steer). */
export declare const SealedTaskInputSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
    category: z.ZodLiteral<"task-input">;
    scope: z.ZodObject<{
        id: z.ZodString;
        epoch: z.ZodNumber;
        keyId: z.ZodString;
    }, z.core.$strict>;
    chainHead: z.ZodObject<{
        seq: z.ZodNumber;
        hash: z.ZodString;
    }, z.core.$strict>;
    sender: z.ZodString;
    salt: z.ZodString;
    nonce: z.ZodString;
    paddedLength: z.ZodNumber;
    contentMac: z.ZodString;
    ciphertext: z.ZodOptional<z.ZodString>;
    ciphertextRef: z.ZodOptional<z.ZodObject<{
        blobId: z.ZodString;
        contentHash: z.ZodString;
        size: z.ZodNumber;
        contentType: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** The sealed member of a task-output message. */
export declare const SealedTaskOutputSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
    category: z.ZodLiteral<"task-output">;
    scope: z.ZodObject<{
        id: z.ZodString;
        epoch: z.ZodNumber;
        keyId: z.ZodString;
    }, z.core.$strict>;
    chainHead: z.ZodObject<{
        seq: z.ZodNumber;
        hash: z.ZodString;
    }, z.core.$strict>;
    sender: z.ZodString;
    salt: z.ZodString;
    nonce: z.ZodString;
    paddedLength: z.ZodNumber;
    contentMac: z.ZodString;
    ciphertext: z.ZodOptional<z.ZodString>;
    ciphertextRef: z.ZodOptional<z.ZodObject<{
        blobId: z.ZodString;
        contentHash: z.ZodString;
        size: z.ZodNumber;
        contentType: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
/**
 * A task's frozen sealing policy (§6.2). The offer carries it in plaintext.
 * `epoch` is the epoch of the offer's task-input content, and the lowest epoch
 * the task accepts.
 */
export declare const TaskSealingSchema: z.ZodObject<{
    scopeId: z.ZodString;
    epoch: z.ZodNumber;
    categories: z.ZodArray<z.ZodEnum<{
        "task-input": "task-input";
        "task-output": "task-output";
    }>>;
}, z.core.$strict>;
export type TaskSealing = z.infer<typeof TaskSealingSchema>;
/**
 * The routine template of a sealed execution (design §6.3). The offer's
 * `sealed` member is then the template, family `routine.template`, which the
 * member sealed once for every occurrence. The device rebuilds its binding
 * from these fields: identity `{ routineId, definitionVersion }`, no device,
 * the offer's `agentRef` and `sealing.categories`, and `notAfter`. They travel
 * in plaintext because the AAD binds them. `definitionVersion` is an integer,
 * because the binding tells `4` and `"4"` apart. The device, not the Host,
 * checks `notAfter` against its clock.
 */
export declare const RoutineRefSchema: z.ZodObject<{
    routineId: z.ZodString;
    definitionVersion: z.ZodNumber;
    notAfter: z.ZodString;
}, z.core.$strict>;
/**
 * The rule of a sealed offer, for `superRefine`: `sealed` is present exactly
 * when the task's `sealing` includes `task-input`, and then `instruction` is
 * absent and `sealed.scope` is the task's scope at the task's epoch. When the
 * task seals only its output, `instruction` is plaintext and required. A
 * `routineRef` names a routine template, which is sealed task input, so it
 * needs a task that seals `task-input`.
 *
 * Whether a task's later messages must be sealed is the Host's and the
 * device's check: they know the task's `sealing`, this payload does not.
 */
export declare function sealedOfferRule(payload: {
    readonly instruction?: unknown;
    readonly sealing: TaskSealing;
    readonly sealed?: SealedPayload;
    readonly routineRef?: unknown;
}, ctx: z.RefinementCtx): void;
// ==== @byok-sdk/protocol dist/sealed-split-table.d.ts ====
/**
 * The split table of sealed payload v1 (#654 design §8.1, §9.3): for each
 * sealed message type, its plaintext type, its data category, its identity
 * fields, the fields that move into the ciphertext, the fields it drops, and
 * the rule of each digest field (D16).
 *
 * Plain data with no runtime imports, so `wire-additions.ts` can derive the
 * sealed gates from it and stay free of zod.
 */
import type { MessageType } from './messages';
import type { SealedPayloadV1Category } from './sealed-payload';
/**
 * How a sealed message type treats one digest field of its plaintext type
 * (D16, design §9.3).
 *
 * - `ciphertext-sha256`: the SHA-256 of the sealed bytes, for a Host that
 *   checks the bytes it stores (a ciphertext blob).
 * - `keyed-mac`: a keyed MAC under the scope's MAC key; the Host forwards it.
 * - `sealed`: the field moves into the ciphertext with its parent.
 * - `plain`: a digest that no sealed content derives, kept in plaintext.
 * - `forbidden`: the sealed type does not carry it in v1.
 */
export type SealedDigestRule = 'ciphertext-sha256' | 'keyed-mac' | 'sealed' | 'plain' | 'forbidden';
/** One sealed message type in the split table. */
export interface SealedSplitEntry {
    /**
     * The plaintext message type this type seals. The AAD and the content MAC
     * bind it as the family, not the sealed wire type.
     */
    readonly plainType: MessageType;
    readonly category: SealedPayloadV1Category;
    /**
     * Payload fields that, after the envelope `task_id`, name this write in the
     * AAD and the content MAC (§8.2, §9.1). The sealed type requires them.
     */
    readonly identity: readonly string[];
    /**
     * Top-level fields of the plaintext type that move into the ciphertext.
     * The sealed type does not have them; the receiver merges the opened
     * object back and validates the plaintext type.
     */
    readonly moved: readonly string[];
    /** Top-level fields of the plaintext type that the sealed type drops in v1. */
    readonly forbidden: readonly string[];
    /**
     * Every path of the plaintext type whose name contains `digest`, `hash` or
     * `revision` (case-insensitive), with its rule. A schema test keeps this
     * complete.
     */
    readonly digests: {
        readonly [path: string]: SealedDigestRule;
    };
    /**
     * UTF-8 byte limits of moved fields that replace the plaintext type's limit
     * of that field after the merge (decision 12b). The category limit still
     * bounds the whole opened content.
     */
    readonly limits?: {
        readonly [field: string]: number;
    };
    /**
     * The sealed form carries inline ciphertext only, never `ciphertextRef`
     * (decision 12e). The Host keeps it in a tail row that expires, so it holds
     * no blob for it. The schema does not check this; the Host and the device do.
     */
    readonly inlineOnly?: true;
}
/**
 * The split table (design §8.3): each sealed message type, the plaintext type
 * it seals, its category, identity, moved and forbidden fields, and the rule
 * of each digest field. It is the one authority; the schemas, the Host's
 * comparison projection and the receiver's merge read it.
 *
 * A sealed offer also carries the task's `sealing`. When the categories
 * include `task-input`, `instruction` is sealed; otherwise it stays plaintext
 * and only the task output is sealed.
 *
 * Blob bytes have no sealing rule yet, so a sealed type carries no plaintext
 * blob reference: `artifactRefs` and the artifact `blobRef` are dropped until
 * that rule exists. A sealed artifact is inline content, so its `inline`
 * takes up to 2 MiB instead of the plaintext 64 KB (decision 12b).
 */
export declare const SEALED_SPLIT_TABLE: Readonly<{
    readonly 'task.offer_for_agent_sealed': SealedSplitEntry;
    readonly 'task.offer_for_agent_with_egress_sealed': SealedSplitEntry;
    readonly 'task.offer_for_agent_with_egress_fresh_sealed': SealedSplitEntry;
    readonly 'task.steer_sealed': {
        readonly plainType: 'task.steer';
        readonly category: 'task-input';
        readonly identity: readonly ["steerId"];
        readonly moved: readonly ["text"];
        readonly forbidden: readonly [];
        readonly digests: {};
    };
    readonly 'task.complete_sealed': {
        readonly plainType: 'task.complete';
        readonly category: 'task-output';
        readonly identity: readonly [];
        readonly moved: readonly ["summary", "finalMessage", "document"];
        readonly forbidden: readonly ["artifactRefs", "preparedObservation"];
        readonly digests: {
            readonly 'agentRef.profileRevision': 'plain';
            readonly 'agentHomeProjection.profileRevision': 'plain';
            readonly 'agentHomeProjection.projectionHash': 'plain';
            readonly 'artifactRefs[].contentHash': 'forbidden';
            readonly 'preparedObservation.requestDigest': 'forbidden';
        };
    };
    readonly 'task.fail_sealed': {
        readonly plainType: 'task.fail';
        readonly category: 'task-output';
        readonly identity: readonly [];
        readonly moved: readonly ["reason"];
        readonly forbidden: readonly ["preparedObservation"];
        readonly digests: {
            readonly 'agentRef.profileRevision': 'plain';
            readonly 'agentHomeProjection.profileRevision': 'plain';
            readonly 'agentHomeProjection.projectionHash': 'plain';
            readonly 'preparedObservation.requestDigest': 'forbidden';
        };
    };
    readonly 'task.decline_sealed': {
        readonly plainType: 'task.decline';
        readonly category: 'task-output';
        readonly identity: readonly [];
        readonly moved: readonly ["reason"];
        readonly forbidden: readonly [];
        readonly digests: {
            readonly 'agentRef.profileRevision': 'plain';
        };
    };
    readonly 'task.cancelled_sealed': {
        readonly plainType: 'task.cancelled';
        readonly category: 'task-output';
        readonly identity: readonly [];
        readonly moved: readonly ["reason"];
        readonly forbidden: readonly [];
        readonly digests: {
            readonly 'agentRef.profileRevision': 'plain';
            readonly 'agentHomeProjection.profileRevision': 'plain';
            readonly 'agentHomeProjection.projectionHash': 'plain';
        };
    };
    readonly 'task.progress_sealed': {
        readonly plainType: 'task.progress';
        readonly category: 'task-output';
        readonly identity: readonly ["seq"];
        readonly moved: readonly ["events"];
        readonly forbidden: readonly [];
        readonly digests: {
            readonly 'events[].spill.blob.contentHash': 'sealed';
        };
        readonly inlineOnly: true;
    };
    readonly 'task.artifact_sealed': {
        readonly plainType: 'task.artifact';
        readonly category: 'task-output';
        readonly identity: readonly ["artifactId"];
        readonly moved: readonly ["inline"];
        readonly forbidden: readonly ["blobRef"];
        readonly digests: {
            readonly 'blobRef.contentHash': 'forbidden';
        };
        readonly limits: {
            readonly inline: number;
        };
    };
    readonly 'task.await_approval_sealed': {
        readonly plainType: 'task.await_approval';
        readonly category: 'task-output';
        readonly identity: readonly ["approvalId"];
        readonly moved: readonly ["summary"];
        readonly forbidden: readonly [];
        readonly digests: {};
        readonly inlineOnly: true;
    };
}>;
export type SealedMessageType = keyof typeof SEALED_SPLIT_TABLE;
export declare function isSealedMessageType(type: string): type is SealedMessageType;
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
import { type ResultSchema } from './result-schema';
export declare const TerminalProjectionContractSchema: z.ZodString;
/**
 * The frozen outcome schema of a result-document offer (wire v3). The value
 * is kept exactly as sent; {@link checkResultSchema} decides admission, so
 * every decode (Host submit, server/cloud parse, daemon admission) applies
 * the one subset guard and reports its capped issues.
 */
export declare const ResultDocumentSchemaSchema: z.ZodCustom<ResultSchema, ResultSchema>;
/** Offer-scoped authority: explicit bypass or one required structured result with its frozen schema. */
export declare const TerminalProjectionSelectionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    mode: z.ZodLiteral<"none">;
}, z.core.$strict>, z.ZodObject<{
    mode: z.ZodLiteral<"result-document">;
    contract: z.ZodString;
    schema: z.ZodCustom<ResultSchema, ResultSchema>;
}, z.core.$strict>], "mode">;
export type TerminalProjectionSelection = z.infer<typeof TerminalProjectionSelectionSchema>;
// ==== @byok-sdk/protocol dist/version.d.ts ====
/** Bounded volatile navigation; only cursor is a durable acknowledgement. */
export declare const MAILBOX_READ_AHEAD_MAX_SEQS = 4096;
export declare const MAILBOX_READ_AHEAD_CAPABILITY = "mailbox-read-ahead";
/**
 * Wire protocol version. Every v4 change is a version bump, a gated addition
 * or a strip-safe addition: see docs/protocol.md "Freeze rule", which is the
 * one statement of the rule, and `src/wire-additions.ts`, which declares the
 * receiver-capability gates and additions. No v4 release has been published
 * yet, so `src/__tests__/compat.test.ts` has no published v4 decoder to prove
 * additions against; cross-release gates stay unproven until one exists.
 *
 * v4 completes the ADR-034 cutover and retires the approval paths kept for
 * pre-M5 peers. It removes the v3 handshake answer, the runtime-only offers
 * (with and without toolsets) with their sealed twins, and the
 * `strict-agent-only` flag: every offer is Agent-bound. `approvalId` is
 * required on `task.await_approval`, `task.approve` and `task.reject`, so a
 * decision resolves only the approval it names. `task.approval_resolved` is
 * baseline: the daemon reports every locally resolved approval, and the
 * server no longer infers one from later task activity. The three approval
 * capability flags of v3 are gone. A v3 envelope is rejected; there is no v3 reader. Drain, then
 * upgrade server and client together.
 *
 * v3 made `schema` required on the `terminalProjection.mode:
 * 'result-document'` arm (`terminal-projection.ts`, `result-schema.ts`): the
 * offer freezes the outcome schema, and the outcome reaches the Host only as
 * `task.complete.document`. That narrows a strict shape, so it is a wire
 * major. A v2 envelope is rejected; there is no v2 reader and no capability
 * negotiation between the two result-document shapes. Drain, then upgrade
 * server and client together. Every addition v2 declared is part of the v3
 * baseline, and the v2 `result-document` capability flag is gone: every v3
 * server keeps `task.complete.document`.
 *
 * v2 removed the task offer's `policy` (`PermissionPolicy`), the runtime
 * capability `permissionModes` and the input-preparation `permissionMode`.
 * Sessions run without an SDK permission gate; each local agent keeps its
 * own guardrails. A v1 envelope is rejected; there is no v1 reader.
 * v2 also removed the egress policy's `metadata-status` activity mode, its
 * `activity.mode` field and the `sanitizer_rejected` drop reason. Agent
 * egress goes to the Host as the runtime produced it.
 * v2 also removed the input-preparation artifact's `toolImplementationKinds`
 * and the readiness reason `executor_identity_unproven`. The SDK does not
 * attest tool executables. The artifact names its counted tools in
 * `toolNames`.
 */
export declare const PROTOCOL_VERSION = 4;
/**
 * The device runs `homeAccess: 'memory-reader'` Agent offers: each reader
 * Attempt gets its own run directory under the Agent home, and readers are
 * counted apart from the one writer. The Agent offers are strict, so a host
 * must refuse a reader offer to a device without this flag before it creates
 * the task.
 */
export declare const AGENT_HOME_READERS_CAPABILITY: 'agent-home-readers';
/**
 * Capability flags. The daemon sends its flags in `conn.hello`; the server
 * sends its own on every long-poll response (`EventsPollResponse`). Additional
 * flags may be introduced without a protocol version bump; unrecognized flags
 * must be ignored by both sides.
 *
 * `dispatch-selection` (additive-minor) is a correctness gate for the
 * optional offer `dispatchSelection` control field. An older v1 daemon
 * legally strips unknown optional fields, so a server must never send an
 * authoritative provider/model selection unless the target connection
 * advertises this flag. Absence means reject before task creation, not send
 * an offer that could reach a different provider.
 *
 * `toolset-selection` (additive-minor) means the daemon understands an
 * offer's `requiredToolsets` and can resolve its logical ids against local
 * MCP configuration.
 */
export declare const CUSTOM_HARNESS_CAPABILITY: 'custom-harness';
export declare const CAPABILITY_FLAGS: readonly ['steer', 'blob-upload', 'dispatch-selection', "provider-profile-binding", 'toolset-selection', 'agent-home-contract', "agent-home-readers", "agent-egress-policy", "agent-egress-reliable-ack", "agent-message-egress", "agent-egress-fresh-session", "agent-content-workspace-read", "agent-content-transcript-read", "agent-content-artifact-read", "agent-home-projection", "agent-input-preparation-v9", "terminal-projection-selection", "host-mcp-task-context", "custom-harness", "mailbox-read-ahead", "provider-provisioning.v1", "agent-memory-intent.v1", "agent-memory-selection", "agent-memory-read-if-admitted", "agent-memory-read-write-if-admitted", 'agent-message-draft', "sealed-payload-v1", "sealed-output-ciphertext-ref", "runtime-failure-class"];
export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];
// ==== @byok-sdk/protocol dist/wire-additions.d.ts ====
/**
 * The one table of receiver-capability gates and wire additions
 * (docs/protocol.md "Freeze rule").
 *
 * A v4 change takes exactly one of three paths: a version bump, a gated
 * addition, or a strip-safe addition. Envelope and HTTP rows have explicit
 * kinds. The last two are declared here.
 *
 * - `gated`: the sender must not emit the surface unless the receiver
 *   durably advertised `capability`. A field entry applies when the payload
 *   carries the field (and, with `value`, when the field equals it); a
 *   dotted field names a nested field, for example `sealed.ciphertextRef`. A type
 *   entry applies to every message of that type. Server-to-daemon surfaces
 *   are gated by a device flag, daemon-to-server surfaces by a server flag.
 * - `strip-safe`: an optional field an older receiver drops without changing
 *   what it executes or acknowledges.
 *
 * v3 baseline: every v3 decoder reads every surface v2 had, so the v2
 * strip-safe rows and the v2 `result-document` gate are gone. The device
 * gates kept below name capabilities a daemon advertises only when it is
 * configured for them (Agent home, egress, input preparation, provisioning,
 * memory intents and so on): they gate on the receiver's configuration.
 *
 * v4 baseline: every v4 server reads `task.approval_resolved`, so its
 * `approval_resolved` gate is gone. No v4 release has been published yet, so
 * no published decoder proves these rows across releases.
 *
 * Senders derive their admission flags from {@link requiredReceiverCapabilities}
 * and nowhere else, so a gate cannot exist in one place and be missing in
 * another. This module imports no runtime code except the plain-data split
 * table, so it stays free of zod.
 */
import type { MessageType } from './messages';
import type { CapabilityFlag } from './version';
type HttpWireSurface = 'ChallengeRequest' | 'ChallengeResponse' | 'TokenRequest' | 'TokenResponse' | 'EventsPollQuery' | 'EventsPollResponse' | 'MessagesSendRequest' | 'MessagesSendResponse';
export type WireAddition = {
    readonly kind: 'envelope';
    readonly rule: 'gated';
    readonly surface: MessageType;
    readonly field?: string;
    readonly value?: string;
    readonly capability: CapabilityFlag;
    readonly advertisedBy: 'device' | 'server';
} | {
    readonly kind: 'envelope';
    readonly rule: 'strip-safe';
    readonly surface: MessageType;
    readonly field: string;
} | {
    readonly kind: 'http';
    readonly rule: 'strip-safe';
    readonly surface: HttpWireSurface;
    readonly field: string;
};
export declare const WIRE_ADDITIONS: readonly WireAddition[];
/**
 * Every capability the receiver must have durably advertised before a sender
 * may emit this message. Deduplicated, in table order. A sender refuses (before
 * creating the task or appending to the mailbox) when any is missing.
 */
export declare function requiredReceiverCapabilities(type: MessageType, payload: unknown): CapabilityFlag[];
export {};
// ==== @byok-sdk/protocol dist/wire-v4-migration.d.ts ====
import { type MessageType } from './messages';
/**
 * Every wire v3 message type and its v4 type. `null` marks a v3 type that v4
 * does not carry: a stored body of that type cannot be migrated.
 */
export declare const WIRE_V3_TO_V4_TYPES: Readonly<Record<string, MessageType | null>>;
/** Why a stored v3 body cannot be migrated. */
export type WireV4MigrationRefusal = 
/** Not JSON, not an envelope object, or not `v: 3`. */
'not_wire_v3'
/** A v3 type that {@link WIRE_V3_TO_V4_TYPES} maps to `null`, or does not list. */
 | 'type_without_v4_form'
/** The mapped envelope does not parse under v4. */
 | 'invalid_under_v4';
export type WireV4MigrationResult = {
    readonly ok: true;
    readonly type: MessageType;
    readonly body: string;
} | {
    readonly ok: false;
    readonly type?: string;
    readonly refusal: WireV4MigrationRefusal;
};
/** The v4 type of a v3 type, or `undefined` when v4 does not carry it. */
export declare function wireV4TypeOf(v3Type: string): MessageType | undefined;
/**
 * Re-encodes one stored wire v3 envelope as v4. The result is the canonical
 * v4 encoding, so its bytes and hash differ from the v3 body.
 */
export declare function migrateWireV3Envelope(body: string): WireV4MigrationResult;
