import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
} from '../custody/custody-commitments';
import {
  launchAttestedPiSubagentRunner,
  runAttestedPiSubagentRunnerFromEnvironment,
} from '../custody/pi-subagent-runner-entry';
import {
  BYOK_SDK_HELPER_SUBCOMMAND,
  runSdkReservedHelperCommand,
} from '../sdk-reserved-helper-host';

// WP4 runner groundwork test (contract 20260917-2002): the runner dispatch
// edge gets the same attested-exec-point discipline the WP3 print entry has,
// reached ONLY through the helper host's direct `__byok_sdk_helper
// pi-subagent-runner` argv shape. Frozen counting table: BOTH runner
// bootstrap edges charge one (rpc->runner = 1, print->runner = 1), so the
// entry re-stamps PI_SUBAGENT_DEPTH from the parent commitment + 1 and
// refuses a record declaring anything else.
//
// Unlike the print seam, this entry has no shebang/script shape, so every
// case here drives it cross-platform: in-process for the unit gates, and
// through `process.execPath` + a tiny dispatch stub that re-enters
// runSdkReservedHelperCommand for the process-boundary refusals. No
// it.skip without a POSIX-only reason — nothing in this file needs one.

const clientRoot = path.resolve(import.meta.dirname, '../..');
const helperHostPath = path.resolve(clientRoot, 'src/sdk-reserved-helper-host.ts');

/** The dispatching parent's contract depth: the rpc entry sits at depth 0. */
const PARENT_CONTRACT_DEPTH = '0';
const RUNNER_CONTRACT_DEPTH = '1';

interface ProbeRecord {
  argv: string[];
  env: Record<string, string>;
}

interface RunnerHarness {
  readonly home: string;
  readonly runnerEnvPath: string;
  readonly probeOutPath: string;
  readonly probeReal: string;
  readonly recordPath: string;
  readonly runnerEnv: NodeJS.ProcessEnv;
  readonly execEnv: Record<string, string>;
  readonly exactNames: readonly string[];
  readonly record: DescendantLaunchV1;
}

/**
 * Mint the parent side of a runner bootstrap edge: seal an attested identity
 * over the probe binary (real bytes, real stat tuple, real digests), declare
 * the exact attested exec environment, and write the per-launch descendant
 * record. Same minting logic the daemon performs from a verified parent
 * launch; `declaredDepth` lets a case forge the record's own depth claim so
 * the re-stamp disagreement gate can be observed refusing it.
 */
function mintRunnerHarness(scratch: string, declaredDepth = RUNNER_CONTRACT_DEPTH): RunnerHarness {
  const workspace = path.join(scratch, 'workspace');
  const home = path.join(scratch, 'home');
  const sessionsDir = path.join(scratch, 'sessions');
  const probeOutPath = path.join(scratch, 'runner-env-probe.json');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });

  // Attested exec target stand-in: records the projected launch environment
  // and exits 0. The output path travels as the first exec argv element; the
  // last argv element is the frozen record convention (templateKind).
  const probeBinary = path.join(scratch, 'custody-runner-probe.mjs');
  writeFileSync(
    probeBinary,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'const out = process.argv[2];',
      'if (!out) { process.exit(3); }',
      'writeFileSync(out, JSON.stringify({ argv: process.argv.slice(1), env: process.env }, null, 2));',
      'process.exit(0);',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const probeReal = realpathSync(probeBinary);

  // The attested exec environment: exactly the declared exactNames, carrying
  // the contract projection the entry must reproduce (re-stamp computes
  // PI_SUBAGENT_DEPTH from the parent commitment plus the +1 edge charge).
  const runnerEnvPath = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
  const execEnv = {
    HOME: home,
    PATH: runnerEnvPath,
    PI_CODING_AGENT_SESSION_DIR: sessionsDir,
    PI_SUBAGENT_CHILD: '1',
    PI_SUBAGENT_DEPTH: declaredDepth,
    PI_SUBAGENT_MAX_DEPTH: '3',
  };
  const fixedArgv = [probeOutPath, 'pi-subagent-runner'];

  const stubStat = lstatSync(probeReal);
  const identity = {
    kind: 'attested',
    authority: 'host-install-record',
    manifestRevision: 'custody-wp4-runner-entry-probe-1',
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
  const recordDepth = Number(declaredDepth);
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
      templateKind: 'pi-subagent-runner',
      edge: { parent: 'pi-rpc', child: 'pi-subagent-runner' },
      rootTaskId: 'custody-wp4-runner-root',
      parentInstancePath: [0],
      instancePath: [0, 0],
      depth: recordDepth,
      remainingDepth: 3 - recordDepth,
      effectiveLimits: { maxDepth: 3, fanout: 5, parallel: 2, sessionCap: 8 },
      task: 'Report the custody depth projection.',
      modelCandidates: [{ provider: 'custody-probe', model: 'stub' }],
      attempt: 0,
      session: { cwd: workspace, root: sessionsDir, file: null },
      mcp: { env: {}, metadata: {} },
      envValues: {
        PI_SUBAGENT_CHILD: '1',
        PI_SUBAGENT_DEPTH: declaredDepth,
        PI_SUBAGENT_MAX_DEPTH: '3',
      },
      exactNames,
      controlledDirValues: { PI_CODING_AGENT_SESSION_DIR: sessionsDir },
    },
  };
  const recordPath = path.join(scratch, 'runner-launch-record.json');
  writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });

  // SDK dispatch construction point: the helper host's runner branch receives
  // the parent's contract depth commitment (rpc->runner = 1), the per-launch
  // record path, and an ambient canary that must NOT leak past the projection.
  const runnerEnv: NodeJS.ProcessEnv = {
    PATH: runnerEnvPath,
    HOME: home,
    TMPDIR: path.join(scratch, 'tmp'),
    LANG: process.env.LANG ?? '',
    TZ: 'UTC',
    BYOK_SDK_CUSTODY_RUNNER_CANARY: 'ambient-nondeclared',
    [BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV]: PARENT_CONTRACT_DEPTH,
    [BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]: recordPath,
  };
  return { home, runnerEnvPath, probeOutPath, probeReal, recordPath, runnerEnv, execEnv, exactNames, record };
}

