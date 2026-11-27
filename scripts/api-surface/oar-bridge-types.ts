import type { OarStartErrorClasses } from '../../packages/client/src/adapters/runtime-start-failure';
type ErrorExports<M> = Extract<keyof M, `${string}Error`>;
// Check source types across the private JS/declaration boundary.
// The bridge exposes a smaller surface than the full OAR adapter.
import type * as Bridge from '../../packages/client/src/runtime/codex-session-runtime.js';
import type { codexSession as vendorSession, CodexAdapterSession } from '../../packages/client/vendor/oar/223703d/runtimes/codex/session.js';
import type { ControlResult, RawEvent } from '../../packages/client/vendor/oar/223703d/contracts/session.js';
import type { AppServerClient, LineProcess, SpawnLineProcess } from '../../packages/client/vendor/oar/223703d/runtimes/codex/app-server-client.js';
import type { spawnOwnedLineProcess } from '../../packages/client/src/runtime/owned-line-process.js';
import type { buildRuntimeEnvironment } from '../../packages/client/src/runtime/environment.js';
import type { CodexProjection, CodexRecord } from '../../packages/client/src/adapters/codex/projection.js';
import type { SessionNotFoundError as VendorSessionNotFoundError } from '../../packages/client/vendor/oar/223703d/contracts/session-not-found-error.js';
import type { SessionUnavailableError as VendorSessionUnavailableError } from '../../packages/client/vendor/oar/223703d/contracts/session-unavailable-error.js';
import type * as TreeBridge from '../../packages/client/src/runtime/oar-process-tree.js';
import type * as VendorTree from '../../packages/client/vendor/oar/223703d/shared/executable/process-tree.js';

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
    : false;
type Assignable<A, B> = [A] extends [B] ? true : false;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Flatten<T> = { [K in keyof T]: T[K] };
type Field<T, K extends PropertyKey> = T extends unknown ? K extends keyof T ? T[K] : never : never;
type WidenString<T> = T extends string ? string : T;
type VendorArgs = Parameters<typeof vendorSession>;
type BridgeArgs = Parameters<typeof Bridge.codexSession>;

// Keep the executable-only input and the explicit env requirement.
type Executable = Extract<VendorArgs[1], { via: 'executable' }>;
type BridgeInstallation = Mutable<Pick<Executable, 'kind' | 'via' | 'command'>>;
type BridgeOptions = Mutable<
  Pick<VendorArgs[2], 'cwd' | 'resume' | 'model' | 'effort' | 'approvalPolicy' | 'sandboxMode' | 'launchArgs' | 'mcpServers' | 'endTurnProcessesOnAbort'> & Required<Pick<VendorArgs[2], 'env' | 'retainedBytes'>>
>;
type VendorHooks = NonNullable<VendorArgs[4]>;
type BridgeHooks = Mutable<Omit<VendorHooks, 'onRecord'>> & {
  onRecord?: (record: CodexRecord) => void;
};

// The control view omits record metadata and widens string discriminators.
// Numeric and null exit codes must still come from the vendor response union.
type ResponseBody = ControlResult['response']['body'];
type BridgeControl = {
  response: { body: {
    kind: WidenString<ResponseBody['kind']>;
    code?: WidenString<Field<ResponseBody, 'code'>>;
    reason?: Field<ResponseBody, 'reason'>;
  } };
};
// The agy adapter reads OAR's class on a refusal (input_too_large past the input bound).
type AcpBridgeControl = {
  response: { body: {
    kind: WidenString<ResponseBody['kind']>;
    code?: WidenString<Field<ResponseBody, 'code'>>;
    reason?: Field<ResponseBody, 'reason'>;
    failure?: WidenString<Field<ResponseBody, 'failure'>>;
  } };
};
type BridgeRecord = Pick<RawEvent, 'seq' | 'sessionId' | 'agentPath'> & {
  readonly kind: WidenString<RawEvent['kind']>;
  readonly body: unknown;
};
type BridgeInput<T extends (...args: never[]) => unknown> = [input: Parameters<T>[0], options?: Pick<NonNullable<Parameters<T>[1]>, 'inputId' | 'images'>];
import type { RuntimeInputOptions } from '../../packages/client/src/types.js';
export type CheckInputOptions = Assert<Equal<RuntimeInputOptions, NonNullable<BridgeInput<AdapterSession['prompt']>[1]>>>;
type BridgeSession = {
  readonly capabilities: Pick<AdapterSession['capabilities'], 'images'>;
  readonly id: CodexAdapterSession['id'];
  prompt(...args: BridgeInput<CodexAdapterSession['prompt']>): Promise<Bridge.CodexControl>;
  steer(...args: BridgeInput<CodexAdapterSession['steer']>): Promise<Bridge.CodexControl>;
  queue(...args: BridgeInput<CodexAdapterSession['queue']>): Promise<Bridge.CodexControl>;
  abort(...args: Parameters<CodexAdapterSession['abort']>): Promise<Bridge.CodexControl>;
  records(): readonly CodexRecord[];
  dispose: CodexAdapterSession['dispose'];
};

