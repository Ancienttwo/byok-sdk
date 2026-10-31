import type { ServiceEnvironmentUnavailableCode } from './login-shell-environment';
import type { RuntimeEnvironment } from './runtime/environment';
import type { ExecutionScratch } from './daemon/retention/scratch';
import type { NativeInteractionCapabilities, NativeInteractionChannel } from './native-interactions';
import type { ToolAuthorizationGate } from './tool-authorization';
import type { PreparedAgentMemoryMode } from '@byok-sdk/protocol';
import type { PreparedAgentMemoryState } from './daemon/prepared-agent-memory';
import type { PiRuntimeLaunchResources } from './adapters/pi/runtime-launch';
import type {
  AgentEgressPolicy,
  AgentEvent,
  TaskOfferPlainPayload,
} from '@byok-sdk/protocol';
import type { InputPreparationModelV1 } from './input-preparation';
import type { AgentRef } from './agent-home';
import type { McpToolsetServerObservation } from './mcp/observation';
import { freezeRuntimeVersionPolicy } from './runtime-version-policy';

export type { AgentRef } from './agent-home';

/**
 * The offer fields a runtime adapter receives. The client owns this shape;
 * the daemon projects each wire offer onto it.
 */
export type RuntimeTaskInput = Pick<TaskOfferPlainPayload, 'runtime' | 'harnessId' | 'dispatchSelection' | 'limits'> & {
  instruction: NonNullable<TaskOfferPlainPayload['instruction']>;
  /** The runtime session to resume (`session.mode: 'resume'` on the offer); absent for a fresh session. */
  sessionRef?: string;
};
export type {
  McpServerObservation,
  McpToolDescriptor,
  McpToolsetServerObservation,
} from './mcp/observation';
export type { AgentEgressPolicy } from '@byok-sdk/protocol';

/**
 * Failure vocabulary shared by the detection contract and local diagnostics.
 */
export const RUNTIME_DETECTION_FAILURE_KINDS = ['not-found', 'not-executable', 'timeout', 'probe-failed', 'refused'] as const;

/**
 * One version predicate (#1103). Only an exact token or a component-boundary
 * prefix: no range, no minimum/maximum, no regular expression and no semver
 * dependency, so the policy can never become a second version comparator.
 */
export type RuntimeVersionSpec =
  | { readonly kind: 'exact'; readonly version: string }
  | { readonly kind: 'prefix'; readonly prefix: string };

/**
 * Pure, serializable version policy (#1103). The descriptor default, an
 * adapter option and `DaemonConfig.runtimes.<id>.versionPolicy` are complete
 * objects that replace one another wholesale through
 * `resolveRuntimeVersionPolicy`; a field is never merged across them.
 */
export interface RuntimeVersionPolicy {
  /** The normalized token this SDK was qualified against, for example `0.160.0`. */
  readonly qualifiedVersion: string;
  /** What an unmatched token means. A descriptor default may not use `block`; only a Host layer may. */
  readonly unqualified: 'allow' | 'warn' | 'block';
  /** Explicitly known-good versions outside the qualified range. */
  readonly allow?: readonly RuntimeVersionSpec[];
  /** Versions that must stay a warning even where `unqualified` is `allow`. */
  readonly warn?: readonly RuntimeVersionSpec[];
  /** Versions this Host refuses before claim. Host layer only. */
  readonly block?: readonly RuntimeVersionSpec[];
}

/** The one policy verdict for an installed runtime token (#1103). `matched` names the spec that decided a non-qualified verdict. */
export type RuntimeVersionVerdict =
  | { readonly state: 'allow'; readonly qualifiedVersion: string; readonly matched?: string }
  | { readonly state: 'warn'; readonly qualifiedVersion: string; readonly matched?: string }
  | { readonly state: 'block'; readonly qualifiedVersion: string; readonly matched: string };

