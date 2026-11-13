import type { OarStartErrorClasses } from '../../packages/client/src/adapters/runtime-start-failure';
type ErrorExports<M> = Extract<keyof M, `${string}Error`>;
// Check source types across the private JS/declaration boundary.
// The bridge exposes a smaller surface than the full OAR adapter.
import type * as Bridge from '../../packages/client/src/runtime/codex-session-runtime.js';
import type { codexSession as vendorSession, CodexAdapterSession } from '../../packages/client/vendor/oar/95c6547/runtimes/codex/session.js';
import type { ControlResult, RawEvent } from '../../packages/client/vendor/oar/95c6547/contracts/session.js';
import type { LineProcess, SpawnLineProcess } from '../../packages/client/vendor/oar/95c6547/runtimes/codex/app-server-client.js';
import type { spawnOwnedLineProcess } from '../../packages/client/src/runtime/owned-line-process.js';
import type { buildRuntimeEnvironment } from '../../packages/client/src/runtime/environment.js';
import type { CodexProjection, CodexRecord } from '../../packages/client/src/adapters/codex/projection.js';
import type { SessionNotFoundError as VendorSessionNotFoundError } from '../../packages/client/vendor/oar/95c6547/contracts/session-not-found-error.js';
import type { SessionUnavailableError as VendorSessionUnavailableError } from '../../packages/client/vendor/oar/95c6547/contracts/session-unavailable-error.js';
import type * as TreeBridge from '../../packages/client/src/runtime/oar-process-tree.js';
import type * as VendorTree from '../../packages/client/vendor/oar/95c6547/shared/executable/process-tree.js';

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
  Pick<VendorArgs[2], 'cwd' | 'resume' | 'model' | 'approvalPolicy' | 'sandboxMode' | 'launchArgs' | 'mcpServers'> & Required<Pick<VendorArgs[2], 'env' | 'retainedBytes'>>
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
type FirstInput<T extends (...args: never[]) => unknown> = [Parameters<T>[0]];
type BridgeSession = {
  readonly id: CodexAdapterSession['id'];
  prompt(...args: FirstInput<CodexAdapterSession['prompt']>): Promise<Bridge.CodexControl>;
  steer(...args: FirstInput<CodexAdapterSession['steer']>): Promise<Bridge.CodexControl>;
  abort(...args: Parameters<CodexAdapterSession['abort']>): Promise<Bridge.CodexControl>;
  records(): readonly CodexRecord[];
  dispose: CodexAdapterSession['dispose'];
};

// Exact checks catch removed members, extra members, and wider local types.
// Named aliases identify the failed seam in compiler output.
export type CheckFunctionExports = Assert<Equal<keyof typeof Bridge, 'codexSession' | keyof OarStartErrorClasses>>;
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
export type CheckSessionMembers = Assert<Equal<
  Exclude<keyof CodexAdapterSession, 'capabilities' | 'goal' | 'queue' | 'withdraw' | 'rawEvents' | 'graph' | 'resources' | 'contextBreakdown' | 'compact' | 'stopTask'>,
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
export type CheckSpawnParameters = Assert<Equal<Parameters<typeof spawnOwnedLineProcess>, Parameters<SpawnLineProcess>>>;
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
export type CheckTreeExports = Assert<Equal<keyof typeof TreeBridge, 'descendantsOf' | 'killEntries' | 'readProcessTable'>>;
export type CheckTreeVendorExports = Assert<Equal<Exclude<keyof typeof VendorTree, 'ProcessEntry' | 'ProcessTable' | 'ProcessTableRead' | 'ProcessTableSource' | 'ProcessTableFailureReason' | 'ProcessTableFailure' | 'ProcessTableObservation' | 'InvalidProcessTableError' | 'parseProcessStat' | 'parseProcessPs' | 'parseProcessWindows' | 'observeProcessTable' | 'processTableFailure' | 'signalEntries'>, keyof typeof TreeBridge>>;
export type CheckTreeEntry = Assert<Equal<TreeBridge.ProcessEntry, VendorTree.ProcessEntry>>;
export type CheckTreeTable = Assert<Equal<TreeBridge.ProcessTable, VendorTree.ProcessTable>>;
export type CheckTreeRead = Assert<Equal<typeof TreeBridge.readProcessTable, typeof VendorTree.readProcessTable>>;
export type CheckTreeWalk = Assert<Equal<typeof TreeBridge.descendantsOf, typeof VendorTree.descendantsOf>>;
export type CheckTreeKill = Assert<Equal<typeof TreeBridge.killEntries, typeof VendorTree.killEntries>>;