// Exact checks catch removed members, extra members, and wider local types.
// Named aliases identify the failed seam in compiler output.
export type CheckFunctionExports = Assert<Equal<keyof typeof Bridge, 'codexSession' | 'codexSessionCapabilities' | 'startAppServerClient' | keyof OarStartErrorClasses>>;
export type CheckAppServerClient = Assert<Assignable<AppServerClient, ReturnType<typeof Bridge.startAppServerClient>>>;
export type CheckNotFoundInstance = Assert<Equal<Bridge.SessionNotFoundError, VendorSessionNotFoundError>>;
export type CheckNotFoundConstructor = Assert<Equal<
  ConstructorParameters<typeof Bridge.SessionNotFoundError>,
  ConstructorParameters<typeof VendorSessionNotFoundError>
>>;
export type CheckInstallation = Assert<Equal<BridgeArgs[1], BridgeInstallation>>;
export type CheckOptions = Assert<Equal<BridgeArgs[2], BridgeOptions>>;
export type CheckTimeout = Assert<Equal<BridgeArgs[3], VendorArgs[3]>>;
export type CheckHooks = Assert<Equal<Mutable<NonNullable<BridgeArgs[4]>>, Mutable<BridgeHooks>>>;
export type CheckParameters = Assert<Equal<BridgeArgs, [
  spawn: typeof spawnOwnedLineProcess,
  installation: BridgeInstallation,
  options: BridgeOptions,
  timeout?: VendorArgs[3],
  hooks?: Mutable<BridgeHooks>,
]>>;
export type CheckControl = Assert<Equal<Bridge.CodexControl, BridgeControl>>;
export type CheckRecord = Assert<Equal<CodexRecord, Flatten<BridgeRecord>>>;
export type CheckSession = Assert<Equal<Bridge.RawCodexSession, BridgeSession>>;
// Name each intentional omission so new vendor members fail this check.
// 'compact' (OAR 0.86 manual compaction) is omitted on purpose: exposing it is a separate product decision.
// 'nativeSessionFile' and 'lastModelRequest' (OAR 0.128 optional members) are omitted: the fork wires neither and the SDK exposes neither.
// 'answerQuestion' (OAR 0.136 host user questions) is omitted: native questions stay on the caller-owned request hooks.
export type CheckSessionMembers = Assert<Equal<
  Exclude<keyof CodexAdapterSession, 'goal' | 'withdraw' | 'rawEvents' | 'graph' | 'resources' | 'contextBreakdown' | 'compact' | 'stopTask' | 'nativeSessionFile' | 'lastModelRequest' | 'answerQuestion'>,
  keyof Bridge.RawCodexSession
>>;
export type CheckReturn = Assert<Equal<ReturnType<typeof Bridge.codexSession>, Promise<Bridge.RawCodexSession>>>;
export type CheckVendorReturn = Assert<Equal<ReturnType<typeof vendorSession>, Promise<CodexAdapterSession>>>;
export type CheckVendorFunction = Assert<Assignable<typeof vendorSession, typeof Bridge.codexSession>>;
export type CheckVendorSession = Assert<Assignable<CodexAdapterSession, Bridge.RawCodexSession>>;
export type CheckPromptControl = Assert<Equal<Awaited<ReturnType<CodexAdapterSession['prompt']>>, ControlResult>>;
export type CheckSteerControl = Assert<Equal<Awaited<ReturnType<CodexAdapterSession['steer']>>, ControlResult>>;
export type CheckAbortControl = Assert<Equal<Awaited<ReturnType<CodexAdapterSession['abort']>>, ControlResult>>;
export type CheckVendorRecords = Assert<Equal<ReturnType<CodexAdapterSession['records']>, readonly RawEvent[]>>;
export type CheckVendorHook = Assert<Equal<NonNullable<VendorHooks['onRecord']>, (record: RawEvent) => void>>;

// Check the real transport, env producer, and record consumer too.
export type CheckSpawnParameters = Assert<Assignable<typeof spawnOwnedLineProcess, SpawnLineProcess>>;
export type CheckVendorSpawnParameter = Assert<Equal<VendorArgs[0], SpawnLineProcess>>;
export type CheckSpawn = Assert<Assignable<typeof spawnOwnedLineProcess, SpawnLineProcess>>;
export type CheckLineProcess = Assert<Equal<
  Mutable<Pick<ReturnType<typeof spawnOwnedLineProcess>, Exclude<keyof LineProcess, 'exitError'>>>,
  Mutable<Omit<LineProcess, 'exitError'>>
>>;
export type CheckExitError = Assert<Equal<
  ReturnType<ReturnType<typeof spawnOwnedLineProcess>['exitError']>,
  ReturnType<NonNullable<LineProcess['exitError']>>
>>;
export type CheckEnv = Assert<Equal<Readonly<Awaited<ReturnType<typeof buildRuntimeEnvironment>>['env']>, BridgeArgs[2]['env']>>;
export type CheckVendorEnv = Assert<Assignable<Awaited<ReturnType<typeof buildRuntimeEnvironment>>['env'], VendorArgs[2]['env']>>;
export type CheckProjectionRecord = Assert<Equal<Parameters<CodexProjection['consume']>[1], CodexRecord>>;
export type CheckProjectionInput = Assert<Assignable<RawEvent, Parameters<CodexProjection['consume']>[1]>>;
export type CheckHookRecord = Assert<Assignable<RawEvent, Parameters<NonNullable<NonNullable<BridgeArgs[4]>['onRecord']>>[0]>>;

