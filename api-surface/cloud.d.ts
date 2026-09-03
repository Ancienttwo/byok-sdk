// ==== @byok-sdk/cloud dist/activity.d.ts ====
import { type TenantId } from '@byok-sdk/core';
import { type AgentEventOrUnknown } from '@byok-sdk/protocol';
import { z } from 'zod';
export declare const DEFAULT_ACTIVITY_CAPACITY = 50;
export declare const ActivityAppendRequestSchema: z.ZodObject<{
    taskId: z.ZodString;
    sourceEnvelopeId: z.ZodString;
    batchSeq: z.ZodNumber;
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
    dropped: z.ZodNumber;
}, z.core.$strip>;
export declare const TimelineEventSchema: z.ZodObject<{
    taskId: z.ZodString;
    sourceEnvelopeId: z.ZodString;
    batchSeq: z.ZodNumber;
    eventIndex: z.ZodNumber;
    receivedAt: z.ZodISODateTime;
    event: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
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
}, z.core.$strip>;
export type TimelineEvent = Readonly<z.infer<typeof TimelineEventSchema>>;
export interface ActivityCursor {
    readonly batchSeq: number;
    readonly eventIndex: number;
}
export interface ActivityTail {
    readonly tenantId: TenantId;
    readonly taskId: string;
    readonly entries: readonly TimelineEvent[];
    readonly cursor?: ActivityCursor;
    readonly dropped: number;
    readonly capacity: number;
    readonly expiresAt: string;
}
export interface ActivityAppendInput {
    readonly taskId: string;
    readonly sourceEnvelopeId: string;
    readonly batchSeq: number;
    readonly events: readonly AgentEventOrUnknown[];
    readonly dropped: number;
    readonly ttlMs: number;
    readonly capacity?: number;
}
export interface ActivityStore {
    append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail>;
    read(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined>;
}
export declare function validateActivityAppend(input: ActivityAppendInput): number;
export declare function projectTimelineEvents(input: ActivityAppendInput, receivedAt: string): readonly TimelineEvent[];
export declare function parseTimelineEvents(value: unknown): readonly TimelineEvent[];
export declare function compareTimelineEvents(left: TimelineEvent, right: TimelineEvent): number;
export declare function activityCursor(entries: readonly TimelineEvent[]): ActivityCursor | undefined;
export declare function activityTailKey(tenant: TenantId, taskId: string): string;
// ==== @byok-sdk/cloud dist/agent-home-projections.d.ts ====
/**
 * Durable task-free Agent-home projection facts.
 *
 * Desired projection and completion are deliberately two immutable request
 * receipts.  The receipt store is tenant-scoped and first-write-wins, so the
 * composition does not need a second mutable projection authority merely to
 * survive a process restart.
 */
import { type AgentHomeProjectionPayload, type AgentHomeProjectionCompletionRequest, type AgentHomeProjectionReadback } from '@byok-sdk/protocol';
import type { TenantId } from '@byok-sdk/core';
import type { TenantBoundReceipts } from './tenant-stores';
export interface AgentHomeProjectionReceiptInput {
    readonly requestId: string;
    readonly agentRef: AgentHomeProjectionPayload['agentRef'];
    readonly projectionHash: AgentHomeProjectionPayload['projectionHash'];
}
export declare function agentHomeProjectionRequestKey(deviceId: string, requestId: string): string;
export declare function agentHomeProjectionCompletionKey(deviceId: string, requestId: string): string;
export declare function sameAgentHomeProjectionRequest(expected: AgentHomeProjectionPayload, actual: AgentHomeProjectionPayload): boolean;
export declare function receiptMatchesAgentHomeProjection(request: AgentHomeProjectionPayload, receipt: AgentHomeProjectionCompletionRequest): boolean;
export declare function statusInputMatchesAgentHomeProjection(request: AgentHomeProjectionPayload, input: AgentHomeProjectionReceiptInput): boolean;
export declare function readAgentHomeProjectionStatus(receipts: TenantBoundReceipts, tenant: TenantId, deviceId: string, input: AgentHomeProjectionReceiptInput): Promise<AgentHomeProjectionReadback | undefined>;
export declare function recordAgentHomeProjectionCompletion(receipts: TenantBoundReceipts, tenant: TenantId, deviceId: string, receiptInput: AgentHomeProjectionCompletionRequest): Promise<AgentHomeProjectionReadback>;
// ==== @byok-sdk/cloud dist/agent-memory-projection.d.ts ====
/**
 * Optional hosted Agent-memory projection ports and reference store.
 *
 * Local `MEMORY.md` and `notes/` remain the sole authoring authority. This
 * module only accepts a redacted full snapshot after a host-owned authorizer
 * grants the exact authenticated task identity; it never offers a read,
 * import, merge, history, RAG, or product-fact surface.
 */
import type { TenantId } from '@byok-sdk/core';
import { type AgentMemoryProjectionMutation, type AgentMemoryProjectionReceipt, type AgentMemoryProjectionEraseResult } from '@byok-sdk/protocol';
export type { AgentMemoryProjectionMeteringReceipt, AgentMemoryProjectionMutation, AgentMemoryProjectionReceipt, AgentMemoryProjectionEraseResult, } from '@byok-sdk/protocol';
export interface AgentMemoryProjectionAuthorizerInput {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly taskId: string;
    readonly agentRef: AgentMemoryProjectionMutation['agentRef'];
    readonly sessionRef: AgentMemoryProjectionMutation['sessionRef'];
    readonly runtimeId: AgentMemoryProjectionMutation['runtimeId'];
    readonly grantRef: AgentMemoryProjectionMutation['grantRef'];
    /** Server-granted active writer epoch; a client may not upgrade it unilaterally. */
    readonly writerEpoch: AgentMemoryProjectionMutation['writerEpoch'];
    readonly policyRevision: AgentMemoryProjectionMutation['policyRevision'];
}
export type AgentMemoryProjectionAuthorization = {
    readonly outcome: 'authorized';
} | {
    readonly outcome: 'denied';
    readonly reasonCode: string;
};
/**
 * Embedder-owned consent and grant authority. A model never provides a
 * consent flag: it presents only an opaque grantRef, which this port binds to
 * the authenticated tenant/device/task/AgentRef/session/runtime/grant/policy
 * identity. The host must retain an exact historical permit until its
 * mutation is accepted, explicitly revoked, or superseded by a higher writer
 * epoch; reaching task terminal state alone must not implicitly delete it.
 */
export interface AgentMemoryProjectionAuthorizer {
    authorize(input: AgentMemoryProjectionAuthorizerInput): Promise<AgentMemoryProjectionAuthorization>;
    /** Revoke hosted-projection authorization before the server asks the store to erase. */
    revoke(input: {
        readonly tenantId: TenantId;
        readonly agentId: string;
    }): Promise<void>;
}
/** Input to the durable projection store. `redactedBytes` has already been decoded from the portable base64url body. */
export interface AgentMemoryProjectionCommitInput {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly mutation: AgentMemoryProjectionMutation;
    readonly redactedBytes: Uint8Array;
}
/**
 * Durable hosted snapshot and immutable metering receipt authority.
 *
 * `commit` must hash the supplied bytes and compare them with the portable
 * redacted hash before every write. It accepts a new epoch only at sourceSeq
 * one, accepts same-epoch writes only gap-free, returns `idempotent` for an
 * exact replay, and rejects stale/gap/binding/hash mismatches. The accepted
 * snapshot and its metering receipt share one transaction boundary.
 */
export interface AgentMemoryProjectionStore {
    commit(input: AgentMemoryProjectionCommitInput): Promise<AgentMemoryProjectionReceipt>;
    /**
     * Server-side deletion leaves a body-free epoch fence. The host must mint a
     * later writer grant from `nextWriterEpoch`; no device/runtime is required.
     */
    erase(input: {
        readonly tenantId: TenantId;
        readonly agentId: string;
    }): Promise<AgentMemoryProjectionEraseResult>;
}
// ==== @byok-sdk/cloud dist/approval-control.d.ts ====
/**
 * Host-side approval resolution: the one rule that decides WHICH approval a
 * `cloud.approveTask`/`rejectTask` call is allowed to resolve.
 *
 * `@byok-sdk/server` keeps this as a single mutable slot on its task record
 * (`TaskSnapshot.pendingApprovalId`, `packages/server/src/hub.ts`) that
 * `task.await_approval` overwrites and `task.approval_resolved` clears. Cloud
 * holds no session state and no second store: the SAME two observations are
 * already durable in the `ApprovalTimelineStore` tail
 * (`approval-timeline.ts`), appended by the inbound gate, so the slot is
 * DERIVED from that tail on each call rather than mirrored into a record that
 * could then disagree with it.
 *
 * The derivation is a fold over the tail's entries in revision order, holding
 * exactly one slot — deliberately the server's shape, not a set of concurrently
 * pending approvals:
 *
 *   - `approval_requested` SETS the slot, superseding whatever it held. A
 *     daemon that dispatched a fresh approval without this cloud ever seeing
 *     the previous one resolved has moved on, and the newest request is what
 *     an operator is being asked about (`hub.ts:1399`).
 *   - `approval_resolved(X)` CLEARS the slot when the slot's own id is `X`, or
 *     when the slot has no id at all (a pre-M5 daemon never reported one, so
 *     the resolution can only be about the single outstanding request). A
 *     resolution naming some OTHER id is about an approval already superseded
 *     and leaves the current slot standing (`hub.ts:1569`).
 *
 * Two ways there is legitimately nothing pending: the tail has no unresolved
 * request, or the tail is gone entirely — it is a bounded, TTL'd observation
 * ring, not an authority that keeps facts forever. Both answer `undefined`,
 * and the callers fail closed on it. A dropped-then-expired approval is not
 * silently approved.
 */
import type { ApprovalTimelineTail } from './approval-timeline';
/**
 * M5 (approval targeting): thrown by `ByokCloud.approveTask`/`rejectTask` when
 * the caller supplied an `approvalId` that does NOT match the approval this
 * task currently has pending — the caller is targeting a SPECIFIC approval the
 * daemon has already superseded with a newer one.
 *
 * Distinct from the `task_not_awaiting_approval` `ByokCloudError` (there
 * is no pending approval at all, checked FIRST so it still wins when both would
 * apply): this error means the task genuinely IS awaiting an approval, just not
 * the one the caller thinks it is. Thrown before any mailbox row is allocated —
 * a stale-id call has zero side effects.
 *
 * A distinct class rather than a `CloudErrorCode`, unlike the rest of
 * this package's failures, because it carries the two ids the caller needs to
 * re-target: a code alone cannot say what the pending approval actually is.
 */
export declare class StaleApprovalError extends Error {
    readonly taskId: string;
    readonly requestedApprovalId: string;
    readonly currentApprovalId: string | undefined;
    constructor(taskId: string, requestedApprovalId: string, currentApprovalId: string | undefined);
}
/** The one approval a task currently has outstanding. */
export interface PendingApproval {
    /**
     * The daemon's own id for this approval. ABSENT for a pre-M5 daemon that
     * reported `task.await_approval` without one — the approval is still pending
     * and still resolvable, it just cannot be targeted, so a caller-supplied
     * `approvalId` proceeds untargeted exactly as it does on the server.
     */
    readonly approvalId?: string;
}
/**
 * The task's current pending approval, or `undefined` when it has none — see
 * this module's own doc comment for the fold and why it holds one slot.
 */
export declare function pendingApproval(tail: ApprovalTimelineTail | undefined): PendingApproval | undefined;
// ==== @byok-sdk/cloud dist/approval-timeline.d.ts ====
import { type TenantId } from '@byok-sdk/core';
import { z } from 'zod';
export declare const DEFAULT_APPROVAL_TIMELINE_CAPACITY = 50;
export declare const DEFAULT_APPROVAL_TIMELINE_TTL_MS: number;
export declare const APPROVAL_SUMMARY_MAX_BYTES: number;
export declare const ApprovalTimelineEventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"approval_requested">;
    summary: z.ZodString;
    approvalId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"approval_resolved">;
    approvalId: z.ZodString;
    decision: z.ZodEnum<{
        approve: "approve";
        reject: "reject";
    }>;
    resolvedBy: z.ZodEnum<{
        local: "local";
    }>;
    at: z.ZodISODateTime;
}, z.core.$strip>], "type">;
export type ApprovalTimelineEvent = Readonly<z.infer<typeof ApprovalTimelineEventSchema>>;
export declare const ApprovalObservationSchema: z.ZodObject<{
    taskId: z.ZodString;
    sourceEnvelopeId: z.ZodString;
    revision: z.ZodNumber;
    receivedAt: z.ZodISODateTime;
    event: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"approval_requested">;
        summary: z.ZodString;
        approvalId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"approval_resolved">;
        approvalId: z.ZodString;
        decision: z.ZodEnum<{
            approve: "approve";
            reject: "reject";
        }>;
        resolvedBy: z.ZodEnum<{
            local: "local";
        }>;
        at: z.ZodISODateTime;
    }, z.core.$strip>], "type">;
}, z.core.$strip>;
export type ApprovalObservation = Readonly<z.infer<typeof ApprovalObservationSchema>>;
export interface ApprovalTimelineTail {
    readonly tenantId: TenantId;
    readonly taskId: string;
    readonly entries: readonly ApprovalObservation[];
    readonly cursor?: number;
    readonly dropped: number;
    readonly capacity: number;
    readonly expiresAt: string;
}
export interface ApprovalTimelineAppendInput {
    readonly taskId: string;
    readonly sourceEnvelopeId: string;
    readonly event: ApprovalTimelineEvent;
    readonly ttlMs?: number;
    readonly capacity?: number;
}
export interface ApprovalTimelineStore {
    append(tenant: TenantId, input: ApprovalTimelineAppendInput): Promise<ApprovalTimelineTail>;
    read(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined>;
}
export interface ValidatedApprovalTimelineAppend {
    readonly capacity: number;
    readonly ttlMs: number;
    readonly event: ApprovalTimelineEvent;
}
export declare function validateApprovalTimelineAppend(input: ApprovalTimelineAppendInput): ValidatedApprovalTimelineAppend;
export declare function approvalTimelineKey(tenant: TenantId, taskId: string): string;
export declare function parseApprovalObservations(value: unknown): readonly ApprovalObservation[];
export declare function approvalTimelineCursor(entries: readonly ApprovalObservation[]): number | undefined;
// ==== @byok-sdk/cloud dist/auth/bearer.d.ts ====
/**
 * The single bearer check every device-facing route shares.
 *
 * S1 shape, reproduced exactly: the token's `(tenantId, deviceId, productId)`
 * are LOOKUP KEYS, and the ROW that comes back is the authority. A token for a
 * device that no longer exists, one whose tenant does not own that device, one
 * whose product disagrees with the row, one for a revoked device, an expired
 * token, and a malformed tenant id in the claims all fail identically here and
 * are indistinguishable to the caller. There is deliberately no "which of
 * those was it" signal to hand back, so no route can turn a 401 into a
 * cross-tenant existence oracle.
 *
 * The returned {@link DevicePrincipal} is core's, carrying a minted
 * `TenantId` — which is what makes it the only legal input to
 * `tenantStoresFor` (`../tenant-stores.ts`).
 */
import { type DevicePrincipal } from '@byok-sdk/core';
import type { DeviceDirectory } from '../stores/ports';
import type { TokenSigner } from './tokens';
export interface BearerAuthDeps {
    readonly tokenSigner: TokenSigner;
    readonly devices: DeviceDirectory;
    /**
     * The ONE product this deployment serves, when it serves exactly one.
     *
     * Two deployment shapes, two explicit authorities — not a default and a
     * fallback. A multi-product hosted control plane leaves this absent, and the
     * row is the whole product authority (`device.productId === claims.productId`
     * below). A single-product instance supplies it — that is the embedded shape,
     * where `createByokServer({ productId })` always has one — and the token must
     * then name THAT product as well, so a device paired through a code minted
     * for another product cannot reach this instance's bearer-authed routes at
     * all.
     *
     * Absent it, a cross-product device whose token and row agree with each other
     * authenticates on every `device` route the deployment mounts, which is
     * precisely the drift this closes for the embedded shape.
     */
    readonly instanceProductId?: string;
}
export declare function extractBearerToken(header: string | undefined): string | undefined;
export declare function authenticateBearer(header: string | undefined, deps: BearerAuthDeps): Promise<DevicePrincipal | undefined>;
// ==== @byok-sdk/cloud dist/auth/device-assertion.d.ts ====
import { type AuthenticatedDeviceAssertion, type Clock, type DeviceAssertionExpectedBinding, type DeviceAssertionReplayAuthority } from '@byok-sdk/core';
import type { CloudCrypto } from '../crypto/port';
import type { DeviceDirectory } from '../stores/ports';
export interface HostedDeviceAssertionAuthDeps {
    readonly devices: DeviceDirectory;
    readonly crypto: CloudCrypto;
    readonly replay: DeviceAssertionReplayAuthority;
    readonly clock: Clock;
    readonly expected: DeviceAssertionExpectedBinding;
    readonly maxLifetimeMs?: number;
}
/**
 * Hosted composition for an assertion exchange endpoint. The returned
 * principal is current device-directory authority; the assertion is consumed
 * before success is returned. Connector sessions minted afterward remain
 * host-owned and are never represented by this short-lived credential.
 */
export declare function authenticateHostedDeviceAssertion(input: unknown, deps: HostedDeviceAssertionAuthDeps): Promise<AuthenticatedDeviceAssertion | undefined>;
// ==== @byok-sdk/cloud dist/auth/device-proof.d.ts ====
import { type Clock, type DevicePrincipal } from '@byok-sdk/core';
import type { CloudCrypto } from '../crypto/port';
import type { DeviceDirectory } from '../stores/ports';
export declare const DEFAULT_DEVICE_PROOF_CLOCK_SKEW_MS = 60000;
export declare const MAX_DEVICE_PROOF_CLOCK_SKEW_MS: number;
export declare const DEFAULT_DEVICE_PROOF_MAX_LIFETIME_MS: number;
export declare const MAX_DEVICE_PROOF_MAX_LIFETIME_MS: number;
export interface DeviceProofRequestBinding {
    readonly method: string;
    readonly path: string;
    readonly operation: string;
    readonly resource: string;
    readonly body: Uint8Array;
}
export interface DeviceProofAuthDeps {
    readonly devices: DeviceDirectory;
    readonly crypto: CloudCrypto;
    readonly clock: Clock;
    readonly clockSkewMs?: number;
    readonly maxLifetimeMs?: number;
}
export interface AuthenticatedDeviceProof {
    /** Row-derived principal; no protected claim is re-used as authority. */
    readonly device: DevicePrincipal;
    readonly requestId: string;
    readonly operation: string;
    readonly resource: string;
    readonly bodySha256: string;
    readonly bodySize: bigint;
    readonly keyId: string;
    readonly keyEpoch: number;
}
/**
 * Authenticate a request-bound proof. Every rejected state is `undefined`, so
 * a route has one 401 response for malformed input, row misses, revocation,
 * stale epochs, binding changes, clock failures and bad signatures.
 */
export declare function authenticateDeviceProof(input: unknown, request: DeviceProofRequestBinding, deps: DeviceProofAuthDeps): Promise<AuthenticatedDeviceProof | undefined>;
// ==== @byok-sdk/cloud dist/auth/plane.d.ts ====
/**
 * The auth plane: everything the three pre-tenant routes (`/byok/pair`,
 * `/byok/challenge`, `/byok/token`) need, and nothing else.
 *
 * Those three routes cannot take a {@link TenantStores} facade — they run
 * BEFORE a principal exists, which is exactly why they are the surface where a
 * tenant boundary is easiest to lose. So instead of handing them naked stores
 * and trusting each handler to pass the right tenant, this module owns every
 * tenant-carrying call they make and hands back operations that name no tenant
 * at all:
 *
 * - a pairing code redeems into a REGISTERED device row in one step, so the
 *   claims never sit in handler scope as a tenant a handler could substitute;
 * - a device resolves to a row (the pre-tenant lookup, §6.2's pinned wire
 *   contract), and unknown/revoked collapse to one answer;
 * - nonce issue/atomic-consume and token minting take that ROW, so the
 *   tenant they act on is the row's, by construction.
 */
import type { Clock, TenantId } from '@byok-sdk/core';
import type { CloudCrypto } from '../crypto/port';
import type { CloudStores, DeviceRecord, PairingCodeInfo } from '../stores/ports';
import { type TokenSigner } from './tokens';
/** ~10min, matching the reference server's pairing-code lifetime. */
export declare const PAIRING_CODE_TTL_MS: number;
/** The paired identity key is the first and only proof key in S6. */
export declare const DEVICE_IDENTITY_PROOF_KEY_ID = "identity";
export declare const DEVICE_IDENTITY_PROOF_KEY_EPOCH = 0;
export interface PairInput {
    readonly pairingCode: string;
    readonly deviceName: string;
    readonly devicePublicKey: string;
    /** Optional client-hashed machine identity (protocol §6.1). Carried into registration verbatim; it is never a tenant or product authority. */
    readonly machineId?: string;
}
export interface MintedAccessToken {
    readonly accessToken: string;
    readonly expiresAt: string;
}
export interface AuthPlane {
    /** Host control plane: mint a single-use code carrying the tenant/product a device will land in. */
    createPairingCode(tenant: TenantId, input: {
        readonly productId: string;
        readonly ttlMs?: number;
    }): Promise<PairingCodeInfo>;
    /**
     * Redeem a code and register the device it pairs, in one step. `undefined`
     * for a code that is unknown, expired, or already used — one answer for all
     * three. Single-use redemption is what makes this exclusive: a second
     * redeem never reaches the row write.
     */
    redeemAndRegister(input: PairInput): Promise<DeviceRecord | undefined>;
    /** The pre-tenant device lookup §6.2's wire contract forces. `undefined` for unknown AND revoked alike — no existence oracle. */
    resolveDevice(deviceId: string): Promise<DeviceRecord | undefined>;
    issueNonce(device: DeviceRecord): Promise<string>;
    /** Atomically consume the nonce after signature verification (§6.2). */
    consumeNonceIfValid(device: DeviceRecord, nonce: string): Promise<boolean>;
    /** Domain-separated (`byok-nonce-v1\n`) — see `verify.ts`. A raw signature over the bare nonce is invalid, with no second accepted form. */
    verifySignature(device: DeviceRecord, nonce: string, signature: string): Promise<boolean>;
    mintAccessToken(device: DeviceRecord): Promise<MintedAccessToken>;
}
export interface AuthPlaneDeps {
    readonly stores: CloudStores;
    readonly crypto: CloudCrypto;
    readonly clock: Clock;
    readonly tokenSigner: TokenSigner;
    readonly accessTokenTtlSeconds?: number;
}
export declare function createAuthPlane(deps: AuthPlaneDeps): AuthPlane;
// ==== @byok-sdk/cloud dist/auth/tokens.d.ts ====
/**
 * Access tokens for the hosted device surface (docs/protocol.md §6).
 *
 * The token carries the identity TRIPLE — `(deviceId, tenantId, productId)` —
 * and all three legs are lookup keys, never authority: `authenticateBearer`
 * (`bearer.ts`) resolves them against the device directory and answers with
 * the ROW's identity. A token missing a leg is not a partially usable token;
 * it is not a token this deployment minted.
 *
 * {@link TokenSigner} is a port for the same reason `@byok-sdk/server` made it
 * one: a SaaS with an org-wide asymmetric signer or a KMS swaps its own in.
 * The reference implementation below is HS256 over a caller-supplied secret,
 * built on WebCrypto so the package stays runtime-neutral (no `jose`, no
 * `node:crypto`).
 */
import type { Clock } from '@byok-sdk/core';
/** Access tokens are ~1h, matching the reference server (docs/protocol.md §6.1/§6.2). */
export declare const ACCESS_TOKEN_TTL_SECONDS: number;
export interface AccessTokenClaims {
    readonly deviceId: string;
    /** Unbranded on the wire: the value is only a lookup key until a device row vouches for it. */
    readonly tenantId: string;
    readonly productId: string;
}
export interface TokenSigner {
    sign(claims: AccessTokenClaims, expiresInSeconds: number): Promise<string>;
    /** Claims for a valid, unexpired token, or `undefined` for invalid/expired/malformed — no reason is ever reported. */
    verify(token: string): Promise<AccessTokenClaims | undefined>;
}
/**
 * HS256 JWT signer over `secret`.
 *
 * `clock` is injected rather than read off `Date.now()` so expiry is testable
 * and so the whole package keeps a single notion of "now" (the same one the
 * stores use for TTLs).
 */
export declare function createHmacTokenSigner(secret: Uint8Array, clock: Clock): TokenSigner;
// ==== @byok-sdk/cloud dist/auth/verify.d.ts ====
import type { CloudCrypto } from '../crypto/port';
export { NONCE_SIGNING_DOMAIN } from '@byok-sdk/core';
export declare function verifyNonceSignature(crypto: CloudCrypto, devicePublicKey: string, nonce: string, signature: string): Promise<boolean>;
// ==== @byok-sdk/cloud dist/capabilities.d.ts ====
/**
 * The hosted capability declaration (ADR-010).
 *
 * A client learns what a deployment supports by READING a declaration, never
 * by probing an endpoint and interpreting 404/405/501. `@byok-sdk/core` owns the
 * declaration shape and the `hasCapability`/`assertCapability` enforcement
 * point; what lives here is the hosted vocabulary and the mapping from a
 * capability name to the routes that provide it.
 *
 * `GET /byok/capabilities` is a hosted-only route: it is not part of the
 * frozen device wire contract, `@byok-sdk/protocol` is untouched by it, and the
 * daemon does not consume it yet (that lands in a later slice). What it
 * already does here is drive route selection — a deployment that does not
 * declare `blobs.presigned` does not mount the grant routes at all, and one
 * that does not declare `blobs.contentproxy` does not mount the two `/content`
 * routes, so the declaration and the surface cannot disagree.
 */
import { type CapabilityDeclaration } from '@byok-sdk/core';
/** The hosted capability vocabulary this package knows how to serve. */
export declare const CLOUD_CAPABILITIES: {
    /** `GET /byok/events` long-poll receive (§8). */
    readonly eventsLongPoll: 'events.longpoll';
    /** `POST /byok/messages` batched send (§8.2). */
    readonly messagesBatch: 'messages.batch';
    /** The three bearer-authed blob routes: reserve/grant, explicit finalize, committed-only download (§7). */
    readonly blobsPresigned: 'blobs.presigned';
    /**
     * The two presigned `/byok/blobs/:id/content` routes — cloud carrying the
     * bytes itself.
     *
     * Split out of `blobs.presigned` because it was one capability describing two
     * separable facts. A composition whose bytes live in object storage mints
     * grants (`blobs.presigned`) but has no byte-proxy path at all, and saying so
     * by declaration is ADR-010's whole posture: a client reads what a deployment
     * serves, it never probes a `/content` route and interprets the status code.
     *
     * Spelled all-lowercase because core's declaration schema pins capability
     * names to `/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/` — the same reason the sibling
     * above reads `events.longpoll` and not `events.longPoll`.
     */
    readonly blobsContentProxy: 'blobs.contentproxy';
    /** Board list/claim/unclaim/status routes. Polling is first-class under this declaration. */
    readonly boardCoordination: 'board.coordination';
    /** Additional SSE transport for the same board read model. */
    readonly boardSse: 'board.sse';
    /** Device-scoped five-level presence publication. */
    readonly presenceHints: 'presence.hints';
    /** Bounded task activity batch publication. */
    readonly activityTail: 'activity.tail';
    /** Request-bound device proof record manifest/read/write surface (S6). */
    readonly truthRecords: 'truth.records';
    /**
     * Tenant-scoped skill pack distribution: the manifest list plus the per-file
     * content route a paired device installs from.
     *
     * Hosted HTTP on purpose. A pack is DECLARATIVE CONTENT a device pulls after
     * reading this declaration — not a message — so `@byok-sdk/protocol` gains
     * nothing from it and the frozen v1 envelope stays untouched. Composition-
     * bound like `truth.records`: a deployment that declares it without supplying
     * a `SkillPackStore` is refused at construction rather than publishing two
     * routes it would then 404.
     */
    readonly skillPacks: 'skills.pack';
    /** Optional, one-way redacted Agent-memory snapshot mutation route. */
    readonly agentMemoryProjection: 'agent.memory.projection';
};
export type CloudCapability = (typeof CLOUD_CAPABILITIES)[keyof typeof CLOUD_CAPABILITIES];
/** The wire DTO for `GET /byok/capabilities` — core's shape, bound to a cloud-owned route. */
export declare const CapabilitiesResponseSchema: import("zod").ZodObject<{
    schema: import("zod").ZodLiteral<"byok-capabilities-v1">;
    version: import("zod").ZodNumber;
    capabilities: import("zod").ZodArray<import("zod").ZodString>;
}, import("zod/v4/core").$strip>;
export type CapabilitiesResponse = CapabilityDeclaration;
export interface FullCapabilityDeclarationOptions {
    /**
     * Composition-bound capabilities require an explicit application authority.
     * `truth.records` is omitted by default because the standard in-memory
     * composition cannot truthfully promise a cross-store atomic commit.
     */
    readonly includeTruthRecords?: boolean;
    /**
     * `skills.pack` is omitted for the same reason: the standard composition is
     * given no `SkillPackStore`, and a default-on declaration would make every
     * existing deployment refuse to construct.
     */
    readonly includeSkillPacks?: boolean;
    /**
     * Hosted Agent memory is default-off: a composition needs both an embedder
     * grant authorizer and a durable projection store before it may declare the
     * mutation route.
     */
    readonly includeAgentMemoryProjection?: boolean;
}
/** Every capability the standard composition can serve, plus explicitly wired composition-bound ones. */
export declare function fullCapabilityDeclaration(version?: number, options?: FullCapabilityDeclarationOptions): CapabilityDeclaration;
export declare function declares(declaration: CapabilityDeclaration, capability: CloudCapability): boolean;
// ==== @byok-sdk/cloud dist/cloud.d.ts ====
/**
 * `createByokCloud` — the hosted device surface, assembled.
 *
 * What this is NOT: an embedded coordinator. There is no `TaskHandle`, no
 * connection registry, no per-task object that a host holds onto. Sprint 0.1's
 * non-goal is explicit about that — the embedded `TaskHandle` must not become
 * the hosted API — so the host's control-plane input is a function
 * ({@link ByokCloud.enqueueOffer}) and its read model is a store query
 * ({@link ByokCloud.readTaskAttempt}).
 *
 * Every route is stateless in the strict sense: it resolves a principal from
 * the request, binds stores to that principal's tenant, and returns. Nothing
 * survives the response but what a store wrote. The one shape that would
 * quietly undo that — a Running/session map — is asserted absent by
 * `src/__tests__/constraints.test.ts`.
 */
import { type BoardItem, type BoardItemInput, type BoardListQuery, type BoardPage, type CapabilityDeclaration, type Clock, type CoreStores, type PresenceHint, type SkillPackStore, type TenantId, type TenantReadiness } from '@byok-sdk/core';
import type { ActivityTail } from './activity';
import type { ApprovalTimelineTail } from './approval-timeline';
import { type Envelope, type AgentContentReadPayload, type AgentMessagePublishPayload, type AgentMessageServerContext, type AgentHomeProjectionCompletionRequest, type AgentHomeProjectionPayload, type AgentHomeProjectionReadback, type AgentMemoryProjectionEraseResult, type TaskOfferPayload, type TaskSteerPayload, type TaskOfferForAgentPayload, type TaskOfferForAgentWithEgressPayload, type TaskOfferForAgentWithEgressFreshPayload, type TaskOfferWithToolsetsPayload } from '@byok-sdk/protocol';
import type { TokenSigner } from './auth/tokens';
import type { CloudCrypto } from './crypto/port';
import { type RouteDescriptor } from './router/registry';
import { type ByokCloudObserver } from './inbound';
import { type AgentHomeProjectionReceiptInput } from './agent-home-projections';
import type { AgentMemoryProjectionAuthorizer, AgentMemoryProjectionStore } from './agent-memory-projection';
import type { BlobContentProxy, CloudStores, DeviceRecord, AgentEgressRecord, PairingCodeInfo, RequestReceipt, TaskAttempt, TaskAttemptListQuery, TaskAttemptPage } from './stores/ports';
import { type TerminalResult } from './terminal-result';
import type { TruthCommitter, TruthObjectDownloads } from './truth/contract';
/** Matches the reference server's ceiling (§7). */
export declare const DEFAULT_MAX_BLOB_SIZE_BYTES: number;
/** Matches the reference server's hold (§8). */
export declare const DEFAULT_LONG_POLL_HOLD_MS = 50000;
/** How often a held poll re-reads the mailbox. */
export declare const DEFAULT_LONG_POLL_INTERVAL_MS = 250;
/** Rows per `GET /byok/events` response. */
export declare const DEFAULT_EVENTS_PAGE_LIMIT = 50;
/** Device capability required by the strict Agent offer path. */
export declare const AGENT_HOME_CONTRACT_CAPABILITY = "agent-home-contract";
export interface ByokCloudOptions {
    readonly core: CoreStores;
    readonly cloud: CloudStores;
    /**
     * Byte proxying for the two `/byok/blobs/:id/content` routes. OPTIONAL, and
     * absent is a first-class answer: a composition backed by object storage
     * hands the device a presigned URL to the object store and never carries a
     * byte, so it has nothing to supply here. Supplying it is necessary but not
     * sufficient for the routes to exist — the deployment must also declare
     * `blobs.contentproxy` (ADR-010).
     */
    readonly blobContentProxy?: BlobContentProxy;
    /** Atomic proof receipt + truth/reference/accounting authority for S6 routes. */
    readonly truthCommitter?: TruthCommitter;
    /** Content-hash keyed object GET grants for object-backed truth bodies. */
    readonly truthObjectDownloads?: TruthObjectDownloads;
    /**
     * Tenant-scoped skill pack catalogue. OPTIONAL, and absent is a first-class
     * answer: a deployment that distributes no declarative content supplies
     * nothing here and declares no `skills.pack`. Supplying it is necessary but
     * not sufficient for the routes to exist — the deployment must also declare
     * the capability (ADR-010), the same asymmetry the byte proxy above has.
     */
    readonly skillPacks?: SkillPackStore;
    readonly crypto: CloudCrypto;
    readonly tokenSigner: TokenSigner;
    readonly clock: Clock;
    /** What this deployment serves (ADR-010). Routes are mounted from it, so it can never over-declare. */
    readonly capabilities: CapabilityDeclaration;
    /** Recorded on the control-plane principal every host-side call is made under. */
    readonly operatorId?: string;
    /**
     * The ONE product this deployment serves, when it serves exactly one — the
     * embedded shape. Supplying it makes every bearer-authed route additionally
     * require the token to name this product; omitting it leaves the device row
     * as the whole product authority. Two deployment shapes, two explicit
     * authorities: see `BearerAuthDeps.instanceProductId` (`auth/bearer.ts`).
     */
    readonly instanceProductId?: string;
    /** Product-owned consumer; destination lookup is keyed by authenticated task context, never model input. */
    readonly agentMessage?: {
        consume(input: {
            readonly tenant: TenantId;
            readonly deviceId: string;
            readonly taskId: string;
            readonly context: AgentMessageServerContext;
            readonly payload: AgentMessagePublishPayload;
        }): Promise<{
            readonly outcome: 'accepted' | 'held' | 'refused';
            readonly reasonCode?: string;
        }>;
    };
    /**
     * Post-commit relay for envelopes this cloud durably accepted. Read-only by
     * construction: it is told after the write, it returns `void`, and a throw
     * from it is swallowed — the outcome is already fixed. Distinct from
     * {@link ByokCloudOptions.agentMessage}, which is admission and runs BEFORE
     * a write, deciding whether it happens at all.
     */
    readonly observer?: ByokCloudObserver;
    /** Embedder-owned grant and consent authority for optional hosted Agent-memory projection. */
    readonly agentMemoryProjectionAuthorizer?: AgentMemoryProjectionAuthorizer;
    /** Durable snapshot + immutable metering receipt authority for optional hosted Agent-memory projection. */
    readonly agentMemoryProjectionStore?: AgentMemoryProjectionStore;
    readonly maxBlobSizeBytes?: number;
    readonly longPollHoldMs?: number;
    readonly longPollIntervalMs?: number;
    readonly eventsPageLimit?: number;
    readonly accessTokenTtlSeconds?: number;
    readonly boardPageLimit?: number;
    readonly boardStreamQueryIntervalMs?: number;
    readonly boardStreamHeartbeatIntervalMs?: number;
    readonly boardStreamReconciliationIntervalMs?: number;
    readonly boardChannelMaxBytes?: number;
    readonly boardTitleMaxBytes?: number;
    readonly presenceTtlMs?: number;
    readonly presenceMinimumIntervalMs?: number;
    readonly presenceDetailMaxBytes?: number;
    readonly activityMaxEvents?: number;
    readonly activityMaxBytes?: number;
    readonly activityCapacity?: number;
    readonly activityTtlMs?: number;
    readonly maxTruthRequestBytes?: number;
    readonly skillPackPageLimit?: number;
}
export interface EnqueueOfferInput {
    /** Supply one to make the enqueue addressable by the host's own id; otherwise cloud mints one. */
    readonly taskId?: string;
    readonly payload: TaskOfferPayload;
}
export interface EnqueueToolsetOfferInput {
    /** Supply one to make the enqueue addressable by the host's own id; otherwise cloud mints one. */
    readonly taskId?: string;
    /** Strict control payload containing logical ids only; executable MCP definitions are not part of this type. */
    readonly payload: TaskOfferWithToolsetsPayload;
}
/**
 * Strict Agent dispatch input. The device path is intentionally a separate
 * argument on {@link ByokCloud.enqueueAgentOffer}; no legacy offer field is
 * interpreted as an Agent placement hint.
 */
export interface AgentDispatchInput {
    /** Supply one to make the enqueue addressable by the host's own id; otherwise cloud mints one. */
    readonly taskId?: string;
    /** Strict Agent payload carrying the exact opaque AgentRef. */
    readonly payload: TaskOfferForAgentPayload;
}
/** Strict Agent dispatch that supplies the policy consumed by the typed egress lanes. */
export interface AgentEgressDispatchInput {
    /** Supply one to make the enqueue addressable by the host's own id; otherwise cloud mints one. */
    readonly taskId?: string;
    readonly payload: TaskOfferForAgentWithEgressPayload;
    /** Host-only product destination/freshness authority; never serialized to the daemon. */
    readonly agentMessageContext?: AgentMessageServerContext;
}
/** Strict Agent dispatch whose selected runtime mints its session after start. */
export interface AgentEgressFreshSessionDispatchInput {
    /** Supply one to make the enqueue addressable by the host's own id; otherwise cloud mints one. */
    readonly taskId?: string;
    /** Deliberately session-free strict payload for the fresh-runtime path. */
    readonly payload: TaskOfferForAgentWithEgressFreshPayload;
    /** Host-only product destination/freshness authority; never serialized to the daemon. */
    readonly agentMessageContext?: AgentMessageServerContext;
}
/** A task-free, independently capability-gated Agent content read. */
export interface AgentContentReadInput {
    readonly payload: AgentContentReadPayload;
}
/** Task-free exact-device projection desired state, intentionally unrelated to TaskAttempt. */
export type AgentHomeProjectionInput = AgentHomeProjectionPayload;
/** Exact request identity a host must echo to read back durable projection status. */
export type AgentHomeProjectionStatusInput = AgentHomeProjectionReceiptInput;
/** Optional targeting for {@link ByokCloud.approveTask}. */
export interface ApproveTaskOptions {
    /**
     * Resolve THIS specific approval rather than whichever one is pending.
     * A mismatch against the task's current pending approval throws
     * {@link StaleApprovalError} instead of resolving the wrong thing.
     */
    readonly approvalId?: string;
}
/** Optional targeting and refusal cause for {@link ByokCloud.rejectTask}. */
export interface RejectTaskOptions extends ApproveTaskOptions {
    /** Carried to the runtime verbatim; absent stays absent on the wire. */
    readonly reason?: string;
}
export interface EnqueuedAgentControl {
    readonly seq: number;
    readonly envelope: Envelope;
}
export interface EnqueuedAgentHomeProjection extends EnqueuedAgentControl {
    readonly status: AgentHomeProjectionReadback;
}
export interface EnqueuedOffer {
    readonly taskId: string;
    /** The per-(tenant, device) delivery seq — the daemon's redelivery cursor position for this envelope. */
    readonly seq: number;
    readonly envelope: Envelope;
    readonly attempt: TaskAttempt;
}
export interface ByokCloud {
    /** WHATWG fetch handler — mount on `@hono/node-server`, a Worker, or Deno. */
    readonly fetch: (request: Request, ...rest: unknown[]) => Response | Promise<Response>;
    /** The I1 route inventory: every mounted route and the credential class it requires. */
    readonly routes: readonly RouteDescriptor[];
    /**
     * What the router ACTUALLY holds, read back off the router itself. Exposed
     * so the I1 matrix can close in both directions: an inventory is only
     * evidence if a route mounted some other way would show up here without a
     * matching entry in {@link routes}.
     */
    readonly mountedRoutes: readonly {
        readonly method: string;
        readonly path: string;
    }[];
    readonly capabilities: CapabilityDeclaration;
    /** Host control plane: mint a single-use pairing code for a tenant/product. */
    createPairingCode(tenant: TenantId, input: {
        readonly productId: string;
        readonly ttlMs?: number;
    }): Promise<PairingCodeInfo>;
    /** Host control plane: hand a device a frozen-v1 `task.offer`. The hosted replacement for `dispatch()` — a function, not a handle. */
    enqueueOffer(tenant: TenantId, deviceId: string, input: EnqueueOfferInput): Promise<EnqueuedOffer>;
    /** Host control plane: enqueue the additive fail-closed offer variant that requires local MCP toolsets. */
    enqueueToolsetOffer(tenant: TenantId, deviceId: string, input: EnqueueToolsetOfferInput): Promise<EnqueuedOffer>;
    /**
     * Host control plane: enqueue a strict Agent offer to an explicit device.
     * Capability admission is read from the durable authenticated device row
     * before either the mailbox append or task-attempt open.
     */
    enqueueAgentOffer(tenant: TenantId, deviceId: string, input: AgentDispatchInput): Promise<EnqueuedOffer>;
    /**
     * Host control plane: enqueue the typed egress-policy Agent offer. Missing
     * egress/reliable-ack capabilities reject before a mailbox row is allocated.
     */
    enqueueAgentEgressOffer(tenant: TenantId, deviceId: string, input: AgentEgressDispatchInput): Promise<EnqueuedOffer>;
    /**
     * Host control plane: enqueue the distinct fresh-session egress offer.
     * The device must durably advertise fresh-session support before task or
     * mailbox reservation, so older resume-only daemons never receive it.
     */
    enqueueFreshAgentEgressOffer(tenant: TenantId, deviceId: string, input: AgentEgressFreshSessionDispatchInput): Promise<EnqueuedOffer>;
    /** Host control plane: request one policy-bound content read without a task fallback. */
    enqueueAgentContentRead(tenant: TenantId, deviceId: string, input: AgentContentReadInput): Promise<EnqueuedAgentControl>;
    /** Durable, task-free projection request for precisely one admitted device. */
    enqueueAgentHomeProjection(tenant: TenantId, deviceId: string, input: AgentHomeProjectionInput): Promise<EnqueuedAgentHomeProjection>;
    /** Tenant/device/request-bound durable desired-state and terminal-outcome readback. */
    getAgentHomeProjectionStatus(tenant: TenantId, deviceId: string, input: AgentHomeProjectionStatusInput): Promise<AgentHomeProjectionReadback | undefined>;
    /** Direct device completion endpoint authority; first exact terminal receipt wins. */
    completeAgentHomeProjection(tenant: TenantId, deviceId: string, receipt: AgentHomeProjectionCompletionRequest): Promise<AgentHomeProjectionReadback>;
    /**
     * Server-side consent revocation and hosted projection erasure. It does not
     * depend on a device being online and never imports anything back locally.
     */
    eraseAgentMemoryProjection(tenant: TenantId, agentId: string): Promise<AgentMemoryProjectionEraseResult>;
    /** Host control plane: durably request cancellation by tenant/task id. Idempotent. */
    cancelTask(tenant: TenantId, taskId: string, reason?: string): Promise<TaskAttempt>;
    /**
     * Host control plane: resolve the approval a paused task is waiting on, by
     * enqueueing `task.approve` to the device that claimed it.
     *
     * WHICH approval is a derived fact, not a stored one — see
     * `approval-control.ts` for the fold over the durable timeline that produces
     * it, and why cloud adds no second authority for it. Gate order mirrors the
     * reference server (`packages/server/src/hub.ts`), and every gate is
     * evaluated in full before a mailbox row is allocated, so a refused call has
     * zero side effects:
     *
     *   1. no such task for this tenant -> `task_not_found`;
     *   2. nothing to resolve -> `task_not_awaiting_approval`, which covers a
     *      terminal attempt, an unclaimed one, and a timeline with no unresolved
     *      request (expired or never written). Checked BEFORE targeting, so it
     *      still wins when both would apply;
     *   3. `opts.approvalId` names an approval this task has already superseded
     *      -> {@link StaleApprovalError}. When the daemon never reported an id
     *      at all, the call proceeds untargeted, exactly as on the server.
     *
     * Delivery is a best-effort notification, the same contract the wire message
     * has always had (`TaskApprovePayloadSchema`, `@byok-sdk/protocol`): the
     * enqueued envelope is durable, the runtime's response to it is observable
     * only through that task's own later messages. The outgoing `approvalId` is
     * the caller's when given, else the pending one, else omitted.
     */
    approveTask(tenant: TenantId, taskId: string, opts?: ApproveTaskOptions): Promise<EnqueuedAgentControl>;
    /**
     * Host control plane: refuse the approval a paused task is waiting on, by
     * enqueueing `task.reject` to the device that claimed it. Same gates, same
     * targeting, and the same best-effort delivery contract as
     * {@link ByokCloud.approveTask} — `opts.reason` is carried to the runtime
     * verbatim and is never synthesized when absent.
     */
    rejectTask(tenant: TenantId, taskId: string, opts?: RejectTaskOptions): Promise<EnqueuedAgentControl>;
    /**
     * Host control plane: inject steering text into a RUNNING task, by enqueueing
     * `task.steer` to the device that claimed it.
     *
     * Gated on the claim-time capability snapshot and on nothing else — see
     * `steer-control.ts` for why that is the only admissible input and why an
     * absent snapshot refuses. Gate order mirrors the reference server
     * (`ConnectionHub.steerTask`, `packages/server/src/hub.ts`), and every gate is
     * evaluated in full before a mailbox row is allocated, so a refused call has
     * zero side effects:
     *
     *   1. no such task for this tenant -> `task_not_found` ({@link ByokCloudError});
     *   2. terminal attempt -> {@link SteerRejectedError} `task_terminal`,
     *      checked BEFORE the running check so a steer racing a terminal
     *      transition always resolves terminal-first;
     *   3. not running (or running with no owning device) ->
     *      {@link SteerRejectedError} `task_not_running`;
     *   4. the claim snapshot does not positively say `steer: true` ->
     *      {@link SteerRejectedError} `steer_unsupported_runtime`, including when
     *      there is no snapshot at all.
     *
     * Delivery is the same best-effort notification every control message has:
     * the enqueued envelope is durable, and whether the runtime acted on it is
     * observable only through that task's own later messages.
     */
    steerTask(tenant: TenantId, taskId: string, payload: TaskSteerPayload): Promise<EnqueuedAgentControl>;
    readTaskAttempt(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined>;
    /**
     * Host control plane: one bounded page of this tenant's task attempts,
     * keyset-paged by `taskId` — see {@link TaskAttemptListQuery} for why the key
     * is the task id and not a timestamp, and why the walk terminates on an
     * absent `nextCursor` rather than on an empty page.
     *
     * A non-positive or non-integer `limit` is rejected
     * (`coordination_input_invalid`), never defaulted: the host names the bound.
     */
    listTaskAttempts(tenant: TenantId, query: TaskAttemptListQuery): Promise<TaskAttemptPage>;
    /** The recorded terminal for a task — the first one, re-encoded canonically under the frozen v1 codec (see `recordTerminal`, `inbound.ts`: the stored body is `encodeEnvelope` of the zod-parsed envelope, not the device's original byte sequence). */
    readTerminalReceipt(tenant: TenantId, taskId: string): Promise<RequestReceipt | undefined>;
    /** Exact durable egress fact and receipt selected by (tenant, device, event id). */
    readAgentEgress(tenant: TenantId, deviceId: string, eventId: string): Promise<AgentEgressRecord | undefined>;
    /**
     * Host control plane: the same first terminal, decoded into the typed read
     * model ({@link TerminalResult}) so a host reads result fields, not envelope
     * prose. An accepted host cancellation tombstone outranks a later device
     * receipt; the raw receipt remains readable as device evidence through
     * {@link ByokCloud.readTerminalReceipt}. `undefined` means neither fact
     * exists. An absent `document` covers both a legacy
     * pre-`result-document` daemon build and a daemon with no `resultDocument`
     * extractor; a receipt whose body is not a terminal envelope throws rather
     * than returning a best-effort shape.
     */
    readTaskResult(tenant: TenantId, taskId: string): Promise<TerminalResult | undefined>;
    listDevices(tenant: TenantId): Promise<readonly DeviceRecord[]>;
    revokeDevice(tenant: TenantId, deviceId: string): Promise<void>;
    /** Host control plane: create a board row from explicit producer labels. */
    createBoardItem(tenant: TenantId, input: BoardItemInput): Promise<BoardItem>;
    listBoardItems(tenant: TenantId, query: BoardListQuery): Promise<BoardPage>;
    /** Human review authority. Device routes cannot produce `done`. */
    acceptBoardItem(tenant: TenantId, itemId: string): Promise<BoardItem>;
    listPresence(tenant: TenantId): Promise<readonly PresenceHint[]>;
    /** SDK-owned observation only; never a scheduler or execution authority. */
    readTenantReadiness(tenant: TenantId): Promise<TenantReadiness>;
    readActivity(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined>;
    readApprovalTimeline(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined>;
}
export declare function createByokCloud(options: ByokCloudOptions): ByokCloud;
// ==== @byok-sdk/cloud dist/composition/in-memory.d.ts ====
/**
 * The in-memory composition: core's reference stores plus cloud's, wired into
 * a working {@link ByokCloud}.
 *
 * This is what the handler suites and the client-side end-to-end test run
 * against, and it is the honest demonstration of the S3 claim — the daemon
 * cannot tell this from `@byok-sdk/server`, and nothing in the path needs a
 * database to prove it.
 */
import { type CapabilityDeclaration, type Clock, type CoreStores, type SkillPackStore } from '@byok-sdk/core';
import { type TokenSigner } from '../auth/tokens';
import type { CloudCrypto } from '../crypto/port';
import { type ByokCloud, type ByokCloudOptions } from '../cloud';
import type { BlobContentProxy, CloudStores } from '../stores/ports';
import type { TruthCommitter, TruthObjectDownloads } from '../truth/contract';
import type { AgentMemoryProjectionAuthorizer, AgentMemoryProjectionStore } from '../agent-memory-projection';
export interface InMemoryByokCloudOptions {
    readonly clock?: Clock;
    readonly crypto?: CloudCrypto;
    readonly tokenSigner?: TokenSigner;
    readonly capabilities?: CapabilityDeclaration;
    readonly operatorId?: string;
    /** Single-product instance authority; absent leaves the device row as the whole product authority. */
    readonly instanceProductId?: string;
    readonly maxBlobSizeBytes?: number;
    readonly longPollHoldMs?: number;
    readonly longPollIntervalMs?: number;
    readonly eventsPageLimit?: number;
    readonly accessTokenTtlSeconds?: number;
    readonly boardPageLimit?: number;
    readonly boardStreamQueryIntervalMs?: number;
    readonly boardStreamHeartbeatIntervalMs?: number;
    readonly boardStreamReconciliationIntervalMs?: number;
    readonly boardChannelMaxBytes?: number;
    readonly boardTitleMaxBytes?: number;
    readonly presenceTtlMs?: number;
    readonly presenceMinimumIntervalMs?: number;
    readonly presenceDetailMaxBytes?: number;
    readonly activityMaxEvents?: number;
    readonly activityMaxBytes?: number;
    readonly activityCapacity?: number;
    readonly activityTtlMs?: number;
    /** Test/host supplied atomic truth authority; never synthesized from sequential stores. */
    readonly truthCommitter?: TruthCommitter;
    readonly truthObjectDownloads?: TruthObjectDownloads;
    readonly maxTruthRequestBytes?: number;
    /**
     * Host/test supplied skill pack catalogue. Absent by default, and
     * `fullCapabilityDeclaration()` withholds `skills.pack` to match — a
     * composition that declared a channel it has no store for would be refused at
     * construction, which would break every existing in-memory deployment.
     */
    readonly skillPacks?: SkillPackStore;
    readonly skillPackPageLimit?: number;
    readonly agentMessage?: ByokCloudOptions['agentMessage'];
    /** Post-commit relay; absent means nothing is watching. */
    readonly observer?: ByokCloudOptions['observer'];
    readonly agentMemoryProjectionAuthorizer?: AgentMemoryProjectionAuthorizer;
    readonly agentMemoryProjectionStore?: AgentMemoryProjectionStore;
}
export interface InMemoryByokCloud {
    readonly cloud: ByokCloud;
    /** The naked stores, for a host that wants to inspect or seed state directly. */
    readonly core: CoreStores;
    readonly stores: CloudStores;
    /** The byte proxy the two `/content` routes were mounted on. */
    readonly blobContentProxy: BlobContentProxy;
    readonly clock: Clock;
    readonly crypto: CloudCrypto;
}
export declare function createInMemoryByokCloud(options?: InMemoryByokCloudOptions): InMemoryByokCloud;
// ==== @byok-sdk/cloud dist/coordination-client.d.ts ====
import { type CapabilityDeclaration } from '@byok-sdk/core';
import { z } from 'zod';
declare const BoardFeedItemSchema: z.ZodObject<{
    tenantId: z.ZodString;
    itemId: z.ZodString;
    channel: z.ZodString;
    title: z.ZodString;
    status: z.ZodEnum<{
        closed: "closed";
        done: "done";
        in_progress: "in_progress";
        in_review: "in_review";
        todo: "todo";
    }>;
    assignee: z.ZodOptional<z.ZodObject<{
        holderId: z.ZodString;
        heldSince: z.ZodString;
    }, z.core.$strip>>;
    boardSeq: z.ZodNumber;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>;
declare const BoardFeedPageSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        tenantId: z.ZodString;
        itemId: z.ZodString;
        channel: z.ZodString;
        title: z.ZodString;
        status: z.ZodEnum<{
            closed: "closed";
            done: "done";
            in_progress: "in_progress";
            in_review: "in_review";
            todo: "todo";
        }>;
        assignee: z.ZodOptional<z.ZodObject<{
            holderId: z.ZodString;
            heldSince: z.ZodString;
        }, z.core.$strip>>;
        boardSeq: z.ZodNumber;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
    }, z.core.$strip>>;
    nextSeq: z.ZodNumber;
    hasMore: z.ZodBoolean;
}, z.core.$strip>;
export type BoardFeedItem = z.infer<typeof BoardFeedItemSchema>;
export type BoardFeedPage = z.infer<typeof BoardFeedPageSchema>;
export type BoardFeedMode = 'sse' | 'poll';
export type BoardFeedRead = {
    readonly type: 'board';
    readonly item: BoardFeedItem;
} | {
    readonly type: 'reconcile';
} | {
    readonly type: 'poll';
    readonly page: BoardFeedPage;
};
export declare class BoardFeedRetryableError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare class BoardFeedStoppedError extends Error {
    constructor(message: string);
}
export interface BoardFeedClientOptions {
    readonly baseUrl: string | URL;
    readonly accessToken: string;
    readonly capabilities: CapabilityDeclaration;
    readonly fetch?: typeof globalThis.fetch;
    readonly idleWatchdogMs?: number;
}
/**
 * One board feed consumer with a declaration-fixed transport.
 *
 * The mode is selected once from ADR-010 data. A temporary SSE 5xx or idle
 * watchdog expiry raises {@link BoardFeedRetryableError}; it never mutates the
 * mode to polling. A caller retries the same instance and therefore the same
 * declared transport. Polling exists only when `board.sse` was absent from the
 * declaration in the first place.
 */
export declare class BoardFeedClient {
    #private;
    readonly mode: BoardFeedMode;
    constructor(options: BoardFeedClientOptions);
    readOnce(afterSeq: number, signal?: AbortSignal): Promise<BoardFeedRead>;
}
export {};
// ==== @byok-sdk/cloud dist/coordination.d.ts ====
import type { AgentEventOrUnknown } from '@byok-sdk/protocol';
import { type ActivityAppendInput, type ActivityTail } from './activity';
import type { TenantBoundActivity } from './tenant-stores';
export declare const DEFAULT_BOARD_CHANNEL_MAX_BYTES = 128;
export declare const DEFAULT_BOARD_TITLE_MAX_BYTES = 512;
export declare const DEFAULT_ACTIVITY_MAX_EVENTS = 50;
export declare const DEFAULT_ACTIVITY_MAX_BYTES: number;
export { DEFAULT_ACTIVITY_CAPACITY } from './activity';
export declare const DEFAULT_ACTIVITY_TTL_MS: number;
export declare const DEFAULT_PRESENCE_TTL_MS = 90000;
export declare const DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS = 5000;
export declare const DEFAULT_PRESENCE_DETAIL_MAX_BYTES = 512;
export interface ActivityBounds {
    readonly maxEvents: number;
    readonly maxBytes: number;
    readonly capacity: number;
    readonly ttlMs: number;
}
export declare const DEFAULT_ACTIVITY_BOUNDS: ActivityBounds;
export declare function assertBoardLabels(channel: string, title: string, limits: {
    readonly channelMaxBytes: number;
    readonly titleMaxBytes: number;
}): void;
/**
 * The page bound on {@link TaskAttemptStore.list}. Fail-closed rather than
 * defaulted or clamped: a caller that asks for `0`, `-1`, `2.5`, or `Infinity`
 * has a bug, and answering it with a silently substituted limit hides that bug
 * behind a plausible page. Enforced in the STORE rather than only at the
 * façade, because the port is reachable directly by a host composition.
 */
export declare function assertTaskAttemptListLimit(limit: number): void;
export declare function validateActivityEvents(events: readonly AgentEventOrUnknown[], dropped: number, bounds: ActivityBounds): void;
export declare function validateActivityBatch(input: Omit<ActivityAppendInput, 'ttlMs' | 'capacity'>, bounds: ActivityBounds): void;
export declare function appendActivityEvents(activity: TenantBoundActivity, input: {
    readonly taskId: string;
    readonly sourceEnvelopeId: string;
    readonly batchSeq: number;
    readonly events: readonly AgentEventOrUnknown[];
    readonly dropped: number;
}, bounds: ActivityBounds): Promise<ActivityTail>;
// ==== @byok-sdk/cloud dist/crypto/port.d.ts ====
/**
 * The crypto seam.
 *
 * `@byok-sdk/server` reaches straight for `node:crypto`. Cloud cannot: a hosted
 * composition has to load on Workers and Deno too, and `src/__tests__/
 * constraints.test.ts` asserts this package never imports a `node:` module.
 * So every primitive the device surface needs — random identifiers, Ed25519
 * verification of a challenge signature, HMAC for presigned blob URLs,
 * SHA-256 for content addressing — arrives through this port.
 *
 * `web-crypto.ts` in this directory is the reference implementation, built on
 * the WebCrypto API that Node >=20, Workers, and Deno all expose as
 * `globalThis.crypto`. A composition backed by a KMS or an HSM supplies its
 * own instead.
 */
export interface CloudCrypto {
    /** A fresh UUID v4 — envelope ids, device ids, blob ids, task ids. */
    randomUuid(): string;
    /** `byteLength` random bytes, base64url-encoded — nonces and opaque tokens. */
    randomToken(byteLength: number): string;
    /** A short, human-typeable pairing code (uppercase, unambiguous alphabet). */
    randomPairingCode(length: number): string;
    /**
     * Verify `signature` (base64url) over `message` against
     * `publicKeyBase64Url` — a raw 32-byte Ed25519 public key in the same
     * base64url encoding a JWK's `x` field uses, which is what a device
     * registers at pairing time. String input is encoded as UTF-8; byte input is
     * used verbatim so core's frozen device-proof signing bytes are not decoded
     * and re-encoded by the adapter.
     *
     * Never throws: a malformed key or signature is a failed verification, not
     * an exception a route has to translate.
     */
    verifyEd25519(publicKeyBase64Url: string, message: string | Uint8Array, signature: string): Promise<boolean>;
    /** HMAC-SHA-256 over `message`, base64url-encoded. Used for presigned blob URLs. */
    hmacSha256(secret: Uint8Array, message: string): Promise<string>;
    /** SHA-256 of `data`, in core's canonical `sha256:<64 lowercase hex>` form. */
    sha256(data: Uint8Array): Promise<string>;
    /**
     * Length-independent equality for two base64url strings. Signature
     * comparison must not leak a prefix through timing.
     */
    timingSafeEqual(left: string, right: string): boolean;
}
// ==== @byok-sdk/cloud dist/crypto/web-crypto.d.ts ====
/**
 * The reference {@link CloudCrypto}, built entirely on the WebCrypto API that
 * Node >=20, Cloudflare Workers, and Deno all expose as `globalThis.crypto`.
 *
 * No `node:crypto`, no dependency: the point of the port is that a hosted
 * composition stays runtime-neutral, and an adapter that reached for a Node
 * built-in here would make that claim false for the default composition.
 */
import type { CloudCrypto } from './port';
export declare function base64UrlEncode(bytes: Uint8Array): string;
/**
 * Decode base64url. Returns `undefined` rather than throwing for input that
 * is not base64url at all — every caller here is verifying attacker-supplied
 * material, where "not decodable" and "does not verify" must be the same
 * answer.
 */
export declare function base64UrlDecode(value: string): Uint8Array | undefined;
/**
 * WebCrypto's own types are derived from the runtime's `globalThis.crypto`
 * rather than named directly: `CryptoKey`/`SubtleCrypto`/`KeyUsage` are DOM
 * lib globals, and this package compiles without the DOM lib (a Workers build
 * has no DOM either). Deriving keeps the types exact without pulling in a
 * `node:` import or widening `lib`.
 */
export type SubtleCryptoLike = typeof globalThis.crypto.subtle;
export type CryptoKeyLike = Awaited<ReturnType<SubtleCryptoLike['importKey']>>;
export type KeyUsageLike = Parameters<SubtleCryptoLike['importKey']>[4][number];
export declare function createWebCrypto(): CloudCrypto;
// ==== @byok-sdk/cloud dist/errors.d.ts ====
/**
 * The one error taxonomy for `@byok-sdk/cloud`.
 *
 * Same idiom as `@byok-sdk/core`'s `errors.ts`: one class, code-based branching,
 * so a composition maps failures onto HTTP with a code table instead of an
 * `instanceof` chain. Cloud does not re-export core's codes — a cloud error is
 * about the hosted surface (a store contract the composition broke, a
 * declaration the host mis-configured), and core errors travel up unchanged.
 */
export declare const CLOUD_ERROR_CODES: {
    /** A pairing code that is unknown, expired, or already redeemed (§6.1). */
    readonly pairing_code_invalid: 'pairing_code_invalid';
    /** The composition handed a device row whose tenant is not a mintable `TenantId`. */
    readonly device_tenant_invalid: 'device_tenant_invalid';
    /**
     * The mailbox committed a row `seq` that disagrees with the delivery `seq`
     * its body factory baked into the envelope. Loud rather than silent: those
     * two numbers ARE the daemon's redelivery cursor.
     */
    readonly mailbox_seq_mismatch: 'mailbox_seq_mismatch';
    /** A capability declaration the host supplied that core refused. */
    readonly capability_declaration_invalid: 'capability_declaration_invalid';
    /**
     * The declaration names a capability this composition cannot serve, so the
     * deployment would publish a surface it does not have (ADR-010).
     *
     * Construction-time and fatal. A client learns what a deployment supports by
     * READING the declaration and is entitled to act on it without probing, so a
     * declaration that over-states is not a degraded deployment — it is a
     * deployment whose one honest interface lies.
     */
    readonly capability_over_declared: 'capability_over_declared';
    /** Host-supplied board labels or coordination input exceeded the explicit contract. */
    readonly coordination_input_invalid: 'coordination_input_invalid';
    /**
     * A terminal receipt whose stored body is not a terminal envelope — either
     * undecodable or a non-terminal type. Whatever wrote that row broke the
     * receipt-store contract, so the typed read model fails closed instead of
     * projecting a best-effort shape.
     */
    readonly terminal_receipt_unreadable: 'terminal_receipt_unreadable';
    /** A progress/activity batch exceeded the configured event or byte ceiling. */
    readonly activity_batch_too_large: 'activity_batch_too_large';
    /** Host control-plane task lookup is tenant-closed and found no task. */
    readonly task_not_found: 'task_not_found';
    /**
     * A host `approveTask`/`rejectTask` names a task with no approval to
     * resolve: the durable timeline holds no unresolved `approval_requested`
     * (including a tail that has expired or was never written), the attempt has
     * already reached a terminal status, or no device ever claimed it so there
     * is nothing to notify. Fail-closed by construction — cloud never invents a
     * pending approval to make the call succeed.
     */
    readonly task_not_awaiting_approval: 'task_not_awaiting_approval';
    /** Durable target-device capability is absent, revoked, or unavailable. */
    readonly agent_capability_missing: 'agent_capability_missing';
    /** Inbound Agent identity did not exactly match the offered identity. */
    readonly agent_ref_mismatch: 'agent_ref_mismatch';
    /** A strict Agent task id already names a durable attempt and cannot be re-enqueued. */
    readonly agent_task_already_exists: 'agent_task_already_exists';
    /** A first-write-wins Agent control record was replayed with a different body. */
    readonly agent_content_request_mismatch: 'agent_content_request_mismatch';
    /** A durable mailbox receipt id resolved to an envelope other than its exact acknowledgement. */
    readonly mailbox_receipt_mismatch: 'mailbox_receipt_mismatch';
    /** A task-free Agent-home request id already names a different immutable desired projection. */
    readonly agent_home_projection_request_conflict: 'agent_home_projection_request_conflict';
    /** A direct Agent-home completion did not identify a stored desired request for this exact device. */
    readonly agent_home_projection_request_not_found: 'agent_home_projection_request_not_found';
    /** A direct Agent-home completion changed the first durable terminal outcome. */
    readonly agent_home_projection_completion_conflict: 'agent_home_projection_completion_conflict';
    /** A task-free completion did not exactly echo its immutable desired projection binding. */
    readonly agent_home_projection_receipt_mismatch: 'agent_home_projection_receipt_mismatch';
    /** A receipt-store row at the projection namespace violated the frozen projection schema. */
    readonly agent_home_projection_receipt_invalid: 'agent_home_projection_receipt_invalid';
    /** A hosted Agent-memory mutation did not match the durable task/device/AgentRef binding. */
    readonly agent_memory_projection_task_mismatch: 'agent_memory_projection_task_mismatch';
    /** The embedder-owned grant/consent authority denied a hosted memory mutation. */
    readonly agent_memory_projection_authorization_denied: 'agent_memory_projection_authorization_denied';
    /** A redacted snapshot's decoded bytes did not match its declared hash or byte count. */
    readonly agent_memory_projection_hash_mismatch: 'agent_memory_projection_hash_mismatch';
    /** A writer epoch/source sequence already names a different immutable projection mutation. */
    readonly agent_memory_projection_replay_mismatch: 'agent_memory_projection_replay_mismatch';
    /** A hosted memory mutation came from an older writer epoch. */
    readonly agent_memory_projection_stale_epoch: 'agent_memory_projection_stale_epoch';
    /** A server-side erase fence prevents a deleted writer epoch from re-entering. */
    readonly agent_memory_projection_erased_epoch: 'agent_memory_projection_erased_epoch';
    /** A prior erase reached the protocol writer-epoch ceiling and cannot mint a later writer. */
    readonly agent_memory_projection_epoch_exhausted: 'agent_memory_projection_epoch_exhausted';
    /** A hosted memory mutation skipped or reset a required source sequence. */
    readonly agent_memory_projection_sequence_gap: 'agent_memory_projection_sequence_gap';
};
export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[keyof typeof CLOUD_ERROR_CODES];
export declare class ByokCloudError extends Error {
    readonly code: CloudErrorCode;
    constructor(code: CloudErrorCode, message: string, options?: ErrorOptions);
}
export declare function isCloudError(value: unknown, code?: CloudErrorCode): value is ByokCloudError;
// ==== @byok-sdk/cloud dist/handlers/board.d.ts ====
import { type BoardPage } from '@byok-sdk/core';
import type { Context } from 'hono';
import { type DeviceRouteDeps } from './shared';
export declare const DEFAULT_BOARD_PAGE_LIMIT = 50;
export declare const DEFAULT_BOARD_STREAM_QUERY_INTERVAL_MS = 5000;
export declare const DEFAULT_BOARD_STREAM_HEARTBEAT_INTERVAL_MS = 15000;
export declare const DEFAULT_BOARD_STREAM_RECONCILIATION_INTERVAL_MS = 120000;
export interface BoardRouteDeps extends DeviceRouteDeps {
    readonly pageLimit: number;
}
export interface BoardStreamRouteDeps extends BoardRouteDeps {
    readonly queryIntervalMs: number;
    readonly heartbeatIntervalMs: number;
    readonly reconciliationIntervalMs: number;
}
export declare function boardListHandler(deps: BoardRouteDeps): (c: Context) => Promise<Response>;
export declare function boardClaimHandler(deps: DeviceRouteDeps): (c: Context) => Promise<Response>;
export declare function boardUnclaimHandler(deps: DeviceRouteDeps): (c: Context) => Promise<Response>;
export declare function boardStatusHandler(deps: DeviceRouteDeps): (c: Context) => Promise<Response>;
export declare function boardStreamHandler(deps: BoardStreamRouteDeps): (c: Context) => Promise<Response>;
export type BoardPollResponse = BoardPage;
// ==== @byok-sdk/cloud dist/handlers/shared.d.ts ====
/**
 * The two things every device-facing handler starts from: a tolerant JSON body
 * read, and the bearer -> principal -> tenant-closed-facade step.
 *
 * Once {@link authenticateDevice} has answered, a handler holds a
 * `TenantStores` and a `DevicePrincipal` and never sees a `TenantId` again.
 */
import type { Context } from 'hono';
import type { DevicePrincipal } from '@byok-sdk/core';
import { type BearerAuthDeps } from '../auth/bearer';
import { type CloudRootStores, type TenantStores } from '../tenant-stores';
/** Every error response on this surface is `{ error }` — the same shape the reference server uses. */
export interface ErrorBody {
    readonly error: string;
}
export declare function readJsonBody(c: Context): Promise<unknown>;
export interface BoundedJsonBodyResult {
    readonly body: unknown;
    readonly tooLarge: boolean;
}
/**
 * Read and parse one JSON request while retaining a hard byte ceiling before
 * JSON.parse. The declared length is only an early rejection; the stream is
 * still counted because chunked requests may omit Content-Length or lie about
 * it. Invalid JSON remains represented by `body: undefined` for the caller's
 * existing validation status.
 */
export declare function readBoundedJsonBody(c: Context, maximum: number): Promise<BoundedJsonBodyResult>;
export interface DeviceRouteDeps {
    readonly bearer: BearerAuthDeps;
    readonly root: CloudRootStores;
}
export interface AuthenticatedDeviceContext {
    readonly device: DevicePrincipal;
    readonly stores: TenantStores;
}
/**
 * `undefined` means "answer 401" — and it means that for a missing header, a
 * forged token, an expired token, a revoked device, a product mismatch, and a
 * token whose tenant does not own the device, indistinguishably.
 */
export declare function authenticateDevice(c: Context, deps: DeviceRouteDeps): Promise<AuthenticatedDeviceContext | undefined>;
// ==== @byok-sdk/cloud dist/handlers/skill-packs.d.ts ====
/**
 * `GET /byok/skill-packs` and `GET /byok/skill-packs/:name/files/:path` — the
 * hosted half of the skill-pack delivery channel.
 *
 * Two device-class reads, and nothing else. There is no publish route here on
 * purpose: a device is a CONSUMER of packs, and a device-bearer-authed write
 * would let any paired device in a tenant publish content to every other device
 * in it. Publication is a host control-plane action against the store directly,
 * exactly as board item creation is.
 *
 * Both routes answer 404 for a pack this tenant does not have — the same answer
 * a name that never existed anywhere gets — so the surface is not a
 * cross-tenant existence oracle. The store is tenant-first, so that property
 * comes from the lookup key rather than from a comparison a handler could
 * forget.
 *
 * Bytes travel as UTF-8 text inside JSON. A pack carries Markdown, YAML and
 * static text; there is no archive to unpack and no binary channel to
 * negotiate, which is the same reason the manifest has no exec surface — the
 * format cannot express the thing we do not want it to express.
 */
import { type SkillPackStore } from '@byok-sdk/core';
import type { Context } from 'hono';
import { type BearerAuthDeps } from '../auth/bearer';
/** Rows per `GET /byok/skill-packs` response. A tenant's pack catalogue is small by design. */
export declare const DEFAULT_SKILL_PACK_PAGE_LIMIT = 50;
export interface SkillPackRouteDeps {
    readonly bearer: BearerAuthDeps;
    readonly skillPacks: SkillPackStore;
    readonly pageLimit: number;
}
export declare function skillPackListHandler(deps: SkillPackRouteDeps): (c: Context) => Promise<Response>;
export declare function skillPackFileHandler(deps: SkillPackRouteDeps): (c: Context) => Promise<Response>;
// ==== @byok-sdk/cloud dist/handlers/truth.d.ts ====
import { DEVICE_PROOF_HEADER } from '@byok-sdk/core';
import type { Context } from 'hono';
import { type DeviceProofAuthDeps } from '../auth/device-proof';
import { type TruthCommitter, type TruthObjectDownloads } from '../truth/contract';
export { DEVICE_PROOF_HEADER };
export declare const DEFAULT_MAX_TRUTH_REQUEST_BYTES: number;
export declare const MAX_DEVICE_PROOF_HEADER_BYTES: number;
export interface TruthRouteDeps {
    readonly proof: DeviceProofAuthDeps;
    readonly truth: TruthCommitter;
    readonly objectDownloads: TruthObjectDownloads;
    readonly maxRequestBytes: number;
}
export declare function truthManifestHandler(deps: TruthRouteDeps): (c: Context) => Promise<Response>;
export declare function truthGetHandler(deps: TruthRouteDeps): (c: Context) => Promise<Response>;
export declare function truthPutHandler(deps: TruthRouteDeps): (c: Context) => Promise<Response>;
// ==== @byok-sdk/cloud dist/inbound.d.ts ====
/**
 * The single inbound choke point for every daemon -> cloud envelope.
 *
 * The reference server runs this gate inside a live `ConnectionHub`; here it
 * is a pure function over a tenant-closed facade, so the same order holds with
 * no connection, no session, and no cross-request state:
 *
 * 0. **rate limit** — one token per inbound envelope, debited BEFORE anything
 *    else, so a flood of garbage-typed envelopes costs the same budget as a
 *    flood of well-formed ones. S3a's reference limiter allows everything; the
 *    seam is what matters at this position.
 * 1. **type-allow** — only `DAEMON_TO_SERVER_TYPES` may pass, plus the
 *    authenticated long-poll `conn.hello` capability snapshot handled below.
 *    A server -> daemon type arriving inbound, or anything unrecognized, is
 *    rejected before it is dispatched or counted accepted.
 * 2. **ownership** — an envelope for a task already owned by a DIFFERENT
 *    device is dropped, never force-failed: force-failing on an authz mismatch
 *    would let an attacker who merely guesses a `taskId` kill the real owner's
 *    task. A task with no owner yet, or that this tenant does not have at all,
 *    is not rejected here — the store's own no-op-on-missing behavior covers
 *    the latter, and it covers it per tenant, so a guessed id from another
 *    tenant writes nothing anywhere.
 * 3. **dedup** — an envelope id already seen from this device is a no-op. The
 *    wire is at-least-once (§9); this makes processing at-most-once.
 * 4. **apply** — the lifecycle write.
 *
 * A duplicate is still a wire-level success (§8.2): it just did not re-run
 * anything. Only `rejected`/`rate_limited` are excluded from `accepted`.
 *
 * 5. **observe** — an optional {@link ByokCloudObserver} is told, once, about
 *    each envelope whose write committed. It runs after step 4 has returned,
 *    it cannot change the outcome, and it is not the admission hook.
 */
import { type AgentMessageDispositionPayload, type AgentMessagePublishPayload, type AgentMessageServerContext, type Envelope } from '@byok-sdk/protocol';
import type { TenantId } from '@byok-sdk/core';
import { type ActivityBounds } from './coordination';
import type { TenantStores } from './tenant-stores';
export type InboundOutcome = 'accepted' | 'duplicate' | 'rejected' | 'rate_limited';
/**
 * One envelope whose write COMMITTED, handed to {@link ByokCloudObserver}.
 *
 * `outcome` is constant by construction — `accepted` is the only outcome that
 * committed anything — and is carried anyway because it names the fact in the
 * gate's own vocabulary rather than leaving the reader to infer it from the
 * hook's name. A `duplicate` re-ran nothing, a `rejected` and a `rate_limited`
 * wrote nothing; none of them appear here.
 */
export interface InboundCommitted {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly envelope: Envelope;
    readonly outcome: Extract<InboundOutcome, 'accepted'>;
}
/**
 * Post-commit relay for the host (the `TaskHandle` fan-out `@byok-sdk/server`
 * drives off its live hub).
 *
 * Deliberately NOT the admission hook. `ByokCloudOptions.agentMessage.consume`
 * runs BEFORE a write and decides whether it happens; this runs AFTER one and
 * cannot decide anything: it returns `void`, it is called inside a `try`, and
 * a throw from it is swallowed with the outcome already fixed. An observer
 * that wants to refuse work has the admission hook; an observer here is
 * watching, not gating.
 *
 * Synchronous and cheap by contract — it runs inline on the request path.
 */
export interface ByokCloudObserver {
    onInboundCommitted(input: InboundCommitted): void;
}
export declare function handleAgentMessagePublish(stores: TenantStores, deviceId: string, taskId: string, payload: AgentMessagePublishPayload, consume: ((input: {
    readonly tenant: TenantStores['tenant'];
    readonly deviceId: string;
    readonly taskId: string;
    readonly context: AgentMessageServerContext;
    readonly payload: AgentMessagePublishPayload;
}) => Promise<{
    readonly outcome: 'accepted' | 'held' | 'refused';
    readonly reasonCode?: string;
}>) | undefined, alreadyDeduplicated: boolean): Promise<{
    readonly outcome: InboundOutcome;
    readonly disposition?: AgentMessageDispositionPayload;
}>;
/** Reads only a terminal immutable admission; pending rows have no disposition to acknowledge. */
export declare function readAgentMessageDisposition(stores: TenantStores, deviceId: string, taskId: string, payload: AgentMessagePublishPayload): Promise<AgentMessageDispositionPayload | undefined>;
/** Receipt key a task's terminal is recorded under — the idempotency seam S3b's journal will share. */
export declare function terminalReceiptKey(taskId: string): string;
export declare function handleInboundEnvelope(stores: TenantStores, deviceId: string, envelope: Envelope, activityBounds?: ActivityBounds, agentMessageConsume?: Parameters<typeof handleAgentMessagePublish>[4], observer?: ByokCloudObserver): Promise<InboundOutcome>;
// ==== @byok-sdk/cloud dist/index.d.ts ====
/**
 * `@byok-sdk/cloud` — the hosted device surface.
 *
 * Cloud sits BESIDE `@byok-sdk/server`, not above it (§12.1): `cloud → core +
 * protocol`, and never `cloud → server`. The self-hosted embedded coordinator
 * stays the self-hosted option; this package serves the same frozen v1 device
 * wire contract statelessly, over `@byok-sdk/core` ports plus the cloud-local auth
 * and task ports in `stores/ports.ts`.
 *
 * `src/__tests__/constraints.test.ts` asserts the properties this export list
 * implies: no `@byok-sdk/server` import, no `node:` import, no module-level
 * mutable state, no session/Running map, and no route mounted outside the I1
 * registry.
 */
export { isTenantId, tenantId } from '@byok-sdk/core';
export type { TenantId } from '@byok-sdk/core';
export { createByokCloud } from './cloud';
export type { ByokCloud, ByokCloudOptions, AgentDispatchInput, AgentEgressDispatchInput, AgentEgressFreshSessionDispatchInput, AgentContentReadInput, AgentHomeProjectionInput, AgentHomeProjectionStatusInput, ApproveTaskOptions, EnqueueOfferInput, EnqueueToolsetOfferInput, RejectTaskOptions, EnqueuedAgentControl, EnqueuedAgentHomeProjection, EnqueuedOffer, } from './cloud';
export { agentHomeProjectionCompletionKey, agentHomeProjectionRequestKey, readAgentHomeProjectionStatus, recordAgentHomeProjectionCompletion, } from './agent-home-projections';
export type { AgentHomeProjectionReceiptInput } from './agent-home-projections';
export { AGENT_HOME_CONTRACT_CAPABILITY, DEFAULT_EVENTS_PAGE_LIMIT, DEFAULT_LONG_POLL_HOLD_MS, DEFAULT_LONG_POLL_INTERVAL_MS, DEFAULT_MAX_BLOB_SIZE_BYTES, } from './cloud';
export { DEFAULT_BOARD_PAGE_LIMIT, DEFAULT_BOARD_STREAM_HEARTBEAT_INTERVAL_MS, DEFAULT_BOARD_STREAM_QUERY_INTERVAL_MS, DEFAULT_BOARD_STREAM_RECONCILIATION_INTERVAL_MS, } from './handlers/board';
export { DEFAULT_SKILL_PACK_PAGE_LIMIT } from './handlers/skill-packs';
export { createInMemoryByokCloud } from './composition/in-memory';
export type { InMemoryByokCloud, InMemoryByokCloudOptions } from './composition/in-memory';
export { ByokCloudError, CLOUD_ERROR_CODES, isCloudError } from './errors';
export type { CloudErrorCode } from './errors';
export { InMemoryAgentMemoryProjectionAuthorizer, InMemoryAgentMemoryProjectionStore, } from './stores/in-memory/agent-memory-projection';
export type { AgentMemoryProjectionAuthorization, AgentMemoryProjectionEraseResult, AgentMemoryProjectionAuthorizer, AgentMemoryProjectionAuthorizerInput, AgentMemoryProjectionCommitInput, AgentMemoryProjectionMeteringReceipt, AgentMemoryProjectionMutation, AgentMemoryProjectionReceipt, AgentMemoryProjectionStore, } from './agent-memory-projection';
export { CLOUD_CAPABILITIES, CapabilitiesResponseSchema, declares, fullCapabilityDeclaration, } from './capabilities';
export type { CapabilitiesResponse, CloudCapability, FullCapabilityDeclarationOptions, } from './capabilities';
export { CloudRouteRegistry, ROUTE_CLASSES, ROUTE_METHODS, routeKey } from './router/registry';
export type { CloudRouteHandler, RouteClass, RouteDescriptor, RouteMethod } from './router/registry';
export { ACCESS_TOKEN_TTL_SECONDS, createHmacTokenSigner } from './auth/tokens';
export type { AccessTokenClaims, TokenSigner } from './auth/tokens';
export { NONCE_SIGNING_DOMAIN, verifyNonceSignature } from './auth/verify';
export { authenticateBearer, extractBearerToken } from './auth/bearer';
export type { BearerAuthDeps } from './auth/bearer';
export { DEFAULT_DEVICE_PROOF_CLOCK_SKEW_MS, DEFAULT_DEVICE_PROOF_MAX_LIFETIME_MS, MAX_DEVICE_PROOF_CLOCK_SKEW_MS, MAX_DEVICE_PROOF_MAX_LIFETIME_MS, authenticateDeviceProof, } from './auth/device-proof';
export type { AuthenticatedDeviceProof, DeviceProofAuthDeps, DeviceProofRequestBinding, } from './auth/device-proof';
export { authenticateHostedDeviceAssertion } from './auth/device-assertion';
export type { HostedDeviceAssertionAuthDeps } from './auth/device-assertion';
export { DEVICE_IDENTITY_PROOF_KEY_EPOCH, DEVICE_IDENTITY_PROOF_KEY_ID, PAIRING_CODE_TTL_MS, createAuthPlane, } from './auth/plane';
export type { AuthPlane, AuthPlaneDeps, MintedAccessToken, PairInput } from './auth/plane';
export { createWebCrypto } from './crypto/web-crypto';
export type { CloudCrypto } from './crypto/port';
export { handleInboundEnvelope, terminalReceiptKey } from './inbound';
export type { ByokCloudObserver, InboundCommitted, InboundOutcome } from './inbound';
export { projectTerminalResult } from './terminal-result';
export type { TerminalResult } from './terminal-result';
export { tenantStoresFor } from './tenant-stores';
export type { TenantBoundActivity, TenantBoundApprovalTimeline, TenantBoundBoard, CloudRootStores, TenantBoundBlobs, TenantBoundDedup, TenantBoundDevices, TenantBoundMailbox, TenantBoundPresence, TenantBoundQuota, TenantBoundRateLimiter, TenantBoundReceipts, TenantBoundTaskAttempts, TenantStores, } from './tenant-stores';
export { ApprovalObservationSchema, ApprovalTimelineEventSchema, APPROVAL_SUMMARY_MAX_BYTES, DEFAULT_APPROVAL_TIMELINE_CAPACITY, DEFAULT_APPROVAL_TIMELINE_TTL_MS, approvalTimelineCursor, parseApprovalObservations, validateApprovalTimelineAppend, } from './approval-timeline';
export type { ApprovalObservation, ApprovalTimelineAppendInput, ApprovalTimelineEvent, ApprovalTimelineStore, ApprovalTimelineTail, } from './approval-timeline';
export { StaleApprovalError, pendingApproval } from './approval-control';
export type { PendingApproval } from './approval-control';
export { SteerRejectedError } from './steer-control';
export type { SteerRejectionCode } from './steer-control';
export { assertTaskAttemptListLimit, DEFAULT_ACTIVITY_BOUNDS, DEFAULT_ACTIVITY_CAPACITY, DEFAULT_ACTIVITY_MAX_BYTES, DEFAULT_ACTIVITY_MAX_EVENTS, DEFAULT_ACTIVITY_TTL_MS, DEFAULT_BOARD_CHANNEL_MAX_BYTES, DEFAULT_BOARD_TITLE_MAX_BYTES, DEFAULT_PRESENCE_DETAIL_MAX_BYTES, DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS, DEFAULT_PRESENCE_TTL_MS, } from './coordination';
export type { ActivityBounds } from './coordination';
export { TimelineEventSchema, ActivityAppendRequestSchema, activityCursor, parseTimelineEvents, projectTimelineEvents, validateActivityAppend, } from './activity';
export type { ActivityAppendInput, ActivityCursor, ActivityStore, ActivityTail, TimelineEvent, } from './activity';
export { BoardFeedClient, BoardFeedRetryableError, BoardFeedStoppedError } from './coordination-client';
export type { BoardFeedClientOptions, BoardFeedItem, BoardFeedMode, BoardFeedPage, BoardFeedRead, } from './coordination-client';
export { TRUTH_BATCH_MAX_RECORDS, TRUTH_INLINE_CONTENT_TYPE, TRUTH_LABEL_MAX_LENGTH, TRUTH_MANIFEST_MAX_LIMIT, TRUTH_RECORD_CAPABILITY, TRUTH_RECORD_KEY_MAX_LENGTH, TRUTH_REQUEST_ID_MAX_LENGTH, TruthBodyInputSchema, TruthCommitResponseSchema, TruthRecordKeySchema, TruthRecordMetadataSchema, TruthWriteRequestSchema, truthManifestMetadata, truthRecordMetadata, } from './truth/contract';
export { DEFAULT_MAX_TRUTH_REQUEST_BYTES, DEVICE_PROOF_HEADER, MAX_DEVICE_PROOF_HEADER_BYTES, } from './handlers/truth';
export type { PreparedTruthWrite, TruthBodyInput, TruthCommitInput, TruthCommitResponse, TruthCommitResult, TruthCommitter, TruthObjectDownloads, TruthRecordMetadata, TruthWriteRequest, } from './truth/contract';
export { TruthCommitError, isTruthCommitError } from './truth/errors';
export type { TruthCommitErrorCode } from './truth/errors';
export { BLOB_READ_ERROR_CODES, CLOUD_STORE_NAMES, TASK_ATTEMPT_STATUSES, } from './stores/ports';
export { CLOUD_PORT_INTERFACES, CLOUD_PORT_METHODS } from './stores/ports-contract';
export type { BlobContent, BlobContentProxy, BlobDeclaration, BlobObservation, BlobReadErrorCode, BlobReadResult, BlobWriteResult, CloudBlobStore, CloudStoreName, CloudStores, DeviceDirectory, DeviceRecord, DeviceRegistration, InboundDedupStore, InboundRateLimiter, NonceStore, PairingCodeClaims, PairingCodeInfo, PairingCodeIssueInput, PairingCodeStore, PairingEnrollment, PairingEnrollmentInput, ProofRequestReceipt, ProofRequestReceiptInput, ProofRequestReceiptStore, RequestReceipt, RequestReceiptStore, TaskAttempt, TaskAttemptListQuery, TaskAttemptPage, TaskAttemptStatus, TaskAttemptStore, AgentRef, AgentEgressRecord, AgentEgressStore, AgentMessageAdmission, TaskCancellationMutation, TaskCancellationRequest, TaskCancellationStore, } from './stores/ports';
export { AllowAllRateLimiter, BLOB_URL_TTL_MS, DEDUP_RING_CAPACITY, InMemoryBlobContentProxy, InMemoryCloudBlobStore, InMemoryActivityStore, InMemoryDeviceDirectory, InMemoryInboundDedupStore, InMemoryNonceStore, InMemoryPairingCodeStore, InMemoryRequestReceiptStore, InMemoryAgentEgressStore, InMemoryProofRequestReceiptStore, InMemoryTaskAttemptStore, InMemoryTaskCancellationStore, NONCE_TTL_MS, createInMemoryBlobs, createInMemoryCloudStores, } from './stores/in-memory/index';
export type { InMemoryBlobStoreOptions, InMemoryBlobs, InMemoryCloudComposition, } from './stores/in-memory/index';
// ==== @byok-sdk/cloud dist/router/registry.d.ts ====
/**
 * The route inventory (sprint I1).
 *
 * Isolation review starts by asking "what routes exist, and what does each one
 * require?" — a question that is only answerable if the answer cannot drift
 * from what is actually mounted. So mounting goes through {@link
 * CloudRouteRegistry.register} and nowhere else: the registry owns the Hono
 * app, hands out no reference to it that could be mounted on directly, and
 * records a class for every route as it goes.
 *
 * `src/__tests__/route-inventory.test.ts` closes that loop in BOTH directions
 * against Hono's own `app.routes` table: a mounted route missing from the
 * inventory fails the suite, and an inventoried route that never reached the
 * router fails it too. A route whose class is not one of {@link ROUTE_CLASSES}
 * cannot be registered at all.
 */
import { type Context } from 'hono';
/**
 * What a route requires of its caller. Not a description of the handler's
 * work — a description of the credential it is authenticated by, which is the
 * thing an isolation review has to enumerate:
 *
 * - `device` — a bearer access token; resolves to a `DevicePrincipal` and a
 *   tenant-closed facade.
 * - `proof` — a request-bound Ed25519 device proof; tenant/product/key
 *   authority comes from the current device row, not protected claims.
 * - `presigned` — no principal at all; an HMAC signature over the resource id
 *   plus an expiry IS the credential (§7's two `/content` routes).
 * - `public` — deliberately unauthenticated; must expose nothing tenant-scoped.
 */
export declare const ROUTE_CLASSES: readonly ['device', 'proof', 'presigned', 'public'];
export type RouteClass = (typeof ROUTE_CLASSES)[number];
export declare const ROUTE_METHODS: readonly ['GET', 'POST', 'PUT'];
export type RouteMethod = (typeof ROUTE_METHODS)[number];
export interface RouteDescriptor {
    readonly method: RouteMethod;
    readonly path: string;
    readonly class: RouteClass;
}
export type CloudRouteHandler = (c: Context) => Response | Promise<Response>;
export declare function routeKey(route: {
    readonly method: string;
    readonly path: string;
}): string;
export declare class CloudRouteRegistry {
    #private;
    register(descriptor: RouteDescriptor, handler: CloudRouteHandler): void;
    /** The inventory, in registration order. */
    get routes(): readonly RouteDescriptor[];
    /** What the router actually mounted, read back off Hono itself — the other half of the I1 comparison. */
    get mounted(): readonly {
        readonly method: string;
        readonly path: string;
    }[];
    get fetch(): (request: Request, ...rest: unknown[]) => Response | Promise<Response>;
}
// ==== @byok-sdk/cloud dist/steer-control.d.ts ====
/**
 * GAP-2: why a `cloud.steerTask` call was refused, and the one input that
 * decides it.
 *
 * The reference server (`ConnectionHub.steerTask`, `packages/server/src/hub.ts`)
 * reaches this decision from `TaskSnapshot.claimedRuntimeCapabilities` — the
 * capability block the CLAIMING adapter reported for itself on its own
 * `task.claim`, frozen at the `Offered -> Claimed` transition. Cloud keeps the
 * same single source: {@link TaskAttempt.claimedRuntimeCapabilities}, written by
 * the claim that wins the ownership CAS (`stores/ports.ts`) and never again.
 *
 * The gap this closes is not cosmetic: only pi's adapter implements steering,
 * and Claude's and Codex's THROW on receiving `task.steer`, which stalls that
 * device's redelivery cursor at that seq forever. So the refusal has to happen
 * before an envelope exists, from a fact that shares a lifecycle with the
 * task-to-runtime binding.
 *
 * Fail-closed on unknown, deliberately: `steer_unsupported_runtime` covers both
 * "the claiming adapter reported `steer: false`" and "this attempt carries no
 * capability snapshot at all" (a daemon whose claim predates the field, an
 * attempt claimed before migration `0018`). Refusing an unknown is a
 * recoverable, operator-visible error; guessing "supported" reintroduces the
 * permanent cursor stall this gate exists to prevent. There is deliberately NO
 * runtime-id allow-list here either — a table mapping `pi -> steerable` would be
 * a second capability authority in the coordination plane, drifting the moment a
 * runtime gains or loses the feature, and the daemon already reports the truth.
 *
 * SINGLE SOURCE, deliberately: the gate reads the claim snapshot and NOTHING
 * from the connection layer. Cloud's connection-level equivalent is
 * `DeviceRecord.capabilities`, written from a bearer-authenticated `conn.hello`
 * (`inbound.ts`) — discovery data describing a device BUILD, not the adapter
 * that took this task. A device can reconnect later with a different adapter
 * set; a task already running must keep being judged against what was true when
 * it was claimed. Same pin the reference server holds in
 * `packages/server/src/__tests__/steer-runtime-capability-gate.test.ts`.
 */
import type { RuntimeId } from '@byok-sdk/protocol';
import type { TaskAttemptStatus } from './stores/ports';
/**
 * Stable strings a caller switches on (an operator UI, an HTTP surface mapping
 * this to a status code) rather than matching error text. Byte-identical to the
 * reference server's `SteerRejectionCode` (`packages/server/src/hub.ts`), so a
 * host that moves from the embedded server to the hosted kernel keeps its own
 * mapping unchanged.
 *
 * - `task_terminal` — the attempt already reached `complete`/`failed`/
 *   `cancelled`. Checked FIRST, so a terminal attempt that is also (obviously)
 *   not running reports the more specific truth, and a steer racing a terminal
 *   transition always resolves terminal-first.
 * - `task_not_running` — the attempt exists and is live, but is `offered`/
 *   `claimed`/`cancel_requested`; there is no running turn to steer yet.
 * - `steer_unsupported_runtime` — the runtime that CLAIMED this attempt cannot
 *   be steered, per the claim-time capability snapshot. A MISSING snapshot
 *   rejects under this same code: unknown is not supported.
 */
export type SteerRejectionCode = 'steer_unsupported_runtime' | 'task_not_running' | 'task_terminal';
/**
 * Thrown by `ByokCloud.steerTask` instead of a generic `Error`, so a caller can
 * tell WHY a steer was refused without matching on message text — the same
 * typed-error idiom as `StaleApprovalError` (`approval-control.ts`).
 *
 * A distinct class rather than a `CloudErrorCode`, for the same reason as
 * `StaleApprovalError`: it carries the state and the runtime the caller needs to
 * explain the refusal, and a code alone cannot.
 *
 * Thrown before any mailbox row is allocated — a refused steer is a NON-EVENT,
 * exactly like a refused approval.
 */
export declare class SteerRejectedError extends Error {
    readonly taskId: string;
    readonly code: SteerRejectionCode;
    /** The attempt's status at the moment the steer was refused. */
    readonly status: TaskAttemptStatus;
    /** {@link TaskAttempt.claimedRuntime} — `undefined` when nothing was ever recorded, which is itself a reason `steer_unsupported_runtime` can fire. */
    readonly runtime: RuntimeId | undefined;
    constructor(taskId: string, code: SteerRejectionCode, 
    /** The attempt's status at the moment the steer was refused. */
    status: TaskAttemptStatus, 
    /** {@link TaskAttempt.claimedRuntime} — `undefined` when nothing was ever recorded, which is itself a reason `steer_unsupported_runtime` can fire. */
    runtime: RuntimeId | undefined);
}
// ==== @byok-sdk/cloud dist/stores/in-memory/activity.d.ts ====
import type { Clock, TenantId } from '@byok-sdk/core';
import { type ActivityAppendInput, type ActivityStore, type ActivityTail } from '../../activity';
export declare class InMemoryActivityStore implements ActivityStore {
    #private;
    private readonly clock;
    constructor(clock: Clock);
    append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail>;
    read(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/agent-egress.d.ts ====
import { type Clock, type TenantId } from '@byok-sdk/core';
import type { AgentEgressRecord, AgentEgressStore } from '../ports';
/** Reference egress fact store. Duplicate event ids return, never overwrite, the first receipt. */
export declare class InMemoryAgentEgressStore implements AgentEgressStore {
    #private;
    constructor(clock: Clock);
    record(tenant: TenantId, input: Omit<AgentEgressRecord, 'tenantId' | 'recordedAt'>): Promise<{
        readonly record: AgentEgressRecord;
        readonly created: boolean;
    }>;
    get(tenant: TenantId, deviceId: string, eventId: string): Promise<AgentEgressRecord | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/agent-memory-projection.d.ts ====
/** In-memory conformance implementation for the one-way hosted memory projection ports. */
import type { Clock, TenantId } from '@byok-sdk/core';
import { type AgentMemoryProjectionEraseResult, type AgentMemoryProjectionReceipt } from '@byok-sdk/protocol';
import type { AgentMemoryProjectionAuthorization, AgentMemoryProjectionAuthorizer, AgentMemoryProjectionAuthorizerInput, AgentMemoryProjectionCommitInput, AgentMemoryProjectionStore } from '../../agent-memory-projection';
import type { CloudCrypto } from '../../crypto/port';
/**
 * Reference transaction semantics: current snapshot bytes and immutable
 * metering receipt advance in the same serialized mutation. Receipts retain
 * metadata only, never a body.
 */
export declare class InMemoryAgentMemoryProjectionStore implements AgentMemoryProjectionStore {
    #private;
    constructor(clock: Clock, crypto: CloudCrypto);
    commit(input: AgentMemoryProjectionCommitInput): Promise<AgentMemoryProjectionReceipt>;
    erase(input: {
        readonly tenantId: TenantId;
        readonly agentId: string;
    }): Promise<AgentMemoryProjectionEraseResult>;
}
/** Test/reference authorizer whose grant registry demonstrates revocation without model booleans. */
export declare class InMemoryAgentMemoryProjectionAuthorizer implements AgentMemoryProjectionAuthorizer {
    #private;
    grant(input: AgentMemoryProjectionAuthorizerInput): void;
    authorize(input: AgentMemoryProjectionAuthorizerInput): Promise<AgentMemoryProjectionAuthorization>;
    revoke(input: {
        readonly tenantId: TenantId;
        readonly agentId: string;
    }): Promise<void>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/approval-timeline.d.ts ====
import type { Clock, TenantId } from '@byok-sdk/core';
import { type ApprovalTimelineAppendInput, type ApprovalTimelineStore, type ApprovalTimelineTail } from '../../approval-timeline';
export declare class InMemoryApprovalTimelineStore implements ApprovalTimelineStore {
    #private;
    private readonly clock;
    constructor(clock: Clock);
    append(tenant: TenantId, input: ApprovalTimelineAppendInput): Promise<ApprovalTimelineTail>;
    read(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/blobs.d.ts ====
/**
 * The in-memory blob pair: metadata and bytes in process memory, HMAC-signed
 * expiring URLs (docs/protocol.md §7).
 *
 * TWO objects, one shared record map, because the contract they satisfy is two
 * things: {@link CloudBlobStore} is the tenant-first port every composition
 * owes, and {@link BlobContentProxy} is the optional byte-carrying half. The
 * in-memory composition is the one that supplies both — it has nowhere else to
 * put bytes — which is why hosted-in-memory behavior is byte-for-byte what it
 * was before the split.
 *
 * They cannot be one object: the port's method inventory is contract data
 * (`CLOUD_PORT_METHODS`) and `@byok-sdk/conformance` asserts a composition's blob
 * store implements EXACTLY the two declared methods. An object carrying all
 * six would fail that assertion, which is the point — the suite is what keeps
 * the narrowed port narrow.
 *
 * The presigned URL form — `/byok/blobs/<id>/content?sig=&exp=` — is the
 * relative shape the daemon's blob client already resolves against its server
 * base, so a hosted deployment is indistinguishable from a self-hosted one on
 * this route too.
 *
 * Tenancy: `createUpload` records the owning tenant and reservation while
 * `observeUpload`/`getDownloadUrl` refuse any other, so the three bearer routes are
 * tenant-closed. The two `/content` routes are presigned by construction and
 * have no principal at all — the signature over the blob id IS the credential
 * (same posture as the reference server, §7).
 */
import { type Clock, type ContentHash, type ObjectStore, type StorageReservation, type TenantId } from '@byok-sdk/core';
import type { CloudCrypto } from '../../crypto/port';
import type { BlobContentProxy, BlobObservation, BlobReadResult, BlobWriteResult, CloudBlobStore } from '../ports';
/** How long a presigned upload/download URL stays valid. */
export declare const BLOB_URL_TTL_MS: number;
interface BlobRecord {
    readonly tenantId: TenantId;
    readonly reservationId: string;
    readonly contentHash: ContentHash;
    readonly byteSize: bigint;
    readonly contentType: string;
    uploaded: boolean;
    data?: Uint8Array;
}
export interface InMemoryBlobStoreOptions {
    readonly urlTtlMs?: number;
}
/**
 * The state both halves read, and the only thing they share.
 *
 * Module-private on purpose: it is not a port, and nothing outside this file
 * should be able to reach a blob record without going through one of the two
 * contracts above.
 */
declare class InMemoryBlobRegistry {
    readonly blobs: Map<string, BlobRecord>;
    readonly reservationBlobs: Map<string, string>;
    readonly clock: Clock;
    readonly crypto: CloudCrypto;
    readonly secret: Uint8Array;
    readonly urlTtlMs: number;
    constructor(clock: Clock, crypto: CloudCrypto, options: InMemoryBlobStoreOptions);
    signUrl(blobId: string, action: 'put' | 'get'): Promise<string>;
    computeSig(blobId: string, action: 'put' | 'get', exp: number): Promise<string>;
}
/** The narrowed port: tenant-first grants, no bytes. */
export declare class InMemoryCloudBlobStore implements CloudBlobStore {
    #private;
    constructor(registry: InMemoryBlobRegistry, objects: ObjectStore);
    createUpload(tenant: TenantId, reservation: StorageReservation): Promise<{
        blobId: string;
        uploadUrl: string;
    }>;
    observeUpload(tenant: TenantId, blobId: string, reservation: StorageReservation): Promise<BlobObservation | undefined>;
    getDownloadUrl(tenant: TenantId, blobId: string): Promise<string | undefined>;
}
/** The optional half: the bytes this composition has nowhere else to put. */
export declare class InMemoryBlobContentProxy implements BlobContentProxy {
    #private;
    constructor(registry: InMemoryBlobRegistry);
    verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): Promise<boolean>;
    expectedUploadBytes(blobId: string): Promise<bigint | undefined>;
    writeContent(blobId: string, data: Uint8Array): Promise<BlobWriteResult>;
    /**
     * Never returns `{ok:false}`: this composition holds the bytes in the same
     * process, so there is no upstream to be unreachable and no stream to be
     * interrupted. Both `BlobReadErrorCode`s are structurally unreachable here
     * — a proxy that fetches from object storage is where they become live.
     */
    readContent(blobId: string): Promise<BlobReadResult | undefined>;
}
/** Both halves over one registry. The only way to obtain either. */
export interface InMemoryBlobs {
    readonly blobs: CloudBlobStore;
    readonly contentProxy: BlobContentProxy;
}
export declare function createInMemoryBlobs(clock: Clock, crypto: CloudCrypto, objects: ObjectStore, options?: InMemoryBlobStoreOptions): InMemoryBlobs;
export {};
// ==== @byok-sdk/cloud dist/stores/in-memory/dedup.d.ts ====
/**
 * In-memory {@link InboundDedupStore} (N3).
 *
 * A bounded ring per (tenant, device), not an unbounded set: the wire is
 * at-least-once (§9), so this makes processing at-most-once without letting a
 * chatty device grow memory without limit. Check-and-record is one call, so a
 * composition cannot accidentally split it into a racy read-then-write.
 */
import { type TenantId } from '@byok-sdk/core';
import type { InboundDedupStore } from '../ports';
/** Ids retained per device. Same order of magnitude as the reference server's ring. */
export declare const DEDUP_RING_CAPACITY = 1024;
export declare class InMemoryInboundDedupStore implements InboundDedupStore {
    #private;
    constructor(capacity?: number);
    checkAndRecord(tenant: TenantId, deviceId: string, envelopeId: string): Promise<boolean>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/device-directory.d.ts ====
/**
 * In-memory {@link DeviceDirectory}.
 *
 * Rows live under a `(tenant, deviceId)` composite key, so a cross-tenant read
 * is not "denied" — it addresses a different key space and finds nothing
 * (§12.6.2 layer 3). The pre-tenant index below maps a deviceId to that same
 * composite key, so a revocation applied through the composite key is
 * immediately visible to `/byok/challenge` and `/byok/token` with no second
 * copy to keep in sync — and a deleted row is removed from BOTH in one step.
 *
 * Revocation DELETES. `DeviceRecord.revoked` survives as the field every auth
 * path already reads, but no record this store writes ever carries `true`:
 * revocation and machine supersession remove the record outright, so "revoked"
 * and "never registered" are one indistinguishable answer rather than two.
 */
import { type PresenceStore, type TenantId, type TenantReadiness } from '@byok-sdk/core';
import type { DeviceDirectory, DeviceRecord, DeviceRegistration } from '../ports';
export declare class InMemoryDeviceDirectory implements DeviceDirectory {
    #private;
    register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord>;
    get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined>;
    /**
     * Revocation removes the registration. A no-op for a device this tenant does
     * not own: revoking what you cannot address changes nothing.
     */
    revoke(tenant: TenantId, deviceId: string): Promise<void>;
    recordCapabilities(tenant: TenantId, input: {
        readonly deviceId: string;
        readonly capabilities: readonly string[];
    }): Promise<DeviceRecord | undefined>;
    list(tenant: TenantId): Promise<readonly DeviceRecord[]>;
    readiness(tenant: TenantId, presence: PresenceStore): Promise<TenantReadiness>;
    resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/index.d.ts ====
/**
 * The in-memory reference implementation of every cloud-local port.
 *
 * Same posture as `@byok-sdk/core`'s: a reference, not a production store. What it
 * guarantees is that the behavior the handler suites assert is achievable
 * without a database — which is what makes those same assertions meaningful
 * when a durable composition (S3b's journal, S4A's schema) runs them later.
 */
import type { Clock, ObjectStore } from '@byok-sdk/core';
import type { CloudCrypto } from '../../crypto/port';
import type { BlobContentProxy, CloudStores } from '../ports';
export { AllowAllRateLimiter } from './rate-limiter';
export { BLOB_URL_TTL_MS, InMemoryBlobContentProxy, InMemoryCloudBlobStore, createInMemoryBlobs, } from './blobs';
export type { InMemoryBlobs, InMemoryBlobStoreOptions } from './blobs';
export { DEDUP_RING_CAPACITY, InMemoryInboundDedupStore } from './dedup';
export { InMemoryDeviceDirectory } from './device-directory';
export { InMemoryNonceStore, NONCE_TTL_MS } from './nonces';
export { InMemoryPairingCodeStore } from './pairing-codes';
export { InMemoryRequestReceiptStore } from './receipts';
export { InMemoryProofRequestReceiptStore } from './proof-receipts';
export { InMemoryTaskAttemptStore } from './task-attempts';
export { InMemoryTaskCancellationStore } from './task-cancellations';
export { InMemoryActivityStore } from './activity';
export { InMemoryApprovalTimelineStore } from './approval-timeline';
export { InMemoryAgentEgressStore } from './agent-egress';
/**
 * The port bundle plus the byte proxy, in the shape `createInMemoryCoreStores`
 * already uses: the composition is an object with a `stores` field, not the
 * bundle itself.
 *
 * `blobContentProxy` sits BESIDE `stores` rather than inside it because it is
 * not a port — `createByokCloud` takes it as its own optional input, and a
 * composition that cannot carry bytes simply has none to hand over.
 */
export interface InMemoryCloudComposition {
    readonly stores: CloudStores;
    readonly blobContentProxy: BlobContentProxy;
}
export declare function createInMemoryCloudStores(clock: Clock, crypto: CloudCrypto, objects: ObjectStore, mailbox: import('@byok-sdk/core').MailboxStore): InMemoryCloudComposition;
// ==== @byok-sdk/cloud dist/stores/in-memory/nonces.d.ts ====
/**
 * In-memory {@link NonceStore}: single-use challenge nonces, ~5min TTL
 * (docs/protocol.md §6.2).
 *
 * A nonce is bound to the (tenant, device) it was issued for, so a nonce
 * issued to one tenant's device is not validatable by another's even if the
 * value leaks.
 */
import { type Clock, type TenantId } from '@byok-sdk/core';
import type { CloudCrypto } from '../../crypto/port';
import type { NonceStore } from '../ports';
/** ~5min, matching the reference server (docs/protocol.md §6.2). */
export declare const NONCE_TTL_MS: number;
export declare class InMemoryNonceStore implements NonceStore {
    #private;
    constructor(clock: Clock, crypto: CloudCrypto, ttlMs?: number);
    /** Number of records currently held (post-sweep). Test-facing only. */
    get size(): number;
    issue(tenant: TenantId, deviceId: string): Promise<string>;
    consumeIfValid(tenant: TenantId, deviceId: string, nonce: string): Promise<boolean>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/pairing-codes.d.ts ====
/**
 * In-memory {@link PairingCodeStore}: single-use codes bound to the tenant and
 * product they were minted for.
 *
 * Enrollment answers `undefined` for unknown, expired, and already-used alike.
 * The reference server distinguishes those three in its 401 text; a hosted,
 * multi-tenant surface deliberately does not — the code is a bearer credential
 * addressable across every tenant, and "already used" versus "never existed"
 * is exactly the difference an attacker enumerating codes would pay for.
 *
 * Code issuance and enrollment project this one authority into separate ports.
 * The enrollment path serializes each code through registration and flips
 * `used` only after its shared device directory has accepted the row.
 */
import type { Clock, TenantId } from '@byok-sdk/core';
import type { DeviceDirectory, DeviceRecord, PairingEnrollment, PairingEnrollmentInput, PairingCodeInfo, PairingCodeIssueInput, PairingCodeStore } from '../ports';
export declare class InMemoryPairingCodeStore implements PairingCodeStore, PairingEnrollment {
    #private;
    constructor(clock: Clock, devices: DeviceDirectory);
    issue(tenant: TenantId, input: PairingCodeIssueInput): Promise<PairingCodeInfo>;
    redeemAndRegister(input: PairingEnrollmentInput): Promise<DeviceRecord | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/proof-receipts.d.ts ====
import { type Clock, type TenantId } from '@byok-sdk/core';
import type { ProofRequestReceipt, ProofRequestReceiptInput, ProofRequestReceiptStore } from '../ports';
export declare class InMemoryProofRequestReceiptStore implements ProofRequestReceiptStore {
    #private;
    constructor(clock: Clock);
    record(tenant: TenantId, input: ProofRequestReceiptInput): Promise<{
        readonly receipt: ProofRequestReceipt;
        readonly created: boolean;
    }>;
    get(tenant: TenantId, deviceId: string, requestId: string): Promise<ProofRequestReceipt | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/rate-limiter.d.ts ====
/**
 * The reference {@link InboundRateLimiter}: allow-all.
 *
 * S3a's job is to put the seam at gate position 0 — before the type-allow
 * check — not to invent a limiter policy. A hosted deployment's real budget
 * lives at its edge; when it arrives it plugs in here and the gate order does
 * not move.
 */
import type { TenantId } from '@byok-sdk/core';
import type { InboundRateLimiter } from '../ports';
export declare class AllowAllRateLimiter implements InboundRateLimiter {
    consume(_tenant: TenantId, _deviceId: string): Promise<boolean>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/receipts.d.ts ====
/**
 * In-memory {@link RequestReceiptStore}: first write wins.
 *
 * The terminal a device reports is a fact, and a retry of the same terminal
 * (the wire is at-least-once) must not overwrite the first one — `created:
 * false` is how the caller learns it was a replay rather than a new fact.
 */
import { type Clock, type TenantId } from '@byok-sdk/core';
import type { RequestReceipt, RequestReceiptStore } from '../ports';
export declare class InMemoryRequestReceiptStore implements RequestReceiptStore {
    #private;
    constructor(clock: Clock);
    record(tenant: TenantId, input: {
        key: string;
        body: string;
    }): Promise<{
        receipt: RequestReceipt;
        created: boolean;
    }>;
    get(tenant: TenantId, key: string): Promise<RequestReceipt | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/task-attempts.d.ts ====
/**
 * In-memory {@link TaskAttemptStore} — the ownership authority the inbound
 * gate reads (N2).
 *
 * Two deliberate no-ops:
 *
 * - `claim` on a task this tenant never offered writes nothing. A device that
 *   guesses a taskId must not be able to conjure a row (and, cross-tenant,
 *   must not leave a trace in the tenant it guessed into).
 * - `recordStatus` on an unknown task writes nothing, mirroring the reference
 *   server's per-type handlers, whose behavior on a missing record is a no-op
 *   rather than a rejection.
 *
 * Ownership is first-claim-wins and never transfers: reassigning an owner is
 * the one operation that would make the gate's cross-device assertion
 * unfalsifiable.
 */
import { type Clock, type TenantId } from '@byok-sdk/core';
import type { RuntimeCapabilities, RuntimeId } from '@byok-sdk/protocol';
import { type AgentMessageAdmission, type AgentRef, type TaskAttempt, type TaskAttemptListQuery, type TaskAttemptPage, type TaskAttemptStatus, type TaskAttemptStore } from '../ports';
export declare class InMemoryTaskAttemptStore implements TaskAttemptStore {
    #private;
    constructor(clock: Clock, state?: InMemoryTaskAttemptState);
    open(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef?: AgentRef;
    }): Promise<TaskAttempt>;
    reserveAgentOffer(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef: AgentRef;
    }): Promise<{
        readonly attempt: TaskAttempt;
        readonly created: boolean;
    }>;
    reserveAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<'reserved' | 'pending' | 'rejected'>;
    readAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<AgentMessageAdmission | undefined>;
    finalizeAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
        readonly terminalBody: string;
    }): Promise<AgentMessageAdmission | undefined>;
    get(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined>;
    getMany(tenant: TenantId, taskIds: readonly string[]): Promise<readonly TaskAttempt[]>;
    list(tenant: TenantId, query: TaskAttemptListQuery): Promise<TaskAttemptPage>;
    claim(tenant: TenantId, input: {
        taskId: string;
        deviceId: string;
        runtime?: RuntimeId;
        capabilities?: RuntimeCapabilities;
    }): Promise<TaskAttempt | undefined>;
    recordStatus(tenant: TenantId, input: {
        readonly taskId: string;
        readonly status: TaskAttemptStatus;
        readonly agentRef?: AgentRef;
        readonly terminalCause?: string;
    }): Promise<TaskAttempt | undefined>;
}
/** Shared mutable state for the task and cancellation reference ports. */
export declare class InMemoryTaskAttemptState {
    #private;
    readonly attempts: Map<string, TaskAttempt>;
    readonly messageAdmissions: Map<string, AgentMessageAdmission>;
    constructor(clock: Clock);
    now(): string;
    /** Serialize every state-changing operation for one tenant/task key. */
    mutate<T>(key: string, operation: () => T | Promise<T>): Promise<T>;
}
// ==== @byok-sdk/cloud dist/stores/in-memory/task-cancellations.d.ts ====
import { type MailboxStore, type TenantId } from '@byok-sdk/core';
import type { TaskCancellationMutation, TaskCancellationRequest, TaskCancellationStore } from '../ports';
import { InMemoryTaskAttemptState } from './task-attempts';
/** Failure-free reference composition of the atomic cancellation port. */
export declare class InMemoryTaskCancellationStore implements TaskCancellationStore {
    #private;
    constructor(state: InMemoryTaskAttemptState, mailbox: MailboxStore);
    request(tenant: TenantId, input: TaskCancellationRequest): Promise<TaskCancellationMutation | undefined>;
}
// ==== @byok-sdk/cloud dist/stores/ports-contract.d.ts ====
/**
 * The declared method inventory of every cloud-local port.
 *
 * The exact counterpart of `@byok-sdk/core`'s `ports-contract.ts`, and it exists
 * for the same reason: the table says what a port IS, so it has to be readable
 * by every enforcer without any of them owning it. `@byok-sdk/conformance` asserts
 * live compositions against it; a durable adapter (`@byok-sdk/cloud-dataplane`) is
 * written against it.
 *
 * This module adds data and nothing else. It does not re-declare, re-shape, or
 * re-interpret a single line of `ports.ts` — that file stays the authority for
 * what the methods mean, and stayed byte-identical through S4A-a.
 *
 * Adding a port method means editing this table, which is the point: a port
 * grows by contract, not by whichever composition needed something.
 */
import type { CloudStoreName } from './ports';
export declare const CLOUD_PORT_METHODS: Readonly<Record<CloudStoreName, readonly string[]>>;
/** The interface each port name is declared as, for a source-side scan. */
export declare const CLOUD_PORT_INTERFACES: Readonly<Record<CloudStoreName, string>>;
// ==== @byok-sdk/cloud dist/stores/ports.d.ts ====
/**
 * The cloud-local store ports.
 *
 * `@byok-sdk/core` owns the platform ports every composition shares (mailbox,
 * board, truth, objects, quota). These are the ones only a HOSTED device
 * surface needs — the auth plane and the task-attempt bookkeeping the device
 * routes read. S2 deliberately kept them out of core: they are hosted-surface
 * concerns, and S4A's schema work is the right moment to decide their durable
 * home. Cloud owning them keeps this slice additive and revertible.
 *
 * Two rules, same as core's (`stores.ts`):
 *
 * 1. **Async.** Every method returns a `Promise`, so a SQL or KV composition
 *    can implement the same contract the in-memory reference does.
 * 2. **Tenant-first.** Every method's first parameter is a required
 *    `TenantId` — with one documented lookup exception below. Pairing code
 *    consumption is a separate composition-owned enrollment operation: its
 *    bearer code resolves the tenant internally and it returns only the
 *    resulting device row.
 *
 * The lookup exception:
 *
 * - {@link DeviceDirectory.resolveByDeviceId} — `POST /byok/challenge` and
 *   `POST /byok/token` carry only a deviceId (the pinned wire contract), and
 *   the row is what tells the deployment which tenant to mint for.
 * It is not reachable through {@link TenantStores} (see `tenant-stores.ts`),
 * so a device-facing handler cannot call it.
 *
 * The byte-proxy trio that used to be a third pre-tenant exception is no
 * longer part of this bundle at all: it moved to {@link BlobContentProxy},
 * an OPTIONAL composition input rather than a {@link CloudStores} member,
 * because a composition backed by object storage physically cannot proxy
 * bytes (see the blobs section below).
 */
import type { MailboxBody, MailboxMessage, PresenceStore, StorageReservation, TenantId, TenantReadiness } from '@byok-sdk/core';
import type { AgentEgressReliablePayload, AgentRef, RuntimeCapabilities, RuntimeId } from '@byok-sdk/protocol';
export type { AgentEgressReliablePayload, AgentRef } from '@byok-sdk/protocol';
import type { ActivityStore } from '../activity';
import type { ApprovalTimelineStore } from '../approval-timeline';
export interface DeviceRecord {
    readonly tenantId: TenantId;
    readonly productId: string;
    readonly deviceId: string;
    readonly deviceName: string;
    /** Ed25519 public key, base64url-encoded (JWK `x` form). */
    readonly devicePublicKey: string;
    /** Proof key identity stored on the row; verifier claims never supply a default. */
    readonly proofKeyId: string;
    /** Current proof signing-key rotation generation. */
    readonly proofKeyEpoch: number;
    /**
     * Always `false`. Revocation and machine supersession DELETE the record, so
     * no implementation ever produces a `true` here; the field stays because
     * every auth path reads it and a missing row must fail exactly as a revoked
     * one used to.
     */
    readonly revoked: boolean;
    /**
     * Client-hashed physical machine identity (lowercase hex SHA-256), when the
     * pairing carried one. Absent for every device paired without it — an
     * absent value supersedes nothing, so it is never a filter that silently
     * groups unidentified machines together.
     */
    readonly machineId?: string;
    /**
     * The latest capability snapshot written by an authenticated device
     * handshake. This is deliberately separate from core presence: presence is
     * lossy/TTL-bounded and cannot authorize Agent dispatch.
     */
    readonly capabilities?: readonly string[];
}
/** Everything `POST /byok/pair` knows at registration time. `tenantId` is the store's first parameter; `revoked` is the store's own to set (always `false`). */
export interface DeviceRegistration {
    readonly productId: string;
    readonly deviceId: string;
    readonly deviceName: string;
    readonly devicePublicKey: string;
    readonly proofKeyId: string;
    readonly proofKeyEpoch: number;
    /**
     * Optional client-hashed physical machine identity from `PairRequest`. When
     * present, `register` DELETES this tenant/product's prior rows carrying the
     * same value — and the device-scoped state those rows were the only reason
     * to keep — before inserting, so one physical machine holds one device row
     * per product. It names no tenant and no product of
     * its own — both still come from the redeemed pairing code's claims — so it
     * can only ever supersede rows the caller already addressed.
     */
    readonly machineId?: string;
}
export interface DeviceDirectory {
    /** Registers the device. With `input.machineId` set this ALSO deletes this tenant/product's prior rows carrying that same machine identity — one physical machine, one row. */
    register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord>;
    /** The row `tenant` owns under `deviceId` — `undefined` including when the device exists under a DIFFERENT tenant. */
    get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined>;
    /**
     * Deletes the registration and the device-scoped state it owned (presence,
     * challenge nonces, assertion-replay entries, inbound dedup) — never the
     * history keyed by the device_id string. A no-op for a device this tenant
     * cannot address. Afterwards every read answers exactly as it does for a
     * device that was never registered.
     *
     * How far the deletion physically reaches is driver-scoped. The durable
     * (Postgres) driver deletes the registration and every dependent
     * device-scoped row in the same transaction, so the state is gone the moment
     * `revoke` resolves. The in-memory reference directory deletes only the
     * registration: its sibling stores are separate maps it does not own, so a
     * presence hint expires on its own `expiresAt` TTL and, until then, is
     * excluded from every projection by the readiness active-device filter
     * (`activeDeviceIds`, built from the surviving rows). The observable contract
     * above holds either way — no read path can see a revoked device.
     */
    revoke(tenant: TenantId, deviceId: string): Promise<void>;
    list(tenant: TenantId): Promise<readonly DeviceRecord[]>;
    /** Set-wise tenant observation. `revokedDeviceCount` is structurally 0 — a revoked device has no row to count. */
    readiness(tenant: TenantId, presence: PresenceStore): Promise<TenantReadiness>;
    /**
     * Persist a capability snapshot obtained from an authenticated device
     * message. Implementations may return `undefined` for an unknown (including
     * revoked, which is the same absence) device; callers must fail closed in
     * that case.
     */
    recordCapabilities(tenant: TenantId, input: {
        readonly deviceId: string;
        readonly capabilities: readonly string[];
    }): Promise<DeviceRecord | undefined>;
    /** Pre-tenant. Two callers only: `POST /byok/challenge` and `POST /byok/token`. Never exposed through the tenant facade. */
    resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined>;
}
/**
 * The identity a pairing code carries. Minted out-of-band by the host's own
 * auth/device-flow UI — the only party that knows which tenant a human is
 * acting for. Deliberately NOT a wire field: `PairRequest` has no tenant of
 * its own, so a device can never name the tenant it lands in.
 */
export interface PairingCodeClaims {
    readonly tenantId: TenantId;
    readonly productId: string;
}
export interface PairingCodeInfo {
    readonly code: string;
    /** Canonical ISO-8601 UTC instant. */
    readonly expiresAt: string;
}
export interface PairingCodeIssueInput {
    readonly code: string;
    readonly productId: string;
    readonly expiresAt: string;
}
export interface PairingCodeStore {
    issue(tenant: TenantId, input: PairingCodeIssueInput): Promise<PairingCodeInfo>;
}
/**
 * The pre-tenant facts a pairing request carries into enrollment. Tenant and
 * product are deliberately absent: the guarded pairing-code row is their sole
 * authority, and no caller can choose the registration scope.
 */
export interface PairingEnrollmentInput {
    readonly pairingCode: string;
    readonly deviceId: string;
    readonly deviceName: string;
    readonly devicePublicKey: string;
    readonly proofKeyId: string;
    readonly proofKeyEpoch: number;
    readonly machineId?: string;
}
/**
 * The only pairing-code consumption operation. Implementations atomically
 * consume a valid code, apply machine supersession/state cleanup, and register
 * the device; failures leave the code retryable. Unknown, expired, and already
 * consumed codes all return `undefined`.
 */
export interface PairingEnrollment {
    redeemAndRegister(input: PairingEnrollmentInput): Promise<DeviceRecord | undefined>;
}
export interface NonceStore {
    issue(tenant: TenantId, deviceId: string): Promise<string>;
    /**
     * Atomically consume a nonce only when it belongs to this exact (tenant,
     * device), is unexpired, and has not already been consumed. Returns `true`
     * for the sole winner; every other case returns `false`.
     */
    consumeIfValid(tenant: TenantId, deviceId: string, nonce: string): Promise<boolean>;
}
export interface InboundDedupStore {
    /**
     * `true` when `envelopeId` was already seen for this (tenant, device);
     * otherwise records it and returns `false`. Bounded per device — the wire is
     * at-least-once (§9); this makes processing at-most-once without an
     * unbounded set.
     */
    checkAndRecord(tenant: TenantId, deviceId: string, envelopeId: string): Promise<boolean>;
}
export declare const TASK_ATTEMPT_STATUSES: readonly ['offered', 'claimed', 'running', 'cancel_requested', 'complete', 'failed', 'cancelled'];
export type TaskAttemptStatus = (typeof TASK_ATTEMPT_STATUSES)[number];
/** The durable first-message reservation and, once present, its terminal disposition. */
export interface AgentMessageAdmission {
    readonly messageId: string;
    readonly payloadBody: string;
    readonly terminalBody?: string;
}
export interface TaskAttempt {
    readonly tenantId: TenantId;
    readonly taskId: string;
    /** The device the offer was addressed to. */
    readonly deviceId: string;
    /** Exact Agent identity sealed when the strict Agent offer was opened. */
    readonly agentRef?: AgentRef;
    /** Set by `task.claim`, and only by the first one. Legacy attempts remain claimable by any tenant device until then; strict Agent attempts are target-device bound before this field is consulted. */
    readonly ownerDeviceId?: string;
    readonly status: TaskAttemptStatus;
    /**
     * The runtime the CLAIMING daemon reported for itself on its own
     * `task.claim` (`TaskClaimPayload.runtime`), snapshotted at the
     * `offered -> claimed` transition and never written again — a redelivered or
     * losing claim leaves it exactly as the winning claim left it.
     *
     * ADR-028 forbids cloud holding EXECUTION state (a live `running`/`thinking`
     * phase, a turn, a PID, the current tool call) — quantities that keep
     * changing while an attempt runs. This is not one: it is written once, at
     * the moment ownership is decided, and is an attribution fact about the
     * attempt. Byte-for-byte the same semantics as the reference server's
     * `TaskSnapshot.claimedRuntime` (`packages/server/src/types.ts`).
     *
     * Absent for a daemon whose `task.claim` carried no `runtime` at all.
     */
    readonly claimedRuntime?: RuntimeId;
    /**
     * The capability block the CLAIMING adapter reported for ITSELF on that same
     * `task.claim` (`TaskClaimPayload.capabilities`), snapshotted under exactly
     * the same write-once rule as {@link TaskAttempt.claimedRuntime}.
     *
     * This is the ONLY input to the steer gate (`steer-control.ts`,
     * `ByokCloud.steerTask`). The connection-level snapshot cloud keeps —
     * `DeviceRecord.capabilities`, written from `conn.hello`
     * (`inbound.ts`) — describes a device BUILD and never feeds it: a device can
     * reconnect later with a different adapter set, while a task that is already
     * running must keep being judged against what was true when it was claimed.
     * Same single-source rule the reference server pins
     * (`packages/server/src/__tests__/steer-runtime-capability-gate.test.ts`).
     *
     * Absent for a daemon that predates the field, which the gate reads as
     * "unknown" and refuses — unknown is not supported.
     */
    readonly claimedRuntimeCapabilities?: RuntimeCapabilities;
    /** Runtime-reported terminal cause from the first winning terminal. */
    readonly terminalCause?: string;
    /** Durable host cancellation authority. Its presence outranks later device terminal receipts. */
    readonly cancellation?: {
        readonly requestedAt: string;
        readonly reason?: string;
    };
    readonly updatedAt: string;
}
/**
 * One bounded page request over a tenant's task attempts.
 *
 * Keyset-paged by `taskId` ASCENDING, deliberately, and NOT chronologically: an
 * attempt carries no monotonic sequence, and `updatedAt` moves under an
 * in-flight page (a status transition would re-order rows mid-walk and let a
 * caller skip or repeat one). `taskId` is `task_<uuid>` — stable, unique per
 * tenant, and never rewritten — so it is the only column that gives a walk the
 * exactly-once property. The order is therefore arbitrary but TOTAL, which is
 * what a paged read model needs; a caller that wants recency sorts a page
 * itself.
 *
 * Adding a sequence column to get chronological order was rejected: it is a
 * migration across every composition to serve a read-model nicety, and a second
 * ordering authority to keep consistent with the row it decorates.
 */
export interface TaskAttemptListQuery {
    /** Maximum attempts in the page. Required and fail-closed: a non-positive or non-integer limit is rejected, never silently defaulted or clamped. */
    readonly limit: number;
    /**
     * The `nextCursor` from the previous page — opaque to the caller, and an
     * EXCLUSIVE lower bound on `taskId`. Absent starts at the beginning. A cursor
     * naming a task that has since been deleted still resolves: it is a bound,
     * not a lookup.
     */
    readonly cursor?: string;
}
export interface TaskAttemptPage {
    readonly attempts: readonly TaskAttempt[];
    /**
     * Pass as the next request's `cursor`. ABSENT means this page is the end of
     * the walk — not "start over" — so a caller stops on absence rather than on
     * an empty page, and a page that exactly fills `limit` with nothing after it
     * still terminates.
     */
    readonly nextCursor?: string;
}
export interface TaskAttemptStore {
    /** Called when an offer is enqueued: records the pending attempt with no owner yet. */
    open(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef?: AgentRef;
    }): Promise<TaskAttempt>;
    /**
     * Atomically reserve one strict Agent offer. `created: false` means the task
     * id already had durable authority and no caller may append another offer.
     */
    reserveAgentOffer(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef: AgentRef;
    }): Promise<{
        readonly attempt: TaskAttempt;
        readonly created: boolean;
    }>;
    /**
     * Atomically binds one message payload to a live task before an external
     * consumer can run. `pending` is an existing exact reservation whose terminal
     * receipt has not been recorded yet; callers must fail closed rather than
     * invoke the consumer again.
     */
    reserveAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<'reserved' | 'pending' | 'rejected'>;
    /** Read only an exact reservation; conflicting task/message bindings are not observable. */
    readAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<AgentMessageAdmission | undefined>;
    /** CAS the exact reservation to one immutable terminal disposition body. */
    finalizeAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
        readonly terminalBody: string;
    }): Promise<AgentMessageAdmission | undefined>;
    get(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined>;
    /** Batch lookup used by mailbox projection; implementations must not turn one poll into N queries. */
    getMany(tenant: TenantId, taskIds: readonly string[]): Promise<readonly TaskAttempt[]>;
    /**
     * One bounded page of this tenant's attempts, keyset-paged by `taskId` — see
     * {@link TaskAttemptListQuery} for why that key and not a timestamp.
     * Implementations must read one page in one query (`taskId > cursor ORDER BY
     * taskId LIMIT limit + 1`), never the whole tenant filtered in memory.
     */
    list(tenant: TenantId, query: TaskAttemptListQuery): Promise<TaskAttemptPage>;
    /**
     * First claim wins the ownership; a later claim by the same device is
     * idempotent. No-op (returns `undefined`) for a task this tenant never
     * offered.
     *
     * `runtime`/`capabilities` are the claiming daemon's self-report, written
     * ONLY by the claim that actually wins the ownership CAS — an idempotent
     * re-claim (and a losing one) must leave the recorded snapshot untouched,
     * including when it carries a different or absent value.
     */
    claim(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly runtime?: RuntimeId;
        readonly capabilities?: RuntimeCapabilities;
    }): Promise<TaskAttempt | undefined>;
    /** Record a lifecycle transition. No-op (returns `undefined`) for an unknown task — same shape as the reference server's per-type handlers. */
    recordStatus(tenant: TenantId, input: {
        readonly taskId: string;
        readonly status: TaskAttemptStatus;
        readonly agentRef?: AgentRef;
        readonly terminalCause?: string;
    }): Promise<TaskAttempt | undefined>;
}
export interface TaskCancellationRequest {
    readonly taskId: string;
    readonly proposedMessageId: string;
    readonly reason?: string;
    readonly materialize: (seq: number, messageId: string) => MailboxBody | Promise<MailboxBody>;
}
export interface TaskCancellationMutation {
    readonly attempt: TaskAttempt;
    /** Absent only when the task was already complete or failed before cancellation. */
    readonly message?: MailboxMessage;
}
/**
 * One atomic authority for the cancellation tombstone plus its durable device
 * delivery. Implementations must commit both or neither.
 */
export interface TaskCancellationStore {
    request(tenant: TenantId, input: TaskCancellationRequest): Promise<TaskCancellationMutation | undefined>;
}
export interface RequestReceipt {
    readonly tenantId: TenantId;
    readonly key: string;
    /** Opaque payload the caller recorded — for terminals, the encoded envelope. */
    readonly body: string;
    readonly recordedAt: string;
}
export interface RequestReceiptStore {
    /**
     * Record a receipt under `key`, or return the existing one untouched.
     * `created` is `false` for a replay — the FIRST terminal is the fact
     * (§12.6.4: 不覆写第一份事实), and a retry of the same terminal must not
     * overwrite it.
     */
    record(tenant: TenantId, input: {
        readonly key: string;
        readonly body: string;
    }): Promise<{
        readonly receipt: RequestReceipt;
        readonly created: boolean;
    }>;
    get(tenant: TenantId, key: string): Promise<RequestReceipt | undefined>;
}
export interface AgentEgressRecord {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly payload: AgentEgressReliablePayload;
    /** Stable cloud-generated receipt identity echoed on every exact replay. */
    readonly receiptId: string;
    readonly recordedAt: string;
}
export interface AgentEgressStore {
    /** First event-id write wins; callers reject mismatches rather than updating. */
    record(tenant: TenantId, input: Omit<AgentEgressRecord, 'tenantId' | 'recordedAt'>): Promise<{
        readonly record: AgentEgressRecord;
        readonly created: boolean;
    }>;
    get(tenant: TenantId, deviceId: string, eventId: string): Promise<AgentEgressRecord | undefined>;
}
export interface ProofRequestReceipt {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly requestId: string;
    readonly operation: string;
    readonly resource: string;
    readonly bodySha256: string;
    readonly bodySize: bigint;
    readonly responseStatus: number;
    readonly responseBody: string;
    readonly recordedAt: string;
}
export type ProofRequestReceiptInput = Omit<ProofRequestReceipt, 'tenantId' | 'recordedAt'>;
/**
 * First-result-wins replay store. The application layer compares every stored
 * binding before returning an exact replay; a reused request id with any
 * different binding is a conflict, never a second write.
 */
export interface ProofRequestReceiptStore {
    record(tenant: TenantId, input: ProofRequestReceiptInput): Promise<{
        readonly receipt: ProofRequestReceipt;
        readonly created: boolean;
    }>;
    get(tenant: TenantId, deviceId: string, requestId: string): Promise<ProofRequestReceipt | undefined>;
}
export interface BlobDeclaration {
    readonly size: number;
    readonly contentType: string;
    /** Canonical `sha256:<64 lowercase hex>` — the schema rejected anything else before this store sees it. */
    readonly contentHash: string;
}
/** What object-store metadata can actually observe at finalize (ADR-024). */
export interface BlobObservation {
    readonly observedByteSize: bigint;
    readonly observedContentType: string;
}
export type BlobWriteResult = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly reason: string;
};
export interface BlobContent {
    readonly data: Uint8Array;
    readonly contentType: string;
}
/**
 * How a byte-proxying read can fail while the blob itself is known to exist.
 *
 * The split is about WHERE the failure landed relative to the upstream
 * response, because that is the only part a proxy can observe and the only
 * part an operator can act on: `blob_upstream_unavailable` means nothing came
 * back at all (the upstream was unreachable/refused before its response
 * started), so a retry may succeed unchanged; `blob_upstream_stream_interrupted`
 * means the response HAD started and died mid-transfer, so whatever the caller
 * already has is a truncated prefix, not a short blob.
 *
 * Both are 502 on the wire (see `BLOB_READ_ERROR_HTTP_STATUS` in
 * `handlers/blobs.ts`) — the CODE carries the distinction, not the status.
 */
export declare const BLOB_READ_ERROR_CODES: readonly ['blob_upstream_unavailable', 'blob_upstream_stream_interrupted'];
export type BlobReadErrorCode = (typeof BLOB_READ_ERROR_CODES)[number];
/**
 * The result of {@link BlobContentProxy.readContent}, in the same union idiom
 * as {@link BlobWriteResult}. Note what is NOT in here: not-found stays
 * `undefined` at the method's return type, so "no such blob" keeps its
 * existing 404 meaning and never has to be spelled as a failure code.
 */
export type BlobReadResult = {
    readonly ok: true;
    readonly content: BlobContent;
} | {
    readonly ok: false;
    readonly code: BlobReadErrorCode;
};
/**
 * The capability-minting half of blobs: what EVERY composition can honestly
 * provide, whoever holds the bytes.
 *
 * Both methods are tenant-first, and both are reachable through {@link
 * TenantStores}. There is no pre-tenant method left on this port — see
 * {@link BlobContentProxy} for where the other three went and why.
 */
export interface CloudBlobStore {
    /** Mint only from an already-admitted object reservation. */
    createUpload(tenant: TenantId, reservation: StorageReservation): Promise<{
        readonly blobId: string;
        readonly uploadUrl: string;
    }>;
    /** Observe existence/size/type while proving this blob belongs to this reservation. */
    observeUpload(tenant: TenantId, blobId: string, reservation: StorageReservation): Promise<BlobObservation | undefined>;
    /** A presigned GET URL for a blob THIS tenant owns that has finished uploading; `undefined` otherwise — including for another tenant's blob. */
    getDownloadUrl(tenant: TenantId, blobId: string): Promise<string | undefined>;
}
/**
 * The byte-proxying half: an OPTIONAL composition input, not a port.
 *
 * These three serve the two `/byok/blobs/:id/content` routes, which exist
 * because the in-memory and self-hosted compositions have nowhere else to put
 * bytes — cloud has to carry them. A composition whose bytes live in object
 * storage (S3/R2) hands the device a presigned URL to the object store itself
 * and never sees a byte, so it cannot implement these at all.
 *
 * That is why this is a separate interface supplied at composition time rather
 * than a member of {@link CloudStores}: "this deployment cannot proxy bytes"
 * becomes a type-level fact (the proxy is simply absent) instead of three
 * methods that throw. The alternatives were both anti-patterns — a conformance
 * suite that skips three methods for one composition is a subset waiver, and
 * one that asserts a typed rejection proves nothing
 * (docs/researches/s4a-dataplane-design.md §6).
 *
 * All three are pre-tenant by construction: the `/content` routes are
 * presigned, not bearer-authed, so there is no principal in scope at all and
 * the HMAC signature over the blob id is the whole credential. They stay off
 * {@link TenantStores} for the same reason the two exceptions above do.
 *
 * A deployment supplying a proxy must also declare `blobs.contentproxy`
 * (ADR-010): the routes mount on proxy-presence AND declaration, never on
 * either alone.
 */
export interface BlobContentProxy {
    verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): Promise<boolean>;
    /** Authoritative declared size for a signed PUT; no byte buffering precedes this lookup. */
    expectedUploadBytes(blobId: string): Promise<bigint | undefined>;
    writeContent(blobId: string, data: Uint8Array): Promise<BlobWriteResult>;
    /** `undefined` = no such blob (404); a `{ok:false}` result = the blob exists but its bytes could not be proxied (502, distinguished by {@link BlobReadErrorCode}). */
    readContent(blobId: string): Promise<BlobReadResult | undefined>;
}
/**
 * Step 0 of the inbound gate. S3a ships an allow-all reference (a hosted
 * deployment's real limiter is edge/infra work, not handler work) — what
 * matters now is that the SEAM sits at gate position 0, before the type-allow
 * check, so a flood of garbage-typed envelopes costs the same budget as a
 * flood of well-formed ones once a real limiter is plugged in.
 */
export interface InboundRateLimiter {
    consume(tenant: TenantId, deviceId: string): Promise<boolean>;
}
/**
 * All-or-nothing: a composition supplies every port here or it is not a
 * composition. {@link BlobContentProxy} is deliberately absent — it is an
 * optional input to `createByokCloud`, not a port, precisely so that the
 * bundle can stay all-or-nothing while byte proxying stays optional.
 */
export interface CloudStores {
    readonly activity: ActivityStore;
    readonly approvals: ApprovalTimelineStore;
    readonly devices: DeviceDirectory;
    readonly pairingCodes: PairingCodeStore;
    readonly pairing: PairingEnrollment;
    readonly nonces: NonceStore;
    readonly dedup: InboundDedupStore;
    readonly tasks: TaskAttemptStore;
    readonly cancellations: TaskCancellationStore;
    readonly receipts: RequestReceiptStore;
    readonly egress: AgentEgressStore;
    readonly proofReceipts: ProofRequestReceiptStore;
    readonly blobs: CloudBlobStore;
    readonly rateLimiter: InboundRateLimiter;
}
/** Names of every port in {@link CloudStores}, in contract order. */
export declare const CLOUD_STORE_NAMES: readonly ['activity', 'approvals', 'devices', 'pairingCodes', 'pairing', 'nonces', 'dedup', 'tasks', 'cancellations', 'receipts', 'egress', 'proofReceipts', 'blobs', 'rateLimiter'];
export type CloudStoreName = (typeof CLOUD_STORE_NAMES)[number];
// ==== @byok-sdk/cloud dist/tenant-stores.d.ts ====
/**
 * Layer 2 of the six-layer isolation model (§12.6.2) — the tenant-closed
 * facade a handler actually receives.
 *
 * `@byok-sdk/core`'s `stores.ts` deliberately left this undefined: it is shaped by
 * how handlers are written, and the first handlers live here. This is that
 * shape, and the two properties it exists to enforce are:
 *
 * 1. **It can only be built from an authenticated principal.** {@link
 *    tenantStoresFor} is the only constructor, and its first parameter is a
 *    `Principal` — a value that only `authenticateBearer` (`auth/bearer.ts`)
 *    mints, and only from a device ROW. There is no path from a device-supplied
 *    string to a facade.
 * 2. **No handler ever passes a `TenantId` again.** Every method below has the
 *    tenant pre-applied, so a handler cannot read `principal.tenantId` off one
 *    principal and hand a different tenant to a store. Grep the handler tree
 *    for `TenantId` and you will not find one — asserted by
 *    `src/__tests__/constraints.test.ts`.
 *
 * The three pre-tenant store methods (`resolveByDeviceId`, `redeem`, the
 * presigned blob calls) are deliberately absent from this surface: a
 * device-facing handler must not be able to reach them.
 */
import { type BoardClaimInput, type BoardItem, type BoardItemInput, type BoardListQuery, type BoardPage, type BoardStatusUpdateInput, type BoardUnclaimInput, type CoreStores, type MailboxAdvanceCursorInput, type MailboxAppendInput, type MailboxCursorState, type MailboxMessage, type MailboxPage, type MailboxReadQuery, type MailboxRecordDeliveryInput, type Principal, type PresenceHint, type PresenceHintInput, type TenantReadiness, type StorageFinalizeInput, type StorageFinalizeResult, type StorageReservation, type StorageReservationInput, type TenantId } from '@byok-sdk/core';
import type { RuntimeCapabilities, RuntimeId } from '@byok-sdk/protocol';
import type { ActivityAppendInput, ActivityTail } from './activity';
import type { ApprovalTimelineAppendInput, ApprovalTimelineTail } from './approval-timeline';
import type { BlobObservation, CloudStores, DeviceRecord, AgentEgressRecord, RequestReceipt, TaskCancellationMutation, TaskCancellationRequest, TaskAttempt, TaskAttemptStatus } from './stores/ports';
export interface TenantBoundMailbox {
    append(input: MailboxAppendInput): Promise<MailboxMessage>;
    /** Pure read. Never advances the cursor — the daemon's next poll is the only ack. */
    readAfter(query: MailboxReadQuery): Promise<MailboxPage>;
    recordDelivery(input: MailboxRecordDeliveryInput): Promise<MailboxCursorState>;
    advanceCursor(input: MailboxAdvanceCursorInput): Promise<MailboxCursorState>;
    readCursor(deviceId: string): Promise<MailboxCursorState>;
}
export interface TenantBoundBoard {
    create(input: BoardItemInput): Promise<BoardItem>;
    get(itemId: string): Promise<BoardItem | undefined>;
    list(query: BoardListQuery): Promise<BoardPage>;
    claim(input: BoardClaimInput): Promise<BoardItem>;
    unclaim(input: BoardUnclaimInput): Promise<BoardItem>;
    updateStatus(input: BoardStatusUpdateInput): Promise<BoardItem>;
}
export interface TenantBoundPresence {
    publish(input: PresenceHintInput): Promise<PresenceHint>;
    read(deviceId: string): Promise<PresenceHint | undefined>;
    list(): Promise<readonly PresenceHint[]>;
}
export interface TenantBoundActivity {
    append(input: ActivityAppendInput): Promise<ActivityTail>;
    read(taskId: string): Promise<ActivityTail | undefined>;
}
export interface TenantBoundApprovalTimeline {
    append(input: ApprovalTimelineAppendInput): Promise<ApprovalTimelineTail>;
    read(taskId: string): Promise<ApprovalTimelineTail | undefined>;
}
export interface TenantBoundDevices {
    get(deviceId: string): Promise<DeviceRecord | undefined>;
    list(): Promise<readonly DeviceRecord[]>;
    revoke(deviceId: string): Promise<void>;
    /** Persist the authenticated device's own capability snapshot. */
    recordCapabilities(input: {
        readonly capabilities: readonly string[];
    }): Promise<DeviceRecord | undefined>;
    readiness(): Promise<TenantReadiness>;
}
export interface TenantBoundTaskAttempts {
    open(input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef?: TaskAttempt['agentRef'];
    }): Promise<TaskAttempt>;
    reserveAgentOffer(input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef: NonNullable<TaskAttempt['agentRef']>;
    }): Promise<{
        readonly attempt: TaskAttempt;
        readonly created: boolean;
    }>;
    reserveAgentMessage(input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<'reserved' | 'pending' | 'rejected'>;
    readAgentMessage(input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<import('./stores/ports').AgentMessageAdmission | undefined>;
    finalizeAgentMessage(input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
        readonly terminalBody: string;
    }): Promise<import('./stores/ports').AgentMessageAdmission | undefined>;
    get(taskId: string): Promise<TaskAttempt | undefined>;
    getMany(taskIds: readonly string[]): Promise<readonly TaskAttempt[]>;
    list(query: import('./stores/ports').TaskAttemptListQuery): Promise<import('./stores/ports').TaskAttemptPage>;
    claim(input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly runtime?: RuntimeId;
        readonly capabilities?: RuntimeCapabilities;
    }): Promise<TaskAttempt | undefined>;
    recordStatus(input: {
        readonly taskId: string;
        readonly status: TaskAttemptStatus;
        readonly agentRef?: TaskAttempt['agentRef'];
        readonly terminalCause?: TaskAttempt['terminalCause'];
    }): Promise<TaskAttempt | undefined>;
}
export interface TenantBoundTaskCancellations {
    request(input: TaskCancellationRequest): Promise<TaskCancellationMutation | undefined>;
}
export interface TenantBoundDedup {
    checkAndRecord(deviceId: string, envelopeId: string): Promise<boolean>;
}
export interface TenantBoundReceipts {
    record(input: {
        readonly key: string;
        readonly body: string;
    }): Promise<{
        readonly receipt: RequestReceipt;
        readonly created: boolean;
    }>;
    get(key: string): Promise<RequestReceipt | undefined>;
}
export interface TenantBoundAgentEgress {
    record(input: Omit<AgentEgressRecord, 'tenantId' | 'recordedAt'>): Promise<{
        readonly record: AgentEgressRecord;
        readonly created: boolean;
    }>;
    get(deviceId: string, eventId: string): Promise<AgentEgressRecord | undefined>;
}
export interface TenantBoundBlobs {
    createUpload(reservation: StorageReservation): Promise<{
        readonly blobId: string;
        readonly uploadUrl: string;
    }>;
    observeUpload(blobId: string, reservation: StorageReservation): Promise<BlobObservation | undefined>;
    getDownloadUrl(blobId: string): Promise<string | undefined>;
}
export interface TenantBoundQuota {
    readReservation(reservationId: string): Promise<StorageReservation | undefined>;
    reserve(input: StorageReservationInput): Promise<StorageReservation>;
    finalizeReservation(input: StorageFinalizeInput): Promise<StorageFinalizeResult>;
    abortReservation(reservationId: string): Promise<StorageReservation>;
}
export interface TenantBoundRateLimiter {
    consume(deviceId: string): Promise<boolean>;
}
export interface TenantStores {
    readonly tenant: TenantId;
    readonly principal: Principal;
    readonly mailbox: TenantBoundMailbox;
    readonly board: TenantBoundBoard;
    readonly presence: TenantBoundPresence;
    readonly activity: TenantBoundActivity;
    readonly approvals: TenantBoundApprovalTimeline;
    readonly devices: TenantBoundDevices;
    readonly tasks: TenantBoundTaskAttempts;
    readonly cancellations: TenantBoundTaskCancellations;
    readonly dedup: TenantBoundDedup;
    readonly receipts: TenantBoundReceipts;
    readonly egress: TenantBoundAgentEgress;
    readonly blobs: TenantBoundBlobs;
    readonly quota: TenantBoundQuota;
    readonly rateLimiter: TenantBoundRateLimiter;
}
/** Every naked store a composition supplies. Only {@link tenantStoresFor} reads this. */
export interface CloudRootStores {
    readonly core: CoreStores;
    readonly cloud: CloudStores;
}
export declare function tenantStoresFor(principal: Principal, root: CloudRootStores): TenantStores;
// ==== @byok-sdk/cloud dist/terminal-result.d.ts ====
import { type AgentRef, type BlobRef, type TerminalInferenceUsage } from '@byok-sdk/protocol';
import type { RequestReceipt } from './stores/ports';
/**
 * The typed terminal read model — the hosted counterpart of the embedded
 * coordinator's `TaskResult`, projected off the receipt the inbound gate
 * stores. Every field is copied verbatim from the payload the gate already
 * zod-parsed before storing (`recordTerminal`, `inbound.ts`); this projection
 * neither re-validates nor synthesizes one.
 */
export interface TerminalResult {
    readonly taskId: string;
    readonly state: 'complete' | 'failed' | 'cancelled';
    /** Exact Agent identity echoed by the winning terminal, when Agent-bound. */
    readonly agentRef?: AgentRef;
    readonly summary?: string;
    readonly sessionRef?: string;
    readonly artifactRefs?: readonly BlobRef[];
    /**
     * The product's structured terminal result, verbatim `task.complete.document`.
     * Absent — key missing, never null — when the daemon sent none, which covers
     * both a legacy pre-`result-document` build and a daemon with no
     * `resultDocument` extractor.
     */
    readonly document?: unknown;
    /**
     * Device/runtime terminal observation copied from the canonical winning
     * receipt. It is telemetry only — never cloud storage usage, billing, quota
     * or entitlement authority.
     */
    readonly usage?: TerminalInferenceUsage;
    readonly reason?: string;
    /** Terminal cause projection; currently the protocol's terminal reason. */
    readonly terminalCause?: string;
    readonly retryable?: boolean;
    /** When the receipt store wrote the terminal fact — the first one, by its own first-write-wins rule. */
    readonly recordedAt: string;
}
/**
 * Pure projection of a terminal receipt onto {@link TerminalResult}. `taskId`
 * names the task the receipt was read for (the receipt's key carries it, its
 * body does not); `recordedAt` is the receipt store's write time.
 *
 * Fail closed on anything but a terminal envelope: the stored body is
 * `encodeEnvelope` of what the inbound gate accepted, so an undecodable body
 * or a non-terminal type means the receipt-store contract itself broke — an
 * error, never a best-effort shape.
 */
export declare function projectTerminalResult(taskId: string, receipt: RequestReceipt): TerminalResult;
// ==== @byok-sdk/cloud dist/truth/contract.d.ts ====
import type { ContentHash, TenantId, TruthBodyRef, TruthManifestEntry, TruthManifestQuery, TruthRecord, TruthRecordKind, TruthRecordSelector } from '@byok-sdk/core';
import { z } from 'zod';
export declare const TRUTH_RECORD_CAPABILITY = "truth.records";
export declare const TRUTH_INLINE_CONTENT_TYPE = "application/vnd.byok.truth+utf8";
export declare const TRUTH_REQUEST_ID_MAX_LENGTH = 120;
export declare const TRUTH_RECORD_KEY_MAX_LENGTH = 200;
export declare const TRUTH_LABEL_MAX_LENGTH = 200;
export declare const TRUTH_BATCH_MAX_RECORDS = 32;
export declare const TRUTH_MANIFEST_MAX_LIMIT = 100;
export declare const TruthRecordKeySchema: z.ZodString;
export declare const TruthBodyInputSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"inline">;
    content: z.ZodString;
    contentHash: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"object">;
    contentHash: z.ZodString;
    byteSize: z.ZodNumber;
}, z.core.$strict>], "kind">;
export declare const TruthWriteRequestSchema: z.ZodObject<{
    expectedRev: z.ZodOptional<z.ZodNumber>;
    body: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"inline">;
        content: z.ZodString;
        contentHash: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"object">;
        contentHash: z.ZodString;
        byteSize: z.ZodNumber;
    }, z.core.$strict>], "kind">;
    label: z.ZodOptional<z.ZodString>;
    snapshots: z.ZodOptional<z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            memory: "memory";
            profile: "profile";
        }>;
        recordKey: z.ZodString;
        expectedRev: z.ZodNumber;
        body: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"inline">;
            content: z.ZodString;
            contentHash: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"object">;
            contentHash: z.ZodString;
            byteSize: z.ZodNumber;
        }, z.core.$strict>], "kind">;
        label: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type TruthBodyInput = z.infer<typeof TruthBodyInputSchema>;