// The ACP bridge: one start signature for every vendored ACP runtime, with
// the SDK-owned agent process, terminal processes and explicit environment.
import type * as AcpBridge from '../../packages/client/src/runtime/acp-session-runtime.js';
import type { StartAcpSession as VendorStartAcp, AcpSessionOptions, AcpSessionHooks } from '../../packages/client/vendor/oar/95c6547/shared/acp/session.js';
import type { SpawnAcpLineProcess } from '../../packages/client/vendor/oar/95c6547/shared/acp/process.js';
import type { SpawnAcpTerminal } from '../../packages/client/vendor/oar/95c6547/shared/acp/terminal.js';
import type { AdapterSession } from '../../packages/client/vendor/oar/95c6547/contracts/session.js';
import type { RuntimeFailureError as VendorRuntimeFailureError } from '../../packages/client/vendor/oar/95c6547/contracts/runtime-failure-error.js';
import type { UnsupportedOptionError as VendorUnsupportedOptionError } from '../../packages/client/vendor/oar/95c6547/contracts/errors.js';
import type { spawnOwnedTerminalProcess } from '../../packages/client/src/runtime/owned-terminal-process.js';
import type { grokSession as vendorGrokSession } from '../../packages/client/vendor/oar/95c6547/runtimes/grok/session.js';
import type { antigravitySession as vendorAntigravitySession } from '../../packages/client/vendor/oar/95c6547/runtimes/antigravity/session.js';

type AcpBridgeArgs = Parameters<AcpBridge.StartAcpSession>;
type AcpBridgeOptions = Mutable<
  Pick<AcpSessionOptions, 'cwd' | 'env' | 'resume' | 'model' | 'appendSystemPrompt' | 'launchArgs' | 'mcpServers'> & Required<Pick<AcpSessionOptions, 'retainedBytes'>>
>;
type AcpBridgeHooks = Mutable<Omit<AcpSessionHooks, 'onRecord' | 'onPermission'>> & {
  onRecord?: (record: AcpBridge.AcpRecord) => void;
  onPermission?: (request: AcpBridge.AcpPermissionRequest) => AcpBridge.AcpPermissionResponse;
};
// The input id names a prompt to a runtime with native turns (Grok), so its turn is told from the runtime's own.
type AcpInputId = { inputId?: string };
type AcpBridgeSession = {
  readonly id: AdapterSession['id'];
  prompt(input: Parameters<AdapterSession['prompt']>[0], options?: AcpInputId): Promise<AcpBridge.AcpControl>;
  queue(input: Parameters<AdapterSession['queue']>[0], options: Required<AcpInputId>): Promise<AcpBridge.AcpControl>;
  withdraw?(...args: Parameters<NonNullable<AdapterSession['withdraw']>>): Promise<AcpBridge.AcpControl>;
  steer?(...args: FirstInput<NonNullable<AdapterSession['steer']>>): Promise<AcpBridge.AcpControl>;
  abort(...args: Parameters<AdapterSession['abort']>): Promise<AcpBridge.AcpControl>;
  records(): readonly AcpBridge.AcpRecord[];
  dispose: AdapterSession['dispose'];
};

export type CheckAcpExports = Assert<Equal<keyof typeof AcpBridge, keyof OarStartErrorClasses | 'grokSession' | 'antigravitySession' | 'opencodeSession'>>;
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
  Exclude<keyof AdapterSession, 'capabilities' | 'goal' | 'rawEvents' | 'graph' | 'resources' | 'contextBreakdown' | 'compact' | 'stopTask'>,
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

// The failure bridge (#869): the vendored OAR failure tables, typed with the
// protocol's class. The protocol enum and OAR's `FailureClass` are one set.
import type * as FailureBridge from '../../packages/client/src/runtime/oar-failure-runtime.js';
import type { codexFailure as vendorCodexFailure } from '../../packages/client/vendor/oar/95c6547/runtimes/codex/failure.js';
import type { failureFromStatus as vendorFailureFromStatus } from '../../packages/client/vendor/oar/95c6547/shared/failure-class.js';
import type { FailureClass } from '../../packages/client/vendor/oar/95c6547/contracts/failure.js';
import type { RuntimeFailureClass } from '../../packages/protocol/src/messages.js';

