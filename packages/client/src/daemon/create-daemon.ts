import type { OutboundStatus } from './outbound-settlement';
import { TerminalCommitQueue } from './terminal-commit-queue';
import { type RuntimeObservation } from '../runtime-detection';
import { serviceEnvironmentStatus, type ServiceEnvironmentStatus } from '../login-shell-environment';
import type {
  AgentEgressPolicy,
  Envelope,
  RuntimeId,
} from '@byok-sdk/protocol';
import type {
  RuntimeAdapter,
  RuntimeVersionPolicy,
  McpStdioServerConfig,
  McpToolsetConfig,
  McpToolsetObservation,
  McpToolsetRegistryStatus,
  McpToolsetReloadReceipt,
} from '../types';
import {
  type AgentHomeExecutionStatus,
  type AgentHomeProjection,
} from '../agent-home';
import type { AgentRef } from '../agent-home';
import {
  type LocalAgentReleaseIdentity,
} from '../release-identity';
import { assertCodexSandboxSetting, type CodexAdapterOptions, type CodexSandboxSetting } from '../adapters/codex/codex-adapter';
import type { ClaudeAdapterOptions } from '../adapters/claude/claude-adapter';
import type { PiAdapterOptions } from '../adapters/pi/pi-adapter';
import { assertRuntimeEnvironmentPolicy, type RuntimeEnvironmentPolicy } from '../runtime/environment';
import { ApprovalRegistry, type LocalToolApprovalPolicy } from './approvals';
import { AuthManager } from './auth-manager';
import { resolveMachineId } from './machine-id';
import { DaemonHaltError, type DaemonLifecycle } from './daemon-lifecycle';
import {
  type ControlStorageStatus,
} from './control-protocol';
import {
  type InputPreparationAuthorityResolver,
  type InputPreparationCounterAdapter,
  type InputPreparationLimitsPolicyV1,
} from '../input-preparation';
import { deterministicJitterMs } from './deterministic-jitter';
import { type OperationalHealthSnapshot } from './operational-health';
import { DaemonObserver, type DaemonEventListener, type DaemonTaskInfo, type Unsubscribe } from './observer';
import { type DeviceEnrollment } from './store';
import { type DeviceMemberStatus } from './e2ee-key-package-notice';
import { type LocalTaskJournal } from './journal/journal';
import type { JournalOpenFaultSeam } from '../util/sqlite-support';
import { promises as fs } from 'node:fs';
import { type StorageConfig } from './retention/config';
import { RetentionSweeper, type RetentionTimers } from './retention/sweeper';
import { createRetentionRegistry } from './retention/producers';

