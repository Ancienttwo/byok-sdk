/**
 * WP4 custody dispatcher (`custody/custody-dispatcher.ts`) — the ONLY mint and
 * dispatch authority for pi subagent children (design freeze D3, notes
 * 20260917-2155). Every production subagent spawn — both vendor lanes — is
 * rerouted here:
 *
 *   vendor foreground (print lane)  runs/foreground/execution.ts
 *   vendor background (runner lane) runs/background/async-execution.ts spawnRunner
 *   vendor runner bootstrap step    runs/background/subagent-runner.ts
 *   vendor probe lane (herdr)       profiles/profiles.ts probeModel
 *                                   (each site surfaces a dispatch refusal
 *                                   through its own failure path, fail-closed)
 *
 * The dispatcher performs, in order, the frozen custody chain:
 *
 *   ① admission   — the inherited run-fanout budget (PI_SUBAGENT_RUN_FANOUT_BUDGET)
 *                   plus the verified-parent binding: a parent that is itself a
 *                   dispatched child must present its own launch record whose
 *                   depth commitment agrees with the record's contract depth,
 *                   else the dispatch refuses before any state exists.
 *   ② caps        — session/parallel cross-process caps execute as wx slot
 *                   files under the budget directory (keyed by session and
 *                   root task), created inside the existing fanout admission
 *                   lock; numeric policy limits alone never admit a spawn.
 *   ④ permit      — the vendored createWorkflowChildPermit is ISSUED here and
 *                   CONSUMED at the existing vendored consume site
 *                   (execution.ts consumeWorkflowChildPermit) before the
 *                   physical spawn.
 *   mint          — the descendant-launch record is constructed directly
 *                   (identity has no mint function) over the self bundle's
 *                   helper re-entry: `node <runtime> __byok_sdk_helper
 *                   pi-subagent-print|pi-subagent-runner`. Depth charges follow
 *                   the frozen table (every logical delegation edge charges 1;
 *                   only runner→print charges 0); the vendor's
 *                   getSubagentDepthEnv increment is discarded at the reroute
 *                   sites.
 *   spawn         — the helper direct-connect argv shape; the child re-enters
 *                   this bundle through the helper host and its attested entry
 *                   re-measures the record against the running process.
 *   ⑤ settle      — four-stage crash mapping on existing primitives only:
 *                     未准入      refusal before any state write (no state);
 *                     已准入未spawn  admission ledger + claimed permit + record
 *                                 remain, swept by the next admission after
 *                                 60 s once the launcher pid is dead (the same
 *                                 liveness rule the admission lock uses);
 *                     已spawn      the child entry validates the record against
 *                                 its own process and removes the sweep sidecar;
 *                     终止待确认     exit observation stays with the existing
 *                                 asyncDir finalizeProcessTerminal / foreground
 *                                 close paths — no second scheduler.
 *
 * Outside an SDK dispatch context (no inherited budget) every entry point
 * fails closed with a refusal. There is no discovery, no PATH fallback and no
 * legacy chain left behind this module.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CONTROLLED_PI_DIRECTORY_ENV_NAMES,
  DESCENDANT_PER_LAUNCH_ENV_NAMES,
  KEYS_PI_INHERITED_ENV_NAMES,
  KEYS_PI_WINDOWS_ENV_NAMES,
  RUNTIME_DESCENDANT_EDGES,
  descendantTemplateDigest,
  parseDescendantLaunch,
  toolImplementationLaunchEnvNamesDigest,
  toolImplementationLoaderEnvValuesDigest,
  type DescendantLaunchV1,
  type DescendantLimitsV1,
  type ImplementationSpawnBindingV1,
  type RuntimeDescendantPolicyV1,
  type RuntimeEntryV1,
  type ToolImplementationStatTupleV1,
} from '@byok-sdk/implementation-identity';
import {
  BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV,
  BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV,
  BYOK_SDK_CUSTODY_RUNNER_CONFIG_ENV,
  loadCustodyLaunchRecord,
  parseCustodyParentDepthCommitment,
} from './custody-commitments';
import { parsePiPrintArgv } from './pi-print-argv';
// The vendored budget-lock and child-permit primitives come through the JS
// bridge (`custody-vendor-bridge.js`): the vendored tree publishes TS with no
// consumable declarations and is type-checked by no tsc pass, so client .ts
// modules never import it directly.
import type { RunFanoutBudgetDescriptor, WorkflowChildPermit } from './custody-vendor-bridge.js';
import {
  RUN_FANOUT_BUDGET_ENV,
  claimRunFanoutBatchWithCommit,
  claimWorkflowChildPermit,
  createWorkflowChildPermit,
  decodeRunFanoutBudgetDescriptor,
} from './custody-vendor-bridge.js';

/** The vendored lanes a child can take; identical to the runtime entry names. */
export type CustodyChildLane = Extract<RuntimeEntryV1, 'pi-subagent-print' | 'pi-subagent-runner'>;

