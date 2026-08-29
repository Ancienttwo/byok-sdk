import type { AgentEgressPolicy, AgentEvent, PermissionPolicy, TaskOfferPayload } from '@byok-sdk/protocol';
import type { RuntimeEnvironmentRequirements } from './daemon/environment';
import type { AgentRef } from './agent-home';

export type { AgentRef } from './agent-home';
export type { AgentEgressPolicy } from '@byok-sdk/protocol';

export type { RuntimeEnvironmentRequirements } from './daemon/environment';

export interface GitWorkspaceConfig {
  mode: 'local-checkpoints';
}

/**
 * Result of probing whether a runtime is usable on this machine. `authPresent`
 * is computed without ever reading the runtime's own credential storage (see
 * the credential-isolation rule on {@link RuntimeAdapter}) — it only reflects
 * whether a recognized environment variable name is set.
 */
export interface RuntimeDetectResult {
  present: boolean;
  version?: string;
  authPresent?: boolean;
}

/** What a runtime adapter can do, advertised so the daemon can pick/validate adapters. */
export interface RuntimeCapabilities {
  readonly steer: boolean;
  readonly resume: boolean;
  /**
   * Whether this adapter can project task-scoped, locally configured MCP
   * servers into the runtime without accepting executable definitions from
   * the remote task. Omission is fail-closed and means unsupported.
   */
  readonly mcpToolsets?: boolean;
  /**
   * Whether this adapter can genuinely pause a running session on
   * `needs_approval` and resume it from an out-of-band decision — i.e.
   * whether {@link Session.resolveApproval} really resolves rather than
   * throwing. This is the ONLY source of truth for the wire's
   * `RuntimeInfo.capabilities.approvalInteractive` (`daemon/
   * create-daemon.ts`'s `toRuntimeInfoCapabilities`); the daemon no longer
   * hardcodes a value.
   *
   * Required, deliberately: a new adapter (or a test fake) that forgets to
   * declare it fails to compile rather than silently defaulting to a claim
   * it cannot back.
   */
  readonly approvalInteractive: boolean;
  /** Subset of {@link PermissionPolicy}'s `mode` values this adapter can express without widening. */
  readonly permissionModes: readonly string[];
}

/** One local stdio MCP server definition. Remote task payloads can never supply this shape. */
export interface McpStdioServerConfig {
  command: string;
  args?: readonly string[];
  /** SDK-reserved task-scoped servers may receive child-only context. Host toolset configuration rejects this field. */
  env?: Readonly<Record<string, string>>;
}

/** A logical group of local MCP servers selectable by a wire-level toolset id. */
export interface McpToolsetConfig {
  mcpServers: Readonly<Record<string, McpStdioServerConfig>>;
}

/** Lifecycle facts a device host may explicitly report for one configured toolset. */
export type McpToolsetLifecycleState =
  | 'installed'
  | 'unauthorized'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'crashed'
  | 'incompatible';

/**
 * One host-owned lifecycle observation. The SDK validates and projects this
 * evidence but never derives it from executable configuration or command
 * presence. `reasonCode` is a bounded machine code, not arbitrary log text.
 */
export interface McpToolsetObservation {
  state: McpToolsetLifecycleState;
  observedAt: string;
  version?: string;
  reasonCode?: string;
}

/** Redacted status for one configured toolset; executable definitions are absent by construction. */
export interface McpToolsetStatus {
  id: string;
  serverCount: number;
  definitionRevision: string;
  observation?: Readonly<McpToolsetObservation>;
}

/** Content-addressed status of the daemon's complete device-local toolset registry. */
export interface McpToolsetRegistryStatus {
  revision: string;
  toolsets: readonly Readonly<McpToolsetStatus>[];
}

/** Receipt returned after an atomic, expected-revision registry reload. */
export interface McpToolsetReloadReceipt {
  previousRevision: string;
  revision: string;
  changed: boolean;
  toolsets: readonly Readonly<McpToolsetStatus>[];
}

