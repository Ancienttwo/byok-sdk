import {
  DEVICE_ASSERTION_AUDIENCE_MAX_BYTES,
  DEVICE_ASSERTION_DEFAULT_TTL_MS,
  DEVICE_ASSERTION_MAX_TTL_MS,
} from '@byok-sdk/core';
import path from 'node:path';
import {
  createEnvelope,
  encodeEnvelope,
  PROTOCOL_VERSION,
  TASK_TRANSITIONS,
  AGENT_EGRESS_POLICY_CAPABILITY,
  AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
  AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
  AgentContentReceiptPayloadSchema,
} from '@byok-sdk/protocol';
import type {
  AgentEgressPolicy,
  AgentEgressReliablePayload,
  CapabilityFlag,
  ContentReadPolicy,
  Envelope,
  RuntimeId,
  RuntimeInfo,
} from '@byok-sdk/protocol';
import type { PermissionPolicy } from '@byok-sdk/protocol';
import type {
  RuntimeAdapter,
  GitWorkspaceConfig,
  McpToolsetConfig,
  McpToolsetObservation,
  McpToolsetRegistryStatus,
  McpToolsetReloadReceipt,
} from '../types';
import {
  AgentHomeLeaseManager,
  AgentHomeManager,
  stableAgentHomeOwnerId,
  type AgentHomeProjection,
} from '../agent-home';
import type { AgentRef } from '../agent-home';
import {
  resolveLocalAgentReleaseIdentity,
  type LocalAgentReleaseIdentity,
} from '../release-identity';
import { PiAdapter, validatePiByokLauncherConfig } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { ApprovalNotFoundError, ApprovalRegistry } from './approvals';
import { AuthManager } from './auth-manager';
import { BlobClient } from './blob-client';
import { declares, fetchCapabilityDeclaration, PRESENCE_HINTS_CAPABILITY } from './capabilities-client';
import {
  assertPresenceHeartbeatCadence,
  DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS,
  DEFAULT_PRESENCE_TTL_MS,
  PresencePublisher,
} from './presence-publisher';
import { assertServerUrlAllowed, toHttpBase } from './url';
import { mintDeviceAssertion } from './device-assertion-signer';
import type { BackoffOptions, ConnectionState, LivenessOptions } from './ws-transport';
import { AnotherControlServerRunningError, startControlServer } from './control-server';
import type { ControlMethods, ControlServerHandle } from './control-server';
import {
  ControlError,
  parseApprovalsRequestParams,
  parseApprovalsResolveParams,
  parseAssertionIssueParams,
  parseShutdownParams,
  parseToolsetsReloadParams,
  type AssertionIssueResult,
  type ControlActiveTask,
  type ControlStatusResult,
  type ControlStorageStatus,
  type ShutdownReason,
} from './control-protocol';
import { McpToolsetRegistry, McpToolsetRevisionConflictError } from './toolset-registry';
import { ConnectionManager } from './connection-manager';
import { createFleetJitter, type FleetJitter } from './deterministic-jitter';
import { OperationalHealthTracker, type OperationalHealthSnapshot } from './operational-health';
import { acquireDaemonOwner, type DaemonOwnerLease } from './daemon-owner';
import { toRuntimeInfoCapabilities } from './runtime-capabilities';
import { CursorStore } from './cursor-store';
import { DaemonObserver, type DaemonEventListener, type DaemonTaskInfo, type Unsubscribe } from './observer';
import { SessionWorkspaceStore } from './session-workspace-store';
import { AgentSessionHandoffStore } from './agent-session-handoff-store';
import { GitWorkspaceManager, stableGitWorkspaceOwnerId } from './git-workspace';
import { GitWorkspaceStore } from './git-workspace-store';
import { DeviceRecordRePairRequiredError, DeviceStore, type DeviceRecord } from './store';
import { JournalUnavailableError, journalHash, type JournalIdentity, type LocalTaskJournal, type ReceivedEnvelopeRecord, type StorageCategory } from './journal/journal';
import { JournalHandleCleanupError, SqliteLocalTaskJournal } from './journal/sqlite-journal';
import { isSqliteAvailable, type JournalOpenFaultSeam } from './journal/sqlite-support';
import {
  createFilesystemCleanupExecutor,
  createStatfsFreeBytesProvider,
  LocalStoragePressureEngine,
  resolveLocalStoragePolicy,
  type LocalStoragePolicy,
  type LocalStoragePolicyInput,
} from './journal/storage-policy';
import {
  DEFAULT_MAX_TASK_OUTPUT_BYTES,
  TaskRunner,
  type ResultDocumentExtractor,
  type TaskRunnerDeps,
} from './task-runner';
import {
  validateProgressBatcherOptions,
  type ProgressBatcherOptions,
} from './progress-batcher';
import { AgentEgressController, type AgentEgressReliableAppendResult } from './agent-egress-controller';
import { resolveAgentEgressPolicy, type AgentEgressStatus } from './agent-egress-policy';
import { sanitizeEgressEnvelope, type AgentEgressSanitizer } from './agent-egress-sanitizer';
import type { AgentContentReceiptWithoutReliableIdentity, AgentReliableEgressRecord } from './agent-egress-spool';
import { AgentContentAuditStore } from './agent-content-audit-store';
import {
  AGENT_CONTENT_READ_CAPABILITIES,
  AgentContentReadPolicyEngine,
  createAgentContentReadPolicy,
  type AgentContentReadPolicy,
  type AgentContentReadPolicySelection,
  type AgentContentReadRoot,
  type AgentContentReadSurface,
  type AgentContentSessionIdentity,
} from './agent-content-read';

/**
 * M4 Phase 2 (originally control-socket-only). M5 batch-3 (workstream 2):
 * now the shared DEFAULT for every graceful-shutdown path via
 * `runShutdownSequence` — overridable per-daemon via
 * `DaemonConfig.shutdownGraceMs`. Bound on how long the graceful-shutdown
 * sequence waits for `TaskRunner.shutdownActiveTasks` before proceeding to
 * the rest of teardown regardless — an active task's `session.interrupt()`
 * hanging (a misbehaving runtime adapter) must never block the daemon from
 * actually stopping.
 */
const SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS = 10_000;

/** Finding F5(b): default bound on how long `performControlShutdown` waits for the outbox to actually drain before closing the connection — see `ConnectionManager.stop`'s own doc comment. Overridable via `DaemonOverrides.shutdown.outboxDrainTimeoutMs`. */
const DEFAULT_SHUTDOWN_OUTBOX_DRAIN_TIMEOUT_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Optional white-label product display info — purely opaque passthrough
 * (never interpreted, validated, or rendered by the daemon itself). Carried
 * through to `DaemonStatus.branding` (see `status()` below) so a downstream
 * CLI or audit log can render/stamp product identity without the daemon
 * needing to know anything about presentation. Deliberately a small,
 * open-ish shape rather than an exhaustive theming schema — add fields here
 * only as concrete consumers (CLI UX, audit log) need them.
 */
export interface DaemonBranding {
  /** Product/company name for banners, prompts, audit log entries, etc. */
  displayName?: string;
  /** Support/help URL surfaced alongside branding. */
  supportUrl?: string;
  /** Brand accent color (any CSS-color-like string — hex, name, etc.); not parsed or validated here. */
  accent?: string;
}

/**
 * S3b (L-002): opt-in durable local journal for hosted deployments
 * (architecture §12.7.2).
 *
 * Explicit and off by default, because it changes what an ack MEANS. With no
 * journal configured (the self-hosted default this SDK has always shipped),
 * the daemon's redelivery cursor advances on handler success exactly as
 * before. With one configured, every inbound envelope is committed and fsynced
 * to `<storeDir>/daemon.db` BEFORE the handler resolves — and since
 * `ConnectionManager` only advances the cursor once the handler resolves
 * (`connection-manager.ts`), acking before committing stops being something
 * this daemon can express, rather than something it is careful not to do.
 *
 * Turning this on when the runtime has no working `node:sqlite` is a typed
 * construction failure, not a downgrade to a file journal — see
 * `JournalUnavailableError`. That refusal is the point (§12.7.2): a journal
 * that does not fsync loses tasks only under power-cut timings, so it passes
 * every test anyone will ever run against it.
 */
export interface HostedJournalConfig {
  /**
   * The backend. Only `sqlite` today, and spelled out rather than implied by
   * the section's presence so adding a second one later is an additive change
   * to a closed set instead of a re-interpretation of an existing config.
   */
  mode: 'sqlite';
  /** Bound on waiting for the journal's write lock, ms. Defaults to the journal's own bound. */
  busyTimeoutMs?: number;
  /** Per-record byte bound. Defaults to the journal's own bound; oversized records are refused, never truncated. */
  maxRecordBytes?: number;
  /**
   * S3b (L-003): opt-in local storage policy — §12.7.2.1's watermarks,
   * classified GC, and bounded WAL compaction. See `LocalStoragePolicyInput`
   * (`journal/storage-policy.ts`); `maxStoreBytes` and `minFreeBytes` are the
   * only two a host must supply.
   *
   * Optional WITHIN hosted journal mode, and off by default there too: a
   * journal without a policy is a daemon that records durably and never
   * declines, which is exactly the right behaviour on a host that manages its
   * own disk. Setting it is what turns local storage into an admission-control
   * input — hard pressure declines new offers (retryably) while terminal
   * flush, delete, export and recovery keep running, and `emergency` refuses
   * to ack at all rather than acking a row it cannot durably record.
   */
  storagePolicy?: LocalStoragePolicyInput;
}

export interface DaemonConfig {
  /** Distribution-owned application release; observability only, never a protocol/capability gate. */
  localAgentRelease: LocalAgentReleaseIdentity;
  productName: string;
  productId: string;
  serverUrl: string;
  deviceName?: string;
  workspaceRoot: string;
  /**
   * Strict Agent execution boundary. The host selects one absolute branded
   * storage root; the SDK alone composes `agents/<agentId>`, initializes the
   * durable home, and binds it as runtime cwd. `projection` may write opaque,
   * redacted host content into the canonical home supplied by the SDK.
   */
  agentHome?: {
    hostStorageRoot: string;
    projection?: AgentHomeProjection;
  };
  /**
   * Explicit Agent-local/cloud egress selection. Omission still enforces the
   * SDK metadata/status projection, but does not advertise or admit the new
   * policy/reliable protocol surface.
   */
  agentEgress?: AgentEgressConfig;
  /**
   * Disabled by default. Enables local-only Git checkpoint repositories for
   * legacy task workspaces. Mutually exclusive with `agentHome`: strict Agent
   * execution has one canonical workspace authority.
   */
  gitWorkspace?: GitWorkspaceConfig;
  /** Disabled by default. Enables the durable local task journal — see {@link HostedJournalConfig}. */
  hostedJournal?: HostedJournalConfig;
  /**
   * Restricts which runtimes this daemon will ever use — enforced in two
   * places that must stay consistent: `createDaemon` (this file) builds its
   * bundled adapter set FROM this list (unset = all three bundled adapters
   * — pi, claude, codex; set = exactly the listed runtime ids, unknown ids
   * ignored — see `buildDefaultAdapters`), and `TaskRunner.pickAdapter`
   * (`task-runner.ts`) separately fail-closed-rejects any `task.offer`
   * naming a runtime outside this list regardless of which adapters were
   * constructed. `createDaemonWithAdapters` callers supply their own
   * `adapters` array directly, so for them this field is enforcement-only,
   * unchanged from M1/M2.
   */
  runtimeAllowlist?: string[];
  /**
   * Separate-process Pi BYOK credential boundary. Required only for a
   * `dispatchSelection` in the BYOK lane; subscription runtimes and legacy
   * Pi tasks do not invoke it.
   */
  piByokLauncher?: import('../adapters/pi/pi-adapter').PiByokLauncherConfig;
  /**
   * M5 batch-3 (workstream 1): explicit auto-select priority order for
   * `TaskRunner.pickAdapter`'s no-explicit-runtime branch (`task-runner.ts`)
   * — tried in listed order; the first candidate that is both PRESENT
   * (`adapter.detect()`) and CAPABLE (declares the offer's
   * `PermissionPolicy.mode` in its own `descriptor.capabilities.permissionModes` —
   * see `adapterSupportsMode`) wins. Unset defaults to
   * `DEFAULT_RUNTIME_PREFERENCE` (`task-runner.ts`): `['claude', 'codex',
   * 'pi']` — pi LAST, deliberately.
   *
   * Product decision: pi is this SDK's FALLBACK runtime, not its default.
   * Before this field existed, the auto-select path had no notion of
   * priority at all — it simply walked `deps.adapters` in whatever order
   * `buildDefaultAdapters`/the embedder constructed them, which for
   * `createDaemon`'s bundled set meant `ALL_RUNTIME_IDS`'s construction
   * order (`['pi', 'claude', 'codex']`) doubled as the de-facto selection
   * priority — silently making pi the default winner whenever it was
   * present, for no better reason than being listed first in an array never
   * meant to encode a priority. This field makes the real priority an
   * explicit, independently-configurable decision instead of an accident of
   * construction order — see `ALL_RUNTIME_IDS`'s own doc comment below for
   * the construction-vs-selection-order split this introduces.
   *
   * Only affects the auto-select (no `task.offer.runtime`) path — an offer
   * naming an explicit runtime is unaffected (unchanged semantics: that
   * exact adapter is used, or the offer is declined; never a fallback
   * substitution). Independent of `runtimeAllowlist` above (which restricts
   * WHICH runtimes are eligible at all): this only orders the attempt
   * sequence among whatever that allowlist, if set, already let through.
   */
  runtimePreference?: RuntimeId[];
  /**
   * The device operator's configured policy CEILING — every `task.offer`'s
   * own policy is merged against this and fail-closed-rejected if it asks
   * for more latitude than this allows (`daemon/policy.ts`'s
   * `computeEffectivePolicy`).
   *
   * M5 batch-3 (workstream 1): `workspaceRoot` set on THIS ceiling is still
   * merged into the effective policy handed to an adapter as
   * `ctx.policy.workspaceRoot` (`computeEffectivePolicy` is unchanged) — but
   * no bundled adapter (pi/claude/codex) actually reads or enforces it;
   * every adapter derives its real confinement from `ctx.workspaceDir` (the
   * daemon-created per-task directory) instead — see docs/security.md's
   * "Workspace confinement is a convention, not a sandbox" section. Setting
   * it here is therefore silently inert rather than actively dangerous by
   * itself (an OFFER independently asking for its OWN `workspaceRoot` is a
   * separate, fail-closed-declined case — see `TaskRunner.handleOffer` —
   * precisely because THAT looks like a live security control when it
   * isn't). `start()` below logs a loud, one-time `console.warn` whenever
   * this ceiling sets `workspaceRoot`, so an operator who configured it
   * expecting real enforcement finds out immediately instead of trusting a
   * control nothing honors.
   */
  permissionDefaults?: PermissionPolicy;
  storeDir?: string;
  /** Optional white-label branding — see `DaemonBranding`. Carried through verbatim to `status().branding`. */
  branding?: DaemonBranding;
  /**
   * M5: per-device, per-runtime escape hatch into the environment allowlist
   * `task-runner.ts` builds each task's spawn environment from
   * (`daemon/environment.ts`'s `buildRuntimeEnv`) — keyed by runtime id
   * (`'pi' | 'claude' | 'codex'`, though not typed that narrowly here since
   * an id with no matching adapter is simply never looked up). `allow`
   * entries are exact variable names or `*`-suffixed prefixes, merged in
   * alongside that runtime adapter's own declared
   * `descriptor.environmentRequirements` — this can never override the hard
   * `BYOK_*` deny (see `environment.ts`'s own doc comment).
   */
  runtimeEnvironment?: Record<string, { allow?: string[] }>;
  /**
   * Device-local registry behind wire-level `requiredToolsets` ids. Only
   * logical ids cross the SaaS wire; MCP executable definitions stay here.
   * The first slice supports stdio servers (`command` + `args`) only and
   * deliberately has no task-provided env/header/secret surface.
   */
  mcpToolsets?: Record<string, McpToolsetConfig>;
  /**
   * M5: explicit escape hatch for `url.ts`'s `assertServerUrlAllowed` — see
   * that function's own doc comment for the full allow/deny rule. Default
   * (unset/`false`): a `serverUrl` using plaintext `ws:`/`http:` is only
   * accepted when its host is loopback (`localhost`/`*.localhost`,
   * `127.0.0.0/8`, `::1`); anything else over plaintext throws a typed
   * `InsecureServerUrlError` from `pair()`/`start()` below, BEFORE any
   * network call is attempted, rather than silently sending the pairing
   * code / device credentials to a remote host in the clear. Set this
   * `true` only when you have deliberately decided to accept that risk
   * (e.g. a trusted private network with no TLS terminator in front of the
   * server) — doing so also logs a loud `console.warn` (see
   * `checkServerUrl`, this file) every time it actually changes the
   * outcome. Never overrides an unsupported scheme (anything other than
   * `http:`/`https:`/`ws:`/`wss:`), which is refused unconditionally.
   */
  dangerouslyAllowInsecureRemote?: boolean;
  /**
   * M5 batch-3 (workstream 2): caps accumulated (approximate,
   * serialized-event-length) agent-event output bytes this daemon will
   * tolerate for a single task before tearing it down as a resource-limit
   * violation (`task.fail`, `retryable: false`, reason prefixed
   * `resource limit exceeded: maxTaskOutputBytes` — see
   * `MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX`, `task-runner.ts`) — see
   * `TaskRunner.pump`'s own doc comment for exactly what's counted and what
   * isn't. Default {@link DEFAULT_MAX_TASK_OUTPUT_BYTES} (64 MiB) when
   * unset.
   *
   * `0` or a negative number is a config validation error, thrown
   * synchronously from `createDaemonWithAdapters`/`createDaemon` — NOT a
   * supported way to disable the cap. Pass `Number.POSITIVE_INFINITY`
   * explicitly instead to opt out of enforcement altogether.
   */
  maxTaskOutputBytes?: number;
  /**
   * Host-owned batching policy for normalized `task.progress` events.
   * `maxBatchBytes`, when set, measures exactly the UTF-8 bytes of
   * `JSON.stringify(events)` and must match the deployment's activity-ingress
   * budget. It is deliberately unset by default because that ingress ceiling
   * is deployment policy, not a frozen protocol constant.
   */
  progressBatch?: ProgressBatcherOptions;
  /**
   * additive-minor (`task.complete.document`): the seam through which this
   * product turns a finished task's final output text into the STRUCTURED
   * terminal result the wire carries as `task.complete.document`, and the
   * server projects into `TaskResult.document`.
   *
   * `extract(finalOutput, task)` is called exactly once per task, at the
   * moment `task.complete` is built, with the same text that becomes
   * `summary` (the concatenated `progress` events for that task) plus the
   * task's `taskId`/`sessionRef`. Return `undefined` for "no structured
   * result this time". Everything about the document's SHAPE is the
   * product's business — the SDK never inspects, validates, or transforms
   * it; extraction logic (prompting for JSON, parsing a fenced block,
   * validating against the product's own schema) is product glue and belongs
   * in this callback, not in the SDK.
   *
   * The SDK enforces exactly two wire rules, via the protocol's own
   * `checkResultDocument`: the value must be JSON-serializable, and at most
   * `RESULT_DOCUMENT_MAX_BYTES` (1 MiB) as canonical JSON. Stay under ~512
   * KiB in practice (docs/protocol.md); a bigger result belongs in an
   * artifact, not here.
   *
   * FAIL-CLOSED, never silent: if the extractor throws, returns a promise
   * (the seam is synchronous and the runtime enforces it — an unawaited
   * promise would be encoded as an empty document), produces something
   * unsendable, or produces a document while the connected server never
   * advertised the `result-document` capability (an old server would strip
   * the field on arrival without a word), the task is reported as
   * `task.fail` with `retryable: false` and a reason prefixed
   * `result document undeliverable` — see
   * `RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX` (`task-runner.ts`).
   * Completing a task while quietly discarding the structured result it
   * exists to produce is not an option this SDK offers.
   *
   * Omitted entirely by default, in which case the completion path is
   * unchanged in every respect — no extractor call, no capability check, and
   * a `task.complete` payload byte-identical to the one sent before this
   * field existed.
   */
  resultDocument?: { readonly extract: ResultDocumentExtractor };
  /**
   * M5 batch-3 (workstream 2): deadline bound on the graceful-shutdown
   * sequence's own wait for `TaskRunner.shutdownActiveTasks` to finish
   * interrupting/failing every active task before this daemon proceeds to
   * actually stop regardless — see `runShutdownSequence`'s own doc comment
   * for the full sequence this bounds, and for why every graceful-shutdown
   * path (`stop()`, `unpair()`, the control socket's `shutdown` RPC) now
   * shares it. Default 10s (`SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS`) — the same
   * bound the control-socket shutdown path already used before this field
   * existed.
   */
  shutdownGraceMs?: number;
  /**
   * Cadence for the `online` presence heartbeat (§12.3), when — and only when
   * — the deployment's capability declaration contains `presence.hints` (see
   * `capabilities-client.ts`; a deployment that declares nothing, or one this
   * daemon could not read a declaration from, publishes nothing at all).
   *
   * Every field is optional and defaults to `presence-publisher.ts`'s own
   * constants, which are chosen against the hosted defaults. `ttlMs` and
   * `minimumIntervalMs` describe THE DEPLOYMENT's hint TTL and publication
   * throttle as this operator understands them: the daemon never learns either
   * from the wire, and uses them only to validate `intervalMs` sits strictly
   * between them — a cadence outside that band is rejected synchronously here,
   * the same way `maxTaskOutputBytes` is above, rather than degrading into a
   * rate-limited or flickering hint nobody sees an error for.
   */
  presence?: PresenceConfig;
  /**
   * Plan `device-assertion-broker`: opt-in local assertion broker — lets a
   * sibling process on this same machine (typically the host's own CLI,
   * installed alongside this daemon) ask the daemon, over the already
   * authenticated control socket, to mint a short-lived audience-scoped
   * assertion signed with the paired device key. See
   * {@link DeviceAssertionConfig}.
   *
   * OFF by default, and off is expressed two ways that mean the same thing: an
   * absent section, or a present one with an empty `audiences` list. Both make
   * `assertion.issue` answer `assertion_disabled` without looking at anything
   * else. A new local authentication surface does not get to be on because
   * someone left a config key behind.
   */
  deviceAssertion?: DeviceAssertionConfig;
}

