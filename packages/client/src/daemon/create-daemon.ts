import { resultReplyFailureFromState, resultReplyFailureReason } from './result-reply-failure';
import type { OutboundStatus } from './outbound-settlement';
import { terminalIdentity } from './terminal-identity';
import { HarnessIdSchema, type HarnessInfo } from '@byok-sdk/protocol';
import { TerminalCommitQueue } from './terminal-commit-queue';
import { isWireRuntimeId, observeRuntimeDetection, projectRuntimeObservation, type RuntimeObservation } from '../runtime-detection';
import { serviceEnvironmentStatus, type ServiceEnvironmentStatus } from '../lifecycle/service-environment';
import {
  DEVICE_ASSERTION_AUDIENCE_MAX_BYTES,
  DEVICE_ASSERTION_DEFAULT_TTL_MS,
  DEVICE_ASSERTION_MAX_TTL_MS,
} from '@byok-sdk/core';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  isTaskOfferType,
  isSealedMessageType,
  requiredReceiverCapabilities,
  PROTOCOL_VERSION,
  SEALED_PAYLOAD_CAPABILITY,
  STRICT_AGENT_ONLY_CAPABILITY,
  TASK_TRANSITIONS,
  AGENT_EGRESS_POLICY_CAPABILITY,
  AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
  AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
  AGENT_MESSAGE_EGRESS_CAPABILITY,
  HOST_MCP_TASK_CONTEXT_CAPABILITY,
  AGENT_HOME_PROJECTION_CAPABILITY,
  AGENT_HOME_READERS_CAPABILITY,
  AGENT_MEMORY_SELECTION_CAPABILITY,
  AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY,
  AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY,
  AGENT_INPUT_PREPARATION_CAPABILITY,
  TERMINAL_PROJECTION_SELECTION_CAPABILITY,
  PROVIDER_PROFILE_BINDING_CAPABILITY,
  PROVIDER_PROVISIONING_CAPABILITY,
  AGENT_MEMORY_INTENT_CAPABILITY,
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
import type {
  RuntimeAdapter,
  GitWorkspaceConfig,
  McpStdioServerConfig,
  McpToolsetConfig,
  McpToolsetObservation,
  McpToolsetRegistryStatus,
  McpToolsetReloadReceipt,
} from '../types';
import {
  AgentHomeLeaseManager,
  AgentHomeManager,
  stableAgentHomeOwnerId,
  type AgentHomeExecutionStatus,
  type AgentHomeProjection,
} from '../agent-home';
import type { AgentRef } from '../agent-home';
import {
  resolveLocalAgentReleaseIdentity,
  type LocalAgentReleaseIdentity,
} from '../release-identity';
import { PiAdapter, validatePiByokLauncherConfig } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { attachOwnedProcessGroupLedger } from '../adapters/process-tree';
import { OwnedProcessLedger } from './owned-process-ledger';
import { assertCodexSandboxSetting, CodexAdapter, type CodexSandboxSetting } from '../adapters/codex/codex-adapter';
import { ApprovalNotFoundError, ApprovalRegistry } from './approvals';
import { AuthManager, DeviceRevokedError } from './auth-manager';
import { BlobClient } from './blob-client';
import { SealedTasks } from './sealed-task';
import { DAEMON_TASK_FAILURE, taskFailureField } from './task-failure';
import { resolveMachineId } from './machine-id';
import {
  declares, E2EE_MEMBER_CAPABILITY, E2EE_MEMBER_KEM_EPOCH_CAPABILITY, fetchCapabilityDeclaration, PRESENCE_HINTS_CAPABILITY,
} from './capabilities-client';
import type { CapabilityDeclaration } from '@byok-sdk/core';
import {
  assertPresenceHeartbeatCadence,
  DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS,
  DEFAULT_PRESENCE_TTL_MS,
  PresencePublisher,
} from './presence-publisher';
import { assertServerUrlAllowed, formatServerUrl, InsecureServerUrlError, toHttpBase } from './url';
import { mintDeviceAssertion, mintTaskAssertion } from './device-assertion-signer';
import { DaemonHaltError, type DaemonHaltReason, type DaemonLifecycle } from './daemon-lifecycle';
import { AnotherControlServerRunningError, startControlServer } from './control-server';
import type { ControlMethods, ControlServerHandle } from './control-server';
import {
  ControlError,
  ENROLLMENT_PAIRING_CODE_MAX_BYTES,
  parseApprovalsRequestParams,
  parseAgentMessagePublishParams,
  parseAgentResultDescribeParams,
  parseAgentResultSubmitParams,
  parseAgentMemoryRecallParams,
  parseAgentMemorySaveParams,
  parseApprovalsResolveParams,
  parseAssertionIssueParams,
  parseEnrollmentPairParams,
  parseShutdownParams,
  parseTaskAssertionIssueParams,
  parseTeamContextParams,
  parseTeamMessageAckParams,
  parseTeamMessageInspectParams,
  parseTeamMessagePostParams,
  parseTeamMessageReadParams,
  parseTeamNotificationSnapshotParams,
  parseTeamWorkspaceCreateParams,
  parseTeamWorkspaceJoinParams,
  parseToolsetsReloadParams,
  TASK_ASSERTION_CONTEXT_TOKEN_MAX_BYTES,
  type AssertionIssueResult,
  type ControlActiveTask,
  type ControlStatusResult,
  type ControlStorageStatus,
  type ShutdownReason,
  type TaskAssertionIssueResult,
} from './control-protocol';
import {
  INPUT_PREPARATION_CANCEL_METHOD,
  INPUT_PREPARATION_LOOKUP_METHOD,
  INPUT_PREPARATION_PREPARE_METHOD,
  parseInputPreparationCancelParams,
  parseInputPreparationLookupParams,
  parseInputPreparationRequestParams,
  type InputPreparationResult,
} from './control-protocol';
import {
  validateInputPreparationLimits,
  type InputPreparationAuthorityResolver,
  type InputPreparationCounterAdapter,
  type InputPreparationLimitsPolicyV1,
} from '../input-preparation';
import {
  createInputPreparationService,
  InputPreparationRequestError,
  type InputPreparationService,
} from './input-preparation-service';
import { InputPreparationUnsupportedRecordVersionError } from './input-preparation-store';
import { createPiInputPreparationCompiler, resolvePinnedPiRuntimeIdentity } from '../adapters/pi/input-preparation';
import { decodeTeamMemberContext, encodeTeamMemberContext, LocalTeamWorkspace } from './team-workspace';
import { McpToolsetRegistry, McpToolsetRevisionConflictError } from './toolset-registry';
import { ConnectionManager } from './connection-manager';
import { createFleetJitter, deterministicJitterMs, type FleetJitter } from './deterministic-jitter';
import { OperationalHealthTracker, type OperationalHealthSnapshot } from './operational-health';
import { acquireDaemonOwner, DaemonOwnerActiveError, type DaemonOwnerLease } from './daemon-owner';
import { toRuntimeInfoCapabilities } from './runtime-capabilities';
import { CursorStore } from './cursor-store';
import { DaemonObserver, type DaemonEventListener, type DaemonTaskInfo, type Unsubscribe } from './observer';
import { SessionWorkspaceStore } from './session-workspace-store';
import { AgentSessionHandoffStore } from './agent-session-handoff-store';
import { GitWorkspaceManager, stableGitWorkspaceOwnerId } from './git-workspace';
import { GitWorkspaceStore } from './git-workspace-store';
import { DeviceRecordRePairRequiredError, DeviceStore, enrollmentIdentityOf, type DeviceEnrollment, type DeviceRecord } from './store';
import { createDeviceCredentialStore, createDeviceMemberCustody } from './device-credential-provider';
import { DeviceMemberRecords } from './device-member-custody';
import { checkVerificationSecret, enrollDeviceMember, resumeDeviceMember } from './device-member';
import { StoredDeviceProofSigner } from './device-proof-signer';
import { processE2eeKeyPackageNotice, type DeviceMemberStatus } from './e2ee-key-package-notice';
import { DeviceMemberKeyring, type MemberFreshness } from './e2ee-keyring';
import { E2eeMemberClient } from './e2ee-member-client';
import { JournalRecordTooLargeError, journalHash, type JournalIdentity, type LocalTaskJournal, type ReceivedEnvelopeRecord } from './journal/journal';
import { JournalHandleCleanupError, SqliteLocalTaskJournal } from './journal/sqlite-journal';
import type { JournalOpenFaultSeam } from './journal/sqlite-support';
import { promises as fs } from 'node:fs';
import { LocalStorageConfigError, resolveStorageConfig, type StorageConfig } from './retention/config';
import { ScratchRoot } from './retention/scratch';
import { StoragePressure } from './retention/pressure';
import { RetentionSweeper, type RetentionTimers } from './retention/sweeper';
import { createRetentionRegistry } from './retention/producers';

import { DEFAULT_MAX_INLINE_EVENT_BYTES, MIN_MAX_INLINE_EVENT_BYTES } from './event-spill';
import {
  DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME,
  DEFAULT_MAX_TASK_OUTPUT_BYTES,
  TaskRunner,
  type TaskRunnerDeps,
} from './task-runner';
import {
  validateProgressBatcherOptions,
  type ProgressBatcherOptions,
} from './progress-batcher';
import { AgentEgressController, type AgentEgressReliableAppendResult } from './agent-egress-controller';
import { resolveAgentEgressPolicy, type AgentEgressStatus } from './agent-egress-policy';
import type { AgentContentReceiptWithoutReliableIdentity, AgentReliableEgressRecord } from './agent-egress-spool';
import { AgentContentAuditStore } from './agent-content-audit-store';
import { AgentHomeProjectionCompletionClient } from './agent-home-projection-client';
import { InputPreparationCompletionClient } from './input-preparation-completion-client';
import {
  createProviderProvisioningNoticeProcessor,
  type ProviderProvisioningHandler,
} from './provider-provisioning';
import {
  createRemoteInputPreparationHandler,
} from './input-preparation-remote';
import { createPreparedToolSurfaceAssembler } from './prepared-tool-surface';
import { buildRuntimeEnv } from './environment';
import { resolveAgentMessageMcpBin } from './resolve-agent-message-mcp-bin';
import { preflightAgentMessageMcp } from './agent-message-mcp-preflight';
import { preflightAgentResultMcp } from './agent-result-mcp-preflight';
import { assertJournalEnvelopeProtocol, DaemonConfigFieldRemovedError } from './daemon-errors';
import { resolveAgentMemoryDescribeBin, resolveAgentMemoryMcpBin } from './resolve-agent-memory-mcp-bin';
import { exportAgentMemoryHome, type AgentMemoryExport, type AgentMemoryExportOptions } from './agent-memory-export';
import { resolveSdkReservedHelperBin, type SdkHelperHostConfig } from '../sdk-reserved-helper-host';
import {
  isAgentMemorySecureFilesystemAvailable,
  probeAgentMemoryStrictDirectorySync,
  type AgentMemoryHostedProjection,
} from './agent-memory';
import {
  NATIVE_AGENT_MEMORY_INTENT_BACKEND,
  createAgentMemoryIntentProcessor,
  helperAgentMemoryIntentBackend,
  type AgentMemoryIntentBackend,
  type AgentMemoryIntentTransport,
} from './agent-memory-intent';
import { isAgentMemoryFilesystemHelperSupported } from './agent-memory-fs-helper';
import { resolveAgentMemoryFilesystemHelper } from './agent-memory-helper-release';
import { openAgentMemoryFilesystemHelper } from './agent-memory-fs-helper';
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

