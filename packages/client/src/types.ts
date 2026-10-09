import type { NativeInteractionCapabilities, NativeInteractionChannel } from './native-interactions';
import type { PreparedAgentMemoryMode } from '@byok-sdk/protocol';
import type { PreparedAgentMemoryState } from './daemon/prepared-agent-memory';
import type { PiRuntimeLaunchResources } from './adapters/pi/runtime-launch';
import type {
  AgentEgressPolicy,
  AgentEvent,
  TaskOfferPayload,
} from '@byok-sdk/protocol';
import type { InputPreparationModelV1 } from './input-preparation';
import type { AgentRef } from './agent-home';
import type { McpToolsetServerObservation } from './mcp/observation';

export type { AgentRef } from './agent-home';
export type {
  McpServerObservation,
  McpToolDescriptor,
  McpToolsetServerObservation,
} from './mcp/observation';
export type { AgentEgressPolicy } from '@byok-sdk/protocol';


export interface GitWorkspaceConfig {
  mode: 'local-checkpoints';
}

/**
 * Failure vocabulary shared by the detection contract and local diagnostics.
 */
export const RUNTIME_DETECTION_FAILURE_KINDS = ['not-found', 'not-executable', 'timeout', 'probe-failed', 'refused'] as const;

/**
 * One probe outcome, never a separately authored presence boolean. Authentication
 * observation retains each adapter's native status/env-name probe and never
 * reads credential storage. Failure variants contain no arbitrary diagnostics.
 */
export type RuntimeDetectResult =
  | { readonly kind: 'available'; readonly version?: string; readonly authPresent?: boolean; readonly advisory?: RuntimeDetectionAdvisory }
  | { readonly kind: Exclude<typeof RUNTIME_DETECTION_FAILURE_KINDS[number], 'refused'> }
  | { readonly kind: 'refused'; readonly reason: RuntimeDetectionRefusalReason };

/**
 * A local agent updates itself, so a version the SDK was not qualified against
 * is a warning, not a refusal. `version` on the result carries what was found.
 */
export interface RuntimeDetectionAdvisory {
  readonly reason: 'runtime_version_unqualified';
  readonly qualifiedVersion: string;
}

export type RuntimeDetectionRefusalReason = 'app_server_unavailable';