// The process-tree bridge re-exports the vendored OAR functions with their exact types.
import type * as VendorPipes from '../../packages/client/vendor/oar/223703d/shared/executable/pipe-close.js';
import type * as VendorQuery from '../../packages/client/vendor/oar/223703d/shared/executable/query.js';
export type CheckTreeExports = Assert<Equal<keyof typeof TreeBridge, 'descendantsOf' | 'killEntries' | 'observeProcessTable' | 'parseProcessPs' | 'readProcessTable' | 'PIPE_CLOSE_MS' | 'closePipesAfterExit' | 'withQueryDeadline'>>;
export type CheckTreeVendorExports = Assert<Equal<Exclude<keyof typeof VendorTree, 'ProcessEntry' | 'ProcessTable' | 'ProcessTableRead' | 'ProcessTableSource' | 'ProcessTableFailureReason' | 'ProcessTableFailure' | 'ProcessTableObservation' | 'InvalidProcessTableError' | 'parseProcessStat' | 'parseProcessWindows' | 'processTableFailure' | 'signalEntries'>, Exclude<keyof typeof TreeBridge, 'PIPE_CLOSE_MS' | 'closePipesAfterExit' | 'withQueryDeadline'>>>;
export type CheckPipeDeadline = Assert<Equal<typeof TreeBridge.PIPE_CLOSE_MS, typeof VendorPipes.PIPE_CLOSE_MS>>;
export type CheckPipeClose = Assert<Assignable<typeof VendorPipes.closePipesAfterExit, typeof TreeBridge.closePipesAfterExit>>;
export type CheckQueryDeadline = Assert<Equal<typeof TreeBridge.withQueryDeadline, typeof VendorQuery.withQueryDeadline>>;
export type CheckTreeEntry = Assert<Equal<TreeBridge.ProcessEntry, VendorTree.ProcessEntry>>;
export type CheckTreeTable = Assert<Equal<TreeBridge.ProcessTable, VendorTree.ProcessTable>>;
export type CheckTreeRead = Assert<Equal<typeof TreeBridge.readProcessTable, typeof VendorTree.readProcessTable>>;
export type CheckTreeObservation = Assert<Equal<TreeBridge.ProcessTableObservation, VendorTree.ProcessTableObservation>>;
export type CheckTreeFailure = Assert<Equal<TreeBridge.ProcessTableFailure, VendorTree.ProcessTableFailure>>;
export type CheckTreeFailureReason = Assert<Equal<TreeBridge.ProcessTableFailureReason, VendorTree.ProcessTableFailureReason>>;
export type CheckTreeObserve = Assert<Equal<typeof TreeBridge.observeProcessTable, typeof VendorTree.observeProcessTable>>;
export type CheckTreeWalk = Assert<Equal<typeof TreeBridge.descendantsOf, typeof VendorTree.descendantsOf>>;
export type CheckTreeKill = Assert<Equal<typeof TreeBridge.killEntries, typeof VendorTree.killEntries>>;
export type CheckTreeParsePs = Assert<Equal<typeof TreeBridge.parseProcessPs, typeof VendorTree.parseProcessPs>>;

// The ACP bridge: one start signature for every vendored ACP runtime, with
// the SDK-owned agent process, terminal processes and explicit environment.
import type * as AcpBridge from '../../packages/client/src/runtime/acp-session-runtime.js';
import type { StartAcpSession as VendorStartAcp, AcpSessionOptions, AcpSessionHooks } from '../../packages/client/vendor/oar/223703d/shared/acp/session.js';
import type { SpawnAcpLineProcess } from '../../packages/client/vendor/oar/223703d/shared/acp/process.js';
import type { AcpError as VendorAcpError } from '../../packages/client/vendor/oar/223703d/shared/acp/errors.js';
import type { SpawnAcpTerminal } from '../../packages/client/vendor/oar/223703d/shared/acp/terminal.js';
import type { AdapterSession } from '../../packages/client/vendor/oar/223703d/contracts/session.js';
import type { RuntimeFailureError as VendorRuntimeFailureError } from '../../packages/client/vendor/oar/223703d/contracts/runtime-failure-error.js';
import type { UnsupportedOptionError as VendorUnsupportedOptionError } from '../../packages/client/vendor/oar/223703d/contracts/errors.js';
import type { ModelConfirmationError as VendorModelConfirmationError } from '../../packages/client/vendor/oar/223703d/contracts/model-confirmation-error.js';
import type { spawnOwnedTerminalProcess } from '../../packages/client/src/runtime/owned-terminal-process.js';
import type { grokSession as vendorGrokSession } from '../../packages/client/vendor/oar/223703d/runtimes/grok/session.js';
import type { antigravitySession as vendorAntigravitySession } from '../../packages/client/vendor/oar/223703d/runtimes/antigravity/session.js';