/** The pairing is saved, but a member step after it failed: the device is paired without E2EE. */
class PairedWithoutMemberError extends Error {
  constructor(deviceId: string, what: string, cause: unknown) {
    super(`device ${deviceId} is paired, but ${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PairedWithoutMemberError';
  }
}

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

export interface DaemonConfig {
  /** Absolute native asset root for SDK-created runtime adapters. Custom adapters own their option. */
  nativeAssetRoot?: string;
  /** Select an explicit macOS keychain for device enrollment custody. */
  deviceCredentials?: import('./device-credential-store').DeviceCredentialConfig;
  storage?: StorageConfig;
  /** Distribution-owned application release; observability only, never a protocol/capability gate. */
  localAgentRelease: LocalAgentReleaseIdentity;
  productName: string;
  productId: string;
  serverUrl: string;
  /** Bounds one AuthManager pair/challenge/token exchange, including response-body reads. */
  authRequestDeadlineMs?: number;
  deviceName?: string;
  /**
   * Optional override for the client-hashed physical machine identity sent
   * with `POST /byok/pair` (protocol §6.1). Defaults to `resolveMachineId`
   * over this product id, which probes one OS identifier and hashes it; a
   * host that has its own machine authority can supply it here, and one that
   * wants no supersession at all supplies `async () => undefined`.
   */
  machineId?: () => Promise<string | undefined>;
  /**
   * Parent directory of each legacy offer's `workspaceRoot/<taskId>`
   * workspace, and of Git workspace mode. Required unless `strictAgentOnly`
   * is true: a strict Agent daemon refuses every legacy offer and runs each
   * Agent offer in its SDK-owned home, so it never reads this path.
   */
  workspaceRoot?: string;
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
  /** Task memory MCP admission. Absent/auto preserves platform-based admission; off disables both ordinary and prepared memory tools,
   * and drops the Agent memory guidance from Agent task instructions. `status().agentMemoryMcp` reports the effective admission.
   * This does not disable explicit hosted projection/intent transports, and is not a filesystem sandbox. */
  agentMemoryMcp?: 'auto' | 'off';
  /** Optional, one-way hosted projection. Without all guards it has zero network activity. */
  agentMemory?: AgentMemoryHostedProjection;
  /** Explicit raw local Host export opt-in. No control/wire endpoint, upload, or projection callback. Requires agentHome and the admitted Linux, macOS or Windows x64 memory backend. */
  agentMemoryExport?: true;
  /** Absolute directory copied by copyAgentMemoryHelperAssets. Only SDK release assets are admitted; not a helper executable or digest override. */
  agentMemoryHelperAssetRoot?: string;
  /**
   * Explicit composition for SDK-reserved MCP helpers when this daemon is
   * embedded in a single-file/SEA product executable. The product entrypoint
   * must also call `runSdkReservedHelperCommand()` before its own CLI parser.
   */
  sdkHelperHost?: SdkHelperHostConfig;
  /**
   * Refuse legacy task offers locally. This is an additive capability only
   * after the SDK-owned Agent home has passed construction-time preflight.
   */
  strictAgentOnly?: boolean;
  /**
   * How many `homeAccess: 'memory-reader'` Attempts this daemon lets run
   * CONCURRENTLY in one canonical Agent home, across every lane and every
   * session. Default {@link DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME} (4).
   *
   * Readers are counted apart from the writer. A home has at most one writer
   * Attempt, fixed: the writer runs in the home itself, so a second writer
   * would co-write `MEMORY.md`, `notes/` and `.git`. Each reader runs in its
   * own run directory, `<home>/.byok/runs/<taskId>/`. An offer over either
   * limit is declined retryably before adapter preparation, the claim, or any
   * process side effect.
   *
   * Validated up front, the same way `maxTaskOutputBytes` is: a positive safe
   * integer, so `0`, a negative number, `NaN` and a non-integer are
   * construction errors rather than a silently reinterpreted "unlimited".
   *
   * The removed `maxConcurrentMutableSessionsPerAgentHome` is a construction
   * error: a value above 1 let Attempts co-write one home, which reader
   * Attempts replace.
   */
  maxConcurrentReaderAttemptsPerAgentHome?: number;
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
  /** Disabled by default. Requires Agent homes, journal and custody launcher. */
  durablePi?: boolean;
  piByokLauncher?: import('../adapters/pi/pi-adapter').PiByokLauncherConfig;
  /**
   * M5 batch-3 (workstream 1): explicit auto-select priority order for
   * `TaskRunner.pickAdapter`'s no-explicit-runtime branch (`task-runner.ts`)
   * — tried in listed order; the first candidate that is both PRESENT
   * (`adapter.detect()`) and CAPABLE (declares MCP toolset projection when
   * the offer requires it) wins. Unset defaults to
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
  storeDir?: string;
  /**
   * Opt-in host composition for a daemon launched under a different OS
   * principal than the interactive CLI (notably a WinSW service). When true,
   * an unpaired daemon holds the normal writer lease and exposes only the
   * existing HMAC-authenticated local control surface so `enrollment.pair`
   * can persist the credential under the daemon's own OS token. Absent by
   * default: ordinary foreground `start()` keeps rejecting an unpaired device.
   */
  serviceEnrollment?: { readonly enabled: true };
  /** Optional white-label branding — see `DaemonBranding`. Carried through verbatim to `status().branding`. */
  branding?: DaemonBranding;
  /**
   * Codex sandbox for the bundled Codex adapter that `createDaemon` builds,
   * as OAR's `OAR_CODEX_SANDBOX`. Default `danger-full-access`. `inherit`
   * passes no sandbox override, so the user's own `config.toml` applies.
   * `createDaemon` throws a TypeError for any other value.
   * `createDaemonWithAdapters` rejects this key, even when undefined.
   * Configure the injected CodexAdapter with its own sandbox option.
   */
  codexSandbox?: CodexSandboxSetting;
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
   * (unset/`false`): a `serverUrl` using plaintext `http:` is only
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
   * `http:`/`https:`), which is refused unconditionally.
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
  /** Legacy artifact bytes only: default 16 MiB/file and 64 MiB/task, independent of event output limits. */
  artifactLimits?: { maxFileBytes: number; maxTaskBytes: number };
  /** Admission and startup deadline, including pure detect/prepare waits; unresolved process owners remain quarantined. Default 30 seconds. */
  startupTimeoutMs?: number;
  /**
   * Per-EVENT inline ceiling (default {@link DEFAULT_MAX_INLINE_EVENT_BYTES},
   * 64 KiB) for the two `AgentEvent` fields a runtime authors freely:
   * `tool_use.input` and `tool_result.output`. An event whose serialization
   * exceeds this leaves `TaskRunner.pump` with that field replaced by a
   * UTF-8-safe head/tail preview (`{ preview: { head, tail } }`) and an
   * additive `spill` descriptor; the full JSON serialization is uploaded to
   * the blob plane under an idempotent, content-addressed key, and
   * `spill.blob` is where a consumer reads it back. If the upload fails the
   * preview still ships, carrying `spill.unstoredReason` instead — omission
   * is always described, never silent.
   *
   * This is a per-event bound, orthogonal to `maxTaskOutputBytes` (a
   * whole-task total, counted AFTER spilling) and to
   * the server-advertised activity ingress budget.
   *
   * **Consumer contract:** `spill`'s presence is the only signal that the
   * inline field is a preview. A consumer that renders `tool_result.output`
   * without checking `spill` renders a truncation as the whole result.
   *
   * Must be a positive safe integer of at least
   * {@link MIN_MAX_INLINE_EVENT_BYTES} (4096) — below that a legitimate
   * `spill` descriptor no longer fits inside the cap it exists to enforce.
   * Anything else (0, negative, non-integer, `NaN`,
   * `Number.POSITIVE_INFINITY`) is a config validation error thrown
   * synchronously from `createDaemonWithAdapters`/`createDaemon`; there is
   * no opt-out, because "unbounded event" is exactly the state this exists
   * to prevent.
   */
  maxInlineEventBytes?: number;
  /**
   * Timing and event-count batching policy. The server owns the byte ceiling.
   */
  progressBatch?: ProgressBatcherOptions;
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
  /**
   * B-P2 local primitive: the task-free `input_preparation.*` control surface
   * (`docs/researches/runtime-input-preparation-contract.md` §10.3).
   *
   * OFF by default. An absent section keeps the whole feature disabled and
   * makes all three methods answer `input_preparation_unconfigured` — there is
   * no default limits policy and no default authority, by the Owner-approved
   * limits boundary of 2026-09-14. The counter inside the section is
   * OPTIONAL: without one, preparations settle on the compiler's own byte
   * evidence. A PRESENT section with an
   * invalid policy is a construction error, the same discipline
   * `deviceAssertion` and the presence cadence already follow: a daemon that
   * starts with an allowance nobody validated is a daemon whose operator
   * believes a limit is in force.
   */
  inputPreparation?: InputPreparationDaemonConfig;
  /**
   * Host consumer for the task-free `provider.provisioning.available` notice
   * (sealed provider provisioning). See {@link ProviderProvisioningHandler}.
   *
   * OFF by default, and the `provider-provisioning.v1` capability is advertised
   * only while a handler is present, so a Host never enqueues a notice this
   * daemon cannot consume. A notice that arrives anyway (a stale row, or a
   * sender that ignored the capability) is NOT acknowledged: the daemon throws,
   * the mailbox row is retained and the cursor stays behind it.
   *
   * The handler receives only `{ requestId }` and resolves with the Host's
   * durable terminal readback; the cursor advances only after that readback
   * validates against this tenant, device and request.
   */
  providerProvisioning?: ProviderProvisioningHandler;
  /**
   * Host transport for the task-free `agent.memory.intent.available` notice
   * (Host-approved Agent memory intents). See {@link AgentMemoryIntentTransport}.
   *
   * OFF by default. The `agent-memory-intent.v1` capability is advertised only
   * while this transport is present AND `agentHome` is configured AND the
   * secure memory filesystem is available AND that backend's ledger write is
   * a proven durable barrier (temp sync, rename, directory sync). Linux uses
   * native descriptors. macOS uses the verified SDK helper after a strict
   * full-sync volume probe. Windows does not advertise: its helper has no
   * OS-crash or power-loss proof. A notice that arrives without the capability is NOT
   * acknowledged: it fails `transport_unconfigured` or
   * `filesystem_unavailable` before any fetch. There is no control-socket
   * method for intents; the only entry is the mailbox notice.
   */
  agentMemoryIntents?: AgentMemoryIntentTransport;
}

/**
 * The local preparation surface. The limits policy and the authority are
 * required together: a policy without an authority would answer questions it
 * cannot back.
 *
 * The counter is OPTIONAL. Without one a preparation compiles, persists and
 * can reach ready with no counter call and no `maxCounterCallsPerScope`
 * reservation consumed: the size evidence is the artifact's
 * `requestBytes`, measured by this daemon's own compiler, and the numeric
 * budget (window, template constant, output reserve, fit) is Host authority.
 * With one, the counter is called once per preparation and its evidence must
 * be provider-authoritative and covered for the receipt to be ready.
 */
export interface InputPreparationDaemonConfig {
  /** Required explicit byte / call / deadline / retention policy. No field has a default. */
  limits: InputPreparationLimitsPolicyV1;
  /** The trusted local device/Agent/Profile authority. Unavailable authority rejects. */
  authorityResolver: InputPreparationAuthorityResolver;
  /**
   * The separately authorized, optional counter. This package ships no
   * fallback counting of any kind and no numeric budget.
   */
  counter?: InputPreparationCounterAdapter;
}

export interface AgentEgressConfig {
  /** Exact policy the daemon is willing to consume from an Agent offer. */
  policy: AgentEgressPolicy;
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
  /** Exact task identity from the same durable Agent-home handoff. */
  taskId: string;
  payload: unknown;
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
  /** Environment selected by this daemon's host process at startup. */
  environment: ServiceEnvironmentStatus;
  environmentResolvedAt?: string;
  /** Startup observations for every configured adapter; status never re-probes. */
  runtimes: RuntimeObservation[];
  storage: ControlStorageStatus;
  /** Process-immutable Local Agent application release captured at construction. */
  localAgentRelease: Readonly<LocalAgentReleaseIdentity>;
  paired: boolean;
  /**
   * Issues #391/#394: where this daemon is in its lifecycle, including whether
   * the server has accepted it (`running` + `connection: 'open'`) and why a
   * run ended for good (`halted`). The same value every `lifecycle` event
   * carries.
   */
  lifecycle: DaemonLifecycle;
  deviceId?: string;
  activeTaskCount: number;
  /** Exact terminal results retained for journal retry; nonzero requires recovery. */
  pendingTerminalCommits: number;
  /** Passthrough of `DaemonConfig.branding` — `undefined` when the product configured none. See `DaemonBranding`. */
  branding?: DaemonBranding;
  /** Local lifecycle/retry budget, separate from transport fallback state. */
  operationalHealth: OperationalHealthSnapshot;
  /** Redacted, content-addressed device-local MCP registry status. */
  toolsets: McpToolsetRegistryStatus;
  /** Content-free egress lane watermarks and typed last-drop facts. */
  egress: AgentEgressStatus;
  outbound: OutboundStatus;
  /** WP0: per-canonical-Agent-home execution serialization — see {@link AgentHomeExecutionStatus}. */
  agentHomeExecution: AgentHomeExecutionStatus;
  /**
   * Effective daemon-level SDK memory MCP admission for ordinary Agent tasks.
   * `admitted`: Agent tasks get the SDK memory MCP; a writer gets
   * `memory_recall` and `memory_save`, a `memory-reader` Attempt only
   * `memory_recall`. The selected adapter must still support MCP toolsets for
   * each task. `off`: `DaemonConfig.agentMemoryMcp` is `off`; no Agent task
   * gets the memory MCP or the memory guidance. `unavailable`: `auto`, but
   * this daemon has no Agent home or no secure memory filesystem (for example
   * macOS or Windows x64 without the SDK release helper, or Windows arm64).
   */
  agentMemoryMcp: 'admitted' | 'off' | 'unavailable';
}

export interface Daemon {
  /** Present only with agentMemoryExport: true. Holds the home writer lease; AgentHomeBusyError is retryable. Raw contents remain Host-owned. */
  exportAgentMemory?(agentRef: AgentRef, options?: AgentMemoryExportOptions): Promise<AgentMemoryExport>;
  /**
   * Pairing result is intentionally credential-blind. With
   * `verificationSecret`, the base32 secret the web client shows after the
   * pairing code (#654 §7.2), the device also enrolls as an E2EE member; the
   * secret never reaches the Host. Without it the device pairs without E2EE.
   */
  pair(pairingCode: string, options?: { readonly verificationSecret?: string }): Promise<DeviceEnrollment>;
  /**
   * Resolves once local startup is done — store ownership, storage, journal
   * recovery, the control socket and the task runner — with the reconnect
   * loop running. It does not wait for the server: `status().lifecycle` and
   * `lifecycle` events report the connection, and a halt the server causes.
   * Throws {@link DaemonHaltError} for a halt found locally; any other throw
   * is a crash.
   */
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

/** Custom adapter composition. Available custom descriptors are published through
 * the capability-gated harness inventory; built-in RuntimeId remains closed. */
export interface DaemonOverrides {
  /**
   * Explicit enrollment-custody dependency. The caller owns its secret storage
   * and lifetime; omission composes the platform OS credential store.
   */
  deviceCredentials?: import('./device-credential-store').DeviceCredentialBackend;
  retention?: { clock?: () => Date; timers?: RetentionTimers; freeBytesProvider?: () => Promise<number> };
  /** Test-only synchronous kill points; never supplied by production configuration. */
  executionRecoveryFault?: (step: 'terminal:before-send' | 'terminal:queued' | 'outbound:before-post' | 'outbound:after-ack') => void;
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
   * A durable local journal the host supplies instead of `SqliteLocalTaskJournal`
   * (§12.7.2). It must meet the same contract (a resolved `appendEnvelope` is
   * fsynced); the daemon does not check that. `stop()` does not close it:
   * whoever injected it owns its lifetime.
   */
  journal?: LocalTaskJournal;
  /** Test-only post-open SQLite initialization fault seam. */
  journalOpenFaults?: JournalOpenFaultSeam;
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
 * A sealed terminal (`task.complete_sealed`, …) has the kind of its plaintext type.
 */
function terminalKindOf(type: string): 'complete' | 'failed' | 'cancelled' | 'declined' | undefined {
  const plainType = type.endsWith('_sealed') ? type.slice(0, -'_sealed'.length) : type;
  if (plainType === 'task.decline') return 'declined';
  if (plainType === 'task.complete') return 'complete';
  if (plainType === 'task.fail') return 'failed';
  if (plainType === 'task.cancelled') return 'cancelled';
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
 * The protocol owns the task-opening family. Project that classification
 * here so neither the daemon nor the storage journal maintains a second list.
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
    opensTask: isTaskOfferType(envelope.type),
  };
}

/** Runtimes actually detected as present on this device, typed per protocol §10 gap #4 (`ConnHelloPayload.runtimes`). Computed once at `start()` — re-probing on every reconnect would mean re-spawning each runtime's `--version` check for no real benefit within one daemon lifetime. */
async function detectRuntimes(adapters: RuntimeAdapter[]): Promise<{ runtimes: RuntimeInfo[]; harnesses: HarnessInfo[]; observations: RuntimeObservation[] }> {
  const detections = await Promise.all(adapters.map(async (adapter) => ({ adapter, detected: await observeRuntimeDetection(adapter) })));
  const runtimes: RuntimeInfo[] = [];
  const harnesses: HarnessInfo[] = [];
  const observations: RuntimeObservation[] = [];
  for (const { adapter, detected } of detections) {
    observations.push(projectRuntimeObservation(adapter.descriptor, detected));
    if (detected.kind !== 'available') continue;
    if (detected.advisory !== undefined) {
      console.warn(`[byok/client] ${adapter.descriptor.id} ${detected.version ?? '(unknown version)'} is not the qualified ${detected.advisory.qualifiedVersion}; continuing`);
    }
    if (!isWireRuntimeId(adapter.descriptor.id)) {
      harnesses.push({ id: HarnessIdSchema.parse(adapter.descriptor.id),
        ...(detected.version === undefined ? {} : { version: detected.version }),
        capabilities: toRuntimeInfoCapabilities(adapter.descriptor.capabilities) });
      continue;
    }
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
  return { runtimes, harnesses, observations };
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
  strictAgentOnly = false,
  agentHomeProjectionConfigured = false,
  agentEgressConfigured = false,
  contentReadPolicies?: Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>>,
  providerProfileBindingConfigured = false,
  inputPreparationConfigured = false,
  providerProvisioningConfigured = false,
  agentMemoryIntentsProven = false,
): CapabilityFlag[] {
  const flags: CapabilityFlag[] = [];
  if (adapters.some((adapter) => adapter.descriptor.capabilities.steer)) flags.push('steer');
  flags.push('blob-upload');
  flags.push('approval-targeting');
  flags.push(TERMINAL_PROJECTION_SELECTION_CAPABILITY);
  const selectionAdapters = adapters.filter((adapter) =>
    ALL_RUNTIME_IDS.includes(adapter.descriptor.id as RuntimeId),
  );
  if (
    selectionAdapters.length > 0 &&
    selectionAdapters.every((adapter) => adapter.descriptor.supportsDispatchSelection === true)
  ) {
    flags.push('dispatch-selection');
  }
  if (
    providerProfileBindingConfigured &&
    adapters.some((adapter) => adapter.descriptor.id === 'pi' && adapter.descriptor.supportsDispatchSelection)
  ) {
    flags.push(PROVIDER_PROFILE_BINDING_CAPABILITY);
  }
  if (adapters.some((adapter) => adapter.descriptor.capabilities.mcpToolsets === true)) {
    flags.push('toolset-selection');
  }
  // Every Agent-home daemon reads the per-task memory selection, whatever its
  // memory admission: `none` and the two `*-if-admitted` values always run,
  // and an unadmitted `read` or `read-write` declines.
  if (agentHomeConfigured) {
    flags.push(
      'agent-home-contract', AGENT_HOME_READERS_CAPABILITY, AGENT_MEMORY_SELECTION_CAPABILITY,
      AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY, AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY,
    );
  }
  if (strictAgentOnly) flags.push(STRICT_AGENT_ONLY_CAPABILITY);
  if (agentHomeProjectionConfigured) flags.push(AGENT_HOME_PROJECTION_CAPABILITY);
  // Advertised only by a daemon whose `inputPreparation` section is present
  // AND whose native closure verified, because that pair is exactly what makes
  // the remote lane servable. The cloud reads this durable flag before it
  // allocates a receipt, so an unconfigured device is refused at the Host
  // rather than handed a row it can only answer with a rejection.
  if (inputPreparationConfigured) flags.push(AGENT_INPUT_PREPARATION_CAPABILITY);
  // Advertised only while the Host injected a handler: the Host's enqueue
  // gate reads this flag, so an unconfigured device is never sent a notice.
  if (providerProvisioningConfigured) flags.push(PROVIDER_PROVISIONING_CAPABILITY);
  // Advertised only with a Host transport, an Agent home, a secure memory
  // filesystem, and a backend whose ledger write is a proven durable barrier.
  if (agentMemoryIntentsProven) flags.push(AGENT_MEMORY_INTENT_CAPABILITY);
  if (agentEgressConfigured) {
    flags.push(
      AGENT_EGRESS_POLICY_CAPABILITY,
      AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
      AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
    );
    if (agentHomeConfigured && adapters.some((adapter) => adapter.descriptor.capabilities.mcpToolsets === true)) {
      flags.push(AGENT_MESSAGE_EGRESS_CAPABILITY);
    }
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
      return new PiAdapter({ nativeAssetRoot: config.nativeAssetRoot, byokLauncher: config.piByokLauncher, ...(config.sdkHelperHost === undefined ? {} : { sdkHelperHost: config.sdkHelperHost }), ...(config.durablePi === true ? { durablePi: true } : {}) });
    case 'claude':
      return new ClaudeAdapter({ nativeAssetRoot: config.nativeAssetRoot });
    case 'codex':
      return new CodexAdapter({ nativeAssetRoot: config.nativeAssetRoot, ...(config.codexSandbox === undefined ? {} : { sandbox: config.codexSandbox }) });
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
  if (Object.hasOwn(config, 'codexSandbox')) {
    throw new TypeError('DaemonConfig.codexSandbox is only supported by createDaemon; configure the injected Codex adapter directly');
  }
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
  if (overrides.deviceCredentials !== undefined && config.deviceCredentials !== undefined) {
    throw new TypeError('configure OS deviceCredentials or inject a credential backend, not both');
  }
  if (Object.hasOwn(config, 'permissionDefaults')) {
    throw new DaemonConfigFieldRemovedError('permissionDefaults', 'DaemonConfig.permissionDefaults was removed: the local agent\'s own permission settings apply');
  }
  if (config.agentEgress !== undefined && Object.hasOwn(config.agentEgress, 'sanitizer')) {
    throw new DaemonConfigFieldRemovedError('agentEgress.sanitizer', 'DaemonConfig.agentEgress.sanitizer was removed: Agent egress goes to the Host as is');
  }
  if (Object.hasOwn(config, 'mcpLaunchCwd')) {
    throw new DaemonConfigFieldRemovedError('mcpLaunchCwd', 'DaemonConfig.mcpLaunchCwd was removed: MCP servers start in the session cwd, as the agent runtime does');
  }
  if (Object.hasOwn(config, 'toolImplementationAuthority')) {
    throw new DaemonConfigFieldRemovedError('toolImplementationAuthority', 'DaemonConfig.toolImplementationAuthority was removed: the SDK does not attest tool or runtime executables');
  }
  if (Object.hasOwn(config, 'hostedJournal') || Object.hasOwn(overrides, 'hostedJournal')) {
    throw new DaemonConfigFieldRemovedError('hostedJournal', 'DaemonConfig.hostedJournal was removed: every daemon journals; tune it under storage.journal and inject a journal as overrides.journal');
  }
  if (Object.hasOwn(config, 'resultDocument')) {
    throw new DaemonConfigFieldRemovedError('resultDocument', 'DaemonConfig.resultDocument was removed: a result-document offer carries its frozen schema and the runtime submits the outcome through the SDK-reserved submit_result tool');
  }
  if (config.providerProvisioning !== undefined && typeof config.providerProvisioning !== 'function') {
    throw new Error('DaemonConfig.providerProvisioning must be a handler function when present');
  }
  if (
    config.agentMemoryIntents !== undefined &&
    (config.agentMemoryIntents === null ||
      typeof config.agentMemoryIntents !== 'object' ||
      typeof config.agentMemoryIntents.fetch !== 'function' ||
      typeof config.agentMemoryIntents.complete !== 'function')
  ) {
    throw new Error('DaemonConfig.agentMemoryIntents must be a transport with fetch and complete functions when present');
  }
  if (config.agentHome !== undefined && config.gitWorkspace !== undefined) {
    throw new Error(
      'DaemonConfig.agentHome and DaemonConfig.gitWorkspace are mutually exclusive; Agent home is the only workspace authority for Agent offers',
    );
  }
  if (config.agentMemoryMcp !== undefined && config.agentMemoryMcp !== 'auto' && config.agentMemoryMcp !== 'off') {
    throw new Error('DaemonConfig.agentMemoryMcp must be auto or off when present');
  }
  if (config.agentMemoryExport !== undefined && config.agentMemoryExport !== true) {
    throw new Error('DaemonConfig.agentMemoryExport must be true when present');
  }
  if (config.agentMemoryExport === true && config.agentHome === undefined) {
    throw new Error('DaemonConfig.agentMemoryExport requires agentHome');
  }
  const agentMemoryMcpEnabled = config.agentMemoryMcp !== 'off';
  if (config.agentMemory !== undefined && config.agentHome === undefined) {
    throw new Error('DaemonConfig.agentMemory requires DaemonConfig.agentHome for the exact Agent memory authority');
  }
  if (config.agentMemoryHelperAssetRoot !== undefined) {
    if (config.agentHome === undefined) throw new Error('DaemonConfig.agentMemoryHelperAssetRoot requires agentHome');
    // Explicit configuration must fail closed even without projection or intent transport.
    resolveAgentMemoryFilesystemHelper(config.agentMemoryHelperAssetRoot);
  }
  if (Object.hasOwn(config, 'agentMemoryFilesystem')) {
    throw new Error('DaemonConfig.agentMemoryFilesystem is removed; an arbitrary helper is not admitted on this platform. Use the SDK release artifact.');
  }
  if (config.sdkHelperHost !== undefined) {
    resolveSdkReservedHelperBin('agent-message-mcp', config.sdkHelperHost);
  }
  // Platform support alone cannot admit memory. Compiled products and ordinary
  // JS builds can have Agent homes without the SDK native release assets.
  let resolveAgentMemoryFilesystemHelperBin: (() => string) | undefined;
  if (config.agentHome !== undefined && (agentMemoryMcpEnabled || config.agentMemory !== undefined || config.agentMemoryIntents !== undefined || config.agentMemoryExport === true)
    && isAgentMemoryFilesystemHelperSupported()) {
    try {
      resolveAgentMemoryFilesystemHelper(config.agentMemoryHelperAssetRoot);
      resolveAgentMemoryFilesystemHelperBin = () => resolveAgentMemoryFilesystemHelper(config.agentMemoryHelperAssetRoot);
    } catch (error) {
      if (config.agentMemoryHelperAssetRoot !== undefined || config.agentMemory !== undefined || config.agentMemoryIntents !== undefined || config.agentMemoryExport === true) throw error;
    }
  }
  const externalAgentMemoryFilesystem = resolveAgentMemoryFilesystemHelperBin !== undefined;
  if (config.agentMemory !== undefined && !isAgentMemorySecureFilesystemAvailable(externalAgentMemoryFilesystem)) {
    throw new Error('DaemonConfig.agentMemory requires a platform with safe descriptor-relative filesystem operations');
  }
  if (config.agentMemoryExport === true && !isAgentMemorySecureFilesystemAvailable(externalAgentMemoryFilesystem)) {
    throw new Error('DaemonConfig.agentMemoryExport requires a secure Linux, macOS or Windows x64 memory backend');
  }
  const agentMemoryMcpBin = !agentMemoryMcpEnabled || config.agentHome === undefined
    ? undefined
    : resolveAgentMemoryMcpBin(externalAgentMemoryFilesystem, config.sdkHelperHost);
  const agentMemoryDescribeBin = !agentMemoryMcpEnabled || config.agentHome === undefined
    ? undefined
    : resolveAgentMemoryDescribeBin(externalAgentMemoryFilesystem, config.sdkHelperHost);
  // The same daemon-level facts the task runner checks before it binds the memory MCP.
  const agentMemoryMcpAdmission: DaemonStatus['agentMemoryMcp'] = !agentMemoryMcpEnabled
    ? 'off'
    : agentMemoryMcpBin !== undefined && isAgentMemorySecureFilesystemAvailable(externalAgentMemoryFilesystem)
      ? 'admitted'
      : 'unavailable';
  const localAgentRelease = resolveLocalAgentReleaseIdentity(config.localAgentRelease);
  const suppliedJournal = overrides.journal;
  if (suppliedJournal !== undefined && (typeof suppliedJournal.listPrunableConfirmedTasks !== 'function' || typeof suppliedJournal.pruneConfirmedJournalTask !== 'function')) throw new LocalStorageConfigError('config', 'requires the journal confirmed-retention ports');
  const toolsetRegistry = new McpToolsetRegistry(config.mcpToolsets);
  validatePiByokLauncherConfig(config.piByokLauncher);
  if (config.durablePi !== undefined && typeof config.durablePi !== 'boolean') throw new Error('durablePi must be boolean');
  if (config.durablePi === true && (!config.agentHome || !config.piByokLauncher)) throw new Error('durablePi requires Agent home and Pi custody launcher');
  if (config.durablePi === true && process.platform === 'win32') throw new Error('durablePi is unavailable on Windows until parent-death Job Object recovery is validated');
  // M5 batch-3 (workstream 2): validated synchronously, up front — see
  // `DaemonConfig.maxTaskOutputBytes`'s own doc comment for the full
  // zero/negative-is-an-error / `Number.POSITIVE_INFINITY`-is-the-real-
  // opt-out pin. `configured > 0` is `false` for `NaN`, `0`, and any
  // negative number, and `true` for `Number.POSITIVE_INFINITY` — exactly the
  // three-way split this config wants.
  if (config.startupTimeoutMs !== undefined && (!Number.isSafeInteger(config.startupTimeoutMs) || config.startupTimeoutMs <= 0)) throw new Error('startupTimeoutMs must be a positive safe integer');
  if (config.artifactLimits !== undefined) {
    for (const value of [config.artifactLimits.maxFileBytes, config.artifactLimits.maxTaskBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('artifactLimits must contain positive safe integer byte budgets');
    }
  }
  if (config.maxTaskOutputBytes !== undefined && !(config.maxTaskOutputBytes > 0)) {
    throw new Error(
      `DaemonConfig.maxTaskOutputBytes must be a positive number (or omitted to use the ${DEFAULT_MAX_TASK_OUTPUT_BYTES}-byte default) — got ${config.maxTaskOutputBytes}. Pass Number.POSITIVE_INFINITY to explicitly disable the cap; 0 or a negative number is rejected rather than silently treated as "disabled".`,
    );
  }
  // Same up-front discipline as `maxTaskOutputBytes` above, with one
  // deliberate difference: there is no `Number.POSITIVE_INFINITY` opt-out.
  // An unbounded per-event payload is the exact failure this cap exists to
  // prevent, and a cap below `MIN_MAX_INLINE_EVENT_BYTES` cannot even hold
  // the descriptor that documents the omission — see
  // `DaemonConfig.maxInlineEventBytes`'s own doc comment.
  if (
    config.maxInlineEventBytes !== undefined
    && !(Number.isSafeInteger(config.maxInlineEventBytes) && config.maxInlineEventBytes >= MIN_MAX_INLINE_EVENT_BYTES)
  ) {
    throw new Error(
      `DaemonConfig.maxInlineEventBytes must be a safe integer of at least ${MIN_MAX_INLINE_EVENT_BYTES} (or omitted to use the ${DEFAULT_MAX_INLINE_EVENT_BYTES}-byte default) — got ${config.maxInlineEventBytes}. A smaller cap cannot hold the spill descriptor that documents the omission, and there is no "disabled" value: an unbounded tool_use.input/tool_result.output is what this cap exists to prevent.`,
    );
  }
  validateProgressBatcherOptions(config.progressBatch);
  if (config.agentEgress !== undefined && config.agentHome === undefined) {
    throw new Error('DaemonConfig.agentEgress requires DaemonConfig.agentHome for the per-Agent local spool');
  }
  if (config.strictAgentOnly === true && config.agentHome === undefined) {
    throw new Error('DaemonConfig.strictAgentOnly requires DaemonConfig.agentHome');
  }
  if (config.strictAgentOnly !== true && (typeof config.workspaceRoot !== 'string' || config.workspaceRoot === '')) {
    throw new Error('DaemonConfig.workspaceRoot is required unless DaemonConfig.strictAgentOnly is true');
  }
  // WP0: same up-front discipline as `maxTaskOutputBytes` above. A cap that
  // governs how many writers may share one Agent home is a correctness
  // control, so an unusable value is a construction error rather than
  // something the first offer discovers — and there is no
  // `Number.POSITIVE_INFINITY` opt-out here: "no cap" is exactly the
  // co-writing state this exists to prevent.
  if (Object.prototype.hasOwnProperty.call(config, 'maxConcurrentMutableSessionsPerAgentHome')) {
    throw new DaemonConfigFieldRemovedError(
      'maxConcurrentMutableSessionsPerAgentHome',
      'DaemonConfig.maxConcurrentMutableSessionsPerAgentHome was removed. A home has one writer Attempt; send concurrent tasks as homeAccess: \'memory-reader\' offers and set maxConcurrentReaderAttemptsPerAgentHome to limit them.',
    );
  }
  if (
    config.maxConcurrentReaderAttemptsPerAgentHome !== undefined
    && !(Number.isSafeInteger(config.maxConcurrentReaderAttemptsPerAgentHome)
      && config.maxConcurrentReaderAttemptsPerAgentHome > 0)
  ) {
    throw new Error(
      `DaemonConfig.maxConcurrentReaderAttemptsPerAgentHome must be a positive safe integer (or omitted to use the default of ${DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME}) — got ${config.maxConcurrentReaderAttemptsPerAgentHome}. 0, a negative number, NaN, or a non-integer is rejected rather than silently treated as "uncapped".`,
    );
  }
  // Resolved exactly once so the admission gate and the status readback below
  // can never report different numbers.
  const agentHomeReaderLimit = config.maxConcurrentReaderAttemptsPerAgentHome
    ?? DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME;
  const egressPolicy = resolveAgentEgressPolicy(config.agentEgress?.policy);
  const egressBatcherOptions: ProgressBatcherOptions | undefined = config.agentEgress === undefined
    ? config.progressBatch
    : {
        ...config.progressBatch,
        flushIntervalMs: Math.min(config.progressBatch?.flushIntervalMs ?? 250, egressPolicy.activity.maxCoalesceMs),
      };

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
  const storageConfig = resolveStorageConfig(storeDir, config.storage);
  const retentionClock = overrides.retention?.clock ?? (() => new Date());
  const scratchRoot = new ScratchRoot(storageConfig.scratchRoot, retentionClock);
  const storagePressure = new StoragePressure(storageConfig.budget);
  let retentionIdentity: JournalIdentity | undefined;

  /**
   * B-P2 local primitive. Three facts are resolved here, once, at construction:
   *
   * 1. The limits policy is VALIDATED now, not on the first call. A present but
   *    malformed policy is a construction error (same rule as the presence
   *    cadence and the assertion allowlist); an ABSENT section leaves the whole
   *    surface off, and all three methods answer `input_preparation_unconfigured`.
   * 2. The native compiler binds to the identity of the pinned official Pi
   *    release. If the client pin does not name that release the feature does
   *    not silently degrade to a caller-supplied identity — it answers
   *    `runtime_identity_unavailable` and compiles nothing.
   * 3. The service itself, which owns the durable record log under `storeDir`.
   */
  const inputPreparationLimits =
    config.inputPreparation === undefined ? undefined : validateInputPreparationLimits(config.inputPreparation.limits);
  /**
   * The ONE prepared-tool-surface entry, bound to this daemon's registry
   * (`./prepared-tool-surface.ts`).
   *
   * There is deliberately no second path: both
   * the local `input_preparation.prepare` control call and the remote
   * `agent.input.preparation` envelope reach this assembler through
   * `InputPreparationService.prepare`, so a preparation's fingerprints and an
   * offer's admission bind the same facts.
   *
   * The runtime environment is resolved PER CALL, exactly as the offer path
   * builds it — a value captured at construction would miss a later change.
   */
  const preparationRuntimeEnv = () => buildRuntimeEnv({ ambient: process.env });
  const preparedToolSurface = createPreparedToolSurfaceAssembler({
    memoryAvailable: () => agentMemoryMcpEnabled && isAgentMemorySecureFilesystemAvailable(resolveAgentMemoryFilesystemHelperBin !== undefined),
    toolsetRegistry,
    runtimeEnv: preparationRuntimeEnv,
    ...(agentMemoryDescribeBin === undefined ? {} : { agentMemoryDescribe: agentMemoryDescribeBin }),
  });
  let inputPreparationService: InputPreparationService | undefined;
  let inputPreparationInitialization: Promise<void> | undefined;
  /**
   * Set when the input-preparation lane is OFF for a reason the operator must
   * resolve, while the rest of the daemon runs: today only a durable record
   * log holding a record from an older record schema version. Fail closed and
   * scoped — the lane refuses typed (local control calls, remote completions,
   * no advertised capability, no prepared-offer lane) and nothing else is
   * affected. Nothing is migrated, read forward or deleted; the message names
   * the record log the operator archives.
   */
  let inputPreparationLaneOff:
    | { readonly code: 'input_preparation_record_log_unsupported'; readonly message: string }
    | undefined;
  function initializeInputPreparation(): Promise<void> {
    return inputPreparationInitialization ??= (async () => {
      if (config.inputPreparation === undefined || inputPreparationLimits === undefined) return;
      const compiler = createPiInputPreparationCompiler(resolvePinnedPiRuntimeIdentity());
      inputPreparationService = createInputPreparationService({
        storeDir, limits: inputPreparationLimits,
        authorityResolver: config.inputPreparation.authorityResolver,
        ...(config.inputPreparation.counter === undefined ? {} : { counter: config.inputPreparation.counter }),
        compiler, toolSurface: preparedToolSurface,
      });
    })();
  }

  /** Maps this service's typed refusals onto the wire. No refusal is ever widened into a result. */
  async function runInputPreparation(
    call: (service: InputPreparationService) => Promise<InputPreparationResult['receipt']>,
  ): Promise<InputPreparationResult> {
    if (config.inputPreparation === undefined) {
      throw new ControlError(
        'input_preparation_unconfigured',
        'this daemon is not configured for input preparation (DaemonConfig.inputPreparation is absent)',
      );
    }
    await initializeInputPreparation();
    if (inputPreparationLaneOff !== undefined) {
      throw new ControlError(inputPreparationLaneOff.code, inputPreparationLaneOff.message);
    }
    if (inputPreparationService === undefined) throw new ControlError('runtime_identity_unavailable', 'input preparation initialization did not produce a service');
    if (shuttingDown) {
      throw new ControlError('shutting_down', 'this daemon is shutting down and will not prepare new input');
    }
    try {
      return { receipt: await call(inputPreparationService) };
    } catch (error) {
      if (error instanceof InputPreparationRequestError) throw new ControlError(error.code, error.message);
      throw error;
    }
  }
  const teamWorkspaces = new LocalTeamWorkspace(storeDir);
  const store = new DeviceStore(storeDir, overrides.deviceCredentials === undefined ? createDeviceCredentialStore({
    productId: config.productId, storeDir, deviceCredentials: config.deviceCredentials,
  }) : overrides.deviceCredentials);
  // #654 E2d-1: the member entries live in the same OS custody as the
  // enrollment. An injected enrollment backend has no member custody, so such
  // a daemon refuses an E2EE pairing rather than split one device's secrets
  // across two custodians.
  const memberRecords = overrides.deviceCredentials === undefined
    ? new DeviceMemberRecords(createDeviceMemberCustody({ productId: config.productId, storeDir, deviceCredentials: config.deviceCredentials }))
    : undefined;
  /** This run's verified member, once the background resume finds one. */
  let deviceMember: DeviceMemberKeyring | undefined;
  let memberResuming = false;
  /** Set by each start: binds that run's sealed tasks to a ready member. */
  let activateSealedTasks: ((keyring: DeviceMemberKeyring) => void) | undefined;
  /** The freshness points a retired keyring left for the next run's member (§50d); a new enrollment voids them. */
  let carriedFreshness: MemberFreshness | undefined;
  const sealIdentityOf = (record: DeviceRecord, member: DeviceMemberKeyring | undefined): string | undefined => {
    const memberId = member?.session?.member.memberId;
    return memberId === undefined ? undefined : JSON.stringify([record.tenantId, record.deviceId, memberId]);
  };
  const memberStatus = (): DeviceMemberStatus => deviceMember ?? (memberResuming ? 'resuming' : 'none');
  let memberAbort: AbortController | undefined;
  let memberResume: Promise<void> | undefined;
  const logMember = (message: string): void => console.warn(`[byok/client] ${message}`);
  function memberClient(record: DeviceRecord, signal?: AbortSignal): E2eeMemberClient {
    const identity = enrollmentIdentityOf(record);
    return new E2eeMemberClient({
      serverUrl: config.serverUrl,
      auth,
      signer: new StoredDeviceProofSigner({
        auth, tenantId: identity.tenantId, productId: config.productId, keyId: identity.proofKeyId, keyEpoch: identity.proofKeyEpoch,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
  }
  const operationalHealth = new OperationalHealthTracker(storeDir);
  const ownedProcessLedger = new OwnedProcessLedger(storeDir);
  let detachOwnedProcessGroupLedger: (() => void) | undefined;
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
  // Construction performs only non-mutating path/config validation. The real
  // writable preflight runs after daemon ownership below and before transport
  // or capability publication, so relocation can exclude it race-free.
  if (config.strictAgentOnly === true) agentHomeManager?.preflightSync();
  const agentContentReadPolicies = resolveContentReadPolicies(egressPolicy, config.agentEgress?.contentRead);
  // Before authenticated enrollment is loaded, egress is deliberately unable
  // to persist or acknowledge tenant-scoped records. startUnderLease replaces
  // this with the exact loaded DeviceRecord binding before it accepts work.
  let agentEgress = new AgentEgressController({
    policy: egressPolicy,
  });
  // Git workspace mode excludes agentHome, so it is never strict and the
  // validation above has already required workspaceRoot.
  const gitWorkspaceManager = config.gitWorkspace ? overrides.gitWorkspace?.manager ?? new GitWorkspaceManager(config.workspaceRoot!, { ownerId: stableGitWorkspaceOwnerId(storeDir, config.productId) }) : undefined;
  const gitWorkspaceStore = config.gitWorkspace ? overrides.gitWorkspace?.store ?? new GitWorkspaceStore(storeDir) : undefined;
  // Every daemon journals (#924). Opening, schema-initializing and
  // quarantining the SQLite file waits until `startUnderLease` owns the
  // cross-process store lease; a rejected second daemon must not touch the
  // active daemon's DB/WAL/SHM before discovering that it is rejected. On a
  // runtime without `node:sqlite` the journal constructor refuses
  // (`JournalUnavailableError`) before any filesystem work.
  let ownedJournal: SqliteLocalTaskJournal | undefined;
  let journal: LocalTaskJournal | undefined = overrides.journal;
  let hostedStorageInitializationBarrierComplete = true;


  /** Construct every daemon-owned hosted writer only after ownership exists. */
  function initializeOwnedHostedStorage(): LocalTaskJournal {
    if (!journal) {
      const tuning = config.storage?.journal;
      try {
        ownedJournal = new SqliteLocalTaskJournal({
          storeDir,
          ...(tuning?.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: tuning.busyTimeoutMs }),
          ...(tuning?.maxRecordBytes === undefined ? {} : { maxRecordBytes: tuning.maxRecordBytes }),
          ...(overrides.journalOpenFaults === undefined ? {} : { openFaults: overrides.journalOpenFaults }),
        });
      } catch (err) {
        if (err instanceof JournalHandleCleanupError) hostedStorageInitializationBarrierComplete = false;
        throw err;
      }
      journal = ownedJournal;
    }
    return journal;
  }
  const retentionRegistry = createRetentionRegistry({
    storeDir, scratch: scratchRoot, config: storageConfig, clock: retentionClock,
    journal: () => journal, identity: () => retentionIdentity, preparation: () => inputPreparationService,
    ...(agentHomeManager === undefined ? {} : { home: agentHomeManager }),
    ...(agentSessionHandoffs === undefined ? {} : { handoffs: agentSessionHandoffs }),
    ...(config.workspaceRoot === undefined ? {} : { workspaceRoot: config.workspaceRoot }),
    ...(config.piByokLauncher?.sessionDir === undefined ? {} : { piSessionDir: config.piByokLauncher.sessionDir }),
  });
  const retentionSweeper = new RetentionSweeper({
    config: storageConfig, registry: retentionRegistry, pressure: storagePressure, clock: retentionClock,
    ...(overrides.retention?.timers === undefined ? {} : { timers: overrides.retention.timers }),
    freeBytes: overrides.retention?.freeBytesProvider ?? (async () => { const stats = await fs.statfs(storeDir); return Number(stats.bavail) * Number(stats.bsize); }),
    jitter: (sequence, baseMs) => deterministicJitterMs({ seed: `${config.productId}\0${storeDir}`, domain: 'maintenance', sequence, baseMs }),
    onSweep: report => {
      observer.noteRetentionSweep(report);
      void (report.failures === 0 ? operationalHealth.recordSuccess('maintenance') : operationalHealth.recordFailure('maintenance')).catch(() => undefined);
    },
    onFailure: (trigger, classId, code) => observer.noteRetentionFailure(trigger, classId, code),
  });

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
  const terminalCommits = new TerminalCommitQueue(taskId => {
    connection?.retryTaskReceipts(taskId);
    void runner?.retryTerminalFinalization(taskId).catch(error => {
      console.error('[byok/client] terminal finalization still requires recovery', error);
    });
  });
  // M3-2a: local observability — constructed once per daemon instance (not
  // per `start()`) so `subscribe()`/`tasks()` work immediately after
  // `createDaemonWithAdapters()` returns and keep accumulating across an
  // internal stop()/start() cycle within the same instance. See `observer.ts`.
  const outbound: OutboundStatus = { accepted: 0, duplicate: 0, rejected: 0, rejectedByReason: {}, rejectedTerminals: 0 };
  const observer = new DaemonObserver();
  // M4 Phase 2: registry backing the control socket's `approvals.list`/
  // `approvals.resolve` methods — see `approvals.ts`'s module doc comment.
  // Nothing populates it yet in Phase 2; it's constructed now so Phase 3
  // only needs to add producers.
  const approvalRegistry = new ApprovalRegistry();

  let connection: ConnectionManager | undefined;
  let blobLifecycleAbort: AbortController | undefined;
  // #654: sealed output uploads its ciphertext through its own blob client,
  // which shutdown aborts only after the terminal commit barrier. A queued
  // terminal can outlive its run, so its upload reads the current client.
  let sealedUploadAbort: AbortController | undefined;
  let sealedUploads: BlobClient | undefined;
  // A start under way opens a session, so a sealed output waits for its flags.
  let startInProgress = false;
  // The latest run's sealed tasks. A terminal the commit queue holds past a
  // failed stop seals through the run it runs in, never through the stopped
  // run's keyring, which its shutdown retires.
  let latestSealedTasks: SealedTasks | undefined;
  /** The latest run's (tenant, device, member); `undefined` while it has no usable member. */
  let latestSealIdentity: (() => string | undefined) | undefined;
  /** Set by each start: retires that run's member keyring at shutdown. */
  let retireSealedMember: (() => void) | undefined;
  let sealedOutputSettled: (() => Promise<void>) | undefined;
  let inputPreparationStatusAbort: AbortController | undefined;
  let lifecycle: DaemonLifecycle = { phase: 'stopped' };
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
  let serviceEnrollmentWaiting = false;
  let serviceEnrollmentTransitioning = false;
  let daemonOwnerLease: DaemonOwnerLease | undefined;
  // Presence and task context share one deployment declaration. Discovery is
  // asynchronous to start(); only Agent offers with host toolsets wait for it.
  let presencePublisher: PresencePublisher | undefined;
  let detectedRuntimeFacts: readonly RuntimeInfo[] = [];
  let runtimeObservations: RuntimeObservation[] = [];
  let resolvedEnvironment: ServiceEnvironmentStatus = serviceEnvironmentStatus();
  let environmentResolvedAt: string | undefined;
  let presenceDiscovery: AbortController | undefined;
  // One active read per connection generation; stale completions cannot publish.
  let presenceDiscoveryPass: {
    controller: AbortController;
    completion: Promise<void>;
    outcome: 'pending' | 'read' | 'failed' | 'timeout' | 'aborted';
  } | undefined;
  // Both network reads and individual offer waits are bounded. Reconnects do
  // not extend an offer's deadline. This is an operational wait, not token TTL.
  const capabilityDiscoveryTimeoutMs = 5_000;
  /**
   * The deployment declaration this daemon last READ (ADR-010), or `undefined`
   * when it has read none — which is what a failed read leaves behind too, on
   * purpose: a declaration that could not be read is exactly as informative as
   * one that declares nothing.
   *
   * Contract §8.1 is why this is now stored rather than consumed and dropped
   * inside the discovery pass. The task lane's capability gate has TWO channels
   * and both must hold, so the deployment-level answer has to outlive the read
   * that produced it — see {@link taskContextCapabilityAvailable}.
   */
  let deploymentDeclaration: CapabilityDeclaration | undefined;
  /**
   * The exact `CapabilityFlag[]` instance handed to `ConnectionManager`, which
   * reads it afresh for every `conn.hello` it builds. Held here so the one
   * capability whose answer arrives asynchronously can be added to (or removed
   * from) the advertisement a running daemon publishes, via `refreshHello()` —
   * the same mechanism an `mcpToolsets` reload already uses.
   */
  let helloCapabilities: CapabilityFlag[] = [];
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
      authRequestDeadlineMs: config.authRequestDeadlineMs,
      store,
      deviceName: config.deviceName,
      machineId: config.machineId ?? (() => resolveMachineId({ productId: config.productId })),
      // A proactive renewal can find the revocation while the poll is held.
      onRevoked: () => connection?.noteDeviceRevoked(),
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
        `[byok/client] WARNING: dangerouslyAllowInsecureRemote is set — proceeding with an insecure server URL (${formatServerUrl(config.serverUrl)}). ` +
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

  async function pair(pairingCode: string, options?: { readonly verificationSecret?: string }): Promise<DeviceEnrollment> {
    checkServerUrl();
    const verificationSecret = options?.verificationSecret === undefined ? undefined : checkVerificationSecret(options.verificationSecret);
    if (verificationSecret !== undefined && memberRecords === undefined) {
      throw new TypeError('an E2EE pairing needs the OS credential custody; this daemon uses an injected credential backend');
    }
    // Serialize every lifecycle mutation, not only pair/pair. A process-local
    // operation may borrow the daemon's retained cross-process lease, so pair,
    // start, stop, control shutdown and unpair must never decide independently
    // who releases that shared lease.
    const record = await runLifecycleMutation(() => pairUnderLease(pairingCode, verificationSecret));
    return Object.freeze({ deviceId: record.deviceId });
  }

  async function pairUnderLease(pairingCode: string, verificationSecret?: string): Promise<DeviceRecord> {
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
        previous = await auth.readCurrent();
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
        agentEgress = new AgentEgressController({ policy: egressPolicy });
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
      // A new enrollment is a new member (§7.5); the previous one's entries are void (10b).
      carriedFreshness = undefined;
      try {
        await memberRecords?.clear();
      } catch (error) {
        throw new PairedWithoutMemberError(record.deviceId, 'the previous E2EE member entries could not be deleted', error);
      }
      if (verificationSecret !== undefined) {
        try {
          await enrollDeviceMember({
            records: memberRecords!, client: memberClient(record), tenantId: record.tenantId, deviceId: record.deviceId,
            verificationSecret, log: logMember,
          });
        } catch (error) {
          throw new PairedWithoutMemberError(record.deviceId, 'its E2EE member enrollment failed; re-pair to enable E2EE', error);
        }
      }
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

  async function replaceControlServer(required: boolean, enrollmentOnly = false): Promise<void> {
    if (controlServerHandle) {
      await controlServerHandle.close();
      controlServerHandle = undefined;
    }
    try {
      const methods = enrollmentOnly
        ? {
            unary: {
              status: controlMethods.unary.status!,
              'enrollment.pair': controlMethods.unary['enrollment.pair']!,
            },
            stream: {},
          }
        : controlMethods;
      controlServerHandle = await startControlServer({ storeDir, productId: config.productId, methods });
    } catch (err) {
      if (required || err instanceof AnotherControlServerRunningError) throw err;
      console.warn(
        `[byok/client] control socket failed to start (continuing without it): ${err instanceof Error ? err.message : String(err)}`,
      );
      controlServerHandle = undefined;
    }
  }

  /** One report path per lifecycle fact: `status().lifecycle` and the `lifecycle` event change together. */
  function setLifecycle(next: DaemonLifecycle): void {
    if (JSON.stringify(next) === JSON.stringify(lifecycle)) return;
    lifecycle = next;
    observer.noteLifecycle(next);
  }

  function halted(reason: DaemonHaltReason): void {
    setLifecycle({ phase: 'halted', reason, at: new Date().toISOString() });
  }

  /**
   * #394's crash path for a run that already started: the connection has
   * stopped itself; record the `lifecycle` health failure and report the
   * crash. Like a halt, the daemon stays up for its owner to stop.
   */
  function crashed(): void {
    setLifecycle({ phase: 'crashed', at: new Date().toISOString() });
    void operationalHealth.recordFailure('lifecycle').catch((err: unknown) => {
      console.warn(`[byok/client] failed to persist operational health: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async function start(): Promise<void> {
    try {
      checkServerUrl();
    } catch (err) {
      if (err instanceof InsecureServerUrlError) throw new DaemonHaltError('config_invalid', { cause: err });
      throw err;
    }
    await runLifecycleMutation(startUnderLease);
  }

  /**
   * The halts a start can find locally. Anything else thrown from startup is
   * a crash. `store_owned` is found before this process owns the store, so it
   * is thrown only (see {@link DaemonHaltError}).
   */
  function startupHaltReason(err: unknown): DaemonHaltReason | undefined {
    if (err instanceof DaemonHaltError) return err.reason;
    if (err instanceof AnotherControlServerRunningError) return 'store_owned';
    if (err instanceof DeviceRecordRePairRequiredError) return 're_pair_required';
    if (err instanceof DeviceRevokedError) return 'device_revoked';
    return undefined;
  }

  async function startUnderLease(): Promise<void> {
    startInProgress = true;
    try {
      await runStartUnderLease();
    } finally {
      startInProgress = false;
    }
  }

  async function runStartUnderLease(): Promise<void> {
    terminalCommits.resume();
    // A new run begins; a previous run's halt or crash no longer describes it.
    if (lifecycle.phase === 'halted' || lifecycle.phase === 'crashed') setLifecycle({ phase: 'stopped' });
    if (!daemonOwnerLease) {
      try {
        daemonOwnerLease = await acquireDaemonOwner(storeDir, 'daemon');
      } catch (err) {
        if (err instanceof DaemonOwnerActiveError) throw new DaemonHaltError('store_owned', { cause: err });
        throw err;
      }
    }
    try {
    // #384 item 3 / #393: on POSIX a SIGKILLed or OOM-killed daemon leaves its
    // owned runtime groups running, and a tool process in one could still be
    // writing the Agent home or Git workspace a recovered task is handed back
    // for. With the owner lease held, every ledger record is such a residue:
    // end it before anything else here — before `daemon_interrupted` is
    // recorded, before admission, and so before any Agent home lease marker is
    // reclaimed as crash residue — and refuse to start while one survives.
    // Only then does this run's own ledger begin. win32 records none: its job
    // object already ended them.
    const reconciliation = await ownedProcessLedger.reconcile();
    if (reconciliation.recorded > 0) {
      console.warn(
        `[byok/client] previous daemon run left owned runtime process groups: recorded=${reconciliation.recorded} found=${reconciliation.found} terminated=${reconciliation.terminated} survived=${reconciliation.survived} liveWriter=${reconciliation.liveWriter}`,
      );
    }
    await scratchRoot.open(storeDir);
    detachOwnedProcessGroupLedger?.();
    detachOwnedProcessGroupLedger = attachOwnedProcessGroupLedger(ownedProcessLedger);
    // Initialization is one instance promise, including refusal. Even the
    // enrollment-only control endpoint must not expose a half-initialized service.
    await initializeInputPreparation();
    // Retention is owned by daemon lifecycle, including idle restarts. Open
    // only under the store lease and before exposing any control endpoint.
    //
    // A record log written in an older record schema version turns THIS LANE
    // off, not the daemon: the refusal stays fail-closed (no record is read
    // forward, migrated or deleted) but it is scoped to input preparation, so
    // ordinary tasks keep running while the operator archives the log. Every
    // other open failure still fails startup, exactly as before.
    try {
      await inputPreparationService?.open();
    } catch (error) {
      if (!(error instanceof InputPreparationUnsupportedRecordVersionError)) throw error;
      inputPreparationLaneOff = { code: 'input_preparation_record_log_unsupported', message: error.message };
      inputPreparationService = undefined;
      console.error(`[byok/client] input preparation is disabled on this daemon: ${error.message}`);
    }
    // Only the explicitly enabled service-enrollment path resolves credential
    // custody before hosted storage. A WinSW service has a different Windows
    // logon token from the operator CLI, so an unpaired service must be able to
    // bind the authenticated local control endpoint without first opening any
    // hosted writer. Default daemon startup preserves the established ordering
    // below: acquire the lease, initialize hosted storage, then load identity.
    let record: DeviceRecord | undefined;
    if (config.serviceEnrollment?.enabled === true) {
      record = await auth.loadExisting();
      if (!record) {
        startedAt = Date.now();
        serviceEnrollmentWaiting = true;
        serviceEnrollmentTransitioning = false;
        await retentionSweeper.runPass('startup');
        retentionSweeper.start();
        await replaceControlServer(true, true);
        setLifecycle({ phase: 'awaiting-enrollment' });
        return;
      }
    }
    serviceEnrollmentWaiting = false;
    serviceEnrollmentTransitioning = false;
    // This is the first point at which daemon-owned hosted storage may touch
    // the filesystem. The lease was acquired above, so SQLite open/schema/
    // quarantine and every pressure-engine writer are inside the same
    // authority boundary as auth renewal and the rest of daemon lifecycle.
    const activeJournal = initializeOwnedHostedStorage();
    record ??= await auth.loadExisting();
    if (!record) {
      throw new DaemonHaltError('unpaired');
    }
    const activePressureEngine = storagePressure;
    retentionIdentity = { tenantId: record.tenantId, productId: config.productId, deviceId: record.deviceId };
    // Loading an existing record arms proactive token renewal, whose final
    // step writes device.json. Acquire the store mutation lease first so a
    // rejected second daemon can never leave that timer behind as a writer.
    if (config.agentEgress !== undefined) {
      agentEgress = new AgentEgressController({
        policy: egressPolicy,
        tenantId: record.tenantId,
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

    const journalIdentity: JournalIdentity = { tenantId: record.tenantId, productId: config.productId, deviceId: record.deviceId };
    const resultReplyRecoveryTasks = new Map<string, { agentRef: AgentRef; contract: string }>();
    // Assigned once the blob client exists. Startup recovery before that
    // writes only `daemon_interrupted`, which stays plaintext (decision 12d).
    let sealedTasks: SealedTasks | undefined;
    /** This run's verified member, bound when it is first ready; a loss leaves it bound and keyless. */
    let sealedMember: DeviceMemberKeyring | undefined;
    /** The (tenant, device, member) of {@link sealedMember}, taken when it is bound, so retiring the member at shutdown keeps it. */
    let ownSealIdentity: string | undefined;
    const recordRecoveryFailure = async (task: import('./journal/journal').RecoverableTask, reason: string, interrupted = false) => {
      const offer = decodeEnvelope(task.envelopeBytes);
      const { agentRef } = offer.payload as { agentRef?: AgentRef };
      const failure = createEnvelope('task.fail', { reason, retryable: false,
        ...taskFailureField(DAEMON_TASK_FAILURE, connection?.getServerCapabilities() ?? []),
        ...terminalIdentity(task.claimedRuntime, agentRef),
        ...(interrupted ? { recovery: { kind: 'daemon_interrupted' as const, offerId: offer.id } } : {}),
      }, { taskId: task.taskId });
      const envelope = sealedTasks === undefined ? failure : await sealedTasks.sealRecovered(offer, failure);
      const bytes = encodeEnvelope(envelope);
      await activeJournal.recordTerminal({ taskId: task.taskId, terminalType: 'failed', bytes, payloadHash: journalHash(bytes),
        truthState: 'pending', attempt: 1, recordedAt: new Date().toISOString(),
        recovery: { disposition: interrupted ? 'interrupted' : 'abandoned', reason } });
    };
    const durableCursor = await cursorStore.load(config.serverUrl, record.deviceId) ?? 0;
    const recoveryTasks = await activeJournal.listRecoveryTasks(journalIdentity);
    // Scan every stored envelope before acting on any: a row of another
    // wire major stops startup with no journal row written, rewritten or
    // deleted (no daemon_interrupted terminal for a v2 offer, no replay).
    for (const task of recoveryTasks) assertJournalEnvelopeProtocol(task.envelopeBytes, task.taskId, 'recovery-offer');
    for (const terminal of await activeJournal.listPendingTerminals(journalIdentity)) {
      assertJournalEnvelopeProtocol(terminal.bytes, terminal.taskId, 'pending-terminal');
    }
    for (const task of recoveryTasks) {
      // No execution commitment and no local ack: let the authoritative cloud
      // mailbox redeliver (or suppress a cancelled offer). Never replay a cached
      // offer independently of cancellation/placement authority.
      if (task.localState === 'received' && task.seq > durableCursor) continue;
      const offer = decodeEnvelope(task.envelopeBytes);
      if (!isTaskOfferType(offer.type) || offer.task_id !== task.taskId) throw new Error('invalid durable recovery offer binding');
      const payload = offer.payload as { agentRef?: AgentRef; messageEgress?: { mode: string; contract?: string }; terminalProjection?: { mode: string; contract?: string } };
      const resultFailure = resultReplyFailureFromState(task.localState);
      if (resultFailure && (payload.agentRef === undefined || payload.messageEgress?.mode !== 'required' || typeof payload.messageEgress.contract !== 'string'
        || payload.terminalProjection?.mode !== 'result-document' || typeof payload.terminalProjection.contract !== 'string')) {
        throw new Error('durable result-reply failure does not match its original offer');
      }
      // A start after a failed stop in this process: the commit queue still
      // holds this task's real terminal and `resume()` above retries it. The
      // journal keeps the first terminal it records, so a recovery terminal
      // here would replace that result.
      if (terminalCommits.hasPending(task.taskId)) continue;
      if (resultFailure) { resultReplyRecoveryTasks.set(task.taskId, { agentRef: payload.agentRef!, contract: payload.messageEgress!.contract! }); continue; }
      await recordRecoveryFailure(task, 'daemon_interrupted', true);
    }

    // S3b (L-003): one measurement before this daemon can accept anything, so
    // the admission guard's first answer comes from a real reading rather than
    // the optimistic `normal` a fresh engine starts in — a device that booted
    // already over its hard watermark must decline the first offer, not the
    // second. Awaited, and deliberately not caught: hosted mode plus a storage
    // policy is an explicit request to gate on local storage, and a daemon that
    // cannot measure it cannot honour that (§12.7.2's fail-closed posture).
    // An INJECTED engine is left alone — its owner drives its cadence.
    await retentionSweeper.runPass('startup');
    retentionSweeper.start();

    startedAt = Date.now();
    // M4 Phase 2: a second start() on THIS SAME Daemon instance (e.g. the
    // revoke -> re-pair -> start() again recovery flow) restarts its own
    // control socket rather than colliding with itself — `stop()` was not
    // necessarily called in between (mirrors `connection`/`runner` above,
    // which are also silently replaced on a second start()). Only a
    // DIFFERENT process/instance still holding this storeDir's control
    // socket open is the "another daemon is running" fatal case below.
    // The control socket must never brick the rest of the daemon: "another
    // daemon's control server is already running against this exact
    // storeDir" is the one bind failure that stays fatal (a second daemon
    // writing to the same store concurrently is a real hazard); any other
    // bind failure (e.g. an unsupported filesystem) is logged and the
    // daemon proceeds without a control socket at all.
    await replaceControlServer(false);
    // The run marker begins only after this process has passed the daemon's
    // existing single-owner bind check. Writing it before that check would let
    // a rejected second process overwrite the live daemon's marker and create
    // a false crash record on the next restart.
    await operationalHealth.startRun();
    // The owner alone publishes this host-process observation into the event
    // stream. CLI audit persistence uses that same event, with no second writer.
    resolvedEnvironment = { ...serviceEnvironmentStatus() };
    environmentResolvedAt = new Date().toISOString();
    // A later start() (re-pair) detects again: until it does, report nothing
    // rather than the previous start's outcomes.
    runtimeObservations = [];
    observer.noteEnvironmentResolved({ ...resolvedEnvironment }, environmentResolvedAt);

    if (gitWorkspaceManager) {
      await gitWorkspaceManager.preflight();
      await gitWorkspaceStore?.initialize();
      await gitWorkspaceStore?.reconcile();
    }

    blobLifecycleAbort = new AbortController();
    const [{ runtimes, harnesses, observations }, blobClient] = await Promise.all([
      detectRuntimes(adapters),
      Promise.resolve(new BlobClient(config.serverUrl, auth, { signal: blobLifecycleAbort.signal })),
    ]);
    // Startup owns detection: local status keeps every outcome, while
    // conn.hello advertises only available runtimes. Neither re-probes.
    runtimeObservations = observations.map(observation => Object.freeze({ ...observation }));
    observer.noteRuntimesDetected(runtimeObservations.map(observation => ({ ...observation })));
    detectedRuntimeFacts = runtimes;
    const agentMemoryIntentBackend = await provenAgentMemoryIntentBackend();
    const capabilities = computeCapabilities(
      adapters,
      config.agentHome !== undefined,
      config.strictAgentOnly === true,
      agentHomeManager?.supportsTaskFreeProjection() === true,
      config.agentEgress !== undefined,
      agentContentReadPolicies,
      config.piByokLauncher !== undefined,
      inputPreparationService !== undefined,
      config.providerProvisioning !== undefined,
      agentMemoryIntentBackend !== undefined,
    );
    const agentHomeProjectionCompletion = agentHomeManager?.supportsTaskFreeProjection() === true
      ? new AgentHomeProjectionCompletionClient({
          serverUrl: config.serverUrl,
          auth,
          tenantId: record.tenantId,
          deviceId: record.deviceId,
        })
      : undefined;

    const processProviderProvisioningNotice = createProviderProvisioningNoticeProcessor({
      tenantId: record.tenantId,
      deviceId: record.deviceId,
      handler: config.providerProvisioning,
    });
    // Constructed unconditionally so a stale notice is answered with a closed
    // reason before any fetch: no transport → `transport_unconfigured`; no
    // proven backend (the capability was not advertised) →
    // `filesystem_unavailable`. Either keeps the mailbox row and the cursor.
    const processAgentMemoryIntentNotice = createAgentMemoryIntentProcessor({
      tenantId: record.tenantId,
      deviceId: record.deviceId,
      transport: config.agentMemoryIntents,
      homes: agentHomeManager,
      backend: agentMemoryIntentBackend,
      onIntegrity: (event) => observer.noteAgentMemoryIntentIntegrity(event),
    });

    /**
     * C07 G4-remote. Constructed UNCONDITIONALLY, unlike the projection client
     * above: a daemon with no `inputPreparation` section still has to be able
     * to answer a stale or mis-targeted envelope with a typed
     * `input_preparation_unconfigured` completion. Throwing instead would
     * freeze this device's redelivery cursor behind a row it can never
     * discharge, which is a worse failure than reporting the truth.
     *
     * That completion is ACCEPTED by cloud: the completion route asserts no
     * device capability (`cloud.ts`'s `completeInputPreparationFromStores`),
     * precisely so this rejection is recordable by a device that never
     * advertised `agent-input-preparation-v9`. The flag remains the admission
     * gate on `enqueueInputPreparation`.
     *
     * The handler takes the service directly, so a preparation runs IN-PROCESS.
     * Nothing here touches the local control socket — see
     * `input-preparation-remote.ts` for why that is the point.
     */
    inputPreparationStatusAbort = new AbortController();
    const inputPreparationCompletion = new InputPreparationCompletionClient({
      serverUrl: config.serverUrl,
      auth,
      tenantId: record.tenantId,
      deviceId: record.deviceId,
      statusReadSignal: inputPreparationStatusAbort.signal,
    });
    const handleRemoteInputPreparation = createRemoteInputPreparationHandler({
      deviceId: record.deviceId,
      service: inputPreparationService,
      limits: inputPreparationLimits,
      // The two absences are different facts and the Host is told which:
      // "this daemon does not do preparation" versus "its native closure did
      // not verify". Neither is ever widened into a compiled artifact.
      ...(config.inputPreparation !== undefined && inputPreparationService === undefined
        ? { unavailableReason: inputPreparationLaneOff?.code ?? 'runtime_identity_unavailable' }
        : {}),
      completion: inputPreparationCompletion,
      signal: blobLifecycleAbort.signal,
      resolveBlobText: (blobRef, signal) => blobClient.resolveInstruction(blobRef, { signal }),
    });

    capabilities.push('custom-harness');
    // #654 E2d-3: sealed task content needs this run's verified member. The
    // object exists before the restart replay, and its keyring holds no key
    // until the member is ready, so a recovered sealed terminal is sealed or
    // one of the closed plaintext forms (decision 74e). The member stays bound
    // after a loss: a sealed task must never fall back to plaintext output.
    sealedUploadAbort = new AbortController();
    sealedUploads = new BlobClient(config.serverUrl, auth, { signal: sealedUploadAbort.signal });
    const opened = new SealedTasks({
      keyring: {
        scopeCategories: async (scopeId) => sealedMember?.scopeCategories(scopeId),
        openingKey: async (scope) => sealedMember?.openingKey(scope),
        acceptHeader: async (header) => await sealedMember?.acceptHeader(header) === true,
        sealingKey: async (scopeId, minEpoch) => sealedMember?.sealingKey(scopeId, minEpoch),
      },
      tenantId: record.tenantId,
      deviceId: record.deviceId,
      blobs: {
        download: (ref) => blobClient.downloadBlob(ref, { signal: blobLifecycleAbort?.signal }),
        upload: (ciphertext) => sealedUploads!.uploadArtifact(ciphertext, 'application/octet-stream'),
      },
      // Between sessions, and while a start is under way, the next
      // session's flags are unknown. Once the daemon stopped, halted or
      // crashed with no start under way, no session will advertise any.
      serverCapabilities: () => {
        if (lifecycle.phase === 'halted' || lifecycle.phase === 'crashed') return [];
        if (lifecycle.phase === 'running') return connection?.isOpen() === true ? connection.getServerCapabilities() : undefined;
        return startInProgress ? undefined : [];
      },
    });
    sealedTasks = opened;
    latestSealedTasks = opened;
    sealedOutputSettled = () => opened.settled();
    activateSealedTasks = (keyring) => {
      if (sealedMember !== undefined) return;
      sealedMember = keyring;
      ownSealIdentity = sealIdentityOf(record, keyring);
    };
    // Only the next run receives this run's points, so a run with no member leaves none.
    retireSealedMember = () => { carriedFreshness = sealedMember?.retire(); };
    latestSealIdentity = () => sealIdentityOf(record, sealedMember);
    // Contract §8.1 / §8.3: the device-level capability string is NOT computed
    // here. It is the one flag whose answer depends on a deployment fact this
    // daemon has not read yet at this point in `start()`, so it is added (and
    // removed again) by `applyCapabilityDeclaration` against this exact array —
    // `ConnectionManager` rebuilds `conn.hello` from it, so a later change
    // reaches the server through `refreshHello()`. Reset to "no declaration
    // read" first: a restart must not inherit the previous run's answer about a
    // deployment it has not spoken to yet.
    deploymentDeclaration = undefined;
    helloCapabilities = capabilities;

    /** With `replaces`, the terminal replaces the refused terminal of that hash (#654 §77b). */
    const commitTerminal = (taskId: string, terminal: Envelope | (() => Promise<Envelope | undefined>), replaces?: string): void => {
      const ownerIdentity = ownSealIdentity;
      const plainBytes = typeof terminal === 'function' ? undefined : encodeEnvelope(terminal);
      // A sealed terminal is sealed once and its bytes are journaled; a retry
      // of the commit reuses them and never seals or uploads again (§9.2).
      let sealing: Promise<Envelope | undefined> | undefined;
      // The seal and its upload run before the commit joins the one commit
      // tail, so a slow upload holds no other task's terminal.
      const seal = typeof terminal === 'function'
        ? async (): Promise<void> => {
          sealing ??= terminal();
          try { await sealing; } catch (error) { sealing = undefined; throw error; }
        }
        : undefined;
      terminalCommits.enqueue(taskId, async () => {
        let envelope: Envelope | undefined;
        if (typeof terminal === 'function') {
          envelope = await sealing;
          if (envelope === undefined) return;
        } else envelope = terminal;
        const bytes = plainBytes ?? encodeEnvelope(envelope);
        try {
          const durableRecord = { taskId, terminalType: terminalKindOf(envelope.type)!, bytes,
            payloadHash: journalHash(bytes), truthState: 'pending' as const, attempt: 1, recordedAt: new Date().toISOString() };
          await (replaces === undefined ? activeJournal.recordTerminal(durableRecord) : activeJournal.replaceRefusedTerminal(taskId, replaces, durableRecord));
          // Read the first immutable winner, not an attempted replacement candidate.
          const durableTerminal = (await activeJournal.listPendingTerminals(journalIdentity)).find((row) => row.taskId === taskId);
          if (!durableTerminal || durableTerminal.truthState !== 'pending') return;
          const durable = decodeEnvelope(durableTerminal.bytes);
          overrides.executionRecoveryFault?.('terminal:before-send');
          observer.captureOutboundApproval(durable);
          connection?.send(durable);
        } catch (error: unknown) {
          if (!(error instanceof JournalRecordTooLargeError)) throw error;
          // A completed result can exceed the journal's bounded record size.
          // Do not truncate or invent a success: settle the exact task identity
          // with one small, canonical, non-retryable failure. The offer is the
          // sole source of AgentRef, so a foreign or missing ref is never guessed.
          const task = await activeJournal.readTask(taskId, journalIdentity);
          if (!task) throw new Error(`missing durable task ${taskId}`);
          if (!('envelopeBytes' in task)) throw new Error(`task ${taskId} has a withheld offer and no result`);
          const offer = decodeEnvelope(task.envelopeBytes);
          if (!isTaskOfferType(offer.type) || offer.task_id !== taskId) throw new Error(`invalid durable offer binding for ${taskId}`);
          const offerPayload = offer.payload as { agentRef?: AgentRef };
          const plainFailure = createEnvelope('task.fail', {
            reason: 'terminal_result_too_large', retryable: false,
            ...taskFailureField(DAEMON_TASK_FAILURE, connection?.getServerCapabilities() ?? []),
            ...terminalIdentity(task.claimedRuntime, offerPayload.agentRef),
          }, { taskId });
          // Only the owner run's tenant, device and member seal this failure.
          const sameIdentity = ownerIdentity !== undefined && ownerIdentity === latestSealIdentity?.();
          const failure = await latestSealedTasks!.sealRecovered(offer, plainFailure, sameIdentity);
          const failureBytes = encodeEnvelope(failure);
          await activeJournal.recordTerminal({ taskId, terminalType: 'failed', bytes: failureBytes,
            payloadHash: journalHash(failureBytes), truthState: 'pending', attempt: 1, recordedAt: new Date().toISOString() });
          const durableFailure = (await activeJournal.listPendingTerminals(journalIdentity)).find((row) => row.taskId === taskId);
          if (!durableFailure || durableFailure.truthState !== 'pending') return;
          const decoded = decodeEnvelope(durableFailure.bytes);
          observer.captureOutboundApproval(decoded);
          connection?.send(decoded);
          // Never recurse through arbitrary fallback terminals. A storage or
          // canonicalization failure remains visible and requires operator
          // recovery; the oversized result itself is never silently dropped.
        }
      }, seal);
    };

    /**
     * #654: seals a sealed task's terminal when the commit queue runs it. The
     * queue can hold it past a failed stop. Then it seals through the run it
     * runs in, after that run's start and member resume: a throw here is a
     * retry. A run whose resume found no member, or whose member is lost,
     * gives the closed plaintext form. Without an `owner` run, it always seals
     * through the task's journaled offer.
     */
    const sealQueuedTerminal = async (owner: SealedTasks | undefined, ownerIdentity: string | undefined, envelope: Envelope): Promise<Envelope | undefined> => {
      const taskId = envelope.task_id!;
      if (startInProgress) throw new Error(`${envelope.type} for sealed task ${taskId} waits for the start under way`);
      const current = latestSealedTasks!;
      if (current === owner) return owner.sealOutbound(envelope);
      if (memberResuming) throw new Error(`${envelope.type} for sealed task ${taskId} waits for this run's member`);
      const task = await activeJournal.readTask(taskId, journalIdentity);
      if (!task || !('envelopeBytes' in task)) throw new Error(`missing durable offer of sealed task ${taskId}`);
      // A run under another tenant, device or member never seals this task's output.
      return current.sealRecovered(decodeEnvelope(task.envelopeBytes), envelope, ownerIdentity !== undefined && ownerIdentity === latestSealIdentity?.());
    };

    // #654: a task waits on its approval request. One that cannot be sealed
    // (no sealing key, or over the inline frame) never reaches the Host, so
    // the device denies it locally and the task goes on or ends.
    const denyUnsentApproval = (envelope: Envelope): void => {
      const { approvalId } = envelope.payload as { approvalId?: string };
      if (envelope.type !== 'task.await_approval' || approvalId === undefined) return;
      console.error(`[byok/client] approval ${approvalId} of sealed task ${envelope.task_id} was not sent; denied locally`);
      try {
        approvalRegistry.resolve(approvalId, 'reject', 'the approval request could not be sealed for the Host');
      } catch {
        // Already resolved, for example by the approval timeout.
      }
    };

    // The journal owns terminal bytes; the transport owns one delivery queue.
    // A local write failure must never bypass durability and send different truth.
    // #654: a task that seals its output sends each outbound sealed, in order.
    const sendEnvelope: TaskRunnerDeps['send'] = (envelope) => {
      const terminal = envelope.task_id !== undefined && terminalKindOf(envelope.type) !== undefined;
      if (sealedTasks?.sealsOutbound(envelope)) {
        // The local observer reads the plaintext envelope; see `plainOf`.
        observer.captureOutboundApproval(envelope);
        const sealedTaskOutput = sealedTasks;
        if (terminal) {
          const ownerIdentity = ownSealIdentity;
          commitTerminal(envelope.task_id!, () => sealQueuedTerminal(sealedTaskOutput, ownerIdentity, envelope));
          return;
        }
        void sealedTaskOutput.sealOutbound(envelope).then(
          (sealed) => { if (sealed !== undefined) connection?.send(sealed); else denyUnsentApproval(envelope); },
          (error: unknown) => {
            console.error(`[byok/client] ${envelope.type} for sealed task ${envelope.task_id} not sent`, error);
            denyUnsentApproval(envelope);
          },
        );
        return;
      }
      if (!terminal) {
        observer.captureOutboundApproval(envelope);
        connection?.send(envelope);
        return;
      }
      commitTerminal(envelope.task_id!, envelope);
    };

    /**
     * #654 §77b: a sealed terminal that named its ciphertext blob and that the
     * Host refused gets one replacement, the failure of a terminal that cannot
     * be sealed. It seals with the member that sealed the refused terminal once
     * this run's start and member resume are over, else it is the closed
     * plaintext form. A journaled terminal is replaced in the journal, so the
     * Host receives exactly one terminal. Never throws: the caller is the
     * outbound settlement, which would post the refused bytes again.
     */
    const replaceRefusedTerminal = (refused: Envelope): void => {
      const failure = opened.refusedReplacement(refused);
      if (failure === undefined) return;
      const taskId = refused.task_id!;
      const refusedHash = journalHash(encodeEnvelope(refused));
      const ownerIdentity = JSON.stringify([record.tenantId, record.deviceId, (refused.payload as { sealed: { sender: string } }).sealed.sender]);
      commitTerminal(taskId, async () => {
        // A repeated trigger after the replacement committed changes nothing.
        const durable = (await activeJournal.listPendingTerminals(journalIdentity)).find((row) => row.taskId === taskId);
        if (durable?.payloadHash !== refusedHash || durable.truthState !== 'failed') return undefined;
        return sealQueuedTerminal(undefined, ownerIdentity, failure);
      }, refusedHash);
    };

    // #826: an inbound envelope above the journal record bound is never stored
    // or run, and it must not hold the cursor. An offer is declined once,
    // non-retryably, from a journal record kept without its bytes. Any other
    // envelope is dropped; for a task.cancel, the local task runs until it ends.
    const refuseOverBoundEnvelope = async (envelope: Envelope, record: ReceivedEnvelopeRecord, byteLength: number): Promise<void> => {
      const taskId = envelope.task_id;
      if (!isTaskOfferType(envelope.type) || taskId === undefined) {
        console.warn(`[byok/client] dropped inbound ${envelope.type} (seq=${record.seq}): ${byteLength} bytes is over the journal record bound`);
        return;
      }
      const { agentRef } = envelope.payload as { agentRef?: AgentRef };
      // A sealed offer this device cannot hold is one it cannot open; a device
      // with no keyring declines every sealed offer for want of a key. The
      // closed code is a value gate on the server's `sealed-payload-v1`.
      const code = sealedMember === undefined ? 'sealed_key_unavailable' : 'sealed_open_failed';
      const serverCapabilities = connection?.getServerCapabilities() ?? [];
      const closedCode = isSealedMessageType(envelope.type)
        && requiredReceiverCapabilities('task.decline', { reason: code, code }).every((flag) => serverCapabilities.includes(flag));
      const decline = createEnvelope('task.decline', {
        ...(closedCode ? { reason: code, code } : { reason: 'inbound_envelope_too_large' }),
        retryable: false, ...(agentRef === undefined ? {} : { agentRef }),
      }, { taskId });
      const bytes = encodeEnvelope(decline);
      const receipt = await activeJournal.appendWithheldOffer({
        identity: journalIdentity, envelopeId: record.envelopeId, taskId, seq: record.seq, bytesHash: record.bytesHash,
        byteLength, receivedAt: record.receivedAt, decline: { bytes, payloadHash: journalHash(bytes) },
      });
      // The decline is already durable. A new receipt sends it; a redelivery
      // retries a send still in flight (startup replays any other pending one).
      if (receipt.created) sendEnvelope(decline);
      else if (terminalCommits.hasPending(taskId)) await terminalCommits.retry(taskId);
      await terminalCommits.receipt(taskId);
    };

    // Serialize the marker/acceptance handshake across inbound dispositions
    // and turn_end. Acceptance evidence precedes deletion of the exact draft.
    let resultReplyTransitionTail: Promise<void> = Promise.resolve();
    const withReplyTransition = (write: () => Promise<void>): Promise<void> => {
      const operation = resultReplyTransitionTail.then(write);
      resultReplyTransitionTail = operation.catch(() => {});
      return operation;
    };
    const recordReplyState = (taskId: string, failure?: import('./result-reply-failure').ResultReplyFailure): Promise<void> => {
      return withReplyTransition(async () => {
        const task = await activeJournal.readTask(taskId, journalIdentity);
        if (!task || task.localState.startsWith('terminal:')) return;
        const priorFailure = resultReplyFailureFromState(task.localState);
        const accepted = failure === undefined || task.localState === 'required-reply-accepted' || task.localState.endsWith('-accepted');
        const kind = failure ?? priorFailure;
        const state = kind === undefined ? 'required-reply-accepted' : `${kind}${accepted ? '-accepted' : ''}`;
        await activeJournal.recordTransition({ transitionId: `result-reply:${taskId}:${state}`, taskId,
          to: state, occurredAt: new Date().toISOString() });
      });
    };
    const deps: TaskRunnerDeps = {
      adapters,
      runtimeAllowlist: config.runtimeAllowlist,
      // M5 batch-3: see `DaemonConfig.runtimePreference`'s own doc comment above.
      runtimePreference: config.runtimePreference,
      ...(config.workspaceRoot === undefined ? {} : { workspaceRoot: config.workspaceRoot }),
      ...(agentHomeManager === undefined ? {} : { agentHome: agentHomeManager }),
      ...(config.strictAgentOnly === true ? { strictAgentOnly: true } : {}),
      // Already validated up front — see `DaemonConfig.maxConcurrentReaderAttemptsPerAgentHome`.
      maxConcurrentReaderAttemptsPerAgentHome: agentHomeReaderLimit,
      scratchRoot,
      ...(agentSessionHandoffs === undefined ? {} : { agentSessionHandoffs }),
      deviceId: record.deviceId,
      getMcpToolsets: () => toolsetRegistry.snapshot().toolsets,
      // The prepared-Execution lane, present only on a daemon whose input
      // preparation service actually constructed — which is also the only
      // daemon that advertises `agent-input-preparation-v9` and can hold a record
      // a `task.offer_prepared` could name. The three device facts travel with
      // the store because this file already owns them: re-deriving the
      // installed runtime identity or the operator's policy revision inside the
      // task runner would be a second opinion about the same configuration.
      ...(inputPreparationService === undefined || inputPreparationLimits === undefined
        ? {}
        : {
          inputPreparationLane: {
            store: inputPreparationService.store,
            // The service's own once-only open latch. The task runner awaits
            // it before its first record read so a restarted daemon that has
            // served no control call yet still sees its durable records; the
            // replay behind it stays the service's single authority.
            open: inputPreparationService.open,
            runtime: inputPreparationService.runtime,
            policyRevision: inputPreparationLimits.revision,
            authorizeAgentMemory: (binding) => inputPreparationService!.authorizeAgentMemory(binding),
            toolsetDefinitionRevisions: () => new Map(
              toolsetRegistry.status().toolsets.map((row) => [row.id as string, row.definitionRevision]),
            ),
          },
        }),
      // Queue the exact bytes; observer delivery projections run only after
      // the awaited outbound settlement, including terminal journal fsync.
      send: sendEnvelope,
      ...(config.durablePi !== true ? {} : { durablePi: true, recordDurableTransition: async (taskId: string, leaseId: string, kind: string, ordinal: number) => {
        await withReplyTransition(async () => {
          const task = await activeJournal.readTask(taskId, journalIdentity);
          const to = task?.localState.startsWith('required-reply-') ? task.localState : 'running';
          await activeJournal.recordTransition({ transitionId: randomUUID(), taskId, to,
            occurredAt: new Date().toISOString(), detail: JSON.stringify({ kind, leaseId, ordinal }) });
        });
      } }),
      recordResultReplyFailure: (taskId, failure) => recordReplyState(taskId, failure),
      recordAgentMessageAccepted: taskId => recordReplyState(taskId),
      beforeClaim: async (taskId: string, runtime: string) => {
        await activeJournal.recordAdmission({ taskId, admitted: true, claimedRuntime: runtime, decidedAt: new Date().toISOString() });
      },
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
      onExecutionRecord: (record) => observer.noteExecutionRecord(record),

      // M4 Phase 3: the SAME `ApprovalRegistry` instance the control
      // socket's own `approvals.list`/`approvals.resolve` methods already
      // share (see that field's own construction above) — `TaskRunner
      // .requestApproval` registers into it directly, so a decision arriving
      // via either the server wire or the local CLI resolves the identical
      // entry. `storeDir`/`productId` let the prepared operation approval channel
      // (populated per-task by `TaskRunner`) tell an out-of-process helper
      // exactly which control socket to dial.
      approvalRegistry,
      storeDir,
      productId: config.productId,
      tenantId: record.tenantId,
      // U2 terminal inference usage consumes the one U4a-resolved,
      // process-immutable identity captured above. This is composition-only:
      // TaskRunner receives no config, manifest, or second identity resolver.
      localAgentRelease,
      approvalTimeoutMs: overrides.approvalTimeoutMs,
      // Finding F5(a): see TaskRunnerDeps.shutdownInterruptTimeoutMs's own doc comment.
      shutdownInterruptTimeoutMs: overrides.shutdown?.taskInterruptTimeoutMs,
      // M5 batch-3 (workstream 2): see DaemonConfig.maxTaskOutputBytes's own doc comment — already validated above.
      awaitTerminalCommit: taskId => terminalCommits.receipt(taskId),
      maxTaskOutputBytes: config.maxTaskOutputBytes,
      artifactLimits: config.artifactLimits,
      startupTimeoutMs: config.startupTimeoutMs,
      // See DaemonConfig.maxInlineEventBytes's own doc comment — already validated above.
      maxInlineEventBytes: config.maxInlineEventBytes,
      ...(config.agentHome === undefined ? {} : {
        agentResultMcpBin: (() => {
          const resolved = resolveSdkReservedHelperBin('agent-result-mcp', config.sdkHelperHost);
          return Object.freeze({ command: resolved.command, args: resolved.args });
        })(),
        agentResultMcpPreflight: preflightAgentResultMcp,
      }),
      ...(agentMemoryMcpBin === undefined ? {} : { agentMemoryMcpBin }),
      ...(config.agentMemoryMcp === undefined ? {} : { agentMemoryMcp: config.agentMemoryMcp }),
      ...(agentMemoryDescribeBin === undefined ? {} : { agentMemoryDescribeBin }),
      ...(resolveAgentMemoryFilesystemHelperBin === undefined ? {} : { resolveAgentMemoryFilesystemHelperBin }),
      ...(config.agentMemoryHelperAssetRoot === undefined ? {} : { agentMemoryHelperAssetRoot: config.agentMemoryHelperAssetRoot }),
      ...(config.agentHome !== undefined && config.agentEgress !== undefined ? {
        agentMessageMcpBin: resolveAgentMessageMcpBin(config.sdkHelperHost),
        agentMessageMcpPreflight: preflightAgentMessageMcp,
      } : {}),
      ...(config.agentMemory === undefined ? {} : { agentMemoryHostedProjection: config.agentMemory }),
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
      sealedTasks: opened,
      // Same late-binding closure as `getServerCapabilities`; with no
      // connection yet there is no advertisement, and that is an error.
      getIngressBudget: () => {
        if (connection === undefined) throw new Error('no activity ingress has been advertised; the connection is not started');
        return connection.getIngressBudget();
      },
      // Contract §8.1: the nonce injection asks the SAME gate the RPC and the
      // hello advertisement ask, read fresh at offer time for the same reason
      // `getServerCapabilities` is — the declaration lands after this `deps`
      // object is built.
      hostTaskContextAvailable: () => taskContextCapabilityAvailable(),
      prepareHostTaskContext: waitForHostTaskContext,
      // S3b (L-003): the production admission guard — §12.7.2.1's hard-pressure
      // row. Reads the state the last maintenance tick computed (no disk work
      // on the offer path), and is absent entirely when no storage policy is
      // configured, which is what keeps `handleOffer` byte-identical for every
      // daemon that does not opt in.
      ...(activePressureEngine ? { admissionGuard: () => activePressureEngine.admissionGuard() } : {}),
    };
    runner = new TaskRunner(deps);
    if (config.agentHome !== undefined && config.agentEgress !== undefined) {
      await runner.recoverAgentMessageOutboxes(path.join(config.agentHome.hostStorageRoot, 'agents'), resultReplyRecoveryTasks,
        async taskId => (await activeJournal.readTask(taskId, journalIdentity))?.localState === 'terminal:cancelled');
    }
    // Both prerequisites survive process death in their existing authorities:
    // immutable terminal bytes in the journal and exact disposition in the outbox.
    // Queueing the message first is insufficient: a failed POST must not let the
    // terminal close cloud admission while its message is still pending.
    const replayRecoveryTerminals = async (taskId?: string): Promise<void> => {
      for (const id of resultReplyRecoveryTasks.keys()) {
        if (taskId !== undefined && taskId !== id) continue;
        const task = await activeJournal.readTask(id, journalIdentity);
        const failure = task && resultReplyFailureFromState(task.localState);
        if (!task || !failure || !('envelopeBytes' in task)) { resultReplyRecoveryTasks.delete(id); continue; }
        const state = runner?.recoveredAgentMessageState(id);
        const accepted = task.localState.endsWith('-accepted');
        if (!accepted && state !== 'refused') continue;
        const offer = decodeEnvelope(task.envelopeBytes);
        const payload = offer.payload as { agentRef?: AgentRef; terminalProjection: { contract: string } };
        const reason = accepted ? resultReplyFailureReason(failure, payload.terminalProjection.contract) : 'required Agent message was refused';
        await recordRecoveryFailure(task, reason);
        resultReplyRecoveryTasks.delete(id);
      }
      for (const terminal of await activeJournal.listPendingTerminals(journalIdentity)) {
        if (taskId !== undefined && terminal.taskId !== taskId) continue;
        // A refusal recorded before its replacement committed (#654 §77b).
        if (terminal.truthState === 'failed' && !terminalCommits.hasPending(terminal.taskId)) replaceRefusedTerminal(decodeEnvelope(terminal.bytes));
        if (terminal.truthState !== 'pending') continue;
        if (runner?.hasPendingRecoveredAgentMessage(terminal.taskId)) continue;
        assertJournalEnvelopeProtocol(terminal.bytes, terminal.taskId, 'pending-terminal');
        const envelope = decodeEnvelope(terminal.bytes);
        if (envelope.task_id !== terminal.taskId || terminalKindOf(envelope.type) !== terminal.terminalType) {
          throw new Error('durable terminal execution binding mismatch');
        }
        overrides.executionRecoveryFault?.('terminal:before-send');
        observer.captureOutboundApproval(envelope);
        connection?.send(envelope);
      }
    };

    const handleAgentHomeProjectionEnvelope = async (envelope: Envelope): Promise<boolean> => {
      if (envelope.type !== 'agent.home.projection') return false;
      if (agentHomeManager === undefined || agentHomeProjectionCompletion === undefined) {
        // A sender cannot turn a missing local consumer into a successful
        // no-op. Throwing retains the mailbox row/cursor for operator repair.
        throw new Error('task-free Agent-home projection is not configured on this daemon');
      }
      const outcome = await agentHomeManager.project(envelope.payload);
      await agentHomeProjectionCompletion.complete({
        requestId: envelope.payload.requestId,
        agentRef: envelope.payload.agentRef,
        projectionHash: envelope.payload.projectionHash,
        outcome,
      });
      return true;
    };
    const handleAgentInputPreparationEnvelope = async (envelope: Envelope): Promise<boolean> => {
      if (envelope.type !== 'agent.input.preparation') return false;
      // Resolves once the completion is durably recorded by the cloud. Anything
      // that prevents that recording throws, so the cursor stays put and the
      // row is redelivered — a redelivery reads the immutable cloud completion
      // before local readiness/deadline checks or a second compile/count.
      await handleRemoteInputPreparation(envelope.payload);
      return true;
    };
    const handleAgentMemoryIntentEnvelope = async (envelope: Envelope): Promise<boolean> => {
      if (envelope.type !== 'agent.memory.intent.available') return false;
      // Task-free and never journaled, like provisioning: resolves only after
      // the Host readback matched a durable terminal and the `ackedAt`
      // barrier succeeded. Any throw keeps the row and the cursor.
      await processAgentMemoryIntentNotice(envelope.payload);
      return true;
    };
    const handleProviderProvisioningEnvelope = async (envelope: Envelope): Promise<boolean> => {
      if (envelope.type !== 'provider.provisioning.available') return false;
      // Task-free and never journaled: it is consumed here, ahead of the
      // journal append below, and resolves only on a durable terminal
      // readback. Any throw keeps the row and the cursor for redelivery.
      await processProviderProvisioningNotice(envelope.payload);
      return true;
    };
    const handleE2eeKeyPackageEnvelope = async (envelope: Envelope): Promise<boolean> => {
      if (envelope.type !== 'e2ee.key_package.available') return false;
      // Task-free and never journaled, like provisioning. It throws only while
      // the member resumes or when a Host read fails or times out, which keeps
      // the row; a final Host answer is acknowledged.
      await processE2eeKeyPackageNotice(envelope.payload, memberStatus(), logMember);
      return true;
    };
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
      harnesses,
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
      onEnvelope: async (envelope) => {
        if (tenantRebinding) {
          throw new Error('tenant enrollment is being re-paired; inbound work is blocked until restart');
        }
        observer.handleInboundEnvelope(envelope);
        if (await handleAgentHomeProjectionEnvelope(envelope)) return;
        if (await handleAgentInputPreparationEnvelope(envelope)) return;
        if (await handleProviderProvisioningEnvelope(envelope)) return;
        if (await handleAgentMemoryIntentEnvelope(envelope)) return;
        if (await handleE2eeKeyPackageEnvelope(envelope)) return;
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
        const record = toJournalEnvelopeRecord(envelope, journalIdentity);
        try {
          await activeJournal.appendEnvelope(record);
        } catch (error: unknown) {
          if (!(error instanceof JournalRecordTooLargeError)) throw error;
          await refuseOverBoundEnvelope(envelope, record, error.actualBytes);
          return;
        }
        if (isTaskOfferType(envelope.type) && envelope.task_id !== undefined) {
          // A selected terminal fences admission even if its transaction rolled
          // back to received. Check before reading a possibly stale task row.
          if (terminalCommits.hasPending(envelope.task_id)) {
            await terminalCommits.retry(envelope.task_id);
            return;
          }
          const task = await activeJournal.readTask(envelope.task_id, journalIdentity);
          if (!task) throw new Error('durable offer has no execution record');
          if (task.localState !== 'received') {
            await terminalCommits.retry(envelope.task_id);
            return;
          }
        }
        if (envelope.type === 'task.cancel' && envelope.task_id !== undefined && resultReplyRecoveryTasks.has(envelope.task_id)) {
          const taskId = envelope.task_id;
          const binding = resultReplyRecoveryTasks.get(taskId)!;
          await runner!.cancelRecoveredAgentMessage(taskId, async () => {
            // Without its offer the cancel cannot tell a sealed task: it is never sent.
            const task = await activeJournal.readTask(taskId, journalIdentity);
            if (!task || !('envelopeBytes' in task)) throw new Error(`missing durable offer of recovered task ${taskId}`);
            const cancelled = createEnvelope('task.cancelled', { reason: envelope.payload.reason,
              ...terminalIdentity(task.claimedRuntime, binding.agentRef) }, { taskId });
            sendEnvelope(await opened.sealRecovered(decodeEnvelope(task.envelopeBytes), cancelled));
            await terminalCommits.receipt(taskId);
          });
          resultReplyRecoveryTasks.delete(taskId);
        } else await runner?.handleEnvelope(envelope);
        if (envelope.type === 'agent.message.disposition') {
          // handleEnvelope fsyncs only an exact disposition before this
          // gate opens. A crash before sending leaves the journal pending.
          await replayRecoveryTerminals(envelope.task_id);
        }
        // In particular, a pre-claim decline must be durable before ack.
        if (envelope.task_id !== undefined) await terminalCommits.receipt(envelope.task_id);
      },
      onOutboundQueued: (envelope) => {
        if (terminalKindOf(envelope.type) !== undefined) overrides.executionRecoveryFault?.('terminal:queued');
      },
      beforeOutboundPost: (envelopes) => {
        if (envelopes.some((envelope) => terminalKindOf(envelope.type) !== undefined)) overrides.executionRecoveryFault?.('outbound:before-post');
      },
      onOutboundSettled: async (settlements) => {
        // All terminal fsyncs must succeed before publishing any observation.
        // A retry after a partial local write can repeat the idempotent journal
        // operation, without double-counting an earlier part of this batch.
        for (const settlement of settlements) {
          const { envelope } = settlement;
          if (terminalKindOf(envelope.type) === undefined || envelope.task_id === undefined) continue;
          const hash = journalHash(encodeEnvelope(envelope));
          if (settlement.outcome === 'rejected') {
            await activeJournal.rejectTerminal(envelope.task_id, hash, settlement.reason);
            replaceRefusedTerminal(envelope);
          } else {
            overrides.executionRecoveryFault?.('outbound:after-ack');
            await activeJournal.confirmTerminal(envelope.task_id, hash);
          }
        }
        for (const settlement of settlements) {
          const { envelope } = settlement;
          outbound[settlement.outcome] += 1;
          if (settlement.outcome !== 'rejected') { observer.handleOutboundEnvelope(sealedTasks?.plainOf(envelope) ?? envelope); continue; }
          const rejection = {
            envelopeId: envelope.id, type: envelope.type,
            ...(envelope.task_id === undefined ? {} : { taskId: envelope.task_id }),
            reason: settlement.reason, terminal: terminalKindOf(envelope.type) !== undefined,
          };
          outbound.rejectedByReason[rejection.reason] = (outbound.rejectedByReason[rejection.reason] ?? 0) + 1;
          if (rejection.terminal) outbound.rejectedTerminals += 1;
          outbound.lastRejection = rejection;
          observer.noteOutboundRejected(sealedTasks?.plainOf(envelope) ?? envelope, rejection);
        }
      },
      onStateChange: (state) => {
        setLifecycle({ phase: 'running', connection: state });
        // Discovery is armed before the first connection can deliver offers.
        // Every open replaces the read, so rollout/reconnect facts cannot be
        // borrowed from a previous connection generation.
        if (state === 'open') {
          runner?.retryRecoveredAgentMessages();
          runPresenceDiscovery();
        }
      },
      onHalted: (reason) => halted(reason),
      onCrashed: () => crashed(),
      // Reliable records held for `capability_missing` go out as soon as an
      // advertisement carries the ack capability — on every reconnect, not
      // only at start.
      onCapabilitiesAdvertised: (added) => {
        if (!added.includes(AGENT_EGRESS_RELIABLE_ACK_CAPABILITY) || connection === undefined) return;
        for (const record of agentEgress.retryableReliableRecords(connection.getServerCapabilities())) {
          dispatchReliableRecord(record);
        }
      },
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
    await replayRecoveryTerminals();
    startPresenceProducer();
    // Before the connection, so a key package notice in the first poll waits for the resume.
    startDeviceMember(record);
    await connection.start();
    daemonStarted = true;
    } catch (err) {
      // A failed start opens no session: its teardown settles a queued
      // terminal as a stop does.
      startInProgress = false;
      const haltReason = startupHaltReason(err);
      if (haltReason === undefined) {
        // #394: a crash, the one start failure a restart may fix. Recorded so
        // that a crash loop degrades operational health.
        try {
          await operationalHealth.startRun();
          await operationalHealth.recordFailure('lifecycle');
        } catch (healthError) {
          console.warn(`[byok/client] failed to persist operational health: ${healthError instanceof Error ? healthError.message : String(healthError)}`);
        }
      } else if (haltReason !== 'store_owned') {
        halted(haltReason);
      }
      const thrown = haltReason === undefined || err instanceof DaemonHaltError ? err : new DaemonHaltError(haltReason, { cause: err });
      try {
        // startUnderLease already owns the process-local lifecycle slot. Run
        // teardown directly; queueing requestShutdown here would wait on this
        // operation itself and deadlock.
        await runShutdownSequence('startup failed', { drainTimeoutMs: 0 });
      } catch (cleanupError) {
        throw new AggregateError([thrown, cleanupError], 'daemon startup failed and teardown was incomplete');
      }
      throw thrown;
    }
  }

  /**
   * Contract §8.1 / §8.3: is the task lane's capability gate actually in place
   * on this daemon, right now?
   *
   * BOTH halves, and nothing else counts as either:
   *
   * 1. This daemon can sign at all — `deviceAssertion.audiences` is configured
   *    and non-empty. A daemon that issues no assertions cannot serve a lane
   *    made of them.
   * 2. This daemon has READ a deployment declaration that names
   *    `host-mcp-task-context`. Not "assumed", not "the route 404'd so probably
   *    old": an unread declaration leaves `deploymentDeclaration` undefined and
   *    this answer `false`.
   *
   * Every consumer of the lane asks THIS function — the `conn.hello`
   * advertisement, the nonce injection, and the `task_assertion.issue` RPC — so
   * the three cannot disagree about whether the lane is open.
   *
   * §8.3 is the reason the false answer is a plain refusal: a missing
   * capability makes the task lane `unavailable`, never a reason to fall back
   * to a device assertion, which this lane does not accept in any case.
   */
  function taskContextCapabilityAvailable(): boolean {
    if (deviceAssertionAudiences === undefined) return false;
    if (deploymentDeclaration === undefined) return false;
    return declares(deploymentDeclaration, HOST_MCP_TASK_CONTEXT_CAPABILITY);
  }

  /**
   * Records what the latest discovery pass read (or, on failure, that it read
   * nothing) and republishes the `conn.hello` advertisement if that changed the
   * device-level half of §8.1's gate.
   *
   * The device capability string is advertised only after the deployment-level
   * declaration has actually been read, so the FIRST `conn.hello` of a run
   * never claims the task lane — discovery runs off the connection path and has
   * not answered yet. That ordering is deliberate rather than tolerated: a
   * daemon that advertised the capability before reading the declaration would
   * be promising a lane whose other half it has not seen, which is the same
   * assumption ADR-010 forbids a client to make about an unread deployment.
   * `refreshHello()` is how the answer reaches the server once it exists.
   */
  function applyCapabilityDeclaration(declaration: CapabilityDeclaration | undefined): void {
    deploymentDeclaration = declaration;
    const taskContext = setHelloCapability(HOST_MCP_TASK_CONTEXT_CAPABILITY, taskContextCapabilityAvailable());
    // #654 E2d-e5, E5b-2: only a verified member on a Host with the E2EE member routes and their KEM epoch rules.
    const member = deviceMember?.session !== undefined && declaration !== undefined && declares(declaration, E2EE_MEMBER_CAPABILITY);
    const kemEpoch = member && declares(declaration!, E2EE_MEMBER_KEM_EPOCH_CAPABILITY);
    if (member && !kemEpoch) logMember(`the Host does not declare ${E2EE_MEMBER_KEM_EPOCH_CAPABILITY}; E2EE stays off until the Host is upgraded`);
    const sealedPayload = setHelloCapability(SEALED_PAYLOAD_CAPABILITY, kemEpoch);
    if (taskContext || sealedPayload) connection?.refreshHello();
    if (kemEpoch) deviceMember!.checkKemRotation();
  }

  /** Whether the advertisement changed. */
  function setHelloCapability(flag: CapabilityFlag, wanted: boolean): boolean {
    const index = helloCapabilities.indexOf(flag);
    if (wanted === (index !== -1)) return false;
    if (wanted) helloCapabilities.push(flag);
    else helloCapabilities.splice(index, 1);
    return true;
  }

  /** Arm before connection.start(); its first open callback starts the read. */
  function startPresenceProducer(): void {
    presenceDiscovery = new AbortController();
  }

  async function waitForHostTaskContext(taskId: string, signal: AbortSignal): Promise<void> {
    if (deviceAssertionAudiences === undefined || signal.aborted) return;
    let timedOut = false;
    let interrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => { interrupt = resolve; });
    const timer = setTimeout(() => { timedOut = true; interrupt(); }, capabilityDiscoveryTimeoutMs);
    signal.addEventListener('abort', interrupt, { once: true });
    try {
      // A reconnect replaces the pass. Re-read that identity after each await,
      // under this ONE offer deadline, rather than admitting on an old answer.
      while (!signal.aborted && !timedOut && presenceDiscoveryPass?.outcome === 'pending') {
        await Promise.race([presenceDiscoveryPass.completion, interrupted]);
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', interrupt);
    }
    if (signal.aborted || shuttingDown) return;
    if (!taskContextCapabilityAvailable()) {
      const outcome = timedOut ? 'timeout' : presenceDiscoveryPass?.outcome;
      const reason = outcome === 'read' ? 'capability_undeclared'
        : outcome === 'timeout' ? 'capability_discovery_timeout'
        : outcome === 'failed' ? 'capability_discovery_failed'
        : 'capability_discovery_unavailable';
      observer.noteDeviceAssertion({ result: 'denied', lane: 'task', taskId, reason });
    }
  }

  /** Each connection open starts a fresh, bounded declaration read. */
  function runPresenceDiscovery(): void {
    const lifecycle = presenceDiscovery;
    if (!lifecycle || lifecycle.signal.aborted) return;
    presenceDiscoveryPass?.controller.abort();
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    lifecycle.signal.addEventListener('abort', abort, { once: true });
    const pass = {
      controller,
      completion: Promise.resolve(),
      outcome: 'pending' as 'pending' | 'read' | 'failed' | 'timeout' | 'aborted',
    };
    presenceDiscoveryPass = pass;
    // A previous connection's declaration cannot authorize a new offer while
    // this deployment is still unknown. Existing nonces are never re-minted.
    applyCapabilityDeclaration(undefined);
    presencePublisher?.stop();
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error('capability discovery aborted'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const timer = setTimeout(() => {
      pass.outcome = 'timeout';
      controller.abort();
    }, capabilityDiscoveryTimeoutMs);
    pass.completion = (async () => {
      try {
        const declaration = await Promise.race([
          fetchCapabilityDeclaration(config.serverUrl, { signal: controller.signal }), aborted,
        ]);
        if (controller.signal.aborted || presenceDiscoveryPass !== pass) return;
        applyCapabilityDeclaration(declaration);
        pass.outcome = 'read';
        if (declares(declaration, PRESENCE_HINTS_CAPABILITY)) {
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
        }
      } catch (err) {
        if (presenceDiscoveryPass !== pass || lifecycle.signal.aborted) {
          pass.outcome = 'aborted';
          return;
        }
        if (pass.outcome !== 'timeout') pass.outcome = 'failed';
        applyCapabilityDeclaration(undefined);
        console.warn(
          `[byok/client] capability discovery ${pass.outcome}; presence publishing and the task assertion lane stay off until the next reconnect: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', rejectAbort);
        lifecycle.signal.removeEventListener('abort', abort);
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
  /** Resume this enrollment's member off the start path; shutdown and re-pair abort it. */
  function startDeviceMember(record: DeviceRecord): void {
    // Points pass to the immediately next run only, even when its resume finds no member.
    const carried = carriedFreshness;
    carriedFreshness = undefined;
    if (memberRecords === undefined) return;
    const abort = new AbortController();
    const options = {
      records: memberRecords, client: memberClient(record, abort.signal), tenantId: record.tenantId, deviceId: record.deviceId, log: logMember,
      signal: abort.signal,
    };
    memberAbort = abort;
    memberResuming = true;
    memberResume = resumeDeviceMember(options).then((session) => {
      if (abort.signal.aborted) return;
      memberResuming = false;
      if (session === undefined) return;
      const member = new DeviceMemberKeyring(session, {
        ...options,
        carried,
        kemRotation: () => deploymentDeclaration !== undefined && declares(deploymentDeclaration, E2EE_MEMBER_KEM_EPOCH_CAPABILITY),
        onLost: () => {
          if (deviceMember === member) applyCapabilityDeclaration(deploymentDeclaration);
        },
      });
      deviceMember = member;
      activateSealedTasks?.(member);
      applyCapabilityDeclaration(deploymentDeclaration);
      console.info(`[byok/client] E2EE member ${session.member.memberId} verified at chain seq ${session.state.head!.seq}`);
    }, (error: unknown) => {
      if (abort.signal.aborted) return;
      memberResuming = false;
      logMember(`E2EE member resume failed; E2EE stays off: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

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
    // Release status waits before service/connection drain. Their mailbox rows
    // remain unacknowledged for a fresh lifecycle to recover authoritatively.
    inputPreparationStatusAbort?.abort();
    inputPreparationStatusAbort = undefined;
    blobLifecycleAbort?.abort();
    blobLifecycleAbort = undefined;
    // The member resume and a background KEM rotation write custody entries; they end before this run releases ownership.
    const member = deviceMember;
    memberAbort?.abort();
    memberAbort = undefined;
    deviceMember = undefined;
    memberResuming = false;
    activateSealedTasks = undefined;
    await memberResume;
    memberResume = undefined;
    await member?.kemRotationSettled();
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
    // Detached reads cannot publish into a later daemon lifecycle.
    presenceDiscoveryPass = undefined;
    presencePublisher?.stop();
    presencePublisher = undefined;
    // B-P2: abort every counter call this daemon owns. Their outcomes stay
    // observable in the durable record — an aborted call becomes
    // `counter_interrupted`, never a silent cancellation and never an automatic
    // second call on restart (§10.3.5).
    await attempt(() => inputPreparationService?.stop(), false);
    const stoppingOwnedJournal = ownedJournal;
    const maintenanceStopped = retentionSweeper.stop();
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
    // is draining any more. Exactly a no-op before the journal is open.
    // #654: a sealed outbound is handed over before it is sealed. `settled()`
    // resolves once each one reached the outbox or the terminal commit queue
    // (its sender's handler runs first). Wait for it before the drain below
    // decides the connection is idle.
    await attempt(() => sealedOutputSettled?.(), false);
    const journalTailSettled = journal ? await attempt(() => terminalCommits.stop(), true) : true;
    // This run seals nothing after the barrier: no key or chain view of its
    // member outlives it.
    retireSealedMember?.();
    retireSealedMember = undefined;
    sealedUploadAbort?.abort();
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
      }
    } else if (stoppingOwnedJournal) {
      mutationBarrierComplete = false;
    }
    await attempt(() => auth.stop(), true);
    // A halt or crash stays visible after teardown, until the next start().
    if (lifecycle.phase !== 'halted' && lifecycle.phase !== 'crashed') setLifecycle({ phase: 'stopped' });
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
    detachOwnedProcessGroupLedger?.();
    detachOwnedProcessGroupLedger = undefined;
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
      let current: DeviceRecord | undefined;
      try {
        current = await auth.readCurrent();
      } catch (error) {
        if (!(error instanceof DeviceRecordRePairRequiredError)) throw error;
      }
      // The member entries go first: if their deletion fails, the device
      // stays paired, and the unpair reports the failure.
      carriedFreshness = undefined;
      await memberRecords?.clear();
      try {
        await store.credentials.clear();
      } catch {
        // The OS credential remains the sole secret authority. Leave the
        // metadata and in-memory auth binding observable until its deletion
        // succeeds; never report an unpair that did not clear that authority.
        throw new Error('device credential could not be cleared; enrollment remains paired and fail-closed');
      }
      try {
        await store.remove();
      } catch (error) {
        // Secret clearance won but metadata cleanup lost. Rebuild auth so this
        // process cannot continue with the previous cache; the surviving
        // projection subsequently reads as re-pair-required.
        auth = buildAuthManager();
        throw error;
      }
      if (current) await cursorStore.clear(config.serverUrl, current.deviceId);
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
  // `connection`/`lifecycle`/`auth` fresh at CALL time via normal JS
  // closure semantics, so it stays correct across this daemon's own
  // start()/stop() cycles.
  // -------------------------------------------------------------------------

  function buildStorageStatus(): ControlStorageStatus {
    const snapshot = retentionSweeper.snapshot();
    return { ...snapshot, ...(storageConfig.budget === undefined ? {} : { budget: {
      budgetBytes: storageConfig.budget.maxStoreBytes, pressureState: storagePressure.state,
    } }) };
  }

  function buildControlStatus(): ControlStatusResult {
    const storageStatus = buildStorageStatus();
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
      lifecycle,
      activeTasks,
      environment: { ...resolvedEnvironment },
      ...(environmentResolvedAt === undefined ? {} : { environmentResolvedAt }),
      runtimes: runtimeObservations.map(observation => ({ ...observation })),
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
      storage: storageStatus,
      operationalHealth: operationalHealth.snapshot(),
      outbound: outboundStatus(),
      toolsets: toolsetRegistry.status(),
      // WP0: same counts `Daemon.status()` reports, from the same reader.
      agentHomeExecution: agentHomeExecutionStatus(),
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
      'enrollment.pair': async (params) => {
        if (config.serviceEnrollment?.enabled !== true) {
          throw new ControlError('enrollment_disabled', 'service enrollment is not enabled for this daemon');
        }
        const parsed = parseEnrollmentPairParams(params);
        if (!parsed) {
          throw new ControlError(
            'bad_request',
            `enrollment.pair requires {pairingCode} with 1-${ENROLLMENT_PAIRING_CODE_MAX_BYTES} UTF-8 bytes, and an optional verificationSecret`,
          );
        }
        let verificationSecret: string | undefined;
        try {
          verificationSecret = parsed.verificationSecret === undefined ? undefined : checkVerificationSecret(parsed.verificationSecret);
        } catch {
          throw new ControlError('bad_request', 'enrollment.pair verificationSecret is not a pairing verification secret');
        }
        if (verificationSecret !== undefined && memberRecords === undefined) {
          throw new ControlError('bad_request', 'an E2EE pairing needs the OS credential custody; this daemon uses an injected credential backend');
        }
        if (!serviceEnrollmentWaiting || daemonStarted) {
          throw new ControlError('already_paired', 'this service daemon is not waiting for initial enrollment');
        }
        if (serviceEnrollmentTransitioning) {
          throw new ControlError('pairing_in_progress', 'service enrollment is already in progress');
        }
        serviceEnrollmentTransitioning = true;
        // `control-server.ts` writes this handler's result in the current
        // microtask. Starting on the next macrotask lets that persisted-id
        // receipt leave before normal startup replaces the enrollment-only
        // listener. A crash in this narrow window is safe: WinSW restarts,
        // loadExisting() sees the already-persisted credential, and takes the
        // same normal startup path.
        const startAfterEnrollment = (): void => {
          setImmediate(() => {
            void runLifecycleMutation(startUnderLease).catch(() => {
              // Do not project provider/server exception text into service logs;
              // the stopped/non-ready daemon is the fail-closed observable fact.
              console.error('[byok/client] service enrollment persisted but normal daemon startup failed');
            });
          });
        };
        let record: DeviceRecord;
        try {
          record = await runLifecycleMutation(() => pairUnderLease(parsed.pairingCode, verificationSecret));
        } catch (err) {
          // The pairing is saved, so the service starts as a device without E2EE.
          if (err instanceof PairedWithoutMemberError) startAfterEnrollment();
          else serviceEnrollmentTransitioning = false;
          throw err;
        }
        startAfterEnrollment();
        return { deviceId: record.deviceId };
      },
      /**
       * B-P2 local primitive (§10.3.1). Task-free: no task, claim, Execution,
       * nonce or tool grant is created by any of the three methods below, and
       * the service they call holds no reference to `TaskRunner`.
       *
       * The HMAC handshake has already completed by the time dispatch reaches
       * here — that proves a local device operator, and nothing more. Every
       * claimed device / Agent / profile value in the params is re-validated
       * against the configured authority inside the service, on EVERY call
       * including `lookup` and `cancel`, which is what stops one local scope
       * from reading or cancelling another's preparation.
       */
      [INPUT_PREPARATION_PREPARE_METHOD]: (params) =>
        runInputPreparation((service) => {
          const parsed = parseInputPreparationRequestParams(params);
          if (!parsed.ok) {
            // Two distinct codes, forwarded as the parser classified them: a
            // caller sending a RETIRED key hears `unsupported_input` and which
            // key, rather than adjusting field types against a generic shape
            // error forever.
            throw new ControlError(
              parsed.code,
              `${INPUT_PREPARATION_PREPARE_METHOD}: ${parsed.detail}`,
            );
          }
          return service.prepare(parsed.request);
        }),
      [INPUT_PREPARATION_LOOKUP_METHOD]: (params) =>
        runInputPreparation((service) => {
          const parsed = parseInputPreparationLookupParams(params);
          if (!parsed) throw new ControlError('bad_request', `${INPUT_PREPARATION_LOOKUP_METHOD} requires exactly {requestId, scope}`);
          return service.lookup(parsed);
        }),
      [INPUT_PREPARATION_CANCEL_METHOD]: (params) =>
        runInputPreparation((service) => {
          const parsed = parseInputPreparationCancelParams(params);
          if (!parsed) throw new ControlError('bad_request', `${INPUT_PREPARATION_CANCEL_METHOD} requires exactly {requestId, scope}`);
          return service.cancel(parsed);
        }),
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
      // Shared out-of-process approval control, retained for adapters beyond Claude.
      // The TaskRunner deadline bounds the wait; callers choose a longer control timeout.
      'approvals.request': (params) => {
        const parsed = parseApprovalsRequestParams(params);
        if (!parsed) throw new ControlError('bad_request', 'approvals.request requires {taskId, summary}');
        if (!runner) throw new ControlError('not_found', 'daemon is not started');
        return runner.requestApproval(parsed.taskId, parsed.summary);
      },
      'team_workspaces.create': async (params) => {
        const parsed = parseTeamWorkspaceCreateParams(params);
        if (!parsed) throw new ControlError('bad_request', 'team_workspaces.create requires exactly {workspaceId,members,limits}');
        return teamWorkspaces.createWorkspace(parsed);
      },
      'team_workspaces.list': () => teamWorkspaces.listWorkspaces(),
      'team_workspaces.join': async (params) => {
        const parsed = parseTeamWorkspaceJoinParams(params);
        if (!parsed) throw new ControlError('bad_request', 'team_workspaces.join requires exactly {workspaceId,memberId,ttlMs?}');
        const lease = await teamWorkspaces.createMemberLease(parsed);
        return { workspaceId: lease.workspaceId, memberId: lease.memberId, expiresAt: lease.expiresAt, context: encodeTeamMemberContext(lease) };
      },
      'team_workspaces.revoke': async (params) => {
        const parsed = parseTeamContextParams(params);
        if (!parsed) throw new ControlError('bad_request', 'team_workspaces.revoke requires exactly {context}');
        await teamWorkspaces.revokeMemberLease({ lease: decodeTeamMemberContext(parsed.context) });
        return { revoked: true };
      },
      'team_messages.post': (params) => {
        const parsed = parseTeamMessagePostParams(params);
        if (!parsed) throw new ControlError('bad_request', 'team_messages.post requires exactly {context,body,contentType?}');
        return teamWorkspaces.postMessage({ lease: decodeTeamMemberContext(parsed.context), body: parsed.body, ...(parsed.contentType === undefined ? {} : { contentType: parsed.contentType }) });
      },
      'team_messages.read': (params) => {
        const parsed = parseTeamMessageReadParams(params);
        if (!parsed) throw new ControlError('bad_request', 'team_messages.read requires exactly {context,afterSeq?}');
        return teamWorkspaces.readMessages({ lease: decodeTeamMemberContext(parsed.context), ...(parsed.afterSeq === undefined ? {} : { afterSeq: parsed.afterSeq }) });
      },
      'team_messages.ack': (params) => {
        const parsed = parseTeamMessageAckParams(params);
        if (!parsed) throw new ControlError('bad_request', 'team_messages.ack requires exactly {context,throughSeq}');
        return teamWorkspaces.ackMessages({ lease: decodeTeamMemberContext(parsed.context), throughSeq: parsed.throughSeq });
      },
      'team_notifications.snapshot': (params) => {
        const parsed = parseTeamNotificationSnapshotParams(params);
        if (!parsed) throw new ControlError('bad_request', 'team_notifications.snapshot requires exactly {context,afterSeq?}');
        return teamWorkspaces.notificationSnapshot({ lease: decodeTeamMemberContext(parsed.context), ...(parsed.afterSeq === undefined ? {} : { afterSeq: parsed.afterSeq }) });
      },
      'team_messages.inspect': (params) => {
        const parsed = parseTeamMessageInspectParams(params);
        if (!parsed) throw new ControlError('bad_request', 'team_messages.inspect requires exactly {workspaceId,afterSeq?}');
        return teamWorkspaces.inspectMessages(parsed.workspaceId, parsed.afterSeq);
      },
      'agent_messages.publish': (params) => {
        const parsed = parseAgentMessagePublishParams(params);
        if (!parsed) throw new ControlError('bad_request', 'agent_messages.publish requires exactly {contextToken,contentType,body}');
        if (!runner) throw new ControlError('not_found', 'daemon is not started');
        return runner.publishAgentMessage(parsed);
      },
      'agent_results.describe': (params) => {
        const parsed = parseAgentResultDescribeParams(params);
        if (!parsed) throw new ControlError('bad_request', 'agent_results.describe requires exactly {contextToken}');
        if (!runner) throw new ControlError('not_found', 'daemon is not started');
        return runner.describeAgentResult(parsed);
      },
      'agent_results.submit': (params) => {
        const parsed = parseAgentResultSubmitParams(params);
        if (!parsed) throw new ControlError('bad_request', 'agent_results.submit requires exactly {contextToken,outcome}');
        if (!runner) throw new ControlError('not_found', 'daemon is not started');
        return runner.submitAgentResult(parsed);
      },
      'agent_memory.recall': (params) => {
        const parsed = parseAgentMemoryRecallParams(params);
        if (!parsed) throw new ControlError('bad_request', 'agent_memory.recall requires exactly {contextToken,path,ifRevision?}');
        if (!runner) throw new ControlError('not_found', 'daemon is not started');
        return runner.recallAgentMemory(parsed);
      },
      'agent_memory.save': (params) => {
        const parsed = parseAgentMemorySaveParams(params);
        if (!parsed) throw new ControlError('bad_request', 'agent_memory.save requires exactly {contextToken,op,path,expectedRevision,content?}');
        if (!runner) throw new ControlError('not_found', 'daemon is not started');
        return runner.saveAgentMemory(parsed);
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
          // even then the event carries just its byte size, since on
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
        let record: DeviceRecord | undefined;
        try {
          record = await auth.readCurrent();
        } catch (error) {
          if (!(error instanceof DeviceRecordRePairRequiredError)) throw error;
        }
        if (record === undefined) {
          observer.noteDeviceAssertion({ result: 'denied', reason: 'not_paired', audience: parsed.audience });
          throw new ControlError('not_paired', 'this device is not paired; nothing can be asserted about it');
        }

        // Plan `device-assertion-broker` (codex F2): re-check the mutable
        // conditions IMMEDIATELY before signing, at the signing point itself.
        // `auth.readCurrent()` above is async, and a shutdown request or a
        // revocation can land during that `await` — after gates 4/5 already
        // passed but before the key is ever touched. The same
        // check-then-await-then-sign shape that made the result-document
        // capability re-check necessary applies here: the only checks that
        // count are the ones that still hold at the moment of signing.
        //
        // `auth.readCurrent()` returning a record is itself the fresh
        // not-paired re-check: it composes current metadata with the sole OS
        // credential authority, so unpair cannot leave a stale signer cache.
        // Shutdown and revocation are in-memory flags, so they are re-read
        // here explicitly.
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
          // (path stripped), so the issuer ignores an operator-provided path
          // or query.
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
      /**
       * Contract §8.1 / §8.2(1): mint one task-scoped assertion for ONE
       * upcoming tool invocation by the MCP child of an admitted host toolset
       * server.
       *
       * A separate method from `assertion.issue`, never a mode of it (§8.1:
       * the two lanes have zero interchange). NINE fail-closed gates, in this
       * exact order — one this lane alone has, then the device lane's six
       * unchanged, then the two that make this lane task-scoped:
       *
       * 2. `capability_undeclared` — §8.1's capability gate is not in place:
       *    this daemon has read no deployment declaration naming
       *    `host-mcp-task-context` (or read one that withdrew it). Checked
       *    before the params are parsed, because a daemon that cannot serve
       *    this lane has nothing to say about the shape of a request for it.
       *    §8.3 makes this a refusal and not a degradation: an undeclared lane
       *    is `unavailable`, never a reason to hand back a device assertion.
       *
       * 8. `context_token_invalid` — no registry entry for this nonce. The
       *    same answer for "never existed" and "its task has been cleaned up",
       *    so a refusal is not a probe for what this device has run.
       * 9. `context_revoked` — the entry exists and its task's local authority
       *    has been withdrawn (cancel accepted, terminal reached, shutdown).
       *
       * The gates are ordered so a refusal never leaks more than the caller
       * already knew: the audience allowlist is checked BEFORE the registry, so
       * a caller holding no nonce cannot use a denied audience to learn whether
       * some guessed token exists.
       *
       * `taskId`, `agentRef` and `toolsetId` come from the registry entry and
       * from nowhere else. `parseTaskAssertionIssueParams` rejects params that
       * even mention them, so there is no "requested" value for this handler to
       * prefer, reconcile, or accidentally trust.
       *
       * The honest limit, same as the device lane's: this is the SECOND
       * fail-closed layer (I12). The authoritative revocation point is the
       * host's own cancel/End commit; refusing here does not recall an
       * assertion already issued, and nothing about this handler entitles
       * anyone to claim the daemon delivers synchronous invalidation.
       */
      'task_assertion.issue': async (params): Promise<TaskAssertionIssueResult> => {
        // Gate 1.
        if (deviceAssertionAudiences === undefined) {
          observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'assertion_disabled' });
          throw new ControlError(
            'assertion_disabled',
            'this daemon is not configured to issue assertions (DaemonConfig.deviceAssertion.audiences is absent or empty)',
          );
        }
        // Gate 2.
        if (!taskContextCapabilityAvailable()) {
          observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'capability_undeclared' });
          throw new ControlError(
            'capability_undeclared',
            `this deployment does not declare ${HOST_MCP_TASK_CONTEXT_CAPABILITY}, so no task-scoped assertion can be issued`,
          );
        }
        // Gate 3.
        const parsed = parseTaskAssertionIssueParams(params);
        if (!parsed) {
          const rawAudience =
            typeof params === 'object' && params !== null && typeof (params as { audience?: unknown }).audience === 'string'
              ? (params as { audience: string }).audience
              : undefined;
          observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'bad_request', audience: rawAudience });
          throw new ControlError(
            'bad_request',
            `task_assertion.issue requires exactly {contextToken,audience}, both non-empty strings, with contextToken at most ${TASK_ASSERTION_CONTEXT_TOKEN_MAX_BYTES} and audience at most ${DEVICE_ASSERTION_AUDIENCE_MAX_BYTES} UTF-8 bytes; taskId, agentRef and toolsetId are resolved by this daemon and may not be sent`,
          );
        }
        // Gate 4. Exact membership only, and BEFORE the registry lookup.
        if (!deviceAssertionAudiences.has(parsed.audience)) {
          observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'audience_denied', audience: parsed.audience });
          throw new ControlError('audience_denied', 'the requested audience is not allowed by this daemon');
        }
        // Gate 5.
        if (shuttingDown) {
          observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'shutting_down', audience: parsed.audience });
          throw new ControlError('shutting_down', 'this daemon is shutting down and will not issue new assertions');
        }
        // Gate 6.
        if (auth.isRevoked()) {
          observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'revoked', audience: parsed.audience });
          throw new ControlError('revoked', 'this device has been revoked by the server; re-pair required');
        }
        // Gate 7. Read from disk every time — never a cached record.
        let record: DeviceRecord | undefined;
        try {
          record = await auth.readCurrent();
        } catch (error) {
          if (!(error instanceof DeviceRecordRePairRequiredError)) throw error;
        }
        if (record === undefined) {
          observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'not_paired', audience: parsed.audience });
          throw new ControlError('not_paired', 'this device is not paired; nothing can be asserted about it');
        }

        // Gates 8/9, read AFTER the `await` above: a cancel can land during
        // that disk read, and the only registry state that counts is the one
        // that still holds on this side of it. A daemon with no runner has no
        // registry at all, which is indistinguishable from an unknown token —
        // deliberately, so "is this daemon started" is not answerable here
        // either.
        const context = runner?.hostToolsetContext(parsed.contextToken) ?? { status: 'unknown' as const };
        if (context.status === 'unknown') {
          observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'context_token_invalid', audience: parsed.audience });
          throw new ControlError('context_token_invalid', 'no live host toolset context matches this token');
        }
        if (context.status === 'revoked') {
          observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'context_revoked', audience: parsed.audience });
          throw new ControlError('context_revoked', 'this task context has been revoked; no further assertions will be issued for it');
        }

        // Same check-then-await-then-sign discipline as the device lane above:
        // shutdown and revocation are in-memory flags re-read at the signing
        // point itself, and `auth.readCurrent()` returning a record is itself
        // the fresh not-paired re-check.
        if (shuttingDown) {
          observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'shutting_down', audience: parsed.audience, taskId: context.taskId });
          throw new ControlError('shutting_down', 'this daemon is shutting down and will not issue new assertions');
        }
        if (auth.isRevoked()) {
          observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason: 'revoked', audience: parsed.audience, taskId: context.taskId });
          throw new ControlError('revoked', 'this device has been revoked by the server; re-pair required');
        }

        const minted = mintTaskAssertion({
          record,
          issuer: new URL(toHttpBase(config.serverUrl)).origin,
          productId: config.productId,
          audience: parsed.audience,
          // §8.1: the task lane inherits the device lane's TTL ceiling rather
          // than deriving a second lifetime from the task's own, unpredictable
          // duration.
          ttlMs: deviceAssertionTtlMs,
          now: new Date(),
          taskId: context.taskId,
          agentRef: context.agentRef,
          toolsetId: context.toolsetId,
        });

        // Second registry read, after signing: the envelope is discarded, not
        // returned, if the task's authority ended while it was being produced.
        // Signing is synchronous today, so this cannot currently observe a
        // change — it is the gate that keeps that true, because a signed
        // envelope leaving this handler after a cancel would be exactly the
        // failure AC11 names, and the cost of proving it cannot happen is one
        // map lookup.
        //
        // Read through the SAME `?? {status:'unknown'}` shape gate 8 uses. A
        // missing runner is an unknown token, not a revoked context: the two
        // refusals mean different things to a caller (`context_revoked` says a
        // registry entry existed and its task's authority ended), and answering
        // the wrong one from a defensive `?.` would teach a caller that its
        // still-valid nonce had been withdrawn.
        const stillActive = runner?.hostToolsetContext(parsed.contextToken) ?? { status: 'unknown' as const };
        if (stillActive.status !== 'active') {
          const reason = stillActive.status === 'unknown' ? 'context_token_invalid' : 'context_revoked';
          observer.noteDeviceAssertion({ result: 'denied', lane: 'task', reason, audience: parsed.audience, taskId: context.taskId });
          throw new ControlError(
            reason,
            reason === 'context_token_invalid'
              ? 'no live host toolset context matches this token'
              : 'this task context was revoked while the assertion was being issued',
          );
        }

        observer.noteDeviceAssertion({
          result: 'issued',
          lane: 'task',
          taskId: context.taskId,
          audience: minted.claims.audience,
          jti: minted.claims.jti,
          expiresAt: minted.expiresAt,
        });
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

  /** Each retry of a held record resends one envelope id (#698); a restart builds a new one. */
  const reliableEnvelopes = new WeakMap<AgentReliableEgressRecord, Envelope>();

  function dispatchReliableRecord(record: AgentReliableEgressRecord): void {
    if (record.sessionRef === undefined) {
      agentEgress.noteTransportDrop('invalid_envelope', record.agentRef);
      return;
    }
    if (!connection?.getServerCapabilities().includes(AGENT_EGRESS_RELIABLE_ACK_CAPABILITY)) {
      // The append stays durable and is retried when an advertisement next
      // carries the ack capability (`onCapabilitiesAdvertised`). It is never
      // republished through latest-value activity.
      agentEgress.noteTransportDrop('capability_missing', record.agentRef);
      return;
    }
    const envelope = reliableEnvelopes.get(record) ?? (record.wireType === 'agent.egress.reliable'
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
        ));
    reliableEnvelopes.set(record, envelope);
    connection.send(envelope);
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
      if (handoff.taskId !== input.taskId) {
        throw new Error('Agent reliable egress taskId does not match the durable session handoff');
      }
      const appended = await agentEgress.appendReliable({
        homeDir: binding.resolution.canonicalHome,
        agentRef: binding.resolution.agentRef,
        sessionRef: input.sessionRef,
        payload: input.payload,
        taskId: input.taskId,
        ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      });
      if (appended.ok) dispatchReliableRecord(appended.record);
      return appended;
    } finally {
      await binding.lease.release();
    }
  }

  /**
   * The one memory backend Host-approved Agent memory intents may use, or
   * `undefined` (the capability stays unadvertised and every notice fails
   * closed). All of: a Host transport, an Agent home, the secure memory
   * filesystem on this platform, a backend whose ledger write is a proven
   * durable barrier, and — for the native backend — runtime evidence that the
   * Agent-home filesystem honors directory fsync (the strict barrier would
   * otherwise fail every write).
   */
  async function provenAgentMemoryIntentBackend(): Promise<AgentMemoryIntentBackend | undefined> {
    if (config.agentMemoryIntents === undefined || config.agentHome === undefined || agentHomeManager === undefined) return undefined;
    const helperBin = resolveAgentMemoryFilesystemHelperBin?.();
    if (!isAgentMemorySecureFilesystemAvailable(helperBin !== undefined)) return undefined;
    const backend = helperBin === undefined
      ? NATIVE_AGENT_MEMORY_INTENT_BACKEND
      : helperAgentMemoryIntentBackend(helperBin, config.agentMemoryHelperAssetRoot);
    if (!backend.strictLedgerBarrier) return undefined;
    if (helperBin !== undefined) {
      // Probe the actual branded volume before advertising. The helper open
      // validates the identity and strictly flushes the complete directory chain.
      try {
        const canonicalHome = await fs.realpath(config.agentHome.hostStorageRoot);
        const stat = await fs.stat(canonicalHome, { bigint: true });
        const probe = await openAgentMemoryFilesystemHelper({ helperBin, assetRoot: config.agentMemoryHelperAssetRoot, canonicalHome, homeIdentity: { dev: stat.dev, ino: stat.ino } });
        await probe.close();
      } catch {
        return undefined;
      }
    }
    if (backend.openFilesystem === undefined && !(await probeAgentMemoryStrictDirectorySync(config.agentHome.hostStorageRoot))) {
      return undefined;
    }
    return backend;
  }

  /**
   * WP0: the one place both status surfaces read the per-home Attempt counts
   * from, so `Daemon.status()` and the authenticated control status can never
   * disagree. A daemon with no Agent home configured reports the limit and
   * zeroes rather than omitting the section — "capped, nothing active" is a
   * fact worth stating.
   */
  function agentHomeExecutionStatus(): AgentHomeExecutionStatus {
    const summary = agentHomeManager?.executionLeaseManager.activeAttemptSummary();
    return {
      maxConcurrentReaderAttemptsPerAgentHome: agentHomeReaderLimit,
      activeHomes: summary?.homes ?? 0,
      activeAttempts: summary?.attempts ?? 0,
      activeReaderAttempts: summary?.readerAttempts ?? 0,
    };
  }

  function outboundStatus(): OutboundStatus {
    return { ...outbound, rejectedByReason: { ...outbound.rejectedByReason }, ...(outbound.lastRejection === undefined ? {} : { lastRejection: { ...outbound.lastRejection } }) };
  }

  function status(): DaemonStatus {
    return {
      environment: { ...resolvedEnvironment },
      ...(environmentResolvedAt === undefined ? {} : { environmentResolvedAt }),
      runtimes: runtimeObservations.map(observation => ({ ...observation })),
      storage: buildStorageStatus(),
      localAgentRelease,
      paired: auth.deviceId !== undefined,
      lifecycle,
      deviceId: auth.deviceId,
      activeTaskCount: runner?.activeTaskCount ?? 0,
      pendingTerminalCommits: terminalCommits.pendingCount,
      branding: config.branding,
      operationalHealth: operationalHealth.snapshot(),
      outbound: outboundStatus(),
      toolsets: toolsetRegistry.status(),
      egress: agentEgress.status(),
      agentHomeExecution: agentHomeExecutionStatus(),
      agentMemoryMcp: agentMemoryMcpAdmission,
    };
  }

  function reloadMcpToolsets(
    mcpToolsets: Record<string, McpToolsetConfig> | undefined,
    expectedRevision: string,
  ): McpToolsetReloadReceipt {
    const receipt = toolsetRegistry.reload(mcpToolsets, expectedRevision);
    if (daemonStarted) connection?.refreshHello();
    return receipt;
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
    ...(config.agentMemoryExport !== true ? {} : {
      exportAgentMemory: (agentRef: AgentRef, options?: AgentMemoryExportOptions) => {
        const bin = resolveAgentMemoryFilesystemHelperBin?.();
        return exportAgentMemoryHome(agentHomeManager!, agentRef, options,
          bin === undefined ? undefined : { bin, assetRoot: config.agentMemoryHelperAssetRoot });
      },
    }),
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
export function createDaemon(config: DaemonConfig, overrides: DaemonOverrides = {}): Daemon {
  if (config.codexSandbox !== undefined) assertCodexSandboxSetting(config.codexSandbox, 'DaemonConfig.codexSandbox');
  return buildDaemonWithAdapters(config, buildDefaultAdapters(config), overrides);
}