export type CheckRuntimeFailureClass = Assert<Equal<RuntimeFailureClass, FailureClass>>;
export type CheckFailureBridgeClass = Assert<Equal<ReturnType<typeof FailureBridge.failureFromStatus>, RuntimeFailureClass>>;
export type CheckFailureExports = Assert<Equal<keyof typeof FailureBridge, 'codexFailure' | 'failureFromStatus'>>;
export type CheckFailureFromStatus = Assert<Equal<typeof FailureBridge.failureFromStatus, typeof vendorFailureFromStatus>>;
export type CheckCodexFailureParameters = Assert<Equal<Parameters<typeof FailureBridge.codexFailure>, Parameters<typeof vendorCodexFailure>>>;
export type CheckCodexFailureClass = Assert<Equal<ReturnType<typeof FailureBridge.codexFailure>['failure'], ReturnType<typeof vendorCodexFailure>['failure']>>;
export type CheckCodexFailureFromText = Assert<Equal<ReturnType<typeof FailureBridge.codexFailure>['fromText'], Field<ReturnType<typeof vendorCodexFailure>, 'fromText'>>>;
export type CheckCodexFailureVendor = Assert<Assignable<typeof vendorCodexFailure, typeof FailureBridge.codexFailure>>;

// The dsh bridge: the vendored native runtime, narrowed to what the SDK calls.
// 'queue' and 'withdraw' are omitted on purpose, as for Codex. The runtime reports steer; the vendored session always returns it for the qualified dsh.
import type * as DshBridge from '../../packages/client/src/runtime/dsh-session-runtime.js';
import type { dshSession as vendorDshSession, DshSessionHooks } from '../../packages/client/vendor/oar/95c6547/runtimes/dsh/session.js';
import type { dshMcpRows as vendorDshMcpRows } from '../../packages/client/vendor/oar/95c6547/runtimes/dsh/mcp.js';
import type { DshLineProcess } from '../../packages/client/vendor/oar/95c6547/runtimes/dsh/launch.js';

type VendorDshArgs = Parameters<typeof vendorDshSession>;
type DshBridgeArgs = Parameters<typeof DshBridge.dshSession>;
type DshBridgeOptions = { cwd: string; model: string; resume?: string; mcpServers?: VendorDshArgs[2]['mcpServers']; launch: { directory: string; patches: readonly string[]; env: Readonly<Record<string, string>> }; retainedBytes: number };
type DshVendorSession = Awaited<ReturnType<typeof vendorDshSession>>;
type DshBridgeSession = {
  readonly id: AdapterSession['id'];
  prompt(...args: FirstInput<AdapterSession['prompt']>): Promise<DshBridge.DshControl>;
  steer(...args: FirstInput<DshVendorSession['steer']>): Promise<DshBridge.DshControl>;
  abort(...args: Parameters<AdapterSession['abort']>): Promise<DshBridge.DshControl>;
  records(): readonly DshBridge.DshRecord[];
  dispose: AdapterSession['dispose'];
};
export type CheckDshExports = Assert<Equal<keyof typeof DshBridge, 'dshSession' | 'dshMcpRows' | keyof OarStartErrorClasses>>;
export type CheckDshMcpRows = Assert<Equal<typeof DshBridge.dshMcpRows, typeof vendorDshMcpRows>>;
export type CheckDshOptions = Assert<Equal<Mutable<DshBridgeArgs[2]>, DshBridgeOptions>>;
export type CheckDshVendorOptions = Assert<Assignable<DshBridgeArgs[2], VendorDshArgs[2]>>;
export type CheckDshHooks = Assert<Assignable<DshHooksFromBridge, Partial<Mutable<DshSessionHooks>> | undefined>>;
type DshHooksFromBridge = DshBridgeArgs[3];
export type CheckDshControl = Assert<Equal<DshBridge.DshControl, BridgeControl>>;
export type CheckDshRecord = Assert<Equal<DshBridge.DshRecord, Flatten<BridgeRecord>>>;
export type CheckDshSession = Assert<Equal<DshBridge.RawDshSession, DshBridgeSession>>;
export type CheckDshSessionMembers = Assert<Equal<
  Exclude<keyof DshVendorSession, 'capabilities' | 'goal' | 'queue' | 'withdraw' | 'rawEvents' | 'graph' | 'resources' | 'contextBreakdown' | 'compact' | 'stopTask'>,
  keyof DshBridge.RawDshSession