export type TruthWriteRequest = z.infer<typeof TruthWriteRequestSchema>;
export type PreparedTruthWrite = {
    readonly kind: 'task.terminal';
    readonly recordKey: string;
    readonly contentHash: ContentHash;
    readonly byteSize: bigint;
    readonly body: TruthBodyRef;
    readonly label?: string;
} | {
    readonly kind: 'profile' | 'memory';
    readonly recordKey: string;
    readonly expectedRev: number;
    readonly contentHash: ContentHash;
    readonly byteSize: bigint;
    readonly body: TruthBodyRef;
    readonly label?: string;
};
export interface TruthCommitInput {
    readonly deviceId: string;
    readonly requestId: string;
    readonly operation: string;
    readonly resource: string;
    readonly proofBodySha256: string;
    readonly proofBodySize: bigint;
    readonly writes: readonly [PreparedTruthWrite, ...PreparedTruthWrite[]];
}
export interface TruthRecordMetadata {
    readonly kind: TruthRecordKind;
    readonly recordKey: string;
    readonly rev: number;
    readonly contentHash: string;
    readonly byteSize: number;
    readonly label?: string;
    readonly updatedAt: string;
}
export declare const TruthRecordMetadataSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        memory: "memory";
        profile: "profile";
        "task.terminal": "task.terminal";
    }>;
    recordKey: z.ZodString;
    rev: z.ZodNumber;
    contentHash: z.ZodString;
    byteSize: z.ZodNumber;
    label: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodString;
}, z.core.$strict>;
export interface TruthCommitResponse {
    readonly primary: TruthRecordMetadata;
    readonly snapshots: readonly TruthRecordMetadata[];
}
export declare const TruthCommitResponseSchema: z.ZodObject<{
    primary: z.ZodObject<{
        kind: z.ZodEnum<{
            memory: "memory";
            profile: "profile";
            "task.terminal": "task.terminal";
        }>;
        recordKey: z.ZodString;
        rev: z.ZodNumber;
        contentHash: z.ZodString;
        byteSize: z.ZodNumber;
        label: z.ZodOptional<z.ZodString>;
        updatedAt: z.ZodString;
    }, z.core.$strict>;
    snapshots: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            memory: "memory";
            profile: "profile";
            "task.terminal": "task.terminal";
        }>;
        recordKey: z.ZodString;
        rev: z.ZodNumber;
        contentHash: z.ZodString;
        byteSize: z.ZodNumber;
        label: z.ZodOptional<z.ZodString>;
        updatedAt: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export interface TruthCommitResult {
    readonly response: TruthCommitResponse;
    readonly replayed: boolean;
}
export interface TruthCommitter {
    commit(tenant: TenantId, input: TruthCommitInput): Promise<TruthCommitResult>;
    getRecord(tenant: TenantId, selector: TruthRecordSelector): Promise<TruthRecord | undefined>;
    listManifest(tenant: TenantId, query: TruthManifestQuery): Promise<readonly TruthManifestEntry[]>;
}
/**
 * Object download grant authority for truth bodies. The input is the canonical
 * content hash stored in `TruthBodyRef`, never an opaque upload id.
 */
export interface TruthObjectDownloads {
    getDownloadUrl(tenant: TenantId, hash: ContentHash): Promise<string | undefined>;
}
export declare function truthRecordMetadata(record: TruthRecord): TruthRecordMetadata;
export declare function truthManifestMetadata(entry: TruthManifestEntry): TruthRecordMetadata;
// ==== @byok-sdk/cloud dist/truth/errors.d.ts ====
export declare const TRUTH_COMMIT_ERROR_CODES: readonly ['proof_request_conflict', 'truth_object_not_committed'];
export type TruthCommitErrorCode = (typeof TRUTH_COMMIT_ERROR_CODES)[number];
export declare class TruthCommitError extends Error {
    readonly code: TruthCommitErrorCode;
    readonly current?: unknown;
    constructor(code: TruthCommitErrorCode, message: string, current?: unknown);
}
export declare function isTruthCommitError(value: unknown): value is TruthCommitError;
