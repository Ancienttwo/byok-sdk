import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  descendantTemplateDigest,
  toolImplementationLaunchEnvNamesDigest,
  toolImplementationLoaderEnvValuesDigest,
  type DescendantLaunchV1,
  type ImplementationSpawnBindingV1,
} from '@byok-sdk/implementation-identity';
import {
  BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV,
  BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV,
} from '../custody/pi-subagent-print-entry';
import {
  BYOK_SDK_HELPER_SUBCOMMAND,
  runSdkReservedHelperCommand,
} from '../sdk-reserved-helper-host';

// WP3 charge-once wiring test (contract 20260917-1628-wp3-charge-once-wiring;
// red state introduced by contract 20260917-1545-wp3-charge-once-red, red
// evidence tasks/notes/20260917-1545-wp3-charge-once-red.red-run.txt).
//
// Frozen counting table (owner ruling 2026-09-17): one logical delegation
// charges exactly one depth level.
//   rpc->runner   = 1
//   rpc->print    = 1
//   runner->print = 0 (bootstrap: zero charge)
//   print->runner = 1
//   print->print  = 1
//
// Wiring under test (deep-reasoner Option A + Fable ruling): the vendor's
// getSubagentDepthEnv double-charge is intercepted at the vendor's own
// PI_SUBAGENT_PI_BINARY seam, which the SDK presets with the print preset
// entry (src/custody/pi-subagent-print-entry.ts). The entry gates the
// vendor-built pi-style argv against the registered template, re-stamps the
// depth from the parent's BYOK_SDK_CUSTODY_PARENT_DEPTH commitment (the
// runner->print bootstrap edge charges zero; the vendor's own computed depth
// is never read), validates the parent-minted descendant launch record
// against that commitment through validateDescendantSpawn +
// assertDescendantSpawn, and only then execs the attested target through the
// single attested exec point launchAttestedPiSubagentPrint. The vendored tree
// itself is byte-frozen and untouched.
//
// Chain drive (real vendor code paths, nothing below is depth-mocked):
//   1. The runner process is launched exactly like the vendor background spawn
//      (runs/background/async-execution.ts spawnRunner: node + jiti CLI +
//      config JSON path) with the custody per-launch projection
//      PI_SUBAGENT_DEPTH=1 (the frozen-table state after rpc->runner = 1).
//   2. The real runner (pi-subagents 0.60.0 subagent-runner.ts, the version
//      pinned by packages/client/package.json) resolves the step through
//      buildPiArgs and spawns the print child through the vendor's own launch
//      seam getPiSpawnCommand (runs/shared/pi-spawn.ts) — which now lands on
//      the print preset entry, with the vendor-spread child env (including
//      the parent depth commitment and the launch record path).
//   3. The print leaf is the attested exec target the parent sealed the
//      launch record against: a stand-in binary that records the projected
//      environment and exits 0, so no network or model key is needed.
//
// Assertions: the print child's observed PI_SUBAGENT_DEPTH must equal the
// contract value '1' (bootstrap re-stamp). The unfixed wiring observed '2'.
// Falsifier guard: chain-health assertions pin the run to the real vendor
// spawn (vendor-built argv and the vendor's own PI_SUBAGENT_CHILD marker),
// and the exec-env assertions pin the projection to the parent contract
// (vendor MAX_DEPTH '8' must NOT reach the attested exec), so a broken
// fixture fails loudly instead of faking a depth result.
//
// POSIX note: the vendor seam spawns the preset entry directly
// (getPiSpawnCommand returns PI_SUBAGENT_PI_BINARY verbatim as the command),
// so the entry must be a directly executable shebang script. Windows cannot
// spawn script files through child_process.spawn without a shell, so the
// spawn-driven cases in this file are explicitly skipped on win32; Windows
// coverage of the seam shape is registered in tasks/todos.md.

const clientRoot = path.resolve(import.meta.dirname, '../..');
const requireFromClient = createRequire(path.join(clientRoot, 'package.json'));
const runnerPath = realpathSync(
  path.join(clientRoot, 'node_modules/pi-subagents/src/runs/background/subagent-runner.ts'),
);
const printEntryPath = realpathSync(
  path.join(clientRoot, 'src/custody/pi-subagent-print-entry.ts'),
);