type AcpBridgeArgs = Parameters<AcpBridge.StartAcpSession>;
type AcpBridgeOptions = Mutable<
  Pick<AcpSessionOptions, 'cwd' | 'env' | 'resume' | 'model' | 'effort' | 'appendSystemPrompt' | 'launchArgs' | 'mcpServers'> & Required<Pick<AcpSessionOptions, 'retainedBytes'>>
>;
type AcpBridgeHooks = Mutable<Omit<AcpSessionHooks, 'onRecord' | 'onPermission'>> & {
  onRecord?: (record: AcpBridge.AcpRecord) => void;
  onPermission?: (request: AcpBridge.AcpPermissionRequest) => AcpBridge.AcpPermissionResponse;
};

type AcpBridgeSession = {
  readonly capabilities: Pick<AdapterSession['capabilities'], 'images'>;
  readonly id: AdapterSession['id'];
  prompt(...args: BridgeInput<AdapterSession['prompt']>): Promise<AcpBridge.AcpControl>;
  queue(...args: BridgeInput<AdapterSession['queue']>): Promise<AcpBridge.AcpControl>;
  withdraw?(...args: Parameters<NonNullable<AdapterSession['withdraw']>>): Promise<AcpBridge.AcpControl>;
  steer?(...args: BridgeInput<NonNullable<AdapterSession['steer']>>): Promise<AcpBridge.AcpControl>;
  abort(...args: Parameters<AdapterSession['abort']>): Promise<AcpBridge.AcpControl>;
  records(): readonly AcpBridge.AcpRecord[];
  dispose: AdapterSession['dispose'];
};

export type CheckAcpExports = Assert<Equal<keyof typeof AcpBridge, keyof OarStartErrorClasses | 'AcpError' | 'grokSession' | 'antigravitySession' | 'opencodeSession' | 'grokSessionCapabilities' | 'antigravitySessionCapabilities' | 'opencodeSessionCapabilities' | 'grokListModels' | 'grokAccountUsage' | 'antigravityListModels'>>;
export type CheckAcpRuntimeFailure = Assert<Assignable<VendorRuntimeFailureError, AcpBridge.RuntimeFailureError>>;
export type CheckAcpRuntimeFailureFields = Assert<Equal<Pick<VendorRuntimeFailureError, 'name'>, Pick<AcpBridge.RuntimeFailureError, 'name'>>>;
export type CheckAcpUnsupportedOption = Assert<Assignable<VendorUnsupportedOptionError, AcpBridge.UnsupportedOptionError>>;
export type CheckAcpUnsupportedOptionName = Assert<Equal<Pick<VendorUnsupportedOptionError, 'name'>, Pick<AcpBridge.UnsupportedOptionError, 'name'>>>;
export type CheckGrokVendor = Assert<Equal<typeof vendorGrokSession, VendorStartAcp>>;
export type CheckGrokBridge = Assert<Equal<typeof AcpBridge.grokSession, AcpBridge.StartAcpSession>>;
export type CheckAntigravityVendor = Assert<Equal<typeof vendorAntigravitySession, VendorStartAcp>>;
export type CheckAntigravityBridge = Assert<Equal<typeof AcpBridge.antigravitySession, AcpBridge.StartAcpSession>>;
export type CheckAcpNotFound = Assert<Equal<AcpBridge.SessionNotFoundError, VendorSessionNotFoundError>>;
export type CheckAcpNotFoundConstructor = Assert<Equal<
  ConstructorParameters<typeof AcpBridge.SessionNotFoundError>,
  ConstructorParameters<typeof VendorSessionNotFoundError>
>>;
export type CheckAcpControl = Assert<Equal<AcpBridge.AcpControl, AcpBridgeControl>>;
export type CheckAcpRecord = Assert<Equal<AcpBridge.AcpRecord, Flatten<BridgeRecord>>>;
export type CheckAcpSession = Assert<Equal<AcpBridge.RawAcpSession, AcpBridgeSession>>;
// Name each intentional omission so new vendor members fail this check.
// 'compact' (OAR 0.86 generic contract) is omitted on purpose, as for Codex.
export type CheckAcpSessionMembers = Assert<Equal<
  Exclude<keyof AdapterSession, 'goal' | 'rawEvents' | 'graph' | 'resources' | 'contextBreakdown' | 'compact' | 'stopTask' | 'nativeSessionFile' | 'lastModelRequest' | 'answerQuestion'>,
  keyof AcpBridge.RawAcpSession
