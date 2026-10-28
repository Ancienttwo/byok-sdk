import { createTenantApi } from './api/tenant';
import { createTaskReadsApi } from './api/task-reads';
import { createTaskCancellationApi } from './api/task-cancellation';
import { createE2eeApi } from './api/e2ee';
import { createAgentControlsApi } from './api/agent-controls';
import { createOffersApi } from './api/offers';
import { createMaintenanceApi } from './api/maintenance';
import { z } from 'zod';
import {
  readTaskAgentMessageDraft,
  type AgentMessageDraftCursor,
  type AgentMessageDraftReadback,
} from './agent-message-draft';
import {
  resolveProofReceiptRetention,
  type MaintenanceInput,
  type MaintenanceReport,
  type ProofReceiptRetentionOptions,
} from './maintenance';
import type { DeviceAssertionReplayAuthority } from '@byok-sdk/core';
import { readTaskAgentMessage, type TaskAgentMessage } from './task-agent-message';
import {
  AgentExecutionInputSchema,
  SealedAgentExecutionInputSchema,
  type AgentExecutionInput,
  type SealedAgentExecutionInput,
} from './agent-execution';
import { uuidFromSha256, taskOfferMessageId } from './offer-identity';
import { firstSealedPayload, sameSealedProjection } from './sealed-comparison';
import { HarnessIdSchema, isSealedPayload, requiredReceiverCapabilities } from '@byok-sdk/protocol';
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
  principalTenant,
  type BoardItem,
  type BoardItemInput,
  type BoardListQuery,
  type BoardPage,
  type CapabilityDeclaration,
  type Clock,
  type ControlPlanePrincipal,
  type CoreStores,
  type DevicePrincipal,
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
  BYOK_INPUT_PREPARATION_COMPLETION_ROUTE,
  BYOK_INPUT_PREPARATION_STATUS_ROUTE,
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
  BYOK_E2EE_CHAIN_PATH,
  BYOK_E2EE_KEY_PACKAGES_PATH,
  BYOK_E2EE_MEMBER_KEY_PATH,
  BYOK_E2EE_PAIRING_MAC_PATH,
  BYOK_SKILL_PACK_FILE_ROUTE,
  BYOK_SKILL_PACKS_PATH,
  BYOK_TOKEN_PATH,
  AGENT_HOME_PROJECTION_CAPABILITY,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  type Envelope,
  AgentContentReceiptPayloadSchema,
  AgentHomeProjectionCompletionRequestSchema,
  E2eeKeyPackageAvailablePayloadSchema,
  InputPreparationCompletionRequestSchema,
  AgentMemoryProjectionCommitRequestSchema,
  AgentEgressAckPayloadSchema,
  AgentMessageServerContextSchema,
  AgentEgressPolicySchema,
  InputPreparationOfferBindingSchema,
  SessionSelectionSchema,
  TaskOfferPlainPayloadSchema,
  TaskOfferSealedPayloadSchema,
  TaskSteerSealedPayloadSchema,
  type AgentEgressPolicy,
  type InputPreparationOfferBinding,
  type SessionSelection,
  type TaskOfferPayload,
  type TaskOfferPlainPayload,
  type TaskOfferSealedPayload,
  type AgentRef,
  type AgentContentReceiptPayload,
  type AgentContentReadPayload,
  type AgentEgressAckPayload,
  type AgentMessageDispositionPayload,
  type AgentMessagePublishPayload,
  type AgentMessageServerContext,
  type AgentHomeProjectionCompletionRequest,
  type AgentHomeProjectionPayload,
  type AgentHomeProjectionReadback,
  type AgentInputPreparationPayload,
  type ProviderProvisioningAvailablePayload,
  type AgentMemoryIntentAvailablePayload,
  type InputPreparationCompletionRequest,
  type InputPreparationReadback,
  type AgentMemoryProjectionCommitRequest,
  type AgentMemoryProjectionCommitResponse,
  type AgentMemoryProjectionEraseResult,
  type TaskSteerSealedPayload,
  type E2eeClientPairingMac,
  type E2eeKeyPackageAvailablePayload,
  type E2eeMemberChainEntry,
  type E2eeMemberKeyBundle,
  type E2eeScopeKeyPackage,
  type E2eeScopeKeyPackageV2Schema,
} from '@byok-sdk/protocol';
import { SteerRejectedError } from './steer-control';
import { createAuthPlane, type AuthPlane } from './auth/plane';
import type { TokenSigner } from './auth/tokens';
import { CLOUD_CAPABILITIES, declares } from './capabilities';
import {
  DEFAULT_ACTIVITY_BOUNDS,
  DEFAULT_PRESENCE_DETAIL_MAX_BYTES,
  DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS,
  DEFAULT_PRESENCE_TTL_MS,
  type ActivityBounds,
} from './coordination';
import type { CloudCrypto } from './crypto/port';
import { ByokCloudError, TaskOfferAppendRefusedError } from './errors';
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
import {
  inputPreparationCompletionHandler,
  inputPreparationStatusHandler,
} from './handlers/input-preparations';
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
  DEFAULT_MAX_E2EE_REQUEST_BYTES,
  e2eeMemberChainAppendHandler,
  e2eeMemberChainReadHandler,
  e2eeMemberKeyRegisterHandler,
  e2eePairingMacReadHandler,
  e2eeScopeKeyPackagePutHandler,
  e2eeScopeKeyPackageReadHandler,
} from './handlers/e2ee-member';
import {
  DEFAULT_MAX_TRUTH_REQUEST_BYTES,
  truthGetHandler,
  truthManifestHandler,
  truthPutHandler,
} from './handlers/truth';
import { CloudRouteRegistry, type CloudRouteHandler, type RouteDescriptor } from './router/registry';
import { readAgentMessageDisposition, terminalReceiptKey, type ByokCloudObserver } from './inbound';
import {
  readAgentHomeProjectionStatus,
  recordAgentHomeProjectionCompletion,
  type AgentHomeProjectionReceiptInput,
} from './agent-home-projections';
import {
  readInputPreparationStatus,
  recordInputPreparationCompletion,
  type InputPreparationReceiptInput,
} from './input-preparations';
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
import { type DeviceTerminal, type TerminalResult } from './terminal-result';
import type { MailboxWake } from './mailbox-wake';
import {
  parseTaskRedactionInput,
  sameTaskBody,
  taskRedactionCodec,
  taskRedactionReceiptKey,
  type TaskRedactionResult,
  type TaskRedactionStore,
  type TaskRedactionTaskResult,
} from './task-redaction';
import { tenantStoresFor, type CloudRootStores, type TenantStores } from './tenant-stores';
import {
  releaseSealedCiphertext,
  retainSealedCiphertext,
  SEALED_TASK_REFERENCE_KIND,
  sealedCiphertextCommitted,
  sealedCiphertextRef,
} from './sealed-ciphertext';
import * as e2eeMember from './e2ee-member';
import type { E2eeMemberStore } from './e2ee-member';
import type { TruthCommitter, TruthObjectDownloads } from './truth/contract';

/** Matches the reference server's ceiling (§7). */
export const DEFAULT_MAX_BLOB_SIZE_BYTES = 100 * 1024 * 1024;
/** Matches the reference server's hold (§8). */
export const DEFAULT_LONG_POLL_HOLD_MS = 50_000;
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
  readonly deviceAssertionReplay?: DeviceAssertionReplayAuthority;
  /**
   * Prunes used device-proof request ids in maintenance. Absent, the
   * `proofReceipts` step reports `not-configured` and every used `requestId`
   * stays single-use for as long as its receipt is kept.
   */
  readonly proofReceiptRetention?: ProofReceiptRetentionOptions;
  readonly mailboxWake: MailboxWake;
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
  /**
   * Product-owned consumer; destination lookup uses authenticated task context.
   * Delivery is at least once, including concurrent calls and retries after a
   * process restart or an uncertain commit. The product must durably deduplicate
   * the exact tenant/device/task/AgentRef/message identity and payload, producing
   * one logical effect and the same outcome/reasonCode on every exact replay.
   * A thrown error leaves admission pending for transport retry; only a returned
   * outcome is a terminal product decision. Do not use callback invocation count
   * as execution authority.
   */
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
  /**
   * Admission hook for the unauthenticated auth routes (`POST /byok/pair`,
   * `/byok/challenge`, `/byok/token`), called BEFORE their handler runs and
   * before any store is touched. `false` answers 429 and the handler never
   * runs. Absent means no limit: the SDK ships no policy here, so an edge
   * limiter is the deployment's responsibility (see `deploy/runbooks/hosted-operations.md`,
   * "Public routes and edge rate limits"). A limiter that throws or rejects
   * fails the request with a 500 rather than letting it through.
   *
   * Authenticated routes are not covered: they already have the per-device
   * `InboundRateLimiter`.
   */
  readonly publicRouteLimiter?: PublicRouteLimiter;
  /** Embedder-owned grant and consent authority for optional hosted Agent-memory projection. */
  readonly agentMemoryProjectionAuthorizer?: AgentMemoryProjectionAuthorizer;
  /** Durable snapshot + immutable metering receipt authority for optional hosted Agent-memory projection. */
  readonly agentMemoryProjectionStore?: AgentMemoryProjectionStore;
  /** Durable authority for {@link ByokCloud.redactTasks}. Without it, `redactTasks` fails closed. */
  readonly taskRedactionStore?: TaskRedactionStore;
  /** Durable authority for the E2EE member chain, key packages and pairing MACs. Without it, those calls fail closed. */
  readonly e2eeMemberStore?: E2eeMemberStore;
  readonly maxBlobSizeBytes?: number;
  readonly longPollHoldMs?: number;
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
  /** Byte cap of one E2EE member device write. The default fits one full chain append (64 entries of 64 KiB). */
  readonly maxE2eeRequestBytes?: number;
  readonly skillPackPageLimit?: number;
}