/**
 * One probe outcome, never a separately authored presence boolean. Authentication
 * observation is each adapter's native non-secret login-state probe (a status
 * command, credential env-var names, or Pi's shape-only agent-dir login check)
 * and never returns, logs, or retains a credential value. Failure variants
 * contain no arbitrary diagnostics.
 */
export type RuntimeDetectResult =
  | { readonly kind: 'available'; readonly version?: string; readonly authPresent?: boolean; readonly advisory?: RuntimeDetectionAdvisory; readonly versionVerdict?: RuntimeVersionVerdict }
  | { readonly kind: Exclude<typeof RUNTIME_DETECTION_FAILURE_KINDS[number], 'refused'> }
  | { readonly kind: 'refused'; readonly reason: Exclude<RuntimeDetectionRefusalReason, 'runtime_environment_unavailable'> }
  | { readonly kind: 'refused'; readonly reason: 'runtime_environment_unavailable'; readonly code: ServiceEnvironmentUnavailableCode };

/**
 * A local agent updates itself, so a version the SDK was not qualified against
 * is a warning, not a refusal. `version` on the result carries what was found.
 */
export interface RuntimeDetectionAdvisory {
  readonly reason: 'runtime_version_unqualified';
  readonly qualifiedVersion: string;
}

/**
 * `app_server_unavailable`: Codex has no `app-server`. `acp_unavailable`: an ACP runtime has no stdio ACP mode.
 * `platform_unsupported`: the host platform is not in {@link RuntimeAdapterDescriptor.platforms}; no probe ran.
 * `runtime_environment_unavailable`: the login-shell capture failed (`code`), so the runtime has no environment to start in (#1095).
 */
export type RuntimeDetectionRefusalReason = 'app_server_unavailable' | 'acp_unavailable' | 'platform_unsupported' | 'runtime_environment_unavailable';

/**
 * Each `true` is a guarantee the runtime contract suite checks; `false` means
 * the SDK makes no such guarantee for this runtime (#1103).
 */
export interface RuntimeIsolationCapabilities {
  /** User-level instructions (a user `CLAUDE.md`, `AGENTS.md` or rules) can be kept out. */
  readonly userContext: boolean;
  /** MCP servers the user configured for the runtime can be kept out. */
  readonly userMcpServers: boolean;
  /** The runtime's own transcript store can be turned off. */
  readonly sessionPersistence: boolean;
}

/** What a runtime adapter can do, advertised so the daemon can pick/validate adapters. */
export interface RuntimeCapabilities {
  /**
   * Enforces the `auto` tool authorization gate before every native tool call
   * of an ordinary instruction start. Omission means `auto` tasks are declined
   * for this adapter before claim; `all` needs no adapter support.
   */
  readonly toolAuthorizationAuto?: boolean;
  /** Supports display-only Agent message drafts. Omission means unsupported. */
  readonly messageDraft?: boolean;
  /** Local native interaction support only; omission is unsupported. Not the approval channel. */
  readonly nativeInteractions?: NativeInteractionCapabilities;
  /** The durable Pi worker. Omission means an ordinary adapter. */
  readonly durablePi?: boolean;
  /**
   * Accepts a prepared offer (the prepared lane). Omission means unsupported.
   * `auto` never applies to a prepared offer, whatever `toolAuthorizationAuto` says.
   */
  readonly preparedLane?: boolean;
  /** Which user-level sources the adapter keeps out of a Bot session. Omission means none. */
  readonly isolation?: RuntimeIsolationCapabilities;
  readonly steer: boolean;
  readonly resume: boolean;
  /**
   * Whether this adapter can project task-scoped, locally configured MCP
   * servers into the runtime without accepting executable definitions from
   * the remote task. Omission is fail-closed and means unsupported.
   */
  readonly mcpToolsets?: boolean;
  /**
   * Whether this adapter's sessions call
   * {@link RuntimeOperationStartInput.approvalChannel}'s `request` and wait
   * for the decision. Only such an adapter is handed the channel. It is also
   * the sole source of the wire's `RuntimeInfo.capabilities.approvalInteractive`.
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
  mcpServers: Readonly<Record<string, McpStdioServerConfig & {
    /** Exact Host-approved tool names; omitted or empty adds no approval. Local configuration only. */
    readonly approveTools?: readonly string[];
  }>>;
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
 * The one way a session asks for approval. TaskRunner hands it only to an
 * adapter that declares `approvalInteractive: true`.
 */