>>;
export type CheckAcpPermissionHook = Assert<Assignable<NonNullable<AcpBridgeHooks['onPermission']>, NonNullable<AcpSessionHooks['onPermission']>>>;
export type CheckAcpVendorSession = Assert<Assignable<AdapterSession, AcpBridge.RawAcpSession>>;
export type CheckAcpParameters = Assert<Equal<AcpBridgeArgs, [
  spawn: typeof spawnOwnedLineProcess,
  spawnTerminal: typeof spawnOwnedTerminalProcess,
  installation: Mutable<Pick<Executable, 'kind' | 'via' | 'command' | 'version'>>,
  options: AcpBridgeOptions,
  hooks?: Mutable<AcpBridgeHooks>,
]>>;
export type CheckAcpReturn = Assert<Equal<ReturnType<AcpBridge.StartAcpSession>, Promise<AcpBridge.RawAcpSession>>>;
export type CheckAcpVendorStart = Assert<Assignable<VendorStartAcp, AcpBridge.StartAcpSession>>;
export type CheckAcpVendorHook = Assert<Equal<NonNullable<AcpSessionHooks['onRecord']>, (record: RawEvent) => void>>;
export type CheckAcpHookRecord = Assert<Assignable<RawEvent, AcpBridge.AcpRecord>>;
// The real SDK transports fit the vendor seams.
export type CheckAcpSpawn = Assert<Assignable<typeof spawnOwnedLineProcess, SpawnAcpLineProcess>>;
export type CheckAcpTerminalSpawn = Assert<Assignable<typeof spawnOwnedTerminalProcess, SpawnAcpTerminal>>;
export type CheckAcpEnv = Assert<Equal<Readonly<Awaited<ReturnType<typeof buildRuntimeEnvironment>>['env']>, AcpBridgeArgs[3]['env']>>;

// The failure bridge mirrors OAR. The SDK normalizes vendor classes at the wire boundary.
import type * as FailureBridge from '../../packages/client/src/runtime/oar-failure-runtime.js';
import type { failureFromStatus as vendorFailureFromStatus } from '../../packages/client/vendor/oar/223703d/shared/failure-class.js';
import type { FailureClass } from '../../packages/client/vendor/oar/223703d/contracts/failure.js';
import type { RuntimeFailureClass } from '../../packages/protocol/src/messages.js';

export type CheckRuntimeFailureClass = Assert<Equal<RuntimeFailureClass, Exclude<FailureClass, 'model_refused'>>>;
export type CheckFailureBridgeClass = Assert<Equal<FailureBridge.OarFailureClass, FailureClass>>;
export type CheckFailureExports = Assert<Equal<keyof typeof FailureBridge, 'failureFromStatus'>>;
export type CheckFailureFromStatus = Assert<Equal<typeof FailureBridge.failureFromStatus, typeof vendorFailureFromStatus>>;

// The dsh bridge: the vendored native runtime, narrowed to what the SDK calls.
// 'withdraw' is omitted on purpose, as for Codex. The runtime reports steer; the vendored session always returns it for the qualified dsh.
import type * as DshBridge from '../../packages/client/src/runtime/dsh-session-runtime.js';
import type { dshSession as vendorDshSession, DshSessionHooks } from '../../packages/client/vendor/oar/223703d/runtimes/dsh/session.js';
import type { dshMcpConfigs as vendorDshMcpConfigs } from '../../packages/client/vendor/oar/223703d/runtimes/dsh/mcp.js';
import type { DshLineProcess } from '../../packages/client/vendor/oar/223703d/runtimes/dsh/launch.js';

type VendorDshArgs = Parameters<typeof vendorDshSession>;
type DshBridgeArgs = Parameters<typeof DshBridge.dshSession>;
type DshBridgeOptions = { cwd: string; model: string; effort?: string; resume?: string; mcpServers?: VendorDshArgs[2]['mcpServers']; launch: { directory: string; patches: readonly string[]; env: Readonly<Record<string, string>> }; retainedBytes: number; sessionLogUpload: 'off'; appendSystemPrompt?: string };
type DshVendorSession = Awaited<ReturnType<typeof vendorDshSession>>;
type DshBridgeSession = {
  readonly capabilities: Pick<AdapterSession['capabilities'], 'images'>;
  readonly id: AdapterSession['id'];
  prompt(...args: BridgeInput<AdapterSession['prompt']>): Promise<DshBridge.DshControl>;
  steer(...args: BridgeInput<DshVendorSession['steer']>): Promise<DshBridge.DshControl>;
  queue(...args: BridgeInput<DshVendorSession['queue']>): Promise<DshBridge.DshControl>;
  abort(...args: Parameters<AdapterSession['abort']>): Promise<DshBridge.DshControl>;
  records(): readonly DshBridge.DshRecord[];
  dispose: AdapterSession['dispose'];
};
export type CheckDshExports = Assert<Equal<keyof typeof DshBridge, 'dshSession' | 'dshSessionCapabilities' | 'dshMcpConfigs' | keyof OarStartErrorClasses>>;
export type CheckDshMcpConfigs = Assert<Equal<typeof DshBridge.dshMcpConfigs, typeof vendorDshMcpConfigs>>;
export type CheckDshOptions = Assert<Equal<Mutable<DshBridgeArgs[2]>, DshBridgeOptions>>;
export type CheckDshVendorOptions = Assert<Assignable<DshBridgeArgs[2], VendorDshArgs[2]>>;
type DshPrivateHookKeys = 'credentialsForRedaction' | 'onRouteMismatch' | 'signal';
export type CheckDshHooks = Assert<Equal<Pick<NonNullable<DshHooksFromBridge>, DshPrivateHookKeys>, Pick<DshSessionHooks, DshPrivateHookKeys>>>;
export type CheckDshVendorHooks = Assert<Assignable<DshHooksFromBridge, Partial<Mutable<DshSessionHooks>> | undefined>>;
type DshHooksFromBridge = DshBridgeArgs[3];
export type CheckDshControl = Assert<Equal<DshBridge.DshControl, BridgeControl>>;
export type CheckDshRecord = Assert<Equal<DshBridge.DshRecord, Flatten<BridgeRecord>>>;
export type CheckDshSession = Assert<Equal<DshBridge.RawDshSession, DshBridgeSession>>;
export type CheckDshSessionMembers = Assert<Equal<
  Exclude<keyof DshVendorSession, 'goal' | 'withdraw' | 'rawEvents' | 'graph' | 'resources' | 'contextBreakdown' | 'compact' | 'stopTask' | 'nativeSessionFile' | 'lastModelRequest' | 'answerQuestion'>,
  keyof DshBridge.RawDshSession