/**
 * M4 Phase 3: the out-of-band approval channel `TaskRunner` (`daemon/
 * task-runner.ts`) hands to a prepared operation's `start()` via
 * `RuntimeOperationStartInput.approvalChannel`, for a runtime whose approval mechanism genuinely needs
 * to reach back into the daemon from OUTSIDE the adapter's own process — the
 * claude adapter's concrete case: `claude`'s `--permission-prompt-tool`
 * resolves a pending permission entirely inside a SEPARATE MCP-server child
 * process claude itself spawns (see `bin/byok-approval-mcp.ts`), which has
 * no in-process handle to this task's `Session` at all and must instead call
 * back into the SAME daemon over its control socket. `storeDir`/`productId`
 * are exactly what that out-of-process helper needs to find and authenticate
 * against this daemon's control socket (`daemon/control-protocol.ts`
 * `controlEndpointPath`/`controlTokenPath`); `taskId` is how its request gets
 * correlated back to THIS task once it arrives. `resolve()` is the
 * daemon-side counterpart: it resolves the single most-recently-registered
 * pending approval for this task (via `TaskRunner.requestApproval`'s own
 * `ApprovalRegistry` entry — see `daemon/approvals.ts`), and rejects if none
 * is currently pending, mirroring `Session.resolveApproval`'s own
 * no-notion-of-approval-pending fail-closed contract one level up.
 *
 * Optional and adapter-agnostic on purpose: only an adapter whose runtime
 * genuinely supports an out-of-band pause (claude, today) ever reads this;
 * every other adapter (pi, codex) ignores it exactly as before this field
 * existed.
 */
export interface ApprovalChannel {
  taskId: string;
  storeDir: string;
  productId: string;
  /** Default wait (ms) before the daemon force-resolves an unanswered approval request as a fail-closed rejection — see `TaskRunner.requestApproval`. */
  timeoutMs: number;
  /** Resolve the single currently-pending out-of-band approval for this task. Rejects if none is pending right now. */
  resolve(approved: boolean, reason?: string): Promise<void>;
}

/**
 * A running (or resumable) unit of work on a runtime. One `Session` maps to
 * one underlying runtime process/session for the lifetime of a task.
 */
export interface Session {
  /** Opaque runtime session id, reported back to the server via `task.complete.sessionRef`. */
  sessionRef: string;
  /** Normalized events for this session; the daemon batches these into `task.progress`. */
  events: AsyncIterable<AgentEvent>;
  /** Inject steering text into a running turn (mid-stream). */
  steer(text: string): Promise<void>;
  /** Send a new instruction on the same session after it has gone idle. */
  followUp(task: TaskOfferPayload): Promise<void>;
  /** Best-effort abort of the current turn (used for `task.cancel`). */
  interrupt(): Promise<void>;
  /**
   * Bounded, idempotent disposal receipt. Resolution proves every
   * adapter-owned process and task-scoped resource is quiescent. Expected
   * failure rejects with `RuntimeDisposalFailure` and never changes task
   * semantics.
   */
  close(): Promise<void>;
  /**
   * Resolve a session paused on `needs_approval` (protocol §5). The
   * server's own state has already moved by the time this is called (§4 —
   * `task.approve`/`task.reject` are best-effort notifications, not
   * requests awaiting a reply): `approved: true` must make the session
   * resume producing events (`task.progress` continuing is the proof);
   * `approved: false` means the caller will immediately follow up with
   * `interrupt()` + `close()` and report `task.fail` — an adapter that has
   * no notion of `needs_approval` at all (i.e. never emits one) should
   * throw a descriptive error here rather than silently no-op, since a
   * caller receiving `task.approve`/`task.reject` for one of its tasks
   * implies something upstream expected approval support that isn't there.
   */
  resolveApproval(approved: boolean, reason?: string): Promise<void>;
}

/**
 * Immutable runtime facts shared by discovery and one prepared operation.
 *
 * The SDK snapshots this value before each offer and never consults adapter
 * capability authority again during admission, claim, environment projection,
 * or start. Credential declarations are names only, never values.
 */
export interface RuntimeAdapterDescriptor {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;
  readonly environmentRequirements: RuntimeEnvironmentRequirements;
  /** Explicit opt-in to authoritative `task.offer.dispatchSelection` semantics. */
  readonly supportsDispatchSelection: boolean;
  /**
   * Whether this adapter actually CONSUMES
   * {@link RuntimeAdapterPrepareInput.mcpToolsetTools} — i.e. whether it
   * pre-grants each projected toolset server's tools in the runtime's own
   * grant surface (claude's `--allowedTools`, codex's `enabled_tools` +
   * per-tool `approval_mode`) and therefore needs the daemon to observe
   * them first.
   *
   * The daemon uses this, and only this, to decide whether to pay for the
   * pre-admission `tools/list` probe of every projected server
   * (`daemon/mcp-tools-probe.ts`). An adapter that projects toolsets through
   * its own proxy and grants them itself (the pi adapter) declares nothing
   * here and never makes an offer wait on a probe it has no use for.
   *
   * Omission is fail-closed in the direction that matters: no probe means no
   * observation, and an adapter that does consume the observation rejects a
   * projected server it has no tool names for (`adapters/mcp-tool-grants.ts`).
   * A grant is never widened by a missing declaration.
   */
  readonly requiresMcpToolsetToolObservation?: boolean;
}