export interface ApprovalChannel {
  /**
   * Sends `task.await_approval` for this task and waits for the decision: a
   * wire `task.approve`/`task.reject`, a local `Daemon.approve`/`reject` or
   * `approvals.resolve`, or a fail-closed rejection on timeout, task finish or
   * eviction. The session resumes or stops its runtime from the result.
   */
  request(summary: string): Promise<{ approved: boolean; reason?: string }>;
}

/**
 * Display-only text for the daemon's Agent message draft lane. It is not an
 * `AgentEvent`: the daemon never batches, records or replies with it. The
 * adapter's own message tracker sets `startsMessage` on the first non-blank
 * delta of a new message, and each later `progress` event reconciles the draft.
 */
export interface MessageDraftDelta {
  type: 'message_draft_delta';
  text: string;
  startsMessage: boolean;
}

/**
 * A running (or resumable) unit of work on a runtime. One `Session` maps to
 * one underlying runtime process/session for the lifetime of a task.
 */
export interface Session {
  /** Process-generation-bound native requests. Never reconstructed from a resumed transcript. */
  readonly interactions?: NativeInteractionChannel;
  /** Opaque runtime session id, reported back to the server via `task.complete.sessionRef`. */
  sessionRef: string;
  /** Normalized events for this session; the daemon batches these into `task.progress`. A `MessageDraftDelta` only feeds the display-only draft. */
  events: AsyncIterable<AgentEvent | MessageDraftDelta>;
  /**
   * For an adapter whose descriptor sets `progressEventsAreMessages` but
   * emits one assistant message as several `progress` events. Return false
   * when `event`, an object this session's `events` yielded, continues the
   * message of an earlier event: the daemon then keeps both in the same
   * closing reply. Absent: every non-blank `progress` event starts a message.
   */
  progressStartsMessage?(event: Extract<AgentEvent, { type: 'progress' }>): boolean;
  /** Inject steering text into a running turn (mid-stream). */
  steer(text: string): Promise<void>;
  /** Send a new instruction on the same session after it has gone idle. */
  followUp(task: RuntimeTaskInput): Promise<void>;
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
   * Runtime output this session could not turn into `events`, as counts for
   * the whole session up to `close()`. The daemon reads it once, after
   * `close()` resolved, and only when the descriptor declares
   * `trajectoryEvidence`. A declaring adapter that omits it states that
   * nothing below its event stream can drop or invent a frame.
   */
  evidence?(): SessionEvidence;
}

/** Counts behind one session's event stream; see {@link Session.evidence}. Never a frame, a line or a tool payload. */
export interface SessionEvidence {
  /** Runtime output frames that could not be decoded, including a truncated frame left at the end of the stream. */
  readonly decodeDropped: number;
  /** Decoded frames of a type the adapter neither maps to an event nor expects as bookkeeping. */
  readonly unmappedFrames: number;
  /** Tool results the adapter produced itself instead of observing them from the runtime. */
  readonly syntheticToolResults: number;
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
  /**
   * The effective version policy (#1103), already resolved and frozen by the
   * adapter constructor. Absent for a custom adapter with no policy.
   */
  readonly versionPolicy?: RuntimeVersionPolicy;
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
  /** Can enforce the local Host's exact per-tool MCP approvals. Nonempty grants require this capability. */
  readonly mcpToolApprovals?: boolean;
  /**
   * Whether each `progress` event carries one complete assistant message
   * rather than a streaming delta. Codex emits one event per completed
   * `agentMessage`, and Claude one per complete text block, so commentary and
   * the final answer arrive as separate events with no tool interaction
   * between them. When this is true, the
   * daemon starts a new closing reply at every `progress` event, so the
   * closing reply (`task.complete.finalMessage`) is the last message only.
   * Absent or false: consecutive `progress` events form one reply until a
   * tool interaction.
   */
  readonly progressEventsAreMessages?: boolean;
  /**
   * Declares `Session.events` as the evidence source of the daemon's local
   * execution record (`daemon/execution-record.ts`): every tool call and
   * result carries its `toolCallId`, and `turn_end` means the runtime
   * completed. Absent: every record of this adapter is `unknown`.
   */
  readonly trajectoryEvidence?: 'event-stream';
  /**
   * The `process.platform` values this adapter supports. Runtime detection
   * refuses every other platform with `platform_unsupported` before it runs a
   * probe. Absent: no platform restriction (a custom adapter's default).
   */
  readonly platforms?: readonly NodeJS.Platform[];
}