/** The unauthenticated routes {@link ByokCloudOptions.publicRouteLimiter} guards. */
export type LimitedPublicRoute =
  | { readonly method: 'POST'; readonly path: typeof BYOK_PAIR_PATH }
  | { readonly method: 'POST'; readonly path: typeof BYOK_CHALLENGE_PATH }
  | { readonly method: 'POST'; readonly path: typeof BYOK_TOKEN_PATH };

/** `true` admits the request; `false` answers 429 before the handler or any store runs. */
export type PublicRouteLimiter = (
  route: LimitedPublicRoute,
  request: Request,
) => boolean | Promise<boolean>;

type ResumeSession = Extract<SessionSelection, { readonly mode: 'resume' }>;

/**
 * Strict Agent dispatch input. The device path is intentionally a separate
 * argument on {@link ByokCloud.enqueueAgentOffer}; no legacy offer field is
 * interpreted as an Agent placement hint.
 */
export interface AgentDispatchInput {
  /** Supply one to make the enqueue addressable by the host's own id; otherwise cloud mints one. */
  readonly taskId?: string;
  /**
   * Strict Agent resume payload carrying the exact opaque AgentRef and the
   * exact session being resumed (`session.mode: 'resume'`). A fresh Agent
   * execution is admitted only through {@link ByokCloud.submitAgentExecution};
   * an egress policy only through {@link ByokCloud.enqueueAgentEgressOffer}.
   */
  readonly payload: TaskOfferPlainPayload & {
    readonly session: ResumeSession;
    readonly egressPolicy?: never;
    readonly messageEgress?: never;
    readonly preparation?: never;
  };
}

/**
 * Strict dispatch of an already-counted preparation back to the device that
 * counted it.
 *
 * Deliberately NOT an optional field on {@link AgentDispatchInput}: a host API
 * that could express both through one input would let a caller reach the
 * ordinary lane by omitting one property.
 */
export interface PreparedDispatchInput {
  /** Supply one to make the enqueue addressable by the host's own id; otherwise cloud mints one. */
  readonly taskId?: string;
  /** Instruction-free strict fresh payload naming the preparation this Execution consumes. */
  readonly payload: TaskOfferPlainPayload & { readonly preparation: InputPreparationOfferBinding };
  /** Host-only destination/freshness authority; never serialized to the daemon. */
  readonly agentMessageContext?: AgentMessageServerContext;
}

/** Strict Agent resume dispatch that supplies the policy consumed by the typed egress lanes. */
export interface AgentEgressDispatchInput {
  /** Supply one to make the enqueue addressable by the host's own id; otherwise cloud mints one. */
  readonly taskId?: string;
  readonly payload: TaskOfferPlainPayload & {
    readonly session: ResumeSession;
    readonly egressPolicy: AgentEgressPolicy;
    readonly preparation?: never;
  };
  /** Host-only product destination/freshness authority; never serialized to the daemon. */
  readonly agentMessageContext?: AgentMessageServerContext;
}

/**
 * The sealed lane of {@link AgentDispatchInput} (#654). Resume-only, as the
 * plaintext lane is. Each sealed lane has its own input, as
 * {@link PreparedDispatchInput} does: a plaintext lane refuses `sealing` and
 * `sealed`, so a caller cannot reach the plaintext lane by a missing field,
 * and no lane strips a sealing policy.
 */
export interface SealedAgentDispatchInput {
  /** Required with a sealed instruction, whose AAD and content MAC bind it. Without one, cloud mints the id. */
  readonly taskId?: string;
  readonly payload: TaskOfferSealedPayload & {
    readonly session: ResumeSession;
    readonly egressPolicy?: never;
    readonly messageEgress?: never;
  };
}

/** The sealed lane of {@link AgentEgressDispatchInput} (#654). */
export interface SealedAgentEgressDispatchInput {
  /** Required with a sealed instruction, whose AAD and content MAC bind it. Without one, cloud mints the id. */
  readonly taskId?: string;
  readonly payload: TaskOfferSealedPayload & { readonly session: ResumeSession; readonly egressPolicy: AgentEgressPolicy };
  /** Host-only product destination/freshness authority; never serialized to the daemon. */
  readonly agentMessageContext?: AgentMessageServerContext;
}

const RESUME_SESSION = SessionSelectionSchema.options[0];
const NO_EGRESS = { egressPolicy: z.never().optional(), messageEgress: z.never().optional() };

/** The `task.offer` payload each enqueue lane admits; every lane sends `task.offer`. */
const AgentOfferLaneSchema = TaskOfferPlainPayloadSchema.safeExtend({ session: RESUME_SESSION, ...NO_EGRESS, preparation: z.never().optional() });
const AgentEgressOfferLaneSchema = TaskOfferPlainPayloadSchema.safeExtend({
  session: RESUME_SESSION, egressPolicy: AgentEgressPolicySchema, preparation: z.never().optional(),
});
const PreparedOfferLaneSchema = TaskOfferPlainPayloadSchema.safeExtend({ preparation: InputPreparationOfferBindingSchema });
const SealedAgentOfferLaneSchema = TaskOfferSealedPayloadSchema.safeExtend({ session: RESUME_SESSION, ...NO_EGRESS });
const SealedAgentEgressOfferLaneSchema = TaskOfferSealedPayloadSchema.safeExtend({ session: RESUME_SESSION, egressPolicy: AgentEgressPolicySchema });

/**
 * A plaintext lane refuses the sealed fields (#654), before any device read,
 * attempt, receipt or mailbox write, with a message that names the sealed lane.
 */
function refuseSealedFields(payload: unknown, fields: readonly string[], sealedEntry: string): void {
  if (payload === null || typeof payload !== 'object') return;
  const present = fields.filter((field) => field in payload);
  if (present.length > 0) {
    throw new ByokCloudError('coordination_input_invalid', `${present.join(', ')} belongs to the sealed lane; use ${sealedEntry}`);
  }
}

/** Resume-only Agent lanes refuse a payload that does not resume an exact session. */
function assertResumeSession(payload: { readonly session?: unknown }): void {
  const session = payload.session as { readonly mode?: unknown; readonly sessionRef?: unknown } | undefined;
  if (session?.mode !== 'resume' || typeof session.sessionRef !== 'string' || session.sessionRef.length === 0) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      'Agent resume offer requires session.mode resume with an exact sessionRef; use submitAgentExecution for fresh execution',
    );
  }
}

/** A task-free, independently capability-gated Agent content read. */
export interface AgentContentReadInput {
  readonly payload: AgentContentReadPayload;
}

/** Task-free exact-device projection desired state, intentionally unrelated to TaskAttempt. */
export type AgentHomeProjectionInput = AgentHomeProjectionPayload;

/**
 * Task-free sealed provider provisioning notice: exactly `{ requestId }`. The
 * sealed request itself stays in the Host's own store and is fetched by the
 * device over Host routes; nothing else can be carried by this input.
 */
export type ProviderProvisioningNoticeInput = ProviderProvisioningAvailablePayload;

/**
 * Task-free Host-approved Agent memory intent notice: exactly
 * `{ intentId, agentRef }`. The immutable intent, and any memory content it
 * carries, stays in the Host's own store and is fetched by the device over
 * Host routes; nothing else can be carried by this input.
 */
export type AgentMemoryIntentNoticeInput = AgentMemoryIntentAvailablePayload;

/** Exact request identity a host must echo to read back durable projection status. */
export type AgentHomeProjectionStatusInput = AgentHomeProjectionReceiptInput;

/** Task-free exact-device remote preparation request, intentionally unrelated to TaskAttempt. */
export type InputPreparationInput = AgentInputPreparationPayload;

