#!/usr/bin/env bun
/**
 * WP3 charge-once print preset entry (`pi-subagent-print` bootstrap edge).
 *
 * The vendored pi-subagents runtime spawns every physical print child through
 * its own `getPiSpawnCommand` seam (`runs/shared/pi-spawn.ts`): when
 * `PI_SUBAGENT_PI_BINARY` is set, that value is spawned directly, verbatim, as
 * the whole command. The SDK presets that seam with THIS file (the print
 * preset entry), so the vendor's unconditional `getSubagentDepthEnv` depth
 * increment (the double-charge: one logical delegation charged twice) is
 * applied to this entry instead of to the real runtime — and this entry
 * discards it.
 *
 * Depth authority is the SDK frozen counting table alone (owner ruling
 * 2026-09-17): the runner->print bootstrap edge charges zero, so the print
 * child's contract depth is exactly the runner's contract depth. The runner's
 * contract depth arrives as the parent-minted environment commitment
 * `BYOK_SDK_CUSTODY_PARENT_DEPTH`; the vendor's own `PI_SUBAGENT_DEPTH` is
 * never read.
 *
 * The per-launch record (`byok.descendant-launch`) is minted by the parent
 * from the verified runner launch and handed to the entry through the
 * `BYOK_SDK_CUSTODY_LAUNCH_RECORD` path commitment. The entry re-stamps the
 * depth from the commitment (never from the record, never from the vendor),
 * validates the record against that commitment, runs the identity module's
 * `validateDescendantSpawn` + `assertDescendantSpawn` (first real product
 * caller), and only then execs the attested target through the single
 * attested exec point `launchAttestedPiSubagentPrint`. Every gate is
 * fail-closed: a missing commitment, a non-integer commitment, an argv
 * mismatch, an unreadable record or any validation refusal exits nonzero
 * without execing anything. There is no fallback path.
 *
 * Direct executable shape (shebang above): the vendor spawns this file by
 * absolute path, so it must stay a directly executable artifact. Windows
 * cannot spawn a script file through `child_process.spawn` without a shell,
 * so the seam shape is POSIX-only in this slice (registered in
 * `tasks/todos.md` for Windows coverage).
 *
 * WP4 (contract 20260917-2002) extracted the commitment core shared with the
 * runner entry into `custody-commitments.ts`; this module re-exports the
 * moved names under their original print-entry spellings so the existing
 * import surface (tests included) keeps working unchanged.
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

// Moved to the shared custody commitment core; re-exported under the original
// print-entry spellings so existing imports of this module keep working.
export {
  BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV,
  BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV,
  parseCustodyParentDepthCommitment,
  loadCustodyLaunchRecord,
} from './custody-commitments';
export { PiSubagentCustodyRefusalError as PiSubagentPrintRefusalError } from './custody-commitments';
export { deriveCustodyExpectation as derivePrintExpectation } from './custody-commitments';

/**
 * The registered pi-style argv template of the vendor's print invocation
 * (`buildPiArgs` base args for print mode). The vendor's exact tail is
 * environment-dependent (session, prompt and task files), so the gate pins
 * the stable prefix positionally and refuses any other shape.
 */
export const PRINT_ENTRY_REGISTERED_ARGV_TEMPLATE: readonly string[] = Object.freeze(['--mode', 'json', '-p']);

/** Frozen counting table: the runner->print bootstrap edge charges zero. */
const PRINT_ENTRY_BOOTSTRAP_CHARGE = 0;

/** Bitwise argv-template gate against the registered pi-style prefix. */
export function assertPrintEntryArgvTemplate(argv: readonly string[]): void {
  const template = PRINT_ENTRY_REGISTERED_ARGV_TEMPLATE;
  if (argv.length < template.length) {
    refusal(`argv template mismatch: expected the ${JSON.stringify([...template])} prefix, got ${argv.length} argument(s)`);
  }
  for (const [index, expected] of template.entries()) {
    if (argv[index] !== expected) {
      refusal(`argv template mismatch at position ${index}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(argv[index])}`);
    }
  }
  for (const argument of argv) {
    if (argument.length === 0 || /[\u0000\r\n]/u.test(argument)) {
      refusal('argv template mismatch: empty or control-bearing argument');
    }
  }
}

/**
 * Project the attested exec environment to EXACTLY the record's declared
 * names: declared per-launch values first, then the template's controlled
 * directory commitments, then the observed environment. The vendor-spread
 * environment is never forwarded wholesale; every name is declared or the
 * entry refuses. Finally the bootstrap re-stamp overwrites the depth from
 * the parent commitment.
 */
export function projectAttestedPrintExecEnv(
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
}

/**
 * THE single attested exec point for the print bootstrap edge. Validates the
 * per-launch record against the parent commitment, re-measures the attested
 * target immediately before the exec, and only then execs it. Both transport
 * shapes funnel here: this slice's env-seam preset entry and WP4's
 * fixedArgv direct connect.
 */
export async function launchAttestedPiSubagentPrint(input: AttestedPiSubagentPrintLaunchInput): Promise<number> {
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
  const exec = input.spawnImpl ?? defaultAttestedExec;
  return exec(template.command, [...template.fixedArgv], { cwd: template.cwd, env: execEnv });
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

/** Dispatcher entry: the helper host's print branch (direct argv shape, no pi-style gate). */
export async function runAttestedPiSubagentPrintFromEnvironment(env: Readonly<Record<string, string | undefined>>): Promise<number> {
  const parentDepth = parseCustodyParentDepthCommitment(env);
  const launch = loadCustodyLaunchRecord(env);
  return launchAttestedPiSubagentPrint({ launch, parentDepth, observedEnv: env });
}

/** Full env-seam preset entry flow: argv template gate first, then the attested launch. */
export async function runPiSubagentPrintEntry(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> {
  assertPrintEntryArgvTemplate(argv);
  return runAttestedPiSubagentPrintFromEnvironment(env);
}

/**
 * CLI self-execution guard. `import.meta.main` is the only safe signal here:
 * a `process.argv[1]`/`import.meta.url` realpath comparison collapses once
 * this module is bundled into a host artifact (the bundler rewrites
 * `import.meta.url` to the bundle's own path, so every consumer bundle would
 * execute the CLI flow). Bun sets `main` on the shebang-executed entry file
 * and leaves it false for statically imported modules, in bundles and in
 * test imports alike.
 */
function isDirectExecution(): boolean {
  return (import.meta as { main?: boolean }).main === true;
}

async function main(): Promise<number> {
  try {
    return await runPiSubagentPrintEntry(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`byok custody refusal: ${(error as Error).message}\n`);
    return 1;
  }
}

if (isDirectExecution()) void main().then((code) => process.exit(code));