const RUNNER_CLOSE_TIMEOUT_MS = 120_000;
const CONTRACT_PRINT_DEPTH = '1';
const CONTRACT_PRINT_MAX_DEPTH = '3';
const RUNNER_CONTRACT_DEPTH = '1';

/** Mirror of runs/background/async-execution.ts resolveJitiCliPath. */
function resolveJitiCliPath(): string {
  const packageJsonPath = requireFromClient.resolve('jiti/package.json');
  const packageRoot = path.dirname(packageJsonPath);
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { bin?: string | Record<string, string> };
  const binPath = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.jiti ?? Object.values(pkg.bin ?? {})[0];
  for (const candidate of [binPath, 'lib/jiti-cli.mjs']) {
    if (candidate === undefined) continue;
    const cliPath = path.resolve(packageRoot, candidate);
    if (existsSync(cliPath)) return cliPath;
  }
  throw new Error(`jiti CLI not found under ${packageRoot}`);
}

interface ProbeRecord {
  argv: string[];
  env: Record<string, string>;
}

function spawnRunnerAndWait(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RUNNER_CLOSE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

interface PrintHarness {
  readonly home: string;
  readonly runnerEnvPath: string;
  readonly probeOutPath: string;
  readonly recordPath: string;
  readonly runnerEnv: NodeJS.ProcessEnv;
}

/**
 * Mint the parent side of the bootstrap edge: seal an attested identity over
 * the probe binary (real bytes, real stat tuple, real digests), declare the
 * exact attested exec environment, and write the per-launch descendant
 * record. Same minting logic the daemon performs from a verified parent
 * launch; the runner env preset is the SDK runner-env construction point.
 */
function mintPrintHarness(scratch: string): PrintHarness {
  const workspace = path.join(scratch, 'workspace');
  const home = path.join(scratch, 'home');
  const sessionsDir = path.join(scratch, 'sessions');
  const probeOutPath = path.join(scratch, 'print-env-probe.json');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });

  // Attested exec target stand-in: records the projected launch environment
  // and exits 0. The output path travels as the exec argv element after -p;
  // the last argv element is the frozen record convention (templateKind).
  const probeBinary = path.join(scratch, 'custody-depth-probe.mjs');
  writeFileSync(
    probeBinary,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'const argv = process.argv;',
      'const flagIndex = argv.indexOf("-p");',
      'const out = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;',
      'if (!out) { process.exit(3); }',
      'writeFileSync(out, JSON.stringify({ argv: argv.slice(1), env: process.env }, null, 2));',
      'process.exit(0);',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const probeReal = realpathSync(probeBinary);

  // The attested exec environment: exactly the declared exactNames, carrying
  // the contract projection the entry must reproduce (bootstrap re-stamp
  // computes PI_SUBAGENT_DEPTH from the parent commitment).
  const runnerEnvPath = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
  const execEnv = {
    HOME: home,
    PATH: runnerEnvPath,
    PI_CODING_AGENT_SESSION_DIR: sessionsDir,
    PI_SUBAGENT_CHILD: '1',
    PI_SUBAGENT_DEPTH: CONTRACT_PRINT_DEPTH,
    PI_SUBAGENT_MAX_DEPTH: CONTRACT_PRINT_MAX_DEPTH,
  };
  const fixedArgv = ['--mode', 'json', '-p', probeOutPath, 'pi-subagent-print'];

  const stubStat = lstatSync(probeReal);
  const identity = {
    kind: 'attested',
    authority: 'host-install-record',
    manifestRevision: 'custody-wp3-print-entry-probe-1',
    form: 'compiled-executable',
    installPath: probeReal,
    closureDigest: createHash('sha256').update(readFileSync(probeReal)).digest('hex'),
    closureKind: 'artifact',
    launchArgv: [...fixedArgv],
    launchCwd: workspace,
    launchEnvNamesDigest: toolImplementationLaunchEnvNamesDigest(execEnv),
    loaderEnvValuesDigest: toolImplementationLoaderEnvValuesDigest(execEnv),
    installStat: {
      dev: stubStat.dev,
      ino: stubStat.ino,
      size: stubStat.size,
      mtimeMs: stubStat.mtimeMs,
      mode: stubStat.mode,
      uid: stubStat.uid,
      gid: stubStat.gid,
    },
  } satisfies ImplementationSpawnBindingV1['identity'];

  const template = {
    format: 'byok.implementation-spawn',
    version: 1,
    identity,
    command: probeReal,
    fixedArgv,
    cwd: workspace,
    envCommitments: { PI_CODING_AGENT_SESSION_DIR: sessionsDir },
  } satisfies ImplementationSpawnBindingV1;

  const exactNames = Object.freeze(Object.keys(execEnv).sort());
  const record: DescendantLaunchV1 = {
    format: 'byok.descendant-launch',
    version: 1,
    template,
    templateDigest: descendantTemplateDigest(template),
    policy: {
      envNameAllowlist: [...exactNames],
      maxDepth: 3,
      fanout: 7,
      parallel: 2,
      sessionCap: 11,
    },
    perLaunch: {
      format: 'byok.runtime-descendant-context',
      version: 1,
      templateKind: 'pi-subagent-print',
      edge: { parent: 'pi-subagent-runner', child: 'pi-subagent-print' },
      rootTaskId: 'custody-charge-once-root',
      parentInstancePath: [0],
      instancePath: [0],
      depth: 1,
      remainingDepth: 2,
      effectiveLimits: { maxDepth: 3, fanout: 5, parallel: 2, sessionCap: 8 },
      task: 'Report the custody depth projection.',
      modelCandidates: [{ provider: 'custody-probe', model: 'stub' }],
      attempt: 0,
      session: { cwd: workspace, root: sessionsDir, file: null },
      mcp: { env: {}, metadata: {} },
      envValues: {
        PI_SUBAGENT_CHILD: '1',
        PI_SUBAGENT_DEPTH: CONTRACT_PRINT_DEPTH,
        PI_SUBAGENT_MAX_DEPTH: CONTRACT_PRINT_MAX_DEPTH,
      },
      exactNames,
      controlledDirValues: { PI_CODING_AGENT_SESSION_DIR: sessionsDir },
    },
  };
  const recordPath = path.join(scratch, 'print-launch-record.json');
  writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });

  // SDK runner-env construction point: the vendor background spawn preset
  // with the print preset entry seam, the runner's contract depth commitment
  // (rpc->runner = 1) and the per-launch record path. The vendor's own
  // PI_SUBAGENT_DEPTH projection stays at the frozen-table state 1; the
  // vendor's bootstrap increment happens below this point and is discarded
  // by the entry.
  const runnerEnv: NodeJS.ProcessEnv = {
    PATH: runnerEnvPath,
    HOME: home,
    TMPDIR: path.join(scratch, 'tmp'),
    LANG: process.env.LANG ?? '',
    TZ: 'UTC',
    PI_SUBAGENT_DEPTH: RUNNER_CONTRACT_DEPTH,
    PI_SUBAGENT_MAX_DEPTH: '8',
    PI_SUBAGENT_PI_BINARY: printEntryPath,
    [BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV]: RUNNER_CONTRACT_DEPTH,
    [BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]: recordPath,
  };
  return { home, runnerEnvPath, probeOutPath, recordPath, runnerEnv };
}

