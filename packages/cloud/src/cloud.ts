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
import {
  contentHash,
  parseCapabilityDeclaration,
  type BoardItem,
  type BoardItemInput,
  type BoardListQuery,
  type BoardPage,
  type CapabilityDeclaration,
  type Clock,
  type ControlPlanePrincipal,
  type CoreStores,
  type PresenceHint,
  type SkillPackStore,
  type TenantId,
  type TenantReadiness,
} from '@byok-sdk/core';
import type { ActivityTail } from './activity';
import type { ApprovalTimelineTail } from './approval-timeline';
import { StaleApprovalError, pendingApproval, type PendingApproval } from './approval-control';
import {
  BYOK_ACTIVITY_PATH,
  BYOK_AGENT_HOME_PROJECTION_COMPLETION_ROUTE,
  BYOK_AGENT_MEMORY_PROJECTIONS_PATH,
  BYOK_BLOB_CONTENT_ROUTE,
  BYOK_BLOB_FINALIZE_ROUTE,
  BYOK_BLOB_URL_ROUTE,
  BYOK_BLOBS_PATH,
  BYOK_BOARD_CLAIM_ROUTE,
  BYOK_BOARD_PATH,
  BYOK_BOARD_STATUS_ROUTE,
  BYOK_BOARD_STREAM_PATH,
  BYOK_BOARD_UNCLAIM_ROUTE,
  BYOK_CAPABILITIES_PATH,
  BYOK_CHALLENGE_PATH,
  BYOK_EVENTS_PATH,
  BYOK_MESSAGES_PATH,
  BYOK_PAIR_PATH,
  BYOK_PRESENCE_PATH,
  BYOK_RECORD_ROUTE,
  BYOK_RECORDS_PATH,
  BYOK_SKILL_PACK_FILE_ROUTE,
  BYOK_SKILL_PACKS_PATH,
  BYOK_TOKEN_PATH,
  AGENT_CONTENT_ARTIFACT_READ_CAPABILITY,
  AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY,
  AGENT_CONTENT_WORKSPACE_READ_CAPABILITY,
  AGENT_HOME_PROJECTION_CAPABILITY,
  AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
  AGENT_EGRESS_POLICY_CAPABILITY,
  AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
  AGENT_MESSAGE_EGRESS_CAPABILITY,
  STRICT_AGENT_ONLY_CAPABILITY,
  TERMINAL_PROJECTION_SELECTION_CAPABILITY,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  type Envelope,
  AgentContentReadPayloadSchema,
  AgentContentReceiptPayloadSchema,
  AgentHomeProjectionCompletionRequestSchema,
  AgentHomeProjectionPayloadSchema,
  AgentMemoryProjectionCommitRequestSchema,
  AgentEgressAckPayloadSchema,
  AgentMessageServerContextSchema,
  TaskOfferForAgentWithEgressPayloadSchema,
  TaskOfferForAgentWithEgressFreshPayloadSchema,
  TaskOfferForAgentPayloadSchema,
  type AgentRef,
  type AgentContentReceiptPayload,
  type AgentContentReadPayload,
  type AgentEgressAckPayload,
  type AgentEgressReliablePayload,
  type AgentMessageDispositionPayload,
  type AgentMessagePublishPayload,
  type AgentMessageServerContext,
  type AgentHomeProjectionCompletionRequest,
  type AgentHomeProjectionPayload,
  type AgentHomeProjectionReadback,
  type AgentMemoryProjectionCommitRequest,
  type AgentMemoryProjectionCommitResponse,
  type AgentMemoryProjectionEraseResult,
  type TaskOfferPayload,
  type TaskSteerPayload,
  type TaskOfferForAgentPayload,
  type TaskOfferForAgentWithEgressPayload,
  type TaskOfferForAgentWithEgressFreshPayload,
  type TaskOfferWithToolsetsPayload,
} from '@byok-sdk/protocol';
import { SteerRejectedError } from './steer-control';
import { createAuthPlane, type AuthPlane } from './auth/plane';
import type { TokenSigner } from './auth/tokens';
import { CLOUD_CAPABILITIES, declares } from './capabilities';
import {
  assertBoardLabels,
  DEFAULT_ACTIVITY_CAPACITY,
  DEFAULT_ACTIVITY_MAX_BYTES,
  DEFAULT_ACTIVITY_MAX_EVENTS,
  DEFAULT_ACTIVITY_TTL_MS,
  DEFAULT_BOARD_CHANNEL_MAX_BYTES,
  DEFAULT_BOARD_TITLE_MAX_BYTES,
  DEFAULT_PRESENCE_DETAIL_MAX_BYTES,
  DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS,
  DEFAULT_PRESENCE_TTL_MS,
  type ActivityBounds,
} from './coordination';
import type { CloudCrypto } from './crypto/port';
import { ByokCloudError } from './errors';
import {
  blobDownloadContentHandler,
  blobDownloadUrlHandler,
  blobUploadContentHandler,
  createBlobHandler,
  finalizeBlobHandler,
} from './handlers/blobs';
import { capabilitiesHandler } from './handlers/capabilities';
import { challengeHandler, pairHandler, tokenHandler } from './handlers/auth';
import { eventsHandler } from './handlers/events';
import { messagesHandler } from './handlers/messages';
import { agentHomeProjectionCompletionHandler } from './handlers/agent-home-projections';
import { agentMemoryProjectionHandler } from './handlers/agent-memory-projections';
import {
  boardClaimHandler,
  boardListHandler,
  boardStatusHandler,
  boardStreamHandler,
  boardUnclaimHandler,
  DEFAULT_BOARD_PAGE_LIMIT,
  DEFAULT_BOARD_STREAM_HEARTBEAT_INTERVAL_MS,
  DEFAULT_BOARD_STREAM_QUERY_INTERVAL_MS,
  DEFAULT_BOARD_STREAM_RECONCILIATION_INTERVAL_MS,
} from './handlers/board';
import { activityAppendHandler, presencePublishHandler } from './handlers/presence';
import {
  DEFAULT_SKILL_PACK_PAGE_LIMIT,
  skillPackFileHandler,
  skillPackListHandler,
} from './handlers/skill-packs';
import {
  DEFAULT_MAX_TRUTH_REQUEST_BYTES,
  truthGetHandler,
  truthManifestHandler,
  truthPutHandler,
} from './handlers/truth';
import { CloudRouteRegistry, type RouteDescriptor } from './router/registry';
import { terminalReceiptKey, type ByokCloudObserver } from './inbound';
import {
  agentHomeProjectionRequestKey,
  readAgentHomeProjectionStatus,
  recordAgentHomeProjectionCompletion,
  sameAgentHomeProjectionRequest,
  type AgentHomeProjectionReceiptInput,
} from './agent-home-projections';
import { agentReliabilityKey } from './agent-reliability';
import type {
  AgentMemoryProjectionAuthorizer,
  AgentMemoryProjectionStore,
} from './agent-memory-projection';
import type {
  BlobContentProxy,
  CloudStores,
  DeviceRecord,
  AgentEgressRecord,
  PairingCodeInfo,
  RequestReceipt,
  TaskAttempt,
  TaskAttemptListQuery,
  TaskAttemptPage,
  TaskAttemptStatus,
} from './stores/ports';
import { projectTerminalResult, type TerminalResult } from './terminal-result';
import { tenantStoresFor, type CloudRootStores, type TenantStores } from './tenant-stores';
import type { TruthCommitter, TruthObjectDownloads } from './truth/contract';

/** Matches the reference server's ceiling (§7). */
export const DEFAULT_MAX_BLOB_SIZE_BYTES = 100 * 1024 * 1024;
/** Matches the reference server's hold (§8). */
export const DEFAULT_LONG_POLL_HOLD_MS = 50_000;
/** How often a held poll re-reads the mailbox. */
export const DEFAULT_LONG_POLL_INTERVAL_MS = 250;
/** Rows per `GET /byok/events` response. */
export const DEFAULT_EVENTS_PAGE_LIMIT = 50;
/** Device capability required by the strict Agent offer path. */
export const AGENT_HOME_CONTRACT_CAPABILITY = 'agent-home-contract';

/**
 * Attempt statuses past which there is nothing left to approve or refuse. A
 * predicate rather than a `Set`: `constraints.test.ts` keeps every in-process
 * collection inside a store class, and this needs none.
 */
function isTerminalAttemptStatus(status: TaskAttemptStatus): boolean {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}

function sameAgentRef(expected: AgentRef, actual: AgentRef | undefined): boolean {
  return actual?.agentId === expected.agentId && actual.profileRevision === expected.profileRevision;
}