/** A custody dispatch refusal: fail-closed, no state, no fallback. */
export class CustodyDispatchRefusalError extends Error {
  constructor(readonly reason: string) {
    super(`custody dispatch refused: ${reason}`);
    this.name = 'CustodyDispatchRefusalError';
  }
}

function refuse(reason: string): never {
  throw new CustodyDispatchRefusalError(reason);
}

/** Frozen counting table: only runner→print (the bootstrap edge) charges zero. */
const RUNNER_PRINT_BOOTSTRAP_CHARGE = 0;
const DEFAULT_EDGE_CHARGE = 1;

/** SDK custody root defaults; the vendor's own depth computation is never consulted. */
const CUSTODY_DEFAULT_SESSION_CAP = 16;
const CUSTODY_DEFAULT_PARALLEL = 4;
/** 已准入未spawn state is reclaimable once the launcher pid is dead AND this has elapsed. */
const CUSTODY_STALE_MS = 60_000;
/** The dispatcher launches the interpreter with no load commands; this is sha256("[]"). */
const EMPTY_LOAD_COMMANDS_DIGEST = createHash('sha256').update('[]', 'utf8').digest('hex');

const HELPER_SUBCOMMAND = '__byok_sdk_helper';

/**
 * The root policy allowlist: the whole frozen vocabulary (the maximum
 * `parseRuntimeDescendantPolicy` accepts), because every descendant record
 * inherits this policy unchanged — the identity parser refuses a changed
 * policy — while each record's exactNames are drawn from that same vocabulary.
 * Per-launch names, controlled directories and the ambient inherited set are
 * all legal exactNames; everything outside the vocabulary never is.
 */
const ROOT_POLICY_ENV_ALLOWLIST: readonly string[] = Object.freeze(
  [
    ...KEYS_PI_INHERITED_ENV_NAMES,
    ...KEYS_PI_WINDOWS_ENV_NAMES,
    ...CONTROLLED_PI_DIRECTORY_ENV_NAMES,
    ...DESCENDANT_PER_LAUNCH_ENV_NAMES,
  ].sort(),
);

export interface CustodyParentContext {
  readonly parentKind: RuntimeEntryV1;
  readonly parentDepth: number;
  readonly rootTaskId: string;
  readonly parentInstancePath: readonly number[];
  readonly effectiveLimits: DescendantLimitsV1;
  readonly policy: RuntimeDescendantPolicyV1;
  readonly budget: RunFanoutBudgetDescriptor;
}