import { DEFAULT_MAX_INLINE_EVENT_BYTES, MIN_MAX_INLINE_EVENT_BYTES } from './event-spill';
import {
  DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MAX_TASK_OUTPUT_BYTES,
} from './task-runner';
import {
  type ProgressBatcherOptions,
} from './progress-batcher';
import { type AgentEgressReliableAppendResult } from './agent-egress-controller';
import { type AgentEgressStatus } from './agent-egress-policy';
import type { AgentReliableEgressRecord } from './agent-egress-spool';
import {
  type ProviderProvisioningHandler,
} from './provider-provisioning';
import { exportAgentMemoryHome, type AgentMemoryExportOptions } from './agent-memory-export';
import { type SdkHelperHostConfig } from '../sdk-reserved-helper-host';
import {
  type AgentMemoryHostedProjection,
} from './agent-memory';
import {
  type AgentContentReadRoot,
} from './agent-content-read';
import type { DaemonState } from './create-daemon/state';
import { buildDefaultAdapters, injectedAdapterConfigConflicts } from './create-daemon/support';
import { resolveDaemonConfig } from './create-daemon/config';
import { composeDaemonStores } from './create-daemon/stores';
import { composeDaemonWorkspaces } from './create-daemon/workspaces';
import type { DaemonScope } from './create-daemon/scope';
import { bindDaemonFunctions } from './create-daemon/functions';
import { createControlMethods } from './create-daemon/control-methods';
import type { ToolAuthorizationPolicy } from '../tool-authorization';
import { describeEffectiveDaemonConfig, type DaemonEffectiveConfig } from './config-schema/effective';
import { DaemonConfigInvalidError } from './config-schema/errors';
import { toolAuthorizationIssues } from './config-schema/static-tool-authorization';
import type { AgentMemoryExport, AgentMemoryIntentTransport } from '@byok-sdk/protocol/agent-memory';

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
  /**
   * Per-task tool authorization, decided by this Host for every runtime:
   * `all` (default) never blocks and emits a `tool-reminder` event for each
   * high-risk call; `auto` asks the user through the task's approval path
   * before a high-risk call runs and is declined before claim on a runtime
   * without `toolAuthorizationAuto`. `byRuntime` overrides the mode for one
   * runtime id. `rules` move single calls across the ask boundary and apply
   * to every runtime. A config file and an embedded Host supply the same
   * object; it is validated, copied and frozen before claim, once per offer
   * (including resume). Invalid policies decline the offer. Rules never
   * change the wire or native launch.
   *
   * The optional `fileScope` (#1061) is an explicit file boundary for the
   * SDK-owned file tools: absent means inherit (unchanged behavior);
   * `home` authorizes read+write of the canonical Agent home; `workspaces`
   * adds explicit read/write roots. It applies only to `auto` tasks, requires
   * `agentHome`, and is never selected by the wire or the model. v1 admits it
   * only on the ordinary Pi RPC lane on darwin/linux; other adapters, the
   * prepared/durable lanes, memory-reader offers and Windows decline before
   * claim with `file_scope_unsupported`. This is not an OS sandbox: shell,
   * MCP servers and extensions remain outside it.
   */
  toolAuthorization?: ToolAuthorizationPolicy;
  /**
   * Who may approve a `tool-authorization` approval (an `auto` high-risk tool
   * call). Absent (default): only the Host — a wire `task.approve` or an
   * in-process {@link Daemon.approve}. The control socket's
   * `approvals.resolve` (`byok-agent approve`) can only reject it, and an
   * approve fails with the control error code `approval_requires_host`
   * ({@link APPROVAL_REQUIRES_HOST}). `'allow'` lets the control socket
   * approve it too. Any same-user process that can read `control.token`,
   * including the agent whose tool call waits, can then approve it, and the
   * server records it as a local approval. `task-terminal` approvals are not
   * affected. See `docs/security.md`.
   */
  localToolApproval?: LocalToolApprovalPolicy;
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
   * How many tasks this daemon runs at once, across every Agent home, lane and
   * runtime. Default {@link DEFAULT_MAX_CONCURRENT_TASKS} (8).
   *
   * Active tasks and offers already admitted but still starting both count.
   * An offer over the cap is declined retryably (`task.decline` with
   * `retryable: true` and no code) before adapter preparation, the claim, or
   * any process side effect, so the Host can offer it again later or to
   * another device.
   *
   * Validated up front: a positive safe integer. There is no "uncapped"
   * value; `0`, a negative number, `NaN` and a non-integer are construction
   * errors.
   */
  maxConcurrentTasks?: number;
  /**
   * Wall-clock limit, in milliseconds, for a task whose offer carries no
   * `limits.maxDurationMs`. An offer's own limit always wins. Enforced the
   * same way: the task fails with `resource limit exceeded: maxDurationMs`.
   * Omitted, a task without an offer limit runs until it ends or is
   * cancelled. Validated up front: a positive safe integer.
   */
  defaultMaxDurationMs?: number;
  /**
   * Explicit Agent-local/cloud egress selection. Omission still enforces the
   * SDK metadata/status projection, but does not advertise or admit the new
   * policy/reliable protocol surface.
   */
  agentEgress?: AgentEgressConfig;
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
   * Isolation options of the runtime adapters `createDaemon` builds (#1094),
   * passed to each adapter's constructor; an unset option keeps the
   * adapter's default, under which a runtime keeps the user's own context,
   * sessions and MCP servers. Which runtimes are built stays
   * `runtimeAllowlist`, and the Codex sandbox stays `codexSandbox`.
   * `createDaemonWithAdapters` rejects this key, even when undefined:
   * configure each injected adapter directly.
   */
  runtimes?: {
    pi?: {
      /** `PiAdapterOptions.agentUserContext`: `excluded` keeps user Pi resources and settings out of an Agent task (model and auth stores stay). Default `inherit`. */
      agentUserContext?: PiAdapterOptions['agentUserContext'];
      /** A complete version policy that replaces the adapter default wholesale; `block` is allowed here because it is Host configuration (#1103). */
      versionPolicy?: RuntimeVersionPolicy;
    };
    claude?: {
      /** `ClaudeAdapterOptions.agentUserContext`: `excluded` keeps user MCP servers, `CLAUDE.md` files, rules and auto memory out of an Agent task. Default `inherit`. */
      agentUserContext?: ClaudeAdapterOptions['agentUserContext'];
      /** `ClaudeAdapterOptions.agentSessionPersistence`: `disabled` does not save an Agent task's session transcript, so it cannot be resumed. Default `enabled`. */
      agentSessionPersistence?: ClaudeAdapterOptions['agentSessionPersistence'];
      /** A complete version policy that replaces the adapter default wholesale; `block` is allowed here because it is Host configuration (#1103). */
      versionPolicy?: RuntimeVersionPolicy;
    };
    codex?: {
      /** `CodexAdapterOptions.agentUserMcpServers`: `excluded` disables the user's MCP servers and plugins for an Agent task. Default `inherit`. */
      agentUserMcpServers?: CodexAdapterOptions['agentUserMcpServers'];
      /** A complete version policy that replaces the adapter default wholesale; `block` is allowed here because it is Host configuration (#1103). */
      versionPolicy?: RuntimeVersionPolicy;
    };
  };
  /**
   * The environment every runtime `createDaemon` builds gives its children
   * (#1095): by default the user's login-shell snapshot, so a variable the
   * Host sets in `process.env` reaches a runtime only when `pass` names it.
   * `createDaemonWithAdapters` refuses this field: each injected adapter
   * takes its own `runtimeEnvironment` option.
   */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
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
   * `MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX`, `task-runner/state.ts`) — see
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
  /**
   * Exact policy the daemon is willing to consume from an Agent offer.
   * Absent: the client default policy, as a config file's `"agentEgress": {}`.
   */
  policy?: AgentEgressPolicy;
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
  /**
   * Effective values of this daemon's configuration (#1094): resolved
   * directories (store, Agent homes, execution scratch root and its socket
   * budget), the MCP servers tasks may get, the memory helper resolution,
   * each runtime's isolation options and the tool-authorization mode, plus
   * unknown-field warnings. Resolved once at construction; the same report
   * `byok-agent config check` prints.
   */
  config: DaemonEffectiveConfig;
}