>>;
export type CheckDshVendorSession = Assert<Assignable<DshVendorSession, DshBridge.RawDshSession>>;
export type CheckDshSpawn = Assert<Assignable<ReturnType<typeof spawnOwnedLineProcess>, DshLineProcess>>;
export type CheckDshNotFound = Assert<Equal<DshBridge.SessionNotFoundError, VendorSessionNotFoundError>>;

import type { opencodeSession as vendorOpenCodeSession } from '../../packages/client/vendor/oar/95c6547/runtimes/opencode/session.js';
export type CheckOpenCodeVendor = Assert<Equal<typeof vendorOpenCodeSession, VendorStartAcp>>;
export type CheckOpenCodeBridge = Assert<Equal<typeof AcpBridge.opencodeSession, AcpBridge.StartAcpSession>>;

export type CheckCodexUnavailable = Assert<Equal<Bridge.SessionUnavailableError, VendorSessionUnavailableError>>;
export type CheckAcpUnavailable = Assert<Equal<AcpBridge.SessionUnavailableError, VendorSessionUnavailableError>>;
export type CheckDshUnavailable = Assert<Equal<DshBridge.SessionUnavailableError, VendorSessionUnavailableError>>;
export type CheckCodexRuntimeFailure = Assert<Equal<Bridge.RuntimeFailureError, VendorRuntimeFailureError>>;
export type CheckCodexUnsupportedOption = Assert<Equal<Bridge.UnsupportedOptionError, VendorUnsupportedOptionError>>;
export type CheckCodexStartErrors = Assert<Equal<ErrorExports<typeof Bridge>, keyof OarStartErrorClasses>>;
export type CheckAcpStartErrors = Assert<Equal<ErrorExports<typeof AcpBridge>, keyof OarStartErrorClasses>>;
export type CheckDshStartErrors = Assert<Equal<ErrorExports<typeof DshBridge>, keyof OarStartErrorClasses>>;

// The Claude bridge: the vendored stream-json session and the Claude projection
// profile. The adapter assembles the session profile; the fold stays opaque.
import type * as ClaudeBridge from '../../packages/client/src/runtime/claude-session-runtime.js';
import type { streamJsonSession as vendorStreamJsonSession, StreamJsonSessionHooks } from '../../packages/client/vendor/oar/95c6547/shared/stream-json/session.js';
import type { StreamJsonSessionProfile } from '../../packages/client/vendor/oar/95c6547/shared/stream-json/profile.js';
import type { claudeProjectionProfile as vendorClaudeProfile, ClaudeProjectionState as VendorClaudeState } from '../../packages/client/vendor/oar/95c6547/runtimes/claude/projection.js';
import type { sessionCredentialRedactor as vendorRedactor, CredentialRedactor } from '../../packages/client/vendor/oar/95c6547/shared/credential-redactor.js';

type ClaudeVendorArgs = Parameters<typeof vendorStreamJsonSession<VendorClaudeState>>;
type ClaudeVendorProfile = StreamJsonSessionProfile<VendorClaudeState>;
type ClaudeBridgeArgs = Parameters<typeof ClaudeBridge.streamJsonSession>;
type ClaudeVendorSession = Awaited<ReturnType<typeof vendorStreamJsonSession>>;
type ClaudeBridgeSession = {
  readonly id: AdapterSession['id'];
  prompt(...args: FirstInput<AdapterSession['prompt']>): Promise<ClaudeBridge.ClaudeControl>;
  queue(input: Parameters<AdapterSession['queue']>[0], options: { inputId: string }): Promise<ClaudeBridge.ClaudeControl>;
  withdraw?(...args: Parameters<NonNullable<AdapterSession['withdraw']>>): Promise<ClaudeBridge.ClaudeControl>;
  abort(...args: Parameters<AdapterSession['abort']>): Promise<ClaudeBridge.ClaudeControl>;
  records(): readonly ClaudeBridge.ClaudeRecord[];
  dispose: AdapterSession['dispose'];
};
type ClaudeSharedProfileKeys = 'capabilities' | 'steer' | 'consume' | 'open' | 'exited' | 'disposing';
export type CheckClaudeExports = Assert<Equal<keyof typeof ClaudeBridge,
  'streamJsonSession' | 'claudeProjectionProfile' | 'initialClaudeProjection' | 'resumedClaudeProjection' | 'sessionCredentialRedactor'>>;
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