function uintEnv(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Resolve the dispatching parent's custody context. A parent that is itself a
 * dispatched child must present its own record plus a depth commitment that
 * matches the record's contract depth — the verified-parent binding. A
 * top-level runtime parent (pi-rpc) has no record; its policy is the SDK
 * custody root policy derived from the inherited budget and the vendor-threaded
 * depth ceiling. No inherited budget anywhere: refusal (fail-closed, D1/D7).
 */
export function resolveCustodyParentContext(env: Readonly<Record<string, string | undefined>>): CustodyParentContext {
  let budget: RunFanoutBudgetDescriptor;
  try {
    const decoded = decodeRunFanoutBudgetDescriptor(env[RUN_FANOUT_BUDGET_ENV]);
    if (decoded === undefined) {
      refuse(`${RUN_FANOUT_BUDGET_ENV} is absent: no SDK dispatch context (the vendored runtime spawns only through the SDK custody dispatcher)`);
    }
    budget = decoded;
  } catch (error) {
    if (error instanceof CustodyDispatchRefusalError) throw error;
    refuse(`the inherited run fan-out budget is invalid: ${(error as Error).message}`);
  }
  const recordEnv = env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV];
  if (recordEnv !== undefined && recordEnv !== '') {
    let record: DescendantLaunchV1;
    try {
      record = parseDescendantLaunch(loadCustodyLaunchRecord(env));
    } catch (error) {
      refuse(`the parent's own launch record is not a valid descendant record: ${(error as Error).message}`);
    }
    const parentDepth = parseCustodyParentDepthCommitment(env);
    if (parentDepth !== record.perLaunch.depth) {
      refuse(`verified-parent binding failed: depth commitment ${parentDepth} differs from the parent record's contract depth ${record.perLaunch.depth}`);
    }
    return {
      parentKind: record.perLaunch.templateKind,
      parentDepth,
      rootTaskId: record.perLaunch.rootTaskId,
      parentInstancePath: record.perLaunch.instancePath,
      effectiveLimits: record.perLaunch.effectiveLimits,
      policy: record.policy,
      budget,
    };
  }
  // Top-level runtime parent: the daemon-launched pi-rpc/prepared session.
  const maxDepth = uintEnv(env.PI_SUBAGENT_MAX_DEPTH) ?? 2; // vendor DEFAULT_SUBAGENT_MAX_DEPTH
  const sessionCap = uintEnv(env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION) || CUSTODY_DEFAULT_SESSION_CAP;
  return {
    parentKind: 'pi-rpc',
    parentDepth: 0,
    rootTaskId: budget.rootRunId,
    parentInstancePath: [],
    effectiveLimits: {
      maxDepth,
      fanout: budget.limit,
      parallel: CUSTODY_DEFAULT_PARALLEL,
      sessionCap,
    },
    policy: {
      envNameAllowlist: ROOT_POLICY_ENV_ALLOWLIST,
      maxDepth,
      fanout: budget.limit,
      parallel: CUSTODY_DEFAULT_PARALLEL,
      sessionCap,
    },
    budget,
  };
}

export interface CustodyDispatchInput {
  /** The child lane being dispatched. */
  readonly child: CustodyChildLane;
  /** The child's working directory; becomes the record template cwd. */
  readonly cwd: string;
  /** Print lane: the vendor-built pi-style argv (single source for the payload). */
  readonly vendorArgv?: readonly string[];
  /** The vendor-built child env overlay (sharedEnv); projected, never forwarded wholesale. */
  readonly vendorEnv?: Readonly<Record<string, string | undefined>>;
  /** Runner lane: the absolute runner config path the dispatcher hands to the payload. */
  readonly runnerConfigPath?: string;
  /** Foreground lane: the spawning agent's name (permit binding). */
  readonly agent?: string;
  /** Foreground lane: the launch contract digest (permit projection). */
  readonly launchContractDigest?: string;
  readonly context?: 'fresh' | 'fork';
  /** Permit child key; defaults to a per-launch uuid. */
  readonly childKey?: string;
  /** Foreground child index for the instance path. */
  readonly index?: number;
}

export interface CustodyPermitLaunch {
  readonly permit: WorkflowChildPermit;
  readonly workflowRunId: string;
  readonly childKey: string;
  readonly agent: string;
  readonly launchContractDigest: string;
  readonly context: 'fresh' | 'fork';
  readonly runner: 'pi';
}

export interface CustodyDispatch {
  /** Helper direct-connect argv shape: [entry?, '__byok_sdk_helper', <kind>]. */
  readonly command: string;
  readonly args: readonly string[];
  /** Transport environment: the attested exec env plus the custody commitments. */
  readonly env: Record<string, string>;
  readonly launchId: string;
  readonly recordPath: string;
  readonly permitLaunch: CustodyPermitLaunch;
}

interface LaunchLedgerV1 {
  version: 1;
  launchId: string;
  child: CustodyChildLane;
  parentKind: RuntimeEntryV1;
  launcherPid: number;
  claimedAt: number;
  recordPath: string;
  sidecarPath: string;
  sessionKey: string;
  rootKey: string;
  sessionSlotPath: string;
  parallelSlotPath: string;
  fanoutClaimPath: string;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function safeKeySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

function sha256File(target: string): string {
  return createHash('sha256').update(readFileSync(target)).digest('hex');
}

function statTuple(target: string): ToolImplementationStatTupleV1 {
  const stat = lstatSync(target);
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
  };
}