/**
 * A tiny re-entry stub standing in for the product executable: runs the
 * helper host seam over argv, reporting refusals on stderr with a nonzero
 * exit — the same fail-closed contract the SEA host gives the dispatcher.
 * Spawned as `bun <stub> __byok_sdk_helper pi-subagent-runner` — the runtime
 * binary plus an argument, no script-file association, so the shape runs on
 * win32 too (the same convention the helper host tests use for `bun`).
 */
function writeDispatchStub(scratch: string): string {
  const stubPath = path.join(scratch, 'runner-dispatch-stub.ts');
  writeFileSync(
    stubPath,
    [
      `import { runSdkReservedHelperCommand } from ${JSON.stringify(helperHostPath)};`,
      'try {',
      '  const handled = await runSdkReservedHelperCommand(process.argv.slice(2));',
      '  if (!handled) {',
      "    process.stderr.write('not handled\\n');",
      '    process.exit(64);',
      '  }',
      '} catch (error) {',
      '  process.stderr.write(`byok custody refusal: ${(error as Error).message}\\n`);',
      '  process.exit(1);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return stubPath;
}

describe('custody pi-subagent-runner entry: the runner bootstrap edge charges one', () => {
  it('re-stamps PI_SUBAGENT_DEPTH to parent commitment + 1 and projects exactly the declared env', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-custody-runner-entry-'));
    try {
      const harness = mintRunnerHarness(scratch);
      // In-process attested launch with a capture stub: the entry must exec
      // the attested target with PI_SUBAGENT_DEPTH re-stamped from the parent
      // commitment (0) plus the runner edge charge (1).
      const execEnvs: Record<string, string>[] = [];
      const exitCode = await launchAttestedPiSubagentRunner({
        launch: harness.record,
        parentDepth: Number(PARENT_CONTRACT_DEPTH),
        observedEnv: harness.runnerEnv,
        spawnImpl: async (_command, _args, options) => {
          execEnvs.push(options.env);
          return 0;
        },
      });
      expect(exitCode).toBe(0);
      expect(execEnvs).toHaveLength(1);
      const execEnv = execEnvs[0]!;
      expect(execEnv.PI_SUBAGENT_DEPTH).toBe(RUNNER_CONTRACT_DEPTH);
      // The attested exec environment is exactly the record's exactNames —
      // the ambient canary and both custody commitments are not forwarded.
      expect(Object.keys(execEnv).sort()).toEqual([...harness.exactNames]);
      expect(execEnv[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV]).toBeUndefined();
      expect(execEnv[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]).toBeUndefined();
      expect(execEnv.BYOK_SDK_CUSTODY_RUNNER_CANARY).toBeUndefined();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('refuses a record declaring the parent depth instead of parent + 1, without execing', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-custody-runner-entry-'));
    try {
      // The record's own claim is the parent's depth (0); the commitment says
      // the same parent (0), so the required re-stamp is 1 — a forged record
      // rounding itself down to dodge the charge must refuse.
      const harness = mintRunnerHarness(scratch, PARENT_CONTRACT_DEPTH);
      let execed = false;
      await expect(launchAttestedPiSubagentRunner({
        launch: harness.record,
        parentDepth: Number(PARENT_CONTRACT_DEPTH),
        observedEnv: harness.runnerEnv,
        spawnImpl: async () => {
          execed = true;
          return 0;
        },
      })).rejects.toThrow(`bootstrap re-stamp ${RUNNER_CONTRACT_DEPTH} disagrees with the record's declared depth ${PARENT_CONTRACT_DEPTH}`);
      expect(execed, 'the attested exec must not run on a re-stamp disagreement').toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // End to end through the real default exec: the probe binary observes the
  // projected environment of the actual attested child process. The probe is
  // a shebang script spawned as the whole command — the print seam shape —
  // which child_process.spawn cannot do without a shell on win32.
  const skipProbeOnWin32 = process.platform === 'win32';
  (skipProbeOnWin32 ? it.skip : it)('execs the attested probe, which observes the re-stamped depth and the exact env', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-custody-runner-entry-'));
    try {
      const harness = mintRunnerHarness(scratch);
      const exitCode = await runAttestedPiSubagentRunnerFromEnvironment(harness.runnerEnv);
      expect(exitCode).toBe(0);
      expect(readFileSync(harness.probeOutPath, 'utf8')).toBeTruthy();
      const probe = JSON.parse(readFileSync(harness.probeOutPath, 'utf8')) as ProbeRecord;
      // THE contract assertion: rpc->runner charges one, so the runner child
      // observes the parent commitment (0) plus 1, re-stamped by the entry.
      expect(probe.env.PI_SUBAGENT_DEPTH).toBe(RUNNER_CONTRACT_DEPTH);
      expect(probe.argv).toEqual([harness.probeReal, harness.probeOutPath, 'pi-subagent-runner']);
      // Exact projection, measured against a control: the same probe binary
      // spawned directly with exactly the declared exec env. The OS injects
      // its own names into both children (macOS adds __CF_USER_TEXT_ENCODING),
      // so the entry's exec env may differ from the declared projection by
      // nothing the control does not also pick up — no ambient canary, no
      // custody commitments, nothing beyond exactNames plus OS noise.
      const controlOutPath = path.join(scratch, 'control-env-probe.json');
      await new Promise<void>((resolve) => {
        const control = spawn(harness.probeReal, [controlOutPath, 'pi-subagent-runner'], { cwd: scratch, env: harness.execEnv, stdio: 'ignore' });
        control.once('close', () => resolve());
      });
      const controlKeys = Object.keys((JSON.parse(readFileSync(controlOutPath, 'utf8')) as ProbeRecord).env).sort();
      const probeKeys = Object.keys(probe.env).sort();
      expect(probeKeys.filter((name) => !controlKeys.includes(name)), 'the entry projected a name the OS does not add on its own').toEqual([]);
      expect(controlKeys.filter((name) => !probeKeys.includes(name)), 'the entry dropped a declared name').toEqual([]);
      expect(probe.env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV]).toBeUndefined();
      expect(probe.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]).toBeUndefined();
      expect(probe.env.BYOK_SDK_CUSTODY_RUNNER_CANARY).toBeUndefined();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('custody pi-subagent-runner entry: commitment refusals are fail-closed', () => {
  it.each([
    {
      name: 'missing parent depth commitment',
      mutate: (env: NodeJS.ProcessEnv): void => { delete env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV]; },
      stderrFragment: `${BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV} missing`,
    },
    {
      name: 'non-integer parent depth commitment',
      mutate: (env: NodeJS.ProcessEnv): void => { env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV] = 'zero-and-a-half'; },
      stderrFragment: `${BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV} must be a non-negative integer`,
    },
    {
      name: 'missing launch record commitment',
      mutate: (env: NodeJS.ProcessEnv): void => { delete env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]; },
      stderrFragment: `${BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV} must be an absolute path`,
    },
    {
      name: 'unreadable launch record',
      mutate: (env: NodeJS.ProcessEnv, recordPath: string): void => { env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV] = path.join(path.dirname(recordPath), 'does-not-exist.json'); },
      stderrFragment: `${BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV} unreadable at`,
    },
    {
      name: 'non-JSON launch record',
      mutate: (env: NodeJS.ProcessEnv, recordPath: string): void => {
        const brokenPath = path.join(path.dirname(recordPath), 'not-json.json');
        writeFileSync(brokenPath, '{ definitely not json', { mode: 0o600 });
        env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV] = brokenPath;
      },
      stderrFragment: 'is not valid JSON',
    },
  ])('refuses fail-closed at the process boundary: $name', ({ name, mutate, stderrFragment }) => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-custody-runner-entry-'));
    try {
      const harness = mintRunnerHarness(scratch);
      const stubPath = writeDispatchStub(scratch);
      const env: NodeJS.ProcessEnv = { PATH: harness.runnerEnvPath, HOME: harness.home };
      env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV] = PARENT_CONTRACT_DEPTH;
      env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV] = harness.recordPath;
      mutate(env, harness.recordPath);
      const result = spawnSync('bun', [stubPath, BYOK_SDK_HELPER_SUBCOMMAND, 'pi-subagent-runner'], {
        env,
        cwd: scratch,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status, `${name}: stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).not.toBe(0);
      expect(result.stderr).toContain(stderrFragment);
      expect(exists(harness.probeOutPath), 'the attested exec must not run without valid commitments').toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it('routes pi-subagent-runner dispatch through the helper host to the attested exec point, which refuses without the custody commitments', async () => {
    delete process.env.BYOK_SDK_CUSTODY_PARENT_DEPTH;
    delete process.env.BYOK_SDK_CUSTODY_LAUNCH_RECORD;
    await expect(runSdkReservedHelperCommand([BYOK_SDK_HELPER_SUBCOMMAND, 'pi-subagent-runner'])).rejects.toThrow(
      `${BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV} missing`);
  });
});

function exists(target: string): boolean {
  try {
    readFileSync(target);
    return true;
  } catch {
    return false;
  }
}