export interface AgentEgressConfig {
  /** Exact policy the daemon is willing to consume from an Agent offer. */
  policy: AgentEgressPolicy;
  /** Named redaction hook for explicit contentful trajectory only. */
  sanitizer?: AgentEgressSanitizer;
  /**
   * Device-local additions required to make one server-selected transfer
   * policy executable. These values only supplement `policy.transfers`: a
   * locally configured surface never enables a server-disabled transfer, and
   * cannot widen its maxBytes or MIME authority.
   */
  contentRead?: AgentContentReadConfig;
}

/** Local root and text handling authority for one independently-gated surface. */
export interface AgentContentReadSurfaceConfig {
  readonly root: AgentContentReadRoot;
  readonly maxTextBytes: number;
  readonly textMimeTypes: readonly string[];
  readonly sensitiveNames?: readonly string[];
}

/**
 * Host-local portions of the content-read contract. The audit ledger has no
 * host path option: SDK composition fixes it per Agent home.
 */
export interface AgentContentReadConfig {
  readonly workspace?: AgentContentReadSurfaceConfig;
  readonly transcript?: AgentContentReadSurfaceConfig;
  readonly artifact?: AgentContentReadSurfaceConfig;
  readonly runtimeAllowlistedRoots?: readonly string[];
}

export interface AgentReliableEgressInput {
  agentRef: AgentRef;
  sessionRef: string;
  /** Exact runtime identity from the durable Agent-home handoff. */
  runtimeId: string;
  payload: unknown;
  taskId?: string;
  eventId?: string;
}

/**
 * Plan `device-assertion-broker`. Two fields, both about what this daemon will
 * refuse.
 *
 * Every field is validated synchronously at construction, the same way
 * `maxTaskOutputBytes` and the presence cadence are — a misconfigured
 * authentication surface must fail when the daemon is built, not on the first
 * call that needed it.
 */
export interface DeviceAssertionConfig {
  /**
   * The EXACT audience strings this daemon will mint for. Matched with
   * `Set.has` — exact string equality, never a prefix or suffix or subdomain
   * rule.
   *
   * Prefix matching is the classic hole here: an allowlist entry of
   * `salesko-api` under a `startsWith` rule also admits `salesko-api.evil.com`,
   * and a suffix rule admits `evil-salesko-api`. There is no configuration
   * that turns this into a pattern match, because there is no pattern-matching
   * code to configure.
   *
   * An empty list means the feature is off (see
   * `DaemonConfig.deviceAssertion`). Duplicate entries, empty entries, and
   * entries over 256 UTF-8 bytes are construction errors — a duplicate is
   * usually a copy-paste that hid a typo'd second entry, and silently
   * de-duplicating it would hide it for good.
   */
  audiences: string[];
  /**
   * Assertion lifetime, ms. Default
   * `DEVICE_ASSERTION_DEFAULT_TTL_MS` (120s), hard ceiling
   * `DEVICE_ASSERTION_MAX_TTL_MS` (300s) — both from `@byok-sdk/core`, which
   * enforces the same ceiling again at verification time, so a daemon patched
   * to ignore this one still cannot get a longer-lived assertion accepted.
   *
   * Deliberately NOT caller-selectable over the control socket: a lifetime a
   * caller can ask for is a lifetime every caller asks the maximum of.
   */
  ttlMs?: number;
}

export interface PresenceConfig {
  /** Heartbeat cadence. Default 30s. */
  intervalMs?: number;
  /** The deployment's presence hint TTL. Default 90s (core §12.7.5 suggests 60-120s). */
  ttlMs?: number;
  /** The deployment's minimum interval between accepted publications. Default 5s. */
  minimumIntervalMs?: number;
}

export interface DaemonStatus {
  /** Process-immutable Local Agent application release captured at construction. */
  localAgentRelease: Readonly<LocalAgentReleaseIdentity>;
  paired: boolean;
  connected: boolean;
  /** True once the connection has fallen back to long-poll (protocol §8) — transport info only (finding F6): long-poll is a full transport, so work still proceeds normally while this holds; outbound envelopes POST to /byok/messages instead of going out over WS. */
  degraded: boolean;
  /** True once the server has revoked this device (401 on challenge/token, protocol §6.3). The only recourse is calling `pair()` again — the daemon does not keep retrying on its own. */
  revoked: boolean;
  deviceId?: string;
  activeTaskCount: number;
  /** Passthrough of `DaemonConfig.branding` — `undefined` when the product configured none. See `DaemonBranding`. */
  branding?: DaemonBranding;
  /** Local lifecycle/retry budget, separate from transport fallback state. */
  operationalHealth: OperationalHealthSnapshot;
  /** Redacted, content-addressed device-local MCP registry status. */
  toolsets: McpToolsetRegistryStatus;
  /** Content-free egress lane watermarks and typed last-drop facts. */
  egress: AgentEgressStatus;
}

export interface Daemon {
  pair(pairingCode: string): Promise<DeviceRecord>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): DaemonStatus;
  /** Append one sanitized reliable record before its first transport attempt. */
  publishReliableAgentEgress?(input: AgentReliableEgressInput): Promise<AgentEgressReliableAppendResult>;
  /** Atomically replace the local registry when its current revision matches. */
  reloadMcpToolsets(
    mcpToolsets: Record<string, McpToolsetConfig> | undefined,
    expectedRevision: string,
  ): McpToolsetReloadReceipt;
  /** Record one explicit host-owned lifecycle observation for a configured toolset. */
  reportMcpToolsetObservation(
    toolsetId: string,
    expectedDefinitionRevision: string,
    observation: McpToolsetObservation,
  ): void;
  /**
   * M3-2a: local observability — subscribe to live `DaemonEvent`s (task
   * feed, connection/pairing state changes, runtime-detection results) as
   * they happen on THIS daemon, no SaaS-side polling required. Returns an
   * unsubscribe function; a listener that throws is caught and logged, never
   * propagated (see `observer.ts`). Purely additive: emitting these never
   * changes `status()` or any existing wire/task behavior.
   */
  subscribe(listener: DaemonEventListener): Unsubscribe;
  /** M3-2a: current locally-known tasks and their derived state/summary (for a `tasks` CLI subcommand) — reflects only what this daemon has observed since it started; see `observer.ts`'s `DaemonObserver.tasks`. */
  tasks(): DaemonTaskInfo[];
  /**
   * M3-2a: clears this device's persisted identity/credentials and
   * disconnects — the next `start()` throws until `pair()` is called again.
   * Safe to call at any point in the daemon's lifecycle (never paired,
   * paired-but-not-started, or running).
   */
  unpair(): Promise<void>;
  /**
   * M3-2a: locally resolve a task currently paused on `needs_approval` —
   * drives the exact same code path a server-sent `task.approve` does
   * (`TaskRunner.handleApprove`), invoked directly instead of over the wire.
   * Honest-but-currently-unexercised: none of the three bundled adapters
   * (pi/claude/codex) ever actually pauses for approval — each one's
   * `resolveApproval` throws unconditionally (see `toRuntimeInfoCapabilities`'s
   * doc comment below) — so calling this against a task on this daemon today
   * always fails that task with a clear reason instead of resuming it,
   * exactly as an honest, doing-nothing-magic implementation should. Ready
   * for the day a runtime adapter implements real interactive approval, with
   * no further changes needed here. A no-op (resolves immediately) for a
   * `taskId` this daemon doesn't currently have active.
   */
  approve(taskId: string): Promise<void>;
  /** M3-2a: same as {@link approve} but rejects — see that method's doc comment. */
  reject(taskId: string, reason?: string): Promise<void>;
}

/** Internal seam so tests can substitute stub adapters / faster backoff+batch+liveness+long-poll timing. `createDaemonWithAdapters` (which takes this) is also the real entry point for products supplying a hand-built adapter set `createDaemon` can't construct on its own — e.g. custom adapter options, or an adapter that REPLACES a bundled runtime's implementation under the same id. Honest limit: an adapter id outside `pi`/`claude`/`codex` cannot pass wire validation today — `RuntimeIdSchema` (`@byok-sdk/protocol`) is a closed `z.enum(['pi', 'claude', 'codex'])`, and `isRuntimeId` filtering below (see `detectRuntimes`) drops any detected adapter outside that set before it ever reaches a wire-visible field. A genuinely fourth/namespaced runtime id is a future protocol change, not something this seam enables today. */
export interface DaemonOverrides {
  backoff?: BackoffOptions;
  liveness?: LivenessOptions;
  /** M4 Phase 3: overrides `TaskRunner`'s default out-of-band approval wait (`DEFAULT_APPROVAL_TIMEOUT_MS`, 10 minutes) before an unanswered `requestApproval` force-resolves as a fail-closed rejection. */
  approvalTimeoutMs?: number;
  /** Finding F5: overrides for the control-socket shutdown path's own bounded waits — see `TaskRunner.shutdownTask`'s and `ConnectionManager.stop`'s own doc comments. Both default to 5s; neither affects an ordinary (non-shutdown-RPC) `daemon.stop()` call. */
  shutdown?: {
    /** Bound on how long `shutdownTask` waits for a single task's own `session.interrupt()` before giving up on it specifically and reporting `task.fail` anyway. Default `DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS`. */
    taskInterruptTimeoutMs?: number;
    /** Bound on how long the control-socket shutdown path waits for the outbox to actually drain before closing the connection. Default `DEFAULT_SHUTDOWN_OUTBOX_DRAIN_TIMEOUT_MS`. */
    outboxDrainTimeoutMs?: number;
  };
  longPoll?: {
    /** Consecutive never-acked WS connect failures before falling back to long-poll. Default 3. */
    wsFailureThreshold?: number;
    /** While long-polling, how often to retry establishing WS. Default 5 minutes. */
    wsRetryIntervalMs?: number;
    /** Backoff between failed long-poll HTTP attempts. Default 2s. */
    retryDelayMs?: number;
    /** Minimum delay before the next long-poll request after an empty (no-events) response — avoids busy-looping against a server that responds instantly. Default 250ms. */
    idleDelayMs?: number;
  };
  /**
   * Test/product injection seam for the local Git workspace boundary. The
   * supplied manager/store are used only when `config.gitWorkspace` is enabled;
   * an absent Git config therefore cannot accidentally activate either object.
   */
  gitWorkspace?: {
    manager?: GitWorkspaceManager;
    store?: GitWorkspaceStore;
  };
  /**
   * S3b: injection seam for the durable local journal, mirroring
   * `gitWorkspace` above — used only when `config.hostedJournal` is set, so an
   * absent journal config cannot accidentally activate a supplied object. Also
   * the host-injected-implementation path §12.7.2 allows: a backend other than
   * `SqliteLocalTaskJournal` is acceptable if it meets the same durability
   * contract (a resolved `appendEnvelope` means fsynced), and unacceptable
   * otherwise — this seam does not verify that, the host asserting it does.
   *
   * A journal supplied here is NOT closed by `stop()`; whoever injected it
   * owns its lifetime.
   */
  hostedJournal?: {
    journal?: LocalTaskJournal;
    /** Test-only post-open SQLite initialization fault seam. */
    openFaults?: JournalOpenFaultSeam;
    /**
     * S3b (L-003): injection seam for the storage pressure engine, same rule
     * as `journal` above — used only when `config.hostedJournal` is set, and
     * NOT started or stopped by this daemon. Whoever injects one owns its
     * cadence, which is what lets the disk-pressure matrix drive `tick()` by
     * hand with fake usage/free providers and no timer at all.
     *
     * An injected engine still answers both questions the daemon asks it
     * (admission under hard pressure, ack-critical refusal under emergency)
     * and still backs the `storage` section of the control-socket status.
     */
    pressureEngine?: LocalStoragePressureEngine;
  };
}

/**
 * Plan `device-assertion-broker` (codex round-2 F3): the internal, NON-public
 * test seam for observing assertion issuance.
 *
 * This is NOT reachable through `DaemonConfig`/`DaemonOverrides`, and is NOT
 * re-exported from the package `index.ts` — a test imports it straight from
 * this module. That isolation is the point. The earlier `DaemonOverrides.
 * deviceAssertion.mint` seam replaced the SIGNER, which meant a production
 * embedder (`DaemonOverrides` is public API) could inject a callback that
 * received the whole `DeviceRecord` — private key included — and exfiltrate it
 * or forge claims.
 *
 * `onIssued` is a strict OBSERVER, called only AFTER a real, successful sign,
 * with non-secret metadata ONLY (`jti`, `audience`). It cannot see the private
 * key, cannot alter the signature, the claims, or the audit event, and cannot
 * be reached from any public type. A test counts these calls to prove a gate
 * rejection never reached the signer (a rejection never calls `onIssued`).
 */
export interface AssertionIssueProbe {
  onIssued(meta: { jti: string; audience: string }): void;
}