interface SelfReentryTarget {
  readonly command: string;
  readonly entry?: string;
}

/**
 * Resolve the bundle this process is running from, exactly as a helper
 * re-entry must reach it: `node <entry> __byok_sdk_helper <kind>` for an
 * interpreter-hosted bundle, or the bare executable for a single-file/SEA
 * host. No discovery beyond the running process itself.
 */
function resolveSelfReentryTarget(): SelfReentryTarget {
  const entryArg = process.argv[1];
  if (entryArg) {
    try {
      const real = realpathSync(entryArg);
      if (statSync(real).isFile() && real !== realpathSync(process.execPath)) {
        return { command: realpathSync(process.execPath), entry: real };
      }
    } catch {
      // Fall through to the executable-only shape.
    }
  }
  return { command: process.execPath };
}

/**
 * Project the vendor child environment onto the record's declared names:
 * per-launch vocabulary names become envValues (with the frozen-table depth
 * re-stamp), controlled directories become commitments, and the ambient
 * inherited set rides along from the transport env. Everything else the vendor
 * spread is dropped — the attested exec env is exactly the record's
 * exactNames.
 */
function projectChildEnv(
  merged: Readonly<Record<string, string | undefined>>,
  childDepth: number,
  maxDepth: number,
): {
  readonly envValues: Record<string, string>;
  readonly controlledDirValues: Record<string, string>;
  readonly exactNames: readonly string[];
  readonly execEnv: Record<string, string>;
} {
  const envValues: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (value === undefined || !(DESCENDANT_PER_LAUNCH_ENV_NAMES as readonly string[]).includes(name)) continue;
    envValues[name] = value;
  }
  envValues.PI_SUBAGENT_DEPTH = String(childDepth);
  envValues.PI_SUBAGENT_MAX_DEPTH = String(maxDepth);
  envValues.PI_SUBAGENT_CHILD = '1';
  const controlledDirValues: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (value === undefined || !(CONTROLLED_PI_DIRECTORY_ENV_NAMES as readonly string[]).includes(name)) continue;
    if (!path.isAbsolute(value)) refuse(`controlled directory ${name} is not an absolute path: ${JSON.stringify(value)}`);
    controlledDirValues[name] = value;
  }
  if (!path.isAbsolute(controlledDirValues.PI_CODING_AGENT_SESSION_DIR ?? '')) {
    refuse('PI_CODING_AGENT_SESSION_DIR is absent from the dispatch environment: the session root commitment is required');
  }
  const ambientNames = [...KEYS_PI_INHERITED_ENV_NAMES, ...(process.platform === 'win32' ? KEYS_PI_WINDOWS_ENV_NAMES : [])]
    .filter((name) => merged[name] !== undefined);
  const exactNames = Object.freeze([...new Set([...Object.keys(envValues), ...Object.keys(controlledDirValues), ...ambientNames])].sort());
  const execEnv: Record<string, string> = {};
  for (const name of exactNames) {
    execEnv[name] = envValues[name] ?? controlledDirValues[name] ?? (merged[name] as string);
  }
  return { envValues, controlledDirValues, exactNames, execEnv };
}

interface PrintVendorProjection {
  readonly model: string | undefined;
  readonly sessionFile: string | null;
  readonly task: string;
}

/** Extract the record fields the print lane's vendor argv carries. */
function projectPrintVendorArgv(argv: readonly string[] | undefined): PrintVendorProjection {
  if (argv === undefined) return { model: undefined, sessionFile: null, task: '' };
  return parsePiPrintArgv(argv);
}

/**
 * Sweep 已准入未spawn state: ledger entries whose launcher pid is dead and
 * whose claim is older than the stale window lose their record, sidecar and
 * cap slots. Runs under the admission lock, on the same liveness rule the
 * admission lock itself uses.
 */