>>;
export type CheckDshVendorSession = Assert<Assignable<DshVendorSession, DshBridge.RawDshSession>>;
export type CheckDshSpawn = Assert<Assignable<ReturnType<typeof spawnOwnedLineProcess>, DshLineProcess>>;
export type CheckDshNotFound = Assert<Equal<DshBridge.SessionNotFoundError, VendorSessionNotFoundError>>;

import type { opencodeSession as vendorOpenCodeSession } from '../../packages/client/vendor/oar/223703d/runtimes/opencode/session.js';
export type CheckOpenCodeVendor = Assert<Equal<typeof vendorOpenCodeSession, VendorStartAcp>>;
export type CheckOpenCodeBridge = Assert<Equal<typeof AcpBridge.opencodeSession, AcpBridge.StartAcpSession>>;

export type CheckCodexUnavailable = Assert<Equal<Bridge.SessionUnavailableError, VendorSessionUnavailableError>>;
export type CheckAcpUnavailable = Assert<Equal<AcpBridge.SessionUnavailableError, VendorSessionUnavailableError>>;
export type CheckDshUnavailable = Assert<Equal<DshBridge.SessionUnavailableError, VendorSessionUnavailableError>>;
export type CheckCodexRuntimeFailure = Assert<Equal<Bridge.RuntimeFailureError, VendorRuntimeFailureError>>;
export type CheckCodexUnsupportedOption = Assert<Equal<Bridge.UnsupportedOptionError, VendorUnsupportedOptionError>>;
export type CheckCodexStartErrors = Assert<Equal<ErrorExports<typeof Bridge>, keyof OarStartErrorClasses>>;
export type CheckAcpStartErrors = Assert<Equal<ErrorExports<typeof AcpBridge>, keyof OarStartErrorClasses | 'AcpError'>>;
export type CheckAcpTransportError = Assert<Equal<AcpBridge.AcpError, VendorAcpError>>;
export type CheckDshStartErrors = Assert<Equal<ErrorExports<typeof DshBridge>, keyof OarStartErrorClasses>>;
export type CheckCodexModelConfirmation = Assert<Equal<Bridge.ModelConfirmationError, VendorModelConfirmationError>>;
export type CheckAcpModelConfirmation = Assert<Equal<AcpBridge.ModelConfirmationError, VendorModelConfirmationError>>;
export type CheckDshModelConfirmation = Assert<Equal<DshBridge.ModelConfirmationError, VendorModelConfirmationError>>;

// The Claude bridge: the vendored stream-json session and the Claude projection
// profile. The adapter assembles the session profile; the fold stays opaque.
import type * as ClaudeBridge from '../../packages/client/src/runtime/claude-session-runtime.js';
import type { ClaudeStreamSessionOptions } from '../../packages/client/src/adapters/claude/stream-session.js';
export type CheckClaudeEffort = Assert<Equal<Pick<ClaudeStreamSessionOptions, 'effort'>, Mutable<Pick<VendorArgs[2], 'effort'>>>>;
import type { streamJsonSession as vendorStreamJsonSession, StreamJsonSessionHooks } from '../../packages/client/vendor/oar/223703d/shared/stream-json/session.js';
import type { StreamJsonSessionProfile } from '../../packages/client/vendor/oar/223703d/shared/stream-json/profile.js';
import type { claudeProjectionProfile as vendorClaudeProfile, ClaudeProjectionState as VendorClaudeState } from '../../packages/client/vendor/oar/223703d/runtimes/claude/projection.js';
import type { sessionCredentialRedactor as vendorRedactor, CredentialRedactor } from '../../packages/client/vendor/oar/223703d/shared/credential-redactor.js';