/** What a runtime adapter can do, advertised so the daemon can pick/validate adapters. */
export interface RuntimeCapabilities {
  /** Local native interaction support only; omission is unsupported. Not the remote boolean approval lane. */
  readonly nativeInteractions?: NativeInteractionCapabilities;
  /** Local adapter advertisement; no new protocol field or capability vocabulary. */
  readonly durablePi?: boolean;
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
 * Adapter-agnostic out-of-band channel handed to prepared operations by TaskRunner.
 * The shared registry resolves one pending approval for this task and rejects
 * when none is pending. Claude no longer consumes this channel; third-party
 * adapters and the daemon's generic needs_approval/control path may use it.
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
  /** Process-generation-bound native requests. Never reconstructed from a resumed transcript. */
  readonly interactions?: NativeInteractionChannel;
  /** Current execution artifact, available only after terminal success. */
  resultDocument?(): unknown;
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
 * capability authority again during admission, claim or start.
 */
export interface RuntimeAdapterDescriptor {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;
  /** Explicit opt-in to authoritative `task.offer.dispatchSelection` semantics. */
  readonly supportsDispatchSelection: boolean;
  /**
   * Whether this adapter actually CONSUMES
   * {@link RuntimeAdapterPrepareInput.mcpToolsetTools} — i.e. whether it
   * needs the daemon to observe each projected toolset server before
   * admission, because it registers those tools itself: pi registers one tool
   * per observed MCP tool with the server's own schema. Claude and Codex
   * attach the MCP servers and let the runtime list the tools itself, so they
   * declare nothing.
   *
   * The daemon uses this, and only this, to decide whether to pay for the
   * pre-admission `tools/list` observation of every projected server
   * (`daemon/mcp-tools-probe.ts`). An adapter that consumes no observation
   * never makes an offer wait on one it has no use for.
   */
  readonly requiresMcpToolsetToolObservation?: boolean;
  /**
   * Whether each `progress` event carries one complete assistant message
   * rather than a streaming delta. Codex emits one event per completed
   * `agentMessage`, so its commentary and its final answer arrive as separate
   * events with no tool interaction between them. When this is true, the
   * daemon starts a new closing reply at every `progress` event, so the
   * closing reply (`task.complete.finalMessage`) is the last message only.
   * Absent or false: consecutive `progress` events form one reply until a
   * tool interaction.
   */
  readonly progressEventsAreMessages?: boolean;
}

/** The pure input to one adapter admission decision. It contains no credential values or workspace resources. */
export interface RuntimeAdapterPrepareInput {
  /** Admission cancellation; late pure results are discarded and never started. */
  signal?: AbortSignal;
  offer: TaskOfferPayload;
  descriptor: RuntimeAdapterDescriptor;
  requiredToolsetIds: readonly string[];
  /** Locally resolved MCP authority; available for pure admission validation only. */
  mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
  /** {@link McpToolsetToolObservation} for exactly the projected toolset servers in `mcpServers`. */
  mcpToolsetTools?: McpToolsetToolObservation;
}

/**
 * What each projected toolset MCP server said about itself when the daemon
 * started it and read its own `initialize` + `tools/list` answer
 * (`daemon/mcp-tools-probe.ts`), keyed by the projected server name.
 * SDK-reserved servers are never keyed here — they carry their own fixed,
 * single-tool grants inside the adapters.
 *
 * This is the ONLY authority an adapter may bind a runtime to. Device toolset
 * configuration carries `command`/`args` only, so a configured value could
 * never say what a server exposes; a tool absent from this observation is a
 * tool no runtime is ever told about.
 *
 * It carries FULL descriptors — name, description and the server's own
 * `inputSchema` — plus the server identity and negotiated protocol version.
 * pi registers one tool per MCP tool with the real schema; the prepared launch
 * path binds the schema digest into a frozen tool manifest.
 */
export type McpToolsetToolObservation = Readonly<Record<string, McpToolsetServerObservation>>;

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
  /** Required by prepared operations, absent on ordinary operations. */
  readonly agentMemory?: PreparedAgentMemoryMode;
  readonly taskId: string;
  /** Selected runtime id; lane/provider/model, when present, live only in `dispatchSelection`. */
  readonly runtimeId: string;
  readonly descriptor: RuntimeAdapterDescriptor;
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

/**
 * The durable identity of one already-counted preparation record
 * (`daemon/input-preparation-store.ts`'s {@link InputPreparationRecordKey} plus
 * its derived `recordId`).
 *
 * Carried so a prepared launch names the record it consumes rather than being
 * handed anonymous bytes: the launch is refused if the artifact on disk does
 * not carry this `recordId`.
 */
export interface RuntimePreparedLaunchReferenceV1 {
  readonly scopeId: string;
  readonly agentRef: string;
  readonly requestId: string;
  readonly recordId: string;
}

/**
 * The independently trusted expectations the prepared-input verifier
 * requires (`adapters/pi/input-preparation.ts`'s `PreparedPiExpectedV1`).
 *
 * They come from the DURABLE record — its artifact summary and its binding —
 * never from the artifact file itself. The verifier contract is explicit that a
 * value read out of the envelope can never serve as its own expectation, so
 * carrying them here is what makes the envelope on disk checkable at all.
 */
export interface RuntimePreparedLaunchExpectationV1 {
  /** `InputPreparationArtifactSummaryV1.envelopeDigest`. */
  readonly envelopeDigest: string;
  /** `InputPreparationArtifactSummaryV1.toolManifestDigest`. */
  readonly toolManifestDigest: string;
  /** The exact model identity the record's binding pinned. */
  readonly model: InputPreparationModelV1;
  /** The compiler binding the record's request was compiled under. */
  readonly binding: {
    readonly inputIdentity: string;
    readonly runtimeIdentity: string;
    readonly policyIdentity: string;
    readonly profileRevision: string;
  };
}

/**
 * Everything one prepared Execution needs to launch the frozen request it was
 * counted for.
 *
 * There is no `instruction` here and no way to supply one: the user request is
 * already inside the frozen envelope, and a prepared run that accepted a
 * separate instruction would have two answers to what it is about to send.
 */
export interface RuntimePreparedLaunchV1 {
  readonly agentMemory: PreparedAgentMemoryMode;
  readonly memory: PreparedAgentMemoryState | null;
  readonly reference: RuntimePreparedLaunchReferenceV1;
  /**
   * Absolute path of the retained `InputPreparationArtifact` JSON.
   *
   * A path rather than inline bytes on purpose: the artifact carries D, P(D)
   * and the whole native envelope, and there is exactly one retained copy of
   * it. A second inline representation would be a second authority over the
   * same bytes.
   */
  readonly artifactPath: string;
  readonly expected: RuntimePreparedLaunchExpectationV1;
  readonly toolBindingDigest: string;
  readonly observationDigest: string;
  /** `toolsetId` -> the registry definition revision the preparation bound. */
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
}

/** Trusted daemon barriers for the opt-in durable worker; never serialized. */
export interface DurableLifecycle {
  record(kind: 'tool-intent' | 'tool-committed' | 'respawn-intent', ordinal: number): Promise<void>;
  ownsLease(): boolean;
}

/** Runtime resources shared by every start variant. */
interface RuntimeOperationStartBase {
  /** Trusted parent-only recovery authority; never serialized into the worker. */
  readonly durableContext?: { readonly tenantId: string; readonly lifecycle: DurableLifecycle };

