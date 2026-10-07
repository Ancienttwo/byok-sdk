/**
 * WP4 print direct-connect entry (`pi-subagent-print` helper re-entry).
 *
 * Every physical print child is minted by the custody dispatcher
 * (`custody/custody-dispatcher.ts` — the only mint and dispatch authority),
 * which spawns the helper direct-connect shape `node <bundle>
 * __byok_sdk_helper pi-subagent-print`; the SDK-reserved helper host routes
 * that argv to `runAttestedPiSubagentPrintFromEnvironment` here. The WP3
 * `PI_SUBAGENT_PI_BINARY` seam and its argv-template-gated preset entry are
 * retired, so this module has no shebang and no direct-execution main: it is
 * only ever imported, never executed as a script, and importing it has no
 * side effect (a module-init CLI guard here ran inside every consumer bundle).
 *
 * Depth authority is the SDK frozen counting table alone (owner ruling
 * 2026-09-17): the runner->print bootstrap edge charges zero, so the print
 * child's contract depth is exactly the runner's contract depth. The parent's
 * contract depth arrives as the parent-minted environment commitment
 * `BYOK_SDK_CUSTODY_PARENT_DEPTH`; the vendor's own `PI_SUBAGENT_DEPTH`
 * increment is discarded at the reroute sites and never read here.
 *
 * The per-launch record (`byok.descendant-launch`) is minted by the
 * dispatcher and handed over through the `BYOK_SDK_CUSTODY_LAUNCH_RECORD`
 * path commitment. The entry re-stamps the depth from the commitment (never
 * from the vendor), validates the record against that commitment, runs the
 * identity module's `validateDescendantSpawn` + `assertDescendantSpawn`, and
 * only then proceeds: when the validated template describes exactly the
 * running process (the dispatcher always mints this shape) the
 * spawned-liveness sidecar is claimed and the delegated payload runs
 * in-process; any other template execs the attested target. Every gate is
 * fail-closed: a missing commitment, a non-integer commitment, an
 * unreadable record or any validation refusal refuses without execing
 * anything. There is no fallback path.
 */
import { activateVerifiedCustodyParent } from './external-cli-authority';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  assertDescendantSpawn,
  DescendantLaunchError,
  parseDescendantLaunch,
  validateDescendantSpawn,
  type PiDescendantLaunchV2,
} from '@byok-sdk/implementation-identity';
import {
  BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV,
  deriveCustodyExpectation,
  loadCustodyLaunchRecord,
  parseCustodyParentDepthCommitment,
  refusal,
} from './custody-commitments';
import { claimSpawnedLaunchLiveness } from './custody-dispatcher';
import { isSelfReentrySpawn } from './custody-self-reentry';

/** Frozen counting table: the runner->print bootstrap edge charges zero. */
const PRINT_ENTRY_BOOTSTRAP_CHARGE = 0;

/**
 * Project the attested exec environment to EXACTLY the record's declared
 * names: declared per-launch values first, then the template's controlled
 * directory commitments, then the observed environment. The vendor-spread
 * environment is never forwarded wholesale; every name is declared or the
 * entry refuses. Finally the bootstrap re-stamp overwrites the depth from
 * the parent commitment.
 */
export function projectAttestedPrintExecEnv(
  launch: PiDescendantLaunchV2,
  parentDepth: number,
  observedEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const { exactNames, envValues, controlledDirValues } = launch.perLaunch;
  const execEnv: Record<string, string> = {};
  for (const name of exactNames) {
    const declared = Object.hasOwn(envValues, name) ? envValues[name] : undefined;
    const committed = controlledDirValues[name];
    const value = declared !== undefined && declared !== null ? declared : committed !== undefined ? committed : observedEnv[name];
    if (value === undefined) {
      refusal(`declared exec environment name ${name} has no value`);
    }
    execEnv[name] = value;
  }
  const printDepth = parentDepth + PRINT_ENTRY_BOOTSTRAP_CHARGE;
  if (!Object.hasOwn(execEnv, 'PI_SUBAGENT_DEPTH')) {
    refusal('launch record does not declare PI_SUBAGENT_DEPTH in exactNames');
  }
  const declaredDepth = Object.hasOwn(envValues, 'PI_SUBAGENT_DEPTH') && envValues.PI_SUBAGENT_DEPTH !== null
    ? envValues.PI_SUBAGENT_DEPTH
    : undefined;
  if (declaredDepth !== undefined && declaredDepth !== String(printDepth)) {
    refusal(`bootstrap re-stamp ${printDepth} disagrees with the record's declared depth ${declaredDepth}`);
  }
  execEnv.PI_SUBAGENT_DEPTH = String(printDepth);
  return execEnv;
}

