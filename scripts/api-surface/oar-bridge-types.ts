// Check source types across the private JS/declaration boundary.
// The bridge exposes a smaller surface than the full OAR adapter.
import type * as Bridge from '../../packages/client/src/runtime/codex-session-runtime.js';
import type { codexSession as vendorSession, CodexAdapterSession } from '../../packages/client/vendor/oar/51b83c9/runtimes/codex/session.js';
import type { ControlResult, RawEvent } from '../../packages/client/vendor/oar/51b83c9/contracts/session.js';
import type { LineProcess, SpawnLineProcess } from '../../packages/client/vendor/oar/51b83c9/runtimes/codex/app-server-client.js';
import type { spawnOwnedLineProcess } from '../../packages/client/src/runtime/owned-line-process.js';
import type { buildRuntimeEnvironment } from '../../packages/client/src/runtime/environment.js';
import type { CodexProjection, CodexRecord } from '../../packages/client/src/adapters/codex/projection.js';
import type { SessionNotFoundError as VendorSessionNotFoundError } from '../../packages/client/vendor/oar/51b83c9/contracts/session-not-found-error.js';
import type * as TreeBridge from '../../packages/client/src/runtime/oar-process-tree.js';
import type * as VendorTree from '../../packages/client/vendor/oar/51b83c9/shared/executable/process-tree.js';

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
  Pick<VendorArgs[2], 'cwd' | 'resume' | 'model' | 'approvalPolicy' | 'sandboxMode' | 'launchArgs' | 'mcpServers'> & Required<Pick<VendorArgs[2], 'env'>>
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
export type CheckFunctionExports = Assert<Equal<keyof typeof Bridge, 'codexSession' | 'SessionNotFoundError'>>;
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
export type CheckSessionMembers = Assert<Equal<
  Exclude<keyof CodexAdapterSession, 'capabilities' | 'queue' | 'withdraw' | 'rawEvents' | 'graph' | 'resources' | 'contextBreakdown'>,
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
export type CheckEnv = Assert<Equal<Readonly<Awaited<ReturnType<typeof buildRuntimeEnvironment>>>, BridgeArgs[2]['env']>>;
export type CheckVendorEnv = Assert<Assignable<Awaited<ReturnType<typeof buildRuntimeEnvironment>>, VendorArgs[2]['env']>>;
export type CheckProjectionRecord = Assert<Equal<Parameters<CodexProjection['consume']>[1], CodexRecord>>;
export type CheckProjectionInput = Assert<Assignable<RawEvent, Parameters<CodexProjection['consume']>[1]>>;
export type CheckHookRecord = Assert<Assignable<RawEvent, Parameters<NonNullable<NonNullable<BridgeArgs[4]>['onRecord']>>[0]>>;

// The process-tree bridge re-exports the vendored OAR functions with their exact types.
export type CheckTreeExports = Assert<Equal<keyof typeof TreeBridge, 'descendantsOf' | 'killEntries' | 'readProcessTable'>>;
export type CheckTreeVendorExports = Assert<Equal<Exclude<keyof typeof VendorTree, 'ProcessEntry' | 'ProcessTable'>, keyof typeof TreeBridge>>;
export type CheckTreeEntry = Assert<Equal<TreeBridge.ProcessEntry, VendorTree.ProcessEntry>>;
export type CheckTreeTable = Assert<Equal<TreeBridge.ProcessTable, VendorTree.ProcessTable>>;
export type CheckTreeRead = Assert<Equal<typeof TreeBridge.readProcessTable, typeof VendorTree.readProcessTable>>;
export type CheckTreeWalk = Assert<Equal<typeof TreeBridge.descendantsOf, typeof VendorTree.descendantsOf>>;
export type CheckTreeKill = Assert<Equal<typeof TreeBridge.killEntries, typeof VendorTree.killEntries>>;

// The ACP bridge: one start signature for every vendored ACP runtime, with
// the SDK-owned agent process, terminal processes and explicit environment.
import type * as AcpBridge from '../../packages/client/src/runtime/acp-session-runtime.js';
import type { StartAcpSession as VendorStartAcp, AcpSessionOptions, AcpSessionHooks } from '../../packages/client/vendor/oar/51b83c9/shared/acp/session.js';
import type { SpawnAcpLineProcess } from '../../packages/client/vendor/oar/51b83c9/shared/acp/process.js';
import type { SpawnAcpTerminal } from '../../packages/client/vendor/oar/51b83c9/shared/acp/terminal.js';
import type { AdapterSession } from '../../packages/client/vendor/oar/51b83c9/contracts/session.js';
import type { RuntimeFailureError as VendorRuntimeFailureError } from '../../packages/client/vendor/oar/51b83c9/contracts/runtime-failure-error.js';
import type { spawnOwnedTerminalProcess } from '../../packages/client/src/runtime/owned-terminal-process.js';
import type { grokSession as vendorGrokSession } from '../../packages/client/vendor/oar/51b83c9/runtimes/grok/session.js';

