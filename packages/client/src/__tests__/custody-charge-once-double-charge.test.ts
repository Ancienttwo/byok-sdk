import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WP3 charge-once RED test (contract 20260917-1545-wp3-charge-once-red).
//
// Frozen counting table (owner ruling 2026-09-17): one logical delegation
// charges exactly one depth level.
//   rpc->runner   = 1
//   rpc->print    = 1
//   runner->print = 0 (bootstrap: zero charge)
//   print->runner = 1
//   print->print  = 1
//
// Conflict under test: one logical delegation rpc->runner->print has contract
// depth 1 (rpc->runner charges 1, runner->print bootstrap charges 0). The
// vendor physical implementation increments PI_SUBAGENT_DEPTH at every
// physical spawn (runs/shared/types.ts getSubagentDepthEnv, applied at
// runs/background/subagent-runner.ts runPiStreaming and at
// runs/foreground/execution.ts runSync), so a custody-wired runner launched at
// contract depth 1 (per-launch projection validated by
// packages/implementation-identity/src/descendant-launch.ts, where
// PI_SUBAGENT_DEPTH must equal the contract depth) physically hands the print
// child depth 2.
//
// Chain drive (real vendor code paths, nothing below is depth-mocked):
//   1. The runner process is launched exactly like the vendor background spawn
//      (runs/background/async-execution.ts spawnRunner: node + jiti CLI +
//      config JSON path) with the custody per-launch projection
//      PI_SUBAGENT_DEPTH=1 (the frozen-table state after rpc->runner = 1).
//   2. The real runner (pi-subagents 0.60.0 subagent-runner.ts, the version
//      pinned by packages/client/package.json) resolves the step through
//      buildPiArgs and spawns the print child through the vendor's own launch
//      seam getPiSpawnCommand (runs/shared/pi-spawn.ts PI_SUBAGENT_PI_BINARY),
//      with child env built by getSubagentDepthEnv.
//   3. The print leaf is the repo's standard headless stand-in for the pi
//      binary (same substitution shape as fixtures/fake-pi.mjs): it records
//      the projected environment and exits 0, so no network or model key is
//      needed.
//
// Assertion: the print child's observed PI_SUBAGENT_DEPTH must equal the
// contract value '1'. On the unfixed wiring it is '2' -> this test is RED by
// design. After the wiring fix (plan slice 3) the same assertion must go green.
// Falsifier guard: chain-health assertions below pin the run to the real
// vendor spawn (vendor-built argv and PI_SUBAGENT_CHILD marker), so a broken
// fixture fails loudly instead of faking a depth result.

const clientRoot = path.resolve(import.meta.dirname, '../..');
const requireFromClient = createRequire(path.join(clientRoot, 'package.json'));
const runnerPath = realpathSync(
  path.join(clientRoot, 'node_modules/pi-subagents/src/runs/background/subagent-runner.ts'),
);

const RUNNER_CLOSE_TIMEOUT_MS = 120_000;
const CONTRACT_PRINT_DEPTH = '1';

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

describe('custody charge-once: one logical delegation charges one depth level', () => {
  it('print child observes the contract depth projection 1 after rpc->runner->print', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-custody-charge-once-'));
    try {
      const workspace = path.join(scratch, 'workspace');
      const home = path.join(scratch, 'home');
      const asyncDir = path.join(scratch, 'async-dir');
      const probeOutPath = path.join(scratch, 'print-env-probe.json');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(home, { recursive: true });
      mkdirSync(asyncDir, { recursive: true });

      // Print leaf stand-in: records the projected launch environment through
      // the vendor's own PI_SUBAGENT_PI_BINARY seam and exits 0.
      const probeBinary = path.join(scratch, 'custody-depth-probe.mjs');
      writeFileSync(
        probeBinary,
        [
          '#!/usr/bin/env node',
          'import { writeFileSync } from "node:fs";',
          'const out = process.env.CUSTODY_DEPTH_PROBE_OUT;',
          'if (!out) { process.exit(3); }',
          'writeFileSync(out, JSON.stringify({ argv: process.argv.slice(1), env: process.env }, null, 2));',
          'process.exit(0);',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      chmodSync(probeBinary, 0o755);

      // Runner config: same shape spawnRunner writes for the background
      // runner (one sequential step; all behavior fields resolved).
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

      // Custody per-launch projection for the runner: rpc->runner = 1, so the
      // runner process starts at PI_SUBAGENT_DEPTH=1 (descendant-launch.ts
      // requires the projected PI_SUBAGENT_DEPTH to equal the contract depth).
      // The runner->print bootstrap edge must add zero.
      const runnerEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        TMPDIR: path.join(scratch, 'tmp'),
        LANG: process.env.LANG ?? '',
        TZ: 'UTC',
        PI_SUBAGENT_DEPTH: '1',
        PI_SUBAGENT_MAX_DEPTH: '8',
        PI_SUBAGENT_PI_BINARY: probeBinary,
        CUSTODY_DEPTH_PROBE_OUT: probeOutPath,
      };

      const run = await spawnRunnerAndWait(
        'node',
        [resolveJitiCliPath(), runnerPath, configPath],
        { cwd: workspace, env: runnerEnv },
      );

      // Chain health first: the RED below is only meaningful when the real
      // vendor chain ran end to end. A runner crash here is a harness error,
      // not the double-charge signal.
      expect(run.timedOut, `runner timed out\nstderr:\n${run.stderr}`).toBe(false);
      expect(run.code, `runner exited ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
      expect(existsSync(probeOutPath), 'print probe never ran: the vendor spawn chain did not reach the print child').toBe(true);
      const probe = JSON.parse(readFileSync(probeOutPath, 'utf8')) as ProbeRecord;
      expect(probe.env.PI_SUBAGENT_CHILD, 'child was not launched through the vendor buildPiArgs path').toBe('1');
      expect(probe.argv, 'child argv is not the vendor print invocation').toEqual(
        expect.arrayContaining(['--mode', 'json', '-p']),
      );

      // THE contract assertion: runner->print is a zero-charge bootstrap edge,
      // so the print child must observe the contract depth 1. The unfixed
      // vendor wiring increments at every physical spawn and observes 2.
      expect(probe.env.PI_SUBAGENT_DEPTH).toBe(CONTRACT_PRINT_DEPTH);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