export interface AttestedPiSubagentPrintLaunchInput {
  /** The parent-minted record JSON (shape-checked here, fail-closed). */
  readonly launch: unknown;
  /** The runner's contract depth from the environment commitment. */
  readonly parentDepth: number;
  /** The entry's own process environment (vendor-spread; projected, not forwarded). */
  readonly observedEnv: Readonly<Record<string, string | undefined>>;
  /** Exec override for unit tests; the product default spawns for real. */
  readonly spawnImpl?: (command: string, args: readonly string[], options: { readonly cwd: string; readonly env: Record<string, string> }) => Promise<number>;
  /**
   * WP4: the in-bundle print payload, invoked INSTEAD of the trampoline exec
   * when the validated template describes exactly the running process (the
   * dispatcher always mints this shape). Lazy: it is imported only when a
   * self-reentry actually happens.
   */
  readonly payloadRunner?: (launch: PiDescendantLaunchV2) => Promise<number>;
  /** The launch record path commitment, for the spawned-liveness claim. */
  readonly recordPath?: string;
}

/**
 * THE single attested exec point for the print bootstrap edge. Validates the
 * per-launch record against the parent commitment, re-measures the attested
 * target immediately before the exec, and only then execs it — or, when the
 * validated template IS this process (the dispatcher's helper re-entry
 * shape), claims the spawned-liveness sidecar and runs the payload
 * in-process.
 */
export async function launchAttestedPiSubagentPrint(input: AttestedPiSubagentPrintLaunchInput): Promise<number> {
  const { parentDepth, observedEnv } = input;
  if (!Number.isSafeInteger(parentDepth) || parentDepth < 0) {
    refusal('parent depth commitment is not a safe non-negative integer');
  }
  let launch: PiDescendantLaunchV2;
  try {
    launch = parseDescendantLaunch(input.launch);
  } catch (error) {
    if (error instanceof DescendantLaunchError) refusal(`invalid descendant launch record: ${error.reason}`);
    throw error;
  }
  const template = launch.template;
  const expected = deriveCustodyExpectation(launch, parentDepth);
  const execEnv = projectAttestedPrintExecEnv(launch, parentDepth, observedEnv);
  const actual = { command: template.command, entry: template.entry, fixedArgv: template.fixedArgv, cwd: template.cwd, env: execEnv };
  try {
    validateDescendantSpawn(launch, expected, actual);
  } catch (error) {
    if (error instanceof DescendantLaunchError) refusal(`descendant spawn validation failed: ${error.reason}`);
    throw error;
  }
  try {
    await assertDescendantSpawn(launch, expected, actual);
  } catch (error) {
    refusal(`attested implementation reverification failed: ${(error as Error).message}`);
  }
  if (input.payloadRunner !== undefined && isSelfReentrySpawn(template)) {
    // 已spawn: this process is the attested child. Claim liveness (the sweep
    // sidecar goes away) and run the delegated task in-process.
    if (input.recordPath !== undefined) claimSpawnedLaunchLiveness(input.recordPath);
    activateVerifiedCustodyParent(launch);
    return input.payloadRunner(launch);
  }
  const exec = input.spawnImpl ?? defaultAttestedExec;
  return exec(template.command, [...(template.entry !== undefined ? [template.entry] : []), ...template.fixedArgv], { cwd: template.cwd, env: execEnv });
}

function defaultAttestedExec(command: string, args: readonly string[], options: { readonly cwd: string; readonly env: Record<string, string> }): Promise<number> {
  return new Promise((resolve) => {
    const child = nodeSpawn(command, args, { cwd: options.cwd, env: options.env, stdio: 'inherit' });
    child.once('error', (error) => {
      process.stderr.write(`pi-subagent-print entry: attested exec failed: ${error.message}\n`);
      resolve(1);
    });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

/** Dispatcher entry: the helper host's print branch (direct argv shape). */
export async function runAttestedPiSubagentPrintFromEnvironment(env: Readonly<Record<string, string | undefined>>): Promise<number> {
  const parentDepth = parseCustodyParentDepthCommitment(env);
  const launch = loadCustodyLaunchRecord(env);
  const recordPath = typeof env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV] === 'string'
    ? env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV] as string
    : undefined;
  return launchAttestedPiSubagentPrint({
    launch,
    parentDepth,
    observedEnv: env,
    recordPath,
    payloadRunner: async (validated) => {
      // Lazy: the payload (and its pi session machinery) loads only when a
      // self-reentry actually runs.
      const payload = await import('./pi-subagent-print-payload');
      return payload.runPiSubagentPrintPayload(validated);
    },
  });
}