export interface Daemon {
  /** Present only with agentMemoryExport: true. Holds the home writer lease; AgentHomeBusyError is retryable. Raw contents remain Host-owned. */
  exportAgentMemory?(agentRef: AgentRef, options?: AgentMemoryExportOptions): Promise<AgentMemoryExport>;
  /**
   * Pairing result is intentionally credential-blind. With
   * `verificationSecret`, the base32 secret the web client shows after the
   * pairing code (#654 §7.2), the device also enrolls as an E2EE member; the
   * secret never reaches the Host. Without it the device pairs without E2EE.
   *
   * Pairing refuses with `DeviceStoreBindingMismatchError`
   * (`device_store_not_bound`) while the OS credential entry of this
   * productId holds an enrollment this storeDir did not pair.
   * `replaceOtherStore: true` is the operator's explicit intent to replace
   * that enrollment; the other store then reads as not bound.
   */
  pair(pairingCode: string, options?: { readonly verificationSecret?: string; readonly replaceOtherStore?: boolean }): Promise<DeviceEnrollment>;
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
   * Approve, from the Host process that embeds this daemon, the pending
   * approval `approvalId` of a task — the same resolution a server-sent
   * `task.approve` makes (`TaskRunner.handleApprove`), reported to the server
   * as `task.approval_resolved`. Unlike the control socket's
   * `approvals.resolve`, it also approves a `tool-authorization` approval
   * whatever {@link DaemonConfig.localToolApproval} says. The session that
   * requested it through its `approvalChannel` (or a control-socket
   * `approvals.request`) receives `{ approved: true }`. A no-op (resolves
   * immediately) for a `taskId` this daemon doesn't currently have active;
   * a different `approvalId` is a stale decision and changes nothing.
   */
  approve(taskId: string, opts: { approvalId: string }): Promise<void>;
  /** M3-2a: same as {@link approve} but rejects — see that method's doc comment. */
  reject(taskId: string, opts: { approvalId: string; reason?: string }): Promise<void>;
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

export function createDaemonWithAdapters(
  config: DaemonConfig,
  adapters: RuntimeAdapter[],
  overrides: DaemonOverrides = {},
): Daemon {
  const [conflict] = injectedAdapterConfigConflicts(config);
  if (conflict !== undefined) throw new TypeError(conflict.message);
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
  return buildDaemon(config, () => adapters, 'injected', overrides, assertionProbe);
}

/** `buildAdapters` receives the resolved Pi launcher, so default adapters and retention share one sessionDir. */
function buildDaemon(
  config: DaemonConfig,
  buildAdapters: (piByokLauncher: DaemonConfig['piByokLauncher']) => RuntimeAdapter[],
  runtimeSource: DaemonEffectiveConfig['runtimes'][number]['source'],
  overrides: DaemonOverrides,
  assertionProbe: AssertionIssueProbe | undefined,
): Daemon {
  const {
    agentMemoryMcpEnabled, resolveAgentMemoryFilesystemHelperBin, agentMemoryMcpBin,
    agentMemoryDescribeBin, agentMemoryMcpAdmission, localAgentRelease, toolsetRegistry, piByokLauncher,
    memoryHelper, configWarnings, toolAuthorizationResolver,
  } = resolveDaemonConfig({ overrides, config });
  // Q4': an unknown field never stops the daemon; it is logged once and reported in status().config.
  for (const warning of configWarnings) console.warn(`[byok/client] ${warning.message}`);
  const adapters = buildAdapters(piByokLauncher);
  const authorizationIssues = toolAuthorizationIssues(config, adapters, runtimeSource);
  if (authorizationIssues.length > 0) throw new DaemonConfigInvalidError(authorizationIssues);
  const {
    agentHomeReaderLimit, egressPolicy, egressBatcherOptions, presenceCadence, deviceAssertionAudiences,
    deviceAssertionTtlMs, storeDir, storageConfig, retentionClock, scratchRoot, storagePressure,
    inputPreparationLimits, preparedToolSurface, teamWorkspaces, store, memberRecords, sealIdentityOf,
  } = composeDaemonStores({ config, overrides, agentMemoryMcpEnabled, resolveAgentMemoryFilesystemHelperBin, toolsetRegistry, agentMemoryDescribeBin, adapters });
  // Config-derived, so resolved once; `byok-agent config check` builds the same report.
  const effectiveConfig = describeEffectiveDaemonConfig({
    config, warnings: configWarnings, memoryHelper, agentMemoryMcpAdmission, storeDir,
    scratchRoot: storageConfig.scratchRoot, adapters, runtimeSource,
  });

  const memberStatus = (): DeviceMemberStatus => daemonState.deviceMember ?? (daemonState.memberResuming ? 'resuming' : 'none');
  const {
    logMember, operationalHealth, ownedProcessLedger, cursorStore, agentHomeManager,
    agentSessionHandoffs, agentContentReadPolicies, initialAgentEgress,
  } = composeDaemonWorkspaces({ storeDir, config, egressPolicy });

  const retentionRegistry = createRetentionRegistry({
    storeDir, scratch: scratchRoot, config: storageConfig, clock: retentionClock,
    journal: () => daemonState.journal, identity: () => daemonState.retentionIdentity, preparation: () => daemonState.inputPreparationService,
    ...(agentHomeManager === undefined ? {} : { home: agentHomeManager }),
    ...(agentSessionHandoffs === undefined ? {} : { handoffs: agentSessionHandoffs }),
    ...(piByokLauncher === undefined ? {} : { piSessionDir: piByokLauncher.sessionDir }),
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
    daemonState.connection?.retryTaskReceipts(taskId);
    void daemonState.runner?.retryTerminalFinalization(taskId).catch(error => {
      console.error('[byok/client] terminal finalization still requires recovery', error);
    });
  });
  // M3-2a: local observability — constructed once per daemon instance (not
  // per `start()`) so `subscribe()`/`tasks()` work immediately after
  // `createDaemonWithAdapters()` returns and keep accumulating across an
  // internal stop()/start() cycle within the same instance. See `observer.ts`.
  const outbound: OutboundStatus = { accepted: 0, duplicate: 0, rejected: 0, rejectedByReason: {}, rejectedTerminals: 0, droppedEphemeral: 0 };
  const observer = new DaemonObserver();
  // The one pending-approval registry: `TaskRunner` registers, and wire,
  // in-process and control-socket decisions resolve — see `approvals.ts`.
  const approvalRegistry = new ApprovalRegistry({ localToolApproval: config.localToolApproval });

  // Both network reads and individual offer waits are bounded. Reconnects do
  // not extend an offer's deadline. This is an operational wait, not token TTL.
  const capabilityDiscoveryTimeoutMs = 5_000;
  const pendingLateMutationBarriers = new Set<Promise<void>>();

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
      onRevoked: () => daemonState.connection?.noteDeviceRevoked(),
    });
  }
  const daemonState: DaemonState = {
    shuttingDown: false,
    retentionIdentity: undefined,
    inputPreparationService: undefined,
    inputPreparationInitialization: undefined,
    inputPreparationLaneOff: undefined,
    deviceMember: undefined,
    memberResuming: false,
    activateSealedTasks: undefined,
    carriedFreshness: undefined,
    memberAbort: undefined,
    memberResume: undefined,
    detachOwnedProcessGroupLedger: undefined,
    fleetJitter: undefined,
    agentEgress: initialAgentEgress,
    ownedJournal: undefined,
    journal: overrides.journal,
    hostedStorageInitializationBarrierComplete: true,
    connection: undefined,
    blobLifecycleAbort: undefined,
    sealedUploadAbort: undefined,
    sealedUploads: undefined,
    startInProgress: false,
    pendingAuthOperations: 0,
    authCancellationEpoch: 0,
    latestSealedTasks: undefined,
    latestSealIdentity: undefined,
    retireSealedMember: undefined,
    sealedOutputSettled: undefined,
    inputPreparationStatusAbort: undefined,
    lifecycle: { phase: 'stopped' },
    daemonStarted: false,
    tenantRebinding: false,
    runner: undefined,
    controlServerHandle: undefined,
    serviceEnrollmentEpoch: undefined,
    serviceEnrollmentTransitioning: false,
    daemonOwnerLease: undefined,
    presencePublisher: undefined,
    detectedRuntimeFacts: [],
    runtimeObservations: [],
    resolvedEnvironment: serviceEnvironmentStatus(),
    environmentResolvedAt: undefined,
    presenceDiscovery: undefined,
    presenceDiscoveryPass: undefined,
    deploymentDeclaration: undefined,
    helloCapabilities: [],
    shutdownPromise: undefined,
    startedAt: undefined,
    auth: buildAuthManager(),
    lifecycleMutationTail: Promise.resolve(),
  };

  const daemonScope: DaemonScope = {
    config, adapters, overrides, assertionProbe, agentMemoryMcpEnabled, piByokLauncher,
    resolveAgentMemoryFilesystemHelperBin, agentMemoryMcpBin, agentMemoryDescribeBin,
    agentMemoryMcpAdmission, localAgentRelease, toolsetRegistry, memoryHelper, configWarnings, toolAuthorizationResolver, effectiveConfig,
    agentHomeReaderLimit, egressPolicy,
    egressBatcherOptions, presenceCadence, deviceAssertionAudiences, deviceAssertionTtlMs, storeDir,
    storageConfig, retentionClock, scratchRoot, storagePressure, inputPreparationLimits,
    preparedToolSurface, teamWorkspaces, store, memberRecords, sealIdentityOf, memberStatus,
    logMember, operationalHealth, ownedProcessLedger, cursorStore,
    agentHomeManager, agentSessionHandoffs, agentContentReadPolicies, initialAgentEgress,
    retentionRegistry, retentionSweeper, terminalCommits,
    outbound, observer, approvalRegistry, capabilityDiscoveryTimeoutMs, pendingLateMutationBarriers,
    buildAuthManager, daemonState,
    get controlMethods() { return controlMethods; },
    get reliableEnvelopes() { return reliableEnvelopes; },
    ...bindDaemonFunctions(() => daemonScope),
  };
  const controlMethods = createControlMethods(daemonScope);

  /** Each retry of a held record resends one envelope id (#698); a restart builds a new one. */
  const reliableEnvelopes = new WeakMap<AgentReliableEgressRecord, Envelope>();

  const {
    pair, start, stop, status, publishReliableAgentEgress, reloadMcpToolsets,
    reportMcpToolsetObservation, subscribe, tasks, unpair, approve, reject,
  } = daemonScope;
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
  assertRuntimeEnvironmentPolicy(config.runtimeEnvironment, 'DaemonConfig.runtimeEnvironment');
  return buildDaemon(config, (piByokLauncher) => buildDefaultAdapters(config, piByokLauncher), 'sdk-built', overrides, undefined);
}