/** Runner config: same shape spawnRunner writes for the background runner. */
function writeRunnerConfig(scratch: string, workspace: string, asyncDir: string): string {
  const config = {
    id: 'custody-charge-once-probe',
    steps: [
      {
        agent: 'custody-print-probe',
        task: 'Report the custody depth projection.',
        inheritProjectContext: false,
        inheritGlobalContext: false,
        inheritSkills: false,
      },
    ],
    resultPath: path.join(asyncDir, 'result.json'),
    cwd: workspace,
    placeholder: '',
    asyncDir,
    mode: 'single',
  };
  const configPath = path.join(scratch, 'runner-config.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return configPath;
}

// Windows cannot spawn the shebang preset entry through the vendor seam
// (child_process.spawn has no script-file association there), so the
// spawn-driven cases are POSIX-only in this slice. Skipped, not weakened:
// Windows coverage of the seam shape is registered in tasks/todos.md.
const skipOnWin32 = process.platform === 'win32';

describe('custody charge-once: one logical delegation charges one depth level', () => {
  (skipOnWin32 ? it.skip : it)('print child observes the contract depth projection 1 after rpc->runner->print', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-custody-charge-once-'));
    try {
      const workspace = path.join(scratch, 'workspace');
      const asyncDir = path.join(scratch, 'async-dir');
      mkdirSync(asyncDir, { recursive: true });
      const harness = mintPrintHarness(scratch);
      const configPath = writeRunnerConfig(scratch, workspace, asyncDir);

      const run = await spawnRunnerAndWait(
        'node',
        [resolveJitiCliPath(), runnerPath, configPath],
        { cwd: workspace, env: harness.runnerEnv },
      );

      // Chain health first: the depth assertion is only meaningful when the
      // real vendor chain ran end to end through the preset entry and the
      // attested exec. A runner crash here is a harness error, not the
      // double-charge signal.
      expect(run.timedOut, `runner timed out\nstderr:\n${run.stderr}`).toBe(false);
      expect(run.code, `runner exited ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
      expect(existsSync(harness.probeOutPath), 'attested exec never ran: the custody chain did not reach the print child').toBe(true);
      const probe = JSON.parse(readFileSync(harness.probeOutPath, 'utf8')) as ProbeRecord;
      expect(probe.argv, 'child argv is not the vendor print invocation').toEqual(
        expect.arrayContaining(['--mode', 'json', '-p']),
      );
      expect(probe.env.PI_SUBAGENT_CHILD, 'the vendor child marker did not reach the attested exec').toBe('1');
      // The attested exec environment is the parent's contract projection,
      // not the vendor-spread environment: the vendor's own MAX_DEPTH '8'
      // and the control commitments must not leak past the exec point.
      expect(probe.env.PI_SUBAGENT_MAX_DEPTH).toBe(CONTRACT_PRINT_MAX_DEPTH);
      expect(probe.env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV]).toBeUndefined();
      expect(probe.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]).toBeUndefined();
      expect(probe.env.PI_SUBAGENT_PI_BINARY).toBeUndefined();

      // THE contract assertion: runner->print is a zero-charge bootstrap
      // edge, so the print child must observe the contract depth 1,
      // re-stamped from the parent commitment. The unfixed vendor wiring
      // increments at every physical spawn and observes 2.
      expect(probe.env.PI_SUBAGENT_DEPTH).toBe(CONTRACT_PRINT_DEPTH);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);

  (skipOnWin32 ? it.skip : it)('refuses when the parent depth commitment is missing', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-custody-charge-once-'));
    try {
      const harness = mintPrintHarness(scratch);
      const env: NodeJS.ProcessEnv = { PATH: harness.runnerEnvPath, HOME: harness.home };
      env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV] = harness.recordPath;
      const result = spawnSync(printEntryPath, ['--mode', 'json', '-p', harness.probeOutPath], {
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).not.toBe(0);
      expect(result.stderr).toContain(`${BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV} missing`);
      expect(existsSync(harness.probeOutPath), 'the attested exec must not run without the commitment').toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  (skipOnWin32 ? it.skip : it)('refuses vendor argv that does not match the registered pi-style template', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-custody-charge-once-'));
    try {
      const harness = mintPrintHarness(scratch);
      const env: NodeJS.ProcessEnv = { PATH: harness.runnerEnvPath, HOME: harness.home };
      env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV] = RUNNER_CONTRACT_DEPTH;
      env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV] = harness.recordPath;
      const result = spawnSync(printEntryPath, ['--mode', 'yaml', '-p', harness.probeOutPath], {
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).not.toBe(0);
      expect(result.stderr).toContain('argv template mismatch');
      expect(existsSync(harness.probeOutPath), 'the attested exec must not run on an argv mismatch').toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  // WP4 runner groundwork moved this pin: the runner branch now routes to the
  // attested exec point (custody/pi-subagent-runner-entry.ts) exactly like the
  // print branch above, still reachable only through the direct helper argv
  // shape, and still fails closed without the parent custody commitments.
  it('routes the runner edge to the attested exec point, which refuses without the custody commitments', async () => {
    delete process.env.BYOK_SDK_CUSTODY_PARENT_DEPTH;
    delete process.env.BYOK_SDK_CUSTODY_LAUNCH_RECORD;
    await expect(runSdkReservedHelperCommand([BYOK_SDK_HELPER_SUBCOMMAND, 'pi-subagent-runner'])).rejects.toThrow(
      'BYOK_SDK_CUSTODY_PARENT_DEPTH missing');
  });
});