/**
 * The wire requires UUID-shaped envelope ids, while retries need a stable
 * identity.  Reserve UUIDv8 for this opaque sha256-derived namespace rather
 * than pretending a fresh random UUID can identify the same logical action.
 */
function uuidFromSha256(value: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(value);
  if (match === null) throw new Error('CloudCrypto.sha256 must return canonical sha256 hex');
  const digest = match[1];
  if (digest === undefined) throw new Error('CloudCrypto.sha256 must return canonical sha256 hex');
  const hex = digest.slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) & 0x03]!;
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function sameOfferEnvelope(expected: Envelope, actual: Envelope): boolean {
  // `ts` is deliberately excluded: it records when this particular producer
  // invocation ran, not the task body that a stable message identity names.
  return (
    expected.id === actual.id &&
    expected.type === actual.type &&
    expected.task_id === actual.task_id &&
    JSON.stringify(expected.payload) === JSON.stringify(actual.payload)
  );
}

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
    }): Promise<{ readonly outcome: 'accepted' | 'held' | 'refused'; readonly reasonCode?: string }>;
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
  readonly mountedRoutes: readonly { readonly method: string; readonly path: string }[];
  readonly capabilities: CapabilityDeclaration;
  /** Host control plane: mint a single-use pairing code for a tenant/product. */
  createPairingCode(tenant: TenantId, input: { readonly productId: string; readonly ttlMs?: number }): Promise<PairingCodeInfo>;
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
  enqueueAgentEgressOffer(
    tenant: TenantId,
    deviceId: string,
    input: AgentEgressDispatchInput,
  ): Promise<EnqueuedOffer>;
  /**
   * Host control plane: enqueue the distinct fresh-session egress offer.
   * The device must durably advertise fresh-session support before task or
   * mailbox reservation, so older resume-only daemons never receive it.
   */
  enqueueFreshAgentEgressOffer(
    tenant: TenantId,
    deviceId: string,
    input: AgentEgressFreshSessionDispatchInput,
  ): Promise<EnqueuedOffer>;
  /** Host control plane: request one policy-bound content read without a task fallback. */
  enqueueAgentContentRead(
    tenant: TenantId,
    deviceId: string,
    input: AgentContentReadInput,
  ): Promise<EnqueuedAgentControl>;
  /** Durable, task-free projection request for precisely one admitted device. */
  enqueueAgentHomeProjection(
    tenant: TenantId,
    deviceId: string,
    input: AgentHomeProjectionInput,
  ): Promise<EnqueuedAgentHomeProjection>;
  /** Tenant/device/request-bound durable desired-state and terminal-outcome readback. */
  getAgentHomeProjectionStatus(
    tenant: TenantId,
    deviceId: string,
    input: AgentHomeProjectionStatusInput,
  ): Promise<AgentHomeProjectionReadback | undefined>;
  /** Direct device completion endpoint authority; first exact terminal receipt wins. */
  completeAgentHomeProjection(
    tenant: TenantId,
    deviceId: string,
    receipt: AgentHomeProjectionCompletionRequest,
  ): Promise<AgentHomeProjectionReadback>;
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
  approveTask(
    tenant: TenantId,
    taskId: string,
    opts?: ApproveTaskOptions,
  ): Promise<EnqueuedAgentControl>;
  /**
   * Host control plane: refuse the approval a paused task is waiting on, by
   * enqueueing `task.reject` to the device that claimed it. Same gates, same
   * targeting, and the same best-effort delivery contract as
   * {@link ByokCloud.approveTask} — `opts.reason` is carried to the runtime
   * verbatim and is never synthesized when absent.
   */
  rejectTask(
    tenant: TenantId,
    taskId: string,
    opts?: RejectTaskOptions,
  ): Promise<EnqueuedAgentControl>;
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
  steerTask(
    tenant: TenantId,
    taskId: string,
    payload: TaskSteerPayload,
  ): Promise<EnqueuedAgentControl>;
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
  /** Exact durable egress fact and receipt selected by (tenant, device, AgentRef, event id). */
  readAgentEgress(
    tenant: TenantId,
    deviceId: string,
    agentRef: AgentRef,
    eventId: string,
  ): Promise<AgentEgressRecord | undefined>;
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
  readApprovalTimeline(
    tenant: TenantId,
    taskId: string,
  ): Promise<ApprovalTimelineTail | undefined>;
}