/**
 * The outbound envelope types that carry a task's terminal, matching the set
 * the cloud records a terminal receipt for (`cloud/src/inbound.ts`'s
 * `applyLifecycle`). `task.decline` is deliberately NOT here: declining is
 * refusing to take a task, not producing a result for one.
 *
 * `task.complete`/`task.fail`/`task.cancelled` -> the terminal kind recorded locally.
 */
function terminalKindOf(type: string): 'complete' | 'failed' | 'cancelled' | undefined {
  if (type === 'task.complete') return 'complete';
  if (type === 'task.fail') return 'failed';
  if (type === 'task.cancelled') return 'cancelled';
  return undefined;
}

/**
 * One inbound envelope, as the journal wants it.
 *
 * `bytes` is the CANONICAL v1 encoding of the envelope this daemon parsed, not
 * the socket's original byte sequence — the frozen codec's round-trip
 * guarantee is what makes that a faithful record, and it is the same choice
 * the cloud's own terminal receipt makes.
 *
 * `opensTask` is decided here, from the envelope's own type, rather than
 * inside the journal: the two offer variants are the inbound types that bring
 * a task into existence on this device, and that is protocol knowledge this
 * file already has and the journal should not acquire a second copy of.
 */
function toJournalEnvelopeRecord(envelope: Envelope, identity: JournalIdentity): ReceivedEnvelopeRecord {
  const bytes = encodeEnvelope(envelope);
  return {
    identity,
    envelopeId: envelope.id,
    ...(envelope.task_id === undefined ? {} : { taskId: envelope.task_id }),
    seq: envelope.seq ?? 0,
    bytes,
    bytesHash: journalHash(bytes),
    receivedAt: new Date().toISOString(),
    opensTask: envelope.type === 'task.offer' || envelope.type === 'task.offer_with_toolsets' || envelope.type === 'task.offer_for_agent',
  };
}

function isRuntimeId(id: string): id is RuntimeId {
  return id === 'pi' || id === 'claude' || id === 'codex';
}

/** Runtimes actually detected as present on this device, typed per protocol §10 gap #4 (`ConnHelloPayload.runtimes`). Computed once at `start()` — re-probing on every reconnect would mean re-spawning each runtime's `--version` check for no real benefit within one daemon lifetime. */
async function detectRuntimes(adapters: RuntimeAdapter[]): Promise<RuntimeInfo[]> {
  const detections = await Promise.all(adapters.map(async (adapter) => ({ adapter, detected: await adapter.detect() })));
  const runtimes: RuntimeInfo[] = [];
  for (const { adapter, detected } of detections) {
    if (!detected.present || !isRuntimeId(adapter.descriptor.id)) continue;
    const info: RuntimeInfo = { id: adapter.descriptor.id };
    if (detected.version !== undefined) info.version = detected.version;
    if (detected.authPresent !== undefined) info.authPresent = detected.authPresent;
    // Pre-freeze addition (`RuntimeInfo.capabilities`, `messages.ts`):
    // surfaces this same adapter descriptor's capabilities (already used above
    // by `computeCapabilities` for the connection-level `steer` flag) into
    // the per-runtime wire field — see `toRuntimeInfoCapabilities`'s doc
    // comment.
    info.capabilities = toRuntimeInfoCapabilities(adapter.descriptor.capabilities);
    runtimes.push(info);
  }
  return runtimes;
}

/**
 * M0 gatekeeper finding ②: advertise only what this device can actually do,
 * not a static spread of every known flag. `steer` reflects whether any
 * configured adapter can express it; `blob-upload` is unconditional now
 * that the blob client (protocol §7) genuinely implements it.
 *
 * C2 (cross-model review, P2): `approval-targeting` is unconditional too,
 * for the same reason `blob-upload` is — this daemon has included
 * `approvalId` on `task.await_approval`/`task.approve`/`task.reject`
 * unconditionally since M5 (see `TaskRunner.dispatchApproval`/
 * `handleApprove`/`handleReject`, `task-runner.ts`), so there is no
 * adapter-specific gate to check the way `steer` has. Without this, every
 * daemon built from this codebase advertised nothing here, so the server's
 * own `targeted` marking (`ConnectionHub.approveTask`/`rejectTask` —
 * `packages/server/src/hub.ts`'s `getDeviceCapabilities(...).includes(
 * 'approval-targeting')` check) always saw an upgraded daemon as legacy —
 * see `CAPABILITY_FLAGS`'s own doc comment (`@byok-sdk/protocol`'s `version.ts`)
 * for why this flag is purely informational/observability, not a functional
 * gate, and therefore safe to advertise unconditionally the moment a daemon
 * genuinely does what it claims (as this one already does).
 */
function computeCapabilities(
  adapters: RuntimeAdapter[],
  agentHomeConfigured = false,
  agentEgressConfigured = false,
  contentReadPolicies?: Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>>,
): CapabilityFlag[] {
  const flags: CapabilityFlag[] = [];
  if (adapters.some((adapter) => adapter.descriptor.capabilities.steer)) flags.push('steer');
  flags.push('blob-upload');
  flags.push('approval-targeting');
  const selectionAdapters = adapters.filter((adapter) =>
    ALL_RUNTIME_IDS.includes(adapter.descriptor.id as RuntimeId),
  );
  if (
    selectionAdapters.length > 0 &&
    selectionAdapters.every((adapter) => adapter.descriptor.supportsDispatchSelection === true)
  ) {
    flags.push('dispatch-selection');
  }
  if (adapters.some((adapter) => adapter.descriptor.capabilities.mcpToolsets === true)) {
    flags.push('toolset-selection');
  }
  if (agentHomeConfigured) flags.push('agent-home-contract');
  if (agentEgressConfigured) {
    flags.push(
      AGENT_EGRESS_POLICY_CAPABILITY,
      AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
      AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
    );
  }
  if (contentReadPolicies !== undefined) {
    for (const surface of Object.keys(AGENT_CONTENT_READ_CAPABILITIES) as AgentContentReadSurface[]) {
      const policy = contentReadPolicies[surface];
      if (policy !== 'disabled') flags.push(policy.capability as CapabilityFlag);
    }
  }
  return flags;
}

function resolveContentReadPolicies(
  egressPolicy: AgentEgressPolicy,
  config: AgentContentReadConfig | undefined,
): Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>> {
  const policies: Partial<Record<AgentContentReadSurface, AgentContentReadPolicySelection>> = {};
  for (const surface of Object.keys(AGENT_CONTENT_READ_CAPABILITIES) as AgentContentReadSurface[]) {
    const remote = egressPolicy.transfers[surface];
    const local = config?.[surface];
    if (remote === 'disabled' || local === undefined) {
      policies[surface] = 'disabled';
      continue;
    }
    policies[surface] = createAgentContentReadPolicy({
      enabled: true,
      capability: AGENT_CONTENT_READ_CAPABILITIES[surface],
      root: local.root,
      policyRevision: egressPolicy.policyRevision,
      maxBytes: remote.maxBytes,
      maxTextBytes: local.maxTextBytes,
      allowedMimeTypes: remote.allowedMimeTypes,
      textMimeTypes: local.textMimeTypes,
      ...(local.sensitiveNames === undefined ? {} : { sensitiveNames: local.sensitiveNames }),
    });
  }
  return Object.freeze({
    workspace: policies.workspace ?? 'disabled',
    transcript: policies.transcript ?? 'disabled',
    artifact: policies.artifact ?? 'disabled',
  });
}

function hasExactContentReadTransfer(expected: ContentReadPolicy | 'disabled', actual: ContentReadPolicy): boolean {
  return (
    expected !== 'disabled' &&
    expected.maxBytes === actual.maxBytes &&
    expected.allowedMimeTypes.length === actual.allowedMimeTypes.length &&
    expected.allowedMimeTypes.every((mimeType, index) => mimeType === actual.allowedMimeTypes[index])
  );
}

/** Keep the received policy revision in the audit receipt while refusing any non-exact wire policy. */
function policyRevisionMismatchPolicies(
  policies: Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>>,
  surface: AgentContentReadSurface,
): Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>> {
  const selected = policies[surface];
  if (selected === 'disabled') return policies;
  const mismatch: AgentContentReadPolicy = Object.freeze({
    ...selected,
    policyRevision: `${selected.policyRevision}:wire-policy-mismatch`,
  });
  return Object.freeze({ ...policies, [surface]: mismatch });
}

/**
 * Canonical construction/identity order for `createDaemon`'s bundled adapter
 * set (`buildDefaultAdapters` below) and for `conn.hello.runtimes`
 * reporting order (`detectRuntimes`) — this is NOT the auto-select priority
 * order.
 *
 * M5 batch-3 (workstream 1): auto-select priority now lives entirely in
 * `task-runner.ts`, as its own explicit order independent of this one — see
 * `DEFAULT_RUNTIME_PREFERENCE`/`TaskRunner.pickAdapter`, overridable
 * per-daemon via `DaemonConfig.runtimePreference` above. Before this change,
 * `pickAdapter`'s no-runtime branch walked `deps.adapters` directly (this
 * array's own construction order), so listing pi first here silently made
 * it the de-facto DEFAULT auto-selected runtime whenever present — the
 * opposite of the product decision that pi is the FALLBACK runtime (tried
 * only once nothing better is available/capable), not the default. That
 * conflation is why this constant's order and the auto-select order are now
 * two independent things: this one stays `['pi', 'claude', 'codex']`
 * (unchanged — still a perfectly fine construction/reporting order, and
 * changing it would needlessly reshuffle `conn.hello.runtimes` for no
 * reason), while `DEFAULT_RUNTIME_PREFERENCE` states the actual selection
 * priority explicitly (`['claude', 'codex', 'pi']`, pi last) instead of
 * leaving it as an implicit side effect of this list's order.
 */
const ALL_RUNTIME_IDS: readonly RuntimeId[] = ['pi', 'claude', 'codex'];

function buildAdapter(id: RuntimeId, config: DaemonConfig): RuntimeAdapter {
  switch (id) {
    case 'pi':
      return new PiAdapter({ byokLauncher: config.piByokLauncher });
    case 'claude':
      return new ClaudeAdapter();
    case 'codex':
      return new CodexAdapter();
  }
}

/**
 * Builds `createDaemon`'s bundled adapter set from `DaemonConfig.runtimeAllowlist`
 * — see that field's own doc comment for the unset-vs-set contract. Filters
 * `ALL_RUNTIME_IDS` (rather than mapping the allowlist directly) so an
 * allowlist entry that isn't a real runtime id is silently ignored — the same
 * "unknown id never gets an adapter" fail-closed shape `TaskRunner.pickAdapter`
 * already applies to an unknown *requested* runtime — and it de-duplicates
 * repeated entries for free.
 */
function buildDefaultAdapters(config: DaemonConfig): RuntimeAdapter[] {
  const ids = config.runtimeAllowlist
    ? ALL_RUNTIME_IDS.filter((id) => config.runtimeAllowlist?.includes(id))
    : ALL_RUNTIME_IDS;
  return ids.map((id) => buildAdapter(id, config));
}

/**
 * Plan `device-assertion-broker`: validates `DaemonConfig.deviceAssertion
 * .audiences` and resolves it to the exact-match `Set` the `assertion.issue`
 * gate consults.
 *
 * `undefined` means the feature is OFF — returned for an absent section AND
 * for a present one with an empty list, which are the same statement. Every
 * other malformed shape throws: this is an allowlist for a local
 * authentication surface, and an operator who wrote one that does not parse
 * must not end up with a daemon that quietly allows nothing (indistinguishable
 * from "off") or, worse, one that allows something they did not write.
 */
function resolveDeviceAssertionAudiences(config: DeviceAssertionConfig | undefined): Set<string> | undefined {
  if (config === undefined) return undefined;
  if (!Array.isArray(config.audiences)) {
    throw new Error(
      `DaemonConfig.deviceAssertion.audiences must be an array of exact audience strings — got ${JSON.stringify(config.audiences)}. Omit the deviceAssertion section (or pass an empty array) to leave the assertion broker disabled.`,
    );
  }
  if (config.audiences.length === 0) return undefined;
  const audiences = new Set<string>();
  for (const audience of config.audiences) {
    if (typeof audience !== 'string' || audience.length === 0) {
      throw new Error(
        `DaemonConfig.deviceAssertion.audiences entries must be non-empty strings — got ${JSON.stringify(audience)}`,
      );
    }
    if (Buffer.byteLength(audience, 'utf8') > DEVICE_ASSERTION_AUDIENCE_MAX_BYTES) {
      throw new Error(
        `DaemonConfig.deviceAssertion.audiences entry ${JSON.stringify(audience)} exceeds ${DEVICE_ASSERTION_AUDIENCE_MAX_BYTES} UTF-8 bytes`,
      );
    }
    if (audiences.has(audience)) {
      throw new Error(
        `DaemonConfig.deviceAssertion.audiences contains ${JSON.stringify(audience)} twice — rejected rather than de-duplicated, because a duplicate is usually a copy-paste that hid a typo in the entry that was meant to be different`,
      );
    }
    audiences.add(audience);
  }
  return audiences;
}

/** Plan `device-assertion-broker`: see `DeviceAssertionConfig.ttlMs`. Out of range is a construction error, never a clamp — silently shortening (or lengthening) an operator's configured credential lifetime is worse than refusing to start. */
function resolveDeviceAssertionTtlMs(config: DeviceAssertionConfig | undefined): number {
  const ttlMs = config?.ttlMs ?? DEVICE_ASSERTION_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEVICE_ASSERTION_MAX_TTL_MS) {
    throw new Error(
      `DaemonConfig.deviceAssertion.ttlMs must be a positive integer no greater than ${DEVICE_ASSERTION_MAX_TTL_MS} ms — got ${JSON.stringify(config?.ttlMs)}`,
    );
  }
  return ttlMs;
}

export function createDaemonWithAdapters(
  config: DaemonConfig,
  adapters: RuntimeAdapter[],
  overrides: DaemonOverrides = {},
): Daemon {
  return buildDaemonWithAdapters(config, adapters, overrides);
}

/**
 * codex round-2 F3: the real builder. Exported from THIS module but NOT from
 * the package `index.ts`, so the optional `assertionProbe` (an
 * {@link AssertionIssueProbe} post-sign observer) is reachable only by tests
 * importing this module directly — never through any public type. The public
 * `createDaemonWithAdapters` above forwards without it, so production has no
 * observer and no signer-injection surface at all.
 */
