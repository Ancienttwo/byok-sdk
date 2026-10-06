// Check source types across the private JS/declaration boundary.
// The bridge exposes a smaller surface than the full OAR adapter.
import type * as Bridge from '../../packages/client/src/runtime/codex-session-runtime.js';
import type { codexSession as vendorSession, CodexAdapterSession } from '../../packages/client/vendor/oar/a800aa0/runtimes/codex/session.js';
import type { ControlResult, RawEvent } from '../../packages/client/vendor/oar/a800aa0/contracts/session.js';
import type { LineProcess, SpawnLineProcess } from '../../packages/client/vendor/oar/a800aa0/runtimes/codex/app-server-client.js';
import type { spawnOwnedLineProcess } from '../../packages/client/src/runtime/owned-line-process.js';
import type { buildRuntimeEnv } from '../../packages/client/src/daemon/environment.js';
import type { CodexProjection, CodexRecord } from '../../packages/client/src/adapters/codex/projection.js';

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
  Pick<VendorArgs[2], 'cwd' | 'resume' | 'model' | 'approvalPolicy'> & Required<Pick<VendorArgs[2], 'env'>>
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
export type CheckFunctionExports = Assert<Equal<keyof typeof Bridge, 'codexSession'>>;
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
  Exclude<keyof CodexAdapterSession, 'capabilities' | 'queue' | 'withdraw' | 'rawEvents' | 'graph'>,
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
export type CheckEnv = Assert<Equal<Readonly<ReturnType<typeof buildRuntimeEnv>>, BridgeArgs[2]['env']>>;
export type CheckVendorEnv = Assert<Assignable<ReturnType<typeof buildRuntimeEnv>, VendorArgs[2]['env']>>;
export type CheckProjectionRecord = Assert<Equal<Parameters<CodexProjection['consume']>[1], CodexRecord>>;
export type CheckProjectionInput = Assert<Assignable<RawEvent, Parameters<CodexProjection['consume']>[1]>>;
export type CheckHookRecord = Assert<Assignable<RawEvent, Parameters<NonNullable<NonNullable<BridgeArgs[4]>['onRecord']>>[0]>>;