type AcpBridgeArgs = Parameters<AcpBridge.StartAcpSession>;
type AcpBridgeOptions = Mutable<
  Pick<AcpSessionOptions, 'cwd' | 'env' | 'resume' | 'model' | 'mcpServers'>
>;
type AcpBridgeHooks = Mutable<Omit<AcpSessionHooks, 'onRecord'>> & {
  onRecord?: (record: AcpBridge.AcpRecord) => void;
};
type AcpBridgeSession = {
  readonly id: AdapterSession['id'];
  prompt(...args: FirstInput<AdapterSession['prompt']>): Promise<AcpBridge.AcpControl>;
  abort(...args: Parameters<AdapterSession['abort']>): Promise<AcpBridge.AcpControl>;
  records(): readonly AcpBridge.AcpRecord[];
  dispose: AdapterSession['dispose'];
};

export type CheckAcpExports = Assert<Equal<keyof typeof AcpBridge, 'SessionNotFoundError' | 'RuntimeFailureError' | 'grokSession'>>;
export type CheckAcpRuntimeFailure = Assert<Assignable<VendorRuntimeFailureError, AcpBridge.RuntimeFailureError>>;
export type CheckAcpRuntimeFailureFields = Assert<Equal<Pick<VendorRuntimeFailureError, 'name'>, Pick<AcpBridge.RuntimeFailureError, 'name'>>>;
export type CheckGrokVendor = Assert<Equal<typeof vendorGrokSession, VendorStartAcp>>;
export type CheckGrokBridge = Assert<Equal<typeof AcpBridge.grokSession, AcpBridge.StartAcpSession>>;
export type CheckAcpNotFound = Assert<Equal<AcpBridge.SessionNotFoundError, VendorSessionNotFoundError>>;
export type CheckAcpNotFoundConstructor = Assert<Equal<
  ConstructorParameters<typeof AcpBridge.SessionNotFoundError>,
  ConstructorParameters<typeof VendorSessionNotFoundError>
>>;
export type CheckAcpControl = Assert<Equal<AcpBridge.AcpControl, BridgeControl>>;
export type CheckAcpRecord = Assert<Equal<AcpBridge.AcpRecord, Flatten<BridgeRecord>>>;
export type CheckAcpSession = Assert<Equal<AcpBridge.RawAcpSession, AcpBridgeSession>>;
// Name each intentional omission so new vendor members fail this check.
export type CheckAcpSessionMembers = Assert<Equal<
  Exclude<keyof AdapterSession, 'capabilities' | 'steer' | 'queue' | 'withdraw' | 'rawEvents' | 'graph' | 'resources' | 'contextBreakdown'>,
  keyof AcpBridge.RawAcpSession
>>;
export type CheckAcpVendorSession = Assert<Assignable<AdapterSession, AcpBridge.RawAcpSession>>;
export type CheckAcpParameters = Assert<Equal<AcpBridgeArgs, [
  spawn: typeof spawnOwnedLineProcess,
  spawnTerminal: typeof spawnOwnedTerminalProcess,
  installation: BridgeInstallation,
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
export type CheckAcpEnv = Assert<Equal<Readonly<Awaited<ReturnType<typeof buildRuntimeEnvironment>>>, AcpBridgeArgs[3]['env']>>;

// The failure bridge (#869): the vendored OAR failure tables, typed with the
// protocol's class. The protocol enum and OAR's `FailureClass` are one set.
import type * as FailureBridge from '../../packages/client/src/runtime/oar-failure-runtime.js';
import type { codexFailure as vendorCodexFailure } from '../../packages/client/vendor/oar/51b83c9/runtimes/codex/failure.js';
import type { failureFromStatus as vendorFailureFromStatus } from '../../packages/client/vendor/oar/51b83c9/shared/failure-class.js';
import type { FailureClass } from '../../packages/client/vendor/oar/51b83c9/contracts/failure.js';
import type { RuntimeFailureClass } from '../../packages/protocol/src/messages.js';

export type CheckRuntimeFailureClass = Assert<Equal<RuntimeFailureClass, FailureClass>>;
export type CheckFailureBridgeClass = Assert<Equal<ReturnType<typeof FailureBridge.failureFromStatus>, RuntimeFailureClass>>;
export type CheckFailureExports = Assert<Equal<keyof typeof FailureBridge, 'codexFailure' | 'failureFromStatus'>>;
export type CheckFailureFromStatus = Assert<Equal<typeof FailureBridge.failureFromStatus, typeof vendorFailureFromStatus>>;
export type CheckCodexFailureParameters = Assert<Equal<Parameters<typeof FailureBridge.codexFailure>, Parameters<typeof vendorCodexFailure>>>;
export type CheckCodexFailureClass = Assert<Equal<ReturnType<typeof FailureBridge.codexFailure>['failure'], ReturnType<typeof vendorCodexFailure>['failure']>>;
export type CheckCodexFailureFromText = Assert<Equal<ReturnType<typeof FailureBridge.codexFailure>['fromText'], Field<ReturnType<typeof vendorCodexFailure>, 'fromText'>>>;
export type CheckCodexFailureVendor = Assert<Assignable<typeof vendorCodexFailure, typeof FailureBridge.codexFailure>>;