type ClaudeVendorArgs = Parameters<typeof vendorStreamJsonSession<VendorClaudeState>>;
type ClaudeVendorProfile = StreamJsonSessionProfile<VendorClaudeState>;
type ClaudeBridgeArgs = Parameters<typeof ClaudeBridge.streamJsonSession>;
type ClaudeVendorSession = Awaited<ReturnType<typeof vendorStreamJsonSession>>;
type ClaudeBridgeSession = {
  readonly capabilities: Pick<AdapterSession['capabilities'], 'images'>;
  readonly id: AdapterSession['id'];
  prompt(...args: BridgeInput<AdapterSession['prompt']>): Promise<ClaudeBridge.ClaudeControl>;
  queue(...args: BridgeInput<AdapterSession['queue']>): Promise<ClaudeBridge.ClaudeControl>;
  withdraw?(...args: Parameters<NonNullable<AdapterSession['withdraw']>>): Promise<ClaudeBridge.ClaudeControl>;
  abort(...args: Parameters<AdapterSession['abort']>): Promise<ClaudeBridge.ClaudeControl>;
  records(): readonly ClaudeBridge.ClaudeRecord[];
  dispose: AdapterSession['dispose'];
};
type ClaudeSharedProfileKeys = 'capabilities' | 'steer' | 'consume' | 'open' | 'exited' | 'disposing';
export type CheckClaudeExports = Assert<Equal<keyof typeof ClaudeBridge,
  'streamJsonSession' | 'claudeSessionCapabilities' | 'claudeProjectionProfile' | 'initialClaudeProjection' | 'resumedClaudeProjection' | 'sessionCredentialRedactor'>>;
export type CheckClaudeControl = Assert<Equal<ClaudeBridge.ClaudeControl, BridgeControl>>;
export type CheckClaudeRecord = Assert<Equal<ClaudeBridge.ClaudeRecord, Flatten<BridgeRecord>>>;
export type CheckClaudeSession = Assert<Equal<ClaudeBridge.RawClaudeSession, ClaudeBridgeSession>>;
export type CheckClaudeVendorSession = Assert<Assignable<ClaudeVendorSession, ClaudeBridge.RawClaudeSession>>;
export type CheckClaudeSpawn = Assert<Assignable<ClaudeBridgeArgs[0], ClaudeVendorArgs[0]>>;
export type CheckClaudeRedactor = Assert<Equal<ClaudeBridge.ClaudeCredentialRedactor, CredentialRedactor>>;
export type CheckClaudeRedactorFactory = Assert<Assignable<Parameters<typeof ClaudeBridge.sessionCredentialRedactor>[0], Parameters<typeof vendorRedactor>[0]>>;
export type CheckClaudeProfileValue = Assert<Assignable<typeof vendorClaudeProfile, ClaudeBridge.ClaudeProjectionProfile>>;
export type CheckClaudeStateValue = Assert<Assignable<VendorClaudeState, ClaudeBridge.ClaudeProjectionState>>;
export type CheckClaudeProfile = Assert<Assignable<Pick<ClaudeBridge.ClaudeSessionProfile, ClaudeSharedProfileKeys>, Pick<ClaudeVendorProfile, ClaudeSharedProfileKeys>>>;
export type CheckClaudeHooks = Assert<Assignable<ClaudeBridge.ClaudeSessionHooks, Partial<Mutable<StreamJsonSessionHooks>>>>;
export type CheckClaudeRetention = Assert<Equal<ClaudeBridgeArgs[5], ClaudeVendorArgs[5]>>;

// 'Runtime.minVersion' (OAR 0.110 runtime contract) is omitted on purpose: no bridge exports an OAR Runtime
// (runtimes/*/index.ts is not selected), and each SDK adapter's RuntimeVersionPolicy owns its version gate.
// The check fails when the vendored member changes or goes away, so the omission is revisited then.
import type { Runtime as VendorRuntime } from '../../packages/client/vendor/oar/223703d/contracts/runtime.js';
export type CheckRuntimeMinVersionOmitted = Assert<Equal<VendorRuntime['minVersion'], string | undefined>>;
// The pre-open declaration is intentionally deferred until the SDK consumes it.
export type CheckRuntimeSessionCapabilitiesOmitted = Assert<Equal<VendorRuntime['sessionCapabilities'], ((installation: import('../../packages/client/vendor/oar/223703d/contracts/installation.js').AvailableInstallation) => import('../../packages/client/vendor/oar/223703d/contracts/runtime.js').SessionCapabilityDeclaration) | undefined>>;