/** The pure input to one adapter admission decision. It contains no credential values or workspace resources. */
export interface RuntimeAdapterPrepareInput {
  /** Admission cancellation; late pure results are discarded and never started. */
  signal?: AbortSignal;
  offer: RuntimeTaskInput;
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
  readonly dispatchSelection?: RuntimeTaskInput['dispatchSelection'];
  readonly sessionRef?: string;
  /** Strict Agent identity, present on every `task.offer`. */
  readonly agentRef?: AgentRef;
  /**
   * Canonical runtime cwd. For an Agent writer it is the Agent home root. For
   * a `memory-reader` Attempt it is the run directory
   * `<home>/.byok/runs/<taskId>/`, and `lease.canonicalHome` names the home.
   */
  readonly cwd?: string;
  /**
   * Present for a `memory-reader` Agent Attempt only. An adapter whose runtime
   * does not read instruction files from ancestors of `cwd` uses it to point
   * the runtime at `lease.canonicalHome`.
   */
  readonly homeAccess?: 'memory-reader';
  /** Opaque local lease identity sealed with the Agent manifest. */
  readonly lease?: {
    readonly leaseId: string;
    readonly canonicalHome: string;
  };
  readonly workspace: {
    readonly workspaceDir: string;
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
  readonly terminalProjection?: import('@byok-sdk/protocol').TerminalProjectionSelection;
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
  readonly scratch: ExecutionScratch;
  /** Exact local resource acquired by this operation before resume handoff validation; never serialized. */
  readonly sessionLease?: RuntimeSessionLease;
  /** Trusted parent-only recovery authority; never serialized into the worker. */
  readonly durableContext?: { readonly tenantId: string; readonly lifecycle: DurableLifecycle; readonly replicaRoot: string };

  readonly runtimeLaunch?: PiRuntimeLaunchResources;
  /** Exact daemon MCP admission environment; Pi requires it and never inherits runtime credentials. */
  readonly mcpEnv?: Readonly<Record<string, string>>;
  /** Startup cancellation only; rejection must preserve unresolved process ownership. */
  readonly signal?: AbortSignal;
  readonly manifest: RuntimeOperationManifest;
  readonly env: NodeJS.ProcessEnv;
  /** Local MCP authority resolved from logical wire ids. */
  readonly mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
  /** Local registry approvals copied and frozen with this attempt's servers; never sourced from wire or transcript. */
  readonly mcpToolApprovals?: Readonly<Record<string, readonly string[]>>;
  /** {@link McpToolsetToolObservation} for exactly the projected toolset servers in `mcpServers`. */
  readonly mcpToolsetTools?: McpToolsetToolObservation;
  /**
   * Present only when the adapter declares `approvalInteractive: true`. A
   * request made before `start()` returns waits until the task is active.
   * `start()` must return its Session before awaiting the request's decision.
   */
  readonly approvalChannel?: ApprovalChannel;
  /**
   * Present only for an `auto` task on an adapter declaring
   * `toolAuthorizationAuto`. Every native tool call must pass it before
   * execution; a denial becomes the tool's error result.
   */
  readonly toolAuthorization?: ToolAuthorizationGate;
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

/** Retains runtime-owned session data until runtime disposal succeeds. Release is idempotent. */
export interface RuntimeSessionLease {
  readonly sessionRef: string;
  release(): Promise<void>;
}

/** A pinned provider/runtime decision. `start()` receives resources only, never a raw offer. */
export interface PreparedRuntimeOperation {
  /**
   * Acquire before validating a resume handoff. The caller retains this resource across
   * admission/startup and passes the exact object to start; release only after disposal,
   * or on an offer that never started. Absent when the runtime owns no swept session data.
   */
  acquireSessionLease?(sessionRef: string): Promise<RuntimeSessionLease | undefined>;
  /** Resource phase after workspace resolution and before claim; never reads a credential. */
  resolveRuntimeLaunch?(input: {
    kind: 'instruction' | 'prepared'; cwd: string; env: Readonly<Record<string, string | undefined>>;
    scratch: ExecutionScratch;
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
  /**
   * The environment every child process of this runtime's tasks receives
   * (#1095), built under the adapter's own `RuntimeEnvironmentPolicy`
   * (`buildRuntimeEnvironment`): a fresh `env` and, from the same pass, the
   * `report` of its names and sources that `byok-agent doctor` shows. Rejects
   * with `RuntimeEnvironmentUnavailableError` when that policy has no
   * environment to build from; the daemon then refuses the runtime.
   */
  runtimeEnvironment(): Promise<RuntimeEnvironment>;
}

/** Copy then deeply freeze descriptor authority so callers cannot retain a mutable source reference. */
export function freezeRuntimeAdapterDescriptor(descriptor: RuntimeAdapterDescriptor): RuntimeAdapterDescriptor {
  return Object.freeze({
    id: descriptor.id,
    supportsDispatchSelection: descriptor.supportsDispatchSelection === true,
    requiresMcpToolsetToolObservation: descriptor.requiresMcpToolsetToolObservation === true,
    ...(descriptor.mcpToolApprovals === true ? { mcpToolApprovals: true } : {}),
    ...(descriptor.progressEventsAreMessages === true ? { progressEventsAreMessages: true } : {}),
    ...(descriptor.trajectoryEvidence === 'event-stream' ? { trajectoryEvidence: 'event-stream' as const } : {}),
    ...(descriptor.platforms === undefined ? {} : { platforms: Object.freeze([...descriptor.platforms]) }),
    ...(descriptor.versionPolicy === undefined ? {} : { versionPolicy: freezeRuntimeVersionPolicy(descriptor.versionPolicy) }),
    capabilities: Object.freeze({
      ...(descriptor.capabilities.toolAuthorizationAuto === undefined ? {} : { toolAuthorizationAuto: descriptor.capabilities.toolAuthorizationAuto === true }),
      ...(descriptor.capabilities.durablePi === undefined ? {} : { durablePi: descriptor.capabilities.durablePi === true }),
      ...(descriptor.capabilities.preparedLane === undefined ? {} : { preparedLane: descriptor.capabilities.preparedLane === true }),
      ...(descriptor.capabilities.isolation === undefined ? {} : {
        isolation: Object.freeze({
          userContext: descriptor.capabilities.isolation.userContext === true,
          userMcpServers: descriptor.capabilities.isolation.userMcpServers === true,
          sessionPersistence: descriptor.capabilities.isolation.sessionPersistence === true,
        }),
      }),
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
      ...(descriptor.capabilities.messageDraft === undefined ? {} : { messageDraft: descriptor.capabilities.messageDraft === true }),
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
        }) as RuntimeTaskInput['dispatchSelection']
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
    ...(manifest.homeAccess === undefined ? {} : { homeAccess: manifest.homeAccess }),
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