  readonly runtimeLaunch?: PiRuntimeLaunchResources;
  /** Exact daemon MCP admission environment; Pi requires it and never inherits runtime credentials. */
  readonly mcpEnv?: Readonly<Record<string, string>>;
  /** Startup cancellation only; rejection must preserve unresolved process ownership. */
  readonly signal?: AbortSignal;
  readonly manifest: RuntimeOperationManifest;
  readonly env: NodeJS.ProcessEnv;
  /** Local MCP authority resolved from logical wire ids. */
  readonly mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
  /** {@link McpToolsetToolObservation} for exactly the projected toolset servers in `mcpServers`. */
  readonly mcpToolsetTools?: McpToolsetToolObservation;
  /** Optional, adapter-agnostic out-of-band approval channel. */
  readonly approvalChannel?: ApprovalChannel;
}

/** The ordinary start: a resolved instruction the runtime turns into its own first request. */
export interface RuntimeOperationInstructionStartInput extends RuntimeOperationStartBase {
  readonly kind: 'instruction';
  readonly instruction: string;
}

/**
 * The prepared start: an already-compiled, already-counted provider request the
 * runtime must send verbatim.
 *
 * A separate variant rather than an optional field beside `instruction`,
 * because the two are mutually exclusive authority over the same bytes: with
 * both reachable on one shape every adapter would have to decide which one
 * wins, and the answer would be written three times.
 */
export interface RuntimeOperationPreparedStartInput extends RuntimeOperationStartBase {
  readonly kind: 'prepared';
  readonly preparation: RuntimePreparedLaunchV1;
}

/**
 * Runtime resources only available after TaskRunner has sealed the manifest and
 * claimed the task.
 *
 * Discriminated, not an optional bag: an adapter that does not implement the
 * prepared lane must refuse it by name, and a union is what makes forgetting to
 * a compile error rather than a silently ignored field.
 */
export type RuntimeOperationStartInput =
  | RuntimeOperationInstructionStartInput
  | RuntimeOperationPreparedStartInput;

/** A pinned provider/runtime decision. `start()` receives resources only, never a raw offer. */
export interface PreparedRuntimeOperation {
  /** Resource phase after workspace resolution and before claim; never reads a credential. */
  resolveRuntimeLaunch?(input: {
    kind: 'instruction' | 'prepared'; cwd: string; env: Readonly<Record<string, string | undefined>>;
    projectionRoot: string;
  }): Promise<PiRuntimeLaunchResources>;
  start(input: RuntimeOperationStartInput): Promise<Session>;
}

/**
 * Uniform public adapter seam. `prepare()` is required and must not spawn,
 * create temp files, mutate a workspace, allocate a session id, or read a
 * credential value. There is intentionally no direct `RuntimeAdapter.start`.
 */
export interface RuntimeAdapter {
  readonly descriptor: RuntimeAdapterDescriptor;
  /** Readiness probing must not mutate an Agent home or allocate execution ownership. */
  detect(signal?: AbortSignal): Promise<RuntimeDetectResult>;
  prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult>;
}

/** Copy then deeply freeze descriptor authority so callers cannot retain a mutable source reference. */
export function freezeRuntimeAdapterDescriptor(descriptor: RuntimeAdapterDescriptor): RuntimeAdapterDescriptor {
  return Object.freeze({
    id: descriptor.id,
    supportsDispatchSelection: descriptor.supportsDispatchSelection === true,
    requiresMcpToolsetToolObservation: descriptor.requiresMcpToolsetToolObservation === true,
    ...(descriptor.progressEventsAreMessages === true ? { progressEventsAreMessages: true } : {}),
    capabilities: Object.freeze({
      ...(descriptor.capabilities.durablePi === undefined ? {} : { durablePi: descriptor.capabilities.durablePi === true }),
      ...(descriptor.capabilities.nativeInteractions === undefined ? {} : {
        nativeInteractions: Object.freeze({
          approvalDecisions: Object.freeze([...descriptor.capabilities.nativeInteractions.approvalDecisions]),
          structuredQuestions: descriptor.capabilities.nativeInteractions.structuredQuestions === true,
        }),
      }),
      steer: descriptor.capabilities.steer === true,
      resume: descriptor.capabilities.resume === true,
      approvalInteractive: descriptor.capabilities.approvalInteractive === true,
      ...(descriptor.capabilities.mcpToolsets === undefined ? {} : { mcpToolsets: descriptor.capabilities.mcpToolsets === true }),
    }),
  });
}

/** Copy then freeze the complete safe operation authority just before claim. */
export function sealRuntimeOperationManifest(manifest: RuntimeOperationManifest): RuntimeOperationManifest {
  const dispatchSelection = manifest.dispatchSelection === undefined
    ? undefined
    : manifest.dispatchSelection.lane === 'byok-profile'
      ? Object.freeze({
          ...manifest.dispatchSelection,
          providerProfile: Object.freeze({
            ...manifest.dispatchSelection.providerProfile,
            requiredCapabilities: Object.freeze([
              ...manifest.dispatchSelection.providerProfile.requiredCapabilities,
            ]),
          }),
        }) as TaskOfferPayload['dispatchSelection']
      : Object.freeze({ ...manifest.dispatchSelection });
  return Object.freeze({
    ...(manifest.agentMemory === undefined ? {} : {agentMemory: manifest.agentMemory}),
    taskId: manifest.taskId,
    runtimeId: manifest.runtimeId,
    descriptor: freezeRuntimeAdapterDescriptor(manifest.descriptor),
    requiredToolsetIds: Object.freeze([...manifest.requiredToolsetIds]),
    ...(dispatchSelection === undefined ? {} : { dispatchSelection }),
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