// The SDK supplies both the filtered environment and every reader transport.
import type * as Readers from '../../packages/client/src/runtime/oar-readers.js';
import type * as VersionFloors from '../../packages/client/src/runtime/oar-version-floors.js';
import type { OwnedReaderOptions as SdkReaderOptions } from '../../packages/client/src/runtime/oar-reader-contract.js';
import type { OwnedReaderOptions as VendorReaderOptions, ListModelsResult } from '../../packages/client/vendor/oar/223703d/contracts/list-models.js';
import type { AccountUsageSnapshot } from '../../packages/client/vendor/oar/223703d/contracts/account-usage.js';
import type { RuntimeAccountUsage, RuntimeModelCatalog } from '../../packages/client/src/runtime/runtime-reader-types.js';
import type { codexListModels as V_codexListModels } from '../../packages/client/vendor/oar/223703d/runtimes/codex/list-models.js';
export type Check_codexListModels = Assert<Assignable<typeof V_codexListModels, typeof Readers.codexListModels>>;
import type { codexAccountUsage as V_codexAccountUsage } from '../../packages/client/vendor/oar/223703d/runtimes/codex/account-usage.js';
export type Check_codexAccountUsage = Assert<Assignable<typeof V_codexAccountUsage, typeof Readers.codexAccountUsage>>;
import type { claudeListModels as V_claudeListModels } from '../../packages/client/vendor/oar/223703d/runtimes/claude/list-models.js';
export type Check_claudeListModels = Assert<Assignable<typeof V_claudeListModels, typeof Readers.claudeListModels>>;
import type { claudeAccountUsage as V_claudeAccountUsage } from '../../packages/client/vendor/oar/223703d/runtimes/claude/account-usage.js';
export type Check_claudeAccountUsage = Assert<Assignable<typeof V_claudeAccountUsage, typeof Readers.claudeAccountUsage>>;
import type { dshListModels as V_dshListModels } from '../../packages/client/vendor/oar/223703d/runtimes/dsh/list-models.js';
export type Check_dshListModels = Assert<Assignable<typeof V_dshListModels, typeof Readers.dshListModels>>;
import type { opencodeListModels as V_opencodeListModels } from '../../packages/client/vendor/oar/223703d/runtimes/opencode/list-models.js';
export type Check_opencodeListModels = Assert<Assignable<typeof V_opencodeListModels, typeof Readers.opencodeListModels>>;
import type { antigravityAccountUsage as V_antigravityAccountUsage } from '../../packages/client/vendor/oar/223703d/runtimes/antigravity/account-usage.js';
export type Check_antigravityAccountUsage = Assert<Assignable<typeof V_antigravityAccountUsage, typeof Readers.antigravityAccountUsage>>;
import type { antigravityVersionRefusal as V_antigravityVersionRefusal } from '../../packages/client/vendor/oar/223703d/runtimes/antigravity/version.js';
export type Check_antigravityVersionRefusal = Assert<Assignable<typeof V_antigravityVersionRefusal, typeof VersionFloors.antigravityVersionRefusal>>;
import type { compareSemver as V_compareSemver } from '../../packages/client/vendor/oar/223703d/shared/semver.js';
import type { dshVersionUnsupported as V_dshVersionUnsupported } from '../../packages/client/vendor/oar/223703d/runtimes/dsh/version.js';
export type Check_compareSemver = Assert<Assignable<typeof V_compareSemver, typeof VersionFloors.compareSemver>>;
export type Check_dshVersionUnsupported = Assert<Assignable<typeof V_dshVersionUnsupported, typeof VersionFloors.dshVersionUnsupported>>;
import type { grokListModels as V_grokListModels } from '../../packages/client/vendor/oar/223703d/runtimes/grok/list-models.js';
import type { grokAccountUsage as V_grokAccountUsage } from '../../packages/client/vendor/oar/223703d/runtimes/grok/account-usage.js';
import type { antigravityListModels as V_antigravityListModels } from '../../packages/client/vendor/oar/223703d/runtimes/antigravity/list-models.js';
export type CheckGrokListModels = Assert<Assignable<typeof V_grokListModels, typeof AcpBridge.grokListModels>>;
export type CheckGrokAccountUsage = Assert<Assignable<typeof V_grokAccountUsage, typeof AcpBridge.grokAccountUsage>>;
export type CheckAntigravityListModels = Assert<Assignable<typeof V_antigravityListModels, typeof AcpBridge.antigravityListModels>>;
export type CheckReaderEnvironment = Assert<Assignable<SdkReaderOptions, VendorReaderOptions>>;
export type CheckModelCatalog = Assert<Equal<RuntimeModelCatalog, ListModelsResult>>;
export type CheckUsageSnapshot = Assert<Assignable<AccountUsageSnapshot, RuntimeAccountUsage>>;
export type CheckUsageKinds = Assert<Equal<AccountUsageSnapshot['kind'], RuntimeAccountUsage['kind']>>;

import type * as VendorSuggestions from '../../packages/client/vendor/oar/223703d/suggested-versions.js';
import type * as Suggestions from '../../packages/client/src/runtime/runtime-releases.js';
export type CheckSuggestedEntry = Assert<Equal<VendorSuggestions.SuggestedVersionEntry, Suggestions.SuggestedRuntimeVersionEntry>>;
export type CheckSuggestedManifest = Assert<Equal<VendorSuggestions.SuggestedVersionsManifest, Suggestions.SuggestedRuntimeVersionsManifest>>;
export type CheckSuggestedAdvice = Assert<Equal<VendorSuggestions.SuggestedVersionAdvice, Suggestions.SuggestedRuntimeVersionAdvice>>;
export type CheckSuggestedSnapshot = Assert<Equal<typeof VendorSuggestions.suggestedVersions, typeof Suggestions.suggestedRuntimeVersions>>;
export type CheckParseSuggested = Assert<Equal<typeof VendorSuggestions.parseSuggestedVersions, typeof Suggestions.parseSuggestedRuntimeVersions>>;
export type CheckCheckSuggested = Assert<Equal<typeof VendorSuggestions.checkSuggestedVersion, typeof Suggestions.checkSuggestedRuntimeVersion>>;