/** The pure input to one adapter admission decision. It contains no credential values or workspace resources. */
export interface RuntimeAdapterPrepareInput {
  offer: TaskOfferPayload;
  policy: PermissionPolicy;
  descriptor: RuntimeAdapterDescriptor;
  requiredToolsetIds: readonly string[];
  /** Locally resolved MCP authority; available for pure admission validation only. */
  mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
  /** {@link McpToolsetToolObservation} for exactly the projected toolset servers in `mcpServers`. */
  mcpToolsetTools?: McpToolsetToolObservation;
}

/**
 * Tool names observed by starting each projected toolset MCP server and
 * reading its own `tools/list` answer (`daemon/mcp-tools-probe.ts`), keyed by
 * the projected server name. SDK-reserved servers are never keyed here — they
 * carry their own fixed, single-tool grants inside the adapters.
 *
 * This is the ONLY set of names an adapter may pre-grant to a runtime. Device
 * toolset configuration carries `command`/`args` only, so a configured value
 * could never be an authority on what a server exposes; a name absent from
 * this observation is a name the runtime is never told to allow.
 */
export type McpToolsetToolObservation = Readonly<Record<string, readonly string[]>>;

/** A permanent or currently-unavailable pre-claim admission rejection. */
export interface RuntimeAdapterRejectedOperation {
  kind: 'reject';
  reason: string;
  retryable: boolean;
}

/** The side-effect-free adapter decision made before TaskRunner claims an offer. */
export interface RuntimeAdapterPreparedOperation {
  kind: 'prepared';
  operation: PreparedRuntimeOperation;
}

export type RuntimeAdapterPrepareResult = RuntimeAdapterRejectedOperation | RuntimeAdapterPreparedOperation;

/**
 * Credential-free immutable identity for one admitted runtime operation.
 * It can be emitted, compared, and passed to a prepared operation, but never
 * serializes environment values or credential material.
 */
export interface RuntimeOperationManifest {
  readonly taskId: string;
  /** Selected runtime id; lane/provider/model, when present, live only in `dispatchSelection`. */
  readonly runtimeId: string;
  readonly descriptor: RuntimeAdapterDescriptor;
  readonly policy: PermissionPolicy;
  readonly requiredToolsetIds: readonly string[];
  /** The credential-free runtime/lane/provider/model authority for this operation. */
  readonly dispatchSelection?: TaskOfferPayload['dispatchSelection'];
  readonly sessionRef?: string;
  /** Strict Agent identity, present only for task.offer_for_agent. */
  readonly agentRef?: AgentRef;
  /** Canonical runtime cwd; for an Agent task this is the Agent home root. */
  readonly cwd?: string;
  /** Opaque local lease identity sealed with the Agent manifest. */
  readonly lease?: {
    readonly leaseId: string;
    readonly canonicalHome: string;
  };
  readonly workspace: {
    readonly workspaceDir: string;
    readonly workspaceId?: string;
    readonly baseline?: string;
  };
  /** Names are audit-safe; credential values intentionally never enter the manifest. */
  readonly forwardedEnvironmentNames: readonly string[];
}

/** Runtime resources only available after TaskRunner has sealed the manifest and claimed the task. */
export interface RuntimeOperationStartInput {
  readonly manifest: RuntimeOperationManifest;
  readonly instruction: string;
  readonly env: NodeJS.ProcessEnv;
  /** Local MCP authority resolved from logical wire ids. */
  readonly mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
  /** {@link McpToolsetToolObservation} for exactly the projected toolset servers in `mcpServers`. */
  readonly mcpToolsetTools?: McpToolsetToolObservation;
  /** Optional, adapter-agnostic out-of-band approval channel. */
  readonly approvalChannel?: ApprovalChannel;
}

/** A pinned provider/runtime decision. `start()` receives resources only, never a raw offer. */
export interface PreparedRuntimeOperation {
  start(input: RuntimeOperationStartInput): Promise<Session>;
}

/**
 * Uniform public adapter seam. `prepare()` is required and must not spawn,
 * create temp files, mutate a workspace, allocate a session id, or read a
 * credential value. There is intentionally no direct `RuntimeAdapter.start`.
 */
export interface RuntimeAdapter {
  readonly descriptor: RuntimeAdapterDescriptor;
  detect(): Promise<RuntimeDetectResult>;
  prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult>;
}

function frozenStrings(values: readonly string[] | undefined): readonly string[] | undefined {
  return values === undefined ? undefined : Object.freeze([...values]);
}

