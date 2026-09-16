import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PiRpcClient } from '../adapters/pi/rpc-client';

const execFileAsync = promisify(execFile);

/**
 * The Pi RUNTIME child's half of the launch-cwd boundary.
 *
 * `pi-mcp-launch-cwd.test.ts` already holds this property for the MCP *server*
 * children the Pi child opens. Nothing holds it for the Pi runtime child
 * itself: both final spawn sites hand `PiRpcClient` the task manifest
 * directory as the process cwd —
 *
 *   - ordinary lane: `pi-adapter.ts:518`  (`cwd: manifestCwd`)
 *   - prepared lane: `pi-adapter.ts:747`  (`cwd: input.manifestCwd`)
 *
 * — and that directory is writable by the agent's own tools by design. A
 * bun-family interpreter (a `bun --compile` single-file runtime, or bun
 * running the sealed prepared entry) reads `$cwd/bunfig.toml` and runs its
 * `preload` and auto-loads `$cwd/.env` BEFORE the entry's own first line, so
 * no check inside the entry can stand in for a sealed launch cwd.
 *
 * These cases are RED until the C07 P2/P3 sealed launch description lands
 * (`tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md`). Pre-fix
 * evidence: `guards/pre-fix-claim-a.log` (root-cause-prover scratchpad), which
 * observed `INJECTED=PRELOAD_EXECUTED` and `DOTENV=DOTENV_LOADED` out of the
 * child.
 *
 * The full adapter path cannot be driven here without a live daemon, a paired
 * cloud and a real Pi runtime, so each lane drives `PiRpcClient` with the SAME
 * `{ command, args, cwd, env }` derivation the adapter performs at the cited
 * line, and asserts the property on the real child that derivation produces.
 * When P2 replaces the derivation with the sealed launch description,
 * `adapterProcessCwd` below is what changes — the assertions do not.
 */

const PRELOAD_GLOBAL = '__BYOK_LAUNCH_CWD_PRELOADED__';
const DOTENV_VAR = 'PI_CHILD_SEES_ENV_MARKER';
const DOTENV_VALUE = 'DOTENV_LOADED';
const RECORD_VAR = 'BYOK_PI_LAUNCH_CWD_RECORD_TO';

/**
 * bun, if this machine has one. Resolved once, synchronously, so every case
 * below is either RUN or visibly SKIPPED — never a body that returns early and
 * reports as a pass. Mirrors `pi-mcp-launch-cwd.test.ts`.
 */
const BUN_BIN = ((): string | undefined => {
  const candidates = [
    process.env.BYOK_TEST_BUN_BIN,
    path.join(os.homedir(), '.local/bin/bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) return candidate;
  }
  return undefined;
})();

/**
 * The Pi child's own report, read back out of the child rather than assumed:
 * the cwd it actually ran in, whether the cwd's `bunfig.toml` `preload` got to
 * run before it, and whether the cwd's `.env` reached its environment.
 */
interface ChildReport {
  readonly cwd: string;
  readonly preloaded: boolean;
  readonly dotenv: string;
}

/** The stand-in Pi runtime: reports the three facts above, then exits. */
const PI_ENTRY_SOURCE = [
  "import { writeFileSync } from 'node:fs';",
  `const recordTo = process.env.${RECORD_VAR};`,
  "if (recordTo === undefined) throw new Error('no record path');",
  'writeFileSync(recordTo, JSON.stringify({',
  '  cwd: process.cwd(),',
  `  preloaded: globalThis.${PRELOAD_GLOBAL} === true,`,
  `  dotenv: process.env.${DOTENV_VAR} ?? 'absent',`,
  '}));',
  '',
].join('\n');

/**
 * A directory shaped exactly like a canonical Agent home that the agent's own
 * write/bash tools have reached: this uid can write it, and it carries the two
 * pre-entry loader files a bun-family interpreter honours.
 */
async function plantedAgentHome(): Promise<string> {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-agent-home-')));
  await fs.writeFile(path.join(home, 'byok-preload.ts'), `globalThis.${PRELOAD_GLOBAL} = true;\n`);
  await fs.writeFile(path.join(home, 'bunfig.toml'), 'preload = ["./byok-preload.ts"]\n');
  await fs.writeFile(path.join(home, '.env'), `${DOTENV_VAR}=${DOTENV_VALUE}\n`);
  return home;
}

/**
 * The "release" the lanes launch from: a `bun --compile` single-file binary
 * (the ordinary lane's resolved Pi bin) plus the sealed prepared entry the
 * interpreter is handed on the prepared lane. Built once per file.
 */
let releaseOnce: Promise<{ compiledBin: string; preparedEntry: string }> | undefined;
function piRelease(): Promise<{ compiledBin: string; preparedEntry: string }> {
  releaseOnce ??= (async () => {
    const bun = BUN_BIN;
    if (bun === undefined) throw new Error('no bun on this machine');
    const release = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-release-')));
    await fs.writeFile(path.join(release, 'pi-entry.ts'), PI_ENTRY_SOURCE);
    await execFileAsync(bun, ['build', '--compile', './pi-entry.ts', '--outfile', './pi-compiled'], { cwd: release });
    const preparedEntry = path.join(release, 'byok-pi-prepared.mjs');
    await fs.writeFile(preparedEntry, PI_ENTRY_SOURCE);
    return { compiledBin: path.join(release, 'pi-compiled'), preparedEntry };
  })();
  return releaseOnce;
}

/**
 * The process cwd both final spawn sites derive today: the task manifest
 * directory, which for a Pi task is the canonical Agent home.
 *
 * `pi-adapter.ts:518` (ordinary) and `pi-adapter.ts:747` (prepared) pass
 * exactly this value to `PiRpcClient`. C07 P2/P3 replaces it with the sealed
 * launch cwd carried by the launch description; this function is the single
 * place these cases follow that move.
 */
function adapterProcessCwd(manifestCwd: string): string {
  return manifestCwd;
}

/** The env shape the adapter builds for the child, plus this test's report channel. */
function runtimeEnv(recordTo: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
    [RECORD_VAR]: recordTo,
  };
}

