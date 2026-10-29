import { createTenantApi } from './api/tenant';
import { createTaskReadsApi } from './api/task-reads';
import { createTaskCancellationApi } from './api/task-cancellation';
import { createE2eeApi } from './api/e2ee';
import { createAgentControlsApi } from './api/agent-controls';
import { createOffersApi } from './api/offers';
import { createMaintenanceApi } from './api/maintenance';
import { createAgentExecutionsApi } from './api/agent-executions';
import { createAgentMemoryApi } from './api/agent-memory';
import { createApprovalsApi } from './api/approvals';
import { createEnqueuePaths, sameAgentRef } from './api/enqueue';
import { createProjectionReceiptsApi } from './api/projection-receipts';
import { createSteeringApi } from './api/steering';
import { createTaskRedactionsApi } from './api/task-redactions';
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
  type AgentExecutionInput,
  type SealedAgentExecutionInput,
} from './agent-execution';
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
import type { StaleApprovalError } from './approval-control';
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
  type Envelope,
  type AgentEgressPolicy,
  type InputPreparationOfferBinding,
  type SessionSelection,
  type TaskOfferPayload,
  type TaskOfferPlainPayload,
  type TaskOfferSealedPayload,
  type AgentRef,
  type AgentContentReadPayload,
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
  type AgentMemoryProjectionEraseResult,
  type TaskSteerSealedPayload,
  type E2eeClientPairingMac,
  type E2eeKeyPackageAvailablePayload,
  type E2eeMemberChainEntry,
  type E2eeMemberKeyBundle,
  type E2eeScopeKeyPackage,
  type E2eeScopeKeyPackageV2Schema,
} from '@byok-sdk/protocol';
import type { SteerRejectedError } from './steer-control';
import { createAuthPlane, type AuthPlane } from './auth/plane';
import type { TokenSigner } from './auth/tokens';
import { CAPABILITY_PORTS, CLOUD_CAPABILITIES, declares, type CapabilityPorts, type CloudCapability } from './capabilities';
import {
  DEFAULT_ACTIVITY_BOUNDS,
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
import { readAgentMessageDisposition, type ByokCloudObserver } from './inbound';
import {
  type AgentHomeProjectionReceiptInput,
} from './agent-home-projections';
import {
  readInputPreparationStatus,
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
} from './stores/ports';
import { type DeviceTerminal, type TerminalResult } from './terminal-result';
import type { MailboxWake } from './mailbox-wake';
import {
  type TaskRedactionResult,
  type TaskRedactionStore,
} from './task-redaction';
import { type CloudRootStores, type TenantStores } from './tenant-stores';
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

export interface ByokCloudOptions {
  readonly deviceAssertionReplay?: DeviceAssertionReplayAuthority;
  /**
   * Prunes used device-proof request ids in maintenance (#1120). Required: a
   * deployment cannot keep every used `requestId` forever.
   */
  readonly proofReceiptRetention: ProofReceiptRetentionOptions;
  readonly mailboxWake: MailboxWake;
  readonly core: CoreStores;
  readonly cloud: CloudStores;
  /**
   * Byte proxying for the two `/byok/blobs/:id/content` routes. OPTIONAL, and
   * absent is a first-class answer: a composition backed by object storage
   * hands the device a presigned URL to the object store and never carries a
   * byte, so it has nothing to supply here. Supplied exactly when the
   * deployment declares `blobs.contentproxy` (ADR-010); either without the
   * other is refused at construction.
   */
  readonly blobContentProxy?: BlobContentProxy;
  /** Atomic proof receipt + truth/reference/accounting authority for S6 routes. */
  readonly truthCommitter?: TruthCommitter;
  /** Content-hash keyed object GET grants for object-backed truth bodies. */
  readonly truthObjectDownloads?: TruthObjectDownloads;
  /**
   * Tenant-scoped skill pack catalogue. OPTIONAL, and absent is a first-class
   * answer: a deployment that distributes no declarative content supplies
   * nothing here and declares no `skills.pack`. Supplied exactly when the
   * deployment declares the capability (ADR-010), like the byte proxy above.
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
  const proofReceiptRetention = resolveProofReceiptRetention(options.proofReceiptRetention);
  const declaration = parseDeclaration(options.capabilities);
  assertDeclarationMatchesPorts(declaration, options);
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

  const operatorId = options.operatorId ?? 'host';

  function controlPlane(tenant: TenantId): ControlPlanePrincipal {
    return { kind: 'control-plane', tenantId: tenant, operatorId };
  }

  const enqueue = createEnqueuePaths({ root, controlPlane, options });

  const maintenanceApi = createMaintenanceApi({ options, proofReceiptRetention });

  const offersApi = createOffersApi(enqueue);

  const agentExecutionsApi = createAgentExecutionsApi({ options, ...enqueue });

  const projectionReceiptsApi = createProjectionReceiptsApi({
    root,
    controlPlane,
    options,
    ...enqueue,
    agentHomeContractCapability: AGENT_HOME_CONTRACT_CAPABILITY,
  });

  const agentControlsApi = createAgentControlsApi({
    root,
    controlPlane,
    options,
    ...enqueue,
    getAgentHomeProjectionStatus: projectionReceiptsApi.getAgentHomeProjectionStatus,
    getInputPreparationStatus: projectionReceiptsApi.getInputPreparationStatus,
  });

  const agentMemoryApi = createAgentMemoryApi({ options });

  const e2eeApi = createE2eeApi({ options, ...enqueue });

  const approvalsApi = createApprovalsApi({ root, controlPlane, options, ...enqueue });

  const steeringApi = createSteeringApi({ root, controlPlane, options, ...enqueue });

  const taskCancellationApi = createTaskCancellationApi({ root, controlPlane, options });

  const taskReadsApi = createTaskReadsApi({ root, controlPlane, options, sameAgentRef });

  const taskRedactionsApi = createTaskRedactionsApi({ root, controlPlane, options });

  const tenantApi = createTenantApi({ root, controlPlane, options });

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
          agentMemoryApi.commitAgentMemoryProjectionFromStores(stores, deviceId, mutation, redactedBytes),
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
        appendReliableEgressAck: enqueue.enqueueReliableEgressAck,
        appendContentReceiptAck: enqueue.enqueueContentReceiptAck,
        agentMessage: options.agentMessage,
        appendAgentMessageDisposition: enqueue.enqueueAgentMessageDisposition,
        observer: options.observer,
      }),
    );
  }

  registry.register(
    { method: 'PUT', path: BYOK_AGENT_HOME_PROJECTION_COMPLETION_ROUTE, class: 'device' },
    agentHomeProjectionCompletionHandler({
      ...deviceRouteDeps,
      complete: (stores, deviceId, receipt) => projectionReceiptsApi.completeAgentHomeProjectionFromStores(stores, deviceId, receipt),
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
      projectionReceiptsApi.completeInputPreparationFromStores(stores, deviceId, receipt),
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
      context: (device: DevicePrincipal) => e2eeApi.e2eeMemberContext(principalTenant(device)),
      maxRequestBytes: options.maxE2eeRequestBytes ?? DEFAULT_MAX_E2EE_REQUEST_BYTES,
    };
    registry.register({ method: 'POST', path: BYOK_E2EE_MEMBER_KEY_PATH, class: 'proof' }, e2eeMemberKeyRegisterHandler(e2eeDeps));
    registry.register({ method: 'POST', path: BYOK_E2EE_CHAIN_PATH, class: 'proof' }, e2eeMemberChainAppendHandler(e2eeDeps));
    registry.register({ method: 'POST', path: BYOK_E2EE_KEY_PACKAGES_PATH, class: 'proof' }, e2eeScopeKeyPackagePutHandler(e2eeDeps));
    registry.register({ method: 'GET', path: BYOK_E2EE_CHAIN_PATH, class: 'device' }, e2eeMemberChainReadHandler(e2eeDeps));
    registry.register({ method: 'GET', path: BYOK_E2EE_KEY_PACKAGES_PATH, class: 'device' }, e2eeScopeKeyPackageReadHandler(e2eeDeps));
    registry.register({ method: 'GET', path: BYOK_E2EE_PAIRING_MAC_PATH, class: 'device' }, e2eePairingMacReadHandler(e2eeDeps));
  }

  // Skill packs: the store and the declaration come together; either without
  // the other is refused at construction (`assertDeclarationMatchesPorts`).
  const skillPacks = options.skillPacks;
  if (skillPacks !== undefined && declares(declaration, CLOUD_CAPABILITIES.skillPacks)) {
    const skillPackDeps = {
      ...deviceRouteDeps,
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

  // Byte proxying: the proxy and `blobs.contentproxy` come together. There is
  // no third state: a composition either carries bytes or it does not.
  //
  // DECLARED WITHOUT A PROXY is fatal, above. A declaration is the ONE thing a
  // client is entitled to trust without probing (ADR-010), so a deployment
  // publishing `blobs.contentproxy` it cannot serve does not degrade to "two
  // missing routes" — it tells every client something false and then answers
  // 404 to the client that believed it.
  //
  // SUPPLIED WITHOUT A DECLARATION is fatal too (#1096): the proxy would never
  // be mounted, so the host wired a port that silently does nothing. A host
  // that withholds the capability stops passing the proxy.
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

    submitAgentExecution: agentExecutionsApi.submitAgentExecution,

    enqueueSealedAgentOffer: offersApi.enqueueSealedAgentOffer,
    enqueueSealedAgentEgressOffer: offersApi.enqueueSealedAgentEgressOffer,
    submitSealedAgentExecution: agentExecutionsApi.submitSealedAgentExecution,

    enqueueAgentContentRead: agentControlsApi.enqueueAgentContentRead,

    enqueueAgentHomeProjection: agentControlsApi.enqueueAgentHomeProjection,

    getAgentHomeProjectionStatus: projectionReceiptsApi.getAgentHomeProjectionStatus,

    completeAgentHomeProjection: projectionReceiptsApi.completeAgentHomeProjection,

    enqueueInputPreparation: agentControlsApi.enqueueInputPreparation,

    getInputPreparationStatus: projectionReceiptsApi.getInputPreparationStatus,

    enqueueProviderProvisioningNotice: agentControlsApi.enqueueProviderProvisioningNotice,

    enqueueAgentMemoryIntentNotice: agentControlsApi.enqueueAgentMemoryIntentNotice,

    completeInputPreparation: projectionReceiptsApi.completeInputPreparation,
    eraseAgentMemoryProjection: agentMemoryApi.eraseAgentMemoryProjection,
    redactTasks: taskRedactionsApi.redactTasks,

    appendMemberChainEntries: e2eeApi.appendMemberChainEntries,
    readMemberChain: e2eeApi.readMemberChain,
    putScopeKeyPackages: e2eeApi.putScopeKeyPackages,
    enqueueScopeKeyPackageNotice: e2eeApi.enqueueScopeKeyPackageNotice,
    readScopeKeyPackages: e2eeApi.readScopeKeyPackages,
    readMemberKeyRegistration: e2eeApi.readMemberKeyRegistration,
    relayClientPairingMac: e2eeApi.relayClientPairingMac,

    approveTask: approvalsApi.approveTask,

    rejectTask: approvalsApi.rejectTask,

    steerTask: steeringApi.steerTask,
    steerSealedTask: steeringApi.steerSealedTask,

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
 * Fail closed when the declaration and this composition's ports disagree, in
 * either direction (#1096).
 *
 * Route mounting alone cannot enforce this: `GET /byok/capabilities` serves the
 * declaration verbatim and is mounted unconditionally, so a deployment that
 * declares `blobs.contentproxy` without a proxy publishes the capability and
 * 404s both routes. Refusing at construction is the only placement where the
 * deployment cannot exist in that state — the alternative, sanitizing the
 * declaration down to what got mounted, would make the running surface a second
 * authority over what the host said it was deploying. A port passed without its
 * capability is refused for the same reason seen from the other side: it would
 * never be mounted, so the host would wire a store and then see 404s.
 */
function assertDeclarationMatchesPorts(declaration: CapabilityDeclaration, ports: CapabilityPorts): void {
  if (
    declares(declaration, CLOUD_CAPABILITIES.boardSse) &&
    !declares(declaration, CLOUD_CAPABILITIES.boardCoordination)
  ) {
    throw new ByokCloudError(
      'capability_over_declared',
      `${CLOUD_CAPABILITIES.boardSse} requires ${CLOUD_CAPABILITIES.boardCoordination}; without polling, reconciliation and declared fallback cannot be served.`,
    );
  }
  const undeclared: string[] = [];
  for (const [capability, names] of Object.entries(CAPABILITY_PORTS) as [CloudCapability, readonly (keyof CapabilityPorts)[]][]) {
    if (declares(declaration, capability)) {
      const missing = names.filter((name) => ports[name] === undefined);
      if (missing.length > 0) {
        throw new ByokCloudError(
          'capability_over_declared',
          `This deployment declares ${capability} but was given no ${missing.join(' or ')}, so its routes would be published and unserved.`,
        );
      }
    } else {
      for (const name of names) if (ports[name] !== undefined) undeclared.push(`${name} (${capability})`);
    }
  }
  if (undeclared.length > 0) {
    throw new ByokCloudError(
      'capability_port_undeclared',
      `This deployment was given ${undeclared.join(', ')} without declaring the capability; declare it or stop passing the port.`,
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