/** Exact request identity a host must echo to read back durable preparation status. */
export type InputPreparationStatusInput = InputPreparationReceiptInput;

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

export interface EnqueuedInputPreparation extends EnqueuedAgentControl {
  readonly status: InputPreparationReadback;
}

/** Immutable executable offer authority, independent of mailbox retention. */
export interface TaskOfferReadback {
  readonly taskId: string;
  readonly deviceId: string;
  readonly messageId: string;
  readonly type: 'task.offer';
  readonly payload: TaskOfferPayload;
  /** Receipt time, not a transport delivery timestamp. */
  readonly recordedAt: string;
  /** The delivered marker is durable; false is not proof append never happened. */
  readonly delivered: boolean;
}

export interface EnqueuedOffer {
  readonly taskId: string;
  /** The per-(tenant, device) delivery seq — the daemon's redelivery cursor position for this envelope. */
  readonly seq: number;
  readonly envelope: Envelope;
  readonly attempt: TaskAttempt;
}

export interface ByokCloud {
  runMaintenance(input: MaintenanceInput): Promise<MaintenanceReport>;
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
  /**
   * Host control plane: enqueue a strict Agent resume offer to an explicit
   * device. Resume-only: the payload must carry `session.mode: 'resume'` with
   * an exact `sessionRef`, and one without it is refused with `coordination_input_invalid` before any attempt,
   * receipt or mailbox write. A fresh Agent execution is admitted only through
   * {@link ByokCloud.submitAgentExecution}.
   * Capability admission is read from the durable authenticated device row
   * before either the mailbox append or task-attempt open.
   */
  enqueueAgentOffer(tenant: TenantId, deviceId: string, input: AgentDispatchInput): Promise<EnqueuedOffer>;
  /**
   * Host control plane: enqueue an offer for an already-counted preparation.
   *
   * Admission requires the device to durably advertise both the Agent-home
   * contract and `agent-input-preparation-v9` — the second because only a device
   * that can prepare holds the durable record this offer names. A device that
   * advertises neither never receives the message. The offer is strict, so a
   * daemon that does not know `preparation` stops rather than running it as an
   * ordinary instruction offer.
   */
  enqueuePreparedOffer(
    tenant: TenantId,
    deviceId: string,
    input: PreparedDispatchInput,
  ): Promise<EnqueuedOffer>;
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
   * Submit one fresh Agent execution from the Host's persisted input.
   * A delivered taskId conflicts; recover through exact offer readback.
   */
  submitAgentExecution(tenant: TenantId, input: AgentExecutionInput): Promise<EnqueuedOffer>;
  /**
   * Sealed offer lanes (#654). Each sends the sealed branch of its plaintext
   * sibling's `task.offer` with the same rules, and needs every flag that
   * `requiredReceiverCapabilities` names for it, `sealed-payload-v1` among them.
   * The plaintext siblings refuse `sealing` and `sealed` with
   * `coordination_input_invalid`.
   */
  enqueueSealedAgentOffer(tenant: TenantId, deviceId: string, input: SealedAgentDispatchInput): Promise<EnqueuedOffer>;
  enqueueSealedAgentEgressOffer(tenant: TenantId, deviceId: string, input: SealedAgentEgressDispatchInput): Promise<EnqueuedOffer>;
  submitSealedAgentExecution(tenant: TenantId, input: SealedAgentExecutionInput): Promise<EnqueuedOffer>;
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
   * Durable, task-free remote input preparation for precisely one admitted
   * device. Capability admission, the immutable desired receipt and the
   * mailbox append happen in that order, so a refused call leaves NO receipt
   * and NO delivery row behind.
   */
  enqueueInputPreparation(
    tenant: TenantId,
    deviceId: string,
    input: InputPreparationInput,
  ): Promise<EnqueuedInputPreparation>;
  /**
   * Durable, task-free `provider.provisioning.available` notice for precisely
   * one device that durably advertised `provider-provisioning.v1`. The payload
   * is validated strictly before admission, and admission happens before the
   * mailbox append, so a refused call leaves no delivery row behind.
   *
   * Idempotent per (tenant, device, requestId): the mailbox message id is
   * derived from that identity, so a retried enqueue returns the existing row
   * and its seq instead of appending a second notice. The completion and its
   * durable readback are Host authority on Host routes; this plane records no
   * provisioning receipt of its own.
   */
  enqueueProviderProvisioningNotice(
    tenant: TenantId,
    deviceId: string,
    input: ProviderProvisioningNoticeInput,
  ): Promise<EnqueuedAgentControl>;
  /**
   * Durable, task-free `agent.memory.intent.available` notice for precisely
   * one device that durably advertised `agent-memory-intent.v1`. The payload
   * is validated strictly before admission, and admission happens before the
   * mailbox append, so a refused call leaves no delivery row behind.
   *
   * Idempotent per (tenant, device, intentId) while the original mailbox row
   * is retained: the mailbox message id is derived from that identity, so a
   * retried enqueue returns the existing row and its seq instead of appending
   * a second notice, and a retry naming a different `agentRef` for the same
   * intent fails `mailbox_receipt_mismatch`. After acked-row retention cleanup
   * a retry appends a new row with a new seq and `agentRef` is no longer
   * compared, so the Host must keep `agentRef` fixed per `intentId`. The
   * device fails closed (`fetch_invalid`/`readback_invalid`) on a mismatched
   * `agentId`, or on a mismatched `profileRevision` once its ledger row is
   * pruned; while the row is live it replays its stored completion without
   * comparing the notice's `profileRevision` (no memory write, no second CAS).
   * Approval, release, completion and readback are Host authority on Host
   * routes; this plane records no intent receipt of its own.
   */
  enqueueAgentMemoryIntentNotice(
    tenant: TenantId,
    deviceId: string,
    input: AgentMemoryIntentNoticeInput,
  ): Promise<EnqueuedAgentControl>;
  /**
   * Durable, task-free `e2ee.key_package.available` notice (#654 E2c-3) for
   * one device that durably advertised `sealed-payload-v1`; otherwise it
   * throws `agent_capability_missing` before the mailbox append. The payload
   * is exactly `{ scopeId, epoch }`; the device fetches the package from its
   * device route. Idempotent per (tenant, device, scopeId, epoch) while the
   * mailbox row is retained. `putScopeKeyPackages` calls it for every
   * recipient device that has the capability.
   */
  enqueueScopeKeyPackageNotice(
    tenant: TenantId,
    deviceId: string,
    input: E2eeKeyPackageAvailablePayload,
  ): Promise<EnqueuedAgentControl>;
  /** Tenant/device/request-bound durable desired-state and terminal-outcome readback. */
  getInputPreparationStatus(
    tenant: TenantId,
    deviceId: string,
    input: InputPreparationStatusInput,
  ): Promise<InputPreparationReadback | undefined>;
  /** Direct device completion endpoint authority; first exact terminal receipt wins. */
  completeInputPreparation(
    tenant: TenantId,
    deviceId: string,
    receipt: InputPreparationCompletionRequest,
  ): Promise<InputPreparationReadback>;
  /**
   * Server-side consent revocation and hosted projection erasure. It does not
   * depend on a device being online and never imports anything back locally.
   */
  eraseAgentMemoryProjection(tenant: TenantId, agentId: string): Promise<AgentMemoryProjectionEraseResult>;
  /**
   * Host control plane: replace the stored content of terminal tasks with
   * body-free tombstones (#654 E5a). Status, digests and identity fences stay,
   * so a replay is still a duplicate and new content is still a conflict.
   * Content reads of a redacted task throw `task_content_redacted`.
   * Each task is redacted on its own; a refused task can be retried.
   */
  redactTasks(tenant: TenantId, input: { readonly taskIds: readonly string[] }): Promise<TaskRedactionResult>;
  /**
   * Host control plane (#654 E2c): append signed member chain entries. First
   * writer wins per seq: an entry already stored with the same bytes is a
   * replay, and a different one throws `e2ee_member_chain_conflict`. The
   * first new entry must follow the stored head. The Host checks shapes and
   * the tenant only; members verify signatures and links.
   *
   * A newly stored `shred` entry, whose subject must be exactly `{ scopeId }`,
   * deletes that scope's key packages and epochs in the same write, marks the
   * scope shredded, and records an `e2ee-scope-shred:<scopeId>` receipt.
   * A newly stored `rotate` entry raises its member's KEM floor to its
   * `kemEpoch` in the same write; a floor never falls.
   */
  appendMemberChainEntries(
    tenant: TenantId,
    input: { readonly entries: readonly E2eeMemberChainEntry[] },
  ): Promise<{ readonly appended: number; readonly replayed: number }>;
  /** Host control plane: member chain entries after `afterSeq` (default 0), ascending, at most `limit` (default and maximum 256). */
  readMemberChain(
    tenant: TenantId,
    input?: { readonly afterSeq?: number; readonly limit?: number },
  ): Promise<{ readonly entries: readonly E2eeMemberChainEntry[] }>;
  /**
   * Host control plane: store version 2 scope key packages. The first package
   * of a scope epoch fixes its `keyId`; a package with another `keyId` throws
   * `e2ee_scope_key_conflict`, and the call stores nothing. A package of a
   * shredded scope throws `e2ee_scope_shredded`, and one whose
   * `recipientKemEpoch` is below its recipient's KEM floor throws
   * `e2ee_scope_key_package_stale`; either way the call stores nothing.
   *
   * After the commit, each recipient that is a registered device gets one
   * `e2ee.key_package.available` notice per scope epoch, also on a replay.
   * A recipient device without `sealed-payload-v1` gets no notice and is
   * listed in `skippedDeviceIds`; its packages are stored all the same.
   */
  putScopeKeyPackages(
    tenant: TenantId,
    input: { readonly packages: readonly z.infer<typeof E2eeScopeKeyPackageV2Schema>[] },
  ): Promise<{ readonly stored: number; readonly skippedDeviceIds: readonly string[] }>;
  /** Host control plane: the stored packages of one scope, optionally for one epoch or one recipient. */
  readScopeKeyPackages(
    tenant: TenantId,
    input: { readonly scopeId: string; readonly epoch?: number; readonly recipient?: string },
  ): Promise<{ readonly packages: readonly E2eeScopeKeyPackage[] }>;
  /**
   * Host control plane: the member key bundle an active device registered,
   * and its pairing MAC while the pairing window is open (§7.2 step 3).
   */
  readMemberKeyRegistration(
    tenant: TenantId,
    deviceId: string,
  ): Promise<{ readonly member: E2eeMemberKeyBundle; readonly deviceMac?: string } | undefined>;
  /** Host control plane: relay the client pairing MAC to a registered device (§7.2 step 4). */
  relayClientPairingMac(tenant: TenantId, deviceId: string, input: E2eeClientPairingMac): Promise<void>;
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
   *   3. the pending request has no `approvalId` (recorded before wire v4)
   *      -> `task_not_awaiting_approval`;
   *   4. `opts.approvalId` names an approval this task has already superseded
   *      -> {@link StaleApprovalError}.
   *
   * Delivery is a best-effort notification, the same contract the wire message
   * has always had (`TaskApprovePayloadSchema`, `@byok-sdk/protocol`): the
   * enqueued envelope is durable, the runtime's response to it is observable
   * only through that task's own later messages. The outgoing `approvalId` is
   * the pending request's id; `opts.approvalId` is only compared against it
   * (gate 4) and is never sent.
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
   * absent snapshot refuses. Gate order mirrors the old
   * reference server's `ConnectionHub.steerTask`, and every gate is evaluated
   * in full before a mailbox row is allocated, so a refused call has
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
    payload: { readonly text: string },
  ): Promise<EnqueuedAgentControl>;
  /**
   * The sealed lane of {@link steerTask} (#654): the sealed `task.steer`, with the
   * same gates in the same order, and then the device's durable
   * `sealed-payload-v1` (`agent_capability_missing`). `steerTask` refuses
   * `sealed` and `steerId`.
   */
  steerSealedTask(
    tenant: TenantId,
    taskId: string,
    payload: TaskSteerSealedPayload,
  ): Promise<EnqueuedAgentControl>;
  readTaskAttempt(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined>;
  /** Read the original executable offer; missing/corrupt authority never becomes a guessed payload. */
  readTaskOffer(tenant: TenantId, taskId: string): Promise<TaskOfferReadback | undefined>;
  /**
   * Host control plane: one bounded page of this tenant's task attempts,
   * keyset-paged by `taskId` — see {@link TaskAttemptListQuery} for why the key
   * is the task id and not a timestamp, and why the walk terminates on an
   * absent `nextCursor` rather than on an empty page.
   * `active: true` selects in-flight statuses without cancellation markers.
   *
   * A non-positive or non-integer `limit` is rejected
   * (`coordination_input_invalid`), never defaulted: the host names the bound.
   */
  listTaskAttempts(tenant: TenantId, query: TaskAttemptListQuery): Promise<TaskAttemptPage>;
  /** Store-aggregated task counts, with host cancellation separated from coarse status. */
  countTaskAttempts(tenant: TenantId): Promise<import('./stores/ports').TaskAttemptCounts>;
  /** The recorded terminal for a task — the first one, re-encoded canonically under the frozen v1 codec (see `recordTerminal`, `inbound.ts`: the stored body is `encodeEnvelope` of the zod-parsed envelope, not the device's original byte sequence). Throws `task_content_redacted` after {@link ByokCloud.redactTasks}. */
  readTerminalReceipt(tenant: TenantId, taskId: string): Promise<RequestReceipt | undefined>;
  /** Actual device terminal only; cancellation intent never creates this observation. */
  readDeviceTerminal(tenant: TenantId, taskId: string): Promise<DeviceTerminal | undefined>;
  /** Discover first-message transmission evidence from the frozen execution binding, including pending/held without a Host body. */
  readTaskAgentMessageDraft(tenant: TenantId, deviceId: string, taskId: string, agentRef: AgentRef, cursor?: AgentMessageDraftCursor): Promise<AgentMessageDraftReadback | undefined>;
  readTaskAgentMessage(tenant: TenantId, deviceId: string, taskId: string, agentRef: AgentRef): Promise<TaskAgentMessage | undefined>;
  /**
   * Exact durable message decision, independently of task cancellation/terminal.
   * Missing or pending admission returns undefined; invalid persisted evidence
   * throws. The Host supplies the complete original payload, not a Turn ID.
   */
  readAgentMessageDisposition(
    tenant: TenantId, deviceId: string, taskId: string, payload: AgentMessagePublishPayload,
  ): Promise<AgentMessageDispositionPayload | undefined>;

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
   * exists. An absent `document` means the winning terminal carried none (a
   * non-complete terminal, or an offer with no `result-document` terminal
   * projection); a
   * receipt whose body is not a terminal envelope throws rather than
   * returning a best-effort shape. After {@link ByokCloud.redactTasks} the
   * receipt read throws `task_content_redacted`; a Host cancellation still
   * returns `state: 'cancelled'`, with its reason cleared.
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
  if (options.mailboxWake === undefined) throw new TypeError('mailboxWake is required');
  const proofReceiptRetention = options.proofReceiptRetention === undefined ? undefined : resolveProofReceiptRetention(options.proofReceiptRetention);
  const declaration = parseDeclaration(options.capabilities);
  assertNoOverDeclaration(
    declaration,
    options.blobContentProxy,
    options.truthCommitter,
    options.truthObjectDownloads,
    options.skillPacks,
    options.agentMemoryProjectionAuthorizer,
    options.agentMemoryProjectionStore,
    options.e2eeMemberStore,
  );
  const root: CloudRootStores = { core: options.core, cloud: options.cloud, mailboxWake: options.mailboxWake };
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
    maxEvents: options.activityMaxEvents ?? DEFAULT_ACTIVITY_BOUNDS.maxEvents,
    maxBytes: options.activityMaxBytes ?? DEFAULT_ACTIVITY_BOUNDS.maxBytes,
    capacity: options.activityCapacity ?? DEFAULT_ACTIVITY_BOUNDS.capacity,
    ttlMs: options.activityTtlMs ?? DEFAULT_ACTIVITY_BOUNDS.ttlMs,
  };

  // Auth v2 (§6) — always mounted: without pairing there is no deployment.
  const limitPublic = (
    route: LimitedPublicRoute,
    handler: CloudRouteHandler,
  ): CloudRouteHandler => {
    const limiter = options.publicRouteLimiter;
    if (limiter === undefined) return handler;
    return async (c) => {
      if (!(await limiter(route, c.req.raw))) return c.json({ error: 'rate limit exceeded' }, 429);
      return handler(c);
    };
  };
  registry.register(
    { method: 'POST', path: BYOK_PAIR_PATH, class: 'public' },
    limitPublic({ method: 'POST', path: BYOK_PAIR_PATH }, pairHandler({ auth })),
  );
  registry.register(
    { method: 'POST', path: BYOK_CHALLENGE_PATH, class: 'public' },
    limitPublic({ method: 'POST', path: BYOK_CHALLENGE_PATH }, challengeHandler({ auth })),
  );
  registry.register(
    { method: 'POST', path: BYOK_TOKEN_PATH, class: 'public' },
    limitPublic({ method: 'POST', path: BYOK_TOKEN_PATH }, tokenHandler({ auth })),
  );

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
        activityBounds,
        longPollHoldMs: options.longPollHoldMs ?? DEFAULT_LONG_POLL_HOLD_MS,
        pageLimit: options.eventsPageLimit ?? DEFAULT_EVENTS_PAGE_LIMIT,
      }),
    );
  }

  if (declares(declaration, CLOUD_CAPABILITIES.messagesBatch)) {
    registry.register(
      { method: 'POST', path: BYOK_MESSAGES_PATH, class: 'device' },
      messagesHandler({
        ...deviceRouteDeps,
        clock: options.clock,
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

  // Unconditional, exactly like the Agent-home completion route above and for
  // the same reason: this is the DEVICE's only way to discharge a mailbox row
  // the same deployment already handed it. Gating it on the declaration would
  // let an under-declared deployment enqueue a preparation the device can then
  // never complete, freezing its redelivery cursor behind an envelope with no
  // terminal path. `CLOUD_CAPABILITIES.inputPreparation` still declares the
  // lane so a Host reads what this deployment serves instead of probing it.
  //
  // The same reasoning runs one level deeper: `completeInputPreparationFromStores`
  // asserts no DEVICE capability either, so a device that never advertised
  // `agent-input-preparation-v9` can still record the
  // `input_preparation_unconfigured` rejection the row requires. The device
  // capability stays the admission gate on `enqueueInputPreparation` alone.
  const inputPreparationRouteDeps = {
    ...deviceRouteDeps,
    complete: (stores: TenantStores, deviceId: string, receipt: InputPreparationCompletionRequest) =>
      completeInputPreparationFromStores(stores, deviceId, receipt),
    status: (stores: TenantStores, deviceId: string, input: InputPreparationStatusInput) =>
      readInputPreparationStatus(stores.receipts, stores.tenant, deviceId, input),
  };
  registry.register(
    { method: 'PUT', path: BYOK_INPUT_PREPARATION_COMPLETION_ROUTE, class: 'device' },
    inputPreparationCompletionHandler(inputPreparationRouteDeps),
  );
  registry.register(
    { method: 'GET', path: BYOK_INPUT_PREPARATION_STATUS_ROUTE, class: 'device' },
    inputPreparationStatusHandler(inputPreparationRouteDeps),
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

  if (options.e2eeMemberStore !== undefined && declares(declaration, CLOUD_CAPABILITIES.e2eeMember)) {
    const e2eeDeps = {
      proof: { devices: options.cloud.devices, crypto: options.crypto, clock: options.clock },
      device: deviceRouteDeps,
      context: (device: DevicePrincipal) => e2eeMemberContext(principalTenant(device)),
      maxRequestBytes: options.maxE2eeRequestBytes ?? DEFAULT_MAX_E2EE_REQUEST_BYTES,
    };
    registry.register({ method: 'POST', path: BYOK_E2EE_MEMBER_KEY_PATH, class: 'proof' }, e2eeMemberKeyRegisterHandler(e2eeDeps));
    registry.register({ method: 'POST', path: BYOK_E2EE_CHAIN_PATH, class: 'proof' }, e2eeMemberChainAppendHandler(e2eeDeps));
    registry.register({ method: 'POST', path: BYOK_E2EE_KEY_PACKAGES_PATH, class: 'proof' }, e2eeScopeKeyPackagePutHandler(e2eeDeps));
    registry.register({ method: 'GET', path: BYOK_E2EE_CHAIN_PATH, class: 'device' }, e2eeMemberChainReadHandler(e2eeDeps));
    registry.register({ method: 'GET', path: BYOK_E2EE_KEY_PACKAGES_PATH, class: 'device' }, e2eeScopeKeyPackageReadHandler(e2eeDeps));
    registry.register({ method: 'GET', path: BYOK_E2EE_PAIRING_MAC_PATH, class: 'device' }, e2eePairingMacReadHandler(e2eeDeps));
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
    agentRef: AgentRef,
    buildEnvelope: (taskId: string, seq: number, messageId: string) => Envelope,
    beforeMailbox?: (stores: TenantStores, taskId: string) => Promise<void>,
  ): Promise<EnqueuedOffer> {
    const stores = tenantStoresFor(controlPlane(tenant), root);
    const taskId = requestedTaskId ?? `task_${options.crypto.randomUuid()}`;
    const messageId = await taskOfferMessageId(tenant, taskId, deviceId, agentRef, bytes => options.crypto.sha256(bytes));
    const proposed = buildEnvelope(taskId, 0, messageId);
    await assertSealedCiphertext(tenant, proposed.payload);
    const selection = proposed.payload as { harnessId?: string; runtime?: string; dispatchSelection?: unknown };
    if (selection.harnessId !== undefined) {
      HarnessIdSchema.parse(selection.harnessId);
      if (selection.runtime !== undefined || selection.dispatchSelection !== undefined) throw new ByokCloudError('coordination_input_invalid', 'harnessId conflicts with built-in runtime selection');
      await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities(proposed.type, proposed.payload));
      const device = await options.cloud.devices.get(tenant, deviceId);
      if (!device?.harnesses?.some(harness => harness.id === selection.harnessId)) throw new ByokCloudError('coordination_input_invalid', 'requested custom harness is not advertised by this device');
    }
    // An attempt is the task authority, so reserve/open it BEFORE the offer is
    // observable in a mailbox.  The stable message identity then makes an
    // append failure retry converge on the one offer rather than allocating a
    // second executable body.
    const reservation = await stores.tasks.reserveAgentOffer({ taskId, deviceId, agentRef });
    const openedBeforeAppend = reservation.attempt;
    if (
      openedBeforeAppend.deviceId !== deviceId ||
      openedBeforeAppend.agentRef === undefined ||
      !sameAgentRef(agentRef, openedBeforeAppend.agentRef)
    ) {
      throw new ByokCloudError('agent_ref_mismatch', `Task ${taskId} already has a different durable target or Agent identity.`);
    }

    const offerReceiptKey = `task-offer:${messageId}`;
    const deliveryReceiptKey = `task-offer-delivered:${messageId}`;
    // The task id is the immutable execution identity for every offer kind.
    // This receipt outlives mailbox retention, so a completed or retired task
    // can never be made executable again by reusing the caller-supplied id. A
    // missing marker is the sole retryable state after a pre-delivery failure.
    if (
      (await stores.receipts.get(deliveryReceiptKey)) !== undefined
    ) {
      throw new ByokCloudError(
        'agent_task_already_exists',
        `Task ${taskId} already has a durable delivered attempt and cannot be enqueued again.`,
      );
    }

    // Reserve the immutable executable semantics before a fallible mailbox
    // append. The attempt intentionally contains no payload; this existing
    // idempotent receipt authority supplies the missing comparison so a retry
    // after append failure cannot silently replace an undelivered body.
    const proposedBody = JSON.stringify({
      deviceId,
      type: proposed.type,
      payload: proposed.payload,
    });
    const recorded = await stores.receipts.record({
      key: offerReceiptKey,
      body: proposedBody,
    });
    // A sealed retry may seal the same content again. When its comparison
    // projection matches, the first ciphertext stays the offer (§9.2).
    let build = buildEnvelope;
    let offerPayload: object = proposed.payload;
    if (!recorded.created && !(await sameTaskBody(recorded.receipt.body, proposedBody, options.crypto))) {
      const first = isSealedPayload(proposed.type, proposed.payload)
        ? firstSealedPayload(recorded.receipt.body, { deviceId, type: proposed.type, payload: proposed.payload })
        : undefined;
      if (first === undefined) {
        throw new ByokCloudError(
          'coordination_input_invalid',
          `Task ${taskId} already has a different executable offer body.`,
        );
      }
      build = (id, seq, message) => ({ ...buildEnvelope(id, seq, message), payload: first }) as Envelope;
      offerPayload = first;
    }

    await retainTaskCiphertext(tenant, taskId, offerPayload);
    await beforeMailbox?.(stores, taskId);
    // The attempt is already open, so a refused append must name it: a Host
    // that let cloud allocate the id has no other way to retry or cancel it.
    const message = await stores.mailbox.append({
      admission: 'limited',
      deviceId,
      messageId,
      materialize: async (seq) => {
        // Core stays protocol-free: the mailbox reserves the one authoritative
        // delivery number, then asks this producer to build opaque bytes while
        // allocation and insertion are still serialized per device.
        const envelope = build(taskId, seq, messageId);
        const body = encodeEnvelope(envelope);
        const bytes = new TextEncoder().encode(body);
        return {
          body,
          bodyHash: contentHash(await options.crypto.sha256(bytes)),
          byteSize: BigInt(bytes.length),
        };
      },
    }).catch((refusal: unknown) => {
      throw new TaskOfferAppendRefusedError(taskId, refusal);
    });
    const envelope = decodeEnvelope(message.body);
    if (envelope.seq !== message.seq) {
      throw new ByokCloudError(
        'mailbox_seq_mismatch',
        `Mailbox stored offer seq ${String(envelope.seq)} at row ${message.seq}; the daemon's redelivery cursor would be wrong.`,
      );
    }
    if (!sameOfferEnvelope(build(taskId, message.seq, messageId), envelope)) {
      throw new ByokCloudError(
        'coordination_input_invalid',
        `Task ${taskId} already has a different executable offer body.`,
      );
    }
    const delivered = await stores.receipts.record({ key: deliveryReceiptKey, body: messageId });
    if (!reservation.created && !delivered.created) {
      throw new ByokCloudError(
        'agent_task_already_exists',
        `Task ${taskId} already has a durable Agent attempt and cannot be enqueued again.`,
      );
    }
    return { taskId, seq: message.seq, envelope, attempt: openedBeforeAppend };
  }

  /** A sealed member above the inline limit names its ciphertext blob (#654); see {@link sealedCiphertextCommitted}. */
  async function assertSealedCiphertext(tenant: TenantId, payload: object): Promise<void> {
    const ref = sealedCiphertextRef(payload);
    if (ref !== undefined && !(await sealedCiphertextCommitted(tenantStoresFor(controlPlane(tenant), root).objects, ref))) {
      throw new ByokCloudError('coordination_input_invalid', 'A sealed ciphertextRef must name a committed object of this tenant with its size and content type.');
    }
  }

  async function retainTaskCiphertext(tenant: TenantId, taskId: string, payload: object): Promise<void> {
    const ref = sealedCiphertextRef(payload);
    if (ref !== undefined) await retainSealedCiphertext(tenantStoresFor(controlPlane(tenant), root).objects, taskId, ref);
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

  async function enqueueAgentControlEnvelope(
    tenant: TenantId,
    deviceId: string,
    messageId: string,
    buildEnvelope: (seq: number) => Envelope,
  ): Promise<EnqueuedAgentControl> {
    const stores = tenantStoresFor(controlPlane(tenant), root);
    const message = await stores.mailbox.append({
      admission: 'limited',
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
  ): Promise<
    | { readonly decision: 'approve'; readonly approvalId?: string }
    | { readonly decision: 'reject'; readonly approvalId?: string; readonly reason: string | null }
    | undefined
  > {
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
        if (entry.event.decision === 'reject') {
          return {
            decision: 'reject',
            ...(entry.event.approvalId === undefined ? {} : { approvalId: entry.event.approvalId }),
            reason: entry.event.reason,
          };
        }
        return {
          decision: 'approve',
          ...(entry.event.approvalId === undefined ? {} : { approvalId: entry.event.approvalId }),
        };
      }
    }
    return undefined;
  }

  /**
   * Wire v4 names every approval, so a decision cannot reach a request that
   * has no `approvalId`. Only a request recorded before v4 lacks one; the
   * upgrade drains those executions first.
   */
  function unnamedApproval(taskId: string, decision: 'approve' | 'reject'): ByokCloudError {
    return new ByokCloudError('task_not_awaiting_approval', `Task ${taskId} has no named pending approval to ${decision}.`);
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
          if (opts?.approvalId !== undefined && opts.approvalId !== recorded.approvalId) {
            throw new ByokCloudError(
              'coordination_input_invalid',
              `Task ${taskId} already has a host approval decision for a different approval.`,
            );
          }
          if (recorded.decision !== decision) {
            throw new ByokCloudError(
              'coordination_input_invalid',
              `Task ${taskId} already has the opposite host approval decision.`,
            );
          }
          if (recorded.decision === 'reject' && recorded.reason !== (opts?.reason ?? null)) {
            throw new ByokCloudError(
              'coordination_input_invalid',
              `Task ${taskId} already has a host rejection with a different immutable reason.`,
            );
          }
          const ownerDeviceId = attempt.ownerDeviceId;
          if (ownerDeviceId === undefined) {
            throw new ByokCloudError(
              'task_not_awaiting_approval',
              `Task ${taskId} has no owning device to receive its recorded ${decision}.`,
            );
          }
          if (recorded.approvalId === undefined) throw unnamedApproval(taskId, decision);
          const messageId = await approvalDecisionSource(tenant, taskId, attempt, latestRequest, decision);
          const targeting = { approvalId: recorded.approvalId };
          const recordedReason = recorded.decision === 'reject' ? recorded.reason : undefined;
          return enqueueAgentControlEnvelope(tenant, ownerDeviceId, messageId, (seq) =>
            decision === 'approve'
              ? createEnvelope('task.approve', targeting, { id: messageId, taskId, seq })
              : createEnvelope(
                  'task.reject',
                  { ...targeting, ...(recordedReason === null || recordedReason === undefined ? {} : { reason: recordedReason }) },
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
    if (pending.approvalId === undefined) throw unnamedApproval(taskId, decision);
    if (opts?.approvalId !== undefined && opts.approvalId !== pending.approvalId) {
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
    const approvalId = pending.approvalId;
    const messageId = await approvalDecisionSource(tenant, taskId, attempt, pending, decision);
    const event =
      decision === 'reject'
        ? {
            type: 'approval_resolved' as const,
            approvalId,
            decision: 'reject' as const,
            resolvedBy: 'host' as const,
            reason: opts?.reason ?? null,
            at: new Date().toISOString(),
          }
        : {
            type: 'approval_resolved' as const,
            approvalId,
            decision: 'approve' as const,
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
    let deliveredReason: string | null | undefined = decision === 'reject' ? opts?.reason ?? null : undefined;
    if (resolved.status === 'conflict' || resolved.status === 'superseded' || resolved.status === 'absent') {
      const currentTail = resolved.tail ?? (await stores.approvals.read(taskId));
      const currentPending = pendingApproval(currentTail);
      const recorded = await recordedHostDecision(tenant, taskId, attempt, currentTail, pending);
      if (recorded?.decision === decision) {
        // A concurrent identical resolver won first. Its event timestamp is
        // intentionally not a competing identity; the stable decision source
        // is, and mailbox append below replays that source exactly once.
        if (recorded.decision === 'reject') {
          if (recorded.reason !== deliveredReason) {
            throw new ByokCloudError(
              'coordination_input_invalid',
              `Task ${taskId} already has a host rejection with a different immutable reason.`,
            );
          }
          deliveredReason = recorded.reason;
        }
      } else if (recorded !== undefined) {
        throw new ByokCloudError(
          'coordination_input_invalid',
          `Task ${taskId} already has the opposite host approval decision.`,
        );
      } else if (
        currentPending !== undefined &&
        opts?.approvalId !== undefined &&
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
    const targeting = { approvalId };
    return enqueueAgentControlEnvelope(tenant, ownerDeviceId, messageId, (seq) =>
      decision === 'approve'
        ? createEnvelope('task.approve', targeting, { id: messageId, taskId, seq })
        : createEnvelope(
            'task.reject',
            { ...targeting, ...(deliveredReason === null || deliveredReason === undefined ? {} : { reason: deliveredReason }) },
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
    payload: { readonly text: string },
  ): Promise<EnqueuedAgentControl> {
    refuseSealedFields(payload, ['sealing', 'sealed', 'steerId'], 'steerSealedTask');
    const ownerDeviceId = await runningSteerTarget(tenant, taskId);
    const messageId = options.crypto.randomUuid();
    return enqueueAgentControlEnvelope(tenant, ownerDeviceId, messageId, (seq) =>
      createEnvelope('task.steer', { text: payload.text }, { id: messageId, taskId, seq }),
    );
  }

  /**
   * The two sealed enqueue lanes (#654). Each follows its plaintext sibling:
   * the resume check, the gates of the sealed `task.offer` and the same task
   * envelope path. The strict parse comes first, and every later step reads
   * that copy, so a caller that changes its object during an await cannot make
   * the checks and the enqueue see different payloads.
   */
  async function enqueueSealedTaskOffer(
    tenant: TenantId,
    deviceId: string,
    lane: typeof SealedAgentOfferLaneSchema | typeof SealedAgentEgressOfferLaneSchema,
    input: { readonly taskId?: string; readonly payload: object; readonly agentMessageContext?: AgentMessageServerContext },
  ): Promise<EnqueuedOffer> {
    const { taskId } = input;
    assertResumeSession(input.payload);
    const payload: TaskOfferSealedPayload = lane.parse(input.payload);
    // A sealed instruction binds the task id, so cloud cannot mint one for it.
    if (payload.sealed !== undefined && (typeof taskId !== 'string' || taskId === '')) {
      throw new ByokCloudError('coordination_input_invalid', 'a sealed instruction needs its taskId');
    }
    await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('task.offer', payload));
    return enqueueTaskEnvelope(
      tenant,
      deviceId,
      taskId,
      payload.agentRef,
      (id, seq, messageId) => createEnvelope('task.offer', payload, { id: messageId, taskId: id, seq }),
      payload.egressPolicy === undefined ? undefined : agentMessageOfferWriter(deviceId, payload, input.agentMessageContext),
    );
  }

  /** The sealed steer: the same gates, then the device flag. See {@link ByokCloud.steerSealedTask}. */
  async function steerSealedTask(
    tenant: TenantId,
    taskId: string,
    payload: TaskSteerSealedPayload,
  ): Promise<EnqueuedAgentControl> {
    const sealed = TaskSteerSealedPayloadSchema.parse(payload);
    const ownerDeviceId = await runningSteerTarget(tenant, taskId);
    await assertAgentCapabilities(tenant, ownerDeviceId, requiredReceiverCapabilities('task.steer', sealed));
    await assertSealedCiphertext(tenant, sealed);
    await retainTaskCiphertext(tenant, taskId, sealed);
    // One steer id names one steer: a retry finds the same mailbox row. A
    // retry that seals the same text again keeps the first ciphertext (§9.2).
    // Mailbox retention deletes an acknowledged row while the task runs, so a
    // later retry appends again. The device drops a steer id it has seen (12a).
    const messageId = uuidFromSha256(await options.crypto.sha256(
      new TextEncoder().encode(JSON.stringify({ domain: 'byok:task-steer-sealed', tenant, taskId, steerId: sealed.steerId })),
    ));
    const enqueued = await enqueueAgentControlEnvelope(tenant, ownerDeviceId, messageId, (seq) =>
      createEnvelope('task.steer', sealed, { id: messageId, taskId, seq }),
    );
    // A retry that names a new blob is a duplicate or a conflict. The stored
    // row keeps its own blob, so the task does not hold the new one.
    const proposedRef = sealedCiphertextRef(sealed);
    if (proposedRef !== undefined && sealedCiphertextRef(enqueued.envelope.payload)?.contentHash !== proposedRef.contentHash) {
      await releaseSealedCiphertext(tenantStoresFor(controlPlane(tenant), root).objects, taskId, proposedRef);
    }
    if (enqueued.envelope.type !== 'task.steer' || enqueued.envelope.payload.sealed === undefined
      || !sameSealedProjection(enqueued.envelope.payload, sealed)) {
      throw new ByokCloudError('coordination_input_invalid', `Task ${taskId} already has a different steer ${sealed.steerId}.`);
    }
    return enqueued;
  }

  /** The steer gates 1 to 4; returns the device that owns the running task. */
  async function runningSteerTarget(tenant: TenantId, taskId: string): Promise<string> {
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
    return ownerDeviceId;
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
    const readback = await recordAgentHomeProjectionCompletion(
      stores.receipts,
      stores.tenant,
      deviceId,
      receipt,
    );
    try { options.observer?.onAgentHomeProjectionCompleted?.(readback); } catch { /* Observers cannot change durable completion. */ }
    return readback;
  }

  async function getInputPreparationStatus(
    tenant: TenantId,
    deviceId: string,
    input: InputPreparationStatusInput,
  ): Promise<InputPreparationReadback | undefined> {
    return readInputPreparationStatus(
      tenantStoresFor(controlPlane(tenant), root).receipts,
      tenant,
      deviceId,
      input,
    );
  }

  async function completeInputPreparation(
    tenant: TenantId,
    deviceId: string,
    receiptInput: InputPreparationCompletionRequest,
  ): Promise<InputPreparationReadback> {
    return completeInputPreparationFromStores(
      tenantStoresFor(controlPlane(tenant), root),
      deviceId,
      receiptInput,
    );
  }

  /**
   * Deliberately NOT capability-gated, unlike `enqueueInputPreparation`.
   *
   * Admission is the enqueue's job: a device without
   * `agent-input-preparation-v9` is refused there, before any receipt or mailbox
   * row exists. Once a row DOES exist, the completion is the device's only way
   * to discharge it, and the daemon's redelivery cursor advances only when the
   * completion PUT succeeds. Re-asserting the capability here would reject
   * exactly the completion an unconfigured device must be able to record —
   * `input_preparation_unconfigured` — and freeze that device's strictly
   * seq-ordered cursor behind an envelope with no terminal path.
   *
   * Authority does not weaken: the row's own binding (authenticated device,
   * exact `AgentRef`, `profileId`, `policyRevision`) is checked by
   * `recordInputPreparationCompletion`, so a completion still cannot cross a
   * device, an Agent, or a policy revision. The one authority reduction this
   * does accept, stated plainly: revoking `agent-input-preparation-v9` after a row
   * is enqueued no longer refuses the in-flight completion — that row was
   * legitimately admitted, its receipt stays not-ready and G4 is closed to
   * activation — so revocation stops NEW admissions only.
   *
   * "The device can always discharge its row" holds only within ONE contract
   * version. The completion body is parsed with the strict receipt schema of
   * THIS build, and the relay wire carries no version, so a row admitted
   * before the v5 cut and completed by a device on the other side of it is
   * rejected (422) and stalls that device's cursor. That boundary is an
   * operator precondition — drain in-flight rows, then upgrade cloud and
   * devices as a pair (`docs/spec.md`, bounded admission) — not something this
   * route translates.
   */
  async function completeInputPreparationFromStores(
    stores: TenantStores,
    deviceId: string,
    receiptInput: InputPreparationCompletionRequest,
  ): Promise<InputPreparationReadback> {
    const receipt = InputPreparationCompletionRequestSchema.parse(receiptInput);
    return recordInputPreparationCompletion(stores.receipts, stores.tenant, deviceId, receipt);
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

  function e2eeMemberContext(tenant: TenantId): e2eeMember.E2eeMemberContext {
    const store = options.e2eeMemberStore;
    if (store === undefined) {
      throw new ByokCloudError('e2ee_member_store_unavailable', 'E2EE member storage is not configured for this deployment.');
    }
    return {
      store,
      tenant,
      devices: options.cloud.devices,
      now: () => options.clock.now(),
      enqueueKeyPackageNotice: (deviceId, payload) => enqueueScopeKeyPackageNotice(tenant, deviceId, payload),
    };
  }

  async function enqueueScopeKeyPackageNotice(
    tenant: TenantId,
    deviceId: string,
    input: E2eeKeyPackageAvailablePayload,
  ): Promise<EnqueuedAgentControl> {
    const payload = E2eeKeyPackageAvailablePayloadSchema.parse(input);
    await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('e2ee.key_package.available', payload));
    const messageId = uuidFromSha256(
      await options.crypto.sha256(
        new TextEncoder().encode(
          JSON.stringify({ domain: 'byok:e2ee-key-package-notice', tenant, deviceId, scopeId: payload.scopeId, epoch: payload.epoch }),
        ),
      ),
    );
    const control = await enqueueAgentControlEnvelope(tenant, deviceId, messageId, (seq) =>
      createEnvelope('e2ee.key_package.available', payload, { id: messageId, seq }),
    );
    if (
      control.envelope.type !== 'e2ee.key_package.available' ||
      control.envelope.payload.scopeId !== payload.scopeId ||
      control.envelope.payload.epoch !== payload.epoch
    ) {
      throw new ByokCloudError(
        'mailbox_receipt_mismatch',
        `Mailbox message ${messageId} does not carry the key package notice for scope ${payload.scopeId} epoch ${payload.epoch}.`,
      );
    }
    return control;
  }

  async function redactTasks(tenant: TenantId, input: { readonly taskIds: readonly string[] }): Promise<TaskRedactionResult> {
    const store = options.taskRedactionStore;
    if (store === undefined) {
      throw new ByokCloudError('task_redaction_unavailable', 'Task redaction is not configured for this deployment.');
    }
    const taskIds = parseTaskRedactionInput(input);
    const stores = tenantStoresFor(controlPlane(tenant), root);
    const codec = taskRedactionCodec(options.crypto);
    const tasks: TaskRedactionTaskResult[] = [];
    for (const taskId of taskIds) {
      const attempt = await stores.tasks.get(taskId);
      if (attempt === undefined) {
        tasks.push({ taskId, outcome: 'not_found' });
        continue;
      }
      const messageId = await taskOfferMessageId(tenant, taskId, attempt.deviceId, attempt.agentRef, bytes => options.crypto.sha256(bytes));
      tasks.push(await store.redactTask({
        tenantId: tenant,
        taskId,
        receiptKeys: [`task-offer:${messageId}`, terminalReceiptKey(taskId), `agent-message-offer:${attempt.deviceId}:${taskId}`],
        terminalReceiptKey: terminalReceiptKey(taskId),
        releaseObjectReferences: [{ refKind: SEALED_TASK_REFERENCE_KIND, refId: taskId }],
        auditReceiptKey: taskRedactionReceiptKey(taskId),
        codec,
      }));
    }
    return { tasks };
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
      admission: 'limited',
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
      admission: 'limited',
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
      admission: 'limited',
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

  function agentMessageOfferWriter(
    deviceId: string,
    payload: {
      agentRef: AgentRef;
      session: SessionSelection;
      messageEgress?: TaskOfferPayload['messageEgress'];
    },
    context: AgentMessageServerContext | undefined,
  ): ((stores: TenantStores, taskId: string) => Promise<void>) | undefined {
    if (payload.messageEgress === undefined) {
      if (context !== undefined) throw new Error('agentMessageContext requires messageEgress');
      return undefined;
    }
    const messageContext = AgentMessageServerContextSchema.parse(context);
    const body = JSON.stringify({
      agentRef: payload.agentRef,
      ...(payload.session.mode === 'resume' ? { sessionRef: payload.session.sessionRef } : {}),
      requirement: payload.messageEgress,
      context: messageContext,
    });
    return async (stores, taskId) => {
      const recorded = await stores.receipts.record({ key: `agent-message-offer:${deviceId}:${taskId}`, body });
      if (!recorded.created && !(await sameTaskBody(recorded.receipt.body, body, options.crypto))) {
        throw new ByokCloudError('agent_content_request_mismatch', `Task ${taskId} already has a different Agent message context.`);
      }
    };
  }

  async function submitAgentExecution(
    tenant: TenantId, input: AgentExecutionInput,
  ): Promise<EnqueuedOffer> {
    refuseSealedFields((input as { payload?: unknown } | undefined)?.payload, ['sealing', 'sealed'], 'submitSealedAgentExecution');
    return submitExecution(tenant, AgentExecutionInputSchema.parse(input));
  }

  async function submitSealedAgentExecution(
    tenant: TenantId, input: SealedAgentExecutionInput,
  ): Promise<EnqueuedOffer> {
    return submitExecution(tenant, SealedAgentExecutionInputSchema.parse(input));
  }

  /** One fresh Agent execution on the plaintext or the sealed lane; `validated` is the lane's parsed input. */
  async function submitExecution(
    tenant: TenantId,
    validated: AgentExecutionInput | SealedAgentExecutionInput,
  ): Promise<EnqueuedOffer> {
    const { deviceId, payload } = validated;
    if (payload.messageEgress !== undefined && typeof options.agentMessage?.consume !== 'function') {
      throw new Error('Agent execution with messageEgress requires a registered Agent message consumer.');
    }
    const beforeMailbox = agentMessageOfferWriter(deviceId, payload, validated.agentMessageContext);
    // Selection admission comes from WIRE_ADDITIONS via requiredReceiverCapabilities
    // (dispatch-selection / toolset-selection). Refuse a mismatched runtime before
    // any attempt, receipt or mailbox write.
    if (payload.dispatchSelection !== undefined && payload.runtime !== payload.dispatchSelection.runtimeId) {
      throw new ByokCloudError(
        'coordination_input_invalid',
        `Agent execution runtime ${payload.runtime} does not match dispatchSelection.runtimeId ${payload.dispatchSelection.runtimeId}.`,
      );
    }
    await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('task.offer', payload));
    const enqueued = await enqueueTaskEnvelope(
      tenant,
      deviceId,
      validated.taskId,
      payload.agentRef,
      (taskId, seq, messageId) => createEnvelope('task.offer', payload, { id: messageId, taskId, seq }),
      beforeMailbox,
    );
    return enqueued;
  }

  const maintenanceApi = createMaintenanceApi({ options, proofReceiptRetention });

  const offersApi = createOffersApi({
    assertAgentCapabilities,
    refuseSealedFields,
    assertResumeSession,
    AgentOfferLaneSchema,
    PreparedOfferLaneSchema,
    AgentEgressOfferLaneSchema,
    enqueueTaskEnvelope,
    agentMessageOfferWriter,
  });

  const agentControlsApi = createAgentControlsApi({
    root,
    controlPlane,
    options,
    assertAgentCapabilities,
    enqueueAgentControlEnvelope,
    agentControlEnvelopeId,
    getAgentHomeProjectionStatus,
    getInputPreparationStatus,
  });

  const e2eeApi = createE2eeApi({ e2eeMemberContext });

  const taskCancellationApi = createTaskCancellationApi({ root, controlPlane, options });

  const taskReadsApi = createTaskReadsApi({ root, controlPlane, options, sameAgentRef });

  const tenantApi = createTenantApi({ root, controlPlane, options });

  return {
    runMaintenance: maintenanceApi.runMaintenance,
    fetch: registry.fetch,
    routes: registry.routes,
    mountedRoutes: registry.mounted,
    capabilities: declaration,

    createPairingCode(tenant, input) {
      return auth.createPairingCode(tenant, input);
    },

    enqueueAgentOffer: offersApi.enqueueAgentOffer,

    enqueuePreparedOffer: offersApi.enqueuePreparedOffer,

    enqueueAgentEgressOffer: offersApi.enqueueAgentEgressOffer,

    submitAgentExecution,

    enqueueSealedAgentOffer: (tenant, deviceId, input) => enqueueSealedTaskOffer(tenant, deviceId, SealedAgentOfferLaneSchema, input),
    enqueueSealedAgentEgressOffer: (tenant, deviceId, input) => enqueueSealedTaskOffer(tenant, deviceId, SealedAgentEgressOfferLaneSchema, input),
    submitSealedAgentExecution,

    enqueueAgentContentRead: agentControlsApi.enqueueAgentContentRead,

    enqueueAgentHomeProjection: agentControlsApi.enqueueAgentHomeProjection,

    getAgentHomeProjectionStatus,

    completeAgentHomeProjection,

    enqueueInputPreparation: agentControlsApi.enqueueInputPreparation,

    getInputPreparationStatus,

    enqueueProviderProvisioningNotice: agentControlsApi.enqueueProviderProvisioningNotice,

    enqueueAgentMemoryIntentNotice: agentControlsApi.enqueueAgentMemoryIntentNotice,

    completeInputPreparation,
    eraseAgentMemoryProjection,
    redactTasks,

    appendMemberChainEntries: e2eeApi.appendMemberChainEntries,
    readMemberChain: e2eeApi.readMemberChain,
    putScopeKeyPackages: e2eeApi.putScopeKeyPackages,
    enqueueScopeKeyPackageNotice,
    readScopeKeyPackages: e2eeApi.readScopeKeyPackages,
    readMemberKeyRegistration: e2eeApi.readMemberKeyRegistration,
    relayClientPairingMac: e2eeApi.relayClientPairingMac,

    approveTask(tenant, taskId, opts) {
      return resolveApproval(tenant, taskId, 'approve', opts);
    },

    rejectTask(tenant, taskId, opts) {
      return resolveApproval(tenant, taskId, 'reject', opts);
    },

    steerTask,
    steerSealedTask,

    cancelTask: taskCancellationApi.cancelTask,

    readTaskOffer: taskReadsApi.readTaskOffer,

    readTaskAttempt: taskReadsApi.readTaskAttempt,

    listTaskAttempts: taskReadsApi.listTaskAttempts,

    countTaskAttempts: taskReadsApi.countTaskAttempts,

    readTerminalReceipt: taskReadsApi.readTerminalReceipt,

    readDeviceTerminal: taskReadsApi.readDeviceTerminal,

    readTaskAgentMessageDraft: taskReadsApi.readTaskAgentMessageDraft,
    readTaskAgentMessage: taskReadsApi.readTaskAgentMessage,

    readAgentMessageDisposition: taskReadsApi.readAgentMessageDisposition,

    readAgentEgress: taskReadsApi.readAgentEgress,

    readTaskResult: taskReadsApi.readTaskResult,

    listDevices: tenantApi.listDevices,

    revokeDevice: tenantApi.revokeDevice,

    createBoardItem: tenantApi.createBoardItem,

    listBoardItems: tenantApi.listBoardItems,

    acceptBoardItem: tenantApi.acceptBoardItem,

    listPresence: tenantApi.listPresence,

    readTenantReadiness: tenantApi.readTenantReadiness,

    readActivity: taskReadsApi.readActivity,

    readApprovalTimeline: taskReadsApi.readApprovalTimeline,
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
  e2eeMemberStore: E2eeMemberStore | undefined,
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
  if (e2eeMemberStore === undefined && declares(declaration, CLOUD_CAPABILITIES.e2eeMember)) {
    throw new ByokCloudError(
      'capability_over_declared',
      `This deployment declares ${CLOUD_CAPABILITIES.e2eeMember} but was given no E2eeMemberStore, so the /byok/e2ee routes would be published and unserved.`,
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