function sweepStaleLaunchState(budgetDirectory: string, now: number): void {
  const launchesDir = path.join(budgetDirectory, 'custody-launches');
  let entries: string[];
  try {
    entries = readdirSync(launchesDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const ledgerPath = path.join(launchesDir, entry);
    let ledger: LaunchLedgerV1;
    try {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Partial<LaunchLedgerV1>;
      if (parsed.version !== 1 || typeof parsed.launcherPid !== 'number' || typeof parsed.claimedAt !== 'number') continue;
      ledger = parsed as LaunchLedgerV1;
    } catch {
      continue;
    }
    if (now - ledger.claimedAt <= CUSTODY_STALE_MS || pidIsAlive(ledger.launcherPid)) continue;
    for (const target of [ledger.recordPath, ledger.sidecarPath, ledger.sessionSlotPath, ledger.parallelSlotPath, ledgerPath]) {
      try {
        rmSync(target, { force: true });
      } catch {
        // Best effort reclaim of another dead process's state.
      }
    }
  }
}

function countSlotFiles(directory: string): number {
  try {
    return readdirSync(directory).filter((entry) => /^\d{6}\.json$/.test(entry)).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

function claimCapSlot(directory: string, limit: number, created: string[]): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let slot = 0; slot < limit; slot++) {
    const slotPath = path.join(directory, `${String(slot).padStart(6, '0')}.json`);
    try {
      const fd = openSync(slotPath, 'wx', 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify({ version: 1, pid: process.pid, claimedAt: Date.now() })}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      created.push(slotPath);
      return slotPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  refuse(`custody cap exhausted at ${directory}: ${limit} live slots`);
}

/**
 * THE custody dispatch. See the module docstring for the frozen chain. Every
 * refusal before the ledger commit leaves zero state (未准入); the commit is
 * atomic under the existing fanout admission lock (①②) — the helper rolls its
 * own claim slots back on any throw — and any failure inside the commit rolls
 * our own writes back in the catch (back to 未准入).
 */
export function dispatchCustodyPiSubagentSpawn(input: CustodyDispatchInput): CustodyDispatch {
  if (input.child !== 'pi-subagent-print' && input.child !== 'pi-subagent-runner') {
    refuse(`unknown child lane ${String(input.child)}`);
  }
  if (input.child === 'pi-subagent-runner' && (input.runnerConfigPath === undefined || !path.isAbsolute(input.runnerConfigPath))) {
    refuse('the runner lane requires the absolute runner config path the dispatcher hands to the payload');
  }
  const ctx = resolveCustodyParentContext(process.env);
  const edge = RUNTIME_DESCENDANT_EDGES.find((candidate) => candidate.parent === ctx.parentKind && candidate.child === input.child);
  if (edge === undefined) {
    refuse(`edge ${ctx.parentKind} -> ${input.child} is not in the frozen runtime edge vocabulary`);
  }
  const bootstrap = ctx.parentKind === 'pi-subagent-runner' && input.child === 'pi-subagent-print';
  const charge = bootstrap ? RUNNER_PRINT_BOOTSTRAP_CHARGE : DEFAULT_EDGE_CHARGE;
  const childDepth = ctx.parentDepth + charge;
  const maxDepth = ctx.effectiveLimits.maxDepth;
  // The zero-charge bootstrap edge is legal at cap, every charged edge needs
  // remaining depth — the identity validator enforces the same rule at entry.
  if (!bootstrap && ctx.parentDepth >= maxDepth) {
    refuse(`depth exhausted: parent depth ${ctx.parentDepth} at maxDepth ${maxDepth} on edge ${ctx.parentKind} -> ${input.child}`);
  }
  const launchId = randomUUID();
  const cwd = path.resolve(input.cwd);
  const childIndex = input.index ?? 0;
  const instancePath = bootstrap ? [...ctx.parentInstancePath] : [...ctx.parentInstancePath, childIndex];

  const merged: Record<string, string | undefined> = { ...process.env, ...input.vendorEnv };
  const { envValues, controlledDirValues, exactNames, execEnv } = projectChildEnv(merged, childDepth, maxDepth);

  const target = resolveSelfReentryTarget();
  if (target.entry === undefined && !statSync(target.command).isFile()) {
    refuse('no runtime executable available for the helper re-entry');
  }
  const fixedArgv: readonly string[] = [HELPER_SUBCOMMAND, input.child];
  const form = target.entry === undefined ? 'compiled-executable' as const : 'interpreter+bundle' as const;
  const identity = {
    kind: 'attested',
    authority: 'host-install-record',
    manifestRevision: 'byok-custody-dispatch-v1',
    form,
    // interpreter+bundle: installPath IS the entry script (spawn-binding's
    // attested consistency rule); compiled-executable: installPath is the
    // executable itself. identity.entry stays absent in both forms.
    installPath: target.entry ?? target.command,
    closureDigest: sha256File(target.entry ?? target.command),
    closureKind: 'artifact',
    ...(form === 'interpreter+bundle'
      ? {
        interpreter: {
          path: target.command,
          digest: sha256File(target.command),
          loadCommandsDigest: EMPTY_LOAD_COMMANDS_DIGEST,
        },
      }
      : {}),
    launchArgv: [...fixedArgv],
    launchCwd: cwd,
    launchEnvNamesDigest: toolImplementationLaunchEnvNamesDigest(execEnv),
    loaderEnvValuesDigest: toolImplementationLoaderEnvValuesDigest(execEnv),
    installStat: statTuple(target.entry ?? target.command),
    ...(form === 'interpreter+bundle' ? { interpreterStat: statTuple(target.command) } : {}),
  } satisfies ImplementationSpawnBindingV1['identity'];

  const template = {
    format: 'byok.implementation-spawn',
    version: 1,
    identity,
    command: target.command,
    ...(target.entry === undefined ? {} : { entry: target.entry }),
    fixedArgv,
    cwd,
    envCommitments: controlledDirValues,
  } satisfies ImplementationSpawnBindingV1;

  const print = input.child === 'pi-subagent-print' ? projectPrintVendorArgv(input.vendorArgv) : undefined;
  const record: DescendantLaunchV1 = {
    format: 'byok.descendant-launch',
    version: 1,
    template,
    templateDigest: descendantTemplateDigest(template),
    policy: ctx.policy,
    perLaunch: {
      format: 'byok.runtime-descendant-context',
      version: 1,
      templateKind: input.child,
      edge: { parent: ctx.parentKind, child: input.child },
      rootTaskId: ctx.rootTaskId,
      parentInstancePath: ctx.parentInstancePath,
      instancePath,
      depth: childDepth,
      remainingDepth: maxDepth - childDepth,
      effectiveLimits: ctx.effectiveLimits,
      task: print?.task ?? '',
      modelCandidates: [{ provider: 'pi', model: print?.model ?? '(session-default)' }],
      attempt: 0,
      session: { cwd, root: controlledDirValues.PI_CODING_AGENT_SESSION_DIR!, file: print?.sessionFile ?? null },
      mcp: {
        env: {},
        metadata: input.vendorArgv === undefined ? {} : { 'byok.custody.printArgv': [...input.vendorArgv] },
      },
      envValues,
      exactNames,
      controlledDirValues,
    },
  };
  let parsedRecord: DescendantLaunchV1;
  try {
    parsedRecord = parseDescendantLaunch(record);
  } catch (error) {
    refuse(`the minted record does not parse: ${(error as Error).message}`);
  }

  const permitLaunch: CustodyPermitLaunch = {
    permit: createWorkflowChildPermit({
      issuerPackage: '@byok-sdk/client',
      workflowRunId: ctx.rootTaskId,
      childKey: input.childKey ?? launchId,
      agent: input.agent ?? input.child,
      launchContractDigest: input.launchContractDigest ?? record.templateDigest,
      context: input.context ?? 'fresh',
    }),
    workflowRunId: ctx.rootTaskId,
    childKey: input.childKey ?? launchId,
    agent: input.agent ?? input.child,
    launchContractDigest: input.launchContractDigest ?? record.templateDigest,
    context: input.context ?? 'fresh',
    runner: 'pi',
  };
  // ④ permit: the same in-graph claim the vendored workflow parent performs
  // before dispatch — the vendored consume site refuses a permit that was
  // never claimed, so the claim is part of the dispatcher's issuance.
  const claimError = claimWorkflowChildPermit(permitLaunch.permit, permitLaunch.workflowRunId, permitLaunch.childKey);
  if (claimError !== undefined) refuse(claimError);

  const budgetDirectory = ctx.budget.directory;
  const sessionKey = process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID
    ?? process.env.PI_SUBAGENT_PARENT_SESSION
    ?? controlledDirValues.PI_CODING_AGENT_SESSION_DIR!;
  const rootKey = safeKeySegment(ctx.rootTaskId);
  const now = Date.now();

  const committedFiles: string[] = [];
  let recordPath = '';
  try {
    // ① + ②: one custody fanout claim plus the ② cap slots and the admission
    // ledger, committed atomically inside the existing admission lock.
    claimRunFanoutBatchWithCommit(ctx.budget, [`custody/${rootKey}/${launchId}`], () => {
      sweepStaleLaunchState(budgetDirectory, now);
      const sessionDir = path.join(budgetDirectory, 'custody-caps', 'session', safeKeySegment(sessionKey));
      const parallelDir = path.join(budgetDirectory, 'custody-caps', 'parallel', rootKey);
      const sessionCap = ctx.effectiveLimits.sessionCap;
      const parallelCap = ctx.effectiveLimits.parallel;
      if (countSlotFiles(sessionDir) >= sessionCap) {
        refuse(`session cap exhausted: ${sessionCap} live dispatched children for this session`);
      }
      if (countSlotFiles(parallelDir) >= parallelCap) {
        refuse(`parallel cap exhausted: ${parallelCap} live dispatched children for this root task`);
      }
      const sessionSlotPath = claimCapSlot(sessionDir, sessionCap, committedFiles);
      const parallelSlotPath = claimCapSlot(parallelDir, parallelCap, committedFiles);
      recordPath = path.join(budgetDirectory, 'custody-records', `${launchId}.json`);
      const sidecarPath = `${recordPath}.sidecar.json`;
      const ledgerPath = path.join(budgetDirectory, 'custody-launches', `${launchId}.json`);
      mkdirSync(path.join(budgetDirectory, 'custody-launches'), { recursive: true, mode: 0o700 });
      mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
      const ledger: LaunchLedgerV1 = {
        version: 1,
        launchId,
        child: input.child,
        parentKind: ctx.parentKind,
        launcherPid: process.pid,
        claimedAt: now,
        recordPath,
        sidecarPath,
        sessionKey: safeKeySegment(sessionKey),
        rootKey,
        sessionSlotPath,
        parallelSlotPath,
        fanoutClaimPath: `custody/${rootKey}/${launchId}`,
      };
      writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600, flag: 'wx' });
      committedFiles.push(ledgerPath);
      writeFileSync(recordPath, JSON.stringify(parsedRecord), { mode: 0o600, flag: 'wx' });
      committedFiles.push(recordPath);
      writeFileSync(sidecarPath, `${JSON.stringify({ launcherPid: process.pid, claimedAt: now })}\n`, { mode: 0o600, flag: 'wx' });
      committedFiles.push(sidecarPath);
    });
  } catch (error) {
    // 未准入 (or a partially committed admission): roll our own writes back so
    // no admission state survives a refusal. The fanout claim slots the
    // helper created are rolled back by the helper itself.
    for (const target of [...committedFiles].reverse()) {
      try {
        rmSync(target, { force: true });
      } catch {
        // Rollback is best effort.
      }
    }
    throw error;
  }

  // The child's environment IS the attested exec env; the custody commitments
  // ride on top as transport-only lifecycle names (never inside the projection
  // digests, so the entry-side exact-env comparison stays exact).
  const transportEnv: Record<string, string> = { ...execEnv };
  transportEnv[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV] = String(ctx.parentDepth);
  transportEnv[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV] = recordPath;
  if (input.child === 'pi-subagent-runner') {
    transportEnv[BYOK_SDK_CUSTODY_RUNNER_CONFIG_ENV] = input.runnerConfigPath!;
  }

  return {
    command: target.command,
    args: Object.freeze([...(target.entry === undefined ? [] : [target.entry]), ...fixedArgv]),
    env: transportEnv,
    launchId,
    recordPath,
    permitLaunch,
  };
}

/**
 * The entry-side liveness claim: a validated child (已spawn) removes the sweep
 * sidecar so a slow-but-alive child is never reclaimed. Best effort — the
 * launcher may already have swept the state.
 */
export function claimSpawnedLaunchLiveness(recordPath: string): void {
  try {
    rmSync(`${recordPath}.sidecar.json`, { force: true });
  } catch {
    // Already gone.
  }
}