export function createByokCloud(options: ByokCloudOptions): ByokCloud {
  const declaration = parseDeclaration(options.capabilities);
  assertNoOverDeclaration(
    declaration,
    options.blobContentProxy,
    options.truthCommitter,
    options.truthObjectDownloads,
    options.skillPacks,
    options.agentMemoryProjectionAuthorizer,
    options.agentMemoryProjectionStore,
  );
  const root: CloudRootStores = { core: options.core, cloud: options.cloud };
  const auth: AuthPlane = createAuthPlane({
    stores: options.cloud,
    crypto: options.crypto,
    clock: options.clock,
    tokenSigner: options.tokenSigner,
    ...(options.accessTokenTtlSeconds !== undefined
      ? { accessTokenTtlSeconds: options.accessTokenTtlSeconds }
      : {}),
  });

  const deviceRouteDeps = {
    root,
    bearer: {
      tokenSigner: options.tokenSigner,
      devices: options.cloud.devices,
      ...(options.instanceProductId === undefined
        ? {}
        : { instanceProductId: options.instanceProductId }),
    },
  };

  const registry = new CloudRouteRegistry();
  const activityBounds: ActivityBounds = {
    maxEvents: options.activityMaxEvents ?? DEFAULT_ACTIVITY_MAX_EVENTS,
    maxBytes: options.activityMaxBytes ?? DEFAULT_ACTIVITY_MAX_BYTES,
    capacity: options.activityCapacity ?? DEFAULT_ACTIVITY_CAPACITY,
    ttlMs: options.activityTtlMs ?? DEFAULT_ACTIVITY_TTL_MS,
  };

  // Auth v2 (§6) — always mounted: without pairing there is no deployment.
  registry.register({ method: 'POST', path: BYOK_PAIR_PATH, class: 'public' }, pairHandler({ auth }));
  registry.register({ method: 'POST', path: BYOK_CHALLENGE_PATH, class: 'public' }, challengeHandler({ auth }));
  registry.register({ method: 'POST', path: BYOK_TOKEN_PATH, class: 'public' }, tokenHandler({ auth }));

  // ADR-010 — the declaration itself is always readable; a client that cannot
  // read it has no way to learn anything else without probing status codes.
  registry.register(
    { method: 'GET', path: BYOK_CAPABILITIES_PATH, class: 'public' },
    capabilitiesHandler({ declaration }),
  );

  if (declares(declaration, CLOUD_CAPABILITIES.agentMemoryProjection)) {
    registry.register(
      { method: 'POST', path: BYOK_AGENT_MEMORY_PROJECTIONS_PATH, class: 'device' },
      agentMemoryProjectionHandler({
        ...deviceRouteDeps,
        commit: (stores, deviceId, mutation, redactedBytes) =>
          commitAgentMemoryProjectionFromStores(stores, deviceId, mutation, redactedBytes),
      }),
    );
  }

  if (declares(declaration, CLOUD_CAPABILITIES.eventsLongPoll)) {
    registry.register(
      { method: 'GET', path: BYOK_EVENTS_PATH, class: 'device' },
      eventsHandler({
        ...deviceRouteDeps,
        longPollHoldMs: options.longPollHoldMs ?? DEFAULT_LONG_POLL_HOLD_MS,
        longPollIntervalMs: options.longPollIntervalMs ?? DEFAULT_LONG_POLL_INTERVAL_MS,
        pageLimit: options.eventsPageLimit ?? DEFAULT_EVENTS_PAGE_LIMIT,
      }),
    );
  }

  if (declares(declaration, CLOUD_CAPABILITIES.messagesBatch)) {
    registry.register(
      { method: 'POST', path: BYOK_MESSAGES_PATH, class: 'device' },
      messagesHandler({
        ...deviceRouteDeps,
        activityBounds,
        appendReliableEgressAck: enqueueReliableEgressAck,
        appendContentReceiptAck: enqueueContentReceiptAck,
        agentMessage: options.agentMessage,
        appendAgentMessageDisposition: enqueueAgentMessageDisposition,
        observer: options.observer,
      }),
    );
  }

  registry.register(
    { method: 'PUT', path: BYOK_AGENT_HOME_PROJECTION_COMPLETION_ROUTE, class: 'device' },
    agentHomeProjectionCompletionHandler({
      ...deviceRouteDeps,
      complete: (stores, deviceId, receipt) => completeAgentHomeProjectionFromStores(stores, deviceId, receipt),
    }),
  );

  if (declares(declaration, CLOUD_CAPABILITIES.boardCoordination)) {
    const boardDeps = {
      ...deviceRouteDeps,
      pageLimit: options.boardPageLimit ?? DEFAULT_BOARD_PAGE_LIMIT,
    };
    registry.register({ method: 'GET', path: BYOK_BOARD_PATH, class: 'device' }, boardListHandler(boardDeps));
    registry.register(
      { method: 'POST', path: BYOK_BOARD_CLAIM_ROUTE, class: 'device' },
      boardClaimHandler(deviceRouteDeps),
    );
    registry.register(
      { method: 'POST', path: BYOK_BOARD_UNCLAIM_ROUTE, class: 'device' },
      boardUnclaimHandler(deviceRouteDeps),
    );
    registry.register(
      { method: 'POST', path: BYOK_BOARD_STATUS_ROUTE, class: 'device' },
      boardStatusHandler(deviceRouteDeps),
    );
  }

  if (declares(declaration, CLOUD_CAPABILITIES.boardSse)) {
    registry.register(
      { method: 'GET', path: BYOK_BOARD_STREAM_PATH, class: 'device' },
      boardStreamHandler({
        ...deviceRouteDeps,
        pageLimit: options.boardPageLimit ?? DEFAULT_BOARD_PAGE_LIMIT,
        queryIntervalMs: options.boardStreamQueryIntervalMs ?? DEFAULT_BOARD_STREAM_QUERY_INTERVAL_MS,
        heartbeatIntervalMs:
          options.boardStreamHeartbeatIntervalMs ?? DEFAULT_BOARD_STREAM_HEARTBEAT_INTERVAL_MS,
        reconciliationIntervalMs:
          options.boardStreamReconciliationIntervalMs ??
          DEFAULT_BOARD_STREAM_RECONCILIATION_INTERVAL_MS,
      }),
    );
  }

  if (declares(declaration, CLOUD_CAPABILITIES.presenceHints)) {
    registry.register(
      { method: 'PUT', path: BYOK_PRESENCE_PATH, class: 'device' },
      presencePublishHandler({
        ...deviceRouteDeps,
        ttlMs: options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS,
        minimumIntervalMs:
          options.presenceMinimumIntervalMs ?? DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS,
        detailMaxBytes: options.presenceDetailMaxBytes ?? DEFAULT_PRESENCE_DETAIL_MAX_BYTES,
      }),
    );
  }

  if (declares(declaration, CLOUD_CAPABILITIES.activityTail)) {
    registry.register(
      { method: 'POST', path: BYOK_ACTIVITY_PATH, class: 'device' },
      activityAppendHandler({ ...deviceRouteDeps, bounds: activityBounds }),
    );
  }

  const truthCommitter = options.truthCommitter;
  const truthObjectDownloads = options.truthObjectDownloads;
  if (
    truthCommitter !== undefined &&
    truthObjectDownloads !== undefined &&
    declares(declaration, CLOUD_CAPABILITIES.truthRecords)
  ) {
    const truthDeps = {
      proof: {
        devices: options.cloud.devices,
        crypto: options.crypto,
        clock: options.clock,
      },
      truth: truthCommitter,
      objectDownloads: truthObjectDownloads,
      maxRequestBytes: options.maxTruthRequestBytes ?? DEFAULT_MAX_TRUTH_REQUEST_BYTES,
    };
    registry.register(
      { method: 'GET', path: BYOK_RECORDS_PATH, class: 'proof' },
      truthManifestHandler(truthDeps),
    );
    registry.register(
      { method: 'GET', path: BYOK_RECORD_ROUTE, class: 'proof' },
      truthGetHandler(truthDeps),
    );
    registry.register(
      { method: 'PUT', path: BYOK_RECORD_ROUTE, class: 'proof' },
      truthPutHandler(truthDeps),
    );
  }

  // Skill packs: both conditions, same asymmetry as the byte proxy below.
  // Declared-without-a-store is fatal (above); supplied-without-a-declaration
  // is a silent no-mount, which is how a deployment rolls the channel out or
  // back without ever telling a client something false.
  const skillPacks = options.skillPacks;
  if (skillPacks !== undefined && declares(declaration, CLOUD_CAPABILITIES.skillPacks)) {
    const skillPackDeps = {
      bearer: deviceRouteDeps.bearer,
      skillPacks,
      pageLimit: options.skillPackPageLimit ?? DEFAULT_SKILL_PACK_PAGE_LIMIT,
    };
    registry.register(
      { method: 'GET', path: BYOK_SKILL_PACKS_PATH, class: 'device' },
      skillPackListHandler(skillPackDeps),
    );
    registry.register(
      { method: 'GET', path: BYOK_SKILL_PACK_FILE_ROUTE, class: 'device' },
      skillPackFileHandler(skillPackDeps),
    );
  }

  if (declares(declaration, CLOUD_CAPABILITIES.blobsPresigned)) {
    const blobDeps = {
      ...deviceRouteDeps,
      maxBlobSizeBytes: options.maxBlobSizeBytes ?? DEFAULT_MAX_BLOB_SIZE_BYTES,
    };
    registry.register({ method: 'POST', path: BYOK_BLOBS_PATH, class: 'device' }, createBlobHandler(blobDeps));
    registry.register({ method: 'POST', path: BYOK_BLOB_FINALIZE_ROUTE, class: 'device' }, finalizeBlobHandler(blobDeps));
    registry.register({ method: 'GET', path: BYOK_BLOB_URL_ROUTE, class: 'device' }, blobDownloadUrlHandler(blobDeps));
  }

  // Byte proxying: BOTH conditions, and neither is inferred from the other.
  // There is no third state: a composition either carries bytes or it does not.
  //
  // The two halves fail differently, and the asymmetry is the point.
  //
  // DECLARED WITHOUT A PROXY is fatal, above. A declaration is the ONE thing a
  // client is entitled to trust without probing (ADR-010), so a deployment
  // publishing `blobs.contentproxy` it cannot serve does not degrade to "two
  // missing routes" — it tells every client something false and then answers
  // 404 to the client that believed it. Not mounting the routes is what an
  // honest composition does with a capability it lacks; the dishonesty is in
  // still announcing it, and the announcement is unconditional.
  //
  // SUPPLIED WITHOUT A DECLARATION is not fatal, and stays a silent no-mount.
  // The deployment's declaration is then merely narrower than its parts, which
  // is how a capability gets rolled out or rolled back: a host with a proxy
  // wired up but the capability withheld serves exactly what it declares. The
  // client is told less than the truth, never more, and no route exists that a
  // client could only discover by probing.
  const contentProxy = options.blobContentProxy;
  if (contentProxy !== undefined && declares(declaration, CLOUD_CAPABILITIES.blobsContentProxy)) {
    const contentDeps = {
      contentProxy,
      maxUploadBytes: options.maxBlobSizeBytes ?? DEFAULT_MAX_BLOB_SIZE_BYTES,
    };
    registry.register(
      { method: 'PUT', path: BYOK_BLOB_CONTENT_ROUTE, class: 'presigned' },
      blobUploadContentHandler(contentDeps),
    );
    registry.register(
      { method: 'GET', path: BYOK_BLOB_CONTENT_ROUTE, class: 'presigned' },
      blobDownloadContentHandler(contentDeps),
    );
  }

  // Task approval is deliberately absent, exactly as it is on the reference
  // server: every route above is authenticated by a DEVICE's own credential,
  // and a device-bearer-authed approval route would let any validly paired
  // device approve any task in its tenant. Approval is an operator action and
  // belongs to the host's own control-plane surface.

  const operatorId = options.operatorId ?? 'host';

  function controlPlane(tenant: TenantId): ControlPlanePrincipal {
    return { kind: 'control-plane', tenantId: tenant, operatorId };
  }

  async function enqueueTaskEnvelope(
    tenant: TenantId,
    deviceId: string,
    requestedTaskId: string | undefined,
    agentRef: AgentRef | undefined,
    buildEnvelope: (taskId: string, seq: number, messageId: string) => Envelope,
    beforeMailbox?: (stores: TenantStores, taskId: string) => Promise<void>,
  ): Promise<EnqueuedOffer> {
    const stores = tenantStoresFor(controlPlane(tenant), root);
    const taskId = requestedTaskId ?? `task_${options.crypto.randomUuid()}`;
    const messageId = uuidFromSha256(
      await options.crypto.sha256(
        new TextEncoder().encode(
          JSON.stringify({ domain: 'byok:task-offer', tenant, taskId, deviceId, agentRef }),
        ),
      ),
    );
    // An attempt is the task authority, so reserve/open it BEFORE the offer is
    // observable in a mailbox.  The stable message identity then makes an
    // append failure retry converge on the one offer rather than allocating a
    // second executable body.
    const reservation =
      agentRef === undefined
        ? undefined
        : await stores.tasks.reserveAgentOffer({ taskId, deviceId, agentRef });
    const openedBeforeAppend =
      reservation?.attempt ??
      (agentRef === undefined ? await stores.tasks.open({ taskId, deviceId }) : undefined);
    if (
      openedBeforeAppend === undefined ||
      openedBeforeAppend.deviceId !== deviceId ||
      (agentRef === undefined
        ? openedBeforeAppend.agentRef !== undefined
        : openedBeforeAppend.agentRef === undefined || !sameAgentRef(agentRef, openedBeforeAppend.agentRef))
    ) {
      throw new ByokCloudError(
        agentRef === undefined ? 'coordination_input_invalid' : 'agent_ref_mismatch',
        `Task ${taskId} already has a different durable target or Agent identity.`,
      );
    }

    const offerReceiptKey = `task-offer:${messageId}`;
    const deliveryReceiptKey = `task-offer-delivered:${messageId}`;
    // Existing strict dispatch keeps its observable one-winner behavior once
    // an offer is delivered. A missing delivery marker is the sole retryable
    // state: it is how an append failure can be retried without treating a
    // completed Agent placement as a second dispatch.
    if (
      agentRef !== undefined &&
      reservation?.created === false &&
      (await stores.receipts.get(deliveryReceiptKey)) !== undefined
    ) {
      throw new ByokCloudError(
        'agent_task_already_exists',
        `Task ${taskId} already has a durable Agent attempt and cannot be enqueued again.`,
      );
    }

    // Reserve the immutable executable semantics before a fallible mailbox
    // append. The attempt intentionally contains no payload; this existing
    // idempotent receipt authority supplies the missing comparison so a retry
    // after append failure cannot silently replace an undelivered body.
    const proposed = buildEnvelope(taskId, 0, messageId);
    const proposedBody = JSON.stringify({
      deviceId,
      type: proposed.type,
      payload: proposed.payload,
    });
    const recorded = await stores.receipts.record({
      key: offerReceiptKey,
      body: proposedBody,
    });
    if (!recorded.created && recorded.receipt.body !== proposedBody) {
      throw new ByokCloudError(
        'coordination_input_invalid',
        `Task ${taskId} already has a different executable offer body.`,
      );
    }

    await beforeMailbox?.(stores, taskId);
    const message = await stores.mailbox.append({
      deviceId,
      messageId,
      materialize: async (seq) => {
        // Core stays protocol-free: the mailbox reserves the one authoritative
        // delivery number, then asks this producer to build opaque bytes while
        // allocation and insertion are still serialized per device.
        const envelope = buildEnvelope(taskId, seq, messageId);
        const body = encodeEnvelope(envelope);
        const bytes = new TextEncoder().encode(body);
        return {
          body,
          bodyHash: contentHash(await options.crypto.sha256(bytes)),
          byteSize: BigInt(bytes.length),
        };
      },
    });
    const envelope = decodeEnvelope(message.body);
    if (envelope.seq !== message.seq) {
      throw new ByokCloudError(
        'mailbox_seq_mismatch',
        `Mailbox stored offer seq ${String(envelope.seq)} at row ${message.seq}; the daemon's redelivery cursor would be wrong.`,
      );
    }
    if (!sameOfferEnvelope(buildEnvelope(taskId, message.seq, messageId), envelope)) {
      throw new ByokCloudError(
        'coordination_input_invalid',
        `Task ${taskId} already has a different executable offer body.`,
      );
    }
    if (agentRef !== undefined) {
      const delivered = await stores.receipts.record({ key: deliveryReceiptKey, body: messageId });
      if (reservation?.created === false && !delivered.created) {
        throw new ByokCloudError(
          'agent_task_already_exists',
          `Task ${taskId} already has a durable Agent attempt and cannot be enqueued again.`,
        );
      }
    }
    return { taskId, seq: message.seq, envelope, attempt: openedBeforeAppend };
  }

  async function assertAgentCapabilities(
    tenant: TenantId,
    deviceId: string,
    required: readonly string[],
  ): Promise<void> {
    // This is deliberately a durable device-row read. Core presence is
    // lossy/TTL-bounded and is never consulted for an execution admission.
    const device = await options.cloud.devices.get(tenant, deviceId);
    if (
      device === undefined ||
      device.revoked ||
      !device.capabilities ||
      !required.every((capability) => device.capabilities!.includes(capability))
    ) {
      const missing = required.filter((capability) => !device?.capabilities?.includes(capability));
      throw new ByokCloudError(
        'agent_capability_missing',
        `Device ${deviceId} lacks durable Agent capabilities (${missing.join(', ')}); refusing before mailbox append.`,
      );
    }
  }

  /**
   * Producer-side scheduling defence for explicit legacy delivery. The daemon
   * remains the final authority for stale connections and already-queued
   * offers, but this durable read avoids creating a task/mailbox fact that a
   * strict device is guaranteed to decline.
   */
  async function assertLegacyAdmission(tenant: TenantId, deviceId: string): Promise<void> {
    const device = await options.cloud.devices.get(tenant, deviceId);
    if (device?.capabilities?.includes(STRICT_AGENT_ONLY_CAPABILITY) === true) {
      throw new ByokCloudError(
        'agent_capability_missing',
        `Device ${deviceId} advertises strict-agent-only; refusing legacy offer before mailbox append.`,
      );
    }
  }

  function contentReadCapability(surface: AgentContentReadPayload['surface']): string {
    switch (surface) {
      case 'workspace':
        return AGENT_CONTENT_WORKSPACE_READ_CAPABILITY;
      case 'transcript':
        return AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY;
      case 'artifact':
        return AGENT_CONTENT_ARTIFACT_READ_CAPABILITY;
    }
  }

  async function enqueueAgentControlEnvelope(
    tenant: TenantId,
    deviceId: string,
    messageId: string,
    buildEnvelope: (seq: number) => Envelope,
  ): Promise<EnqueuedAgentControl> {
    const stores = tenantStoresFor(controlPlane(tenant), root);
    const message = await stores.mailbox.append({
      deviceId,
      messageId,
      materialize: async (seq) => {
        const body = encodeEnvelope(buildEnvelope(seq));
        const bytes = new TextEncoder().encode(body);
        return {
          body,
          bodyHash: contentHash(await options.crypto.sha256(bytes)),
          byteSize: BigInt(bytes.length),
        };
      },
    });
    const envelope = decodeEnvelope(message.body);
    if (envelope.seq !== message.seq) {
      throw new ByokCloudError(
        'mailbox_seq_mismatch',
        `Mailbox stored Agent control seq ${String(envelope.seq)} at row ${message.seq}.`,
      );
    }
    return { seq: message.seq, envelope };
  }

  async function agentControlEnvelopeId(
    domain: string,
    tenant: TenantId,
    deviceId: string,
    agentRef: AgentRef,
    logicalRequestId: string,
  ): Promise<string> {
    return uuidFromSha256(
      await options.crypto.sha256(
        new TextEncoder().encode(
          JSON.stringify({ domain, tenant, deviceId, agentRef, logicalRequestId }),
        ),
      ),
    );
  }

  async function approvalDecisionSource(
    tenant: TenantId,
    taskId: string,
    attempt: TaskAttempt,
    pending: PendingApproval,
    decision: 'approve' | 'reject',
  ): Promise<string> {
    const agent = attempt.agentRef;
    return uuidFromSha256(
      await options.crypto.sha256(
        new TextEncoder().encode(
          JSON.stringify({
            domain: 'byok:approval-decision',
            tenant,
            taskId,
            deviceId: attempt.deviceId,
            ownerDeviceId: attempt.ownerDeviceId,
            agentRef: agent,
            requestSourceEnvelopeId: pending.sourceEnvelopeId,
            requestRevision: pending.revision,
            decision,
          }),
        ),
      ),
    );
  }

  function latestApprovalRequest(tail: ApprovalTimelineTail | undefined): PendingApproval | undefined {
    if (tail === undefined) return undefined;
    for (let index = tail.entries.length - 1; index >= 0; index -= 1) {
      const entry = tail.entries[index]!;
      if (entry.event.type !== 'approval_requested') continue;
      return {
        sourceEnvelopeId: entry.sourceEnvelopeId,
        revision: entry.revision,
        ...(entry.event.approvalId === undefined ? {} : { approvalId: entry.event.approvalId }),
      };
    }
    return undefined;
  }

  async function recordedHostDecision(
    tenant: TenantId,
    taskId: string,
    attempt: TaskAttempt,
    tail: ApprovalTimelineTail | undefined,
    request: PendingApproval,
  ): Promise<{ readonly decision: 'approve' | 'reject'; readonly approvalId?: string } | undefined> {
    for (const decision of ['approve', 'reject'] as const) {
      const sourceEnvelopeId = await approvalDecisionSource(tenant, taskId, attempt, request, decision);
      const index = tail?.entries.findIndex((candidate) => candidate.sourceEnvelopeId === sourceEnvelopeId) ?? -1;
      const entry = index < 0 ? undefined : tail!.entries[index];
      if (entry?.event.type !== 'approval_resolved' || entry.event.resolvedBy !== 'host') continue;
      const laterResolution = tail!.entries.slice(index + 1).some(
        (candidate) =>
          candidate.event.type === 'approval_resolved' &&
          (request.approvalId === undefined || candidate.event.approvalId === request.approvalId),
      );
      if (!laterResolution) {
        return {
          decision,
          ...(entry.event.approvalId === undefined ? {} : { approvalId: entry.event.approvalId }),
        };
      }
    }
    return undefined;
  }

  /**
   * The shared body of `approveTask`/`rejectTask` — one gate order, two
   * decisions, so the two host calls cannot drift apart. See
   * {@link ByokCloud.approveTask} for what each gate refuses and why the whole
   * gate runs before any durable allocation.
   */
  async function resolveApproval(
    tenant: TenantId,
    taskId: string,
    decision: 'approve' | 'reject',
    opts: RejectTaskOptions | undefined,
  ): Promise<EnqueuedAgentControl> {
    const stores = tenantStoresFor(controlPlane(tenant), root);
    const attempt = await stores.tasks.get(taskId);
    if (attempt === undefined) {
      throw new ByokCloudError('task_not_found', `Task ${taskId} was not found for this tenant.`);
    }
    if (isTerminalAttemptStatus(attempt.status)) {
      throw new ByokCloudError(
        'task_not_awaiting_approval',
        `Task ${taskId} already reached ${attempt.status}; there is no approval left to ${decision}.`,
      );
    }
    const tail = await stores.approvals.read(taskId);
    const pending = pendingApproval(tail);
    const latestRequest = latestApprovalRequest(tail);
    if (pending === undefined) {
      // A response may have been lost after the conditional timeline commit or
      // after mailbox append.  Re-read the stable decision source and replay
      // the exact logical outcome; an opposite decision remains fail-closed.
      if (latestRequest !== undefined) {
        const recorded = await recordedHostDecision(tenant, taskId, attempt, tail, latestRequest);
        if (recorded !== undefined) {
          if (recorded.decision !== decision) {
            throw new ByokCloudError(
              'coordination_input_invalid',
              `Task ${taskId} already has the opposite host approval decision.`,
            );
          }
          const ownerDeviceId = attempt.ownerDeviceId;
          if (ownerDeviceId === undefined) {
            throw new ByokCloudError(
              'task_not_awaiting_approval',
              `Task ${taskId} has no owning device to receive its recorded ${decision}.`,
            );
          }
          const messageId = await approvalDecisionSource(tenant, taskId, attempt, latestRequest, decision);
          const targeting = recorded.approvalId === undefined ? {} : { approvalId: recorded.approvalId };
          return enqueueAgentControlEnvelope(tenant, ownerDeviceId, messageId, (seq) =>
            decision === 'approve'
              ? createEnvelope('task.approve', targeting, { id: messageId, taskId, seq })
              : createEnvelope(
                  'task.reject',
                  { ...targeting, ...(opts?.reason === undefined ? {} : { reason: opts.reason }) },
                  { id: messageId, taskId, seq },
                ),
          );
        }
      }
      throw new ByokCloudError(
        'task_not_awaiting_approval',
        `Task ${taskId} has no pending approval to ${decision}.`,
      );
    }
    // Untargeted when the daemon never reported an id: there is nothing to
    // disagree with, and the pending approval is the only one there is.
    if (
      opts?.approvalId !== undefined &&
      pending.approvalId !== undefined &&
      opts.approvalId !== pending.approvalId
    ) {
      throw new StaleApprovalError(taskId, opts.approvalId, pending.approvalId);
    }
    // The claiming device, not the offered one: an approval belongs to the
    // runtime that is actually paused on it.
    const ownerDeviceId = attempt.ownerDeviceId;
    if (ownerDeviceId === undefined) {
      throw new ByokCloudError(
        'task_not_awaiting_approval',
        `Task ${taskId} has no owning device; no runtime is paused on an approval to ${decision}.`,
      );
    }
    // A pre-M5 request has no native id to validate or deliver. A caller may
    // supply a target because the public option is shared with M5 peers, but
    // it cannot manufacture protocol identity: both the durable event and the
    // control payload remain id-less. Decision identity is the request
    // source/revision.
    const approvalId = pending.approvalId;
    const messageId = await approvalDecisionSource(tenant, taskId, attempt, pending, decision);
    const event = {
      type: 'approval_resolved' as const,
      ...(approvalId === undefined ? {} : { approvalId }),
      decision,
      resolvedBy: 'host' as const,
      at: new Date().toISOString(),
    };
    const resolved = await root.cloud.approvals.resolvePending(tenant, {
      taskId,
      sourceEnvelopeId: messageId,
      expectedSourceEnvelopeId: pending.sourceEnvelopeId,
      expectedRevision: pending.revision,
      event,
    });
    let deliveredApprovalId = approvalId;
    if (resolved.status === 'conflict' || resolved.status === 'superseded' || resolved.status === 'absent') {
      const currentTail = resolved.tail ?? (await stores.approvals.read(taskId));
      const currentPending = pendingApproval(currentTail);
      const recorded = await recordedHostDecision(tenant, taskId, attempt, currentTail, pending);
      if (recorded?.decision === decision) {
        // A concurrent identical resolver won first. Its event timestamp is
        // intentionally not a competing identity; the stable decision source
        // is, and mailbox append below replays that source exactly once.
        deliveredApprovalId = recorded.approvalId;
      } else if (recorded !== undefined) {
        throw new ByokCloudError(
          'coordination_input_invalid',
          `Task ${taskId} already has the opposite host approval decision.`,
        );
      } else if (
        currentPending !== undefined &&
        opts?.approvalId !== undefined &&
        currentPending.approvalId !== undefined &&
        currentPending.approvalId !== opts.approvalId
      ) {
        throw new StaleApprovalError(taskId, opts.approvalId, currentPending.approvalId);
      } else {
        throw new ByokCloudError(
          'task_not_awaiting_approval',
          `Task ${taskId} no longer has the pending approval to ${decision}.`,
        );
      }
    }
    const targeting = deliveredApprovalId === undefined ? {} : { approvalId: deliveredApprovalId };
    return enqueueAgentControlEnvelope(tenant, ownerDeviceId, messageId, (seq) =>
      decision === 'approve'
        ? createEnvelope('task.approve', targeting, { id: messageId, taskId, seq })
        : createEnvelope(
            'task.reject',
            { ...targeting, ...(opts?.reason === undefined ? {} : { reason: opts.reason }) },
            { id: messageId, taskId, seq },
          ),
    );
  }

  /**
   * The steer gate. See {@link ByokCloud.steerTask} for the order and
   * `steer-control.ts` for why the claim snapshot is the only input.
   */
  async function steerTask(
    tenant: TenantId,
    taskId: string,
    payload: TaskSteerPayload,
  ): Promise<EnqueuedAgentControl> {
    const stores = tenantStoresFor(controlPlane(tenant), root);
    const attempt = await stores.tasks.get(taskId);
    if (attempt === undefined) {
      throw new ByokCloudError('task_not_found', `Task ${taskId} was not found for this tenant.`);
    }
    if (isTerminalAttemptStatus(attempt.status)) {
      throw new SteerRejectedError(taskId, 'task_terminal', attempt.status, attempt.claimedRuntime);
    }
    // The owner check rides the same gate as the status check rather than
    // getting a fourth code: an attempt with no owning device has no runtime
    // paused on a turn, which is exactly what `task_not_running` says. It is
    // also unreachable while `running` implies a prior claim — this is the
    // narrowing, not a second contract.
    const ownerDeviceId = attempt.ownerDeviceId;
    if (attempt.status !== 'running' || ownerDeviceId === undefined) {
      throw new SteerRejectedError(taskId, 'task_not_running', attempt.status, attempt.claimedRuntime);
    }
    if (attempt.claimedRuntimeCapabilities?.steer !== true) {
      throw new SteerRejectedError(
        taskId,
        'steer_unsupported_runtime',
        attempt.status,
        attempt.claimedRuntime,
      );
    }
    const messageId = options.crypto.randomUuid();
    return enqueueAgentControlEnvelope(tenant, ownerDeviceId, messageId, (seq) =>
      createEnvelope('task.steer', { text: payload.text }, { id: messageId, taskId, seq }),
    );
  }

  async function getAgentHomeProjectionStatus(
    tenant: TenantId,
    deviceId: string,
    input: AgentHomeProjectionStatusInput,
  ): Promise<AgentHomeProjectionReadback | undefined> {
    return readAgentHomeProjectionStatus(
      tenantStoresFor(controlPlane(tenant), root).receipts,
      tenant,
      deviceId,
      input,
    );
  }

  async function completeAgentHomeProjection(
    tenant: TenantId,
    deviceId: string,
    receiptInput: AgentHomeProjectionCompletionRequest,
  ): Promise<AgentHomeProjectionReadback> {
    return completeAgentHomeProjectionFromStores(
      tenantStoresFor(controlPlane(tenant), root),
      deviceId,
      receiptInput,
    );
  }

  async function completeAgentHomeProjectionFromStores(
    stores: TenantStores,
    deviceId: string,
    receiptInput: AgentHomeProjectionCompletionRequest,
  ): Promise<AgentHomeProjectionReadback> {
    const receipt = AgentHomeProjectionCompletionRequestSchema.parse(receiptInput);
    await assertAgentCapabilities(stores.tenant, deviceId, [
      AGENT_HOME_CONTRACT_CAPABILITY,
      AGENT_HOME_PROJECTION_CAPABILITY,
    ]);
    return recordAgentHomeProjectionCompletion(
      stores.receipts,
      stores.tenant,
      deviceId,
      receipt,
    );
  }

  async function commitAgentMemoryProjectionFromStores(
    stores: TenantStores,
    deviceId: string,
    mutationInput: AgentMemoryProjectionCommitRequest,
    redactedBytes: Uint8Array,
  ): Promise<AgentMemoryProjectionCommitResponse> {
    const mutation = AgentMemoryProjectionCommitRequestSchema.parse(mutationInput);
    const attempt = await stores.tasks.get(mutation.taskId);
    if (
      attempt === undefined ||
      attempt.deviceId !== deviceId ||
      !sameAgentRef(mutation.agentRef, attempt.agentRef)
    ) {
      throw new ByokCloudError(
        'agent_memory_projection_task_mismatch',
        'The Agent-memory projection does not match an exact task/device/AgentRef binding.',
      );
    }
    const authorizer = options.agentMemoryProjectionAuthorizer;
    const store = options.agentMemoryProjectionStore;
    if (authorizer === undefined || store === undefined) {
      throw new ByokCloudError(
        'agent_capability_missing',
        'Hosted Agent-memory projection requires both an authorizer and a projection store.',
      );
    }
    const authorization = await authorizer.authorize({
      tenantId: stores.tenant,
      deviceId,
      taskId: mutation.taskId,
      agentRef: mutation.agentRef,
      sessionRef: mutation.sessionRef,
      runtimeId: mutation.runtimeId,
      grantRef: mutation.grantRef,
      writerEpoch: mutation.writerEpoch,
      policyRevision: mutation.policyRevision,
    });
    if (authorization.outcome !== 'authorized') {
      throw new ByokCloudError(
        'agent_memory_projection_authorization_denied',
        `The Agent-memory projection grant was denied: ${authorization.reasonCode}`,
      );
    }
    return store.commit({ tenantId: stores.tenant, deviceId, mutation, redactedBytes });
  }

  async function eraseAgentMemoryProjection(tenant: TenantId, agentId: string): Promise<AgentMemoryProjectionEraseResult> {
    const authorizer = options.agentMemoryProjectionAuthorizer;
    const store = options.agentMemoryProjectionStore;
    if (authorizer === undefined || store === undefined) {
      throw new ByokCloudError(
        'agent_capability_missing',
        'Hosted Agent-memory projection is not configured for this deployment.',
      );
    }
    // Consent revocation first ensures every later device replay is denied,
    // even when a subsequent external erase has to be retried by the caller.
    await authorizer.revoke({ tenantId: tenant, agentId });
    return store.erase({ tenantId: tenant, agentId });
  }

  async function enqueueReliableEgressAck(stores: TenantStores, record: AgentEgressRecord): Promise<void> {
    const payload: AgentEgressAckPayload = AgentEgressAckPayloadSchema.parse({
      agentRef: record.payload.agentRef,
      sessionRef: record.payload.sessionRef,
      policyRevision: record.payload.policyRevision,
      eventId: record.payload.eventId,
      cursor: record.payload.cursor,
      receiptId: record.receiptId,
    });
    const message = await stores.mailbox.append({
      deviceId: record.deviceId,
      messageId: record.receiptId,
      materialize: async (seq) => {
        const body = encodeEnvelope(createEnvelope('agent.egress.ack', payload, { id: record.receiptId, seq }));
        const bytes = new TextEncoder().encode(body);
        return {
          body,
          bodyHash: contentHash(await options.crypto.sha256(bytes)),
          byteSize: BigInt(bytes.length),
        };
      },
    });
    const decoded = decodeEnvelope(message.body);
    if (
      decoded.type !== 'agent.egress.ack' ||
      decoded.seq !== message.seq ||
      JSON.stringify(decoded.payload) !== JSON.stringify(payload)
    ) {
      throw new ByokCloudError(
        'mailbox_receipt_mismatch',
        `Mailbox receipt ${record.receiptId} does not exactly acknowledge Agent egress ${record.payload.eventId}.`,
      );
    }
  }

  /** Durable content receipt first; this exact mailbox acknowledgement is then replayable by request id. */
  async function enqueueContentReceiptAck(
    stores: TenantStores,
    deviceId: string,
    receipt: AgentContentReceiptPayload,
  ): Promise<void> {
    const exactReceipt = AgentContentReceiptPayloadSchema.parse(receipt);
    if (exactReceipt.eventId !== exactReceipt.requestId) {
      throw new ByokCloudError('mailbox_receipt_mismatch', 'Content receipt eventId must equal requestId.');
    }
    const payload: AgentEgressAckPayload = AgentEgressAckPayloadSchema.parse({
      agentRef: exactReceipt.agentRef,
      sessionRef: exactReceipt.sessionRef,
      policyRevision: exactReceipt.policyRevision,
      eventId: exactReceipt.eventId,
      cursor: exactReceipt.cursor,
      receiptId: exactReceipt.requestId,
    });
    const message = await stores.mailbox.append({
      deviceId,
      // The request itself already occupies its bare request id in this
      // mailbox. A namespaced producer key keeps the ack idempotent without
      // returning that control envelope on duplicate receipt delivery.
      messageId: `agent-content-ack:${exactReceipt.requestId}`,
      materialize: async (seq) => {
        const body = encodeEnvelope(createEnvelope('agent.egress.ack', payload, { id: exactReceipt.requestId, seq }));
        const bytes = new TextEncoder().encode(body);
        return {
          body,
          bodyHash: contentHash(await options.crypto.sha256(bytes)),
          byteSize: BigInt(bytes.length),
        };
      },
    });
    const decoded = decodeEnvelope(message.body);
    if (
      decoded.type !== 'agent.egress.ack' ||
      decoded.seq !== message.seq ||
      JSON.stringify(decoded.payload) !== JSON.stringify(payload)
    ) {
      throw new ByokCloudError(
        'mailbox_receipt_mismatch',
        `Mailbox content receipt ${exactReceipt.requestId} does not exactly acknowledge its durable content fact.`,
      );
    }
  }

  async function enqueueAgentMessageDisposition(
    stores: TenantStores,
    deviceId: string,
    taskId: string,
    payload: AgentMessageDispositionPayload,
  ): Promise<void> {
    const message = await stores.mailbox.append({
      deviceId,
      messageId: `agent-message-disposition:${payload.receiptId}`,
      materialize: async (seq) => {
        const body = encodeEnvelope(createEnvelope('agent.message.disposition', payload, {
          id: payload.receiptId,
          taskId,
          seq,
        }));
        const bytes = new TextEncoder().encode(body);
        return { body, bodyHash: contentHash(await options.crypto.sha256(bytes)), byteSize: BigInt(bytes.length) };
      },
    });
    const decoded = decodeEnvelope(message.body);
    if (decoded.type !== 'agent.message.disposition' || decoded.seq !== message.seq) {
      throw new ByokCloudError('mailbox_receipt_mismatch', 'Agent message disposition mailbox readback mismatched.');
    }
  }

  return {
    fetch: registry.fetch,
    routes: registry.routes,
    mountedRoutes: registry.mounted,
    capabilities: declaration,

    createPairingCode(tenant, input) {
      return auth.createPairingCode(tenant, input);
    },

    async enqueueOffer(tenant, deviceId, input) {
      await assertLegacyAdmission(tenant, deviceId);
      return enqueueTaskEnvelope(tenant, deviceId, input.taskId, undefined, (taskId, seq, messageId) =>
        createEnvelope('task.offer', input.payload, { id: messageId, taskId, seq }),
      );
    },

    async enqueueToolsetOffer(tenant, deviceId, input) {
      await assertLegacyAdmission(tenant, deviceId);
      return enqueueTaskEnvelope(tenant, deviceId, input.taskId, undefined, (taskId, seq, messageId) =>
        createEnvelope('task.offer_with_toolsets', input.payload, { id: messageId, taskId, seq }),
      );
    },

    async enqueueAgentOffer(tenant, deviceId, input) {
      await assertAgentCapabilities(tenant, deviceId, [
        AGENT_HOME_CONTRACT_CAPABILITY,
        ...(input.payload.terminalProjection === undefined ? [] : [TERMINAL_PROJECTION_SELECTION_CAPABILITY]),
      ]);
      // Parse the strict control payload before reserving a mailbox sequence.
      // A malformed/oversized AgentRef therefore cannot leave a durable
      // delivery row behind.
      const payload = TaskOfferForAgentPayloadSchema.parse(input.payload);
      return enqueueTaskEnvelope(tenant, deviceId, input.taskId, payload.agentRef, (taskId, seq, messageId) =>
        createEnvelope('task.offer_for_agent', payload, { id: messageId, taskId, seq }),
      );
    },

    async enqueueAgentEgressOffer(tenant, deviceId, input) {
      await assertAgentCapabilities(tenant, deviceId, [
        AGENT_HOME_CONTRACT_CAPABILITY,
        AGENT_EGRESS_POLICY_CAPABILITY,
        AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
        ...(input.payload.messageEgress === undefined ? [] : [AGENT_MESSAGE_EGRESS_CAPABILITY]),
        ...(input.payload.terminalProjection === undefined ? [] : [TERMINAL_PROJECTION_SELECTION_CAPABILITY]),
      ]);
      const payload = TaskOfferForAgentWithEgressPayloadSchema.parse(input.payload);
      if (payload.messageEgress === undefined && input.agentMessageContext !== undefined) {
        throw new Error('agentMessageContext requires messageEgress');
      }
      const messageContext = payload.messageEgress === undefined
        ? undefined
        : AgentMessageServerContextSchema.parse(input.agentMessageContext);
      const enqueued = await enqueueTaskEnvelope(
        tenant,
        deviceId,
        input.taskId,
        payload.agentRef,
        (taskId, seq, messageId) => createEnvelope('task.offer_for_agent_with_egress', payload, { id: messageId, taskId, seq }),
        payload.messageEgress === undefined ? undefined : async (stores, taskId) => {
          const body = JSON.stringify({ agentRef: payload.agentRef, sessionRef: payload.sessionRef, requirement: payload.messageEgress, context: messageContext });
          const recorded = await stores.receipts.record({ key: `agent-message-offer:${deviceId}:${taskId}`, body });
          if (!recorded.created && recorded.receipt.body !== body) {
            throw new ByokCloudError('agent_content_request_mismatch', `Task ${taskId} already has a different Agent message context.`);
          }
        },
      );
      return enqueued;
    },

    async enqueueFreshAgentEgressOffer(tenant, deviceId, input) {
      await assertAgentCapabilities(tenant, deviceId, [
        AGENT_HOME_CONTRACT_CAPABILITY,
        AGENT_EGRESS_POLICY_CAPABILITY,
        AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
        AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
        ...(input.payload.messageEgress === undefined ? [] : [AGENT_MESSAGE_EGRESS_CAPABILITY]),
        ...(input.payload.terminalProjection === undefined ? [] : [TERMINAL_PROJECTION_SELECTION_CAPABILITY]),
      ]);
      const payload = TaskOfferForAgentWithEgressFreshPayloadSchema.parse(input.payload);
      if (payload.messageEgress === undefined && input.agentMessageContext !== undefined) {
        throw new Error('agentMessageContext requires messageEgress');
      }
      const messageContext = payload.messageEgress === undefined
        ? undefined
        : AgentMessageServerContextSchema.parse(input.agentMessageContext);
      const enqueued = await enqueueTaskEnvelope(
        tenant,
        deviceId,
        input.taskId,
        payload.agentRef,
        (taskId, seq, messageId) => createEnvelope('task.offer_for_agent_with_egress_fresh', payload, { id: messageId, taskId, seq }),
        payload.messageEgress === undefined ? undefined : async (stores, taskId) => {
          const body = JSON.stringify({ agentRef: payload.agentRef, requirement: payload.messageEgress, context: messageContext });
          const recorded = await stores.receipts.record({ key: `agent-message-offer:${deviceId}:${taskId}`, body });
          if (!recorded.created && recorded.receipt.body !== body) {
            throw new ByokCloudError('agent_content_request_mismatch', `Task ${taskId} already has a different Agent message context.`);
          }
        },
      );
      return enqueued;
    },

    async enqueueAgentContentRead(tenant, deviceId, input) {
      const payload = AgentContentReadPayloadSchema.parse(input.payload);
      await assertAgentCapabilities(tenant, deviceId, [
        AGENT_HOME_CONTRACT_CAPABILITY,
        AGENT_EGRESS_POLICY_CAPABILITY,
        AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
        contentReadCapability(payload.surface),
      ]);
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const persisted = await stores.receipts.record({
        key: agentReliabilityKey('agent-content-request', deviceId, payload.agentRef, payload.requestId),
        body: JSON.stringify(payload),
      });
      if (!persisted.created && persisted.receipt.body !== JSON.stringify(payload)) {
        throw new ByokCloudError(
          'agent_content_request_mismatch',
          `Request ${payload.requestId} already exists with a different immutable content-read body.`,
        );
      }
      const messageId = await agentControlEnvelopeId(
        'byok:agent-content-read',
        tenant,
        deviceId,
        payload.agentRef,
        payload.requestId,
      );
      const control = await enqueueAgentControlEnvelope(tenant, deviceId, messageId, (seq) =>
        createEnvelope('agent.content.read', payload, { id: messageId, seq }),
      );
      if (
        control.envelope.type !== 'agent.content.read' ||
        JSON.stringify(control.envelope.payload) !== JSON.stringify(payload)
      ) {
        throw new ByokCloudError(
          'agent_content_request_mismatch',
          `Request ${payload.requestId} already exists with a different immutable content-read body.`,
        );
      }
      return control;
    },

    async enqueueAgentHomeProjection(tenant, deviceId, input) {
      // Validate the bounded opaque request before durable capability admission
      // or receipt/mailbox allocation. A malformed control can therefore never
      // leave an immutable desired fact or delivery row behind.
      const payload = AgentHomeProjectionPayloadSchema.parse(input);
      await assertAgentCapabilities(tenant, deviceId, [
        AGENT_HOME_CONTRACT_CAPABILITY,
        AGENT_HOME_PROJECTION_CAPABILITY,
      ]);
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const requestBody = JSON.stringify(payload);
      const persisted = await stores.receipts.record({
        key: agentHomeProjectionRequestKey(deviceId, payload.agentRef, payload.requestId),
        body: requestBody,
      });
      const persistedPayload = AgentHomeProjectionPayloadSchema.parse(JSON.parse(persisted.receipt.body));
      if (!sameAgentHomeProjectionRequest(payload, persistedPayload)) {
        throw new ByokCloudError(
          'agent_home_projection_request_conflict',
          `Agent-home projection request ${payload.requestId} already exists with a different immutable desired body.`,
        );
      }
      const messageId = await agentControlEnvelopeId(
        'byok:agent-home-projection',
        tenant,
        deviceId,
        payload.agentRef,
        payload.requestId,
      );
      const control = await enqueueAgentControlEnvelope(tenant, deviceId, messageId, (seq) =>
        createEnvelope('agent.home.projection', payload, { id: messageId, seq }),
      );
      if (
        control.envelope.type !== 'agent.home.projection' ||
        !sameAgentHomeProjectionRequest(payload, control.envelope.payload)
      ) {
        throw new ByokCloudError(
          'agent_home_projection_request_conflict',
          `Mailbox request ${payload.requestId} does not match its immutable Agent-home projection fact.`,
        );
      }
      const status = await getAgentHomeProjectionStatus(tenant, deviceId, {
        requestId: payload.requestId,
        agentRef: payload.agentRef,
        projectionHash: payload.projectionHash,
      });
      if (status === undefined) {
        throw new ByokCloudError(
          'agent_home_projection_receipt_invalid',
          `Agent-home projection request ${payload.requestId} disappeared after durable allocation.`,
        );
      }
      return { ...control, status };
    },

    getAgentHomeProjectionStatus,

    completeAgentHomeProjection,
    eraseAgentMemoryProjection,

    approveTask(tenant, taskId, opts) {
      return resolveApproval(tenant, taskId, 'approve', opts);
    },

    rejectTask(tenant, taskId, opts) {
      return resolveApproval(tenant, taskId, 'reject', opts);
    },

    steerTask,

    async cancelTask(tenant, taskId, reason) {
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const proposedMessageId = options.crypto.randomUuid();
      const mutation = await stores.cancellations.request({
        taskId,
        proposedMessageId,
        ...(reason === undefined ? {} : { reason }),
        materialize: async (seq, messageId) => {
          const envelope = createEnvelope('task.cancel', reason === undefined ? {} : { reason }, {
            id: messageId,
            taskId,
            seq,
          });
          const body = encodeEnvelope(envelope);
          const bytes = new TextEncoder().encode(body);
          return {
            body,
            bodyHash: contentHash(await options.crypto.sha256(bytes)),
            byteSize: BigInt(bytes.length),
          };
        },
      });
      if (mutation === undefined) {
        throw new ByokCloudError('task_not_found', `Task ${taskId} was not found for this tenant.`);
      }
      if (mutation.message !== undefined) {
        const envelope = decodeEnvelope(mutation.message.body);
        if (envelope.seq !== mutation.message.seq || envelope.type !== 'task.cancel') {
          throw new ByokCloudError(
            'mailbox_seq_mismatch',
            `Mailbox stored cancellation seq ${String(envelope.seq)} at row ${mutation.message.seq}.`,
          );
        }
      }
      return mutation.attempt;
    },

    readTaskAttempt(tenant, taskId) {
      return tenantStoresFor(controlPlane(tenant), root).tasks.get(taskId);
    },

    listTaskAttempts(tenant, query) {
      return tenantStoresFor(controlPlane(tenant), root).tasks.list(query);
    },

    readTerminalReceipt(tenant, taskId) {
      return tenantStoresFor(controlPlane(tenant), root).receipts.get(terminalReceiptKey(taskId));
    },

    readAgentEgress(tenant, deviceId, agentRef, eventId) {
      return tenantStoresFor(controlPlane(tenant), root).egress.get(deviceId, agentRef, eventId);
    },

    async readTaskResult(tenant, taskId) {
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const attempt = await stores.tasks.get(taskId);
      if (attempt?.cancellation !== undefined) {
        return {
          taskId,
          state: 'cancelled',
          ...(attempt.agentRef === undefined ? {} : { agentRef: attempt.agentRef }),
          ...(attempt.cancellation.reason === undefined
            ? {}
            : { reason: attempt.cancellation.reason }),
          ...(attempt.cancellation.reason === undefined
            ? {}
            : { terminalCause: attempt.cancellation.reason }),
          recordedAt: attempt.cancellation.requestedAt,
        };
      }
      const receipt = await stores.receipts.get(
        terminalReceiptKey(taskId),
      );
      return receipt === undefined ? undefined : projectTerminalResult(taskId, receipt);
    },

    listDevices(tenant) {
      return tenantStoresFor(controlPlane(tenant), root).devices.list();
    },

    revokeDevice(tenant, deviceId) {
      return tenantStoresFor(controlPlane(tenant), root).devices.revoke(deviceId);
    },

    createBoardItem(tenant, input) {
      assertBoardLabels(input.channel, input.title, {
        channelMaxBytes: options.boardChannelMaxBytes ?? DEFAULT_BOARD_CHANNEL_MAX_BYTES,
        titleMaxBytes: options.boardTitleMaxBytes ?? DEFAULT_BOARD_TITLE_MAX_BYTES,
      });
      return tenantStoresFor(controlPlane(tenant), root).board.create(input);
    },

    listBoardItems(tenant, query) {
      return tenantStoresFor(controlPlane(tenant), root).board.list(query);
    },

    acceptBoardItem(tenant, itemId) {
      return tenantStoresFor(controlPlane(tenant), root).board.updateStatus({
        itemId,
        expectedStatus: 'in_review',
        status: 'done',
      });
    },

    listPresence(tenant) {
      return tenantStoresFor(controlPlane(tenant), root).presence.list();
    },

    readTenantReadiness(tenant) {
      return tenantStoresFor(controlPlane(tenant), root).devices.readiness();
    },

    readActivity(tenant, taskId) {
      return tenantStoresFor(controlPlane(tenant), root).activity.read(taskId);
    },

    readApprovalTimeline(tenant, taskId) {
      return tenantStoresFor(controlPlane(tenant), root).approvals.read(taskId);
    },
  };
}