/** Spawn the child through the real `PiRpcClient` and read its report back. */
async function launch(options: { command: string; args: string[]; cwd: string }): Promise<ChildReport> {
  const recordDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-record-'));
  const recordTo = path.join(recordDir, 'record.json');
  const rpc = new PiRpcClient({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: runtimeEnv(recordTo),
  });
  await rpc.waitClosed();
  const raw = await fs.readFile(recordTo, 'utf8');
  return JSON.parse(raw) as ChildReport;
}

describe('Pi runtime child — launch cwd', () => {
  // The vector needs a real bun-family interpreter; without one there is
  // nothing to observe, so the case is visibly skipped rather than passed.
  it.skipIf(BUN_BIN === undefined)(
    'ordinary lane (pi-adapter.ts:518) leaves the Agent home bunfig preload and .env unreachable',
    async () => {
      const home = await plantedAgentHome();
      const { compiledBin } = await piRelease();

      const report = await launch({
        command: compiledBin,
        args: ['--mode', 'rpc'],
        cwd: adapterProcessCwd(home),
      });

      expect(report.preloaded).toBe(false);
      expect(report.dotenv).toBe('absent');
      expect(await fs.realpath(report.cwd)).not.toBe(home);
    },
    120_000,
  );

  it.skipIf(BUN_BIN === undefined)(
    'prepared lane (pi-adapter.ts:747) leaves the Agent home bunfig preload and .env unreachable',
    async () => {
      const home = await plantedAgentHome();
      const { preparedEntry } = await piRelease();
      const configPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-prepared-')), 'config.json');
      await fs.writeFile(configPath, JSON.stringify({ launch: {}, mcp: {} }), { mode: 0o600 });

      // The prepared lane hands the interpreter the sealed entry; under S2 the
      // interpreter IS the bun-family runtime, which is why `process.execPath`
      // is stood in for by bun here.
      const report = await launch({
        command: BUN_BIN!,
        args: [preparedEntry, '--config', configPath],
        cwd: adapterProcessCwd(home),
      });

      expect(report.preloaded).toBe(false);
      expect(report.dotenv).toBe('absent');
      expect(await fs.realpath(report.cwd)).not.toBe(home);
    },
    120_000,
  );

  // The control. Same planted files, same interpreter, same `PiRpcClient`
  // spawn — with the cwd named explicitly as a writable directory that holds
  // them. If this does not fire, the two lane cases above prove nothing.
  it.skipIf(BUN_BIN === undefined)(
    'control: the planted preload and .env DO fire when the child runs in a writable directory holding them',
    async () => {
      const hostile = await plantedAgentHome();
      const { compiledBin } = await piRelease();

      const report = await launch({ command: compiledBin, args: [], cwd: hostile });

      expect(report.preloaded).toBe(true);
      expect(report.dotenv).toBe(DOTENV_VALUE);
      expect(await fs.realpath(report.cwd)).toBe(hostile);
    },
    120_000,
  );
});