export function buildDaemonWithAdapters(
  config: DaemonConfig,
  adapters: RuntimeAdapter[],
  overrides: DaemonOverrides = {},
  assertionProbe?: AssertionIssueProbe,
): Daemon {
  if (config.agentHome !== undefined && config.gitWorkspace !== undefined) {
    throw new Error(
      'DaemonConfig.agentHome and DaemonConfig.gitWorkspace are mutually exclusive; Agent home is the only workspace authority for Agent offers',
    );
  }
  const localAgentRelease = resolveLocalAgentReleaseIdentity(config.localAgentRelease);
  const toolsetRegistry = new McpToolsetRegistry(config.mcpToolsets);
  validatePiByokLauncherConfig(config.piByokLauncher);
  // M5 batch-3 (workstream 2): validated synchronously, up front — see
  // `DaemonConfig.maxTaskOutputBytes`'s own doc comment for the full
  // zero/negative-is-an-error / `Number.POSITIVE_INFINITY`-is-the-real-
  // opt-out pin. `configured > 0` is `false` for `NaN`, `0`, and any
  // negative number, and `true` for `Number.POSITIVE_INFINITY` — exactly the
  // three-way split this config wants.
  if (config.maxTaskOutputBytes !== undefined && !(config.maxTaskOutputBytes > 0)) {
    throw new Error(
      `DaemonConfig.maxTaskOutputBytes must be a positive number (or omitted to use the ${DEFAULT_MAX_TASK_OUTPUT_BYTES}-byte default) — got ${config.maxTaskOutputBytes}. Pass Number.POSITIVE_INFINITY to explicitly disable the cap; 0 or a negative number is rejected rather than silently treated as "disabled".`,
    );
  }
  validateProgressBatcherOptions(config.progressBatch);
  if (config.agentEgress !== undefined && config.agentHome === undefined) {
    throw new Error('DaemonConfig.agentEgress requires DaemonConfig.agentHome for the per-Agent local spool');
  }
  const egressPolicy = resolveAgentEgressPolicy(config.agentEgress?.policy);
  const egressBatcherOptions: ProgressBatcherOptions | undefined = egressPolicy.activity.mode === 'contentful-trajectory'
    ? {
        ...config.progressBatch,
        flushIntervalMs: Math.min(config.progressBatch?.flushIntervalMs ?? 250, egressPolicy.activity.maxCoalesceMs),
      }
    : config.progressBatch;

  // Same up-front discipline as `maxTaskOutputBytes` above: the presence
  // cadence is pure config, so a band violation is a construction error rather
  // than something the heartbeat loop discovers later — see
  // `DaemonConfig.presence`. Resolved once here so the assertion and the
  // publisher below can never read different numbers.
  const presenceCadence = {
    intervalMs: config.presence?.intervalMs ?? DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS,
    ttlMs: config.presence?.ttlMs ?? DEFAULT_PRESENCE_TTL_MS,
    minimumIntervalMs: config.presence?.minimumIntervalMs ?? DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS,
  };
  assertPresenceHeartbeatCadence(presenceCadence);

  // Plan `device-assertion-broker`: same up-front discipline as the two blocks
  // above. This one guards a local AUTHENTICATION surface, so every rejection
  // below is a construction error rather than a runtime refusal — a daemon
  // that starts with a malformed allowlist is a daemon whose operator believes
  // an allowlist is in force.
  //
  // Resolved into a `Set` (exact membership, no ordering, no pattern) and a
  // number here, once, so the handler below cannot read a different allowlist
  // or a different TTL than the one that was validated.
  const deviceAssertionAudiences = resolveDeviceAssertionAudiences(config.deviceAssertion);
  const deviceAssertionTtlMs = resolveDeviceAssertionTtlMs(config.deviceAssertion);
  /**
   * Set SYNCHRONOUSLY by `performControlShutdown`, before the shutdown RPC's
   * own response is even written — see that function and the `shutting_down`
   * gate for the ~10s minting window this closes.
   *
   * Latched: nothing ever sets it back to `false`, including a later
   * `start()` on this same instance. A daemon that has been told to shut down
   * does not get to mint credentials again in this process, and "fail closed
   * until restart" is the correct posture for the one flag whose entire job is
   * to stop issuance during teardown.
   */
  let shuttingDown = false;

  const storeDir = DeviceStore.resolveDir(config.productId, config.storeDir);
  const store = new DeviceStore(storeDir);
  const operationalHealth = new OperationalHealthTracker(storeDir);
  let fleetJitter: FleetJitter | undefined;
  let maintenanceSequence = 0;
  const cursorStore = new CursorStore(storeDir);
  const sessionWorkspaces = new SessionWorkspaceStore(storeDir);
  const agentHomeManager = config.agentHome === undefined
    ? undefined
    : new AgentHomeManager({
        hostStorageRoot: config.agentHome.hostStorageRoot,
        ...(config.agentHome.projection === undefined ? {} : { projection: config.agentHome.projection }),
        leaseManager: new AgentHomeLeaseManager({
          ownerId: stableAgentHomeOwnerId(storeDir, config.productId),
        }),
      });
  const agentSessionHandoffs = config.agentHome === undefined ? undefined : new AgentSessionHandoffStore();
  const agentContentReadPolicies = resolveContentReadPolicies(egressPolicy, config.agentEgress?.contentRead);
  // Before authenticated enrollment is loaded, egress is deliberately unable
  // to persist or acknowledge tenant-scoped records. startUnderLease replaces
  // this with the exact loaded DeviceRecord binding before it accepts work.
  let agentEgress = new AgentEgressController({
    policy: egressPolicy,
    ...(config.agentEgress?.sanitizer === undefined ? {} : { sanitizer: config.agentEgress.sanitizer }),
  });
  const gitWorkspaceManager = config.gitWorkspace ? overrides.gitWorkspace?.manager ?? new GitWorkspaceManager(config.workspaceRoot, { ownerId: stableGitWorkspaceOwnerId(storeDir, config.productId) }) : undefined;
  const gitWorkspaceStore = config.gitWorkspace ? overrides.gitWorkspace?.store ?? new GitWorkspaceStore(storeDir) : undefined;
  // S3b (L-002), same three-part shape as `gitWorkspace` above: optional
  // config field, conditional construction, override seam. An absent
  // `hostedJournal` constructs NOTHING — no database file, no directory, no
  // reference — which is what keeps the default self-hosted path identical to
  // what it was before this slice.
  //
  // Fail-closed on a runtime without `node:sqlite` needs no check here: this
  // is the constructor that refuses (`JournalUnavailableError`), before any
  // filesystem work, and it propagates straight out of `createDaemon`.
  let resolvedStoragePolicy: LocalStoragePolicy | undefined;
  if (config.hostedJournal) {
    // Validated synchronously and up front, the same way `maxTaskOutputBytes`
    // is above — a misconfigured durability section must fail at
    // construction, not at the first envelope that needed it.
    if (config.hostedJournal.mode !== 'sqlite') {
      throw new Error(`DaemonConfig.hostedJournal.mode must be "sqlite" — got ${JSON.stringify(config.hostedJournal.mode)}`);
    }
    // Resolved HERE, in the same pure-config block, and deliberately BEFORE
    // any journal is constructed: rejecting a malformed storage policy must
    // not depend on this runtime having `node:sqlite`, or the same bad config
    // would surface as `JournalUnavailableError` on Node 20 and
    // `LocalStoragePolicyError` on Node 22. Config errors are config errors on
    // every runtime.
    if (config.hostedJournal.storagePolicy) {
      resolvedStoragePolicy = resolveLocalStoragePolicy(config.hostedJournal.storagePolicy);
    }
  }
  // Capability detection is side-effect-free and therefore remains a
  // construction-time failure. Opening/schema-initializing/quarantining the
  // SQLite file is intentionally deferred until `startUnderLease` owns the
  // cross-process store lease; a rejected second daemon must not touch the
  // active daemon's DB/WAL/SHM before discovering that it is rejected.
  if (config.hostedJournal && overrides.hostedJournal?.journal === undefined && !isSqliteAvailable()) {
    throw new JournalUnavailableError(`node:sqlite could not be loaded on Node ${process.versions.node}`);
  }

  let ownedJournal: SqliteLocalTaskJournal | undefined;
  let journal: LocalTaskJournal | undefined = config.hostedJournal ? overrides.hostedJournal?.journal : undefined;
  let ownedPressureEngine: LocalStoragePressureEngine | undefined;
  let hostedStorageInitializationBarrierComplete = true;
  let pressureEngine: LocalStoragePressureEngine | undefined = config.hostedJournal
    ? overrides.hostedJournal?.pressureEngine
    : undefined;

  /** Construct every daemon-owned hosted writer only after ownership exists. */
  function initializeOwnedHostedStorage(): void {
    if (!config.hostedJournal) return;
    if (!journal) {
      try {
        ownedJournal = new SqliteLocalTaskJournal({
          storeDir,
          ...(config.hostedJournal.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: config.hostedJournal.busyTimeoutMs }),
          ...(config.hostedJournal.maxRecordBytes === undefined ? {} : { maxRecordBytes: config.hostedJournal.maxRecordBytes }),
          ...(overrides.hostedJournal?.openFaults === undefined ? {} : { openFaults: overrides.hostedJournal.openFaults }),
        });
      } catch (err) {
        if (err instanceof JournalHandleCleanupError) hostedStorageInitializationBarrierComplete = false;
        throw err;
      }
      journal = ownedJournal;
    }
    if (resolvedStoragePolicy && !pressureEngine) {
      const activeJournal = journal;
      const cleanupJournal = ownedJournal;
      ownedPressureEngine = new LocalStoragePressureEngine({
        policy: resolvedStoragePolicy,
        journal: activeJournal,
        freeBytesProvider: createStatfsFreeBytesProvider(storeDir),
        executor: createFilesystemCleanupExecutor(
          cleanupJournal ? { pruneJournalTask: (taskId) => cleanupJournal.pruneConfirmedJournalTask(taskId) } : {},
        ),
        timers: {
          setInterval: (handler, baseMs) => {
            if (!fleetJitter) throw new Error('maintenance scheduler started before device identity was loaded');
            const timer = setInterval(handler, fleetJitter.delay('maintenance', maintenanceSequence++, baseMs));
            timer.unref?.();
            return timer;
          },
          clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
        },
        onMaintenanceOutcome: (outcome) => {
          const write = outcome === 'success'
            ? operationalHealth.recordSuccess('maintenance')
            : operationalHealth.recordFailure('maintenance');
          void write.catch((err: unknown) => {
            console.warn(`[byok/client] failed to persist operational health: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
        onEvent: (event) => {
          if (event.kind !== 'state-changed') return;
          console.warn(
            `[byok/client] local storage pressure: ${event.from} -> ${event.to} (used ${event.snapshot.usedBytes} of ${event.snapshot.budgetBytes} budget bytes, ${event.snapshot.freeBytes} free)`,
          );
        },
      });
      pressureEngine = ownedPressureEngine;
    }
  }
  /**
   * S3b: serializes terminal journal writes against the outbound send that
   * follows each one, and gives `runShutdownSequence` something to await.
   *
   * `TaskRunnerDeps.send` is synchronous by contract, so the journal write
   * cannot simply be awaited inline. Chaining instead keeps the ordering
   * (journal committed, THEN the terminal goes on the wire) without changing
   * that contract — and the shutdown sequence awaits this tail before the
   * outbox drain, so a `task.fail` produced during teardown can never be left
   * mid-chain while the connection closes out from under it.
   */
  let journalTerminalTail: Promise<void> = Promise.resolve();
  // M3-2a: local observability — constructed once per daemon instance (not
  // per `start()`) so `subscribe()`/`tasks()` work immediately after
  // `createDaemonWithAdapters()` returns and keep accumulating across an
  // internal stop()/start() cycle within the same instance. See `observer.ts`.
  const observer = new DaemonObserver();
  // M4 Phase 2: registry backing the control socket's `approvals.list`/
  // `approvals.resolve` methods — see `approvals.ts`'s module doc comment.
  // Nothing populates it yet in Phase 2; it's constructed now so Phase 3
  // only needs to add producers.
  const approvalRegistry = new ApprovalRegistry();

  let connection: ConnectionManager | undefined;
  let connectionState: ConnectionState = 'closed';
  // A successful start owns tenant-bound egress and journal composition. A
  // re-pair during that lifetime is refused rather than leaving any active
  // closure on the previous record; stop() must complete first.
  let daemonStarted = false;
  // Once an active daemon begins an explicit re-pair, no inbound envelope or
  // host reliable append may observe the old binding after the new record is
  // committed. A failed replacement before commit clears this; a failed
  // shutdown after commit remains fail-closed.
  let tenantRebinding = false;
  let runner: TaskRunner | undefined;
  // M4 Phase 2: local control socket (see `control-server.ts`) — started in
  // `start()`, closed in `stop()`. `undefined` whenever the daemon isn't
  // running, or when binding it failed non-fatally (see `start()`'s own
  // try/catch below).
  let controlServerHandle: ControlServerHandle | undefined;
  let daemonOwnerLease: DaemonOwnerLease | undefined;
  // The presence producer (§12.3). Both are `undefined` whenever this daemon
  // is not running, and neither is on the task path in any way: capability
  // discovery runs off the connection critical path, and a failure to read a
  // declaration leaves the publisher unstarted and every other daemon function
  // untouched (ADR-010 fail-closed — never a 404 probe, never an assumed
  // capability). The controller cancels an in-flight discovery during
  // shutdown so teardown never waits on a hung deployment.
  let presencePublisher: PresencePublisher | undefined;
  /** Runtime facts are probed once per start and reused by WS + first-hop HTTP presence. */
  let detectedRuntimeFacts: readonly RuntimeInfo[] = [];
  let presenceDiscovery: AbortController | undefined;
  /** Guards against a reconnect storm stacking overlapping declaration reads. */
  let presenceDiscoveryInFlight = false;
  let shutdownPromise: Promise<void> | undefined;
  const pendingLateMutationBarriers = new Set<Promise<void>>();
  /** M4 Phase 2: when this `start()` began — backs the control socket's `status.uptimeMs`. */
  let startedAt: number | undefined;

  // M3-2a: `let`, not `const` — `unpair()` below rebuilds this from scratch
  // (fresh, no cached in-memory `record`) rather than mutating the existing
  // instance. `AuthManager` has no reset/forget method of its own (out of
  // scope: owned by a concurrent worker's untouched file) and caches its
  // `record` in memory once loaded, so merely clearing `store` on disk isn't
  // enough on its own — a same-process `loadExisting()` call would keep
  // returning the cached record. Reconstructing `auth` is the seam this file
  // already owns end-to-end; `pair`/`start`/`status`/`stop` all read the
  // CURRENT closure variable at call time, so a fresh instance is picked up
  // by every one of them with no further wiring.
  function buildAuthManager(): AuthManager {
    return new AuthManager({
      serverUrl: config.serverUrl,
      store,
      deviceName: config.deviceName,
      onRevoked: () => {
        connectionState = 'revoked';
      },
    });
  }
  let auth = buildAuthManager();

  /**
   * M5: `assertServerUrlAllowed`'s call site — see that function's own doc
   * comment (`url.ts`) for why `pair()`/`start()` are the right (and only
   * needed) two places to call it from. Checked WITHOUT the escape hatch
   * FIRST, deliberately: that is the only way to tell whether
   * `dangerouslyAllowInsecureRemote` actually changed the outcome (as
   * opposed to being set but inert, e.g. against a `serverUrl` that was
   * already loopback) — only a hatch that genuinely let something through
   * deserves the loud warning below, emitted via the exact same
   * `console.warn('[byok/client] ...')` convention this file already uses
   * for its other non-fatal, operator-facing warnings (see the
   * control-socket bind-failure warning in `start()`).
   *
   * F2 (fixed here): `config.dangerouslyAllowInsecureRemote` being set only
   * means "forgive a plaintext-to-non-loopback rejection" — it does NOT mean
   * "forgive literally any rejection this gate can ever produce." An
   * unsupported scheme (e.g. `ftp:`) or a `serverUrl` that fails to parse as
   * a URL at all is refused by `assertServerUrlAllowed` UNCONDITIONALLY,
   * regardless of `dangerouslyAllowInsecureRemote` (see that function's own
   * doc comment) — the previous version of this catch block forwarded the
   * hatch's boolean straight past that distinction and warned-and-proceeded
   * for EVERY rejection once the flag was set. Fixed by re-running the exact
   * same check WITH the hatch passed through once the flag is confirmed set;
   * only a second call that ALSO passes proves the hatch genuinely covers
   * this specific rejection and earns the warn-and-proceed below. If the
   * second call throws too, that throw propagates out of this function
   * unchanged (nothing here catches it) — correctly, since the hatch was
   * never going to cover this rejection in the first place.
   */
  function checkServerUrl(): void {
    try {
      assertServerUrlAllowed(config.serverUrl);
    } catch (err) {
      if (!config.dangerouslyAllowInsecureRemote) throw err;
      assertServerUrlAllowed(config.serverUrl, { dangerouslyAllowInsecureRemote: true });
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[byok/client] WARNING: dangerouslyAllowInsecureRemote is set — proceeding with an insecure server URL (${config.serverUrl}). ` +
          `Device credentials and task data will be sent in the clear to a non-loopback host. This should never be used in a real ` +
          `deployment. (${reason})`,
      );
    }
  }

  let lifecycleMutationTail: Promise<void> = Promise.resolve();

  async function runLifecycleMutation<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = lifecycleMutationTail;
    let release!: () => void;
    lifecycleMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function pair(pairingCode: string): Promise<DeviceRecord> {
    checkServerUrl();
    // Serialize every lifecycle mutation, not only pair/pair. A process-local
    // operation may borrow the daemon's retained cross-process lease, so pair,
    // start, stop, control shutdown and unpair must never decide independently
    // who releases that shared lease.
    return runLifecycleMutation(() => pairUnderLease(pairingCode));
  }

  async function pairUnderLease(pairingCode: string): Promise<DeviceRecord> {
    const wasRunning = daemonStarted;
    if (wasRunning) tenantRebinding = true;
    // Pairing persists device.json. It intentionally does not arm proactive
    // renewal (AuthManager.loadExisting does that under start()'s lease), so a
    // short-lived pair command can release ownership once the write lands.
    const acquiredHere = daemonOwnerLease === undefined;
    if (acquiredHere) daemonOwnerLease = await acquireDaemonOwner(storeDir, 'daemon');
    // Finding F5: capture whatever device is currently on disk for this
    // serverUrl (if any) BEFORE pairing — `auth.pair()` mints/persists a
    // brand new deviceId (the server always does, even on a same-keypair
    // re-pair; see docs/protocol.md §6.3) and there would be no way to
    // recover the outgoing deviceId afterward to know whose cursor to clear.
    // Reading straight from `store` (not `auth.deviceId`) works whether or
    // not `start()`/`loadExisting()` ran in this process before `pair()`.
    let replacementPersisted = false;
    try {
      let previous: DeviceRecord | undefined;
      try {
        previous = await store.load();
      } catch (error) {
        // Pairing may replace a legacy/tampered record, but must not derive a
        // cursor/device identity from an untrusted file.
        if (!(error instanceof DeviceRecordRePairRequiredError)) throw error;
      }
      const record = await auth.pair(pairingCode);
      replacementPersisted = true;
      // No stopped daemon operation may continue using a superseded binding
      // between re-pair and the next start. startUnderLease will construct the
      // bound controller only from the newly loaded DeviceRecord.
      if (config.agentEgress !== undefined) {
        // TaskRunner owns the previous controller by reference for this run;
        // deactivate it before the new record can be followed by shutdown
        // terminal/progress activity.
        agentEgress.deactivate();
        agentEgress = new AgentEgressController({
          policy: egressPolicy,
          ...(config.agentEgress.sanitizer === undefined ? {} : { sanitizer: config.agentEgress.sanitizer }),
        });
      }
      if (wasRunning) {
        // The pair response has replaced device.json, so the running daemon's
        // closures are no longer allowed to handle work under the old record.
        // Completing this shutdown before pair() resolves makes restart an
        // explicit, fresh load of the new authenticated binding.
        await runShutdownSequence('re-pairing enrollment binding');
        tenantRebinding = false;
      }
      if (previous && previous.deviceId !== record.deviceId) {
        await cursorStore.clear(config.serverUrl, previous.deviceId);
      }
      observer.notePaired(record.deviceId);
      if (acquiredHere) {
        await daemonOwnerLease?.release();
        daemonOwnerLease = undefined;
      }
      return record;
    } catch (err) {
      if (wasRunning && !replacementPersisted) tenantRebinding = false;
      if (acquiredHere) {
        await daemonOwnerLease?.release();
        daemonOwnerLease = undefined;
      }
      throw err;
    }
  }

  async function start(): Promise<void> {
    checkServerUrl();
    await runLifecycleMutation(startUnderLease);
  }

  async function startUnderLease(): Promise<void> {
    if (!daemonOwnerLease) daemonOwnerLease = await acquireDaemonOwner(storeDir, 'daemon');
    try {
    // This is the first point at which daemon-owned hosted storage may touch
    // the filesystem. The lease was acquired above, so SQLite open/schema/
    // quarantine and every pressure-engine writer are inside the same
    // authority boundary as auth renewal and the rest of daemon lifecycle.
    initializeOwnedHostedStorage();
    const activeJournal = journal;
    const activePressureEngine = pressureEngine;
    const activeOwnedPressureEngine = ownedPressureEngine;
    // Loading an existing record arms proactive token renewal, whose final
    // step writes device.json. Acquire the store mutation lease first so a
    // rejected second daemon can never leave that timer behind as a writer.
    const record = await auth.loadExisting();
    if (!record) {
      throw new Error('device is not paired yet; call pair(pairingCode) first');
    }
    if (config.agentEgress !== undefined) {
      agentEgress = new AgentEgressController({
        policy: egressPolicy,
        tenantId: record.tenantId,
        ...(config.agentEgress.sanitizer === undefined ? {} : { sanitizer: config.agentEgress.sanitizer }),
      });
    }
    // Capability publication happens only after this SDK-owned preflight has
    // proved the canonical root/agents namespace can be materialized and
    // mutated. A configured-but-unusable root must never admit cloud work.
    await agentHomeManager?.preflight();
    if (config.agentEgress !== undefined && config.agentHome !== undefined) {
      await agentEgress.recover(path.join(config.agentHome.hostStorageRoot, 'agents'));
    }
    fleetJitter = createFleetJitter(config.productId, record.deviceId);

    // M5 batch-3 (workstream 1): see `DaemonConfig.permissionDefaults`'s own
    // doc comment above — a configured ceiling `workspaceRoot` is merged
    // into every task's effective policy but enforced by no bundled adapter.
    // Logged once per `start()` (not per task, not per offer) — same
    // operator-facing, non-fatal `console.warn` convention `checkServerUrl`'s
    // `dangerouslyAllowInsecureRemote` warning above already uses in this
    // file. This is purely a LOCAL-ceiling warning: an OFFER independently
    // asking for its own `workspaceRoot` is a different, fail-closed-declined
    // case handled by `TaskRunner.handleOffer`, not here.
    if (config.permissionDefaults?.workspaceRoot !== undefined) {
      console.warn(
        `[byok/client] WARNING: permissionDefaults.workspaceRoot ("${config.permissionDefaults.workspaceRoot}") is configured, but no bundled runtime adapter (pi/claude/codex) enforces PermissionPolicy.workspaceRoot — every adapter confines a task to ctx.workspaceDir instead. This ceiling value has no enforcement effect; see docs/security.md's "Workspace confinement is a convention, not a sandbox" section.`,
      );
    }

    // S3b (L-002): the recovery scan, before anything can accept new work.
    //
    // Every task the journal still has open is one this daemon was in the
    // middle of when it last stopped. Local runtime sessions do not survive
    // the process, so each is marked `interrupted` rather than pretended back
    // into life — the same honest semantics `GitWorkspaceStore.reconcile()`
    // already applies to a lease whose owner is gone, and the same one
    // `SqliteTaskStore` documents on the server side ("record persistence, not
    // live task reconnection"). Marking never deletes: a recovery-marked row
    // is on §12.7.2.1's never-auto-delete list precisely so the evidence
    // outlives the restart.
    //
    // Not wrapped in a try/catch: a journal that cannot be read is not a
    // degraded mode to carry on in. Hosted mode was configured explicitly, so
    // failing `start()` is the fail-closed behaviour §12.7.2 asks for.
    if (activeJournal) {
      const recoverable = await activeJournal.listRecoverable();
      for (const task of recoverable) {
        await activeJournal.markRecovered(task.taskId, {
          disposition: 'interrupted',
          reason: `daemon restarted while this task was in local state "${task.localState}"; local runtime sessions do not survive the process`,
        });
      }
      if (recoverable.length > 0) {
        console.warn(
          `[byok/client] local journal recovery: ${recoverable.length} task(s) were interrupted by the previous shutdown and have been marked (not resumed, not deleted): ${recoverable
            .map((task) => task.taskId)
            .join(', ')}`,
        );
      }
    }

    // S3b (L-003): one measurement before this daemon can accept anything, so
    // the admission guard's first answer comes from a real reading rather than
    // the optimistic `normal` a fresh engine starts in — a device that booted
    // already over its hard watermark must decline the first offer, not the
    // second. Awaited, and deliberately not caught: hosted mode plus a storage
    // policy is an explicit request to gate on local storage, and a daemon that
    // cannot measure it cannot honour that (§12.7.2's fail-closed posture).
    // An INJECTED engine is left alone — its owner drives its cadence.
    if (activeOwnedPressureEngine) {
      await activeOwnedPressureEngine.tick();
      activeOwnedPressureEngine.start();
    }

    startedAt = Date.now();
    // M4 Phase 2: a second start() on THIS SAME Daemon instance (e.g. the
    // revoke -> re-pair -> start() again recovery flow) restarts its own
    // control socket rather than colliding with itself — `stop()` was not
    // necessarily called in between (mirrors `connection`/`runner` above,
    // which are also silently replaced on a second start()). Only a
    // DIFFERENT process/instance still holding this storeDir's control
    // socket open is the "another daemon is running" fatal case below.
    if (controlServerHandle) {
      await controlServerHandle.close();
      controlServerHandle = undefined;
    }
    // The control socket must never brick the rest of the daemon: "another
    // daemon's control server is already running against this exact
    // storeDir" is the one bind failure that stays fatal (a second daemon
    // writing to the same store concurrently is a real hazard); any other
    // bind failure (e.g. an unsupported filesystem) is logged and the
    // daemon proceeds without a control socket at all.
    try {
      controlServerHandle = await startControlServer({ storeDir, productId: config.productId, methods: controlMethods });
    } catch (err) {
      if (err instanceof AnotherControlServerRunningError) throw err;
      console.warn(
        `[byok/client] control socket failed to start (continuing without it): ${err instanceof Error ? err.message : String(err)}`,
      );
      controlServerHandle = undefined;
    }
    // The run marker begins only after this process has passed the daemon's
    // existing single-owner bind check. Writing it before that check would let
    // a rejected second process overwrite the live daemon's marker and create
    // a false crash record on the next restart.
    await operationalHealth.startRun();

    if (gitWorkspaceManager) {
      await gitWorkspaceManager.preflight();
      await gitWorkspaceStore?.initialize();
      await gitWorkspaceStore?.reconcile();
    }

    const [runtimes, blobClient] = await Promise.all([
      detectRuntimes(adapters),
      Promise.resolve(new BlobClient(config.serverUrl, auth)),
    ]);
    // M3-2a: local runtime-detection result — computed once per `start()`,
    // same as the `conn.hello.runtimes` it also feeds (see `detectRuntimes`'s
    // own doc comment on why this isn't re-probed on every reconnect).
    observer.noteRuntimesDetected(runtimes);
    detectedRuntimeFacts = runtimes;
    const capabilities = computeCapabilities(
      adapters,
      config.agentHome !== undefined,
      config.agentEgress !== undefined,
      agentContentReadPolicies,
    );

    // S3b: this daemon's journal identity — only knowable here, after
    // `auth.loadExisting()` has resolved the deviceId.
    const journalIdentity: JournalIdentity | undefined = config.hostedJournal
      ? { tenantId: record.tenantId, productId: config.productId, deviceId: record.deviceId }
      : undefined;

    /**
     * S3b: outbound send.
     *
     * The no-journal branch is the ORIGINAL closure, character for character —
     * the default path must not gain so much as an extra `await`, or the
     * "opt-in, byte-equivalent by default" claim is only approximately true.
     *
     * The journal branch records a terminal BEFORE it goes on the wire, so a
     * crash in that window leaves the terminal hash locally (to be retried)
     * rather than only in the cloud (§12.7.3's "terminal 生成后、truth 写入前"
     * row). A journal write that FAILS still sends: §12.7.2.1 keeps terminal
     * flush running even under hard pressure, and stranding a finished task on
     * the cloud side because the local bookkeeping hiccupped would be a worse
     * outcome than a missing local row.
     */
    const sendSanitizedEnvelope: TaskRunnerDeps['send'] =
      activeJournal && journalIdentity
        ? (envelope) => {
            observer.handleOutboundEnvelope(envelope);
            const terminalKind = terminalKindOf(envelope.type);
            const taskId = envelope.task_id;
            if (terminalKind === undefined || taskId === undefined) {
              connection?.send(envelope);
              return;
            }
            const payloadHash = journalHash(encodeEnvelope(envelope));
            journalTerminalTail = journalTerminalTail
              .then(() =>
                activeJournal.recordTerminal({
                  taskId,
                  terminalType: terminalKind,
                  payloadHash,
                  truthState: 'pending',
                  attempt: 1,
                  recordedAt: new Date().toISOString(),
                }),
              )
              .catch((err: unknown) => {
                console.warn(
                  `[byok/client] could not record task ${taskId}'s terminal in the local journal (sending it anyway): ${err instanceof Error ? err.message : String(err)}`,
                );
              })
              .then(() => {
                connection?.send(envelope);
              });
          }
        : (envelope) => {
            observer.handleOutboundEnvelope(envelope);
            connection?.send(envelope);
          };
    const sendEnvelope: TaskRunnerDeps['send'] = (candidate) => {
      // The egress policy is additive and applies only to a running
      // task.offer_for_agent_with_egress. Legacy tasks and plain Agent-home
      // offers retain their exact established task.* wire semantics.
      if (candidate.task_id === undefined || runner?.usesAgentEgress(candidate.task_id) !== true) {
        sendSanitizedEnvelope(candidate);
        return;
      }
      const sanitized = sanitizeEgressEnvelope(candidate, egressPolicy, config.agentEgress?.sanitizer);
      if (!sanitized.ok) {
        // Fail closed at the single outbound boundary. In particular, a
        // throwing sanitizer does not leave original candidate bytes on the
        // WS/long-poll queue as a fallback.
        agentEgress.noteTransportDrop(sanitized.reason);
        return;
      }
      sendSanitizedEnvelope(sanitized.envelope);
    };

    const deps: TaskRunnerDeps = {
      adapters,
      runtimeAllowlist: config.runtimeAllowlist,
      // M5 batch-3: see `DaemonConfig.runtimePreference`'s own doc comment above.
      runtimePreference: config.runtimePreference,
      permissionDefaults: config.permissionDefaults,
      workspaceRoot: config.workspaceRoot,
      ...(agentHomeManager === undefined ? {} : { agentHome: agentHomeManager }),
      ...(agentSessionHandoffs === undefined ? {} : { agentSessionHandoffs }),
      deviceId: record.deviceId,
      // M5: see `DaemonConfig.runtimeEnvironment`'s own doc comment above.
      runtimeEnvironment: config.runtimeEnvironment,
      getMcpToolsets: () => toolsetRegistry.snapshot().toolsets,
      // M3-2a: `send` is already this file's OWN closure (not something
      // `TaskRunner` builds) — every `task.claim`/`task.started`/
      // `task.progress`/`task.artifact`/`task.await_approval`/
      // `task.complete`/`task.fail`/`task.decline`/`task.cancelled`
      // `TaskRunner` ever emits passes through here. Feeding the observer
      // first (never throws — see `observer.ts`) and then sending exactly as
      // before is the entire integration; `task-runner.ts` itself is
      // untouched. See `observer.ts`'s module doc comment.
      send: sendEnvelope,
      blobClient,
      batcherOptions: egressBatcherOptions,
      agentEgress,
      ...(config.agentEgress === undefined ? {} : { agentEgressPolicy: egressPolicy }),
      sessionWorkspaces,
      gitWorkspaceManager,
      gitWorkspaceStore,
      onGitWorkspaceEvent: (event) => observer.noteGitWorkspace({
        taskId: event.taskId,
        workspaceId: event.workspaceId,
        phase: event.phase,
        headChanged: event.observation?.headChanged,
        commitsSinceBaseline: event.observation?.commitsSinceBaseline,
        dirty: event.observation ? { staged: event.observation.staged, unstaged: event.observation.unstaged, untracked: event.observation.untracked, conflicted: event.observation.conflicted } : undefined,
        errorCategory: event.errorCategory,
      }),
      onRuntimeDisposalFailure: (event) => observer.noteRuntimeDisposalFailure(event),

      // M4 Phase 3: the SAME `ApprovalRegistry` instance the control
      // socket's own `approvals.list`/`approvals.resolve` methods already
      // share (see that field's own construction above) — `TaskRunner
      // .requestApproval` registers into it directly, so a decision arriving
      // via either the server wire or the local CLI resolves the identical
      // entry. `storeDir`/`productId` let the prepared operation approval channel
      // (populated per-task by `TaskRunner`) tell an out-of-process helper
      // (`bin/byok-approval-mcp.ts`) exactly which control socket to dial.
      approvalRegistry,
      storeDir,
      productId: config.productId,
      // U2 terminal inference usage consumes the one U4a-resolved,
      // process-immutable identity captured above. This is composition-only:
      // TaskRunner receives no config, manifest, or second identity resolver.
      localAgentRelease,
      approvalTimeoutMs: overrides.approvalTimeoutMs,
      // Finding F5(a): see TaskRunnerDeps.shutdownInterruptTimeoutMs's own doc comment.
      shutdownInterruptTimeoutMs: overrides.shutdown?.taskInterruptTimeoutMs,
      // M5 batch-3 (workstream 2): see DaemonConfig.maxTaskOutputBytes's own doc comment — already validated above.
      maxTaskOutputBytes: config.maxTaskOutputBytes,
      // additive-minor (`task.complete.document`): passed through verbatim,
      // absent when unconfigured — see `DaemonConfig.resultDocument`'s own
      // doc comment. Spread rather than assigned so an unconfigured daemon
      // builds the exact `deps` object it did before this seam existed.
      ...(config.resultDocument ? { resultDocument: config.resultDocument } : {}),
      // M4 Phase 3 hardening: bridges TaskRunner's stale-approval-race
      // finding out to the SAME local observability seam every other
      // daemon-local event already uses (see observer.ts's own module doc
      // comment) — TaskRunner itself still has no notion `DaemonObserver`
      // exists, exactly like every other `deps.send`-shaped seam here.
      onStaleApprovalDecision: (taskId, decision, reason) => {
        observer.noteStaleApprovalDecision(taskId, decision, reason);
      },
      // Finding F4: see `TaskRunnerDeps.onApprovalDispatched`'s own doc
      // comment — lets `observer`'s `awaiting-approval` DaemonEvent (and
      // thus `tasks --follow`) surface the approvalId an operator actually
      // needs to call `approve`/`reject`/`approvals` against.
      onApprovalDispatched: (taskId, approvalId) => {
        observer.noteApprovalDispatched(taskId, approvalId);
      },
      // M4 (additive-minor, `task.approval_resolved`): read fresh at call
      // time via `connection` (assigned just below — safe by the time this
      // is actually invoked, same closure pattern `send` above already
      // relies on) rather than captured once here, since the negotiated
      // capability is only known once the handshake completes, strictly
      // after this `deps` object is constructed.
      getServerCapabilities: () => connection?.getServerCapabilities() ?? [],
      // S3b (L-003): the production admission guard — §12.7.2.1's hard-pressure
      // row. Reads the state the last maintenance tick computed (no disk work
      // on the offer path), and is absent entirely when no storage policy is
      // configured, which is what keeps `handleOffer` byte-identical for every
      // daemon that does not opt in.
      ...(activePressureEngine ? { admissionGuard: () => activePressureEngine.admissionGuard() } : {}),
    };
    runner = new TaskRunner(deps);
    const handleAgentEgressEnvelope = async (envelope: Envelope): Promise<boolean> => {
      if (envelope.type !== 'agent.egress.ack') return false;
      if (config.agentEgress === undefined) return true;
      await agentEgress.acknowledge({ ...envelope.payload, tenantId: record.tenantId });
      return true;
    };
    const handleAgentContentReadEnvelope = async (envelope: Envelope): Promise<boolean> => {
      if (envelope.type !== 'agent.content.read') return false;
      // This build could not have advertised a content-read capability without
      // both authorities. A stale or malicious sender gets no implicit local
      // path, tenant, or receipt synthesized from incomplete identity.
      if (config.agentEgress === undefined || agentHomeManager === undefined || agentSessionHandoffs === undefined) {
        return true;
      }

      const payload = envelope.payload;
      const session: AgentContentSessionIdentity = Object.freeze({
        agentRef: payload.agentRef,
        sessionRef: payload.sessionRef,
        runtimeId: payload.runtime,
        cwd: payload.cwd,
      });
      const canonicalHome = (await agentHomeManager.layout.resolve(payload.agentRef)).canonicalHome;
      const exactWirePolicy =
        payload.policyRevision === egressPolicy.policyRevision &&
        hasExactContentReadTransfer(egressPolicy.transfers[payload.surface], payload.policy);
      const policies = exactWirePolicy
        ? agentContentReadPolicies
        : policyRevisionMismatchPolicies(agentContentReadPolicies, payload.surface);
      const policyEngine = new AgentContentReadPolicyEngine({
        agentHomeLayout: agentHomeManager.layout,
        policies,
        capabilities,
        ...(config.agentEgress.contentRead?.runtimeAllowlistedRoots === undefined
          ? {}
          : { runtimeAllowlistedRoots: config.agentEgress.contentRead.runtimeAllowlistedRoots }),
        // `requireMatch` is the only session authority for every surface. A
        // wire cwd must be the exact canonical Agent home before any bytes can
        // be read; there is no workspace/artifact exception.
        resolveSessionIdentity: async (request) => {
          const requestedSession = request.session;
          if (requestedSession === undefined) return undefined;
          if (requestedSession.cwd !== canonicalHome) return undefined;
          const handoff = await agentSessionHandoffs.requireMatch({
            agentRef: request.agentRef,
            sessionRef: requestedSession.sessionRef,
            runtimeId: requestedSession.runtimeId,
            cwd: requestedSession.cwd,
          });
          if (handoff.cwd !== canonicalHome) return undefined;
          return Object.freeze({
            agentRef: handoff.agentRef,
            sessionRef: handoff.sessionRef,
            runtimeId: handoff.runtimeId,
            cwd: handoff.cwd,
          });
        },
        // This factory derives the SDK-owned address solely from the canonical
        // AgentHomeLayout resolution and shares its writer queue with every
        // same-Agent envelope in this daemon process.
        auditStore: AgentContentAuditStore.forCanonicalAgentHome(canonicalHome),
      });
      const result = await policyEngine.read({
        requestId: payload.requestId,
        actor: payload.actor,
        tenantId: record.tenantId,
        deviceId: record.deviceId,
        agentRef: payload.agentRef,
        surface: payload.surface,
        relativeTarget: payload.target,
        mimeType: payload.mimeType,
        capability: AGENT_CONTENT_READ_CAPABILITIES[payload.surface],
        policyRevision: payload.policyRevision,
        maxBytes: payload.policy.maxBytes,
        allowedMimeTypes: payload.policy.allowedMimeTypes,
        decodeAs: payload.decodeAs,
        session,
      });

      const receipt = {
        requestId: payload.requestId,
        surface: payload.surface,
        actor: payload.actor,
        agentRef: payload.agentRef,
        sessionRef: payload.sessionRef,
        runtime: payload.runtime,
        cwd: payload.cwd,
        policyRevision: payload.policyRevision,
        target: payload.target,
        mimeType: payload.mimeType,
        decodeAs: payload.decodeAs,
      } as const;
      const appendAndDispatchContentReceipt = async (
        contentReceipt: AgentContentReceiptWithoutReliableIdentity,
      ): Promise<void> => {
        const appended = await agentEgress.appendContentReceipt({
          homeDir: canonicalHome,
          agentRef: payload.agentRef,
          payload: contentReceipt,
        });
        if (!appended.ok) {
          // Throwing keeps the inbound request unacknowledged, so the server
          // redelivers rather than treating a non-durable content decision as
          // complete or silently moving it to latest-value activity.
          throw new Error(`content receipt could not enter reliable spool: ${appended.reason}`);
        }
        dispatchReliableRecord(appended.record);
      };
      if (result.decision === 'deny') {
        await appendAndDispatchContentReceipt({
          ...receipt,
          decision: 'denied',
          byteCount: 0,
          reason: result.reason,
        });
        return true;
      }

      // A committed audit receipt plus this requestId-stable blob reservation
      // makes a crash/redelivery retry the same upload rather than minting a
      // second cloud object.
      const blobRef = await blobClient.uploadArtifact(result.content, payload.mimeType, {
        idempotencyKey: payload.requestId,
      });
      await appendAndDispatchContentReceipt({
        ...receipt,
        decision: 'allowed',
        byteCount: result.byteCount,
        contentHash: `sha256:${result.contentHash}`,
        blobRef,
      });
      return true;
    };

    connection = new ConnectionManager({
      serverUrl: config.serverUrl,
      deviceId: record.deviceId,
      productId: config.productId,
      capabilities,
      clientVersion: localAgentRelease.version,
      runtimes,
      getConfiguredToolsets: () => toolsetRegistry.snapshot().configuredToolsets,
      auth,
      cursorStore,
      // Finding F3: return (not void-and-forget) so ConnectionManager can
      // await this handler and only advance/persist its redelivery cursor
      // once it actually resolves — see connection-manager.ts's `process`.
      // M3-2a: also this file's own closure, unrelated to F3's redelivery
      // semantics above — `handleInboundEnvelope` only ever looks at
      // `task.offer` (the one event with no corresponding outbound envelope
      // of its own) and never throws, so it can't affect cursor advancement.
      // S3b (L-002): where "ack after durable commit" stops being a
      // discipline and becomes the only expressible behaviour.
      //
      // `ConnectionManager.process` advances (and persists) the redelivery
      // cursor ONLY when this handler resolves, and merely records a stall
      // when it throws (`connection-manager.ts`) — that was already true, and
      // is not changed by this slice. Putting the journal transaction INSIDE
      // this handler therefore makes the ordering structural: the cursor
      // cannot move past a seq whose envelope is not yet committed, because
      // the only thing that moves the cursor is this function resolving, and
      // this function does not resolve until the commit does. There is no
      // second path to the cursor to keep in step, and the transport is
      // untouched.
      //
      // Placed after the observer (which never throws and owns no durable
      // state) and before the runner, so the bytes are on disk before any
      // work is scheduled off them. A redelivered envelope is absorbed by the
      // journal's own receipt and costs one no-op transaction.
      //
      // The no-journal branch is the ORIGINAL closure, unchanged.
      onEnvelope:
        activeJournal && journalIdentity
          ? async (envelope) => {
              if (tenantRebinding) {
                throw new Error('tenant enrollment is being re-paired; inbound work is blocked until restart');
              }
              observer.handleInboundEnvelope(envelope);
              if (await handleAgentEgressEnvelope(envelope)) return;
              if (await handleAgentContentReadEnvelope(envelope)) return;
              // S3b (L-003): §12.7.2.1's `emergency` row — "fail-closed，不 ack
              // 新 mailbox row；保留现有 recovery evidence". Throwing HERE, ahead
              // of the append, reuses the ordering the journal branch already
              // established: the handler rejects, so the cursor does not move,
              // so the mailbox keeps the row and redelivers it later. The task
              // is not lost; it is left in the one place that still has room
              // for it. Nothing is deleted to make space.
              activePressureEngine?.assertAckCriticalAllowed();
              await activeJournal.appendEnvelope(toJournalEnvelopeRecord(envelope, journalIdentity));
              return runner?.handleEnvelope(envelope) ?? Promise.resolve();
            }
          : (envelope) => {
              if (tenantRebinding) {
                return Promise.reject(new Error('tenant enrollment is being re-paired; inbound work is blocked until restart'));
              }
              observer.handleInboundEnvelope(envelope);
              if (envelope.type === 'agent.egress.ack') return handleAgentEgressEnvelope(envelope).then(() => undefined);
              if (envelope.type === 'agent.content.read') return handleAgentContentReadEnvelope(envelope).then(() => undefined);
              return runner?.handleEnvelope(envelope) ?? Promise.resolve();
            },
      onStateChange: (state) => {
        // A connection that re-settles (a fresh WS ack, or long-poll taking
        // over) is the one moment this daemon knows it may be talking to a
        // different deployment build than it last read a declaration from —
        // so it is also where re-discovery belongs. `runPresenceDiscovery` is
        // a no-op before `startPresenceProducer` arms it and after shutdown
        // disarms it, so the initial settle during `start()` is not a second
        // discovery pass.
        const wasSettled = connectionState === 'open' || connectionState === 'degraded';
        connectionState = state;
        observer.noteConnectionState(state);
        if (!wasSettled && (state === 'open' || state === 'degraded')) runPresenceDiscovery();
      },
      backoff: overrides.backoff,
      liveness: overrides.liveness,
      wsFailureThreshold: overrides.longPoll?.wsFailureThreshold,
      wsRetryIntervalMs: overrides.longPoll?.wsRetryIntervalMs,
      longPollRetryDelayMs: overrides.longPoll?.retryDelayMs,
      longPollIdleDelayMs: overrides.longPoll?.idleDelayMs,
      fleetJitter,
      onOperationalOutcome: (outcome, source) => {
        const write = outcome === 'success'
          ? operationalHealth.recordSuccess(source)
          : operationalHealth.recordFailure(source);
        void write.catch((err: unknown) => {
          console.warn(`[byok/client] failed to persist operational health: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
    });
    await connection.start();
    await connection.waitForAck();
    for (const record of agentEgress.retryableReliableRecords(connection.getServerCapabilities())) {
      dispatchReliableRecord(record);
    }
    startPresenceProducer();
    daemonStarted = true;
    } catch (err) {
      try {
        // startUnderLease already owns the process-local lifecycle slot. Run
        // teardown directly; queueing requestShutdown here would wait on this
        // operation itself and deadlock.
        await runShutdownSequence('startup failed', { drainTimeoutMs: 0 });
      } catch (cleanupError) {
        throw new AggregateError([err, cleanupError], 'daemon startup failed and teardown was incomplete');
      }
      throw err;
    }
  }

  /**
   * Arms capability discovery for this `start()` and runs the first pass.
   * The controller lives for the whole run, so every later re-discovery
   * (see `runPresenceDiscovery`) is cancelled by the same shutdown abort.
   */
  function startPresenceProducer(): void {
    presenceDiscovery = new AbortController();
    runPresenceDiscovery();
  }

  /**
   * ADR-010's client half: read the deployment's declaration, and run the
   * presence heartbeat if and only if it contains `presence.hints`.
   *
   * Run on start AND on every connection re-settle (the `onStateChange` hook
   * above), because a declaration is a deployment fact that a rollout can
   * change under a long-lived daemon — and because that is also the only
   * healing path a startup discovery failure gets. There is deliberately NO
   * retry timer of its own: a failed pass simply leaves presence off until the
   * next reconnect, which is the one event that already means "this deployment
   * may not be the same one I last talked to".
   *
   * Deliberately NOT awaited by `startUnderLease` — the plan's "discovery is
   * asynchronous to the connection path" rule. A deployment that is slow to
   * answer (or never answers) must cost this daemon nothing but presence: no
   * capability here is on the task path, so there is no state a caller of
   * `start()` could need this for.
   *
   * Every failure is fail-closed and observable: the publisher stays off and a
   * single `console.warn` records why, matching the operator-facing warning
   * convention the rest of this file already uses. There is no fallback branch
   * — no "assume the usual capabilities", no 404-means-unsupported reading —
   * because a declaration that could not be read is exactly as informative as
   * one that declares nothing.
   */
  function runPresenceDiscovery(): void {
    const discovery = presenceDiscovery;
    // Not started (or already torn down), or a pass is still in flight — a
    // reconnect storm must not stack discovery requests on a deployment.
    if (!discovery || presenceDiscoveryInFlight) return;
    presenceDiscoveryInFlight = true;
    void (async () => {
      try {
        const declaration = await fetchCapabilityDeclaration(config.serverUrl, { signal: discovery.signal });
        // Shutdown may have run while the declaration was in flight; starting a
        // heartbeat after teardown would leave a timer nothing stops.
        if (discovery.signal.aborted) return;
        if (declares(declaration, PRESENCE_HINTS_CAPABILITY)) {
          // One publisher per `start()`, reused across reconnects: its
          // revoked latch is a device-level fact, so a fresh declaration must
          // never resurrect a publisher a revocation stopped.
          presencePublisher ??= new PresencePublisher({
            serverUrl: config.serverUrl,
            auth,
            getConfiguredToolsets: () => toolsetRegistry.snapshot().configuredToolsets,
            clientVersion: localAgentRelease.version,
            protocolVersions: [PROTOCOL_VERSION],
            runtimes: detectedRuntimeFacts,
            ...presenceCadence,
            onDegraded: (reason) => console.warn(`[byok/client] ${reason}`),
          });
          presencePublisher.start();
        } else {
          // The deployment withdrew the capability. A clean stop, not a
          // permanent one: a later rollout that declares it again is free to
          // start this same publisher back up.
          presencePublisher?.stop();
        }
      } catch (err) {
        if (discovery.signal.aborted) return;
        console.warn(
          `[byok/client] capability discovery failed; presence publishing stays off until the next reconnect: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        presenceDiscoveryInFlight = false;
      }
    })();
  }

  /**
   * M5 batch-3 (workstream 2): the ONE graceful-shutdown sequence, shared by
   * every path that stops this daemon while it might have active tasks —
   * closes the M5 ledger item "SIGTERM path doesn't send task.fail". Before
   * this, `stop()` and `performControlShutdown` were two INDEPENDENT
   * implementations: `stop()` just dropped the connection outright with no
   * notion of active tasks at all, so the OS-signal path
   * (`bin/commands/start.ts`'s SIGINT/SIGTERM handler -> this daemon's own
   * public `stop()`) never sent `task.fail` for whatever was still running.
   * Now there is exactly one teardown sequence, and every caller (`stop()`,
   * `unpair()` via `stop()`, and `performControlShutdown`) shares it: stop
   * accepting new offers -> best-effort interrupt+fail every active task,
   * over the STILL-OPEN connection (`TaskRunner.shutdownActiveTasks`,
   * deadline-bounded by `config.shutdownGraceMs` — default
   * `SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS` — so a hung task teardown can never
   * block this daemon from actually stopping) -> bounded wait for that
   * outbox to actually drain (finding F5(b)) -> close the connection / stop
   * the auth renewal timer / stop serving control RPCs -> release the
   * store-mutation lease -> remove the control socket/token files (that last
   * split is an ordering INVARIANT, not a detail — see the comment at the
   * end of this function).
   *
   * CRITICAL preservation (M4 Phase 2 fix, unchanged by this refactor): the
   * connection must not close until AFTER `shutdownActiveTasks` has actually
   * enqueued its `task.fail`(s) — see `performControlShutdown`'s own doc
   * comment for the exact regression (`start.ts` used to wake on the earlier
   * `shutdown-requested` event and race `daemon.stop()` ahead of the
   * still-in-flight send) this ordering fixes. That ordering is unchanged
   * here: stopAcceptingOffers -> shutdownActiveTasks -> THEN connection
   * teardown, for every caller alike, including the OS-signal path that
   * previously skipped straight to connection teardown.
   *
   * Idempotent: a second call (e.g. `performControlShutdown`'s own internal
   * call, followed by `bin/commands/start.ts`'s subsequent `daemon.stop()`
   * once `shutdown-complete` wakes it — see that file's own doc comment)
   * finds `runner`'s active-task map already empty (the first call's own
   * `finish()`s already deleted every entry), so `shutdownActiveTasks` sends
   * nothing the second time; `stopAcceptingOffers` is already idempotent by
   * its own contract; `connection.stop()` is documented idempotent
   * (`connection-manager.ts`); and `controlServerHandle` is reassigned to
   * `undefined` after the first close, so a second call's `?.close()` is a
   * no-op. (When the first call kept the lease — see the split teardown at
   * the end of this function — the handle deliberately survives instead,
   * already stopped serving; both of its stages are themselves idempotent,
   * so the retry that finally releases the lease is what removes the
   * socket/token files.) See `daemon-control-socket.test.ts`'s "REGRESSION
   * (gatekeeper-caught)" test for exactly this double-teardown shape (a
   * control-socket shutdown followed by `runStartCommand`'s own
   * `daemon.stop()`), which must neither double-fail a task nor throw.
   */
  async function runShutdownSequence(reason: string, opts: { drainTimeoutMs?: number } = {}): Promise<void> {
    // Plan `device-assertion-broker` (codex F1): the assertion-minting latch is
    // armed at the top of THIS function, synchronously, before the first
    // `await` below. This is the single choke point EVERY teardown path crosses
    // — the control-socket `shutdown` RPC, the public `daemon.stop()`, and
    // `unpair()` all funnel here — so arming it here means `stop()`/`unpair()`
    // close the minting window too, not only the RPC. The RPC handler
    // additionally arms it before its own `setImmediate` defer (see
    // `controlMethods.shutdown`) so a pipelined `shutdown`+`assertion.issue`
    // batch cannot mint in the gap between the RPC returning and this function
    // being scheduled. Latched, never cleared.
    shuttingDown = true;
    const errors: unknown[] = [];
    let mutationBarrierComplete = hostedStorageInitializationBarrierComplete;
    if (!hostedStorageInitializationBarrierComplete) {
      errors.push(new Error('hosted storage initialization left an unclosed SQLite handle; ownership lease retained'));
    }
    const attempt = async (operation: () => void | Promise<void>, mutationBarrier: boolean): Promise<boolean> => {
      try {
        await operation();
        return true;
      } catch (err) {
        errors.push(err);
        if (mutationBarrier) mutationBarrierComplete = false;
        return false;
      }
    };

    // A prior shutdown attempt may have hit its deadline while task teardown
    // continued in the background. A retry must not release ownership merely
    // because its own fresh runner pass is empty: the late pass is still a
    // possible journal producer until it settles.
    if (pendingLateMutationBarriers.size > 0) {
      const prior = Promise.allSettled([...pendingLateMutationBarriers]);
      let priorSettled = false;
      void prior.then(() => {
        priorSettled = true;
      });
      const graceMs = config.shutdownGraceMs ?? SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS;
      await Promise.race([prior, delay(graceMs)]);
      if (!priorSettled) {
        mutationBarrierComplete = false;
        errors.push(new Error('a prior active task teardown remains unsettled; ownership lease retained'));
      }
    }

    // S3b (L-003): stop the maintenance cadence first — a compaction pass
    // starting while the journal is being drained would hold the single writer
    // against the terminal writes below for no benefit. Only the engine THIS
    // daemon constructed; an injected one belongs to its injector, exactly like
    // an injected journal is not closed here. Idempotent, like every other step
    // in this sequence.
    // Stop beating first, and cancel a discovery that has not resolved yet.
    // Nothing downstream depends on either, and both are pure timers/sockets —
    // no mutation barrier, no errors to collect. Stopping IS this daemon's
    // offline signal: the hosted hint carries a TTL and expiry means absence,
    // so no `offline` publish is (or may be) issued here. Both are idempotent,
    // like every other step in this sequence.
    presenceDiscovery?.abort();
    presenceDiscovery = undefined;
    // A fetch that ignores the abort and stalls would otherwise leave this
    // latch true forever, silently swallowing every re-discovery a LATER
    // `start()` asks for.
    presenceDiscoveryInFlight = false;
    presencePublisher?.stop();
    presencePublisher = undefined;
    const stoppingOwnedPressureEngine = ownedPressureEngine;
    const stoppingOwnedJournal = ownedJournal;
    const maintenanceStopped = stoppingOwnedPressureEngine?.stop() ?? Promise.resolve();
    await attempt(() => runner?.stopAcceptingOffers(), true);
    const activeTeardown = runner?.shutdownActiveTasks(reason) ?? Promise.resolve();
    const graceMs = config.shutdownGraceMs ?? SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS;
    let activeTeardownSettled = false;
    const observedActiveTeardown = activeTeardown.then(
      () => {
        activeTeardownSettled = true;
      },
      (err: unknown) => {
        activeTeardownSettled = true;
        throw err;
      },
    );
    await attempt(() => Promise.race([observedActiveTeardown, delay(graceMs)]), true);
    if (!activeTeardownSettled) {
      mutationBarrierComplete = false;
      errors.push(new Error('active task teardown did not settle before the shutdown grace deadline'));
      pendingLateMutationBarriers.add(observedActiveTeardown);
      void observedActiveTeardown.finally(() => pendingLateMutationBarriers.delete(observedActiveTeardown)).catch(() => undefined);
    }
    // S3b: in hosted mode, a terminal is journaled before it is handed to the
    // outbox (see `sendEnvelope`), so a `task.fail` that `shutdownActiveTasks`
    // just produced may still be mid-chain right now. Awaiting the chain here
    // — before the drain wait below, which is what decides the connection is
    // idle — is what keeps that fail from being written into an outbox nobody
    // is draining any more. Exactly a no-op when no journal is configured.
    const journalTailSettled = journal ? await attempt(() => journalTerminalTail, true) : true;
    // stop() cleared the maintenance timer synchronously above. Await the pass
    // that may already have been inside SQLite only here, immediately before
    // closing the owned journal, so task interruption is not held behind a
    // slow checkpoint while the journal-close race remains impossible.
    const maintenanceSettled = await attempt(() => maintenanceStopped, true);
    // Finding F5(b): bounded wait for the outbox (e.g. the task.fail(s)
    // shutdownActiveTasks just enqueued) to actually drain before closing
    // the connection out from under it — see ConnectionManager.stop's own
    // doc comment for why an unbounded wait wasn't safe to make the
    // universal default, and ConnectionManager.outboxLength's own doc
    // comment for the honest-audit read a caller may take afterward.
    const drainTimeoutMs =
      opts.drainTimeoutMs ?? overrides.shutdown?.outboxDrainTimeoutMs ?? DEFAULT_SHUTDOWN_OUTBOX_DRAIN_TIMEOUT_MS;
    const connectionStopped = await attempt(() => connection?.stop(drainTimeoutMs), true);
    // Close the owned journal only after every producer has stopped: active
    // task teardown and its terminal tail settled, maintenance settled, and
    // the connection can no longer deliver a new inbound envelope. Closing it
    // earlier would let a failed/slow connection shutdown append into a closed
    // database after this function released the store lease.
    if (activeTeardownSettled && journalTailSettled && maintenanceSettled && connectionStopped) {
      const journalClosed = await attempt(() => stoppingOwnedJournal?.close(), true);
      if (journalClosed) {
        if (journal === stoppingOwnedJournal) journal = undefined;
        if (ownedJournal === stoppingOwnedJournal) ownedJournal = undefined;
        if (pressureEngine === stoppingOwnedPressureEngine) pressureEngine = undefined;
        if (ownedPressureEngine === stoppingOwnedPressureEngine) ownedPressureEngine = undefined;
      }
    } else if (stoppingOwnedJournal) {
      mutationBarrierComplete = false;
    }
    await attempt(() => auth.stop(), true);
    connectionState = 'closed';
    // M4 Phase 2: stop the control socket in every shutdown path — this is
    // the single lifecycle choke point every caller (a foreground abort via
    // `bin/commands/start.ts`, `unpair()` below, and the control socket's
    // OWN `shutdown` RPC — see `performControlShutdown`) already funnels
    // through, so nothing else needs its own control-socket teardown logic.
    //
    // Plan `shutdown-lease-order`: that teardown is SPLIT around the lease
    // release, and the order below is the invariant, not an implementation
    // detail. The control socket/token files are this daemon's only external
    // liveness signal — `bin/control-client.ts`'s `isControlDaemonGone`
    // (which `bin/commands/unpair.ts` polls, and every contender's own
    // "is it gone yet" check mirrors) reads exactly "token file gone AND a
    // connect refused". Removing them while this daemon still holds the
    // store-mutation lease publishes "exited" to a contender whose immediate
    // `acquireDaemonOwner` then hits the still-bound mutex and is refused
    // with `DaemonOwnerActiveError('unknown')` — a measured 11-46ms window
    // (CI job 94465898325's intermittent `ipc-smoke` failure). So:
    // stop serving RPCs, release the lease, and only then remove the files.
    //
    // Stage 1 keeps the mutation-barrier coupling the combined close() had:
    // a stop-serving failure means a control RPC may still be in flight
    // against this store, i.e. a possible residual writer, and the lease
    // must be retained for it.
    await attempt(async () => {
      await controlServerHandle?.stopServing();
    }, true);
    if (mutationBarrierComplete && daemonOwnerLease) {
      await attempt(() => operationalHealth.markCleanStop(), false);
      await attempt(async () => {
        await daemonOwnerLease?.release();
        daemonOwnerLease = undefined;
      }, false);
    }
    // Stage 2, the last observable act of this daemon, and gated on the ONE
    // condition that makes "gone" honest: this process no longer holds the
    // lease. That gate also fixes the `mutationBarrierComplete === false`
    // branch, which used to remove the signal (publishing "exited") while
    // deliberately retaining the lease forever — the combination that turned
    // `unpair`'s intended `UnpairExitUnconfirmedError` into a confusing
    // `DaemonOwnerActiveError` from its post-exit reacquire. Keeping the
    // files in place instead leaves `isControlDaemonGone` false, so unpair's
    // exit poll times out and fails closed with its own typed error, exactly
    // as its "unknown state is unsafe" contract intends. Same gate covers a
    // failed `release()`: the lease is still held, so nothing is published.
    if (daemonOwnerLease === undefined) {
      await attempt(async () => {
        await controlServerHandle?.close();
        controlServerHandle = undefined;
      }, false);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'daemon shutdown completed with errors');
    }
    if (!mutationBarrierComplete) {
      // Defensive invariant: every mutation-barrier failure is recorded above.
      // Keep the lease if that invariant is ever violated rather than allowing
      // doctor or a second daemon to overlap a residual writer.
      throw new Error('daemon shutdown mutation barrier is incomplete; ownership lease retained');
    }
    daemonStarted = false;
  }

  /**
   * Public `Daemon.stop()` (also `unpair()`'s own teardown, below) — see
   * `runShutdownSequence`'s own doc comment for the sequence this now runs.
   * `opts` is an internal-only extension of the public `stop(): Promise<void>`
   * interface (this file already has the analogous `performControlShutdown`
   * convention of calling this closure directly with extra options a plain
   * `Daemon.stop()` caller never needs to pass): `performControlShutdown`
   * below supplies its own `reason` instead of this default.
   */
  async function stop(opts: { drainTimeoutMs?: number; reason?: string } = {}): Promise<void> {
    // Plan `device-assertion-broker` (codex round-2 F1): arm the minting latch
    // the INSTANT `stop()` is called, before `requestShutdown` enqueues the
    // teardown behind any in-progress lifecycle mutation. `runShutdownSequence`
    // sets it too, but that runs only AFTER `runLifecycleMutation` awaits its
    // predecessor — so a `stop()` queued behind an in-progress `start()`/
    // `pair()` would otherwise leave the control socket minting with
    // `shuttingDown === false` for the whole duration of that predecessor.
    // Setting it here, synchronously, before the first await, closes that gap.
    shuttingDown = true;
    await requestShutdown(opts.reason ?? 'operator', { drainTimeoutMs: opts.drainTimeoutMs });
  }

  function requestShutdown(reason: string, opts: { drainTimeoutMs?: number } = {}): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    const current = runLifecycleMutation(() => runShutdownSequence(reason, opts));
    shutdownPromise = current;
    void current.finally(() => {
      if (shutdownPromise === current) shutdownPromise = undefined;
    }).catch(() => undefined);
    return current;
  }

  /**
   * M3-2a: clears this device's persisted identity and disconnects. Safe at
   * any point in the lifecycle:
   *  - `stop()` is a no-op beyond clearing state if `start()` was never
   *    called (`connection` stays `undefined`; `auth.stop()` on a
   *    never-renewed `AuthManager` just no-ops its unset timer).
   *  - `store.clear()` (`fs.rm(..., { force: true })`) is a no-op if this
   *    device was never paired.
   * Reads the on-disk record BEFORE clearing (mirrors `pair()`'s own F5
   * pattern above) so the cursor hygiene cleanup below knows which device's
   * entry to remove; rebuilding `auth` (see `buildAuthManager`) is what
   * actually makes the NEXT `start()` require a fresh `pair()` — clearing
   * `store` alone would leave a same-process `AuthManager`'s cached
   * in-memory record still usable.
   */
  async function unpair(): Promise<void> {
    // codex round-2 F1: same synchronous arming as `stop()` above — an `unpair`
    // queued behind an in-progress `start()`/`pair()` must not leave the socket
    // minting while it waits its turn in the lifecycle queue. Unpair is the
    // exact path where this matters most: it tears the daemon down and then
    // clears `device.json`, so any assertion minted in the queue-wait window
    // would be for a device that is being unpaired.
    shuttingDown = true;
    await runLifecycleMutation(unpairUnderLease);
  }

  async function unpairUnderLease(): Promise<void> {
    // The outer lifecycle slot prevents pair/start/control shutdown from
    // entering while teardown and destructive credential cleanup span two
    // cross-process lease acquisitions.
    await runShutdownSequence('operator');
    // stop() releases only after every daemon writer settles. Reacquire before
    // destructive identity cleanup; if another daemon won the gap, fail
    // closed rather than clearing state under it.
    const cleanupLease = await acquireDaemonOwner(storeDir, 'daemon');
    try {
      // The identity being removed is read under the same lease as both the
      // device and cursor mutations. A pair that wins stop()'s release gap is
      // therefore either wholly before this cleanup (and is fully removed) or
      // wholly after it; stale pre-lease identity can never drive cleanup.
      const current = await store.remove();
      if (current) {
        await cursorStore.clear(config.serverUrl, current.deviceId);
      }
    } finally {
      await cleanupLease.release();
    }
    auth = buildAuthManager();
    observer.noteUnpaired();
  }

  /**
   * M3-2a: local approve/reject — see the `Daemon` interface's own doc
   * comments on {@link Daemon.approve}/{@link Daemon.reject} for the full
   * rationale (honest-but-currently-unexercised; every bundled adapter's
   * `resolveApproval` throws unconditionally today). Constructs the exact
   * envelope shape a server-sent `task.approve`/`task.reject` would be and
   * feeds it straight to `runner.handleEnvelope` — `TaskRunner`'s only public
   * entry point — rather than reaching into its private `handleApprove`/
   * `handleReject`. `seq: 0` is an inert local sentinel: this call never
   * passes through `ConnectionManager`, so nothing ever reads it as a real
   * redelivery cursor value, and `TaskRunner` itself only ever reads
   * `task_id`/`payload` off an approve/reject envelope, never `seq`.
   */
  async function approve(taskId: string): Promise<void> {
    if (!runner) throw new Error('daemon is not started; call start() first');
    await runner.handleEnvelope(createEnvelope('task.approve', {}, { taskId, seq: 0 }));
  }

  async function reject(taskId: string, reason?: string): Promise<void> {
    if (!runner) throw new Error('daemon is not started; call start() first');
    await runner.handleEnvelope(createEnvelope('task.reject', { reason }, { taskId, seq: 0 }));
  }

  // -------------------------------------------------------------------------
  // M4 Phase 2: control socket method registry (`control-server.ts` is
  // daemon-agnostic; this is the glue that closes over THIS daemon
  // instance's own state). Built once; every handler below reads `runner`/
  // `connection`/`connectionState`/`auth` fresh at CALL time via normal JS
  // closure semantics, so it stays correct across this daemon's own
  // start()/stop() cycles.
  // -------------------------------------------------------------------------

  function buildControlStatus(): ControlStatusResult {
    const snapshot = pressureEngine?.snapshot();
    const storageStatus: ControlStorageStatus | undefined =
      snapshot === undefined
        ? undefined
        : {
            pressureState: snapshot.state,
            budgetBytes: snapshot.budgetBytes,
            usedBytes: snapshot.usedBytes,
            freeBytes: snapshot.freeBytes,
            measuredAt: snapshot.measuredAt,
            categories: (Object.keys(snapshot.categories) as StorageCategory[])
              .sort()
              .map((category) => ({
                category,
                bytes: snapshot.categories[category].bytes,
                approximate: snapshot.categories[category].approximate,
              })),
            ...(snapshot.lastCompaction
              ? {
                  lastCompaction: {
                    checkpointed: snapshot.lastCompaction.checkpointed,
                    walFramesRemaining: snapshot.lastCompaction.walFramesRemaining,
                    pagesVacuumed: snapshot.lastCompaction.pagesVacuumed,
                    durationMs: snapshot.lastCompaction.durationMs,
                    at: snapshot.lastCompaction.at,
                  },
                }
              : {}),
          };
    const activeTasks: ControlActiveTask[] = observer
      .tasks()
      .filter((task) => TASK_TRANSITIONS[task.state].length > 0) // non-terminal only — see the `status` method's own doc comment (control-protocol.ts)
      .map((task) => ({ taskId: task.taskId, state: task.state }));
    // Finding F4: computed once and reused for both `approvals` (the actual
    // entries, so `status`'s live section can render approvalIds without a
    // second control-socket round trip) and `approvalsPending` (the same
    // list's count) — same source `approvals.list` itself calls.
    const pendingApprovals = approvalRegistry.list();
    return {
      localAgentRelease,
      pid: process.pid,
      uptimeMs: startedAt !== undefined ? Date.now() - startedAt : 0,
      paired: auth.deviceId !== undefined,
      deviceId: auth.deviceId,
      transport: connectionState,
      activeTasks,
      runtimeIds: adapters.map((adapter) => adapter.descriptor.id),
      // M4 Phase 4 (part B.3): queue watermarks come from TaskRunner's own
      // active-task map (distinct from `observer.tasks()` above, which is
      // derived from the envelope feed) — see `TaskRunner.getQueueWatermarks`'s
      // own doc comment for why this is a progress-batcher-backlog +
      // in-flight-approval-count proxy rather than the adapter's own event
      // queue depth.
      queueWatermarks: runner?.getQueueWatermarks() ?? [],
      approvals: pendingApprovals,
      approvalsPending: pendingApprovals.length,
      // S3b (L-003): the storage section, present only when a policy is
      // configured AND a measurement has actually happened. An engine that has
      // never ticked reports nothing rather than a zeroed snapshot — "not
      // measured" and "measured, and empty" are different facts, and a status
      // surface that conflates them is how an operator concludes a full disk is
      // fine.
      ...(storageStatus === undefined ? {} : { storage: storageStatus }),
      operationalHealth: operationalHealth.snapshot(),
      toolsets: toolsetRegistry.status(),
    };
  }

  /**
   * The control socket's `shutdown` RPC — see this method's own protocol
   * doc comment (`control-protocol.ts`'s `ShutdownParams`) for the wire
   * contract. M5 batch-3 (workstream 2): delegates the actual teardown
   * sequence to `runShutdownSequence` — see that function's own doc comment
   * for the full "stop accepting -> fail active tasks -> drain -> close"
   * sequence every graceful-shutdown path now shares — and wraps it with
   * this RPC's own audit events. Invoked from the RPC handler via
   * `setImmediate` (see `controlMethods` below) so the `{acknowledged:true}`
   * response has already been written to the wire before any of this runs.
   *
   * Gatekeeper-confirmed regression (fixed pre-M5; PRESERVED, not
   * reintroduced, by this refactor): `noteShutdownRequested` fires
   * SYNCHRONOUSLY, before `shutdownActiveTasks` even calls
   * `session.interrupt()` — `observer.emit()` calls its listeners
   * synchronously, so `bin/commands/start.ts`'s subscriber used to be woken
   * IMMEDIATELY, race ahead, and call `daemon.stop()` (which sets
   * `ConnectionManager.stopped = true` synchronously) before the active
   * task's `task.fail` was ever sent — silently stranding it in a
   * post-`stopped` outbox that `drainOutbox` refuses to flush. Fixed by
   * emitting a SEPARATE, later `shutdown-complete` event only once
   * `runShutdownSequence` below has fully resolved — `start.ts` now waits
   * for that one instead, so it can never race ahead of this function's own
   * internal ordering. `shutdown-requested` is kept as an earlier,
   * informational-only audit marker; nothing may gate teardown decisions on
   * it. The ordering itself (stopAcceptingOffers -> shutdownActiveTasks ->
   * THEN connection teardown) now lives inside `runShutdownSequence` rather
   * than duplicated in this function's own body, but the observable
   * guarantee `start.ts` depends on — `shutdown-complete` fires only after
   * every active task's `task.fail` has actually been enqueued and the
   * connection has begun closing — is unchanged.
   */
  async function performControlShutdown(reason: ShutdownReason | undefined): Promise<void> {
    const effectiveReason = reason ?? 'operator';
    // Plan `device-assertion-broker` (codex F1): belt-and-suspenders re-arm of
    // the minting latch. The `shutdown` RPC handler already set it
    // synchronously before deferring this function, and `runShutdownSequence`
    // (called below, via `requestShutdown`) sets it again — but re-asserting it
    // here keeps this function correct on its own terms regardless of how it is
    // reached, and setting an already-`true` boolean is free.
    shuttingDown = true;
    observer.noteShutdownRequested(effectiveReason);
    // Hardening finding (P2 re-gate): `noteShutdownComplete` now fires in a
    // `finally` — `start.ts`'s own wait for THIS event (see the doc comment
    // above) is what makes `runStartCommand` return at all. Before this fix,
    // a throw anywhere in the body below (every step `runShutdownSequence`
    // takes is best-effort in its OWN implementation today, but nothing here
    // guaranteed one of them could never throw in the future) would
    // propagate out of this function without ever emitting
    // `shutdown-complete`, leaving `start.ts` waiting forever — exactly the
    // class of hang this event was introduced to prevent in the first
    // place. `finally` runs on both the success path and any throw, and does
    // not swallow the throw itself (it still propagates to this function's
    // own caller — the `shutdown` control method's `.catch()` in
    // `controlMethods` below — afterward).
    try {
      await requestShutdown(`control socket shutdown (${effectiveReason})`);
    } finally {
      // Finding F5(b): read AFTER runShutdownSequence() returns — 0 means
      // the drain genuinely finished in time; a positive count is an honest
      // record that this many envelopes (almost certainly including a
      // task.fail shutdownActiveTasks just sent) never actually left the
      // outbox, rather than the audit log silently implying full delivery.
      observer.noteShutdownComplete(effectiveReason, connection?.outboxLength() ?? 0);
    }
  }

  const controlMethods: ControlMethods = {
    unary: {
      status: () => buildControlStatus(),
      'toolsets.reload': (params) => {
        const parsed = parseToolsetsReloadParams(params);
        if (!parsed) {
          throw new ControlError(
            'bad_request',
            'toolsets.reload requires exactly {expectedRevision, mcpToolsets}',
          );
        }
        try {
          return toolsetRegistry.reload(parsed.mcpToolsets, parsed.expectedRevision);
        } catch (err) {
          if (err instanceof McpToolsetRevisionConflictError) {
            throw new ControlError('revision_conflict', err.message);
          }
          throw new ControlError('bad_request', err instanceof Error ? err.message : String(err));
        }
      },
      'approvals.list': () => ({ approvals: approvalRegistry.list() }),
      'approvals.resolve': (params) => {
        const parsed = parseApprovalsResolveParams(params);
        if (!parsed) throw new ControlError('bad_request', 'approvals.resolve requires {approvalId, decision}');
        try {
          approvalRegistry.resolve(parsed.approvalId, parsed.decision, parsed.reason);
        } catch (err) {
          if (err instanceof ApprovalNotFoundError) throw new ControlError('not_found', err.message);
          throw err;
        }
        return { resolved: true };
      },
      // M4 Phase 3: called by `bin/byok-approval-mcp.ts` — a claude-spawned
      // MCP-server child process, not this daemon's own adapter/session
      // in-process (see `types.ts`'s `ApprovalChannel` doc comment). Awaits
      // `TaskRunner.requestApproval`'s own returned promise directly, which
      // is exactly what lets this control call stay pending for as long as
      // `approvalTimeoutMs` allows (`control-server.ts`'s unary dispatch has
      // no timeout of its own — see its `dispatch()`) — the caller's own
      // `requestTimeoutMs` (`bin/control-client.ts`) must be configured
      // longer than that for the same reason.
      'approvals.request': (params) => {
        const parsed = parseApprovalsRequestParams(params);
        if (!parsed) throw new ControlError('bad_request', 'approvals.request requires {taskId, summary}');
        if (!runner) throw new ControlError('not_found', 'daemon is not started');
        return runner.requestApproval(parsed.taskId, parsed.summary);
      },
      /**
       * Plan `device-assertion-broker`: mint one short-lived, audience-scoped
       * device assertion for a sibling local process.
       *
       * SIX fail-closed gates, in this exact order, none of which signs
       * anything on the way out. The order is part of the contract, not an
       * implementation detail:
       *
       * 1. `assertion_disabled` — before anything else, because a daemon that
       *    was never configured for this must not reveal, by answering
       *    differently for different inputs, that it even validates params.
       * 2. `bad_request` — shape/length, checked before the allowlist so a
       *    malformed request cannot be used to probe membership.
       * 3. `audience_denied` — EXACT `Set.has`, never a prefix/suffix rule
       *    (`salesko-api.evil.com` and `salesko-ap` both fail against an entry
       *    of `salesko-api`). The message deliberately does not echo the
       *    allowlist: a refusal must not be an enumeration oracle.
       * 4. `shutting_down` — see `performControlShutdown`'s own comment for
       *    the minting window this closes.
       * 5. `revoked` — the server-side revocation this daemon already knows
       *    about.
       * 6. `not_paired` — the on-disk record, re-read on EVERY call (never
       *    cached), so clearing `device.json` removes local signing authority
       *    immediately.
       *
       * Only after all six does the private key get imported, used once, and
       * dropped (`device-assertion-signer.ts`).
       *
       * Honest limit, and it must stay in the docs as well as here: gates 4-6
       * are only HALF of revocation. They make this daemon stop minting
       * promptly, but an assertion already in a caller's hands is not recalled
       * by any of them. The other half is the host's own recheck at exchange
       * time, which is why core's `verifyDeviceAssertion` makes the device
       * row's `revoked` state a REQUIRED parameter. Nothing here entitles
       * anyone to claim this daemon delivers synchronous invalidation on its
       * own.
       */
      'assertion.issue': async (params): Promise<AssertionIssueResult> => {
        // Gate 1.
        if (deviceAssertionAudiences === undefined) {
          observer.noteDeviceAssertion({ result: 'denied', reason: 'assertion_disabled' });
          throw new ControlError(
            'assertion_disabled',
            'this daemon is not configured to issue device assertions (DaemonConfig.deviceAssertion.audiences is absent or empty)',
          );
        }
        // Gate 2.
        const parsed = parseAssertionIssueParams(params);
        if (!parsed) {
          // The audience is reported only when it was a string at all — and
          // even then `bin/audit-log.ts` persists just its byte size, since on
          // this path it is unvalidated caller free text.
          const rawAudience =
            typeof params === 'object' && params !== null && typeof (params as { audience?: unknown }).audience === 'string'
              ? (params as { audience: string }).audience
              : undefined;
          observer.noteDeviceAssertion({ result: 'denied', reason: 'bad_request', audience: rawAudience });
          throw new ControlError(
            'bad_request',
            `assertion.issue requires exactly {audience} where audience is a non-empty string of at most ${DEVICE_ASSERTION_AUDIENCE_MAX_BYTES} UTF-8 bytes`,
          );
        }
        // Gate 3. Exact membership only.
        if (!deviceAssertionAudiences.has(parsed.audience)) {
          observer.noteDeviceAssertion({ result: 'denied', reason: 'audience_denied', audience: parsed.audience });
          throw new ControlError('audience_denied', 'the requested audience is not allowed by this daemon');
        }
        // Gate 4.
        if (shuttingDown) {
          observer.noteDeviceAssertion({ result: 'denied', reason: 'shutting_down', audience: parsed.audience });
          throw new ControlError('shutting_down', 'this daemon is shutting down and will not issue new assertions');
        }
        // Gate 5.
        if (auth.isRevoked()) {
          observer.noteDeviceAssertion({ result: 'denied', reason: 'revoked', audience: parsed.audience });
          throw new ControlError('revoked', 'this device has been revoked by the server; re-pair required');
        }
        // Gate 6. Read from disk every time — never a cached record.
        const record = await store.load();
        if (record === undefined) {
          observer.noteDeviceAssertion({ result: 'denied', reason: 'not_paired', audience: parsed.audience });
          throw new ControlError('not_paired', 'this device is not paired; nothing can be asserted about it');
        }

        // Plan `device-assertion-broker` (codex F2): re-check the mutable
        // conditions IMMEDIATELY before signing, at the signing point itself.
        // `store.load()` above is async, and a shutdown request or a
        // revocation can land during that `await` — after gates 4/5 already
        // passed but before the key is ever touched. The same
        // check-then-await-then-sign shape that made the result-document
        // capability re-check necessary applies here: the only checks that
        // count are the ones that still hold at the moment of signing.
        //
        // `store.load()` returning a record is itself the fresh not-paired
        // re-check (unpair clears `device.json` under a lease, so a record
        // read here is a currently-paired record). Shutdown and revocation are
        // in-memory flags, so they are re-read here explicitly.
        if (shuttingDown) {
          observer.noteDeviceAssertion({ result: 'denied', reason: 'shutting_down', audience: parsed.audience });
          throw new ControlError('shutting_down', 'this daemon is shutting down and will not issue new assertions');
        }
        if (auth.isRevoked()) {
          observer.noteDeviceAssertion({ result: 'denied', reason: 'revoked', audience: parsed.audience });
          throw new ControlError('revoked', 'this device has been revoked by the server; re-pair required');
        }

        const minted = mintDeviceAssertion({
          record,
          // `toHttpBase` is the one place a configured serverUrl is normalized
          // (ws:->http:, wss:->https:, path stripped), so an operator who
          // configured the websocket spelling and one who configured the HTTP
          // spelling of the same deployment produce the same issuer.
          issuer: new URL(toHttpBase(config.serverUrl)).origin,
          productId: config.productId,
          audience: parsed.audience,
          ttlMs: deviceAssertionTtlMs,
          now: new Date(),
        });
        observer.noteDeviceAssertion({
          result: 'issued',
          audience: minted.claims.audience,
          jti: minted.claims.jti,
          expiresAt: minted.expiresAt,
        });
        // codex round-2 F3: post-sign observer — non-secret metadata only,
        // reachable only from the internal test seam. Never sees the key,
        // never alters anything above it.
        assertionProbe?.onIssued({ jti: minted.claims.jti, audience: minted.claims.audience });
        return { assertion: minted.envelope, expiresAt: minted.expiresAt };
      },
      shutdown: (params) => {
        // Plan `device-assertion-broker` (codex F1): arm the minting latch
        // SYNCHRONOUSLY, as the very first statement of this handler, BEFORE
        // the `setImmediate` defer below. The teardown itself is deferred so
        // the `{acknowledged:true}` response is written first — but the LATCH
        // must not be. A client can pipeline `shutdown` and `assertion.issue`
        // as two NDJSON lines in one write; the server dispatches them in
        // order on the same tick, so if the latch were only set inside the
        // deferred `performControlShutdown` (next macrotask), the
        // `assertion.issue` that runs on THIS tick would still see
        // `shuttingDown === false` and mint. Setting it here, before yielding,
        // closes that exact window. `runShutdownSequence` sets it again
        // (idempotent) so the non-RPC `stop()`/`unpair()` paths are covered
        // too.
        shuttingDown = true;
        const { reason } = parseShutdownParams(params);
        // Fire-and-forget, deliberately AFTER this handler's own return
        // value has been serialized and written to the socket (see
        // `control-server.ts`'s dispatch: it awaits this handler, THEN
        // writes the response) — `setImmediate` schedules the teardown for
        // the next macrotask tick, strictly after that write.
        setImmediate(() => {
          void performControlShutdown(reason).catch((err: unknown) => {
            console.error('[byok/client] error during control-socket shutdown teardown:', err);
          });
        });
        return { acknowledged: true };
      },
    },
    stream: {
      'tasks.subscribe': (_params, ctx) =>
        new Promise<void>((resolve) => {
          const unsubscribeObserver = observer.subscribe((event) => ctx.emit(event));
          ctx.signal.addEventListener(
            'abort',
            () => {
              unsubscribeObserver();
              resolve();
            },
            { once: true },
          );
        }),
    },
  };

  function subscribe(listener: DaemonEventListener): Unsubscribe {
    return observer.subscribe(listener);
  }

  function tasks(): DaemonTaskInfo[] {
    return observer.tasks();
  }

  function dispatchReliableRecord(record: AgentReliableEgressRecord): void {
    if (record.sessionRef === undefined) {
      agentEgress.noteTransportDrop('invalid_envelope', record.agentRef);
      return;
    }
    if (!connection?.getServerCapabilities().includes(AGENT_EGRESS_RELIABLE_ACK_CAPABILITY)) {
      // The append stays durable and is retried after the next acknowledged
      // connection. It is never republished through latest-value activity.
      agentEgress.noteTransportDrop('capability_missing', record.agentRef);
      return;
    }
    const envelope = record.wireType === 'agent.egress.reliable'
      ? createEnvelope('agent.egress.reliable', {
          agentRef: record.agentRef,
          sessionRef: record.sessionRef,
          policyRevision: record.policyRevision,
          eventId: record.eventId,
          cursor: record.cursor,
          payload: record.payload as AgentEgressReliablePayload['payload'],
          contentHash: record.payloadHash,
          byteCount: record.byteCount,
        }, {
          ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
          sessionRef: record.sessionRef,
        })
      : createEnvelope(
          'agent.content.receipt',
          AgentContentReceiptPayloadSchema.parse(record.payload),
          {
            ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
            sessionRef: record.sessionRef,
          },
        );
    // The payload's optional host redaction already ran before append/hash;
    // this second SDK boundary pass validates the frozen envelope without
    // invoking a non-idempotent host sanitizer a second time.
    const sanitized = sanitizeEgressEnvelope(envelope, egressPolicy, undefined, { lane: 'reliable' });
    if (!sanitized.ok) {
      agentEgress.noteTransportDrop(sanitized.reason, record.agentRef);
      return;
    }
    connection.send(sanitized.envelope);
  }

  async function publishReliableAgentEgress(input: AgentReliableEgressInput): Promise<AgentEgressReliableAppendResult> {
    if (config.agentEgress === undefined || agentHomeManager === undefined || agentSessionHandoffs === undefined) {
      throw new Error('Agent reliable egress is not configured');
    }
    if (tenantRebinding) {
      throw new Error('tenant enrollment is being re-paired; reliable egress is blocked until restart');
    }
    const binding = await agentHomeManager.acquire(input.agentRef);
    try {
      await agentHomeManager.initialize(binding);
      const handoff = await agentSessionHandoffs.requireMatch({
        agentRef: binding.resolution.agentRef,
        sessionRef: input.sessionRef,
        runtimeId: input.runtimeId,
        cwd: binding.resolution.canonicalHome,
      });
      if (input.taskId !== undefined && handoff.taskId !== input.taskId) {
        throw new Error('Agent reliable egress taskId does not match the durable session handoff');
      }
      const appended = await agentEgress.appendReliable({
        homeDir: binding.resolution.canonicalHome,
        agentRef: binding.resolution.agentRef,
        sessionRef: input.sessionRef,
        payload: input.payload,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      });
      if (appended.ok) dispatchReliableRecord(appended.record);
      return appended;
    } finally {
      await binding.lease.release();
    }
  }

  function status(): DaemonStatus {
    return {
      localAgentRelease,
      paired: auth.deviceId !== undefined,
      connected: connectionState === 'open',
      degraded: connection?.isTransportDegraded() ?? false,
      revoked: connection?.isRevoked() ?? auth.isRevoked(),
      deviceId: auth.deviceId,
      activeTaskCount: runner?.activeTaskCount ?? 0,
      branding: config.branding,
      operationalHealth: operationalHealth.snapshot(),
      toolsets: toolsetRegistry.status(),
      egress: agentEgress.status(),
    };
  }

  function reloadMcpToolsets(
    mcpToolsets: Record<string, McpToolsetConfig> | undefined,
    expectedRevision: string,
  ): McpToolsetReloadReceipt {
    return toolsetRegistry.reload(mcpToolsets, expectedRevision);
  }

  function reportMcpToolsetObservation(
    toolsetId: string,
    expectedDefinitionRevision: string,
    observation: McpToolsetObservation,
  ): void {
    toolsetRegistry.report(toolsetId, expectedDefinitionRevision, observation);
  }

  return {
    pair,
    start,
    stop,
    status,
    publishReliableAgentEgress,
    reloadMcpToolsets,
    reportMcpToolsetObservation,
    subscribe,
    tasks,
    unpair,
    approve,
    reject,
  };
}

/**
 * Public white-label entry point (M0-M3): the "5-line launcher" — a product
 * only needs a `DaemonConfig`, no hand-built adapter list. The bundled
 * adapter set is built from `config.runtimeAllowlist` (see
 * `buildDefaultAdapters` and that field's own doc comment for the exact
 * unset-vs-set contract); with no `runtimeAllowlist` configured, the default
 * is ALL THREE bundled adapters (pi, claude, codex), not pi alone: M0/M1
 * hard-wired pi-only unconditionally, which meant any product wanting
 * claude/codex had to drop to `createDaemonWithAdapters` and hand-build
 * adapters just to get a runtime that was already built into this SDK.
 * `detectRuntimes` only ever advertises what's actually present on the
 * device (protocol §10 gap #4), so constructing an adapter for a runtime the
 * device doesn't have costs one quick failed `--version` probe at `start()`
 * and is otherwise invisible — there's no reason to withhold it by default.
 * Products that DO want to restrict to a subset set `runtimeAllowlist`
 * (also independently enforced at task-pick time — see
 * `TaskRunnerDeps.runtimeAllowlist` / `TaskRunner.pickAdapter`); products
 * needing something this can't build (custom adapter options, a fourth
 * in-house runtime, test stubs) use `createDaemonWithAdapters` directly.
 */
export function createDaemon(config: DaemonConfig): Daemon {
  return createDaemonWithAdapters(config, buildDefaultAdapters(config));
}