/**
 * Fail closed on a declaration this composition's parts cannot back.
 *
 * Route mounting alone cannot enforce this: `GET /byok/capabilities` serves the
 * declaration verbatim and is mounted unconditionally, so a deployment that
 * declares `blobs.contentproxy` without a proxy publishes the capability and
 * 404s both routes. Refusing at construction is the only placement where the
 * deployment cannot exist in that state — the alternative, sanitizing the
 * declaration down to what got mounted, would make the running surface a second
 * authority over what the host said it was deploying.
 */
function assertNoOverDeclaration(
  declaration: CapabilityDeclaration,
  contentProxy: BlobContentProxy | undefined,
  truthCommitter: TruthCommitter | undefined,
  truthObjectDownloads: TruthObjectDownloads | undefined,
  skillPacks: SkillPackStore | undefined,
  agentMemoryProjectionAuthorizer: AgentMemoryProjectionAuthorizer | undefined,
  agentMemoryProjectionStore: AgentMemoryProjectionStore | undefined,
): void {
  if (
    declares(declaration, CLOUD_CAPABILITIES.boardSse) &&
    !declares(declaration, CLOUD_CAPABILITIES.boardCoordination)
  ) {
    throw new ByokCloudError(
      'capability_over_declared',
      `${CLOUD_CAPABILITIES.boardSse} requires ${CLOUD_CAPABILITIES.boardCoordination}; without polling, reconciliation and declared fallback cannot be served.`,
    );
  }
  if (contentProxy === undefined && declares(declaration, CLOUD_CAPABILITIES.blobsContentProxy)) {
    throw new ByokCloudError(
      'capability_over_declared',
      `This deployment declares ${CLOUD_CAPABILITIES.blobsContentProxy} but was given no BlobContentProxy, so both /byok/blobs/:id/content routes would be published and unserved.`,
    );
  }
  if (truthCommitter === undefined && declares(declaration, CLOUD_CAPABILITIES.truthRecords)) {
    throw new ByokCloudError(
      'capability_over_declared',
      `This deployment declares ${CLOUD_CAPABILITIES.truthRecords} but was given no atomic TruthCommitter.`,
    );
  }
  if (truthObjectDownloads === undefined && declares(declaration, CLOUD_CAPABILITIES.truthRecords)) {
    throw new ByokCloudError(
      'capability_over_declared',
      `This deployment declares ${CLOUD_CAPABILITIES.truthRecords} but was given no content-hash keyed TruthObjectDownloads authority.`,
    );
  }
  if (skillPacks === undefined && declares(declaration, CLOUD_CAPABILITIES.skillPacks)) {
    throw new ByokCloudError(
      'capability_over_declared',
      `This deployment declares ${CLOUD_CAPABILITIES.skillPacks} but was given no SkillPackStore, so both /byok/skill-packs routes would be published and unserved.`,
    );
  }
  if (
    declares(declaration, CLOUD_CAPABILITIES.agentMemoryProjection) &&
    (agentMemoryProjectionAuthorizer === undefined || agentMemoryProjectionStore === undefined)
  ) {
    throw new ByokCloudError(
      'capability_over_declared',
      `This deployment declares ${CLOUD_CAPABILITIES.agentMemoryProjection} but was given no complete AgentMemoryProjectionAuthorizer/AgentMemoryProjectionStore pair.`,
    );
  }
}

function parseDeclaration(declaration: CapabilityDeclaration): CapabilityDeclaration {
  try {
    return parseCapabilityDeclaration(declaration);
  } catch (cause) {
    throw new ByokCloudError(
      'capability_declaration_invalid',
      'The capability declaration this deployment was configured with is not a valid ADR-010 declaration.',
      { cause },
    );
  }
}
