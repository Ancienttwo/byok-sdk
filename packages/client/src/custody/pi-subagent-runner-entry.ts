/**
 * WP4 same-bundle runner preset entry (`pi-subagent-runner` dispatch edge).
 *
 * Unlike the print leaf, the runner lane has no vendor spawn seam to preset:
 * the vendor's background runner is spawned by its own launch code
 * (`runs/background/async-execution.ts`), and no `PI_SUBAGENT_*_BINARY`-style
 * seam intercepts it. This entry is therefore reached ONLY through the
 * helper host's direct `__byok_sdk_helper pi-subagent-runner` argv shape
 * (`sdk-reserved-helper-host.ts`) — the same single-file/SEA re-entry shape
 * every SDK-reserved helper uses, which is cross-platform by construction.
 * Because the invocation shape is fixed by the host, there is no pi-style
 * argv template gate here and no shebang/direct-execution main: this module
 * is only ever imported, never executed as a script.
 *
 * Depth authority is the SDK frozen counting table alone (owner ruling
 * 2026-09-17), and BOTH runner bootstrap edges charge one — rpc->runner = 1
 * and print->runner = 1 — so this entry re-stamps the child's
 * `PI_SUBAGENT_DEPTH` from the parent-minted `BYOK_SDK_CUSTODY_PARENT_DEPTH`
 * commitment plus one, and refuses a record whose declared depth disagrees
 * with that re-stamp (the +1 is exactly what `validateDescendantSpawn`
 * independently expects for a non-bootstrap edge, so a forged record cannot
 * pass by rounding the commitment down).
 *
 * The per-launch record (`byok.descendant-launch`) is minted by the parent
 * from the verified launch and handed over through the
 * `BYOK_SDK_CUSTODY_LAUNCH_RECORD` path commitment. The entry validates the
 * record against the parent commitment, runs the identity module's
 * `validateDescendantSpawn` + `assertDescendantSpawn` (physical bytes and
 * stat tuple re-measured immediately before the exec), and only then execs
 * the attested target through the single attested exec point
 * `launchAttestedPiSubagentRunner`. Every gate is fail-closed: a missing
 * commitment, a non-integer commitment, an unreadable record or any
 * validation refusal exits nonzero without execing anything. There is no
 * fallback path, and nothing here reroutes a vendor spawn site — enabling
 * the vendor runner lane is the later five-edge cut (plan 1459), not this
 * groundwork slice.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import {
  assertDescendantSpawn,
  DescendantLaunchError,
  parseDescendantLaunch,
  validateDescendantSpawn,
  type DescendantLaunchV1,
} from '@byok-sdk/implementation-identity';
import {
  deriveCustodyExpectation,
  loadCustodyLaunchRecord,
  parseCustodyParentDepthCommitment,
  refusal,
} from './custody-commitments';

/** Frozen counting table: every runner bootstrap edge charges one (rpc->runner = 1, print->runner = 1). */
const RUNNER_ENTRY_BOOTSTRAP_CHARGE = 1;

/**
 * Project the attested exec environment to EXACTLY the record's declared
 * names: declared per-launch values first, then the template's controlled
 * directory commitments, then the observed environment. The host-spread
 * environment is never forwarded wholesale; every name is declared or the
 * entry refuses. Finally the bootstrap re-stamp overwrites the depth from
 * the parent commitment plus this edge's charge.
 */
export function projectAttestedRunnerExecEnv(
  launch: DescendantLaunchV1,
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
  const runnerDepth = parentDepth + RUNNER_ENTRY_BOOTSTRAP_CHARGE;
  if (!Object.hasOwn(execEnv, 'PI_SUBAGENT_DEPTH')) {
    refusal('launch record does not declare PI_SUBAGENT_DEPTH in exactNames');
  }
  const declaredDepth = Object.hasOwn(envValues, 'PI_SUBAGENT_DEPTH') && envValues.PI_SUBAGENT_DEPTH !== null
    ? envValues.PI_SUBAGENT_DEPTH
    : undefined;
  if (declaredDepth !== undefined && declaredDepth !== String(runnerDepth)) {
    refusal(`bootstrap re-stamp ${runnerDepth} disagrees with the record's declared depth ${declaredDepth}`);
  }
  execEnv.PI_SUBAGENT_DEPTH = String(runnerDepth);
  return execEnv;
}

export interface AttestedPiSubagentRunnerLaunchInput {
  /** The parent-minted record JSON (shape-checked here, fail-closed). */
  readonly launch: unknown;
  /** The dispatching parent's contract depth from the environment commitment. */
  readonly parentDepth: number;
  /** The entry's own process environment (host-spread; projected, not forwarded). */
  readonly observedEnv: Readonly<Record<string, string | undefined>>;
  /** Exec override for unit tests; the product default spawns for real. */
  readonly spawnImpl?: (command: string, args: readonly string[], options: { readonly cwd: string; readonly env: Record<string, string> }) => Promise<number>;
}

/**
 * THE single attested exec point for the runner bootstrap edge. Validates the
 * per-launch record against the parent commitment, re-measures the attested
 * target immediately before the exec, and only then execs it.
 */
export async function launchAttestedPiSubagentRunner(input: AttestedPiSubagentRunnerLaunchInput): Promise<number> {
  const { parentDepth, observedEnv } = input;
  if (!Number.isSafeInteger(parentDepth) || parentDepth < 0) {
    refusal('parent depth commitment is not a safe non-negative integer');
  }
  let launch: DescendantLaunchV1;
  try {
    launch = parseDescendantLaunch(input.launch);
  } catch (error) {
    if (error instanceof DescendantLaunchError) refusal(`invalid descendant launch record: ${error.reason}`);
    throw error;
  }
  const template = launch.template;
  const expected = deriveCustodyExpectation(launch, parentDepth);
  const execEnv = projectAttestedRunnerExecEnv(launch, parentDepth, observedEnv);
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
  const exec = input.spawnImpl ?? defaultAttestedExec;
  return exec(template.command, [...template.fixedArgv], { cwd: template.cwd, env: execEnv });
}

function defaultAttestedExec(command: string, args: readonly string[], options: { readonly cwd: string; readonly env: Record<string, string> }): Promise<number> {
  return new Promise((resolve) => {
    const child = nodeSpawn(command, args, { cwd: options.cwd, env: options.env, stdio: 'inherit' });
    child.once('error', (error) => {
      process.stderr.write(`pi-subagent-runner entry: attested exec failed: ${error.message}\n`);
      resolve(1);
    });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

/** Dispatcher entry: the helper host's runner branch (the only way in — no seam, no script shape). */
export async function runAttestedPiSubagentRunnerFromEnvironment(env: Readonly<Record<string, string | undefined>>): Promise<number> {
  const parentDepth = parseCustodyParentDepthCommitment(env);
  const launch = loadCustodyLaunchRecord(env);
  return launchAttestedPiSubagentRunner({ launch, parentDepth, observedEnv: env });
}
