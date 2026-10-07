import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  descendantTemplateDigest,
  toolImplementationLaunchEnvNamesDigest,
  toolImplementationLoaderEnvValuesDigest,
  type PiDescendantLaunchV2,
  type ImplementationSpawnBindingV1,
} from '@byok-sdk/implementation-identity';
import {
  BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV,
  BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV,
} from '../custody/custody-commitments';
import { launchAttestedPiSubagentPrint } from '../custody/pi-subagent-print-entry';

// Success path of the print attested exec point. Frozen counting table:
// runner->print is the bootstrap edge and charges zero, so the entry re-stamps
// PI_SUBAGENT_DEPTH to the runner's contract depth and execs the attested
// target with exactly the record's declared environment. The refusal paths
// live in custody-five-edge-dispatch.test.ts and sdk-reserved-helper-host.test.ts.

/** The runner's contract depth (rpc->runner = 1); the print child keeps it. */
const RUNNER_CONTRACT_DEPTH = '1';
const CONTRACT_PRINT_MAX_DEPTH = '3';

interface PrintHarness {
  readonly record: PiDescendantLaunchV2;
  readonly exactNames: readonly string[];
  readonly observedEnv: NodeJS.ProcessEnv;
}

/**
 * Mint the runner side of a runner->print edge: seal an attested identity over
 * a probe binary (real bytes, stat tuple and digests), declare the exact exec
 * environment and write the per-launch record. `observedEnv` is the
 * vendor-spread environment the print child receives: it carries the vendor's
 * own MAX_DEPTH, an ambient canary and both custody commitments, none of which
 * may reach the attested exec.
 */
function mintPrintHarness(scratch: string): PrintHarness {
  const workspace = path.join(scratch, 'workspace');
  const home = path.join(scratch, 'home');
  const sessionsDir = path.join(scratch, 'sessions');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });

  const probeBinary = path.join(scratch, 'custody-print-probe.mjs');
  writeFileSync(probeBinary, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  const probeReal = realpathSync(probeBinary);

  const envPath = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
  const execEnv = {
    HOME: home,
    PATH: envPath,
    PI_CODING_AGENT_SESSION_DIR: sessionsDir,
    PI_SUBAGENT_CHILD: '1',
    PI_SUBAGENT_DEPTH: RUNNER_CONTRACT_DEPTH,
    PI_SUBAGENT_MAX_DEPTH: CONTRACT_PRINT_MAX_DEPTH,
  };
  const fixedArgv = ['--mode', 'json', '-p', 'pi-subagent-print'];

  const stubStat = lstatSync(probeReal);
  const identity = {
    kind: 'attested',
    authority: 'host-install-record',
    manifestRevision: 'custody-print-entry-probe-1',
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
  const record: PiDescendantLaunchV2 = {
    format: 'byok.descendant-launch',
    version: 2,
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
      rootTaskId: 'custody-print-entry-root',
      parentInstancePath: [0],
      instancePath: [0],
      depth: Number(RUNNER_CONTRACT_DEPTH),
      remainingDepth: 3 - Number(RUNNER_CONTRACT_DEPTH),
      effectiveLimits: { maxDepth: 3, fanout: 5, parallel: 2, sessionCap: 8 },
      task: 'Report the custody depth projection.',
      modelCandidates: [{ provider: 'custody-probe', model: 'stub' }],
      attempt: 0,
      session: { cwd: workspace, root: sessionsDir, file: null },
      mcp: { env: {}, metadata: {} },
      envValues: {
        PI_SUBAGENT_CHILD: '1',
        PI_SUBAGENT_DEPTH: RUNNER_CONTRACT_DEPTH,
        PI_SUBAGENT_MAX_DEPTH: CONTRACT_PRINT_MAX_DEPTH,
      },
      exactNames,
      controlledDirValues: { PI_CODING_AGENT_SESSION_DIR: sessionsDir },
    },
  };
  const recordPath = path.join(scratch, 'print-launch-record.json');
  writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });

  const observedEnv: NodeJS.ProcessEnv = {
    PATH: envPath,
    HOME: home,
    TMPDIR: path.join(scratch, 'tmp'),
    // The vendor increments at every physical spawn; the entry must not read it.
    PI_SUBAGENT_DEPTH: '2',
    PI_SUBAGENT_MAX_DEPTH: '8',
    BYOK_SDK_CUSTODY_PRINT_CANARY: 'ambient-nondeclared',
    [BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV]: RUNNER_CONTRACT_DEPTH,
    [BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]: recordPath,
  };
  return { record, exactNames, observedEnv };
}

describe('custody pi-subagent-print entry: the runner->print bootstrap edge charges zero', () => {
  it('re-stamps PI_SUBAGENT_DEPTH to the parent commitment and projects exactly the declared env', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-custody-print-entry-'));
    try {
      const harness = mintPrintHarness(scratch);
      const execs: { command: string; args: readonly string[]; env: Record<string, string> }[] = [];
      const exitCode = await launchAttestedPiSubagentPrint({
        launch: harness.record,
        parentDepth: Number(RUNNER_CONTRACT_DEPTH),
        observedEnv: harness.observedEnv,
        spawnImpl: async (command, args, options) => {
          execs.push({ command, args, env: options.env });
          return 0;
        },
      });
      expect(exitCode).toBe(0);
      expect(execs).toHaveLength(1);
      const exec = execs[0]!;
      expect(exec.command).toBe(harness.record.template.command);
      expect(exec.args).toEqual(harness.record.template.fixedArgv);
      // THE contract assertion: the print child keeps the runner's depth. The
      // vendor's own increment ('2' in the observed env) never reaches the exec.
      expect(exec.env.PI_SUBAGENT_DEPTH).toBe(RUNNER_CONTRACT_DEPTH);
      expect(exec.env.PI_SUBAGENT_MAX_DEPTH).toBe(CONTRACT_PRINT_MAX_DEPTH);
      expect(Object.keys(exec.env).sort()).toEqual([...harness.exactNames]);
      expect(exec.env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV]).toBeUndefined();
      expect(exec.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]).toBeUndefined();
      expect(exec.env.BYOK_SDK_CUSTODY_PRINT_CANARY).toBeUndefined();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('refuses a double-charged parent commitment without execing', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-custody-print-entry-'));
    try {
      const harness = mintPrintHarness(scratch);
      let execCount = 0;
      await expect(launchAttestedPiSubagentPrint({
        launch: harness.record,
        parentDepth: Number(RUNNER_CONTRACT_DEPTH) + 1,
        observedEnv: harness.observedEnv,
        spawnImpl: async () => {
          execCount += 1;
          return 0;
        },
      })).rejects.toThrow('custody preset entry refused');
      expect(execCount).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