function frozenPolicy(policy: PermissionPolicy): PermissionPolicy {
  const allowTools = policy.allowTools === undefined ? undefined : Object.freeze([...policy.allowTools]) as unknown as string[];
  const denyTools = policy.denyTools === undefined ? undefined : Object.freeze([...policy.denyTools]) as unknown as string[];
  return Object.freeze({
    mode: policy.mode,
    ...(allowTools === undefined ? {} : { allowTools }),
    ...(denyTools === undefined ? {} : { denyTools }),
    ...(policy.workspaceRoot === undefined ? {} : { workspaceRoot: policy.workspaceRoot }),
    ...(policy.network === undefined ? {} : { network: policy.network }),
  });
}

/** Copy then deeply freeze descriptor authority so callers cannot retain a mutable source reference. */
export function freezeRuntimeAdapterDescriptor(descriptor: RuntimeAdapterDescriptor): RuntimeAdapterDescriptor {
  const baseNames = frozenStrings(descriptor.environmentRequirements.baseNames);
  const credentialNames = frozenStrings(descriptor.environmentRequirements.credentialNames);
  return Object.freeze({
    id: descriptor.id,
    supportsDispatchSelection: descriptor.supportsDispatchSelection === true,
    requiresMcpToolsetToolObservation: descriptor.requiresMcpToolsetToolObservation === true,
    capabilities: Object.freeze({
      steer: descriptor.capabilities.steer === true,
      resume: descriptor.capabilities.resume === true,
      approvalInteractive: descriptor.capabilities.approvalInteractive === true,
      ...(descriptor.capabilities.mcpToolsets === undefined ? {} : { mcpToolsets: descriptor.capabilities.mcpToolsets === true }),
      permissionModes: Object.freeze([...descriptor.capabilities.permissionModes]),
    }),
    environmentRequirements: Object.freeze({
      ...(baseNames === undefined
        ? {}
        : { baseNames }),
      ...(credentialNames === undefined
        ? {}
        : { credentialNames }),
    }),
  });
}

/** Copy then freeze the complete safe operation authority just before claim. */
export function sealRuntimeOperationManifest(manifest: RuntimeOperationManifest): RuntimeOperationManifest {
  return Object.freeze({
    taskId: manifest.taskId,
    runtimeId: manifest.runtimeId,
    descriptor: freezeRuntimeAdapterDescriptor(manifest.descriptor),
    policy: frozenPolicy(manifest.policy),
    requiredToolsetIds: Object.freeze([...manifest.requiredToolsetIds]),
    ...(manifest.dispatchSelection === undefined ? {} : { dispatchSelection: Object.freeze({ ...manifest.dispatchSelection }) }),
    ...(manifest.sessionRef === undefined ? {} : { sessionRef: manifest.sessionRef }),
    ...(manifest.agentRef === undefined
      ? {}
      : { agentRef: Object.freeze({ agentId: manifest.agentRef.agentId, profileRevision: manifest.agentRef.profileRevision }) }),
    cwd: manifest.cwd ?? manifest.workspace.workspaceDir,
    ...(manifest.lease === undefined
      ? {}
      : { lease: Object.freeze({ leaseId: manifest.lease.leaseId, canonicalHome: manifest.lease.canonicalHome }) }),
    workspace: Object.freeze({ ...manifest.workspace }),
    forwardedEnvironmentNames: Object.freeze([...manifest.forwardedEnvironmentNames]),
  });
}

/**
 * Thrown by a prepared operation's `start()` when an already admitted task
 * cannot continue because an internal invariant was violated. Permanent
 * offer semantics are rejected by `RuntimeAdapter.prepare()` before claim;
 * this class remains for post-claim operational/session failures whose
 * retryability is already part of the frozen task behavior.
 */
export class PolicyUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyUnsupportedError';
  }
}

/**
 * Thrown by {@link Session.steer} on an adapter whose runtime has no
 * mid-turn steering channel at all (`descriptor.capabilities.steer === false`) — a
 * permanent property of the runtime, never a transient failure. Typed
 * rather than a bare `Error` so the daemon can classify an inbound
 * `task.steer` for such a runtime as non-retryable (record + ack, cursor
 * advances) instead of stalling the cursor on it forever, without matching
 * on message strings.
 */
export class SteerUnsupportedError extends Error {
  /** The `RuntimeAdapter.descriptor.id` that cannot steer (e.g. `claude`, `codex`). */
  readonly runtimeId: string;

  constructor(runtimeId: string, message: string) {
    super(message);
    this.name = 'SteerUnsupportedError';
    this.runtimeId = runtimeId;
  }
}
